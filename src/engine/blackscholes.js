// Black-Scholes con tasso zero: per GEX su crypto e GLD l'effetto del tasso e' trascurabile.
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

export function normPdf(x) {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

// Abramowitz-Stegun 26.2.17, errore < 7.5e-8.
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = normPdf(x) * poly;
  return x >= 0 ? 1 - tail : tail;
}

function d1(spot, strike, iv, years) {
  return (Math.log(spot / strike) + 0.5 * iv * iv * years) / (iv * Math.sqrt(years));
}

export function bsGamma(spot, strike, iv, years) {
  if (!(spot > 0 && strike > 0 && iv > 0 && years > 0)) return 0;
  return normPdf(d1(spot, strike, iv, years)) / (spot * iv * Math.sqrt(years));
}

export function bsDelta(spot, strike, iv, years, type) {
  if (!(spot > 0 && strike > 0 && iv > 0 && years > 0)) return type === 'C' ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0);
  const n = normCdf(d1(spot, strike, iv, years));
  return type === 'C' ? n : n - 1;
}
