// Candele al timeframe scelto: quelle chiuse dalle klines Binance (45m costruito da 15m),
// dal bucket ancora aperto all'ultima fetch in poi dalle barre 1m dell'orderflow.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 86_400_000;

// interval/limit: klines native chieste a Binance (peso 5 fino a 1000, 10 oltre).
export const TIMEFRAMES = Object.freeze({
  '1m': { ms: MINUTE_MS, interval: '1m', limit: 1000 },
  '3m': { ms: 3 * MINUTE_MS, interval: '3m', limit: 1000 },
  '5m': { ms: 5 * MINUTE_MS, interval: '5m', limit: 1000 },
  '15m': { ms: 15 * MINUTE_MS, interval: '15m', limit: 1000 },
  '30m': { ms: 30 * MINUTE_MS, interval: '30m', limit: 1000 },
  '45m': { ms: 45 * MINUTE_MS, interval: '15m', limit: 1500 }, // non nativo: 500 barre da 1500 x 15m
  '1h': { ms: HOUR_MS, interval: '1h', limit: 1000 },
  '4h': { ms: 4 * HOUR_MS, interval: '4h', limit: 1000 },
  '1d': { ms: DAY_MS, interval: '1d', limit: 1000 },
});
export const MAX_BARS = 1000;
const HISTORY_TTL_MS = 30 * MINUTE_MS;
const NO_LIVE_TTL_MS = MINUTE_MS;
const RETRY_MS = 30_000;

export const isTimeframe = (tf) => typeof tf === 'string' && Object.hasOwn(TIMEFRAMES, tf);

export function timeframe(tf) {
  if (!isTimeframe(tf)) throw new RangeError(`timeframe non valido: ${tf}`);
  return TIMEFRAMES[tf];
}

// Fino a 4h il CVD riparte a ogni giorno UTC; su 4h e 1d si cumula sulla finestra restituita.
export const cvdModeOf = (ms) => (ms >= 4 * HOUR_MS ? 'cumulativo' : 'giornaliero');

// Bucket allineati al giorno UTC: 1440/45 = 32, quindi anche il 45m riparte da 00:00 ogni giorno.
export function bucketStart(t, ms) {
  const day = Math.floor(t / DAY_MS) * DAY_MS;
  return day + Math.floor((t - day) / ms) * ms;
}

// Kline Binance: [openTime, o, h, l, c, volume, closeTime, quoteVol, trades, takerBuyBase, ...].
// Delta esatto = taker buy - taker sell.
export function klineToBar(k) {
  const [o, h, l, c, v, takerBuy] = [k[1], k[2], k[3], k[4], k[5], k[9]].map(Number);
  return { t: Number(k[0]), o, h, l, c, v, delta: 2 * takerBuy - v };
}

// gaps: intervalli [da, a] in cui possono mancare trade live (avvio, riconnessioni).
export const holed = (t, ms, gaps) => gaps.some(([from, to]) => from < t + ms && to >= t);

// Raggruppa barre ordinate in bucket da `ms`. Se i dati partono a meta' di un bucket, o nel primo
// bucket mancano trade, quel bucket viene scartato: sarebbe una candela incompleta.
export function aggregate(bars, ms, gaps = []) {
  const out = [];
  if (bars.length === 0) return out;
  const head = bucketStart(bars[0].t, ms);
  const from = head === bars[0].t && !holed(head, ms, gaps) ? head : head + ms;
  let cur = null;
  for (const b of bars) {
    if (b.t < from) continue;
    const t = bucketStart(b.t, ms);
    if (cur?.t === t) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v;
      cur.delta += b.delta;
    } else {
      cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, delta: b.delta };
      out.push(cur);
    }
  }
  return out;
}

// L'ultima candela dello storico poteva essere ancora aperta alla fetch: da li' valgono le barre live.
const seamOf = (history, live) => history.at(-1)?.t ?? live[0]?.t;

// Candele chiuse dallo storico Binance, poi le barre live; senza storico solo quelle live.
export function mergeBars(history, live) {
  if (live.length === 0) return history.slice();
  const seam = seamOf(history, live);
  return history.filter((b) => b.t < seam).concat(live.filter((b) => b.t >= seam));
}

const round8 = (v) => Math.round(v * 1e8) / 1e8;

export function withCvd(bars, mode) {
  let cvd = 0;
  let day = null;
  return bars.map((b) => {
    const d = Math.floor(b.t / DAY_MS);
    if (mode === 'giornaliero' && d !== day) { day = d; cvd = 0; }
    cvd += b.delta;
    return { ...b, v: round8(b.v), delta: round8(b.delta), cvd: round8(cvd) };
  });
}

