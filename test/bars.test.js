import test from 'node:test';
import assert from 'node:assert/strict';
import { TIMEFRAMES, MAX_BARS, isTimeframe, timeframe, bucketStart, klineToBar, aggregate, holed, mergeBars, withCvd, buildSeries, cvdModeOf, BarSeries } from '../src/bars.js';
import { klinesWeight } from '../src/collectors/binance.js';

const MIN = 60_000;
const at = (d, h, m) => Date.UTC(2026, 0, d, h, m);

// Kline Binance come arriva dal REST (stringhe): delta = 2 * takerBuy - volume.
const kline = (t, o, h, l, c, v, takerBuy) => [t, String(o), String(h), String(l), String(c), String(v), t + 15 * MIN - 1, '0', 10, String(takerBuy), '0', '0'];

// Barre 1m contigue da `from`: prezzo che sale di 1 a minuto, delta +1 nei minuti pari e -1 nei dispari.
function minutes(from, count) {
  return Array.from({ length: count }, (_, i) => {
    const o = 100 + i;
    return { t: from + i * MIN, o, h: o + 2, l: o - 1, c: o + 1, v: 10, delta: i % 2 ? -1 : 1 };
  });
}

const steps = (bars) => bars.slice(1).map((b, i) => b.t - bars[i].t);

test('timeframe: elenco chiuso e validazione', () => {
  assert.deepEqual(Object.keys(TIMEFRAMES), ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '4h', '1d']);
  assert.deepEqual(Object.values(TIMEFRAMES).map((s) => s.ms / MIN), [1, 3, 5, 15, 30, 45, 60, 240, 1440]);
  assert.equal(TIMEFRAMES['45m'].interval, '15m');
  assert.equal(TIMEFRAMES['45m'].limit, 1500);
  for (const tf of ['2m', '1M', '1H', '60m', '1w', '', ' 1m', '__proto__', 'constructor', 'toString', null, undefined, 45]) {
    assert.equal(isTimeframe(tf), false, String(tf));
  }
  assert.throws(() => timeframe('2h'), RangeError);
  assert.equal(cvdModeOf(TIMEFRAMES['1h'].ms), 'giornaliero');
  assert.equal(cvdModeOf(TIMEFRAMES['4h'].ms), 'cumulativo');
  assert.equal(cvdModeOf(TIMEFRAMES['1d'].ms), 'cumulativo');
});

test('peso REST delle klines in funzione di limit', () => {
  assert.deepEqual([1, 99, 100, 499, 500, 1000, 1001, 1500].map(klinesWeight), [1, 1, 2, 2, 5, 5, 10, 10]);
});

test('45m da klines 15m: bucket allineati al giorno UTC anche a cavallo della mezzanotte', () => {
  // 22:15 cade a meta' del bucket 21:45 (scartato); poi 22:30, 23:15, 00:00, 00:45 e 01:30 in formazione.
  const start = at(1, 22, 15);
  const klines = Array.from({ length: 14 }, (_, i) => kline(start + i * 15 * MIN, 100 + i, 105 + i, 95 + i, 101 + i, 10, 6 + (i % 3)));
  const bars = aggregate(klines.map(klineToBar), TIMEFRAMES['45m'].ms);
  assert.deepEqual(bars.map((b) => new Date(b.t).toISOString().slice(0, 16)), [
    '2026-01-01T22:30', '2026-01-01T23:15', '2026-01-02T00:00', '2026-01-02T00:45', '2026-01-02T01:30',
  ]);
  assert.deepEqual(steps(bars), [45 * MIN, 45 * MIN, 45 * MIN, 45 * MIN]);
  // 22:30 = klines 1..3: open della prima, close dell'ultima, estremi, somme.
  assert.deepEqual(bars[0], { t: at(1, 22, 30), o: 101, h: 108, l: 96, c: 104, v: 30, delta: 2 * (7 + 8 + 6) - 30 });
  assert.equal(bars[2].t, at(2, 0, 0));
  assert.equal(bars[2].o, 107);
  assert.equal(bars[4].v, 10);
  assert.equal(bucketStart(at(1, 23, 59), 45 * MIN), at(1, 23, 15));
  assert.equal(bucketStart(at(2, 0, 44), 45 * MIN), at(2, 0, 0));
});

