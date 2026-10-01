// Orderflow per un simbolo: delta, CVD, volume profile di sessione, big trades,
// zone di probabile iceberg/assorbimento e pressione del book locale.
// Sessione = giorno UTC (mercato crypto 24/7).

import { LocalOrderBook } from './orderbook.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MAX_BARS = 1500;
const PRESSURE_SAMPLE_MS = 500;

function roundPrice(value) {
  return Math.round(value * 1e8) / 1e8;
}

export function sessionStartOf(ts) {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

// Value area al 70% espandendo dal POC verso il lato con piu' volume.
export function valueArea(rows, share = 0.7) {
  if (rows.length === 0) return { poc: null, vah: null, val: null };
  const sorted = [...rows].sort((a, b) => a.price - b.price);
  const totals = sorted.map((r) => r.buy + r.sell);
  const all = totals.reduce((s, v) => s + v, 0);
  let pocIdx = 0;
  for (let i = 1; i < totals.length; i++) if (totals[i] > totals[pocIdx]) pocIdx = i;
  let lo = pocIdx;
  let hi = pocIdx;
  let acc = totals[pocIdx];
  while (acc < all * share && (lo > 0 || hi < totals.length - 1)) {
    const below = lo > 0 ? totals[lo - 1] : -1;
    const above = hi < totals.length - 1 ? totals[hi + 1] : -1;
    if (above >= below) { hi += 1; acc += above; } else { lo -= 1; acc += below; }
  }
  return { poc: sorted[pocIdx].price, vah: sorted[hi].price, val: sorted[lo].price, pocIdx, sorted, totals };
}

// Low volume node: minimo locale del profilo (media mobile a 3) dentro la value area.
export function lowVolumeNodes(va, limit = 5) {
  if (!va.sorted || va.sorted.length < 7) return [];
  const { sorted, totals } = va;
  const smooth = totals.map((_, i) => {
    const w = totals.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((s, v) => s + v, 0) / w.length;
  });
  const pocVol = totals[va.pocIdx];
  const nodes = [];
  for (let i = 2; i < smooth.length - 2; i++) {
    const p = sorted[i].price;
    if (p < va.val || p > va.vah) continue;
    const isMin = smooth[i] < smooth[i - 1] && smooth[i] <= smooth[i + 1] && smooth[i] < smooth[i - 2] && smooth[i] <= smooth[i + 2];
    if (isMin && smooth[i] < pocVol * 0.35) nodes.push({ price: p, strength: 1 - smooth[i] / pocVol });
  }
  return nodes.sort((a, b) => b.strength - a.strength).slice(0, limit).map((n) => n.price).sort((a, b) => a - b);
}

export class OrderFlow {
  constructor({ symbol, profileTick, bigTradeUsd, icebergMinUsd, settings }) {
    this.symbol = symbol;
    this.tick = profileTick;
    this.bigTradeUsd = bigTradeUsd;
    this.icebergMinUsd = icebergMinUsd;
    this.settings = settings;
    this.sessionStart = null;
    this.sessionDelta = 0;
    this.sessionVolume = 0;
    this.sessionBuy = 0;
    this.bars = [];
    this.gaps = [];
    this.profile = new Map();
    this.bigTrades = [];
    this.book = new LocalOrderBook({ pruneFraction: (settings.bookPrunePct ?? 3) / 100 });
    this.bookBandPct = settings.bookBandPct ?? 0.25;
    this.bookTauMs = (settings.bookSmoothingSec ?? 30) * 1000;
    this.pressure = null;
    this.levels = new Map();
    this.zones = [];
    this.lastPrice = null;
    this.lastTradeTs = 0;
    this.profileApproximated = false;
  }

  bucket(price) {
    return roundPrice(Math.floor(price / this.tick + 1e-9) * this.tick);
  }

  rollSession(ts) {
    const start = sessionStartOf(ts);
    if (this.sessionStart === start) return;
    this.sessionStart = start;
    this.sessionDelta = 0;
    this.sessionVolume = 0;
    this.sessionBuy = 0;
    this.profile.clear();
    this.profileApproximated = false;
  }

  addProfile(price, buy, sell) {
    const key = this.bucket(price);
    const row = this.profile.get(key) ?? { price: key, buy: 0, sell: 0 };
    row.buy += buy;
    row.sell += sell;
    this.profile.set(key, row);
  }

  barAt(ts, price) {
    const t = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
    let bar = this.bars[this.bars.length - 1];
    if (!bar || bar.t < t) {
      bar = { t, o: price, h: price, l: price, c: price, v: 0, delta: 0 };
      this.bars.push(bar);
      if (this.bars.length > MAX_BARS) this.bars.shift();
    }
    return bar;
  }

  // Klines Binance: [openTime, o, h, l, c, volume, closeTime, quoteVol, trades, takerBuyBase, ...].
  // Il delta storico e' esatto (taker buy - taker sell); il profilo e' approssimato
  // distribuendo il volume della candela 1m uniformemente fra minimo e massimo.
  // L'ultima kline, ancora aperta, fa da base al minuto corrente: i trade live si sommano a quella.
  bootstrap(klines) {
    if (klines.length === 0) return;
    const lastOpen = Number(klines[klines.length - 1][0]);
    this.rollSession(lastOpen);
    for (const k of klines) {
      const t = Number(k[0]);
      const [o, h, l, c, v, takerBuy] = [k[1], k[2], k[3], k[4], k[5], k[9]].map(Number);
      const delta = 2 * takerBuy - v;
      this.bars.push({ t, o, h, l, c, v, delta });
      if (t >= this.sessionStart) {
        this.sessionDelta += delta;
        this.sessionVolume += v;
        this.sessionBuy += takerBuy;
        const first = this.bucket(l);
        const steps = Math.max(1, Math.round((this.bucket(h) - first) / this.tick) + 1);
        for (let i = 0; i < steps; i++) {
          this.addProfile(first + i * this.tick, takerBuy / steps, (v - takerBuy) / steps);
        }
        this.profileApproximated = true;
      }
      this.lastPrice = c;
    }
    if (this.bars.length > MAX_BARS) this.bars.splice(0, this.bars.length - MAX_BARS);
  }

  // Trade live persi fra `from` e `to` (avvio, riconnessioni): le candele che toccano l'intervallo
  // sono incomplete. Array modificato sul posto, si tengono solo i buchi dentro la finestra delle barre.
  addGap(from, to) {
    this.gaps.push([from, to]);
    const oldest = this.bars[0]?.t ?? -Infinity;
    while (this.gaps.length && this.gaps[0][1] < oldest) this.gaps.shift();
  }

  displayedAt(side, price) {
    return this.book.qtyAt(side, price);
  }

  onTrade(price, qty, buyerIsMaker, ts) {
    this.rollSession(ts);
    const aggressorBuy = !buyerIsMaker;
    const signed = aggressorBuy ? qty : -qty;
    const bar = this.barAt(ts, price);
    bar.h = Math.max(bar.h, price);
    bar.l = Math.min(bar.l, price);
    bar.c = price;
    bar.v += qty;
    bar.delta += signed;
    this.sessionDelta += signed;
    this.sessionVolume += qty;
    if (aggressorBuy) this.sessionBuy += qty;
    this.addProfile(price, aggressorBuy ? qty : 0, aggressorBuy ? 0 : qty);
    this.lastPrice = price;
    this.lastTradeTs = ts;

    const usd = price * qty;
    if (usd >= this.bigTradeUsd) {
      this.bigTrades.push({ ts, price, qty, usd, side: aggressorBuy ? 'buy' : 'sell' });
      if (this.bigTrades.length > 60) this.bigTrades.shift();
    }

    // Il lato passivo colpito: un aggressore in vendita consuma i bid.
    const side = aggressorBuy ? 'ask' : 'bid';
    const key = `${side}:${price}`;
    let level = this.levels.get(key);
    if (!level) {
      const shown = this.displayedAt(side, price);
      level = { side, price, executed: 0, maxDisplayed: shown, lastDisplayed: shown, refills: 0, firstTs: ts, lastTs: ts, broken: false };
      this.levels.set(key, level);
    }
    level.executed += qty;
    level.lastTs = ts;
    // Eseguito a book non sincronizzato: la size mostrata prima del trade non e' nota.
    if (!this.book.synced) level.blind = true;

    for (const lv of this.levels.values()) {
      if ((lv.side === 'bid' && price < lv.price) || (lv.side === 'ask' && price > lv.price)) lv.broken = true;
    }
    for (const z of this.zones) {
      if (z.status === 'attiva' && ((z.side === 'bid' && price < z.price) || (z.side === 'ask' && price > z.price))) {
        z.status = 'rotta';
        z.brokenTs = ts;
      }
    }
    this.evaluateLevels(ts);
  }

  onBookSnapshot(snapshot) {
    this.book.applySnapshot(snapshot);
    // I livelli colpiti a book vuoto ripartono da zero, ora che la size mostrata e' nota.
    for (const [key, lv] of this.levels) if (lv.blind) this.levels.delete(key);
    this.trackLevels(false);
  }

  resetBook() {
    this.book.reset();
  }

  // Rinfresco periodico: se lo snapshot si allinea subito, le size cambiate non sono ricariche.
  onBookRefresh(snapshot) {
    const refreshes = this.book.refreshes;
    const staged = this.book.stageRefresh(snapshot);
    if (this.book.refreshes !== refreshes) this.trackLevels(false);
    return staged;
  }

  // Restituisce l'esito di LocalOrderBook.applyDiff: con 'resync' serve un nuovo snapshot.
  onBookDiff(ev) {
    const refreshes = this.book.refreshes;
    const result = this.book.applyDiff(ev);
    if (result !== 'applied') return result;
    // Dopo un rinfresco la size mostrata puo' cambiare senza che sia una ricarica.
    this.trackLevels(this.book.refreshes === refreshes);
    const ts = ev.E ?? Date.now();
    if (!this.pressure || ts - this.pressure.ts >= PRESSURE_SAMPLE_MS) this.samplePressure(ts);
    return result;
  }

  // Size mostrata dei livelli attivi: una ricarica e' un aumento dopo esecuzioni sul livello.
  trackLevels(countRefills) {
    for (const lv of this.levels.values()) {
      const shown = this.displayedAt(lv.side, lv.price);
      if (countRefills && shown > lv.lastDisplayed && lv.executed > 0) lv.refills += 1;
      lv.lastDisplayed = shown;
      lv.maxDisplayed = Math.max(lv.maxDisplayed, shown);
    }
  }

  // Quota bid del nozionale entro ±bookBandPct, media esponenziale sul tempo reale:
  // alpha = 1 - exp(-dt/tau), il primo campione inizializza.
  samplePressure(ts) {
    const d = this.book.bandDepth(this.bookBandPct / 100);
    if (!d || d.bidShare == null) return;
    const prev = this.pressure;
    const alpha = prev ? 1 - Math.exp(-Math.max(0, ts - prev.ts) / this.bookTauMs) : 1;
    const smooth = prev ? prev.smooth + alpha * (d.bidShare - prev.smooth) : d.bidShare;
    this.pressure = { ts, smooth, raw: d.bidShare, bidUsd: d.bidUsd, askUsd: d.askUsd, covered: d.covered };
  }

  // Un livello diventa zona iceberg/assorbimento quando l'eseguito supera di
  // `icebergMinRatio` volte la size massima mostrata, con nozionale minimo e
  // senza che il prezzo lo abbia attraversato durante la finestra.
  evaluateLevels(now) {
    const windowMs = this.settings.icebergWindowMs;
    for (const [key, lv] of this.levels) {
      if (now - lv.lastTs < windowMs) continue;
      this.levels.delete(key);
      if (lv.broken || lv.blind || lv.maxDisplayed <= 0) continue;
      const ratio = lv.executed / lv.maxDisplayed;
      const executedUsd = lv.executed * lv.price;
      if (ratio >= this.settings.icebergMinRatio && executedUsd >= this.icebergMinUsd) {
        this.zones.push({
          side: lv.side,
          price: lv.price,
          executed: lv.executed,
          executedUsd,
          ratio,
          refills: lv.refills,
          kind: lv.refills >= 2 ? 'iceberg' : 'assorbimento',
          ts: lv.lastTs,
          status: 'attiva',
        });
      }
    }
    const ttl = this.settings.zoneTtlMs;
    this.zones = this.zones.filter((z) => now - z.ts < ttl).slice(-40);
  }

  cvdTrend() {
    const minutes = this.settings.cvdTrendMinutes;
    const recent = this.bars.slice(-minutes);
    const delta = recent.reduce((s, b) => s + b.delta, 0);
    const volume = recent.reduce((s, b) => s + b.v, 0);
    const ratio = volume > 0 ? delta / volume : 0;
    const first = recent[0];
    const priceChange = first && this.lastPrice ? this.lastPrice - first.o : 0;
    const threshold = this.settings.cvdDirectionalRatio;
    const direction = ratio > threshold ? 'acquisti' : ratio < -threshold ? 'vendite' : 'neutro';
    // Divergenza: prezzo e delta in direzioni opposte con aggressione significativa.
    const divergence = direction !== 'neutro' && priceChange !== 0 && Math.sign(priceChange) !== Math.sign(delta);
    return { minutes, delta, volume, ratio, direction, priceChange, divergence };
  }

  bookPressure() {
    const p = this.pressure;
    if (!p) return null;
    return {
      smooth: p.smooth,
      raw: p.raw,
      bandPct: this.bookBandPct,
      bidUsd: p.bidUsd,
      askUsd: p.askUsd,
      covered: p.covered,
      synced: this.book.synced,
      smoothingSec: this.bookTauMs / 1000,
      ts: p.ts,
    };
  }

  compactProfile(maxRows = 160) {
    const rows = [...this.profile.values()].sort((a, b) => a.price - b.price);
    if (rows.length <= maxRows) return rows.map((r) => [r.price, r.buy, r.sell]);
    const group = Math.ceil(rows.length / maxRows);
    const out = [];
    for (let i = 0; i < rows.length; i += group) {
      const chunk = rows.slice(i, i + group);
      out.push([chunk[0].price, chunk.reduce((s, r) => s + r.buy, 0), chunk.reduce((s, r) => s + r.sell, 0)]);
    }
    return out;
  }

  snapshot({ barLimit = 360, depth = true } = {}) {
    const va = valueArea([...this.profile.values()]);
    const price = this.lastPrice;
    const location = price == null || va.vah == null ? null : price > va.vah ? 'sopra' : price < va.val ? 'sotto' : 'dentro';
    let cvd = 0;
    let session = null;
    const bars = this.bars.slice(-barLimit).map((b) => b);
    const cvdSeries = [];
    for (const b of this.bars) {
      const s = sessionStartOf(b.t);
      if (s !== session) { session = s; cvd = 0; }
      cvd += b.delta;
      cvdSeries.push(cvd);
    }
    return {
      symbol: this.symbol,
      price,
      lastTradeTs: this.lastTradeTs,
      session: {
        start: this.sessionStart,
        delta: this.sessionDelta,
        volume: this.sessionVolume,
        buyShare: this.sessionVolume > 0 ? this.sessionBuy / this.sessionVolume : null,
      },
      cvdTrend: this.cvdTrend(),
      profile: {
        poc: va.poc,
        vah: va.vah,
        val: va.val,
        lvns: lowVolumeNodes(va),
        location,
        approximated: this.profileApproximated,
        rows: this.compactProfile(),
        tick: this.tick,
      },
      bars: bars.map((b, i) => ({ ...b, cvd: cvdSeries[cvdSeries.length - bars.length + i] })),
      bigTrades: this.bigTrades.slice(-20).reverse(),
      zones: [...this.zones].reverse(),
      bookPressure: this.bookPressure(),
      depth: depth ? this.book.depthProfile(0.01, 40) : null,
    };
  }
}
