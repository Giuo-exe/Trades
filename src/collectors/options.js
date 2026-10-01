// Catene opzioni normalizzate per il motore GEX.
// Opzione: { strike, type, oi, iv, years, contractSize, gamma?, delta?, expiry }

const YEAR_MS = 365 * 86_400_000;
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// "BTC-9OCT26-81000-P" | "SOL_USDC-25DEC26-104-C" | "XRP_USDC-27DEC26-0d6-C"
export function parseDeribitName(name) {
  const m = /^([A-Z]+)(?:_[A-Z]+)?-(\d{1,2})([A-Z]{3})(\d{2})-([\dd]+)-([CP])$/.exec(name);
  if (!m) return null;
  const [, base, day, mon, yy, strikeRaw, type] = m;
  if (!(mon in MONTHS)) return null;
  // Le scadenze Deribit sono alle 08:00 UTC.
  const expiry = Date.UTC(2000 + Number(yy), MONTHS[mon], Number(day), 8);
  return { base, expiry, strike: Number(strikeRaw.replace('d', '.')), type };
}

// "GLD261001C00361000" -> scadenza 2026-10-01, call, strike 361
export function parseOccSymbol(symbol) {
  const m = /^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol);
  if (!m) return null;
  const [, root, yy, mm, dd, type, strike] = m;
  // Chiusura del mercato USA (16:00 ET), approssimata alle 20:00 UTC.
  const expiry = Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), 20);
  return { root, expiry, strike: Number(strike) / 1000, type };
}

function withinHorizon(expiry, now, maxDays) {
  const years = (expiry - now) / YEAR_MS;
  return years > 0 && years <= maxDays / 365 ? years : null;
}

// Per le opzioni Deribit l'open interest e' gia' espresso in unita' del sottostante
// (BTC, ETH, SOL...), quindi il moltiplicatore e' 1.
export async function fetchDeribit({ currencies, base }, maxExpiryDays, now = Date.now()) {
  const options = [];
  let underlying = null;
  for (const currency of currencies) {
    const res = await fetch(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`);
    if (!res.ok) throw new Error(`Deribit ${currency}: HTTP ${res.status}`);
    const body = await res.json();
    for (const row of body.result ?? []) {
      if (row.base_currency !== base || !(row.open_interest > 0)) continue;
      const parsed = parseDeribitName(row.instrument_name);
      if (!parsed) continue;
      const years = withinHorizon(parsed.expiry, now, maxExpiryDays);
      if (years === null) continue;
      underlying ??= row.underlying_price;
      options.push({ strike: parsed.strike, type: parsed.type, oi: row.open_interest, iv: (row.mark_iv ?? 0) / 100, years, contractSize: 1, expiry: parsed.expiry });
    }
  }
  return { options, sourceSpot: underlying, delayed: false };
}

// Quotazioni CBOE ritardate di ~15 minuti, con greche gia' calcolate.
export async function fetchCboe({ symbol, multiplier }, maxExpiryDays, now = Date.now()) {
  const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`, { headers: { 'User-Agent': 'Mozilla/5.0 market-weather' } });
  if (!res.ok) throw new Error(`CBOE ${symbol}: HTTP ${res.status}`);
  const body = await res.json();
  const options = [];
  for (const row of body.data?.options ?? []) {
    if (!(row.open_interest > 0)) continue;
    const parsed = parseOccSymbol(row.option);
    if (!parsed) continue;
    const years = withinHorizon(parsed.expiry, now, maxExpiryDays);
    if (years === null) continue;
    options.push({ strike: parsed.strike, type: parsed.type, oi: row.open_interest, iv: row.iv ?? 0, gamma: row.gamma ?? 0, delta: row.delta ?? 0, years, contractSize: multiplier, expiry: parsed.expiry });
  }
  return { options, sourceSpot: body.data?.current_price ?? null, delayed: true };
}
