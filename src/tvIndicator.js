// Helper condivisi da tv-setup e tv-sync per lo script Pine "Meteo Livelli" dell'account TradingView.
// Le scritture passano dalle API interne della pagina (le stesse del Pine Editor e del pulsante
// "Aggiungi al grafico"), senza toccare l'editor: niente testo digitato, niente scorciatoie.
// In cima la logica pura (testata in test/tv.test.js), sotto le funzioni che parlano con TradingView via CDP.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const SCRIPT_NAME = 'Meteo Livelli';
const PINE_URL = 'https://pine-facade.tradingview.com/pine-facade';
const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';

const fold = (s) => String(s ?? '').trim().toLowerCase();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- logica pura

// Dopo l'alias solo una quotazione in dollari (anche perpetuo) o una scadenza future.
const TICKER_SUFFIX = /^(?:(?:USDT|USDC|FDUSD|USD)(?:\.P|PERP)?|PERP|\d+!|[FGHJKMNQUVXZ]\d{2,4})$/;

// "BINANCE:BTCUSDT.P", "COINBASE:BTCUSD", "OANDA:XAUUSD", "COMEX:GC1!" -> asset della dashboard.
// BTC.D, ETHBTC, BTCDOMUSDT, SOLVUSDT, XAUEUR, NYSE:GOLD restano fuori. Un alias con l'exchange
// ("TVC:GOLD") vale solo per quel simbolo esatto.
export function assetForSymbol(symbol, aliases) {
  const full = String(symbol ?? '').toUpperCase();
  const ticker = full.split(':').pop();
  const match = (alias) => {
    const a = String(alias).toUpperCase();
    return a.includes(':') ? full === a : ticker.startsWith(a) && TICKER_SUFFIX.test(ticker.slice(a.length));
  };
  for (const [asset, list] of Object.entries(aliases ?? {})) {
    if (list.some(match)) return asset;
  }
  return null;
}