test('aggregazione 1m -> 3m, 1h e 1d', () => {
  const src = minutes(at(1, 22, 58), 128); // 22:58 -> 01:05 del giorno dopo
  const m3 = aggregate(src, 3 * MIN);
  assert.equal(m3[0].t, at(1, 23, 0)); // 22:57 incompleto scartato
  assert.deepEqual(new Set(steps(m3)), new Set([3 * MIN]));
  assert.deepEqual(m3[0], { t: at(1, 23, 0), o: 102, h: 106, l: 101, c: 105, v: 30, delta: 1 });
  assert.equal(m3.at(-1).t, at(2, 1, 3));
  assert.equal(m3.at(-1).v, 30);

  const h1 = aggregate(src, 60 * MIN);
  assert.deepEqual(h1.map((b) => b.t), [at(1, 23, 0), at(2, 0, 0), at(2, 1, 0)]);
  assert.deepEqual(h1[0], { t: at(1, 23, 0), o: 102, h: 163, l: 101, c: 162, v: 600, delta: 0 });
  assert.equal(h1[2].v, 60); // 01:00-01:05 in formazione

  const d1 = aggregate(src, 1440 * MIN);
  assert.deepEqual(d1.map((b) => b.t), [at(2, 0, 0)]); // il 1 gennaio parte alle 22:58: scartato
  assert.equal(d1[0].o, 162);
  assert.equal(d1[0].c, 228);
  assert.equal(d1[0].v, 660);
  assert.equal(src[0].v, 10, 'le barre di origine non vengono modificate');
});

test('giunzione storico/live: chiuse dallo storico, dal bucket aperto alla fetch le barre live', () => {
  const ms = 60 * MIN;
  // Storico REST 1h da 18:00 a 01:00 compreso (01:00 era ancora aperto alla fetch, valori vecchi).
  const history = Array.from({ length: 8 }, (_, i) => ({ t: at(1, 18, 0) + i * ms, o: 1, h: 2, l: 0.5, c: 1.5, v: 99, delta: 5 }));
  const live1m = minutes(at(1, 22, 58), 128);
  const merged = mergeBars(history, aggregate(live1m, ms));
  assert.deepEqual(merged.map((b) => b.t), Array.from({ length: 8 }, (_, i) => at(1, 18, 0) + i * ms));
  assert.equal(merged[4].v, 99); // 22:00 dallo storico: le barre 1m lo coprono solo in parte
  assert.equal(merged[5].v, 99); // 23:00 chiuso: la candela Binance, non quella ricostruita dalle barre 1m
  assert.equal(merged[6].v, 99);
  assert.equal(merged.at(-1).v, 60); // 01:00 dal live, non la versione vecchia dello storico

  // Il bucket corrente si aggiorna a ogni nuova barra 1m, senza aggiungere candele.
  const before = buildSeries('1h', history, live1m);
  live1m.push({ t: at(2, 1, 6), o: 300, h: 400, l: 290, c: 350, v: 7, delta: 3 });
  const after = buildSeries('1h', history, live1m);
  assert.equal(after.bars.length, before.bars.length);
  assert.equal(after.bars.at(-1).t, at(2, 1, 0));
  assert.equal(after.bars.at(-1).h, 400);
  assert.equal(after.bars.at(-1).c, 350);
  assert.equal(after.bars.at(-1).v, 67);
  assert.equal(after.liveFrom, at(2, 1, 0));
  assert.equal(after.historyGap, undefined);
  // Senza barre live resta lo storico intero; senza storico solo le barre live.
  assert.equal(mergeBars(history, []).length, 8);
  assert.deepEqual(mergeBars([], aggregate(live1m, ms)).map((b) => b.v), [600, 600, 67]);

  // Storico vecchio (22:00 aperto alla fetch) e barre live dalle 00:00: chiuse fino alle 21:00, buco, poi il live.
  const stale = buildSeries('1h', history.slice(0, 5), minutes(at(2, 0, 0), 66));
  assert.deepEqual(stale.bars.map((b) => b.t), [at(1, 18, 0), at(1, 19, 0), at(1, 20, 0), at(1, 21, 0), at(2, 0, 0), at(2, 1, 0)]);
  assert.deepEqual(stale.historyGap, { from: at(1, 22, 0), to: at(2, 0, 0) });
  assert.equal(stale.liveFrom, at(2, 0, 0));
});

