import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  assetForSymbol, normalizeSource, pineTitle, matchScripts, pickScript, listMayHide, diffScriptLists,
  verifyCreate, verifyUpdate, findStudy, chartKey, chooseMethods, parseArgs, planSetup, pageError, addToChart, studyCopies,
  compareVersions, nextVersion, studiesToUpgrade, upgradePlan, verifyUpgrade, checkInputs, readChart, readStudyInputs, upgradeOnChart, writeSyncInputs,
} from '../src/tvIndicator.js';

const aliases = { BTC: ['BTC', 'XBT'], ETH: ['ETH'], SOL: ['SOL'], GOLD: ['XAU', 'GOLD', 'GC', 'MGC', 'PAXG', 'TVC:GOLD'] };
const s = (id, scriptName, version = '1.0', scriptTitle = scriptName) => ({ scriptIdPart: `USER;${id}`, scriptName, scriptTitle, version });
const base = [s('a1', 'Analisi Evoluta', '93.0'), s('b2', 'Il mio script'), s('c3', 'Libreria Analisi Evoluta', '1.0', 'CicliCore')];
const source = await readFile(new URL('../tradingview/meteo-livelli.pine', import.meta.url), 'utf8');
const methods = { create: 'pineEditorApi.saveNewScript', update: 'pineEditorApi.saveExistingScript', add: 'createStudy', upgrade: 'PineSourceCodeModel.updateToVersion' };

test('simbolo TradingView -> asset della dashboard', () => {
  assert.equal(assetForSymbol('MEXC:BTCUSDT.P', aliases), 'BTC');
  assert.equal(assetForSymbol('OANDA:XAUUSD', aliases), 'GOLD');
  assert.equal(assetForSymbol('COMEX:GC1!', aliases), 'GOLD');
  assert.equal(assetForSymbol('BINANCE:ETHUSDT', aliases), 'ETH');
  assert.equal(assetForSymbol('FX:EURUSD', aliases), null);
  assert.equal(assetForSymbol(undefined, aliases), null);
  for (const [sym, asset] of [['BITMEX:XBTUSD', 'BTC'], ['BINANCE:BTCUSDTPERP', 'BTC'], ['CME:BTC1!', 'BTC'], ['BINANCE:BTCFDUSD', 'BTC'],
    ['BINANCE:SOLUSDC.P', 'SOL'], ['COMEX:GCZ2025', 'GOLD'], ['COMEX:MGC1!', 'GOLD'], ['BINANCE:PAXGUSDT', 'GOLD'], ['tvc:gold', 'GOLD']]) {
    assert.equal(assetForSymbol(sym, aliases), asset, sym);
  }
  // Simboli che iniziano con l'alias ma non sono l'asset: niente livelli (ne' indicatore) su questi grafici.
  for (const sym of ['CRYPTOCAP:BTC.D', 'CRYPTOCAP:BTC', 'BINANCE:BTCDOMUSDT.P', 'BITSTAMP:BTCEUR', 'NASDAQ:BTCS', 'BINANCE:ETHBTC',
    'BINANCE:ETHFIUSDT', 'BINANCE:ETHWUSDT', 'AMEX:ETHE', 'MEXC:SOLVUSDT', 'BINANCE:SOLETH', 'NYSE:GOLD', 'TVC:GOLDSILVER',
    'OANDA:XAUEUR', 'NASDAQ:GCT', 'NYSE:GCI']) {
    assert.equal(assetForSymbol(sym, aliases), null, sym);
  }
});

// Pagina TradingView finta in una vm: le espressioni vere di readChart e addToChart girano qui.
// createStudy inserisce lo studio dopo insertMs, come la pagina vera (prima scarica i metaInfo).
function fakePage({ studies, canCreateStudy = true, insertMs = 40, insert = (d, id) => [{ id, name: 'Meteo Livelli', pineId: d.pineId }] }) {
  const page = { created: 0, studies };
  const chart = {
    symbol: () => 'MEXC:BTCUSDT.P', resolution: () => '45',
    getAllStudies: () => page.studies.map((x) => ({ id: x.id, name: x.name })),
    createStudy: (d) => new Promise((r) => {
      const id = `M${++page.created}`;
      setTimeout(() => { page.studies.push(...insert(d, id)); r(id); }, insertMs);
    }),
    _chartWidget: { model: () => ({ model: () => ({
      allStudies: () => page.studies.map((x) => ({ id: () => x.id, metaInfo: () => ({ scriptIdPart: x.pineId }) })),
      chartApi: () => ({ canCreateStudy: () => ({ success: canCreateStudy }) }),
    }) }) },
  };
  const ctx = vm.createContext({ setTimeout, clearTimeout, location: { pathname: '/chart/L1/' },
    TradingViewApi: { _activeChartWidgetWV: { value: () => chart }, layoutId: () => 'L1', activeChartIndex: () => 0, chartsCount: () => 1 } });
  ctx.window = ctx;
  // Come connection.evaluate: risultato serializzato, promesse attese.
  const run = async (expr) => JSON.parse(JSON.stringify((await vm.runInContext(expr, ctx)) ?? null));
  page.core = { connection: { evaluate: run, evaluateAsync: run } };
  return page;
}

