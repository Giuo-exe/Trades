// Book L2 locale di un perpetual Binance USDⓈ-M: snapshot REST + diff @depth.
// Regole di sincronizzazione Binance futures:
// - scarta gli eventi con u < lastUpdateId dello snapshot;
// - il primo evento applicato deve avere U <= lastUpdateId <= u;
// - ogni evento successivo deve avere pu uguale all'u del precedente.
// Il book e' esatto solo nella finestra di prezzo coperta dallo snapshot (exactLow..exactHigh):
// fuori contiene soltanto i livelli toccati dai diff.

const PRUNE_EVERY = 200;
const RECENT_DIFFS = 50; // ~5 s di diff a 100 ms

export class LocalOrderBook {
  constructor({ pruneFraction = 0.03, snapshotLimit = 1000 } = {}) {
    this.pruneFraction = pruneFraction;
    this.snapshotLimit = snapshotLimit;
    this.refreshes = 0;
    this.refreshFailures = 0;
    this.reset();
  }

  reset() {
    this.bids = new Map();
    this.asks = new Map();
    this.bestCache = { bid: undefined, ask: undefined };
    this.synced = false;
    this.snapshotId = null;
    this.lastUpdateId = null;
    this.prevU = null;
    this.exactLow = null;
    this.exactHigh = null;
    this.staged = null;
    this.recent = [];
    this.sincePrune = 0;
  }

  get size() {
    return this.bids.size + this.asks.size;
  }

  set(side, price, qty) {
    const map = side === 'bid' ? this.bids : this.asks;
    const best = this.bestCache[side];
    if (qty > 0) {
      map.set(price, qty);
      const better = best === null || (best !== undefined && (side === 'bid' ? price > best : price < best));
      if (better) this.bestCache[side] = price;
    } else if (map.delete(price) && price === best) {
      this.bestCache[side] = undefined;
    }
  }

  applySnapshot({ lastUpdateId, bids, asks }) {
    this.reset();
    for (const [p, q] of bids) this.set('bid', Number(p), Number(q));
    for (const [p, q] of asks) this.set('ask', Number(p), Number(q));
    // Con meno livelli del limite lo snapshot contiene l'intero lato.
    let low = Infinity;
    let high = -Infinity;
    for (const p of this.bids.keys()) low = Math.min(low, p);
    for (const p of this.asks.keys()) high = Math.max(high, p);
    this.exactLow = bids.length < this.snapshotLimit ? 0 : low;
    this.exactHigh = asks.length < this.snapshotLimit ? Infinity : high;
    this.snapshotId = lastUpdateId;
    this.lastUpdateId = lastUpdateId;
    this.synced = true;
  }

  // 'applied' | 'stale' | 'resync'. Con 'resync' il book viene svuotato: serve un nuovo snapshot.
  applyDiff(ev) {
    if (!this.synced) return 'resync';
    if (this.prevU === null) {
      if (ev.u < this.snapshotId) return 'stale';
      if (ev.U > this.snapshotId) { this.reset(); return 'resync'; }
    } else if (ev.pu !== this.prevU) {
      this.reset();
      return 'resync';
    }
    for (const [p, q] of ev.b) this.set('bid', Number(p), Number(q));
    for (const [p, q] of ev.a) this.set('ask', Number(p), Number(q));
    this.prevU = ev.u;
    this.lastUpdateId = ev.u;
    this.recent.push(ev);
    if (this.recent.length > RECENT_DIFFS) this.recent.shift();
    if (this.staged) this.advanceStaged(ev);
    if (++this.sincePrune >= PRUNE_EVERY) this.prune();
    return 'applied';
  }

  // Rinfresco senza buttare il book: un secondo book parte dal nuovo snapshot, riceve gli
  // stessi diff e, appena allineato allo stesso update id, sostituisce la finestra esatta.
  // Uno snapshot uguale o di poco piu' vecchio del book si allinea con i diff recenti gia' applicati.
  stageRefresh(snapshot) {
    if (!this.synced || this.prevU === null) return false;
    const next = new LocalOrderBook({ pruneFraction: this.pruneFraction, snapshotLimit: this.snapshotLimit });
    next.applySnapshot(snapshot);
    for (const ev of this.recent) {
      if (next.applyDiff(ev) === 'resync') { this.refreshFailures += 1; return false; }
    }
    this.staged = next;
    if (next.lastUpdateId === this.lastUpdateId) this.mergeStaged();
    return true;
  }

