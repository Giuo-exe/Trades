// Sincronizza l'indicatore "Meteo Livelli" del grafico attivo di TradingView Desktop
// con i livelli della dashboard. Usa la libreria core di tradingview-mcp (CDP su
// 127.0.0.1:9222): TradingView va avviato con --remote-debugging-port=9222.
// Gira sul PC accanto a TradingView; la dashboard puo' stare altrove (es. sul Pi).
// Lo script si crea una volta con "npm run tv-setup"; qui si cambiano solo gli input.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCRIPT_NAME, loadCore, assetForSymbol, readChart, readSavedScripts, pickScript, findStudy, addToChart, chartKey, pageError, writeSyncInputs } from './tvIndicator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const tv = config.tradingview;
const dashboard = process.env.DASHBOARD_URL ?? tv.dashboardUrl;
const studyName = tv.studyName ?? SCRIPT_NAME;
// Di norma tv-sync non aggiunge indicatori: lo fa tv-setup una volta. Con true lo aggiunge ai grafici che ne sono privi.
const autoAdd = tv.autoAddIndicator ?? false;
const log = (msg) => console.log(`${new Date().toISOString()} [tv-sync] ${msg}`);

const core = await loadCore(tv.mcpPath);

const WEATHER = { sereno: '☀️ Sereno', variabile: '⛅ Variabile', temporale: '⛈️ Temporale' };

// Modello e bias dal regime della dashboard (GET /api/snapshot). Se la richiesta fallisce si torna
// al formato breve: i livelli vanno scritti lo stesso.
async function readRegime(asset) {
  try {
    const res = await fetch(`${dashboard}/api/snapshot`);
    if (!res.ok) return null;
    const list = await res.json();
    return (Array.isArray(list) ? list : []).find((a) => a?.asset === asset)?.regime ?? null;
  } catch {
    return null;
  }
}

// in_1: "⛅ Variabile · BTC · attesa · neutro" (senza regime: "⛅ Variabile · BTC"). Il Pine lo legge in qualunque ordine.
function weatherLine(asset, weather, regime) {
  const parts = [WEATHER[weather] ?? weather, asset];
  const clean = (v) => (typeof v === 'string' ? v.replaceAll('·', ' ').trim() : '');
  if (clean(regime?.model) && clean(regime?.bias)) parts.push(clean(regime.model), clean(regime.bias));
  return parts.join(' · ');
}

let lastKey = null;
let lastWarning = null;
const addTried = new Map(); // layout#grafico -> esito dell'unico tentativo di aggiunta
let setupHinted = false;
let nextScriptCheck = 0;

function warnOnce(msg) {
  if (msg !== lastWarning) log(msg);
  lastWarning = msg;
}

// Solo con autoAddIndicator: aggiunge lo script salvato al grafico attivo al massimo una volta per grafico
// del layout e per avvio; se poi l'utente lo toglie, non viene riaggiunto fino al riavvio di tv-sync.
async function addStudy(state) {
  const key = chartKey(state);
  if (!autoAdd) return { warning: `"${studyName}" non e' sul grafico ${state.symbol}: aggiungilo con npm run tv-setup -- --apply o da Indicatori -> I miei script` };
  if (addTried.get(key) === 'ok') return { warning: `"${studyName}" tolto dal grafico ${state.symbol}: lo riaggiungo solo al prossimo avvio di tv-sync` };
  if (addTried.has(key)) return { warning: `"${studyName}" non aggiunto al grafico ${state.symbol}: aggiungilo a mano da Indicatori -> I miei script` };
  // Niente tentativo registrato: si riprova quando si libera un posto.
  if (state.canCreateStudy === false) return { warning: `limite indicatori del piano raggiunto sul grafico ${state.symbol}: "${studyName}" non aggiunto` };
  if (Date.now() < nextScriptCheck) return {};
  let list;
  try {
    list = await readSavedScripts(core);
  } catch (err) {
    nextScriptCheck = Date.now() + 60_000;
    return { warning: `elenco script TradingView non leggibile: ${pageError(err)}` };
  }
  const { script, matches } = pickScript(list, studyName);
  if (!script) {
    nextScriptCheck = Date.now() + 60_000;
    if (!setupHinted) log(matches.length ? `${matches.length} script "${studyName}" nell'account TradingView: esegui npm run tv-setup` : `script "${studyName}" non trovato nell'account TradingView: esegui npm run tv-setup`);
    setupHinted = true;
    return {};
  }
  addTried.set(key, 'tentato');
  const res = await addToChart(core, script, { name: studyName }).catch((err) => ({ study: null, problems: [pageError(err)] }));
  if (res.problems.length) log(`aggiunta di "${studyName}" al grafico ${state.symbol}: ${res.problems.join('; ')}`);
  if (!res.study) return {};
  addTried.set(key, 'ok');
  if (!res.existed) log(`aggiunto "${studyName}" (${script.scriptIdPart} v${script.version}) al grafico ${state.symbol}`);
  return { study: res.study };
}

async function syncOnce() {
  const state = await readChart(core);
  const asset = assetForSymbol(state.symbol, tv.symbolAliases);
  if (!asset) return warnOnce(`simbolo ${state.symbol} non gestito dalla dashboard`);
  let study = findStudy(state.studies, studyName);
  if (!study) {
    const added = await addStudy(state);
    if (!added.study) return added.warning && warnOnce(added.warning);
    study = added.study;
  }

  const [res, regime] = await Promise.all([fetch(`${dashboard}/api/levels/${asset}`), readRegime(asset)]);
  if (!res.ok) return warnOnce(`dashboard non raggiungibile (${res.status})`);
  const levels = await res.json();
  // Il meteo resta quello di /api/levels (stesso istante dei livelli); dal regime solo modello e bias.
  const weather = weatherLine(asset, levels.weather, regime);
  // Uno studio in errore non va toccato: ogni scrittura lo farebbe solo ricalcolare a vuoto.
  if (study.error) return warnOnce(`"${studyName}" e' in errore sul grafico ${state.symbol} (${study.error}): toglilo e rimettilo da Indicatori -> I miei script`);
  const key = `${study.id}|${levels.pine}|${weather}`;
  if (key === lastKey) return;

  // in_0 = "Livelli dalla dashboard", in_1 = "Meteo (opzionale)": ordine degli input nel Pine.
  const updated = await writeSyncInputs(core, study.id, { in_0: levels.pine, in_1: weather });
  if (!updated.includes('in_0')) return warnOnce('input dell\'indicatore non trovati: e\' la versione di meteo-livelli.pine della dashboard?');
  lastKey = key;
  lastWarning = null;
  log(`${state.symbol} -> ${asset}: ${levels.levels.length} livelli, ${weather}`);
}

async function loop() {
  try {
    await syncOnce();
  } catch (err) {
    lastKey = null;
    warnOnce(`TradingView non raggiungibile: ${pageError(err)}. Avvialo con scripts\\avvia-tradingview.ps1`);
    await core.connection.disconnect().catch(() => {});
  }
  setTimeout(loop, tv.syncMs);
}

log(`dashboard ${dashboard}, aggiornamento ogni ${tv.syncMs / 1000}s${autoAdd ? `, aggiunge "${studyName}" al grafico se manca` : ''}`);
loop();