test('aggiunta al grafico: mai una seconda copia, mai oltre il limite del piano', async () => {
  const meteo = s('d4', 'Meteo Livelli');
  const user = () => ({ id: 'A', name: 'Cicli T-3: Tree & Backtrack V4', pineId: 'USER;b7' });
  const opts = { name: 'Meteo Livelli' };

  const ok = fakePage({ studies: [user()] });
  const added = await addToChart(ok.core, meteo, opts);
  assert.equal(ok.created, 1);
  assert.equal(added.study.id, 'M1');
  assert.deepEqual(added.problems, []);
  assert.ok(!added.existed);

  // Gia' sul grafico: nessuna chiamata a createStudy.
  const again = await addToChart(ok.core, meteo, opts);
  assert.equal(ok.created, 1);
  assert.equal(again.existed, true);
  assert.equal(again.study.id, 'M1');

  // tv-setup e tv-sync insieme sullo stesso grafico: uno aggiunge, l'altro aspetta e usa quello.
  const race = fakePage({ studies: [user()], insertMs: 300 });
  const both = await Promise.all([addToChart(race.core, meteo, opts), addToChart(race.core, meteo, opts)]);
  assert.equal(race.created, 1);
  assert.deepEqual(both.map((r) => [r.study.id, !!r.existed, r.problems.length]).sort(), [['M1', false, 0], ['M1', true, 0]]);
  assert.equal(race.studies.length, 2);

  // Al limite di indicatori createStudy aprirebbe la finestra di upgrade di TradingView.
  const full = fakePage({ studies: [user()], canCreateStudy: false });
  const limit = await addToChart(full.core, meteo, opts);
  assert.equal(full.created, 0);
  assert.equal(limit.study, null);
  assert.ok(limit.problems[0].includes('limite'));

  // Se ne compare comunque una seconda copia, viene segnalata.
  const dup = fakePage({ studies: [user()], insert: (d, id) => [{ id: 'X', name: 'Meteo Livelli', pineId: d.pineId }, { id, name: 'Meteo Livelli', pineId: d.pineId }] });
  const two = await addToChart(dup.core, meteo, opts);
  assert.equal(two.study.id, 'M1');
  assert.ok(two.problems.some((p) => p.includes('2 studi "Meteo Livelli" (X, M1)')));
});

test('sorgente: confronto senza CRLF e spazi finali, titolo da indicator()', () => {
  assert.equal(normalizeSource('a  \r\nb\r\n\r\n'), normalizeSource('a\nb'));
  assert.notEqual(normalizeSource('a\nb'), normalizeSource('a\nc'));
  assert.equal(normalizeSource(null), '');
  assert.equal(pineTitle(source), 'Meteo Livelli');
  assert.equal(pineTitle('//@version=6\nindicator(title="Altro", overlay=true)'), 'Altro');
  assert.equal(pineTitle('strategy("x")'), null);
});

test('ricerca dello script per nome (poi per titolo), senza ambiguita\'', () => {
  assert.deepEqual(matchScripts(base, 'meteo livelli'), []);
  const withMeteo = [...base, s('d4', 'Meteo Livelli')];
  assert.equal(pickScript(withMeteo, 'Meteo Livelli').script.scriptIdPart, 'USER;d4');
  assert.equal(pickScript(withMeteo, ' meteo LIVELLI ').script.scriptIdPart, 'USER;d4');
  // Salvato con un altro nome ma con il titolo giusto: e' comunque lui.
  const byTitle = pickScript([...base, s('e5', 'Script senza titolo', '2.0', 'Meteo Livelli')], 'Meteo Livelli');
  assert.equal(byTitle.script.scriptIdPart, 'USER;e5');
  // Il nome vince sul titolo; due nomi uguali = ambiguo.
  assert.equal(pickScript([...withMeteo, s('e5', 'X', '1.0', 'Meteo Livelli')], 'Meteo Livelli').script.scriptIdPart, 'USER;d4');
  const dup = pickScript([...withMeteo, s('f6', 'Meteo Livelli')], 'Meteo Livelli');
  assert.equal(dup.script, null);
  assert.equal(dup.matches.length, 2);
});

test('elenco forse tagliato: blocca solo se il nome cade dopo l\'ultimo di 50', () => {
  const fifty = Array.from({ length: 50 }, (_, i) => s(`x${i}`, i === 49 ? 'T-3 + Neural RSI' : `Cicli ${String(i).padStart(2, '0')}`));
  assert.equal(listMayHide(fifty, 'Meteo Livelli'), false);
  assert.equal(listMayHide(fifty, 'Zeta'), true);
  assert.equal(listMayHide(fifty.slice(0, 49), 'Zeta'), false);
  assert.equal(listMayHide([], 'Zeta'), false);
});

test('diff degli elenchi: aggiunti, spariti, versioni cambiate', () => {
  const after = [s('a1', 'Analisi Evoluta', '94.0'), s('b2', 'Il mio script'), s('d4', 'Meteo Livelli')];
  const d = diffScriptLists(base, after);
  assert.deepEqual(d.added.map((x) => x.scriptIdPart), ['USER;d4']);
  assert.deepEqual(d.removed.map((x) => x.scriptIdPart), ['USER;c3']);
  assert.deepEqual(d.changed.map((x) => [x.scriptIdPart, x.before.version, x.version]), [['USER;a1', '93.0', '94.0']]);
});

