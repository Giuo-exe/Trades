// Prepara una volta sola l'indicatore "Meteo Livelli": crea lo script privato nell'account TradingView
// (da tradingview/meteo-livelli.pine) se manca e lo aggiunge al grafico attivo se manca. Da li' in poi
// tv-sync ne cambia solo gli input. Senza opzioni e' una prova: legge tutto e mostra il piano, non scrive.
//   npm run tv-setup                prova (mostra anche cosa farebbe --update)
//   npm run tv-setup -- --apply     crea lo script e/o lo aggiunge al grafico
//   npm run tv-setup -- --update    come --apply, e se il sorgente salvato e' diverso lo aggiorna; poi porta alla
//                                   nuova versione l'indicatore gia' sul grafico attivo (stesso studio, stessi input)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SCRIPT_NAME, loadCore, parseArgs, chooseMethods, planSetup, pickScript, assetForSymbol, chartKey, studiesToUpgrade,
  readSavedScripts, readScriptSource, readChart, readStudyInputs, probePage, createScript, updateScript, addToChart, upgradeOnChart,
  verifyCreate, verifyUpdate, diffScriptLists, pageError,
} from './tvIndicator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
if (args.help || args.unknown.length) {
  if (args.unknown.length) console.error(`Opzione sconosciuta: ${args.unknown.join(' ')}`);
  console.log('Uso: npm run tv-setup [-- --apply | -- --update]\n  (nessuna opzione)  prova, nessuna modifica\n  --apply            crea lo script "Meteo Livelli" se manca e lo aggiunge al grafico attivo se manca\n  --update           come --apply, aggiorna lo script esistente se il sorgente e\' diverso e porta alla nuova\n                     versione l\'indicatore gia\' sul grafico attivo');
  process.exit(args.unknown.length ? 1 : 0);
}

const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const tv = config.tradingview;
const name = tv.studyName ?? SCRIPT_NAME;
const pineFile = path.join(root, 'tradingview', 'meteo-livelli.pine');
const source = await readFile(pineFile, 'utf8');
const core = await loadCore(tv.mcpPath);
const say = (msg = '') => console.log(msg);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const RESTORE_HINT = 'Controlla gli script elencati in TradingView: Pine Editor -> apri lo script -> menu del titolo ->\n"Storico versioni..." per ripristinare la versione precedente.';

