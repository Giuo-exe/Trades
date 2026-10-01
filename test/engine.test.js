import test from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, bsGamma } from '../src/engine/blackscholes.js';
import { computeGex, totalGexAt } from '../src/engine/gex.js';
import { OrderFlow, valueArea } from '../src/engine/orderflow.js';
import { LocalOrderBook } from '../src/engine/orderbook.js';
import { assessRegime } from '../src/engine/regime.js';
import { parseDeribitName, parseOccSymbol } from '../src/collectors/options.js';

const signs = { callSign: 1, putSign: -1, flipRangePct: 0.3 };
const ofSettings = { cvdTrendMinutes: 15, cvdDirectionalRatio: 0.12, icebergWindowMs: 20000, icebergMinRatio: 3, zoneTtlMs: 4 * 3600e3 };

// Diff contigui allo snapshot: il primo ha U <= lastUpdateId <= u, i successivi pu = u precedente.
function diffFeed(snapshotId, apply) {
  let prev = null;
  return (b, a, E) => {
    const U = prev === null ? snapshotId : prev + 1;
    const ev = { U, u: U + 1, pu: prev ?? snapshotId - 1, E, b, a };
    prev = ev.u;
    return apply(ev);
  };
}

test('normCdf e gamma Black-Scholes', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  // Gamma massima vicino all'ATM.
  assert.ok(bsGamma(100, 100, 0.5, 0.1) > bsGamma(100, 130, 0.5, 0.1));
});

test('GEX: call sopra e put sotto -> flip fra i due strike', () => {
  const options = [
    { strike: 110, type: 'C', oi: 1000, iv: 0.5, years: 0.08, contractSize: 1 },
    { strike: 90, type: 'P', oi: 1000, iv: 0.5, years: 0.08, contractSize: 1 },
  ];
  const g = computeGex(options, 100, signs);
  assert.equal(g.callWall, 110);
  assert.equal(g.putWall, 90);
  assert.ok(g.flip > 90 && g.flip < 110, `flip ${g.flip}`);
  // Simmetria: il flip cade circa a meta'.
  assert.ok(Math.abs(g.flip - 100) < 2, `flip ${g.flip}`);
  assert.ok(totalGexAt(options, 108, signs) > 0);
  assert.ok(totalGexAt(options, 92, signs) < 0);
});

test('GEX: solo call -> gamma positivo e nessun flip', () => {
  const g = computeGex([{ strike: 100, type: 'C', oi: 500, iv: 0.6, years: 0.1, contractSize: 1 }], 100, signs);
  assert.ok(g.total > 0);
  assert.equal(g.flip, null);
});

test('parsing nomi opzioni', () => {
  assert.deepEqual(parseDeribitName('BTC-9OCT26-81000-P'), { base: 'BTC', expiry: Date.UTC(2026, 9, 9, 8), strike: 81000, type: 'P' });
  assert.equal(parseDeribitName('XRP_USDC-27DEC26-0d6-C').strike, 0.6);
  assert.equal(parseDeribitName('SOL_USDC-25DEC26-104-C').base, 'SOL');
  const occ = parseOccSymbol('GLD261001C00361000');
  assert.equal(occ.strike, 361);
  assert.equal(occ.type, 'C');
});

test('CVD e delta da sequenza di trade nota', () => {
  const of = new OrderFlow({ symbol: 'T', profileTick: 1, bigTradeUsd: 1e9, icebergMinUsd: 1e9, settings: ofSettings });
  const t0 = Date.UTC(2026, 0, 1, 10);
  of.onTrade(100, 5, false, t0); // acquisto aggressivo
  of.onTrade(100, 2, true, t0 + 1000); // vendita aggressiva
  of.onTrade(101, 3, false, t0 + 61000); // nuova barra
  const s = of.snapshot();
  assert.equal(s.session.delta, 6);
  assert.equal(s.session.volume, 10);
  assert.equal(s.bars.length, 2);
  assert.equal(s.bars[0].delta, 3);
  assert.equal(s.bars[1].cvd, 6);
});