test('verifica dopo la creazione: un solo nuovo "Meteo Livelli" e nient\'altro', () => {
  const ok = verifyCreate(base, [...base, s('d4', 'Meteo Livelli')], 'Meteo Livelli');
  assert.equal(ok.ok, true);
  assert.equal(ok.script.scriptIdPart, 'USER;d4');

  // Sovrascrittura di uno script esistente: nuova versione invece di un nuovo id.
  const overwrite = verifyCreate(base, [s('a1', 'Meteo Livelli', '94.0', 'Meteo Livelli'), ...base.slice(1)], 'Meteo Livelli');
  assert.equal(overwrite.ok, false);
  assert.ok(overwrite.problems.some((p) => p.includes('trovati 0')));
  assert.ok(overwrite.problems.some((p) => p.includes('"Analisi Evoluta" (USER;a1, versione 93.0)') && p.includes('94.0')));

  const twice = verifyCreate(base, [...base, s('d4', 'Meteo Livelli'), s('d5', 'Meteo Livelli')], 'Meteo Livelli');
  assert.equal(twice.ok, false);
  assert.ok(twice.problems[0].includes('trovati 2'));

  const extra = verifyCreate(base, [...base, s('d4', 'Meteo Livelli'), s('z9', 'Script senza titolo')], 'Meteo Livelli');
  assert.equal(extra.ok, false);
  assert.ok(extra.problems.some((p) => p.includes('Script senza titolo')));

  const gone = verifyCreate(base, [base[0], s('d4', 'Meteo Livelli')], 'Meteo Livelli');
  assert.equal(gone.ok, false);
  assert.equal(gone.problems.length, 2);
});

test('verifica dopo l\'aggiornamento: cambia solo lo script indicato', () => {
  const before = [...base, s('d4', 'Meteo Livelli', '1.0')];
  assert.equal(verifyUpdate(before, [...base, s('d4', 'Meteo Livelli', '2.0')], 'USER;d4').ok, true);
  const nothing = verifyUpdate(before, before, 'USER;d4');
  assert.equal(nothing.ok, false);
  const other = verifyUpdate(before, [s('a1', 'Analisi Evoluta', '94.0'), ...base.slice(1), s('d4', 'Meteo Livelli', '2.0')], 'USER;d4');
  assert.equal(other.ok, false);
  assert.ok(other.problems[0].includes('Analisi Evoluta'));
});

test('studio sul grafico: per id dello script, poi per nome', () => {
  const studies = [
    { id: 'A', name: 'Cicli T-3: Tree & Backtrack V4', pineId: 'USER;b7' },
    { id: 'B', name: 'meteo livelli', pineId: 'PUB;xx' },
    { id: 'C', name: 'Meteo Livelli', pineId: 'USER;d4' },
  ];
  assert.equal(findStudy(studies, 'Meteo Livelli', 'USER;d4').id, 'C');
  assert.equal(findStudy(studies, 'Meteo Livelli').id, 'B');
  assert.equal(findStudy(studies.slice(0, 1), 'Meteo Livelli', 'USER;d4'), null);
  assert.deepEqual(studyCopies(studies, 'Meteo Livelli', 'USER;d4').map((x) => x.id), ['B', 'C']);
  assert.deepEqual(studyCopies(studies.slice(0, 1), 'Meteo Livelli'), []);
  assert.equal(chartKey({ layoutId: '5onD92pd', chartIndex: 1 }), '5onD92pd#1');
  assert.equal(chartKey({}), '?#0');
});

test('scelta dei metodi e opzioni da riga di comando', () => {
  assert.deepEqual(chooseMethods({ saveNewScript: true, saveNew: true, saveExistingScript: true, createStudy: true, pineSourceCodeModel: true }), methods);
  assert.deepEqual(chooseMethods({ saveNew: true }), { create: 'pineLibApi.saveNew', update: null, add: null, upgrade: null });
  assert.deepEqual(chooseMethods({}), { create: null, update: null, add: null, upgrade: null });
  assert.deepEqual(parseArgs([]), { apply: false, update: false, help: false, unknown: [] });
  assert.deepEqual(parseArgs(['--update']), { apply: true, update: true, help: false, unknown: [] });
  assert.deepEqual(parseArgs(['--apply', '--force']).unknown, ['--force']);
  assert.equal(pageError(new Error('JS evaluation error: Error: Failed to create study')), 'Failed to create study');
});

test('piano: crea e aggiunge, poi non tocca piu\' nulla', () => {
  const studies = [{ id: 'A', name: 'Cicli T-3: Tree & Backtrack V4', pineId: 'USER;b7' }];
  const first = planSetup({ name: 'Meteo Livelli', source, scripts: base, studies, methods });
  assert.equal(first.scriptStep, 'create');
  assert.equal(first.chartStep, 'add');
  assert.deepEqual(first.blockers, []);

  const scripts = [...base, s('d4', 'Meteo Livelli')];
  const onChart = [...studies, { id: 'M', name: 'Meteo Livelli', pineId: 'USER;d4' }];
  const done = planSetup({ name: 'Meteo Livelli', source, savedSource: source.replace(/\n/g, '\r\n'), scripts, studies: onChart, methods });
  assert.equal(done.scriptStep, 'same');
  assert.equal(done.chartStep, 'present');

  const differs = planSetup({ name: 'Meteo Livelli', source, savedSource: 'vecchio', scripts, studies, methods });
  assert.equal(differs.scriptStep, 'differs');
  assert.equal(differs.chartStep, 'add');
  assert.equal(planSetup({ name: 'Meteo Livelli', source, savedSource: 'vecchio', scripts, studies, methods, update: true }).scriptStep, 'update');
});

