// "Meteo" del mercato: regole deterministiche e trasparenti su gamma + orderflow.
// E' una lettura di contesto, non un segnale operativo.

const NEAR_FLIP_PCT = 0.005;
const LOCATION_PCT = 0.0015;
const CONFIRM_MS = 5 * 60_000;
const BOOK_SKEW = 0.65;

function pct(a, b) {
  return Math.abs(a - b) / b;
}

export function keyLevels(of, gex) {
  const levels = [];
  const add = (name, price, kind) => { if (Number.isFinite(price)) levels.push({ name, price, kind }); };
  add('VAH', of.profile.vah, 'profilo');
  add('VAL', of.profile.val, 'profilo');
  add('POC', of.profile.poc, 'profilo');
  for (const p of of.profile.lvns) add('LVN', p, 'profilo');
  for (const z of of.zones.filter((z) => z.status === 'attiva')) add(z.kind === 'iceberg' ? 'Iceberg' : 'Assorbimento', z.price, z.side);
  if (gex) {
    add('Gamma flip', gex.flip, 'gamma');
    add('Call wall', gex.callWall, 'gamma');
    add('Put wall', gex.putWall, 'gamma');
  }
  return levels;
}

export function assessRegime(of, gex, now = Date.now()) {
  const price = of.price;
  const reasons = [];
  let storm = 0;
  const gammaKnown = gex && Number.isFinite(gex.total);
  if (gammaKnown) {
    if (gex.total > 0) { storm -= 2; reasons.push('Gamma positivo: i dealer tendono a smorzare i movimenti'); }
    else { storm += 2; reasons.push('Gamma negativo: i dealer tendono ad amplificare i movimenti'); }
  } else {
    reasons.push('Gamma non disponibile');
  }
  const nearFlip = gammaKnown && Number.isFinite(gex.flip) && price != null && pct(price, gex.flip) < NEAR_FLIP_PCT;
  if (nearFlip) reasons.push('Prezzo vicino al gamma flip: regime instabile');

  const loc = of.profile.location;
  if (loc === 'dentro') { storm -= 1; reasons.push('Prezzo dentro la value area: mercato in bilanciamento'); }
  else if (loc) { storm += 1; reasons.push(`Prezzo ${loc} la value area: possibile sbilanciamento`); }

  const cvd = of.cvdTrend;
  const agrees = (loc === 'sopra' && cvd.direction === 'acquisti') || (loc === 'sotto' && cvd.direction === 'vendite');
  if (cvd.direction !== 'neutro') {
    storm += 1;
    reasons.push(`CVD ${cvd.minutes}m dominato da ${cvd.direction}`);
    if (agrees) { storm += 1; reasons.push('Aggressione coerente con la rottura della value area'); }
  } else {
    reasons.push(`CVD ${cvd.minutes}m neutro`);
  }
  if (cvd.divergence) reasons.push('Divergenza: delta e prezzo vanno in direzioni opposte (possibile assorbimento)');

  // Solo informativo: il book esposto non entra nel punteggio. Durante la risincronizzazione
  // il valore e' fermo all'ultimo campione e non va presentato come attuale.
  const book = of.bookPressure;
  if (book?.synced && book.smooth != null && (book.smooth >= BOOK_SKEW || book.smooth <= 1 - BOOK_SKEW)) {
    const side = book.smooth >= BOOK_SKEW ? 'acquisto' : 'vendita';
    const band = book.bandPct.toLocaleString('it-IT');
    reasons.push(`Book ±${band}% sbilanciato in ${side} (${Math.round(book.smooth * 100)}% bid; segnale debole: gli ordini esposti possono sparire)`);
  }

  let weather = 'variabile';
  if (storm >= 3) weather = 'temporale';
  else if (storm <= -2 && !nearFlip) weather = 'sereno';

  let model = 'attesa';
  let bias = 'neutro';
  if (weather === 'temporale') {
    model = 'trend';
    bias = loc === 'sopra' || (loc !== 'sotto' && cvd.direction === 'acquisti') ? 'long' : loc === 'sotto' || cvd.direction === 'vendite' ? 'short' : 'neutro';
  } else if (weather === 'sereno') {
    model = 'mean reversion';
    if (price != null && of.profile.vah != null && pct(price, of.profile.vah) < LOCATION_PCT * 2) bias = 'short';
    else if (price != null && of.profile.val != null && pct(price, of.profile.val) < LOCATION_PCT * 2) bias = 'long';
  }

  // Checklist in tre passi: location -> aggressione -> conferma.
  const levels = keyLevels(of, gex);
  const atLevels = price == null ? [] : levels.filter((l) => pct(price, l.price) < LOCATION_PCT);
  const wantedSide = bias === 'long' ? 'buy' : bias === 'short' ? 'sell' : cvd.direction === 'acquisti' ? 'buy' : cvd.direction === 'vendite' ? 'sell' : null;
  const recentBig = of.bigTrades.filter((t) => now - t.ts < CONFIRM_MS && (!wantedSide || t.side === wantedSide));
  const absorptionHere = atLevels.some((l) => l.name === 'Iceberg' || l.name === 'Assorbimento');
  const checklist = [
    {
      step: 'Location',
      ok: atLevels.length > 0,
      text: atLevels.length > 0 ? `Su livello: ${atLevels.map((l) => l.name).join(', ')}` : 'Prezzo lontano dai livelli chiave',
    },
    {
      step: 'Aggressione',
      ok: cvd.direction !== 'neutro',
      text: cvd.direction !== 'neutro' ? `Aggressori in ${cvd.direction} (${(cvd.ratio * 100).toFixed(1)}% del volume)` : 'Nessuna aggressione dominante',
    },
    {
      step: 'Conferma',
      ok: recentBig.length > 0 || absorptionHere,
      text: absorptionHere ? 'Assorbimento/iceberg sul livello' : recentBig.length > 0 ? `${recentBig.length} big trade negli ultimi 5m` : 'Nessuna conferma da big trade o assorbimento',
    },
  ];

  return { weather, model, bias, score: storm, nearFlip, reasons, checklist, levels };
}