test('buchi nei trade live: il primo bucket che li contiene viene scartato', () => {
  // Bootstrap fallito, primo trade alle 20:00:30: il minuto 20:00 e' allineato a ogni timeframe ma parziale.
  const live1m = minutes(at(1, 20, 0), 12); // 20:00 .. 20:11
  const start = [[-Infinity, at(1, 20, 0) + 30_000]];
  assert.deepEqual(aggregate(live1m, 5 * MIN, start).map((b) => b.t), [at(1, 20, 5), at(1, 20, 10)]);
  assert.equal(aggregate(live1m, MIN, start)[0].t, at(1, 20, 1));
  assert.equal(aggregate(live1m, 5 * MIN)[0].t, at(1, 20, 0));
  // Un buco a meta' finestra non tocca il primo bucket: lo sostituisce lo storico quando si chiude.
  assert.equal(aggregate(live1m, 5 * MIN, [[at(1, 20, 7), at(1, 20, 7) + 2000]])[0].t, at(1, 20, 0));
  assert.equal(holed(at(1, 20, 5), 5 * MIN, [[at(1, 20, 7), at(1, 20, 7) + 2000]]), true);
  assert.equal(holed(at(1, 20, 10), 5 * MIN, [[at(1, 20, 7), at(1, 20, 7) + 2000]]), false);
});

test('v, delta e CVD arrotondati: niente residui delle somme in virgola mobile', () => {
  const bars = [0.1, 0.2, 3.68].map((delta, i) => ({ t: at(1, 0, i), o: 1, h: 1, l: 1, c: 1, v: 0.1 + 0.2, delta }));
  const out = withCvd(bars, 'giornaliero');
  assert.deepEqual(out.map((b) => b.cvd), [0.1, 0.3, 3.98]);
  assert.equal(out[0].v, 0.3);
});

test('CVD: giornaliero si azzera a mezzanotte UTC, cumulativo parte dalla finestra restituita', () => {
  const bars = [at(1, 22, 0), at(1, 23, 0), at(2, 0, 0), at(2, 1, 0)].map((t, i) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 10, delta: [4, -1, 2, 3][i] }));
  assert.deepEqual(withCvd(bars, 'giornaliero').map((b) => b.cvd), [4, 3, 2, 5]);
  assert.deepEqual(withCvd(bars, 'cumulativo').map((b) => b.cvd), [4, 3, 5, 8]);

  // Giornaliero calcolato prima del taglio: la prima barra visibile non riparte da zero.
  const src = minutes(at(1, 22, 0), 180);
  const daily = buildSeries('3m', [], src, 30);
  assert.equal(daily.cvdMode, 'giornaliero');
  assert.equal(daily.bars.length, 30);
  const full = withCvd(aggregate(src, 3 * MIN), 'giornaliero');
  assert.deepEqual(daily.bars.map((b) => b.cvd), full.slice(-30).map((b) => b.cvd));

  const h4 = Array.from({ length: 12 }, (_, i) => ({ t: at(1, 0, 0) + i * 4 * 60 * MIN, o: 1, h: 1, l: 1, c: 1, v: 1, delta: 1 }));
  const cum = buildSeries('4h', h4, [], 5);
  assert.equal(cum.cvdMode, 'cumulativo');
  assert.deepEqual(cum.bars.map((b) => b.cvd), [1, 2, 3, 4, 5]);
  assert.equal(cum.liveFrom, null);
});