test('value area al 70% attorno al POC', () => {
  const rows = [
    { price: 1, buy: 1, sell: 0 }, { price: 2, buy: 2, sell: 0 }, { price: 3, buy: 10, sell: 0 },
    { price: 4, buy: 3, sell: 0 }, { price: 5, buy: 1, sell: 0 },
  ];
  const va = valueArea(rows);
  assert.equal(va.poc, 3);
  assert.equal(va.val, 3); // 10 + 3 = 13 >= 70% di 17
  assert.equal(va.vah, 4);
});

test('iceberg: eseguito molto oltre la size visibile con refill', () => {
  const of = new OrderFlow({ symbol: 'T', profileTick: 1, bigTradeUsd: 1e9, icebergMinUsd: 1000, settings: ofSettings });
  const t0 = Date.UTC(2026, 0, 1, 10);
  of.onBookSnapshot({ lastUpdateId: 10, bids: [[100, 2]], asks: [[101, 2]] });
  const diff = diffFeed(10, (ev) => of.onBookDiff(ev));
  for (let i = 0; i < 10; i++) {
    of.onTrade(100, 2, true, t0 + i * 500); // vendite aggressive sul bid a 100
    assert.equal(diff([[100, 0.5]], [], t0 + i * 500 + 100), 'applied');
    assert.equal(diff([[100, 2]], [], t0 + i * 500 + 200), 'applied'); // il livello si ricarica
  }
  of.onTrade(100.5, 0.1, false, t0 + 40_000); // trade successivo: chiude la finestra
  const zone = of.snapshot().zones[0];
  assert.ok(zone, 'zona attesa');
  assert.equal(zone.side, 'bid');
  assert.equal(zone.kind, 'iceberg');
  assert.equal(zone.refills, 10);
  assert.ok(zone.ratio >= 9);
});

test('iceberg: senza ricariche è assorbimento; un nuovo snapshot non conta come ricarica', () => {
  const of = new OrderFlow({ symbol: 'T', profileTick: 1, bigTradeUsd: 1e9, icebergMinUsd: 1000, settings: ofSettings });
  const t0 = Date.UTC(2026, 0, 1, 10);
  // Prezzi come stringhe Binance: il trade a 100.1 deve trovare il livello "100.10".
  of.onBookSnapshot({ lastUpdateId: 10, bids: [['100.10', '2.000']], asks: [['101.00', '2.000']] });
  of.onTrade(100.1, 1, true, t0);
  assert.equal(of.displayedAt('bid', 100.1), 2);
  diffFeed(10, (ev) => of.onBookDiff(ev))([['100.10', '0.500']], [], t0 + 100);
  assert.equal(of.displayedAt('bid', 100.1), 0.5);
  of.resetBook(); // es. riconnessione: il book torna a 2 dopo il nuovo snapshot
  of.onBookSnapshot({ lastUpdateId: 50, bids: [['100.10', '2.000']], asks: [['101.00', '2.000']] });
  for (let i = 1; i < 10; i++) of.onTrade(100.1, 1, true, t0 + i * 500);
  of.onTrade(100.5, 0.1, false, t0 + 40_000);
  const zone = of.snapshot().zones[0];
  assert.ok(zone, 'zona attesa');
  assert.equal(zone.refills, 0);
  assert.equal(zone.kind, 'assorbimento');
  assert.equal(zone.ratio, 5);
});

