import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { OrderFlow } from './engine/orderflow.js';
import { assessRegime } from './engine/regime.js';
import { startBinance, fetchKlines } from './collectors/binance.js';
import { BarSeries, TIMEFRAMES, isTimeframe } from './bars.js';
import { GexService } from './gexService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const host = process.env.HOST ?? config.server.host;
const port = Number(process.env.PORT ?? config.server.port);
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const assets = {};
for (const [asset, cfg] of Object.entries(config.assets)) {
  const of = new OrderFlow({ symbol: cfg.binanceSymbol, profileTick: cfg.profileTick, bigTradeUsd: cfg.bigTradeUsd, icebergMinUsd: cfg.icebergMinUsd, settings: config.orderflow });
  assets[asset] = { cfg, of, status: startBinance(cfg.binanceSymbol, of, log) };
}
const gex = new GexService(config, log);
gex.start();
// Storico per il grafico: durante un blocco REST si risponde subito con la cache o le sole barre 1m.
const charts = new BarSeries({ fetchKlines: (symbol, interval, limit) => fetchKlines(symbol, interval, limit, { wait: false }) });

function buildAsset(asset, detail) {
  const { cfg, of, status } = assets[asset];
  const snap = of.snapshot({ barLimit: 120, depth: detail });
  const g = gex.get(asset, snap.price);
  const gexOk = g && !g.error && Number.isFinite(g.total) ? g : null;
  const regime = assessRegime(snap, gexOk);
  const out = {
    asset,
    label: cfg.label,
    symbol: cfg.binanceSymbol,
    price: snap.price,
    stale: Date.now() - snap.lastTradeTs > 30_000,
    regime,
    gex: g ? { ...g, byStrike: undefined } : null,
    external: gex.getExternal(asset),
    session: snap.session,
    cvdTrend: snap.cvdTrend,
    profile: { ...snap.profile, rows: detail ? snap.profile.rows : undefined },
    zones: snap.zones.slice(0, detail ? 20 : 6),
    bigTrades: snap.bigTrades.slice(0, detail ? 20 : 5),
    bookPressure: snap.bookPressure,
    cvdSpark: detail ? undefined : snap.bars.map((b) => b.cvd), // solo per le card
    feed: { connected: status.connected, reconnects: status.reconnects, error: status.error, bookSynced: status.book.synced },
  };
  if (detail) {
    out.depth = snap.depth;
    const lo = snap.price * 0.88;
    const hi = snap.price * 1.12;
    out.gexByStrike = (g?.byStrike ?? []).filter((r) => r.strike >= lo && r.strike <= hi);
  }
  return out;
}

const PINE_CODES = { VAH: 'VAH', VAL: 'VAL', POC: 'POC', LVN: 'LVN', 'Gamma flip': 'FLIP', 'Call wall': 'CW', 'Put wall': 'PW', Iceberg: 'ICE', Assorbimento: 'ABS' };

// I livelli gamma (flip ricalcolato, walls dell'oro riscalate da GLD) cambiano di frazioni a ogni ricalcolo:
// arrotondati a ~0,01% del prezzo, tv-sync riscrive l'indicatore solo quando si spostano davvero.
function gammaStep(price) {
  return 10 ** Math.round(Math.log10(price * 0.0001));
}

function buildLevels(asset) {
  const a = buildAsset(asset, false);
  const levels = a.regime.levels;
  const step = a.price > 0 ? gammaStep(a.price) : null;
  const value = (l) => (step && l.kind === 'gamma' ? Math.round(l.price / step) * step : l.price);
  const pine = levels.map((l) => `${PINE_CODES[l.name] ?? l.name}:${+value(l).toFixed(4)}`).join(';');
  return { asset, symbol: a.symbol, price: a.price, weather: a.regime.weather, levels, pine };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api') {
      const asset = parts[2]?.toUpperCase();
      if (req.method === 'GET' && parts[1] === 'snapshot' && !asset) return sendJson(res, 200, Object.keys(assets).map((a) => buildAsset(a, false)));
      if (asset && !assets[asset]) return sendJson(res, 404, { error: `asset sconosciuto: ${parts[2]}` });
      if (req.method === 'GET' && parts[1] === 'snapshot') {
        const tf = url.searchParams.get('tf') ?? '1m';
        if (!isTimeframe(tf)) return sendJson(res, 400, { error: `timeframe non valido: "${tf.slice(0, 16)}". Valori ammessi: ${Object.keys(TIMEFRAMES).join(', ')}` });
        const { cfg, of } = assets[asset];
        const chart = await charts.get(cfg.binanceSymbol, tf, of.bars, of.gaps);
        // Con since e rev ancora validi bastano le candele da since in poi: quelle prima non sono cambiate.
        const since = Number(url.searchParams.get('since'));
        chart.full = !(since > 0 && url.searchParams.get('rev') === chart.rev);
        if (!chart.full) chart.bars = chart.bars.filter((b) => b.t >= since);
        return sendJson(res, 200, { ...buildAsset(asset, true), ...chart });
      }
      if (req.method === 'GET' && parts[1] === 'levels') return sendJson(res, 200, buildLevels(asset));
      if (req.method === 'POST' && parts[1] === 'ingest' && parts[2]?.toLowerCase() === 'gex') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) break; }
        const payload = JSON.parse(body);
        const target = String(payload.asset ?? '').toUpperCase();
        if (!assets[target]) return sendJson(res, 400, { error: 'campo "asset" mancante o sconosciuto' });
        gex.ingest(target, payload);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && parts[1] === 'status') {
        return sendJson(res, 200, Object.fromEntries(Object.entries(assets).map(([a, v]) => [a, v.status])));
      }
      return sendJson(res, 404, { error: 'endpoint sconosciuto' });
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(root, 'public', rel);
    if (!file.startsWith(path.join(root, 'public'))) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    // no-cache: il browser rivalida a ogni caricamento, cosi' un aggiornamento dell'interfaccia arriva subito.
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404); return res.end('not found'); }
    if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'JSON non valido' });
    log(`[http] ${err.stack ?? err}`);
    sendJson(res, 500, { error: 'errore interno' });
  }
});

const wss = new WebSocketServer({ server, path: '/stream' });
setInterval(() => {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify({ type: 'summary', ts: Date.now(), assets: Object.keys(assets).map((a) => buildAsset(a, false)) });
  for (const client of wss.clients) if (client.readyState === 1) client.send(payload);
}, config.broadcastMs);

server.listen(port, host, () => log(`Meteo del Mercato su http://${host}:${port}`));