// Confronto dei sorgenti indipendente da CRLF e spazi finali.
export function normalizeSource(src) {
  return String(src ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
}

// Titolo dichiarato in indicator("..."): e' il nome con cui lo studio compare sul grafico.
export function pineTitle(source) {
  const m = String(source ?? '').match(/^\s*indicator\s*\(\s*(?:title\s*=\s*)?"([^"]*)"/m);
  return m ? m[1] : null;
}

// Script salvati che corrispondono al nome: prima per nome di salvataggio, poi per titolo.
export function matchScripts(list, name) {
  const want = fold(name);
  const byName = list.filter((s) => fold(s.scriptName) === want);
  return byName.length ? byName : list.filter((s) => fold(s.scriptTitle) === want);
}

export function pickScript(list, name) {
  const matches = matchScripts(list, name);
  return { script: matches.length === 1 ? matches[0] : null, matches };
}

// Il server restituisce tutti gli script in ordine alfabetico, senza paginazione. Se un giorno
// l'elenco arrivasse tagliato a un multiplo di 50, un nome che cade dopo l'ultimo potrebbe mancare.
export function listMayHide(list, name) {
  if (!list.length || list.length % 50 !== 0) return false;
  return String(name).localeCompare(list.at(-1).scriptName ?? '', 'en', { sensitivity: 'base' }) >= 0;
}

export function diffScriptLists(before, after) {
  const prev = new Map(before.map((s) => [s.scriptIdPart, s]));
  const next = new Map(after.map((s) => [s.scriptIdPart, s]));
  return {
    added: after.filter((s) => !prev.has(s.scriptIdPart)),
    removed: before.filter((s) => !next.has(s.scriptIdPart)),
    changed: after
      .filter((s) => prev.has(s.scriptIdPart))
      .map((s) => ({ ...s, before: prev.get(s.scriptIdPart) }))
      .filter((s) => s.before.version !== s.version || s.before.scriptName !== s.scriptName),
  };
}

const label = (s) => `"${s.scriptName}" (${s.scriptIdPart}, versione ${s.version})`;

function unexpected(d, allowedId) {
  return [
    ...d.removed.map((s) => `script sparito: ${label(s)}`),
    ...d.changed.filter((s) => s.scriptIdPart !== allowedId).map((s) => `script modificato: ${label(s.before)} ora versione ${s.version}${s.scriptName !== s.before.scriptName ? `, nome "${s.scriptName}"` : ''}`),
  ];
}

// Dopo la creazione: esattamente un nuovo script col nome giusto e nessun altro script toccato.
export function verifyCreate(before, after, name) {
  const d = diffScriptLists(before, after);
  const created = d.added.filter((s) => fold(s.scriptName) === fold(name));
  const problems = [
    ...(created.length === 1 ? [] : [`attesi 1 nuovo script "${name}", trovati ${created.length}`]),
    ...d.added.filter((s) => !created.includes(s)).map((s) => `script inatteso: ${label(s)}`),
    ...unexpected(d, null),
  ];
  return { ok: problems.length === 0, script: created.length === 1 ? created[0] : null, problems };
}

// Dopo l'aggiornamento: cambia solo la versione dello script indicato.
export function verifyUpdate(before, after, id) {
  const d = diffScriptLists(before, after);
  const target = d.changed.find((s) => s.scriptIdPart === id);
  const problems = [
    ...(target && target.version !== target.before.version ? [] : [`lo script ${id} non risulta aggiornato`]),
    ...d.added.map((s) => `script inatteso: ${label(s)}`),
    ...unexpected(d, id),
  ];
  return { ok: problems.length === 0, script: target ?? null, problems };
}

// Studio "Meteo Livelli" sul grafico: per id dello script salvato o, in mancanza, per nome.
export function findStudy(studies, name, pineId = null) {
  return (pineId && studies.find((s) => s.pineId === pineId)) || studies.find((s) => fold(s.name).startsWith(fold(name))) || null;
}

// Tutte le copie dello studio sul grafico: piu' di una vuol dire un'aggiunta doppia.
export function studyCopies(studies, name, pineId = null) {
  return studies.filter((s) => (pineId && s.pineId === pineId) || fold(s.name).startsWith(fold(name)));
}

// Un tentativo di aggiunta per grafico del layout (un layout puo' avere piu' grafici).
export const chartKey = (state) => `${state.layoutId ?? '?'}#${state.chartIndex ?? 0}`;

// caps da probePage(): si usano solo API con il comportamento verificato nel codice della pagina.
export function chooseMethods(caps) {
  return {
    create: caps.saveNewScript ? 'pineEditorApi.saveNewScript' : caps.saveNew ? 'pineLibApi.saveNew' : null,
    update: caps.saveExistingScript ? 'pineEditorApi.saveExistingScript' : null,
    add: caps.createStudy ? 'createStudy' : null,
    upgrade: caps.pineSourceCodeModel ? 'PineSourceCodeModel.updateToVersion' : null,
  };
}

// ---------------------------------------------------------------- versioni sul grafico
// Ogni studio Pine resta sulla versione con cui e' stato inserito (metaInfo().pine.version). Al salvataggio
// (saveNext) TradingView aggiorna da se' gli studi che erano sull'ULTIMA versione salvata, in tutti i grafici del
// layout (ScriptUpdater -> UpdateScriptVersionUndoCommand: stesso id, input rimappati per nome), come dal Pine
// Editor. Quelli rimasti su versioni piu' vecchie si aggiornano con il comando della legenda
// "aggiorna alla versione piu' recente" (PineSourceCodeModel.updateToVersion sul singolo studio).

// Versioni "maggiore.minore" confrontate come numeri, come Version di TradingView: "0.11" > "0.7".
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 2; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

// saveNext crea la versione maggiore successiva (1.0 -> 2.0). Serve solo ad annunciarla nella prova:
// dopo il salvataggio vale la versione letta dall'elenco.
export function nextVersion(version) {
  const major = parseInt(String(version ?? '').split('.')[0], 10);
  return Number.isFinite(major) ? `${major + 1}.0` : null;
}

// Studi di questo script (per id, mai per nome) rimasti su una versione precedente.
export function studiesToUpgrade(studies, pineId, version) {
  if (!pineId || !version) return [];
  return studies.filter((s) => s.pineId === pineId && s.version && compareVersions(s.version, version) < 0);
}

// Chi li aggiorna: TradingView, al salvataggio, quelli che erano sull'ultima versione (prevVersion);
// il comando della legenda gli altri. Senza salvataggio (prevVersion null) tutti col comando.
export function upgradePlan(studies, pineId, prevVersion, version) {
  const old = studiesToUpgrade(studies, pineId, version);
  const auto = prevVersion ? old.filter((s) => compareVersions(s.version, prevVersion) === 0) : [];
  return { auto, manual: old.filter((s) => !auto.includes(s)) };
}

// Dopo l'aggiornamento: ogni studio indicato e' alla nuova versione (stesso id, o sostituito da un nuovo studio
// dello stesso script), c'e' un solo "Meteo Livelli" e tutti gli altri studi sono identici a prima.
export function verifyUpgrade(before, after, { name, pineId, version, ids }) {
  const prev = new Map(before.map((s) => [s.id, s]));
  const next = new Map(after.map((s) => [s.id, s]));
  const targets = new Set(ids);
  const spare = after.filter((s) => !prev.has(s.id) && s.pineId === pineId);
  const used = new Set();
  const upgraded = [];
  const problems = [];
  for (const id of ids) {
    const old = prev.get(id);
    const s = next.get(id) ?? spare.find((x) => !used.has(x.id)) ?? null;
    if (!s) {
      problems.push(`"${old?.name ?? name}" (${id}) non e' piu' sul grafico`);
      continue;
    }
    used.add(s.id);
    if (s.pineId !== pineId || compareVersions(s.version, version) !== 0) problems.push(`"${s.name}" (${s.id}) e' alla versione ${s.version ?? '?'}, attesa ${version}`);
    else upgraded.push({ ...s, from: old?.version ?? null, replaces: s.id === id ? null : id });
    if (s.error) problems.push(`"${s.name}" (${s.id}) e' in errore sul grafico: ${s.error}`);
  }
  for (const s of before) {
    if (targets.has(s.id)) continue;
    const n = next.get(s.id);
    if (!n) problems.push(`indicatore sparito dal grafico: "${s.name}" (${s.id})`);
    else if (n.name !== s.name || n.pineId !== s.pineId || n.version !== s.version) problems.push(`indicatore modificato: "${s.name}" (${s.id}) v${s.version ?? '-'} -> "${n.name}" v${n.version ?? '-'}`);
  }
  for (const s of after) {
    if (!prev.has(s.id) && !used.has(s.id)) problems.push(`indicatore inatteso sul grafico: "${s.name}" (${s.id})`);
  }
  const copies = studyCopies(after, name, pineId);
  if (copies.length !== 1) problems.push(`sul grafico ci sono ${copies.length} studi "${name}"${copies.length ? ` (${copies.map((s) => s.id).join(', ')})` : ''}: ne serve esattamente uno`);
  return { ok: problems.length === 0, upgraded, problems };
}

// Input scritti da tv-sync (livelli e meteo): sono dati, non impostazioni.
export const SYNC_INPUTS = ['in_0', 'in_1'];

// Scrive SOLO livelli e meteo. Non usare indicators.setInputs dell'MCP: riscrive tutti gli input dello studio
// con i valori letti, e input come __chart_bgcolor (chart.bg_color) tornano numeri invece di testo, mandando lo
// studio in "Can't parse pine". Restituisce gli id effettivamente aggiornati.
export async function writeSyncInputs(core, id, values) {
  const items = Object.entries(values).filter(([k]) => SYNC_INPUTS.includes(k)).map(([k, v]) => ({ id: k, value: String(v) }));
  return core.connection.evaluate(`(function () {
    var chart = ${CHART}, study = chart.getStudyById(${js(id)}), items = ${js(items)};
    if (!study) throw new Error('studio ' + ${js(id)} + ' non trovato');
    study.setInputValues(items);
    var state = chart._chartWidget.model().model().dataSourceForId(${js(id)}).properties().childs().inputs.state();
    return items.filter(function (i) { return state[i.id] === i.value; }).map(function (i) { return i.id; });
  })()`);
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const show = (v) => (typeof v === 'string' ? `"${v.length > 40 ? `${v.slice(0, 40)}...` : v}"` : String(v));

// Input visibili prima/dopo il cambio di versione ([{ id, name: "gruppo.nome", type, value, def }]).
// Regola di TradingView (remapStudyInputsByName): un valore passa alla nuova versione solo se nome e tipo
// coincidono e il predefinito non e' cambiato; altrimenti prende il nuovo predefinito.
// kept: conservati · newDefault: non personalizzati, seguono il nuovo predefinito · reset: personalizzati ma
// riportati al nuovo predefinito da TradingView · gone: non piu' presenti · restore: in_0/in_1 da riscrivere.
// Livelli e meteo si riscrivono solo se la nuova versione li ha azzerati: un altro valore vuol dire che
// tv-sync li ha appena aggiornati, e riscrivere quelli vecchi li lascerebbe indietro.
export function checkInputs(before, after) {
  const res = { kept: [], newDefault: [], reset: [], gone: [], restore: {}, problems: [] };
  const byName = new Map(after.map((i) => [i.name, i]));
  const byId = new Map(after.map((i) => [i.id, i]));
  for (const o of before) {
    if (SYNC_INPUTS.includes(o.id)) {
      const n = byId.get(o.id);
      if (!n || n.type !== o.type) res.problems.push(`l'input ${o.id} ("${o.name}", ${o.type}) non c'e' piu' nella nuova versione: tv-sync scrive li' ${o.id === 'in_0' ? 'i livelli' : 'il meteo'}`);
      else if (!same(n.value, o.value) && same(n.value, n.def) && !same(o.value, o.def)) res.restore[o.id] = o.value;
      else res.kept.push(n);
      continue;
    }
    const n = byName.get(o.name);
    if (!n || n.type !== o.type) res.gone.push(o);
    else if (same(n.value, o.value)) res.kept.push(n);
    else if (!same(n.def, o.def) && same(n.value, n.def)) (same(o.value, o.def) ? res.newDefault : res.reset).push({ ...n, before: o.value });
    else res.problems.push(`input "${o.name}": era ${show(o.value)}, ora ${show(n.value)}`);
  }
  return res;
}

export function parseArgs(argv) {
  const known = ['--apply', '--update', '--help', '-h'];
  const has = (f) => argv.includes(f);
  return { apply: has('--apply') || has('--update'), update: has('--update'), help: has('--help') || has('-h'), unknown: argv.filter((a) => !known.includes(a)) };
}

// Decide cosa fare senza scrivere nulla. scriptStep: create | same | differs | update; chartStep: add | present.
// upgrade: studi dello script sul grafico attivo da portare a upgradeTo (prevista se lo script va ancora salvato);
// upgradeAuto li aggiorna TradingView al salvataggio, upgradeManual il comando della legenda.
export function planSetup({ name, source, savedSource = null, scripts, studies, methods, canCreateStudy = true, update = false }) {
  const blockers = [];
  const notes = [];
  const title = pineTitle(source);
  if (!title || !fold(title).startsWith(fold(name))) blockers.push(`il titolo in indicator() e' "${title}": deve iniziare con "${name}", altrimenti tv-sync non trova lo studio`);

  const { script, matches } = pickScript(scripts, name);
  if (matches.length > 1) blockers.push(`nell'account ci sono ${matches.length} script "${name}": ${matches.map(label).join(', ')}. Tienine uno solo`);
  if (!matches.length && listMayHide(scripts, name)) blockers.push(`l'elenco degli script (${scripts.length}) potrebbe essere incompleto: non creo nulla per non duplicare "${name}"`);

  let scriptStep = 'create';
  if (script) scriptStep = normalizeSource(savedSource) === normalizeSource(source) ? 'same' : update ? 'update' : 'differs';
  if (scriptStep === 'create' && !methods.create) blockers.push('API di creazione script non trovata in questa versione di TradingView');
  if (scriptStep === 'update' && !methods.update) blockers.push('API di aggiornamento script non trovata in questa versione di TradingView');

  const study = findStudy(studies, name, script?.scriptIdPart);
  const chartStep = study ? 'present' : 'add';
  if (study && script && study.pineId && study.pineId !== script.scriptIdPart) notes.push(`sul grafico "${study.name}" viene da un altro script (${study.pineId}): tv-sync usera' quello`);
  if (chartStep === 'add' && !methods.add) blockers.push('API per aggiungere indicatori al grafico non trovata');
  if (chartStep === 'add' && canCreateStudy === false) blockers.push('il grafico ha raggiunto il limite di indicatori del piano');

  const saving = scriptStep === 'update' || scriptStep === 'differs';
  const upgradeTo = !script ? null : saving ? nextVersion(script.version) : scriptStep === 'same' ? script.version : null;
  const upgrade = studiesToUpgrade(studies, script?.scriptIdPart, upgradeTo);
  const { auto: upgradeAuto, manual: upgradeManual } = upgradePlan(studies, script?.scriptIdPart, saving ? script.version : null, upgradeTo);
  if (update && upgrade.length) {
    const copies = studyCopies(studies, name, script.scriptIdPart);
    if (copies.length > 1) blockers.push(`sul grafico ci sono ${copies.length} studi "${name}" (${copies.map((s) => s.id).join(', ')}): togline ${copies.length - 1} prima di aggiornare`);
    if (upgradeManual.length && !methods.upgrade) blockers.push(`comando della legenda per aggiornare la versione non trovato: togli "${name}" dal grafico e riaggiungilo`);
  }
  return { script, matches, scriptStep, study, chartStep, blockers, notes, upgrade, upgradeTo, upgradePredicted: saving, upgradeAuto, upgradeManual };
}

// ---------------------------------------------------------------- TradingView via CDP

export async function loadCore(mcpPath) {
  const load = (file) => import(pathToFileURL(path.join(mcpPath, 'src', file)).href);
  const [connection, chart, indicators, pine] = await Promise.all(['connection.js', 'core/chart.js', 'core/indicators.js', 'core/pine.js'].map(load));
  return { connection, chart, indicators, pine };
}

const js = (v) => JSON.stringify(v);

// Messaggio leggibile per un errore lanciato dentro la pagina.
export const pageError = (err) => String(err?.message ?? err).replace(/^JS evaluation error: (Error: )?/, '');

// Elenco completo degli script salvati (GET, lo stesso usato dal Pine Editor e dal dialogo Indicatori).
export async function readSavedScripts(core) {
  const list = await core.connection.evaluateAsync(`
    fetch((window.PINE_URL || ${js(PINE_URL)}) + '/list/?filter=saved', { credentials: 'include', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('elenco script: HTTP ' + r.status); return r.json(); })`);
  if (!Array.isArray(list)) throw new Error('risposta inattesa dall\'elenco degli script');
  return list.map(({ scriptIdPart, scriptName, scriptTitle, version, modified }) => ({ scriptIdPart, scriptName, scriptTitle, version, modified }));
}

export async function readScriptSource(core, script) {
  return core.connection.evaluateAsync(`
    fetch((window.PINE_URL || ${js(PINE_URL)}) + '/get/' + encodeURIComponent(${js(script.scriptIdPart)}) + '/' + encodeURIComponent(${js(script.version)}), { credentials: 'include', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('sorgente script: HTTP ' + r.status); return r.json(); })
      .then(function (d) { return d.source; })`);
}

// Simbolo, layout e studi del grafico attivo, con l'id e la versione dello script Pine di ogni studio.
// Un errore su uno studio (es. durante il cambio di versione) non deve cancellare i dati degli altri.
export async function readChart(core) {
  return core.connection.evaluate(`(function () {
    var api = window.TradingViewApi, chart = ${CHART}, model = chart._chartWidget.model().model(), pine = {};
    try { model.allStudies().forEach(function (s) { try { var mi = s.metaInfo(), st = null; try { st = s.status(); } catch (e) {} pine[s.id()] = { pineId: mi.scriptIdPart || null, version: mi.pine ? mi.pine.version : null, error: st && st.errorDescription ? st.errorDescription.error || 'errore' : null }; } catch (e) {} }); } catch (e) {}
    var layoutId = null, chartIndex = 0, canCreate = null;
    try { layoutId = api.layoutId(); } catch (e) {}
    try { chartIndex = api.activeChartIndex(); } catch (e) {}
    try { canCreate = model.chartApi().canCreateStudy({ id: '', child: false }).success; } catch (e) {}
    return {
      symbol: chart.symbol(), resolution: chart.resolution(), layoutId: layoutId || location.pathname, chartIndex: chartIndex,
      chartsCount: (function () { try { return api.chartsCount(); } catch (e) { return 1; } })(), canCreateStudy: canCreate,
      studies: chart.getAllStudies().map(function (s) { var p = pine[s.id] || {}; return { id: s.id, name: s.name || s.title || '', pineId: p.pineId || null, version: p.version || null, error: p.error || null }; })
    };
  })()`);
}

// Verifica (senza chiamarle) le API usate e che il salvataggio non permetta la sovrascrittura.
export async function probePage(core) {
  return core.connection.evaluate(`(function () {
    var api = window.TradingViewApi;
    if (!api) return { tradingViewApi: false };
    var src = function (f) { return typeof f === 'function' ? String(f) : ''; };
    var pe = null, lib = null, chart = null;
    try { pe = api.pineEditorApi(); } catch (e) {}
    try { lib = api.pineLibApi(); } catch (e) {}
    try { chart = ${CHART}; } catch (e) {}
    return {
      tradingViewApi: true,
      saveNewScript: /allowOverwrite:\\s*(!1|false)/.test(src(pe && pe.saveNewScript)),
      saveNew: /save\\/new/.test(src(lib && lib.saveNew)),
      saveExistingScript: /saveNext/.test(src(pe && pe.saveExistingScript)),
      createStudy: /_createStudy/.test(src(chart && chart.createStudy)) && !!chart && typeof chart.getStudyById === 'function',
      // Solo presenza: pineSourceCodeModel() caricherebbe codice e creerebbe oggetti, si chiama solo con --update.
      pineSourceCodeModel: (function () { try { return chart._chartWidget.model().model().allStudies().some(function (s) { try { return typeof s.pineSourceCodeModel === 'function' && !!s.metaInfo().pine; } catch (e) { return false; } }); } catch (e) { return false; } })()
    };
  })()`);
}

// Input visibili degli studi indicati, come li vede TradingView nel cambio di versione: nome "gruppo.nome",
// tipo, valore attuale e predefinito della versione dello studio. { id studio: [...] | null }
export async function readStudyInputs(core, ids) {
  return core.connection.evaluate(`(function () {
    var chart = ${CHART}, model = chart._chartWidget.model().model(), out = {};
    ${js(ids)}.forEach(function (id) {
      try {
        var mi = model.dataSourceForId(id).metaInfo(), defs = (mi.defaults && mi.defaults.inputs) || {}, values = {};
        chart.getStudyById(id).getInputValues().forEach(function (v) { values[v.id] = v.value; });
        out[id] = mi.inputs.filter(function (i) { return !i.isHidden; }).map(function (i) {
          return { id: i.id, name: i.name ? (i.group ? i.group + '.' : '') + i.name : i.id, type: i.type, value: values[i.id], def: defs[i.id] };
        });
      } catch (e) { out[id] = null; }
    });
    return out;
  })()`);
}

async function pollChart(core, done, ms) {
  const end = Date.now() + ms;
  let state = await readChart(core);
  while (!done(state) && Date.now() < end) {
    await delay(500);
    state = await readChart(core);
  }
  return state;
}

// Comando "aggiorna alla versione piu' recente" della legenda su UN solo studio (variante {study}, mai "all"
// su tutti i grafici). Niente da fare se lo studio non c'e' piu' o e' gia' alla versione: la variante {study}
// non guarda la versione e lo reinserirebbe comunque.
async function updateStudyVersion(core, id, script) {
  return core.connection.evaluateAsync(`(async function () {
    var undo = ${CHART}._chartWidget.model(), s = undo.model().dataSourceForId(${js(id)}), mi = null;
    try { mi = s && s.metaInfo(); } catch (e) {}
    if (!mi || !mi.pine || mi.scriptIdPart !== ${js(script.scriptIdPart)}) return { missing: true };
    if (mi.pine.version === ${js(script.version)}) return { already: true };
    var m = await s.pineSourceCodeModel();
    if (!m || !/study:this\\._pineScript/.test(String(m.updateToVersion))) throw new Error('comando di aggiornamento versione della legenda non trovato');
    await m.updateToVersion(undo, ${js(script.version)}, false);
    return { requested: true };
  })()`);
}

// Porta alla versione salvata (script.version) gli studi di quello script sul grafico attivo, solo quelli.
// before / inputs: grafico e input letti PRIMA del salvataggio (TradingView aggiorna durante il salvataggio).
// prevVersion: ultima versione prima del salvataggio (null se non si e' salvato nulla).
// Poi verifica: studi alla nuova versione, un solo "Meteo Livelli", altri studi identici, input conservati.
export async function upgradeOnChart(core, script, { name = SCRIPT_NAME, before, inputs = {}, prevVersion = null, autoWaitMs = 10000, waitMs = 15000, settleMs = 1000 } = {}) {
  const pineId = script.scriptIdPart;
  const { auto, manual } = upgradePlan(before.studies, pineId, prevVersion, script.version);
  const targets = [...auto, ...manual];
  const problems = [];
  const notes = [];
  if (!targets.length) return { upgraded: [], problems, notes, chart: before };
  const atVersion = (state, id) => state.studies.some((s) => s.id === id && s.pineId === pineId && compareVersions(s.version, script.version) === 0);

  // 1. Aggiornamento di TradingView al salvataggio: si aspetta che arrivi.
  let state = auto.length ? await pollChart(core, (st) => auto.every((s) => atVersion(st, s.id)), autoWaitMs) : await readChart(core);
  const byTv = new Set(auto.filter((s) => atVersion(state, s.id)).map((s) => s.id));

  // 2. Quelli rimasti indietro: comando della legenda, uno studio alla volta.
  const viaLegend = new Set();
  for (const s of targets.filter((t) => !atVersion(state, t.id))) {
    try {
      const r = await updateStudyVersion(core, s.id, script);
      if (r?.requested) viaLegend.add(s.id);
    } catch (err) {
      problems.push(`"${s.name}" (${s.id}): ${pageError(err)}`);
    }
  }
  if (viaLegend.size) state = await pollChart(core, (st) => targets.every((s) => atVersion(st, s.id)), waitMs);
  await delay(settleMs);
  state = await readChart(core);

  // 3. Verifica del grafico.
  const v = verifyUpgrade(before.studies, state.studies, { name, pineId, version: script.version, ids: targets.map((s) => s.id) });
  problems.push(...v.problems);
  if (state.symbol !== before.symbol || chartKey(state) !== chartKey(before)) problems.push(`il grafico attivo e' cambiato (${before.symbol} -> ${state.symbol})`);
  for (const s of v.upgraded) {
    const id = s.replaces ?? s.id;
    const how = byTv.has(id) ? 'da TradingView al salvataggio, come dal Pine Editor' : viaLegend.has(id) ? 'con il comando della legenda' : 'nel frattempo';
    notes.push(`"${s.name}" ${s.replaces ? `${s.replaces} -> ${s.id}` : s.id}: v${s.from} -> v${s.version}, aggiornato ${how}${s.replaces ? ' (id nuovo: tv-sync lo ritrova per nome)' : ''}`);
  }

  // 4. Input: confronto con quelli di prima; livelli e meteo azzerati dalla nuova versione si riscrivono.
  const now = v.upgraded.length ? await readStudyInputs(core, v.upgraded.map((s) => s.id)) : {};
  for (const s of v.upgraded) {
    const old = inputs[s.replaces ?? s.id];
    if (!old) {
      problems.push(`input di "${s.name}" (${s.id}) non letti prima dell'aggiornamento: controllali a mano`);
      continue;
    }
    if (!now[s.id]) {
      problems.push(`input di "${s.name}" (${s.id}) non leggibili dopo l'aggiornamento`);
      continue;
    }
    const c = checkInputs(old, now[s.id]);
    problems.push(...c.problems.map((p) => `"${s.name}" (${s.id}): ${p}`));
    const restore = Object.keys(c.restore);
    if (restore.length) {
      try {
        await writeSyncInputs(core, s.id, c.restore);
        const again = (await readStudyInputs(core, [s.id]))[s.id] ?? [];
        const lost = restore.filter((id) => !same(again.find((i) => i.id === id)?.value, c.restore[id]));
        if (lost.length) problems.push(`"${s.name}" (${s.id}): ${lost.join(', ')} non ripristinati`);
        else notes.push(`${restore.join(', ')} (livelli/meteo) azzerati dalla nuova versione: ripristinati i valori di prima`);
      } catch (err) {
        problems.push(`"${s.name}" (${s.id}): ripristino di ${restore.join(', ')} fallito: ${pageError(err)}`);
      }
    }
    notes.push(`input conservati: ${c.kept.length} di ${old.length}${restore.length ? `, ${restore.length} ripristinati` : ''}`);
    if (c.newDefault.length) notes.push(`seguono i nuovi predefiniti (non erano personalizzati): ${c.newDefault.map((i) => `"${i.name}" ${show(i.value)}`).join(', ')}`);
    for (const i of c.reset) notes.push(`"${i.name}": la nuova versione ha cambiato il predefinito, TradingView mette ${show(i.value)} al posto del tuo ${show(i.before)}`);
    if (c.gone.length) notes.push(`nella nuova versione non ci sono piu' (rinominati, spostati in un gruppo o tolti: valgono i nuovi predefiniti): ${c.gone.map((i) => `"${i.name}"`).join(', ')}`);
  }
  return { upgraded: v.upgraded, problems, notes, chart: state };
}

// Crea un NUOVO script privato (POST save/new senza allow_overwrite). Non apre ne' modifica il Pine Editor.
export async function createScript(core, method, source, name) {
  return core.connection.evaluateAsync(`(async function () {
    var api = window.TradingViewApi, source = ${js(source)}, name = ${js(name)}, r;
    if (${js(method)} === 'pineEditorApi.saveNewScript') r = await api.pineEditorApi().saveNewScript({ source: source, name: name });
    else if (${js(method)} === 'pineLibApi.saveNew') r = await api.pineLibApi().saveNew({ scriptSource: source, scriptName: name, allowOverwrite: false, currentVersion: null });
    else throw new Error('metodo sconosciuto');
    var mi = r && r.metaInfo;
    return { success: !!(r && r.success), id: mi ? mi.scriptIdPart : null, version: mi && mi.pine ? mi.pine.version : null,
      errors: ((r && r.compileErrors && r.compileErrors.errors) || []).map(function (e) { return e.message || JSON.stringify(e); }) };
  })()`);
}

// Nuova versione dello script indicato (solo quell'id). Durante il salvataggio TradingView aggiorna gli studi che
// erano sull'ultima versione (vedi upgradeOnChart): grafico e input vanno letti prima.
export async function updateScript(core, script, source) {
  return core.connection.evaluateAsync(`(async function () {
    var r = await window.TradingViewApi.pineEditorApi().saveExistingScript({ scriptIdPart: ${js(script.scriptIdPart)}, source: ${js(source)}, name: ${js(script.scriptName)} });
    var mi = r && r.metaInfo;
    return { success: !!(r && r.success), id: mi ? mi.scriptIdPart : null, version: mi && mi.pine ? mi.pine.version : null,
      errors: ((r && r.compileErrors && r.compileErrors.errors) || []).map(function (e) { return e.message || JSON.stringify(e); }) };
  })()`);
}

// Aggiunge lo script salvato (per id USER;..., mai uno pubblico omonimo) al grafico attivo, come fa
// "Aggiungi al grafico" del Pine Editor; poi conferma che gli altri studi siano rimasti tutti.
// Se lo studio c'e' gia' (es. aggiunto da tv-sync o tv-setup) non aggiunge nulla; al limite di indicatori
// non chiama createStudy, che aprirebbe la finestra di upgrade.
export async function addToChart(core, script, { name = SCRIPT_NAME, timeoutMs = 20000 } = {}) {
  const before = await readChart(core);
  const existing = findStudy(before.studies, name, script.scriptIdPart);
  if (existing) return { study: existing, existed: true, problems: [], chart: before };
  if (before.canCreateStudy === false) return { study: null, problems: ['il grafico ha raggiunto il limite di indicatori del piano'], chart: before };
  const descriptor = { type: 'pine', pineId: script.scriptIdPart, pineVersion: script.version };
  let res = null;
  let failure = null;
  try {
    // Controllo e createStudy nello stesso turno della pagina, con un segnaposto finche' l'inserimento non finisce:
    // tv-setup e tv-sync usano la stessa pagina, quindi non possono aggiungerlo insieme. Chi arriva secondo aspetta.
    // _createStudy non propaga gli errori di insertStudy: senza timeout la promessa potrebbe non chiudersi mai.
    res = await core.connection.evaluateAsync(`new Promise(function (resolve, reject) {
      var chart = ${CHART}, over = false;
      var timer = setTimeout(function () { over = true; reject(new Error('nessuna risposta entro ${timeoutMs / 1000}s')); }, ${timeoutMs});
      var end = function (f, v) { clearTimeout(timer); f(v); };
      (function go() {
        if (over) return;
        var busy = window.__meteoLivelliAdd;
        if (busy && Date.now() - busy < ${timeoutMs}) return setTimeout(go, 250);
        var present = chart.getAllStudies().some(function (s) { return String(s.name || s.title || '').trim().toLowerCase().indexOf(${js(fold(name))}) === 0; });
        try { present = present || chart._chartWidget.model().model().allStudies().some(function (s) { return s.metaInfo().scriptIdPart === ${js(script.scriptIdPart)}; }); } catch (e) {}
        if (present) return end(resolve, { existed: true });
        var mine = window.__meteoLivelliAdd = Date.now();
        var free = function () { if (window.__meteoLivelliAdd === mine) window.__meteoLivelliAdd = 0; };
        chart.createStudy(${js(descriptor)}).then(function (id) { free(); end(resolve, { id: id }); }, function (e) { free(); end(reject, new Error(String((e && e.message) || e))); });
      })();
    })`);
  } catch (err) {
    failure = pageError(err);
  }
  if (res?.existed) {
    const now = await readChart(core);
    const study = findStudy(now.studies, name, script.scriptIdPart);
    return { study, existed: true, problems: study ? [] : [`"${name}" aggiunto da un altro processo ma non trovato sul grafico`], chart: now };
  }
  const entityId = res?.id ?? null;
  const prev = new Set(before.studies.map((s) => s.id));
  let after = before;
  let study = null;
  for (let i = 0; i < 10 && !study; i++) {
    await delay(i ? 500 : 0);
    after = await readChart(core);
    const added = after.studies.filter((s) => !prev.has(s.id));
    study = added.find((s) => s.id === entityId) ?? added.find((s) => s.pineId === script.scriptIdPart) ?? null;
    if (failure && !study) break;
  }
  const ids = new Set(after.studies.map((s) => s.id));
  // Un'altra aggiunta in contemporanea (tv-setup e tv-sync insieme) lascerebbe due copie.
  const copies = studyCopies(after.studies, name, script.scriptIdPart);
  const problems = [
    ...(failure ? [`TradingView non ha aggiunto lo studio: ${failure}`] : []),
    ...(study || failure ? [] : [`lo studio ${entityId} non compare sul grafico`]),
    ...(copies.length > 1 ? [`sul grafico ci sono ${copies.length} studi "${name}" (${copies.map((s) => s.id).join(', ')}): togline ${copies.length - 1}`] : []),
    ...before.studies.filter((s) => !ids.has(s.id)).map((s) => `indicatore sparito dal grafico: "${s.name}" (${s.id})`),
    ...(after.symbol === before.symbol ? [] : [`il grafico attivo e' cambiato (${before.symbol} -> ${after.symbol})`]),
  ];
  return { study, problems, chart: after };
}