// Il CVD giornaliero si calcola prima del taglio, cosi' il primo giorno visibile non riparte da zero
// se lo storico lo copre; quello cumulativo parte dalla prima barra restituita.
// historyGap: candele mancanti fra uno storico non piu' aggiornato e le barre live.
export function buildSeries(tf, history, minuteBars, limit = MAX_BARS, gaps = []) {
  const { ms } = timeframe(tf);
  const live = aggregate(minuteBars, ms, gaps);
  const merged = mergeBars(history, live);
  const cvdMode = cvdModeOf(ms);
  const bars = cvdMode === 'giornaliero' ? withCvd(merged, cvdMode).slice(-limit) : withCvd(merged.slice(-limit), cvdMode);
  const seam = seamOf(history, live);
  const out = { tf, cvdMode, bars, liveFrom: live.find((b) => b.t >= seam)?.t ?? null };
  if (history.length && live.length && seam < live[0].t) out.historyGap = { from: seam, to: live[0].t };
  return out;
}

// Storico in cache per (simbolo, timeframe): le candele chiuse non cambiano, quindi si richiede
// solo dopo il TTL, quando non arriva piu' fino alla giunzione con le barre 1m o quando un bucket
// live con trade mancanti si chiude dopo la fetch. Richieste contemporanee condividono la stessa
// fetch; fra due fetch della stessa chiave passano almeno RETRY_MS.
export class BarSeries {
  constructor({ fetchKlines, ttlMs = HISTORY_TTL_MS, retryMs = RETRY_MS, now = Date.now }) {
    this.fetchKlines = fetchKlines;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.now = now;
    this.cache = new Map();
  }

  // closedUntil = inizio dell'ultimo bucket ricevuto, che al momento della fetch poteva essere ancora aperto.
  covers(e, seam) {
    if (!e.bars) return false;
    return seam == null ? this.now() - e.fetchedAt < NO_LIVE_TTL_MS : e.closedUntil >= seam;
  }

  // dirty: inizio dell'ultimo bucket live gia' chiuso con trade mancanti.
  async history(symbol, tf, seam, dirty = null) {
    const key = `${symbol} ${tf}`;
    let e = this.cache.get(key);
    if (!e) {
      e = { bars: null, fetchedAt: 0, closedUntil: 0, error: null, retryAt: 0, pending: null };
      this.cache.set(key, e);
    }
    const fresh = this.covers(e, seam) && this.now() - e.fetchedAt < this.ttlMs && (dirty == null || dirty < e.closedUntil);
    if (!fresh && !e.pending && this.now() >= e.retryAt) {
      const { interval, limit, ms } = TIMEFRAMES[tf];
      e.retryAt = this.now() + this.retryMs;
      e.pending = Promise.resolve()
        .then(() => this.fetchKlines(symbol, interval, limit))
        .then((klines) => {
          const bars = aggregate(klines.map(klineToBar), ms);
          Object.assign(e, { bars, fetchedAt: this.now(), closedUntil: bars.at(-1)?.t ?? 0, error: null });
        }, (err) => { e.error = String(err?.message ?? err); })
        .finally(() => { e.pending = null; });
    }
    // Si attende la fetch solo se la cache non basta: altrimenti si risponde subito e il poll successivo trova i dati nuovi.
    if (e.pending && !this.covers(e, seam)) await e.pending;
    if (this.covers(e, seam)) return { bars: e.bars, fetchedAt: e.fetchedAt, error: null };
    // Cache che non arriva piu' alle barre 1m: le candele chiuse restano valide, con un buco fino a quelle live.
    return { bars: e.bars ?? [], fetchedAt: e.fetchedAt, error: e.error ?? 'storico non ancora disponibile' };
  }

  // minuteBars e gaps: gli array vivi dell'orderflow, riletti dopo l'attesa dello storico.
  // rev cambia quando possono cambiare candele gia' inviate: nuovo storico o inizio della finestra spostato.
  async get(symbol, tf, minuteBars, gaps = []) {
    const { ms } = timeframe(tf);
    const live = aggregate(minuteBars, ms, gaps);
    let history = [];
    let historyError = null;
    let fetchedAt = 0;
    // Con la finestra live piena (1m) lo storico serve solo per sostituire minuti chiusi con trade mancanti.
    const dirty = live.slice(-MAX_BARS).findLast((b) => b.t + ms <= this.now() && holed(b.t, ms, gaps))?.t ?? null;
    if (live.length < MAX_BARS || dirty != null) {
      ({ bars: history, error: historyError, fetchedAt } = await this.history(symbol, tf, live[0]?.t ?? null, dirty));
    }
    const out = buildSeries(tf, history, minuteBars, MAX_BARS, gaps);
    // historyAt: ora della lettura di uno storico non piu' aggiornato, null se non ce n'e'.
    if (historyError && live.length < MAX_BARS) Object.assign(out, { historyError, historyAt: fetchedAt || null });
    out.rev = `${fetchedAt}:${out.bars[0]?.t ?? ''}`;
    return out;
  }
}