  advanceStaged(ev) {
    const result = this.staged.applyDiff(ev);
    if (result === 'stale') return;
    if (result === 'resync') { this.staged = null; this.refreshFailures += 1; return; }
    this.mergeStaged();
  }

  mergeStaged() {
    const next = this.staged;
    this.staged = null;
    // Fuori dalla nuova finestra si conservano i livelli gia' noti.
    for (const p of this.bids.keys()) if (p < next.exactLow && !next.bids.has(p)) next.set('bid', p, this.bids.get(p));
    for (const p of this.asks.keys()) if (p > next.exactHigh && !next.asks.has(p)) next.set('ask', p, this.asks.get(p));
    const overlap = this.exactLow <= next.exactHigh && next.exactLow <= this.exactHigh;
    this.exactLow = overlap ? Math.min(this.exactLow, next.exactLow) : next.exactLow;
    this.exactHigh = overlap ? Math.max(this.exactHigh, next.exactHigh) : next.exactHigh;
    this.bids = next.bids;
    this.asks = next.asks;
    this.bestCache = next.bestCache;
    this.refreshes += 1;
  }

  qtyAt(side, price) {
    return (side === 'bid' ? this.bids : this.asks).get(price) ?? 0;
  }

  best(side) {
    if (this.bestCache[side] === undefined) {
      let best = null;
      for (const p of (side === 'bid' ? this.bids : this.asks).keys()) {
        if (best === null || (side === 'bid' ? p > best : p < best)) best = p;
      }
      this.bestCache[side] = best;
    }
    return this.bestCache[side];
  }

  bestBid() { return this.best('bid'); }
  bestAsk() { return this.best('ask'); }

  mid() {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid == null || ask == null ? null : (bid + ask) / 2;
  }

  // Liquidita' esposta entro ±bandFraction dal mid; covered = banda interamente nella finestra esatta.
  bandDepth(bandFraction) {
    const mid = this.mid();
    if (mid == null) return null;
    const lo = mid * (1 - bandFraction);
    const hi = mid * (1 + bandFraction);
    let bidQty = 0, askQty = 0, bidUsd = 0, askUsd = 0;
    for (const [p, q] of this.bids) if (p >= lo) { bidQty += q; bidUsd += p * q; }
    for (const [p, q] of this.asks) if (p <= hi) { askQty += q; askUsd += p * q; }
    const total = bidUsd + askUsd;
    return {
      mid, bidQty, askQty, bidUsd, askUsd,
      bidShare: total > 0 ? bidUsd / total : null,
      covered: this.exactLow != null && lo >= this.exactLow && hi <= this.exactHigh,
    };
  }

  // Nozionale per fascia di prezzo: bids[i] = [mid - (i+1)·step, mid - i·step), asks[i] speculare sopra.
  depthProfile(bandFraction = 0.01, buckets = 40) {
    const mid = this.mid();
    if (mid == null) return null;
    const half = Math.max(1, Math.round(buckets / 2));
    const step = (mid * bandFraction) / half;
    const bids = new Array(half).fill(0);
    const asks = new Array(half).fill(0);
    for (const [p, q] of this.bids) { const i = Math.floor((mid - p) / step); if (i >= 0 && i < half) bids[i] += p * q; }
    for (const [p, q] of this.asks) { const i = Math.floor((p - mid) / step); if (i >= 0 && i < half) asks[i] += p * q; }
    const finite = (v) => (Number.isFinite(v) ? v : null);
    return {
      mid, step, bandPct: bandFraction * 100,
      bids: bids.map(Math.round), asks: asks.map(Math.round),
      exactLow: finite(this.exactLow), exactHigh: finite(this.exactHigh),
    };
  }

  // Elimina i livelli oltre ±pruneFraction dal mid; la finestra esatta si restringe di conseguenza.
  prune() {
    this.sincePrune = 0;
    const mid = this.mid();
    if (mid == null || !this.pruneFraction) return 0;
    const lo = mid * (1 - this.pruneFraction);
    const hi = mid * (1 + this.pruneFraction);
    let removed = 0;
    for (const p of this.bids.keys()) if (p < lo) { this.bids.delete(p); removed += 1; }
    for (const p of this.asks.keys()) if (p > hi) { this.asks.delete(p); removed += 1; }
    if (this.exactLow != null) {
      this.exactLow = Math.max(this.exactLow, lo);
      this.exactHigh = Math.min(this.exactHigh, hi);
    }
    return removed;
  }
}