test('piano: blocchi di sicurezza', () => {
  const studies = [];
  const dup = planSetup({ name: 'Meteo Livelli', source, scripts: [...base, s('d4', 'Meteo Livelli'), s('d5', 'Meteo Livelli')], studies, methods });
  assert.ok(dup.blockers.some((b) => b.includes('2 script')));
  const noApi = planSetup({ name: 'Meteo Livelli', source, scripts: base, studies, methods: { create: null, update: null, add: null, upgrade: null } });
  assert.equal(noApi.blockers.length, 2);
  const limit = planSetup({ name: 'Meteo Livelli', source, scripts: base, studies, methods, canCreateStudy: false });
  assert.ok(limit.blockers.some((b) => b.includes('limite')));
  const wrongTitle = planSetup({ name: 'Meteo Livelli', source: source.replace('indicator("Meteo Livelli"', 'indicator("Altro"'), scripts: base, studies, methods });
  assert.ok(wrongTitle.blockers.some((b) => b.includes('"Altro"')));
  const fifty = Array.from({ length: 50 }, (_, i) => s(`x${i}`, `Cicli ${String(i).padStart(2, '0')}`));
  assert.ok(planSetup({ name: 'Meteo Livelli', source, scripts: fifty, studies, methods }).blockers.some((b) => b.includes('incompleto')));
  // Studio omonimo che viene da un altro script: solo una nota.
  const other = planSetup({ name: 'Meteo Livelli', source, savedSource: source, scripts: [...base, s('d4', 'Meteo Livelli')], studies: [{ id: 'M', name: 'Meteo Livelli', pineId: 'PUB;zz' }], methods });
  assert.equal(other.chartStep, 'present');
  assert.equal(other.notes.length, 1);
});

// ---------------------------------------------------------------- versione dello studio sul grafico

test('versioni: confronto numerico e versione prevista dopo il salvataggio', () => {
  assert.equal(compareVersions('0.11', '0.7'), 1);
  assert.equal(compareVersions('1.0', '2.0'), -1);
  assert.equal(compareVersions('2.0', '2.0'), 0);
  assert.equal(compareVersions('10.0', '9.0'), 1);
  assert.equal(compareVersions('2', '2.0'), 0);
  assert.equal(nextVersion('1.0'), '2.0');
  assert.equal(nextVersion('93.0'), '94.0');
  assert.equal(nextVersion(null), null);
});

// Come il grafico vero: Meteo alla 1.0, copie di Cicli a versioni diverse dello stesso script, uno pubblico, uno di sistema.
const onChart = () => [
  { id: 'KwpfO0', name: 'Meteo Livelli', pineId: 'USER;d4', version: '1.0' },
  { id: 'FFHJ1n', name: 'Cicli T-3: Tree & Backtrack V4', pineId: 'USER;fbc9', version: '0.11' },
  { id: 'KWCceT', name: 'Cicli T-3: Tree & Backtrack V4', pineId: 'USER;fbc9', version: '0.7' },
  { id: 'vF4iQJ', name: 'Cicli T-3: Tree & Backtrack V4', pineId: 'PUB;e316', version: '6.0' },
  { id: 'ESD$TV_SPLITS', name: 'Splits', pineId: null, version: null },
];

test('quali studi aggiornare: solo quelli dello script, solo se indietro', () => {
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(studiesToUpgrade(onChart(), 'USER;d4', '2.0')), ['KwpfO0']);
  assert.deepEqual(studiesToUpgrade(onChart(), 'USER;d4', '1.0'), []);
  assert.deepEqual(ids(studiesToUpgrade(onChart(), 'USER;fbc9', '0.11')), ['KWCceT']);
  assert.deepEqual(studiesToUpgrade(onChart(), null, '2.0'), []);
  // Stesso nome ma altro script: mai.
  assert.deepEqual(studiesToUpgrade([{ id: 'B', name: 'Meteo Livelli', pineId: 'PUB;zz', version: '1.0' }], 'USER;d4', '2.0'), []);

  // Al salvataggio TradingView aggiorna chi era sull'ultima versione; gli altri col comando della legenda.
  const two = [...onChart(), { id: 'OLD', name: 'Meteo Livelli', pineId: 'USER;d4', version: '0.5' }];
  const p = upgradePlan(two, 'USER;d4', '1.0', '2.0');
  assert.deepEqual([ids(p.auto), ids(p.manual)], [['KwpfO0'], ['OLD']]);
  const noSave = upgradePlan(two, 'USER;d4', null, '1.0');
  assert.deepEqual([ids(noSave.auto), ids(noSave.manual)], [[], ['OLD']]);
});

test('verifica dopo il cambio di versione: studio aggiornato, altri identici, una sola copia', () => {
  const opts = { name: 'Meteo Livelli', pineId: 'USER;d4', version: '2.0', ids: ['KwpfO0'] };
  const up = (list) => list.map((x) => (x.id === 'KwpfO0' ? { ...x, version: '2.0' } : x));

  const ok = verifyUpgrade(onChart(), up(onChart()), opts);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.upgraded.map((x) => [x.id, x.from, x.version, x.replaces]), [['KwpfO0', '1.0', '2.0', null]]);

  const still = verifyUpgrade(onChart(), onChart(), opts);
  assert.equal(still.ok, false);
  assert.ok(still.problems[0].includes('versione 1.0, attesa 2.0'));

  const touched = up(onChart()).filter((x) => x.id !== 'FFHJ1n').map((x) => (x.id === 'KWCceT' ? { ...x, version: '0.12' } : x));
  const t = verifyUpgrade(onChart(), [...touched, { id: 'X', name: 'Altro', pineId: 'PUB;x', version: '1.0' }], opts);
  assert.ok(t.problems.some((p) => p.includes('sparito') && p.includes('FFHJ1n')));
  assert.ok(t.problems.some((p) => p.includes('modificato') && p.includes('KWCceT')));
  assert.ok(t.problems.some((p) => p.includes('inatteso') && p.includes('"Altro" (X)')));

  // Sostituito da un nuovo studio dello stesso script: va bene, tv-sync lo ritrova per nome.
  const replaced = onChart().filter((x) => x.id !== 'KwpfO0').concat({ id: 'N3w', name: 'Meteo Livelli', pineId: 'USER;d4', version: '2.0' });
  const r = verifyUpgrade(onChart(), replaced, opts);
  assert.deepEqual(r.problems, []);
  assert.equal(r.upgraded[0].replaces, 'KwpfO0');

  const twice = verifyUpgrade(onChart(), [...up(onChart()), { id: 'N3w', name: 'Meteo Livelli', pineId: 'USER;d4', version: '2.0' }], opts);
  assert.ok(twice.problems.some((p) => p.includes('2 studi "Meteo Livelli" (KwpfO0, N3w)')));

  const gone = verifyUpgrade(onChart(), onChart().slice(1), opts);
  assert.ok(gone.problems.some((p) => p.includes('(KwpfO0) non e\' piu\' sul grafico')));
  assert.ok(gone.problems.some((p) => p.includes('0 studi')));
});

