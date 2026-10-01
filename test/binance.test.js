import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchKlines } from '../src/collectors/binance.js';

test('blocco REST condiviso: risposte arrivate dopo un 418 non accorciano il ban', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  // Ogni fetch resta in sospeso finche' il test non le da' una risposta.
  const pending = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));
  const reply = (status, headers) => new Response(status === 200 ? '[]' : '', { status, headers });

  // Tre richieste partite prima del ban; il 418 arriva per primo, 429 e 200 ad alto peso dopo.
  const calls = [1, 2, 3].map(() => fetchKlines('BTCUSDT', '1m', 1000, { wait: false }).catch((err) => err));
  assert.equal(pending.length, 3);
  pending[0](reply(418, { 'retry-after': '7200' }));
  pending[1](reply(429, { 'retry-after': '60' }));
  pending[2](reply(200, { 'x-mbx-used-weight-1m': '2390' }));
  const [banned, limited, ok] = await Promise.all(calls);
  assert.match(banned.message, /HTTP 418, pausa 7200s/);
  assert.match(limited.message, /HTTP 429/);
  assert.deepEqual(ok, []);

  const err = await fetchKlines('BTCUSDT', '1m', 1000, { wait: false }).catch((e) => e);
  assert.equal(pending.length, 3, 'nessuna richiesta durante il ban');
  const sec = Number(/in pausa per (\d+)s/.exec(err.message)?.[1]);
  assert.ok(sec > 7100, err.message);
});