test('iceberg: eseguito a book non sincronizzato non genera zone dopo il resync', () => {
  const of = new OrderFlow({ symbol: 'T', profileTick: 1, bigTradeUsd: 1e9, icebergMinUsd: 1000, settings: ofSettings });
  const t0 = Date.UTC(2026, 0, 1, 10);
  of.onBookSnapshot({ lastUpdateId: 10, bids: [[100, 20]], asks: [[101, 20]] });
  of.resetBook(); // riconnessione: book vuoto fino al nuovo snapshot
  for (let i = 0; i < 16; i++) of.onTrade(100, 1, true, t0 + i * 100); // 16 dei 20 esposti
  of.onBookSnapshot({ lastUpdateId: 50, bids: [[100, 4]], asks: [[101, 20]] }); // ne restano 4
  of.onTrade(100.5, 0.1, false, t0 + 40_000);
  assert.equal(of.snapshot().zones.length, 0);
  // Dopo il resync il livello riparte dalla size nota: un assorbimento vero resta visibile.
  for (let i = 0; i < 20; i++) of.onTrade(100, 1, true, t0 + 41_000 + i * 100);
  of.onTrade(100.5, 0.1, false, t0 + 80_000);
  const zone = of.snapshot().zones[0];
  assert.ok(zone, 'zona attesa');
  assert.equal(zone.executed, 20);
  assert.equal(zone.ratio, 5);
});

test('iceberg: livello attraversato non genera zona', () => {
  const of = new OrderFlow({ symbol: 'T', profileTick: 1, bigTradeUsd: 1e9, icebergMinUsd: 1000, settings: ofSettings });
  const t0 = Date.UTC(2026, 0, 1, 10);
  of.onBookSnapshot({ lastUpdateId: 10, bids: [[100, 1]], asks: [[101, 1]] });
  for (let i = 0; i < 10; i++) of.onTrade(100, 2, true, t0 + i * 500);
  of.onTrade(99, 1, true, t0 + 6000); // rottura sotto il livello
  of.onTrade(99, 0.1, true, t0 + 40_000);
  assert.equal(of.snapshot().zones.filter((z) => z.price === 100).length, 0);
});

test('regime: gamma negativo + rottura con aggressione = temporale long', () => {
  const of = {
    price: 110,
    profile: { vah: 105, val: 95, poc: 100, lvns: [], location: 'sopra' },
    cvdTrend: { minutes: 15, ratio: 0.3, direction: 'acquisti', divergence: false },
    zones: [],
    bigTrades: [],
  };
  const r = assessRegime(of, { total: -1e6, flip: 120, callWall: 130, putWall: 90 });
  assert.equal(r.weather, 'temporale');
  assert.equal(r.model, 'trend');
  assert.equal(r.bias, 'long');
});

test('regime: gamma positivo dentro value area = sereno', () => {
  const of = {
    price: 100,
    profile: { vah: 105, val: 95, poc: 100, lvns: [], location: 'dentro' },
    cvdTrend: { minutes: 15, ratio: 0.01, direction: 'neutro', divergence: false },
    zones: [],
    bigTrades: [],
  };
  const r = assessRegime(of, { total: 5e6, flip: 90, callWall: 110, putWall: 92 });
  assert.equal(r.weather, 'sereno');
  assert.equal(r.checklist[0].ok, true); // sul POC
});

test('book locale: snapshot + diff, evento stale e regola del primo evento', () => {
  const book = new LocalOrderBook();
  book.applySnapshot({ lastUpdateId: 100, bids: [['99.50', '1.000'], ['99.00', '2.000']], asks: [['100.50', '1.500'], ['101.00', '3.000']] });
  assert.equal(book.synced, true);
  assert.equal(book.bestBid(), 99.5);
  assert.equal(book.bestAsk(), 100.5);
  // u < lastUpdateId: scartato senza toccare il book.
  assert.equal(book.applyDiff({ U: 90, u: 99, pu: 89, b: [['99.50', '9']], a: [] }), 'stale');
  assert.equal(book.qtyAt('bid', 99.5), 1);
  // Primo evento: U <= lastUpdateId <= u.
  assert.equal(book.applyDiff({ U: 98, u: 101, pu: 97, b: [['99.50', '4.000'], ['99.80', '0.700']], a: [['100.50', '0.000']] }), 'applied');
  assert.equal(book.qtyAt('bid', 99.5), 4);
  assert.equal(book.bestBid(), 99.8);
  assert.equal(book.qtyAt('ask', 100.5), 0);
  assert.equal(book.bestAsk(), 101);
  assert.equal(book.applyDiff({ U: 102, u: 105, pu: 101, b: [], a: [['100.90', '2.000']] }), 'applied');
  assert.equal(book.bestAsk(), 100.9);
  assert.equal(book.lastUpdateId, 105);
  assert.equal(book.mid(), (99.8 + 100.9) / 2);
});