test('input dopo il cambio di versione: regola di TradingView, livelli e meteo da riscrivere solo se azzerati', () => {
  const inp = (id, name, type, value, def) => ({ id, name, type, value, def });
  const before = [
    inp('in_0', 'Livelli dalla dashboard', 'text_area', 'VAH:84275;POC:83450', ''),
    inp('in_1', 'Meteo (opzionale)', 'text', '⛅ Variabile · BTC', ''),
    inp('in_2', 'Etichette', 'bool', false, true),
    inp('in_4', 'Value area', 'color', '#C9D4E3', '#C9D4E3'),
    inp('in_5', 'POC', 'color', '#FF0000', '#FFC857'),
    inp('in_9', 'Put wall', 'color', '#FF5C6C', '#FF5C6C'),
  ];
  const after = [
    inp('in_0', 'Livelli dalla dashboard', 'text_area', 'VAH:0', 'VAH:0'), // predefinito cambiato: TradingView lo azzera
    inp('in_1', 'Meteo (opzionale)', 'text', '⛈️ Temporale · BTC', ''), // aggiornato da tv-sync nel frattempo
    inp('in_2', 'Etichette', 'bool', false, true),
    inp('in_4', 'Value area', 'color', '#D8DEE9', '#D8DEE9'),
    inp('in_5', 'POC', 'color', '#F5B942', '#F5B942'),
    inp('in_6', 'Stile linee', 'string', 'sottile', 'sottile'),
  ];
  const c = checkInputs(before, after);
  assert.deepEqual(c.restore, { in_0: 'VAH:84275;POC:83450' });
  assert.deepEqual(c.kept.map((i) => i.id), ['in_1', 'in_2']);
  assert.deepEqual(c.newDefault.map((i) => i.name), ['Value area']);
  assert.deepEqual(c.reset.map((i) => [i.name, i.before, i.value]), [['POC', '#FF0000', '#F5B942']]);
  assert.deepEqual(c.gone.map((i) => i.name), ['Put wall']);
  assert.deepEqual(c.problems, []);

  // Stesso predefinito ma valore diverso: non e' la regola di TradingView.
  const lost = checkInputs(before.slice(2, 3), [inp('in_2', 'Etichette', 'bool', true, true)]);
  assert.ok(lost.problems[0].includes('"Etichette": era false, ora true'));
  // in_0 non piu' testo: tv-sync scriverebbe i livelli nel posto sbagliato.
  const moved = checkInputs(before.slice(0, 1), [inp('in_0', 'Etichette', 'bool', true, true)]);
  assert.ok(moved.problems[0].includes('tv-sync scrive li\' i livelli'));
  // Valore uguale al predefinito anche prima: niente da riscrivere.
  assert.deepEqual(checkInputs([inp('in_1', 'Meteo (opzionale)', 'text', '', '')], [inp('in_1', 'Meteo (opzionale)', 'text', 'x', 'x')]).restore, {});

  // Caso reale della nuova grafica: livelli e meteo spostati nel gruppo "Dati dalla dashboard". TradingView abbina
  // per "gruppo.nome", quindi li azzera anche se il predefinito ("") e' lo stesso: vanno riscritti per id.
  const grouped = checkInputs(before.slice(0, 3), [
    inp('in_0', 'Dati dalla dashboard.Livelli dalla dashboard', 'text_area', '', ''),
    inp('in_1', 'Dati dalla dashboard.Meteo (opzionale)', 'text', '', ''),
    inp('in_2', 'Linee.Inizio linee (barre fa)', 'integer', 120, 120),
  ]);
  assert.deepEqual(grouped.restore, { in_0: 'VAH:84275;POC:83450', in_1: '⛅ Variabile · BTC' });
  assert.deepEqual(grouped.gone.map((i) => i.name), ['Etichette']);
  assert.deepEqual(grouped.problems, []);
});