test('storico in cache: fetch condivisa, TTL, ripiego sulle barre 1m se il REST fallisce', async () => {
  let now = at(2, 1, 6);
  const calls = [];
  let fail = false;
  let release;
  // Klines 15m dalle 12:00 fino al bucket in formazione delle 01:00.
  const klines = Array.from({ length: 53 }, (_, i) => kline(at(1, 12, 0) + i * 15 * MIN, 1, 2, 0.5, 1.5, 4, 3));
  const svc = new BarSeries({
    now: () => now,
    ttlMs: 30 * MIN,
    retryMs: 30_000,
    fetchKlines: async (symbol, interval, limit) => {
      calls.push(`${symbol} ${interval} ${limit}`);
      await new Promise((resolve) => { release = resolve; });
      if (fail) throw new Error('HTTP 503');
      return klines;
    },
  });
  const live1m = minutes(at(1, 22, 58), 128);

  const pending = [svc.get('BTCUSDT', '45m', live1m), svc.get('BTCUSDT', '45m', live1m)];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all(pending);
  assert.deepEqual(calls, ['BTCUSDT 15m 1500'], 'una sola fetch per richieste contemporanee');
  assert.deepEqual(a, b);
  assert.equal(a.tf, '45m');
  assert.equal(a.historyError, undefined);
  assert.deepEqual(new Set(steps(a.bars)), new Set([45 * MIN]));
  assert.equal(a.bars[0].t, at(1, 12, 0));
  assert.equal(a.liveFrom, at(2, 0, 45)); // 22:30, 23:15 e 00:00 chiuse: arrivano dallo storico
  assert.equal(a.bars.at(-1).t, at(2, 0, 45));

  // Poll successivi entro il TTL: nessuna nuova fetch.
  now += 2000;
  await svc.get('BTCUSDT', '45m', live1m);
  assert.equal(calls.length, 1);

  // Scaduto il TTL la fetch riparte; se fallisce restano valide le candele chiuse gia' in cache.
  now += 31 * MIN;
  fail = true;
  const stale = svc.get('BTCUSDT', '45m', live1m);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const s = await stale;
  assert.equal(calls.length, 2);
  assert.equal(s.historyError, undefined);
  assert.equal(s.bars[0].t, at(1, 12, 0));

  // Nessuno storico disponibile: solo le barre 1m aggregate, con l'errore, e nessun nuovo tentativo prima di retryMs.
  const fresh = svc.get('ETHUSDT', '1h', live1m);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const e = await fresh;
  assert.equal(e.historyError, 'HTTP 503');
  assert.deepEqual(e.bars.map((x) => x.t), [at(1, 23, 0), at(2, 0, 0), at(2, 1, 0)]);
  now += 2000;
  const again = await svc.get('ETHUSDT', '1h', live1m);
  assert.equal(again.historyError, 'HTTP 503');
  assert.equal(calls.length, 3);

  // 1m con la finestra live gia' piena: nessuna richiesta REST.
  const full = await svc.get('BTCUSDT', '1m', minutes(at(1, 0, 0), 1500));
  assert.equal(full.bars.length, MAX_BARS);
  assert.equal(calls.length, 3);
});

test('candele chiuse da Binance; un bucket live con trade mancanti si richiede appena si chiude', async () => {
  let now = at(1, 20, 6);
  const calls = [];
  // Klines 5m da Binance (v=77) dalle 12:00 fino al bucket ancora aperto alla fetch.
  const svc = new BarSeries({
    now: () => now,
    fetchKlines: async (symbol, interval) => {
      calls.push(interval);
      const until = bucketStart(now, 5 * MIN);
      return Array.from({ length: (until - at(1, 12, 0)) / (5 * MIN) + 1 }, (_, i) => kline(at(1, 12, 0) + i * 5 * MIN, 1, 2, 0.5, 1.5, 77, 40));
    },
  });
  // Barre 1m dalle 18:00 (v=10); al minuto di avvio 20:05 mancano i trade prima della connessione.
  const live1m = minutes(at(1, 18, 0), 126);
  live1m.at(-1).v = 1;
  const gaps = [[at(1, 20, 5) + 10_000, at(1, 20, 5) + 12_000]];

  const a = await svc.get('BTCUSDT', '5m', live1m, gaps);
  assert.deepEqual(calls, ['5m']);
  assert.equal(a.bars.find((b) => b.t === at(1, 19, 0)).v, 77); // chiusa: Binance, non le barre 1m (5 x 10)
  assert.equal(a.bars.at(-1).t, at(1, 20, 5));
  assert.equal(a.bars.at(-1).v, 1); // in formazione: dalle barre 1m
  assert.equal(a.liveFrom, at(1, 20, 5));

  // 20:10: il bucket 20:05 si e' chiuso con trade mancanti e per lo storico era ancora aperto: fetch prima del TTL,
  // senza attenderla perche' la cache copre ancora la giunzione.
  live1m.push(...minutes(at(1, 20, 6), 5).map((b) => ({ ...b, delta: 2 })));
  now = at(1, 20, 10) + 2000;
  const b = await svc.get('BTCUSDT', '5m', live1m, gaps);
  assert.equal(b.bars.find((x) => x.t === at(1, 20, 5)).v, 41);
  assert.equal(b.rev, a.rev);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  const c = await svc.get('BTCUSDT', '5m', live1m, gaps);
  assert.equal(c.bars.find((x) => x.t === at(1, 20, 5)).v, 77);
  assert.equal(c.liveFrom, at(1, 20, 10));
  assert.notEqual(c.rev, a.rev, 'storico nuovo: il client deve ricaricare la serie intera');
  // Ora lo storico ha il bucket chiuso: nessuna nuova fetch.
  now += 2000;
  await svc.get('BTCUSDT', '5m', live1m, gaps);
  assert.equal(calls.length, 2);
});