test('book locale: u == lastUpdateId vale come primo evento', () => {
  const book = new LocalOrderBook();
  book.applySnapshot({ lastUpdateId: 100, bids: [[99, 1]], asks: [[101, 1]] });
  assert.equal(book.applyDiff({ U: 100, u: 100, pu: 99, b: [[99, 2]], a: [] }), 'applied');
  assert.equal(book.qtyAt('bid', 99), 2);
});

test('book locale: snapshot più vecchio del primo evento -> resync', () => {
  const book = new LocalOrderBook();
  book.applySnapshot({ lastUpdateId: 100, bids: [[99, 1]], asks: [[101, 1]] });
  assert.equal(book.applyDiff({ U: 101, u: 104, pu: 100, b: [], a: [] }), 'resync');
  assert.equal(book.synced, false);
  assert.equal(book.size, 0);
  assert.equal(book.applyDiff({ U: 105, u: 106, pu: 104, b: [], a: [] }), 'resync');
});

test('book locale: buco nella sequenza (pu) -> resync', () => {
  const book = new LocalOrderBook();
  book.applySnapshot({ lastUpdateId: 100, bids: [[99, 1]], asks: [[101, 1]] });
  assert.equal(book.applyDiff({ U: 95, u: 110, pu: 94, b: [], a: [] }), 'applied');
  assert.equal(book.applyDiff({ U: 111, u: 120, pu: 110, b: [], a: [] }), 'applied');
  assert.equal(book.applyDiff({ U: 125, u: 130, pu: 124, b: [], a: [] }), 'resync');
  assert.equal(book.synced, false);
  assert.equal(book.bestBid(), null);
});

test('book locale: quantità zero rimuove il livello e aggiorna il best', () => {
  const book = new LocalOrderBook();
  book.applySnapshot({ lastUpdateId: 1, bids: [[100, 1], [99, 2]], asks: [[101, 1], [102, 2]] });
  const diff = diffFeed(1, (ev) => book.applyDiff(ev));
  diff([[100, 0], [98, 0]], [[101, '0.000']]);
  assert.equal(book.bids.has(100), false);
  assert.equal(book.asks.has(101), false);
  assert.equal(book.size, 2);
  assert.equal(book.bestBid(), 99);
  assert.equal(book.bestAsk(), 102);
});

test('book locale: banda ±% in nozionale e copertura dello snapshot', () => {
  // Meno livelli del limite: lo snapshot contiene tutto il book, banda coperta.
  const full = new LocalOrderBook();
  full.applySnapshot({ lastUpdateId: 1, bids: [[99.9, 1], [99.5, 2], [98, 50]], asks: [[100.1, 1], [100.5, 1], [102, 50]] });
  const d = full.bandDepth(0.01); // mid 100 -> 99..101
  assert.equal(d.mid, 100);
  assert.equal(d.bidQty, 3);
  assert.equal(d.askQty, 2);
  assert.ok(Math.abs(d.bidUsd - (99.9 + 199)) < 1e-9);
  assert.ok(Math.abs(d.askUsd - (100.1 + 100.5)) < 1e-9);
  assert.ok(Math.abs(d.bidShare - d.bidUsd / (d.bidUsd + d.askUsd)) < 1e-12);
  assert.equal(d.covered, true);
  // Snapshot pieno (= limite): la finestra esatta finisce al livello più profondo.
  const cut = new LocalOrderBook({ snapshotLimit: 2 });
  cut.applySnapshot({ lastUpdateId: 1, bids: [[99.9, 1], [99.5, 2]], asks: [[100.1, 1], [100.5, 1]] });
  assert.equal(cut.bandDepth(0.004).covered, true); // 99.6..100.4
  assert.equal(cut.bandDepth(0.01).covered, false);
  assert.equal(new LocalOrderBook().bandDepth(0.01), null);
});