test('piano: con --update lo studio sul grafico passa alla nuova versione, solo quello dello script', () => {
  const scripts = [...base, s('d4', 'Meteo Livelli', '1.0')];
  const studies = [{ id: 'A', name: 'Cicli T-3: Tree & Backtrack V4', pineId: 'USER;b7', version: '0.2' }, { id: 'M', name: 'Meteo Livelli', pineId: 'USER;d4', version: '1.0' }];
  const ids = (list) => list.map((x) => x.id);
  const plan = (o) => planSetup({ name: 'Meteo Livelli', source, scripts, studies, methods, savedSource: 'vecchio', update: true, ...o });

  const upd = plan({});
  assert.equal(upd.scriptStep, 'update');
  assert.equal(upd.chartStep, 'present');
  assert.deepEqual([ids(upd.upgrade), upd.upgradeTo, upd.upgradePredicted, ids(upd.upgradeAuto), ids(upd.upgradeManual)], [['M'], '2.0', true, ['M'], []]);
  assert.deepEqual(upd.blockers, []);
  // Il comando della legenda non serve: lo studio e' sull'ultima versione e lo aggiorna TradingView.
  assert.deepEqual(plan({ methods: { ...methods, upgrade: null } }).blockers, []);

  // --apply senza --update: lo script resta "diverso", ma il piano mostra l'aggiornamento previsto.
  const apply = plan({ update: false });
  assert.equal(apply.scriptStep, 'differs');
  assert.deepEqual(ids(apply.upgrade), ['M']);

  // Script gia' uguale, studio rimasto alla 1.0 con l'ultima 2.0: comando della legenda.
  const newer = [...base, s('d4', 'Meteo Livelli', '2.0')];
  const behind = plan({ scripts: newer, savedSource: source });
  assert.equal(behind.scriptStep, 'same');
  assert.deepEqual([ids(behind.upgrade), behind.upgradeTo, behind.upgradePredicted, ids(behind.upgradeManual)], [['M'], '2.0', false, ['M']]);
  assert.ok(plan({ scripts: newer, savedSource: source, methods: { ...methods, upgrade: null } }).blockers.some((b) => b.includes('legenda')));
  assert.deepEqual(plan({ savedSource: source }).upgrade, []);

  const dup = plan({ studies: [...studies, { id: 'M2', name: 'Meteo Livelli', pineId: 'USER;d4', version: '1.0' }] });
  assert.ok(dup.blockers.some((b) => b.includes('2 studi "Meteo Livelli" (M, M2)')));
  assert.equal(plan({ studies: studies.slice(0, 1) }).chartStep, 'add');
  assert.deepEqual(plan({ studies: studies.slice(0, 1) }).upgrade, []);
});

// Pagina finta per il cambio di versione: studi con metaInfo (versione, input, predefiniti) e il comando della
// legenda. page.upgrade() fa come UpdateScriptVersionUndoCommand: stesso id, valore conservato solo se nome,
// tipo e predefinito coincidono, altrimenti il nuovo predefinito.
function upgradePage(studies, nextInputs, { legend } = {}) {
  const page = { studies, legendCalls: [], writes: [] };
  const find = (id) => page.studies.find((x) => x.id === id);
  const meta = (x) => {
    if (x.stub) throw new Error('studio in sostituzione');
    return {
      scriptIdPart: x.pineId, pine: x.version ? { version: x.version } : undefined,
      inputs: [{ id: 'text', name: 'ILScript', type: 'text', isHidden: true }, ...x.inputs.map(({ id, name, type, group }) => ({ id, name, type, group }))],
      defaults: { inputs: Object.fromEntries(x.inputs.map((i) => [i.id, i.def])) },
    };
  };
  const key = (i) => `${i.group ? `${i.group}.` : ''}${i.name}`;
  page.upgrade = (id, version) => {
    const x = find(id);
    x.version = version;
    x.inputs = nextInputs.map((n) => {
      const o = x.inputs.find((i) => key(i) === key(n) && i.type === n.type && i.def === n.def);
      return { ...n, value: o ? o.value : n.def };
    });
  };
  class SourceModel {
    constructor(study) { this._pineScript = study; }
    async updateToVersion(e, t, o) {
      const i = o ? 'all' : {study:this._pineScript};
      page.legendCalls.push([i.study.id(), String(t), e.undoHistory() === 'H']);
      setTimeout(() => page.upgrade(i.study.id(), String(t)), 30);
    }
  }
  const source = (x) => {
    const st = { id: () => x.id, metaInfo: () => meta(x),
      status: () => (x.error ? { type: 3, errorDescription: { error: x.error } } : { type: 1 }),
      properties: () => ({ childs: () => ({ inputs: { state: () => Object.fromEntries(x.inputs.map((i) => [i.id, i.value])) } }) }) };
    st.pineSourceCodeModel = async () => (legend ? legend(st) : new SourceModel(st));
    return st;
  };
  const model = {
    allStudies: () => page.studies.map(source),
    dataSourceForId: (id) => (find(id) ? source(find(id)) : null),
    chartApi: () => ({ canCreateStudy: () => ({ success: true }) }),
  };
  const chart = {
    symbol: () => 'MEXC:BTCUSDT.P', resolution: () => '45',
    getAllStudies: () => page.studies.map((x) => ({ id: x.id, name: x.name })),
    getStudyById: (id) => ({
      getInputValues: () => [{ id: 'text', value: 'IL' }, ...find(id).inputs.map((i) => ({ id: i.id, value: i.value }))],
      // Come TradingView: aggiorna solo gli input passati.
      setInputValues: (items) => {
        page.writes.push([id, Object.fromEntries(items.map((i) => [i.id, i.value]))]);
        for (const it of items) { const inp = find(id).inputs.find((i) => i.id === it.id); if (inp) inp.value = it.value; }
      },
    }),
    _chartWidget: { model: () => ({ model: () => model, undoHistory: () => 'H' }) },
  };
  const ctx = vm.createContext({ setTimeout, clearTimeout, location: { pathname: '/chart/L1/' },
    TradingViewApi: { _activeChartWidgetWV: { value: () => chart }, layoutId: () => 'L1', activeChartIndex: () => 0, chartsCount: () => 1 } });
  ctx.window = ctx;
  const run = async (expr) => JSON.parse(JSON.stringify((await vm.runInContext(expr, ctx)) ?? null));
  // indicators.setInputs dell'MCP non va usato (riscrive tutti gli input): se qualcuno lo chiama, il test fallisce.
  const setInputs = async () => { throw new Error('indicators.setInputs non va usato'); };
  page.core = { connection: { evaluate: run, evaluateAsync: run }, indicators: { setInputs } };
  return page;
}

