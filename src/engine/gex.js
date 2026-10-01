import { bsGamma, bsDelta } from './blackscholes.js';

// Opzione normalizzata: { strike, type: 'C'|'P', oi, iv (decimale), years, contractSize, gamma?, delta? }
// GEX in dollari per una variazione dell'1% del sottostante:
//   gamma * OI * contractSize * spot^2 * 0.01 * segno
// Segno di default (convenzione "dealer"): call +, put -. Configurabile da config.json.

function optionGamma(o, spot) {
  return o.iv > 0 ? bsGamma(spot, o.strike, o.iv, o.years) : (o.gamma ?? 0);
}

function optionGex(o, spot, signs) {
  const sign = o.type === 'C' ? signs.callSign : signs.putSign;
  return optionGamma(o, spot) * o.oi * o.contractSize * spot * spot * 0.01 * sign;
}

export function totalGexAt(options, spot, signs) {
  let total = 0;
  for (const o of options) if (o.iv > 0) total += optionGex(o, spot, signs);
  return total;
}

// Zero gamma: livello di prezzo in cui il GEX totale ricalcolato cambia segno.
// Restituisce l'attraversamento piu' vicino allo spot, interpolato linearmente.
export function findGammaFlip(options, spot, signs, rangePct = 0.15, steps = 120) {
  const lo = spot * (1 - rangePct);
  const hi = spot * (1 + rangePct);
  let best = null;
  let prevS = lo;
  let prevG = totalGexAt(options, lo, signs);
  for (let i = 1; i <= steps; i++) {
    const s = lo + ((hi - lo) * i) / steps;
    const g = totalGexAt(options, s, signs);
    if (prevG === 0 || Math.sign(g) !== Math.sign(prevG)) {
      const cross = prevG === g ? s : prevS + ((0 - prevG) * (s - prevS)) / (g - prevG);
      if (best === null || Math.abs(cross - spot) < Math.abs(best - spot)) best = cross;
    }
    prevS = s;
    prevG = g;
  }
  return best;
}

export function computeGex(options, spot, settings) {
  const signs = { callSign: settings.callSign ?? 1, putSign: settings.putSign ?? -1 };
  const byStrike = new Map();
  let total = 0;
  let dex = 0;
  let callOi = 0;
  let putOi = 0;
  for (const o of options) {
    const g = optionGex(o, spot, signs);
    const row = byStrike.get(o.strike) ?? { strike: o.strike, call: 0, put: 0, net: 0 };
    if (o.type === 'C') { row.call += g; callOi += o.oi * o.contractSize; } else { row.put += g; putOi += o.oi * o.contractSize; }
    row.net += g;
    byStrike.set(o.strike, row);
    total += g;
    const delta = o.iv > 0 ? bsDelta(spot, o.strike, o.iv, o.years, o.type) : (o.delta ?? 0);
    dex += delta * o.oi * o.contractSize * spot;
  }
  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  let callWall = null;
  let putWall = null;
  for (const r of strikes) {
    if (r.call !== 0 && (callWall === null || Math.abs(r.call) > Math.abs(callWall.call))) callWall = r;
    if (r.put !== 0 && (putWall === null || Math.abs(r.put) > Math.abs(putWall.put))) putWall = r;
  }
  return {
    spot,
    total,
    dex,
    flip: findGammaFlip(options, spot, signs, settings.flipRangePct ?? 0.15),
    callWall: callWall?.strike ?? null,
    putWall: putWall?.strike ?? null,
    putCallOi: callOi > 0 ? putOi / callOi : null,
    byStrike: strikes,
    optionCount: options.length,
  };
}