test('book locale: pruning dei livelli lontani dal mid', () => {
  const book = new LocalOrderBook({ pruneFraction: 0.05 });
  book.applySnapshot({ lastUpdateId: 1, bids: [[99, 1], [96, 1], [94, 1]], asks: [[101, 1], [104, 1], [106, 1], [150, 1]] });
  assert.equal(book.prune(), 3);
  assert.deepEqual([...book.bids.keys()].sort(), [96, 99]);
  assert.deepEqual([...book.asks.keys()].sort(), [101, 104]);
  assert.equal(book.exactLow, 95);
  assert.equal(book.exactHigh, 105);
  // Pruning automatico ogni 200 diff applicati.
  const diff = diffFeed(1, (ev) => book.applyDiff(ev));
  diff([[50, 1]], []);
  assert.equal(book.bids.has(50), true);
  for (let i = 0; i < 199; i++) diff([], []);
  assert.equal(book.bids.has(50), false);
});

test('book locale: profilo di profondità per fasce', () => {
  const book = new LocalOrderBook();
  book.applySnapshot({ lastUpdateId: 1, bids: [[99.95, 2], [99.4, 1], [98.5, 9]], asks: [[100.05, 1], [100.95, 3]] });
  const p = book.depthProfile(0.01, 4); // 2 fasce per lato da 0,5
  assert.equal(p.mid, 100);
  assert.equal(p.step, 0.5);
  assert.deepEqual(p.bids, [Math.round(99.95 * 2), Math.round(99.4)]);
  assert.deepEqual(p.asks, [Math.round(100.05), Math.round(100.95 * 3)]);
  assert.equal(p.exactLow, 0);
  assert.equal(p.exactHigh, null); // lato completo: nessun limite superiore
});

test('book locale: rinfresco con secondo snapshot senza perdere i livelli esterni', () => {
  const book = new LocalOrderBook({ snapshotLimit: 2 });
  book.applySnapshot({ lastUpdateId: 10, bids: [[99, 1], [98, 1]], asks: [[101, 1], [102, 1]] });
  const diff = diffFeed(10, (ev) => book.applyDiff(ev));
  diff([[90, 5]], []); // livello lontano noto solo dai diff
  // Nuovo snapshot a id 20: dentro la sua finestra (97..103) vale lui.
  assert.equal(book.stageRefresh({ lastUpdateId: 20, bids: [[99, 3], [97, 2]], asks: [[101, 4], [103, 1]] }), true);
  diff([], []); // u = 13: stale per il nuovo snapshot
  assert.ok(book.staged);
  assert.equal(book.qtyAt('bid', 99), 1);
  book.applyDiff({ U: 14, u: 21, pu: 13, b: [], a: [[102, 0]] });
  assert.equal(book.staged, null);
  assert.equal(book.refreshes, 1);
  assert.equal(book.qtyAt('bid', 99), 3);
  assert.equal(book.qtyAt('bid', 97), 2);
  assert.equal(book.qtyAt('bid', 90), 5);
  assert.equal(book.qtyAt('ask', 102), 0);
  assert.equal(book.exactLow, 97);
  assert.equal(book.exactHigh, 103);
  assert.equal(book.bestAsk(), 101);
  // Snapshot di rinfresco piu' vecchio dei diff recenti: scartato, il book resta valido.
  assert.equal(book.stageRefresh({ lastUpdateId: 5, bids: [[99, 7]], asks: [[101, 7]] }), false);
  assert.equal(book.applyDiff({ U: 22, u: 23, pu: 21, b: [], a: [] }), 'applied');
  assert.equal(book.refreshFailures, 1);
  assert.equal(book.qtyAt('bid', 99), 3);
  assert.equal(book.synced, true);
});