test('scrittura input: solo livelli e meteo, mai gli altri (es. colori, sfondo del grafico)', async () => {
  const page = upgradePage([{ id: 'M', name: 'Meteo Livelli', pineId: 'USER;d4', version: '2.0', inputs: [
    { id: 'in_0', name: 'Livelli dalla dashboard', type: 'text_area', def: '', value: '' },
    { id: 'in_1', name: 'Meteo (opzionale)', type: 'text', def: '', value: '' },
    { id: 'in_13', name: 'Gamma flip', type: 'color', def: '#3987E5', value: '#3987E5' },
  ] }], []);
  const updated = await writeSyncInputs(page.core, 'M', { in_0: 'POC:1', in_1: 'Sereno', in_13: 123 });
  assert.deepEqual(updated, ['in_0', 'in_1']);
  assert.deepEqual(page.writes, [['M', { in_0: 'POC:1', in_1: 'Sereno' }]]);
  assert.equal(page.studies[0].inputs[2].value, '#3987E5');
});

test('grafico: uno studio in errore viene segnalato dalla verifica', async () => {
  const page = upgradePage([{ id: 'M', name: 'Meteo Livelli', pineId: 'USER;d4', version: '2.0', error: "Can't parse pine", inputs: [] }], []);
  const state = await readChart(page.core);
  assert.equal(state.studies[0].error, "Can't parse pine");
  const v = verifyUpgrade([{ ...state.studies[0], version: '1.0', error: null }], state.studies, { name: 'Meteo Livelli', pineId: 'USER;d4', version: '2.0', ids: ['M'] });
  assert.ok(v.problems.some((p) => p.includes("in errore sul grafico: Can't parse pine")));
});

const v1Inputs = () => [
  { id: 'in_0', name: 'Livelli dalla dashboard', type: 'text_area', def: '', value: 'VAH:84275;POC:83450' },
  { id: 'in_1', name: 'Meteo (opzionale)', type: 'text', def: '', value: '⛅ Variabile · BTC' },
  { id: 'in_2', name: 'Etichette', type: 'bool', def: true, value: false },
  { id: 'in_5', name: 'POC', type: 'color', def: '#FFC857', value: '#FFC857' },
];
const sameInputs = v1Inputs().map(({ value, ...i }) => i);
// Nuova grafica: predefinito dei livelli e del POC cambiati, un input in piu'.
const newInputs = [
  { id: 'in_0', name: 'Livelli dalla dashboard', type: 'text_area', def: 'VAH:0' },
  { id: 'in_1', name: 'Meteo (opzionale)', type: 'text', def: '' },
  { id: 'in_2', name: 'Etichette', type: 'bool', def: true },
  { id: 'in_5', name: 'POC', type: 'color', def: '#F5B942' },
  { id: 'in_6', name: 'Stile linee', type: 'string', def: 'sottile' },
];
const cicli = () => ({ id: 'A', name: 'Cicli T-3: Tree & Backtrack V4', pineId: 'USER;b7', version: '0.2', inputs: [{ id: 'in_0', name: 'Lunghezza', type: 'integer', def: 20, value: 34 }] });
const meteo = (version) => ({ id: 'M', name: 'Meteo Livelli', pineId: 'USER;d4', version, inputs: v1Inputs() });
const ME = { scriptIdPart: 'USER;d4' };

test('lettura del grafico: uno studio in sostituzione non cancella i dati degli altri', async () => {
  const page = upgradePage([{ id: 'S', name: 'Meteo Livelli', stub: true, inputs: [] }, meteo('1.0'), cicli()], sameInputs);
  const st = await readChart(page.core);
  assert.deepEqual(st.studies.map((x) => [x.id, x.pineId, x.version]), [['S', null, null], ['M', 'USER;d4', '1.0'], ['A', 'USER;b7', '0.2']]);
  const inputs = await readStudyInputs(page.core, ['M', 'S']);
  assert.deepEqual(inputs.M.map((i) => [i.id, i.name, i.value, i.def]).slice(0, 2), [['in_0', 'Livelli dalla dashboard', 'VAH:84275;POC:83450', ''], ['in_1', 'Meteo (opzionale)', '⛅ Variabile · BTC', '']]);
  assert.equal(inputs.M.length, 4); // ILScript nascosto escluso
  assert.equal(inputs.S, null);
});

test('cambio versione sul grafico: lo fa TradingView al salvataggio, stesso id e stessi input', async () => {
  const page = upgradePage([cicli(), meteo('1.0')], sameInputs);
  const before = await readChart(page.core);
  const inputs = await readStudyInputs(page.core, ['M']);
  setTimeout(() => page.upgrade('M', '2.0'), 80); // ScriptUpdater durante saveExistingScript
  const res = await upgradeOnChart(page.core, { ...ME, version: '2.0' }, { name: 'Meteo Livelli', before, inputs, prevVersion: '1.0', autoWaitMs: 3000, settleMs: 0 });
  assert.deepEqual(res.problems, []);
  assert.deepEqual(res.upgraded.map((x) => [x.id, x.from, x.version]), [['M', '1.0', '2.0']]);
  assert.deepEqual(page.legendCalls, []);
  assert.deepEqual(page.writes, []);
  assert.ok(res.notes.some((n) => n.includes('da TradingView al salvataggio')));
  assert.ok(res.notes.some((n) => n.includes('input conservati: 4 di 4')));
  assert.equal(page.studies.find((x) => x.id === 'A').version, '0.2');
});