function alarm(title, problems, hint = RESTORE_HINT) {
  console.error(`\n!!! ATTENZIONE: ${title} !!!`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(hint);
}

// Rilegge l'elenco finche' la verifica passa (il server puo' metterci un attimo ad aggiornarlo).
async function readVerified(check) {
  let result;
  for (let i = 0; i < 4; i++) {
    if (i) await delay(1500);
    result = check(await readSavedScripts(core));
    if (result.ok) break;
  }
  return result;
}

async function main() {
  say(`Meteo Livelli · tv-setup ${args.apply ? `(MODIFICA${args.update ? ' + aggiornamento sorgente e grafico' : ''})` : '(PROVA: nessuna modifica)'}`);

  const lines = source.split(/\r?\n/).length;
  const check = await core.pine.check({ source });
  say(`Sorgente: tradingview/meteo-livelli.pine (${lines} righe) · compilazione TradingView: ${check.compiled ? 'OK' : 'ERRORI'}${check.warning_count ? `, ${check.warning_count} avvisi` : ''}`);
  for (const e of check.errors ?? []) say(`  riga ${e.line ?? '?'}: ${e.message}`);

  const caps = await probePage(core);
  if (!caps.tradingViewApi) throw new Error('la pagina collegata non espone TradingViewApi: e\' aperto un grafico?');
  const methods = chooseMethods(caps);
  const state = await readChart(core);
  const asset = assetForSymbol(state.symbol, tv.symbolAliases);
  say(`Grafico attivo: ${state.symbol} ${state.resolution} · layout ${state.layoutId}, grafico ${state.chartIndex + 1} di ${state.chartsCount} · ${state.studies.length} studi · asset dashboard: ${asset ?? 'nessuno (tv-sync non lo aggiornera\')'}`);

  const scripts = await readSavedScripts(core);
  const { script } = pickScript(scripts, name);
  const savedSource = script ? await readScriptSource(core, script) : null;
  // La prova mostra il piano di --update (script e grafico); --apply non aggiorna nulla.
  const planUpdate = args.update || !args.apply;
  const plan = planSetup({ name, source, savedSource, scripts, studies: state.studies, methods, canCreateStudy: state.canCreateStudy, update: planUpdate });
  say(`Script salvati nell'account: ${scripts.length} (elenco completo) · "${name}": ${plan.matches.length ? plan.matches.map((s) => `${s.scriptName} ${s.scriptIdPart} v${s.version}`).join(', ') : 'assente'}`);
  say(`API TradingView: creazione ${methods.create ?? 'NON TROVATA'} · aggiornamento ${methods.update ?? 'NON TROVATA'} · aggiunta al grafico ${methods.add ?? 'NON TROVATA'}${state.canCreateStudy === false ? ' (limite indicatori raggiunto)' : ''} · versione sul grafico ${methods.upgrade ?? 'comando della legenda NON TROVATO'}`);
  if (!check.compiled) plan.blockers.push('il sorgente non compila: correggi meteo-livelli.pine');

  const steps = [];
  if (plan.scriptStep === 'create') {
    steps.push(`creare lo script privato "${name}" con ${methods.create} (POST pine-facade save/new senza allow_overwrite: non sovrascrive nulla, il Pine Editor non viene toccato)`);
    steps.push(`rileggere l'elenco completo: deve esserci esattamente un nuovo "${name}" e nessun altro script deve cambiare versione`);
  } else if (plan.scriptStep === 'same') {
    say(`Script "${name}": gia' presente (v${script.version}) e uguale al file, non va toccato.`);
  } else {
    say(`Script "${name}": il sorgente salvato (v${script.version}) e' DIVERSO da meteo-livelli.pine.${plan.scriptStep === 'differs' ? ' Per aggiornarlo: npm run tv-setup -- --update' : ''}`);
    if (plan.scriptStep === 'update') {
      steps.push(`salvare una nuova versione dello script ${script.scriptIdPart} (solo quello) con il sorgente del file: v${script.version} -> v${plan.upgradeTo} (prevista)`);
      steps.push('rileggere l\'elenco completo: deve cambiare solo la versione di quello script');
    }
  }
  if (plan.chartStep === 'add') {
    steps.push(`aggiungere "${name}" al grafico ${state.symbol} con createStudy sull'id dello script salvato (USER;..., mai uno pubblico omonimo), senza toccare gli altri ${state.studies.length} studi`);
  } else {
    say(`Grafico: "${plan.study.name}" gia' presente (${plan.study.id}${plan.study.version ? `, v${plan.study.version}` : ''}), non va aggiunto.`);
  }
  if (plan.upgrade.length) {
    const to = `v${plan.upgradeTo}${plan.upgradePredicted ? ' (prevista)' : ''}`;
    for (const s of plan.upgrade) {
      const how = plan.upgradeAuto.includes(s) ? 'la fa TradingView al salvataggio, come dal Pine Editor (stesso studio, stesso id)' : 'comando della legenda "aggiorna alla versione piu\' recente", solo su questo studio';
      say(`Versione sul grafico: "${s.name}" ${s.id} v${s.version} -> ${to} · ${how}`);
    }
    if (planUpdate) {
      steps.push(`portare alla ${to} ${plan.upgrade.map((s) => `${s.id} (v${s.version})`).join(', ')} sul grafico ${state.symbol}: solo gli studi dello script ${script.scriptIdPart}`);
      steps.push(`verificare: un solo "${name}", alla nuova versione, gli altri ${state.studies.length - plan.upgrade.length} studi invariati; input: TradingView conserva quelli con stesso nome, gruppo e predefinito, gli altri prendono i nuovi predefiniti; livelli e meteo, se azzerati, si riscrivono subito (tv-sync non lo farebbe finche' non cambiano)`);
      if (plan.upgradeAuto.length && state.chartsCount > 1) say(`Nota: al salvataggio TradingView aggiorna anche le copie alla v${script.version} sugli altri ${state.chartsCount - 1} grafici del layout.`);
    } else {
      say('Per aggiornarlo: npm run tv-setup -- --update');
    }
  }
  for (const n of plan.notes) say(`Nota: ${n}`);

  if (plan.blockers.length) {
    say('\nImpossibile procedere:');
    for (const b of plan.blockers) say(`  - ${b}`);
    return 1;
  }
  if (!steps.length) {
    say('\nTutto pronto: tv-sync cambiera\' solo gli input dell\'indicatore.');
    return 0;
  }
  say('\nPiano:');
  steps.forEach((s, i) => say(`  ${i + 1}. ${s}`));
  say('  Poi tv-sync cambia solo gli input dell\'indicatore.');
  if (!args.apply) {
    say(`\nProva completata, nessuna modifica. Per eseguire il piano: npm run tv-setup -- ${plan.scriptStep === 'update' || plan.upgrade.length ? '--update' : '--apply'}`);
    return 0;
  }

  // Grafico e input si leggono PRIMA di salvare: TradingView aggiorna gli studi durante il salvataggio.
  const willUpgrade = args.update && (plan.scriptStep === 'update' || plan.upgrade.length > 0);
  const snapshot = async () => {
    const chart = await readChart(core);
    if (chart.symbol !== state.symbol || chartKey(chart) !== chartKey(state)) throw new Error(`il grafico attivo e' cambiato durante la verifica (${state.symbol} -> ${chart.symbol}): riesegui la prova`);
    const mine = chart.studies.filter((s) => s.pineId === script.scriptIdPart).map((s) => s.id);
    return { chart, inputs: mine.length ? await readStudyInputs(core, mine) : {} };
  };
  let snap = null;

  let saved = script;
  if (plan.scriptStep === 'create' || plan.scriptStep === 'update') {
    const before = await readSavedScripts(core);
    if (willUpgrade) snap = await snapshot();
    const again = planSetup({ name, source, savedSource, scripts: before, studies: (snap?.chart ?? state).studies, methods, update: args.update });
    if (again.scriptStep !== plan.scriptStep || again.script?.version !== plan.script?.version || again.blockers.length) throw new Error('l\'elenco degli script o il grafico sono cambiati durante la verifica: riesegui la prova');
    say(plan.scriptStep === 'create' ? `\nCreo "${name}"...` : `\nAggiorno "${name}"...`);
    let res = null;
    try {
      res = plan.scriptStep === 'create' ? await createScript(core, methods.create, source, name) : await updateScript(core, script, source);
    } catch (err) {
      // Rifiutato da TradingView: si controlla comunque che l'elenco non sia cambiato.
      const after = await readSavedScripts(core);
      const d = diffScriptLists(before, after);
      const changes = [...d.added.map((s) => `script nuovo: "${s.scriptName}" (${s.scriptIdPart})`), ...d.removed.map((s) => `script sparito: "${s.scriptName}" (${s.scriptIdPart})`), ...d.changed.map((s) => `script modificato: "${s.before.scriptName}" (${s.scriptIdPart}) ${s.before.version} -> ${s.version}`)];
      if (changes.length) alarm(`salvataggio fallito (${pageError(err)}) ma l'elenco script e' cambiato`, changes);
      else say(`Salvataggio rifiutato da TradingView: ${pageError(err)}\nNessuno script e' stato modificato.`);
      return 1;
    }
    const v = await readVerified((after) => plan.scriptStep === 'create' ? verifyCreate(before, after, name) : verifyUpdate(before, after, script.scriptIdPart));
    const wrongId = res.id && v.script && v.script.scriptIdPart !== res.id;
    if (!v.ok || wrongId) {
      alarm('verifica dell\'elenco script fallita dopo il salvataggio', [...v.problems, ...(wrongId ? [`il salvataggio ha restituito ${res.id}, l'elenco ${v.script.scriptIdPart}`] : [])]);
      return 1;
    }
    saved = v.script;
    say(`Script salvato: "${saved.scriptName}" ${saved.scriptIdPart} v${saved.version}. Nessun altro script modificato.`);
    if (!res.success) {
      const onChart = (snap?.chart.studies ?? []).filter((s) => s.pineId === saved.scriptIdPart);
      say(`Lo script e' stato salvato ma TradingView segnala errori di compilazione:\n  ${res.errors.join('\n  ')}`);
      say(onChart.length
        ? `TradingView porta comunque a questa versione ${onChart.map((s) => s.id).join(', ')} sul grafico, che mostrera' l'errore: correggi meteo-livelli.pine e riesegui npm run tv-setup -- --update.`
        : 'Non lo aggiungo al grafico.');
      return 1;
    }
  }

  if (willUpgrade) {
    snap ??= await snapshot();
    const targets = studiesToUpgrade(snap.chart.studies, saved.scriptIdPart, saved.version);
    if (targets.length) {
      say(`Porto "${name}" alla v${saved.version} sul grafico ${snap.chart.symbol}: ${targets.map((s) => `${s.id} v${s.version}`).join(', ')}...`);
      const res = await upgradeOnChart(core, saved, { name, before: snap.chart, inputs: snap.inputs, prevVersion: plan.scriptStep === 'update' ? script.version : null });
      for (const n of res.notes) say(`  ${n}`);
      if (res.problems.length) {
        alarm('aggiornamento sul grafico non confermato', res.problems, `Lo script e' salvato (v${saved.version}). Riesegui npm run tv-setup -- --update: aggiorna solo gli studi rimasti indietro.\nIn alternativa togli "${name}" dal grafico e riaggiungilo con npm run tv-setup -- --apply.`);
        return 1;
      }
      const left = res.chart.studies.length - res.upgraded.length;
      say(`Verifica: un solo "${name}" (${res.upgraded.map((s) => s.id).join(', ')}) alla v${saved.version}, livelli e meteo presenti, gli altri ${left} studi del grafico invariati.`);
    }
  }

  if (plan.chartStep === 'add') {
    say(`Aggiungo "${name}" al grafico ${state.symbol}...`);
    const res = await addToChart(core, saved, { name });
    if (res.problems.length) {
      alarm('aggiunta al grafico non confermata', res.problems, 'Controlla gli indicatori del grafico in TradingView.');
      return 1;
    }
    if (res.existed) say(`"${res.study.name}" e' comparso sul grafico nel frattempo (${res.study.id}): non lo aggiungo una seconda volta.`);
    else say(`Aggiunto: studio ${res.study.id} "${res.study.name}" (${res.study.pineId} v${res.study.version}). Gli altri studi sono intatti.`);
  }
  say('\nFatto: da ora tv-sync cambia solo gli input dell\'indicatore.');
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  const offline = /CDP connection failed/.test(err.message);
  console.error(`\nERRORE: ${offline ? 'TradingView non raggiungibile su 127.0.0.1:9222. Avvialo con scripts\\avvia-tradingview.ps1' : pageError(err)}`);
} finally {
  await core.connection.disconnect().catch(() => {});
}
process.exit(code);