test('book locale: rinfresco con snapshot allineato o di poco più vecchio del book', () => {
  const book = new LocalOrderBook();
  book.applySnapshot({ lastUpdateId: 10, bids: [[99, 1]], asks: [[101, 1]] });
  const diff = diffFeed(10, (ev) => book.applyDiff(ev));
  diff([[99, 2]], []); // U 10, u 11
  diff([[98, 1]], []); // U 12, u 13
  // Stesso update id del book: stesso stato, si sostituisce subito senza aspettare diff.
  assert.equal(book.stageRefresh({ lastUpdateId: 13, bids: [[99, 2], [98, 1], [97, 4]], asks: [[101, 1]] }), true);
  assert.equal(book.staged, null);
  assert.equal(book.refreshes, 1);
  assert.equal(book.qtyAt('bid', 97), 4);
  // Snapshot dentro un diff gia' applicato: lo allineano i diff recenti.
  diff([], [[101, 3]]); // U 14, u 15
  assert.equal(book.stageRefresh({ lastUpdateId: 12, bids: [[99, 2], [96, 5]], asks: [[101, 1]] }), true);
  assert.equal(book.refreshes, 2);
  assert.equal(book.refreshFailures, 0);
  assert.equal(book.qtyAt('bid', 96), 5);
  assert.equal(book.qtyAt('bid', 98), 1);
  assert.equal(book.qtyAt('ask', 101), 3);
  assert.equal(book.applyDiff({ U: 16, u: 17, pu: 15, b: [], a: [] }), 'applied');
});

test('pressione book: EMA sul tempo reale con dt irregolari', () => {
  const of = new OrderFlow({ symbol: 'T', profileTick: 1, bigTradeUsd: 1e9, icebergMinUsd: 1e9, settings: { ...ofSettings, bookBandPct: 1, bookSmoothingSec: 10 } });
  assert.equal(of.bookPressure(), null);
  of.onBookSnapshot({ lastUpdateId: 1, bids: [[99.9, 1]], asks: [[100.1, 1]] });
  const diff = diffFeed(1, (ev) => of.onBookDiff(ev));
  const share = (bid, ask) => (99.9 * bid) / (99.9 * bid + 100.1 * ask);
  const step = (prev, value, dtMs) => prev + (1 - Math.exp(-dtMs / 10_000)) * (value - prev);

  diff([], [], 1000); // il primo campione inizializza
  let p = of.bookPressure();
  assert.equal(p.smooth, share(1, 1));
  assert.equal(p.raw, share(1, 1));
  assert.equal(p.bandPct, 1);
  assert.equal(p.smoothingSec, 10);

  diff([[99.9, 3]], [], 3000); // dt 2 s
  let expected = step(share(1, 1), share(3, 1), 2000);
  p = of.bookPressure();
  assert.ok(Math.abs(p.smooth - expected) < 1e-12);
  assert.equal(p.raw, share(3, 1));

  diff([], [[100.1, 4]], 3200); // entro 500 ms dal campione precedente: non campiona
  assert.equal(of.bookPressure().smooth, p.smooth);

  diff([], [], 10_000); // dt 7 s dall'ultimo campione
  expected = step(expected, share(3, 4), 7000);
  p = of.bookPressure();
  assert.ok(Math.abs(p.smooth - expected) < 1e-12);
  assert.ok(Math.abs(p.bidUsd - 99.9 * 3) < 1e-9);
  assert.ok(Math.abs(p.askUsd - 100.1 * 4) < 1e-9);

  of.samplePressure(10_000 + 600_000); // dopo una lunga pausa alpha ~ 1
  assert.ok(Math.abs(of.bookPressure().smooth - share(3, 4)) < 1e-12);
  const snap = of.snapshot();
  assert.equal(snap.bookPressure.smooth, of.bookPressure().smooth);
  assert.equal(snap.depth.bids.length, 20);
  assert.equal(of.snapshot({ depth: false }).depth, null);
});