test('cambio versione sul grafico: studio rimasto indietro -> comando della legenda, livelli ripristinati', async () => {
  const page = upgradePage([cicli(), meteo('1.0')], newInputs);
  const before = await readChart(page.core);
  const inputs = await readStudyInputs(page.core, ['M']);
  // L'ultima versione era la 2.0: TradingView non tocca uno studio alla 1.0.
  const res = await upgradeOnChart(page.core, { ...ME, version: '3.0' }, { name: 'Meteo Livelli', before, inputs, prevVersion: '2.0', waitMs: 3000, settleMs: 0 });
  assert.deepEqual(res.problems, []);
  assert.deepEqual(page.legendCalls, [['M', '3.0', true]]);
  // La nuova versione ha cambiato il predefinito dei livelli: TradingView li azzera, si riscrivono quelli di prima.
  assert.deepEqual(page.writes, [['M', { in_0: 'VAH:84275;POC:83450' }]]);
  const m = page.studies.find((x) => x.id === 'M');
  assert.deepEqual(m.inputs.map((i) => i.value), ['VAH:84275;POC:83450', '⛅ Variabile · BTC', false, '#F5B942', 'sottile']);
  assert.ok(res.notes.some((n) => n.includes('con il comando della legenda')));
  assert.ok(res.notes.some((n) => n.includes('in_0 (livelli/meteo)') && n.includes('ripristinati')));
  assert.ok(res.notes.some((n) => n.includes('nuovi predefiniti') && n.includes('"POC"')));

  // Rilanciato quando e' gia' alla versione: nessun comando.
  const again = await upgradeOnChart(page.core, { ...ME, version: '3.0' }, { before: await readChart(page.core), inputs: {}, waitMs: 300, settleMs: 0 });
  assert.deepEqual([again.upgraded, again.problems, page.legendCalls.length], [[], [], 1]);
});

test('cambio versione sul grafico: livelli e meteo spostati in un gruppo, TradingView li azzera e si riscrivono', async () => {
  const G = 'Dati dalla dashboard';
  const grouped = [
    { id: 'in_0', name: 'Livelli dalla dashboard', group: G, type: 'text_area', def: '' },
    { id: 'in_1', name: 'Meteo (opzionale)', group: G, type: 'text', def: '' },
    { id: 'in_2', name: 'Inizio linee (barre fa)', group: 'Linee', type: 'integer', def: 120 },
  ];
  const page = upgradePage([cicli(), meteo('1.0')], grouped);
  const before = await readChart(page.core);
  const inputs = await readStudyInputs(page.core, ['M']);
  setTimeout(() => page.upgrade('M', '2.0'), 50);
  const res = await upgradeOnChart(page.core, { ...ME, version: '2.0' }, { name: 'Meteo Livelli', before, inputs, prevVersion: '1.0', autoWaitMs: 3000, settleMs: 0 });
  assert.deepEqual(res.problems, []);
  assert.deepEqual(page.legendCalls, []);
  assert.deepEqual(page.writes, [['M', { in_0: 'VAH:84275;POC:83450', in_1: '⛅ Variabile · BTC' }]]);
  assert.deepEqual(page.studies.find((x) => x.id === 'M').inputs.map((i) => i.value), ['VAH:84275;POC:83450', '⛅ Variabile · BTC', 120]);
  assert.ok(res.notes.some((n) => n.includes('in_0, in_1 (livelli/meteo)')));
  assert.ok(res.notes.some((n) => n.includes('non ci sono piu\'') && n.includes('"Etichette"') && n.includes('"POC"')));
});

test('cambio versione sul grafico: errori segnalati, mai un comando diverso da quello sul singolo studio', async () => {
  // Lo studio non cambia versione.
  const stuck = upgradePage([cicli(), meteo('1.0')], sameInputs);
  stuck.upgrade = () => {};
  const before = await readChart(stuck.core);
  const r1 = await upgradeOnChart(stuck.core, { ...ME, version: '2.0' }, { before, inputs: await readStudyInputs(stuck.core, ['M']), prevVersion: '1.0', autoWaitMs: 200, waitMs: 300, settleMs: 0 });
  assert.equal(stuck.legendCalls.length, 1); // TradingView non l'ha aggiornato: si prova col comando della legenda
  assert.ok(r1.problems.some((p) => p.includes('versione 1.0, attesa 2.0')));

  // Durante l'aggiornamento sparisce un altro indicatore.
  const other = upgradePage([cicli(), meteo('1.0')], sameInputs);
  const b2 = await readChart(other.core);
  setTimeout(() => { other.studies = other.studies.filter((x) => x.id !== 'A'); other.upgrade('M', '2.0'); }, 50);
  const r2 = await upgradeOnChart(other.core, { ...ME, version: '2.0' }, { before: b2, inputs: await readStudyInputs(other.core, ['M']), prevVersion: '1.0', autoWaitMs: 2000, settleMs: 0 });
  assert.ok(r2.problems.some((p) => p.includes('indicatore sparito') && p.includes('(A)')));

  // Un comando della legenda con un comportamento diverso da quello verificato non viene chiamato.
  let called = false;
  const odd = upgradePage([meteo('1.0')], sameInputs, { legend: () => ({ async updateToVersion() { called = true; } }) });
  const r3 = await upgradeOnChart(odd.core, { ...ME, version: '2.0' }, { before: await readChart(odd.core), inputs: {}, waitMs: 200, settleMs: 0 });
  assert.equal(called, false);
  assert.ok(r3.problems.some((p) => p.includes('comando di aggiornamento versione della legenda non trovato')));
});