test('TTL scaduto: risposta subito dalla cache mentre la fetch nuova e\' ancora in corso', async () => {
  let now = at(2, 1, 6);
  let calls = 0;
  const klines = Array.from({ length: 53 }, (_, i) => kline(at(1, 12, 0) + i * 15 * MIN, 1, 2, 0.5, 1.5, 4, 3));
  // Dalla seconda fetch Binance non risponde piu'.
  const svc = new BarSeries({ now: () => now, fetchKlines: async () => (++calls === 1 ? klines : new Promise(() => {})) });
  const live1m = minutes(at(1, 22, 58), 128);
  const a = await svc.get('BTCUSDT', '45m', live1m);
  now += 31 * MIN;
  const b = await svc.get('BTCUSDT', '45m', live1m);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(b, a);
});

test('storico che non arriva piu\' alle barre 1m e REST in errore: restano le candele chiuse in cache', async () => {
  // Fetch 1d alle 23:50 del giorno 1: il giorno 1 e' ancora aperto.
  const daily = Array.from({ length: 10 }, (_, i) => kline(at(1, 0, 0) - (9 - i) * 1440 * MIN, 1, 2, 0.5, 1.5, 77, 40));
  let now = at(1, 23, 50);
  let fail = false;
  const svc = new BarSeries({ now: () => now, fetchKlines: async () => { if (fail) throw new Error('HTTP 503'); return daily; } });
  const window1m = () => minutes(now - 1500 * MIN, 1500);
  const ok = await svc.get('BTCUSDT', '1d', window1m());
  assert.equal(ok.bars.length, 10);
  assert.equal(ok.historyError, undefined);

  // Il giorno dopo alle 01:02 le barre 1m non coprono piu' il giorno 1 e la nuova fetch fallisce.
  now = at(2, 1, 2);
  fail = true;
  const s = await svc.get('BTCUSDT', '1d', window1m());
  assert.equal(s.historyError, 'HTTP 503');
  assert.equal(s.historyAt, at(1, 23, 50));
  assert.deepEqual(s.historyGap, { from: at(1, 0, 0), to: at(2, 0, 0) });
  assert.equal(s.bars.length, 10); // 9 giorni chiusi dalla cache + il giorno 2 dalle barre 1m
  assert.equal(s.bars.at(-2).t, at(0, 0, 0));
  assert.equal(s.bars.at(-1).t, at(2, 0, 0));
});

test('1m con la finestra live piena: REST solo per sostituire un minuto chiuso con trade mancanti', async () => {
  const now = at(2, 0, 59) + 30_000;
  let calls = 0;
  let fail = false;
  const svc = new BarSeries({
    now: () => now,
    fetchKlines: async (symbol, interval, limit) => {
      calls += 1;
      if (fail) throw new Error('HTTP 503');
      return Array.from({ length: limit }, (_, i) => kline(at(2, 0, 59) - (limit - 1 - i) * MIN, 1, 2, 0.5, 1.5, 77, 40));
    },
  });
  const live1m = minutes(at(1, 0, 0), 1500); // fino alle 00:59 del giorno 2, in formazione
  const plain = await svc.get('BTCUSDT', '1m', live1m);
  assert.equal(calls, 0);
  assert.equal(plain.bars.find((b) => b.t === at(2, 0, 30)).v, 10);

  // Minuto 00:30 con trade persi (riconnessione): si legge da Binance, il resto resta live da li' in poi.
  const gaps = [[at(2, 0, 30) + 5000, at(2, 0, 30) + 8000]];
  const fixed = await svc.get('BTCUSDT', '1m', live1m, gaps);
  assert.equal(calls, 1);
  assert.equal(fixed.bars.length, MAX_BARS);
  assert.equal(fixed.bars.find((b) => b.t === at(2, 0, 30)).v, 77);
  assert.equal(fixed.liveFrom, at(2, 0, 59));
  assert.equal(fixed.historyError, undefined);

  // REST in errore: restano le 1000 barre live, senza la nota di storico mancante.
  fail = true;
  const other = await svc.get('ETHUSDT', '1m', live1m, gaps);
  assert.equal(calls, 2);
  assert.equal(other.bars.length, MAX_BARS);
  assert.equal(other.historyError, undefined);
});