test('regime: sbilanciamento del book solo informativo', () => {
  const of = {
    price: 100,
    profile: { vah: 105, val: 95, poc: 100, lvns: [], location: 'dentro' },
    cvdTrend: { minutes: 15, ratio: 0.01, direction: 'neutro', divergence: false },
    zones: [],
    bigTrades: [],
  };
  const gex = { total: 5e6, flip: 90, callWall: 110, putWall: 92 };
  const base = assessRegime(of, gex);
  const buy = assessRegime({ ...of, bookPressure: { smooth: 0.7, bandPct: 0.25, synced: true } }, gex);
  const sell = assessRegime({ ...of, bookPressure: { smooth: 0.35, bandPct: 0.25, synced: true } }, gex);
  const flat = assessRegime({ ...of, bookPressure: { smooth: 0.6, bandPct: 0.25, synced: true } }, gex);
  const frozen = assessRegime({ ...of, bookPressure: { smooth: 0.9, bandPct: 0.25, synced: false } }, gex);
  assert.equal(buy.score, base.score);
  assert.equal(buy.weather, base.weather);
  assert.ok(buy.reasons.some((r) => r.startsWith('Book ±0,25% sbilanciato in acquisto')));
  assert.ok(sell.reasons.some((r) => r.startsWith('Book ±0,25% sbilanciato in vendita')));
  assert.equal(flat.reasons.some((r) => r.startsWith('Book')), false);
  // Book in risincronizzazione: valore fermo, nessun motivo.
  assert.equal(frozen.reasons.some((r) => r.startsWith('Book')), false);
});

test('regime: book resettato dopo uno sbilanciamento non produce il motivo', () => {
  const of = new OrderFlow({ symbol: 'T', profileTick: 1, bigTradeUsd: 1e9, icebergMinUsd: 1e9, settings: { ...ofSettings, bookBandPct: 1 } });
  of.onBookSnapshot({ lastUpdateId: 1, bids: [[99.9, 9]], asks: [[100.1, 1]] });
  diffFeed(1, (ev) => of.onBookDiff(ev))([], [], 1000);
  const gex = { total: 5e6, flip: 90, callWall: 110, putWall: 92 };
  assert.ok(assessRegime(of.snapshot(), gex).reasons.some((r) => r.startsWith('Book ±1% sbilanciato in acquisto')));
  of.resetBook();
  const snap = of.snapshot();
  assert.equal(snap.bookPressure.synced, false);
  assert.equal(assessRegime(snap, gex).reasons.some((r) => r.startsWith('Book')), false);
});

test('orderflow: la kline ancora aperta fa da base al minuto corrente; buchi potati con la finestra', () => {
  const of = new OrderFlow({ symbol: 'T', profileTick: 1, bigTradeUsd: 1e9, icebergMinUsd: 1e9, settings: ofSettings });
  const t0 = Date.UTC(2026, 0, 1, 10);
  const k = (t, v, takerBuy) => [t, '100', '101', '99', '100', String(v), t + 59_999, '0', 5, String(takerBuy)];
  of.bootstrap([k(t0, 10, 6), k(t0 + 60_000, 4, 3)]); // la seconda era ancora aperta alla fetch
  of.onTrade(100, 2, true, t0 + 90_000); // stesso minuto: si somma alla kline, non la sostituisce
  assert.equal(of.bars.length, 2);
  assert.equal(of.bars[1].v, 6);
  assert.equal(of.bars[1].delta, 2 * 3 - 4 - 2);
  assert.equal(of.snapshot().session.volume, 16);

  const gaps = of.gaps;
  of.addGap(-Infinity, t0 - 1000); // prima della finestra delle barre: subito potato
  of.addGap(t0 + 60_000, t0 + 62_000);
  assert.deepEqual(of.gaps, [[t0 + 60_000, t0 + 62_000]]);
  assert.equal(of.gaps, gaps, 'stesso array: chi lo tiene vede i buchi nuovi');
});
