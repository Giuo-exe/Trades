import { computeGex } from './engine/gex.js';
import { fetchDeribit, fetchCboe } from './collectors/options.js';

const RECOMPUTE_MS = 30_000;
const RECOMPUTE_MOVE = 0.001;

// Mantiene l'ultima catena per asset e ricalcola il GEX al prezzo corrente,
// con cache: la ricerca del flip ricalcola la gamma di ogni opzione su 120 prezzi.
export class GexService {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.chains = new Map();
    this.cache = new Map();
    this.external = new Map();
  }

  start() {
    for (const [asset, cfg] of Object.entries(this.config.assets)) {
      const pollMs = cfg.gex.source === 'cboe' ? this.config.gex.cboePollMs : this.config.gex.deribitPollMs;
      const poll = async () => {
        const state = this.chains.get(asset) ?? { error: null };
        try {
          const fetcher = cfg.gex.source === 'cboe' ? fetchCboe : fetchDeribit;
          const chain = await fetcher(cfg.gex, this.config.gex.maxExpiryDays);
          this.chains.set(asset, { ...chain, updatedAt: Date.now(), error: null, anchorPrice: null });
          this.cache.delete(asset);
        } catch (err) {
          this.chains.set(asset, { ...state, error: String(err.message ?? err) });
          this.log(`[gex] ${asset}: ${err.message ?? err}`);
        }
      };
      poll();
      setInterval(poll, pollMs);
    }
  }

  // `price` e' il prezzo del perpetual Binance. Per l'oro la catena e' su GLD:
  // il GEX si calcola in spazio GLD e i livelli vengono riportati al prezzo XAU
  // con il rapporto XAU/GLD fissato al momento dello scaricamento.
  get(asset, price) {
    const chain = this.chains.get(asset);
    if (!chain || !chain.options || price == null) return chain?.error ? { error: chain.error } : null;
    const cfg = this.config.assets[asset];
    const proxied = cfg.gex.source === 'cboe';
    if (proxied && chain.anchorPrice == null && chain.sourceSpot) chain.anchorPrice = price;
    const ratio = proxied && chain.sourceSpot ? chain.anchorPrice / chain.sourceSpot : 1;
    const cached = this.cache.get(asset);
    if (cached && Date.now() - cached.at < RECOMPUTE_MS && Math.abs(price - cached.price) / cached.price < RECOMPUTE_MOVE) return cached.value;

    const g = computeGex(chain.options, price / ratio, this.config.gex);
    const scale = (v) => (v == null ? null : v * ratio);
    const value = {
      total: g.total,
      dex: g.dex,
      flip: scale(g.flip),
      callWall: scale(g.callWall),
      putWall: scale(g.putWall),
      putCallOi: g.putCallOi,
      byStrike: g.byStrike.map((r) => ({ ...r, strike: r.strike * ratio })),
      optionCount: g.optionCount,
      updatedAt: chain.updatedAt,
      delayed: chain.delayed,
      proxy: proxied ? `${cfg.gex.symbol} × ${ratio.toFixed(3)}` : null,
      error: chain.error,
    };
    this.cache.set(asset, { at: Date.now(), price, value });
    return value;
  }

  // GEX fornito da Hermes (o da altre fonti): mostrato accanto a quello calcolato.
  ingest(asset, payload) {
    this.external.set(asset, { ...payload, receivedAt: Date.now() });
  }

  getExternal(asset) {
    return this.external.get(asset) ?? null;
  }
}
