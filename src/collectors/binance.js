import WebSocket from 'ws';

const REST = 'https://fapi.binance.com';
// Binance USDⓈ-M separa i flussi: i trade passano da /market, il book da /public.
// Il vecchio endpoint /stream accetta la sottoscrizione ma non invia piu' gli aggTrade.
const MARKET_STREAM = 'wss://fstream.binance.com/market/stream';
const PUBLIC_STREAM = 'wss://fstream.binance.com/public/stream';
const DEPTH_LIMIT = 1000; // massimo consentito, peso 20
const WEIGHT_CAP = 1800; // margine sul limite di 2400 per minuto e per IP
const BOOK_REFRESH_MS = 5 * 60_000;
const MAX_BUFFER = 300; // ~30 s di diff a 100 ms: piu' del tempo di risposta dello snapshot

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Il peso REST e' per IP, quindi condiviso fra tutti i simboli e tutte le richieste.
let restBlockedUntil = 0;
let usedWeight = 0;
let usedMinute = 0;

// Peso delle klines in funzione di limit (documentazione Binance USDⓈ-M).
export const klinesWeight = (limit) => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10);

// GET con blocco condiviso: 429/418 fermano tutto per Retry-After, oltre WEIGHT_CAP si aspetta
// il minuto successivo. Con wait=false, durante un blocco si fallisce subito invece di attendere.
// Il blocco si puo' solo allungare: una risposta arrivata dopo un 418 non accorcia il ban.
async function restGet(path, weight, label, { wait = true } = {}) {
  for (;;) {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    if (minute !== usedMinute) { usedMinute = minute; usedWeight = 0; }
    if (usedWeight + weight > WEIGHT_CAP) restBlockedUntil = Math.max(restBlockedUntil, (minute + 1) * 60_000 + 1000);
    if (restBlockedUntil <= now) break;
    if (!wait) throw new Error(`${label}: REST Binance in pausa per ${Math.ceil((restBlockedUntil - now) / 1000)}s`);
    // Ricontrolla al risveglio: il blocco puo' essere stato esteso nel frattempo.
    await sleep(restBlockedUntil - now);
  }
  usedWeight += weight;
  const res = await fetch(`${REST}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 429 || res.status === 418) {
    const retrySec = Number(res.headers.get('retry-after')) || 60;
    restBlockedUntil = Math.max(restBlockedUntil, Date.now() + retrySec * 1000);
    throw new Error(`${label}: HTTP ${res.status}, pausa ${retrySec}s`);
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const used = Number(res.headers.get('x-mbx-used-weight-1m'));
  if (used > 0 && Math.floor(Date.now() / 60_000) === usedMinute) usedWeight = Math.max(usedWeight, used);
  if (used >= WEIGHT_CAP) restBlockedUntil = Math.max(restBlockedUntil, (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 1000);
  return res.json();
}

export function fetchKlines(symbol, interval = '1m', limit = 1500, opts) {
  return restGet(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, klinesWeight(limit), `klines ${symbol} ${interval}`, opts);
}

const fetchDepth = (symbol) => restGet(`/fapi/v1/depth?symbol=${symbol}&limit=${DEPTH_LIMIT}`, 20, `depth ${symbol}`);

// Socket con riconnessione esponenziale e watchdog: Binance chiude dopo 24 h,
// un socket silenzioso per 60 s o ancora in connessione dopo 30 s viene considerato morto.
function openStream(name, url, onData, channel, log, onReset = () => {}) {
  let backoff = 1000;
  const connect = () => {
    const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
    const startedAt = Date.now();
    ws.on('open', () => {
      channel.connected = true;
      channel.error = null;
      channel.lastMessageTs = Date.now();
      backoff = 1000;
      onReset();
      log(`[binance] ${name} connesso`);
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg.data) return;
      channel.lastMessageTs = Date.now();
      onData(msg.data);
    });
    ws.on('error', (err) => { channel.error = String(err.message ?? err); });
    ws.on('close', () => {
      channel.connected = false;
      channel.reconnects += 1;
      onReset();
      log(`[binance] ${name} disconnesso, riconnessione fra ${backoff / 1000}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    });
    const watchdog = setInterval(() => {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) { clearInterval(watchdog); return; }
      const open = ws.readyState === WebSocket.OPEN;
      if (Date.now() - (open ? channel.lastMessageTs : startedAt) > (open ? 60_000 : 30_000)) ws.terminate();
    }, 15_000);
  };
  connect();
}

// aggTrade + book locale completo (snapshot REST + diff @depth 100 ms) per un perpetual Binance.
// Lo storico della sessione arriva dalle klines 1m, compresa l'ultima ancora aperta a cui si sommano
// i trade live. I trade persi fra le klines e la connessione, e a ogni riconnessione, restano segnati
// come buchi nell'orderflow: le candele che li contengono non vengono prese per complete.
export function startBinance(symbol, orderflow, log) {
  const book = orderflow.book;
  const newChannel = () => ({ connected: false, lastMessageTs: 0, reconnects: 0, error: null });
  const status = {
    source: 'binance',
    symbol,
    bootstrapped: false,
    error: null,
    trades: newChannel(),
    book: {
      ...newChannel(),
      resyncs: 0,
      snapshots: 0,
      get synced() { return book.synced; },
      get lastUpdateId() { return book.lastUpdateId; },
      get levels() { return book.size; },
      get refreshes() { return book.refreshes; },
      get refreshFailures() { return book.refreshFailures; },
    },
    get connected() { return this.trades.connected && this.book.connected; },
    get reconnects() { return this.trades.reconnects + this.book.reconnects; },
  };
  const lower = symbol.toLowerCase();

  // Da quando mancano trade: dall'apertura dell'ultima kline ricevuta (la kline aperta del REST resta
  // indietro di qualche secondo rispetto ai trade), o da sempre se il bootstrap fallisce.
  let lostFrom = -Infinity;
  // Lo storico si carica una sola volta, prima dei flussi live: un errore di rete all'avvio
  // lascerebbe la sessione senza storico fino al riavvio, quindi si riprova qualche volta.
  const bootstrap = async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const requestedAt = Date.now();
      try {
        const klines = await fetchKlines(symbol);
        orderflow.bootstrap(klines);
        lostFrom = Math.min(requestedAt, Number(klines.at(-1)?.[0] ?? requestedAt));
        status.bootstrapped = true;
        status.error = null;
        return;
      } catch (err) {
        status.error = String(err.message ?? err);
        log(`[binance] bootstrap ${symbol} fallito (tentativo ${attempt}/4): ${status.error}`);
        if (attempt < 4) await sleep(2000 * attempt);
      }
    }
  };

  // I diff restano in coda finche' manca lo snapshot, che si chiede solo con almeno un
  // evento in coda: chiesto prima puo' risultare piu' vecchio del primo diff.
  let buffer = [];
  let syncing = false;
  let failures = 0;
  let gaps = 0;
  let retryAt = 0;
  let syncedAt = 0;
  let generation = 0;
  let refreshing = false;

  const scheduleRetry = () => { retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** (failures - 1)); };

  const resync = (reason, pending) => {
    status.book.resyncs += 1;
    // Salti ravvicinati: attesa crescente anche se ogni snapshot riesce.
    gaps = Date.now() - syncedAt > 60_000 ? 1 : gaps + 1;
    failures = gaps;
    scheduleRetry();
    buffer = pending;
    log(`[binance] ${symbol} book da risincronizzare: ${reason}`);
  };

  const sync = async () => {
    syncing = true;
    try {
      // Attesa residua, non intera: una riconnessione durante il backoff non la raddoppia.
      if (retryAt > Date.now()) await sleep(retryAt - Date.now());
      const gen = generation;
      if (buffer.length === 0) return;
      const snap = await fetchDepth(symbol);
      status.book.snapshots += 1;
      if (gen !== generation || buffer.length === 0) return;
      if (snap.lastUpdateId < buffer[0].U) { failures += 1; scheduleRetry(); return; }
      orderflow.onBookSnapshot(snap);
      const queued = buffer;
      buffer = [];
      for (let i = 0; i < queued.length; i++) {
        if (orderflow.onBookDiff(queued[i]) === 'resync') { resync('primo diff non contiguo allo snapshot', queued.slice(i)); return; }
      }
      failures = 0;
      retryAt = 0;
      syncedAt = Date.now();
      status.book.error = null;
      log(`[binance] ${symbol} book sincronizzato (update id ${snap.lastUpdateId})`);
    } catch (err) {
      failures += 1;
      scheduleRetry();
      status.book.error = String(err.message ?? err);
      log(`[binance] snapshot ${symbol} fallito: ${status.book.error}`);
    } finally {
      syncing = false;
    }
  };

  const onDepth = (d) => {
    if (d.e !== 'depthUpdate') return;
    if (book.synced) {
      const expected = book.lastUpdateId;
      if (orderflow.onBookDiff(d) !== 'resync') return;
      resync(`salto di sequenza (pu ${d.pu}, atteso ${expected})`, [d]);
    } else {
      buffer.push(d);
      if (buffer.length > MAX_BUFFER) buffer.shift();
    }
    if (!syncing) sync();
  };

  // Connessione nuova o persa: la sequenza dei diff e' interrotta, si riparte da zero.
  const resetBook = () => {
    generation += 1;
    buffer = [];
    orderflow.resetBook();
  };

  // Rinfresco periodico della finestra esatta, senza interrompere il flusso dei diff.
  // Durante un blocco REST si salta il giro, invece di accodare richieste che partirebbero insieme.
  setInterval(async () => {
    if (!book.synced || book.staged || syncing || refreshing || Date.now() < restBlockedUntil) return;
    refreshing = true;
    try {
      const snap = await fetchDepth(symbol);
      status.book.snapshots += 1;
      orderflow.onBookRefresh(snap);
    } catch (err) {
      status.book.error = String(err.message ?? err);
    } finally {
      refreshing = false;
    }
  }, BOOK_REFRESH_MS);

  bootstrap().finally(() => {
    // Alla chiusura il buco parte dall'ultimo messaggio ricevuto (un socket muto puo' aver perso trade);
    // tentativi falliti non lo spostano in avanti. Alla connessione si registra.
    openStream(`${symbol} trade`, `${MARKET_STREAM}?streams=${lower}@aggTrade`, (d) => {
      if (d.e === 'aggTrade') orderflow.onTrade(Number(d.p), Number(d.q), d.m, d.T);
    }, status.trades, log, () => {
      if (!status.trades.connected) { lostFrom ??= status.trades.lastMessageTs || Date.now(); return; }
      orderflow.addGap(lostFrom, Date.now());
      lostFrom = null;
    });
    openStream(`${symbol} book`, `${PUBLIC_STREAM}?streams=${lower}@depth@100ms`, onDepth, status.book, log, resetBook);
  });
  return status;
}
