'use strict';

// ---------- timeframe del grafico (ricordato per chi guarda) ----------
const TFS = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '4h', '1d'];
const TF_KEY = 'meteo.tf';

function loadTf() {
  try {
    const v = localStorage.getItem(TF_KEY);
    return TFS.includes(v) ? v : '1m';
  } catch { return '1m'; }
}
function saveTf(tf) {
  try { localStorage.setItem(TF_KEY, tf); } catch { /* storage non disponibile: vale solo per questa pagina */ }
}

const state = { assets: [], selected: null, detail: null, chart: null, candles: null, cvdLine: null, priceLines: [], detailTimer: null, tf: loadTf(), detailCtl: null, needsFit: false, rev: null, lastT: null };

// ---------- formattazione ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 3 : 5;
  return v.toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
// Livelli nelle card: niente decimali sopra 1000, cosi' due prezzi stanno in una cella.
function fmtLevel(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  return v.toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtUsd(v, signed = false) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const [d, s] = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  const sign = v < 0 ? '−' : signed ? '+' : '';
  return `${sign}$${(abs / d).toFixed(abs >= 1e3 ? 1 : 0)}${s}`;
}
function fmtQty(v, signed = false) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const s = abs >= 1e6 ? `${(abs / 1e6).toFixed(2)}M` : abs >= 1e3 ? `${(abs / 1e3).toFixed(1)}K` : abs.toFixed(abs >= 10 ? 0 : 2);
  return `${v < 0 ? '−' : signed ? '+' : ''}${s}`;
}
const pctFrom = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null);
const fmtPct = (v) => v.toLocaleString('it-IT', { maximumFractionDigits: 2 });
const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const fmtWhen = (ts) => new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (ts) => { const s = Math.round((Date.now() - ts) / 1000); return s < 90 ? `${s}s fa` : `${Math.round(s / 60)}m fa`; };

// ---------- token di colore (unica fonte: le custom property in styles.css) ----------
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// '#rrggbb' -> 'rgba(r,g,b,a)'; i token usati dai canvas sono hex proprio per questo.
function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function tokens() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return {
    buy: v('--buy'), sell: v('--sell'), accent: v('--accent'), poc: v('--poc'), flip: v('--flip'),
    ink1: v('--ink-1'), ink2: v('--ink-2'), ink3: v('--ink-3'),
    hairline: v('--hairline'), hairlineStrong: v('--hairline-strong'),
    surface1: v('--surface-1'), surface3: v('--surface-3'), font: v('--font'),
  };
}

// ---------- icone meteo (colori dai token via classi CSS) ----------
const ICONS = {
  sereno: `<svg viewBox="0 0 64 64" class="wx-icon" aria-hidden="true"><circle class="sun" cx="32" cy="32" r="12"/><g class="ray" stroke-width="3.5" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => { const r = (a * Math.PI) / 180; return `<line x1="${32 + Math.cos(r) * 18}" y1="${32 + Math.sin(r) * 18}" x2="${32 + Math.cos(r) * 25}" y2="${32 + Math.sin(r) * 25}"/>`; }).join('')}</g></svg>`,
  variabile: `<svg viewBox="0 0 64 64" class="wx-icon" aria-hidden="true"><circle class="sun" cx="24" cy="24" r="10"/><path class="cloud" d="M20 46h26a9 9 0 0 0 0-18 13 13 0 0 0-25 3 7.5 7.5 0 0 0-1 15z"/></svg>`,
  temporale: `<svg viewBox="0 0 64 64" class="wx-icon" aria-hidden="true"><path class="cloud-dark" d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 3 8.5 8.5 0 0 0-3 17z"/><path class="bolt" d="M33 36l-7 13h7l-4 11 12-16h-7l5-8z"/></svg>`,
};
const WX_TEXT = { sereno: 'Sereno', variabile: 'Variabile', temporale: 'Temporale' };

// ---------- card ----------
// Testo stabile (niente valori live): il tooltip non cambia a ogni aggiornamento. I valori sono nel dettaglio.
function pressureTip(bp, band) {
  const base = `Quota della liquidità in acquisto (bid) rispetto a quella in vendita (ask) esposta nel book entro ±${band}% dal prezzo, media mobile su ~${bp?.smoothingSec ?? 30} s. Sopra 50% = più ordini in acquisto sotto il prezzo che in vendita sopra. Segnale debole: gli ordini esposti possono essere ritirati.`;
  if (!bp) return `${base} Book in sincronizzazione.`;
  return [
    base,
    bp.covered ? null : 'Parte della banda è oltre lo snapshot di Binance (1000 livelli per lato): lì i livelli sono ricostruiti dagli aggiornamenti.',
    bp.synced ? null : 'Book in risincronizzazione: valore fermo all\'ultimo campione.',
  ].filter(Boolean).join(' ');
}

function cardHtml(a) {
  const r = a.regime;
  const g = a.gex && !a.gex.error ? a.gex : null;
  const flipDist = g ? pctFrom(a.price, g.flip) : null;
  const cvd = a.cvdTrend;
  const bp = a.bookPressure;
  const band = fmtPct(bp?.bandPct ?? 0.25);
  const activeZones = a.zones.filter((z) => z.status === 'attiva').slice(0, 4);
  const cvdPct = cvd.ratio * 100;
  const cvdClass = cvd.direction === 'acquisti' ? 'pos' : cvd.direction === 'vendite' ? 'neg' : '';
  // Il valore della pressione resta in inchiostro: il colore lo porta il meter, il triangolo segnala gli estremi.
  const bpLean = bp == null || !bp.synced ? '' : bp.smooth >= 0.65 ? '<i class="lean up" aria-hidden="true"></i>' : bp.smooth <= 0.35 ? '<i class="lean down" aria-hidden="true"></i>' : '';
  const steps = r.checklist ?? [];
  const done = steps.filter((c) => c.ok).length;
  const focus = steps.find((c) => !c.ok) ?? steps.at(-1);
  const signedPct = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`;
  return `
    <div class="c-head">
      <div class="c-id">
        <div class="c-asset"><span class="c-sym">${esc(a.asset)}</span><span class="c-label">${esc(a.label)}</span></div>
        <div class="c-price">${fmtPrice(a.price)}</div>
        ${a.stale || !a.feed.connected ? '<div class="stale">⚠ feed in ritardo / disconnesso</div>' : ''}
      </div>
      <div class="wx">
        <div class="wx-main"><span class="wx-label">${WX_TEXT[r.weather]}</span>${ICONS[r.weather]}</div>
        <div class="wx-chips"><span class="chip">${esc(r.model)}</span><span class="chip bias ${esc(r.bias)}">${esc(r.bias)}</span></div>
      </div>
    </div>
    <div class="c-sec">
      <div class="sec-head"><span class="sec-k">Gamma</span></div>
      <div class="gamma">
        <div class="gex">
          <div class="gex-v ${g ? signClass(g.total) : 'muted'}">${g ? fmtUsd(g.total, true) : a.gex?.error ? 'errore' : '…'}</div>
          <div class="gex-k">GEX netto · $/1%</div>
        </div>
        <dl class="lv">
          <div><dt><i class="key flip"></i>Flip</dt><dd>${g ? fmtLevel(g.flip) : '—'}${flipDist != null ? `<span class="dist">${signedPct(flipDist)}</span>` : ''}</dd></div>
          <div><dt><i class="key buy"></i>Call wall</dt><dd>${g ? fmtLevel(g.callWall) : '—'}</dd></div>
          <div><dt><i class="key sell"></i>Put wall</dt><dd>${g ? fmtLevel(g.putWall) : '—'}</dd></div>
        </dl>
      </div>
    </div>
    <div class="c-sec">
      <div class="sec-head"><span class="sec-k">Orderflow</span></div>
      <div class="metrics">
        <div class="m"><div class="m-k">Delta sessione</div><div class="m-v ${signClass(a.session.delta)}">${fmtQty(a.session.delta, true)}</div><div class="meter blank" aria-hidden="true"></div></div>
        <div class="m"><div class="m-k">CVD ${cvd.minutes}m</div><div class="m-v ${cvdClass}">${signedPct(cvdPct)}${cvd.divergence ? '<span class="flag" title="Divergenza prezzo/delta">◆ div.</span>' : ''}</div>
          <div class="meter" aria-hidden="true"><span class="mid"></span><span style="left:${cvd.ratio >= 0 ? 50 : 50 + Math.max(-50, cvdPct)}%;width:${Math.min(50, Math.abs(cvdPct))}%;background:${cvd.ratio >= 0 ? 'var(--buy)' : 'var(--sell)'}"></span></div></div>
        <div class="m" title="${esc(pressureTip(bp, band))}"><div class="m-k">Pressione ±${band}%</div><div class="m-v${bp && !bp.synced ? ' muted' : ''}">${bp == null ? '—' : `${(bp.smooth * 100).toFixed(0)}%<span class="unit">bid</span>${bpLean}`}</div>
          <div class="meter${bp ? ' split' : ''}${bp && !bp.synced ? ' stale' : ''}" aria-hidden="true"><span class="fill" style="left:0;width:${bp == null ? 0 : bp.smooth * 100}%;background:var(--buy)"></span><span class="mid"></span></div></div>
      </div>
    </div>
    <div class="c-sec">
      <div class="sec-head"><span class="sec-k">Profilo</span><span class="chip">${esc(a.profile.location ?? '—')} VA</span></div>
      <div class="metrics">
        <div class="m"><div class="m-k"><i class="key poc"></i>POC</div><div class="m-v">${fmtLevel(a.profile.poc)}</div></div>
        <div class="m"><div class="m-k">VAL</div><div class="m-v">${fmtLevel(a.profile.val)}</div></div>
        <div class="m"><div class="m-k">VAH</div><div class="m-v">${fmtLevel(a.profile.vah)}</div></div>
      </div>
    </div>
    <div class="c-spark">
      <div class="sec-head"><span class="sec-k">CVD · ultime 2 ore</span></div>
      <canvas class="spark" data-asset="${esc(a.asset)}" role="img" aria-label="CVD ultime 2 ore"></canvas>
    </div>
    <div class="c-sec">
      <div class="sec-head"><span class="sec-k">Checklist Valentini</span><span class="sec-aside">${done}/${steps.length}</span></div>
      <ol class="steps">
        ${steps.map((c) => `<li class="step ${c.ok ? 'ok' : 'ko'}" title="${esc(c.text)}"><span class="step-bar" aria-hidden="true"></span><span class="step-name"><span class="step-ico" aria-hidden="true">${c.ok ? '✓' : '○'}</span>${esc(c.step)}</span><span class="sr-only">: ${c.ok ? 'soddisfatto' : 'non soddisfatto'}. ${esc(c.text)}</span></li>`).join('')}
      </ol>
      ${focus ? `<p class="step-note" aria-hidden="true"><b>${esc(focus.step)}</b>${esc(focus.text)}</p>` : ''}
    </div>
    ${activeZones.length ? `<div class="zones-mini">${activeZones.map((z) => `<span class="zone-chip ${esc(z.side)}" title="${esc(z.kind)} · lato ${esc(z.side)} · eseguito ${fmtUsd(z.executedUsd)} · ${z.ratio.toFixed(1)}× la size visibile">${z.kind === 'iceberg' ? 'Iceberg' : 'Assorb.'} <b>${fmtLevel(z.price)}</b></span>`).join('')}</div>` : ''}
  `;
}

// CVD della card: linea 2px, velo d'area al 10%, linea dello zero in hairline, punto finale con anello.
function drawSpark(canvas, values) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (!values || values.length < 2) return;
  const t = tokens();
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const y = (v) => h - 5 - ((v - min) / span) * (h - 10);
  const x = (i) => 1 + (i / (values.length - 1)) * (w - 8);
  const last = values[values.length - 1];
  const color = last >= 0 ? t.buy : t.sell;
  const y0 = Math.round(y(0)) + 0.5;
  ctx.strokeStyle = t.hairlineStrong;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.stroke();
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.lineTo(x(values.length - 1), y0);
  ctx.lineTo(x(0), y0);
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.1);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x(values.length - 1), y(last), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = t.surface1;
  ctx.stroke();
}

// Aggiorna in place: i nodi restano gli stessi, cosi' hover e tooltip non si chiudono a ogni giro.
function patchChildren(target, source) {
  const prev = [...target.childNodes];
  const next = [...source.childNodes];
  if (prev.length !== next.length) { target.replaceChildren(...next); return; }
  next.forEach((n, i) => {
    const o = prev[i];
    if (o.nodeName !== n.nodeName) o.replaceWith(n);
    else if (n.nodeType !== Node.ELEMENT_NODE) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; }
    else if (o.nodeName !== 'CANVAS') {
      for (const { name } of [...o.attributes]) if (!n.hasAttribute(name)) o.removeAttribute(name);
      for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
      patchChildren(o, n);
    }
  });
}

function renderCards() {
  const root = document.getElementById('cards');
  for (const a of state.assets) {
    let el = root.querySelector(`[data-card="${a.asset}"]`);
    if (!el) {
      el = document.createElement('article');
      el.dataset.card = a.asset;
      el.tabIndex = 0;
      root.appendChild(el);
    }
    el.className = `card ${a.regime.weather}${state.selected === a.asset ? ' selected' : ''}`;
    const tpl = document.createElement('template');
    tpl.innerHTML = cardHtml(a);
    patchChildren(el, tpl.content);
    drawSpark(el.querySelector('.spark'), a.cvdSpark);
  }
}

// ---------- dettaglio ----------
function ensureChart() {
  if (state.chart || !window.LightweightCharts) return;
  const el = document.getElementById('chart');
  const t = tokens();
  const cross = { color: withAlpha(t.ink3, 0.45), labelBackgroundColor: t.surface3 };
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: t.ink3, fontSize: 11, fontFamily: t.font },
    grid: { vertLines: { color: t.hairline }, horzLines: { color: t.hairline } },
    rightPriceScale: { borderColor: t.hairlineStrong, scaleMargins: { top: 0.06, bottom: 0.3 } },
    timeScale: { borderColor: t.hairlineStrong, timeVisible: state.tf !== '1d', secondsVisible: false },
    crosshair: { mode: 0, vertLine: cross, horzLine: cross },
  });
  state.candles = chart.addCandlestickSeries({ upColor: t.buy, downColor: t.sell, wickUpColor: t.buy, wickDownColor: t.sell, borderVisible: false });
  state.cvdLine = chart.addLineSeries({ priceScaleId: 'cvd', color: t.accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  chart.priceScale('cvd').applyOptions({ scaleMargins: { top: 0.75, bottom: 0.02 } });
  state.chart = chart;
}

// Colore (nome del token CSS) e stile di linea dei livelli sul grafico.
const LEVEL_STYLE = {
  VAH: ['--ink-2', 2], VAL: ['--ink-2', 2], POC: ['--poc', 0], LVN: ['--ink-3', 1],
  'Gamma flip': ['--flip', 0], 'Call wall': ['--buy', 0], 'Put wall': ['--sell', 0], Iceberg: ['--accent', 2], Assorbimento: ['--accent', 1],
};

function renderDetail(d) {
  ensureChart();
  document.getElementById('d-title').textContent = `${d.asset} · ${WX_TEXT[d.regime.weather]} · ${d.regime.model}`;
  const g = d.gex && !d.gex.error ? d.gex : null;
  document.getElementById('d-sub').textContent = [
    `${d.symbol} ${fmtPrice(d.price)}`,
    g ? `GEX ${fmtUsd(g.total, true)} · DEX ${fmtUsd(g.dex, true)} · P/C OI ${g.putCallOi?.toFixed(2) ?? '—'} · opzioni ${g.optionCount} · agg. ${ago(g.updatedAt)}${g.delayed ? ' (ritardato)' : ''}${g.proxy ? ` · proxy ${g.proxy}` : ''}` : d.gex?.error ? `GEX non disponibile: ${d.gex.error}` : 'GEX in caricamento',
    d.profile.approximated ? 'profilo: storico da candele 1m + live' : 'profilo: live',
    d.external ? `Hermes: GEX ${fmtUsd(d.external.total, true)} (${ago(d.external.receivedAt)})` : null,
  ].filter(Boolean).join(' · ');

  // Un server non ancora aggiornato ignora ?tf e risponde a 1m: il titolo segue la risposta.
  const tf = d.tf ?? '1m';
  setChartTitle(tf, d.cvdMode ?? cvdModeOf(tf));
  const note = document.getElementById('chart-note');
  const gap = d.historyGap ? `, mancano quelle fra ${fmtWhen(d.historyGap.from)} e ${fmtWhen(d.historyGap.to)}` : '';
  note.hidden = !d.historyError;
  note.textContent = !d.historyError ? ''
    : d.historyAt ? `Storico Binance non aggiornato (${d.historyError}): candele chiuse lette il ${fmtWhen(d.historyAt)}${gap}.`
    : `Storico Binance non disponibile (${d.historyError}): solo le candele delle ultime ~25 ore, ricostruite dai dati 1m.`;

  if (state.candles) {
    const candle = (b) => ({ time: b.t / 1000, open: b.o, high: b.h, low: b.l, close: b.c });
    const cvd = (b) => ({ time: b.t / 1000, value: b.cvd });
    // Risposta parziale: solo le candele da lastT in poi, aggiornate in coda; altrimenti la serie intera.
    const full = d.full !== false;
    if (full) {
      state.candles.setData(d.bars.map(candle));
      state.cvdLine.setData(d.bars.map(cvd));
    } else {
      for (const b of d.bars) { state.candles.update(candle(b)); state.cvdLine.update(cvd(b)); }
    }
    state.rev = d.rev ?? null;
    state.lastT = d.bars.at(-1)?.t ?? (full ? null : state.lastT);
    // Dopo un cambio si inquadrano le ultime candele; se lo storico manca, una seconda volta quando arriva.
    if (state.needsFit && full && d.bars.length && (state.needsFit === true || !d.historyError)) {
      state.needsFit = d.historyError ? 'storico' : false;
      state.chart.applyOptions({ timeScale: { timeVisible: tf !== '1d' } });
      // Ultime ~150 candele, meno su schermi stretti (circa 4 px per candela).
      const n = d.bars.length;
      const show = Math.min(150, Math.max(40, Math.round(document.getElementById('chart').clientWidth / 4)));
      state.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - show), to: n + 2 });
    }
    for (const pl of state.priceLines) state.candles.removePriceLine(pl);
    state.priceLines = d.regime.levels.map((l) => {
      const [token, style] = LEVEL_STYLE[l.name] ?? ['--ink-3', 2];
      return state.candles.createPriceLine({ price: l.price, color: cssVar(token), lineWidth: l.name === 'Gamma flip' ? 2 : 1, lineStyle: style, axisLabelVisible: true, title: l.name });
    });
  }

  drawGex(document.getElementById('gex-canvas'), d.gexByStrike ?? [], d.price, g);
  drawProfile(document.getElementById('vp-canvas'), d.profile, d.price);
  drawDepth(document.getElementById('depth-canvas'), d.depth, d.bookPressure);
  document.getElementById('depth-note').textContent = depthNote(d.depth, d.bookPressure);

  document.getElementById('d-reasons').innerHTML = d.regime.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
  document.getElementById('d-zones').innerHTML = d.zones.length
    ? `<table><thead><tr><th class="n">Prezzo</th><th>Tipo</th><th>Lato</th><th class="n">Eseguito</th><th class="n">×vis.</th><th>Stato</th></tr></thead><tbody>${d.zones.map((z) => `<tr><td class="n">${fmtPrice(z.price)}</td><td>${esc(z.kind)}</td><td><span class="side ${z.side === 'bid' ? 'buy' : 'sell'}">${esc(z.side)}</span></td><td class="n">${fmtUsd(z.executedUsd)}</td><td class="n">${z.ratio.toFixed(1)}</td><td class="${z.status === 'attiva' ? '' : 'dim'}">${esc(z.status)}</td></tr>`).join('')}</tbody></table>`
    : '<p>Nessuna zona rilevata nella sessione. Le zone compaiono quando a un prezzo viene eseguito molto più di quanto il book mostra, senza che il livello venga rotto.</p>';
  document.getElementById('d-big').innerHTML = d.bigTrades.length
    ? `<table><thead><tr><th>Ora</th><th>Lato</th><th class="n">Prezzo</th><th class="n">Valore</th></tr></thead><tbody>${d.bigTrades.map((t) => `<tr><td>${new Date(t.ts).toLocaleTimeString('it-IT')}</td><td><span class="side ${t.side === 'buy' ? 'buy' : 'sell'}">${t.side === 'buy' ? 'acquisto' : 'vendita'}</span></td><td class="n">${fmtPrice(t.price)}</td><td class="n">${fmtUsd(t.usd)}</td></tr>`).join('')}</tbody></table>`
    : '<p>Nessun big trade sopra soglia.</p>';
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = `500 10.5px ${cssVar('--font') || 'system-ui, sans-serif'}`;
  ctx.textBaseline = 'alphabetic';
  return { ctx, w, h };
}

// Barra orizzontale: estremo dati arrotondato, lato della baseline squadrato.
function hbar(ctx, x0, yc, len, bh, dir = 1) {
  if (len <= 0 || bh <= 0) return;
  const r = Math.min(3, bh / 2, len);
  const x = dir > 0 ? x0 : x0 - len;
  ctx.beginPath();
  if (ctx.roundRect && r >= 1) ctx.roundRect(x, yc - bh / 2, len, bh, dir > 0 ? [0, r, r, 0] : [r, 0, 0, r]);
  else ctx.rect(x, yc - bh / 2, len, bh);
  ctx.fill();
}

// Etichetta di una linea di riferimento: testo in inchiostro su una piastrina del colore di superficie.
function tag(ctx, t, text, x, yb, ink) {
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = withAlpha(t.surface1, 0.88);
  ctx.fillRect(x - 3, yb - 10, tw + 6, 13);
  ctx.fillStyle = ink;
  ctx.fillText(text, x, yb);
}

// Linea di riferimento orizzontale (tratteggio = soglia/livello, non griglia).
function refLine(ctx, x0, x1, yy, color, dash) {
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(x0, Math.round(yy) + 0.5); ctx.lineTo(x1, Math.round(yy) + 0.5); ctx.stroke();
  ctx.setLineDash([]);
}

function emptyState(ctx, t, text) { ctx.fillStyle = t.ink3; ctx.fillText(text, 8, 20); }

function drawGex(canvas, rows, price, g) {
  const { ctx, w, h } = setupCanvas(canvas);
  const t = tokens();
  if (!rows.length) { emptyState(ctx, t, 'Dati opzioni non ancora disponibili'); return; }
  const sorted = [...rows].sort((a, b) => b.strike - a.strike);
  const hi = sorted[0].strike;
  const lo = sorted[sorted.length - 1].strike;
  const span = hi - lo || 1;
  const left = 64;
  const mid = Math.round(left + (w - left - 6) / 2) + 0.5;
  const maxAbs = Math.max(...sorted.map((r) => Math.abs(r.net))) || 1;
  const y = (p) => 8 + ((hi - p) / span) * (h - 16);
  const barH = Math.max(2, Math.min(14, (h - 16) / sorted.length - 1));
  ctx.strokeStyle = t.hairlineStrong;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mid, 0); ctx.lineTo(mid, h); ctx.stroke();
  // Strike non uniformi: un'etichetta solo se c'e' spazio dalla precedente (i wall sempre).
  let lastLabelY = -Infinity;
  for (const r of sorted) {
    const yy = y(r.strike);
    const len = (Math.abs(r.net) / maxAbs) * ((w - left - 6) / 2);
    ctx.fillStyle = r.net >= 0 ? t.buy : t.sell;
    hbar(ctx, r.net >= 0 ? mid + 0.5 : mid - 0.5, yy, len, barH, r.net >= 0 ? 1 : -1);
    const wall = r.strike === g?.callWall || r.strike === g?.putWall;
    if (wall || (barH >= 7 && yy - lastLabelY >= 11)) {
      ctx.fillStyle = wall ? t.ink1 : t.ink3;
      ctx.fillText(fmtPrice(r.strike), 4, yy + 3.5);
      lastLabelY = yy;
    }
  }
  const mark = (p, color, label, ink) => {
    if (p == null || p < lo || p > hi) return;
    refLine(ctx, left, w, y(p), color, [4, 3]);
    tag(ctx, t, label, w - ctx.measureText(label).width - 4, y(p) - 3, ink);
  };
  mark(price, t.ink1, `spot ${fmtPrice(price)}`, t.ink1);
  if (g) mark(g.flip, t.flip, `flip ${fmtPrice(g.flip)}`, t.ink2);
}

function drawProfile(canvas, profile, price) {
  const { ctx, w, h } = setupCanvas(canvas);
  const t = tokens();
  const rows = profile.rows ?? [];
  if (!rows.length) { emptyState(ctx, t, 'Profilo in costruzione'); return; }
  const hi = rows[rows.length - 1][0];
  const lo = rows[0][0];
  const span = hi - lo || 1;
  const left = 64;
  const maxVol = Math.max(...rows.map((r) => r[1] + r[2])) || 1;
  const y = (p) => 8 + ((hi - p) / span) * (h - 16);
  const barH = Math.max(1, (h - 16) / rows.length - 0.5);
  if (profile.vah != null) {
    ctx.fillStyle = withAlpha(t.accent, 0.08);
    ctx.fillRect(left, y(profile.vah) - barH, w - left, y(profile.val) - y(profile.vah) + barH * 2);
  }
  ctx.strokeStyle = t.hairlineStrong;
  ctx.beginPath(); ctx.moveTo(left - 0.5, 0); ctx.lineTo(left - 0.5, h); ctx.stroke();
  for (const [p, buy, sell] of rows) {
    const total = ((buy + sell) / maxVol) * (w - left - 6);
    const buyLen = total * (buy / (buy + sell || 1));
    // 1 px di superficie fra acquisti e vendite quando le barre sono abbastanza larghe.
    const gap = buyLen > 3 && total - buyLen > 3 ? 1 : 0;
    ctx.fillStyle = withAlpha(t.buy, 0.85);
    ctx.fillRect(left, y(p) - barH / 2, buyLen - gap, barH);
    ctx.fillStyle = withAlpha(t.sell, 0.85);
    hbar(ctx, left + buyLen + gap, y(p), total - buyLen - gap, barH, 1);
  }
  const mark = (p, color, label, ink) => {
    if (p == null) return;
    refLine(ctx, left, w, y(p), color, [4, 3]);
    tag(ctx, t, `${label} ${fmtPrice(p)}`, 2, y(p) + 3.5, ink);
  };
  mark(profile.vah, t.ink2, 'VAH', t.ink2);
  mark(profile.val, t.ink2, 'VAL', t.ink2);
  mark(profile.poc, t.poc, 'POC', t.ink1);
  mark(price, t.ink1, '▶', t.ink1);
}

const outsideExact = (depth, p) => (depth.exactLow != null && p < depth.exactLow) || (depth.exactHigh != null && p > depth.exactHigh);

// Nozionale esposto per fascia: bid sotto il mid (acquisti), ask sopra (vendite).
function drawDepth(canvas, depth, bp) {
  const { ctx, w, h } = setupCanvas(canvas);
  const t = tokens();
  if (!depth) { emptyState(ctx, t, 'Book in sincronizzazione…'); return; }
  const n = depth.bids.length;
  const hi = depth.mid + depth.step * n;
  const lo = depth.mid - depth.step * n;
  const left = 64;
  const y = (p) => 8 + ((hi - p) / (hi - lo)) * (h - 16);
  const maxUsd = Math.max(...depth.bids, ...depth.asks) || 1;
  const barH = Math.max(1, (h - 16) / (2 * n) - 1);
  ctx.strokeStyle = t.hairline;
  ctx.lineWidth = 1;
  const every = Math.max(1, Math.round(n / 4));
  for (let k = every; k <= n; k += every) {
    for (const p of [depth.mid + k * depth.step, depth.mid - k * depth.step]) {
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(w, yy); ctx.stroke();
      ctx.fillStyle = t.ink3;
      ctx.fillText(fmtPrice(p), 4, y(p) + 3.5);
    }
  }
  const bar = (usd, i, side) => {
    const center = depth.mid + (side === 'bid' ? -1 : 1) * (i + 0.5) * depth.step;
    ctx.globalAlpha = outsideExact(depth, center) ? 0.3 : 0.85;
    ctx.fillStyle = side === 'bid' ? t.buy : t.sell;
    hbar(ctx, left, y(center), (usd / maxUsd) * (w - left - 6), barH, 1);
  };
  depth.bids.forEach((usd, i) => bar(usd, i, 'bid'));
  depth.asks.forEach((usd, i) => bar(usd, i, 'ask'));
  ctx.globalAlpha = 1;
  const mark = (p, color, label, dash, ink) => {
    if (p == null || p < lo || p > hi) return;
    refLine(ctx, left, w, y(p), color, dash);
    if (label) tag(ctx, t, label, w - ctx.measureText(label).width - 4, y(p) - 3, ink);
  };
  if (bp) {
    const band = depth.mid * (bp.bandPct / 100);
    mark(depth.mid + band, t.accent, `+${fmtPct(bp.bandPct)}%`, [4, 3], t.ink2);
    mark(depth.mid - band, t.accent, `−${fmtPct(bp.bandPct)}%`, [4, 3], t.ink2);
  }
  mark(depth.exactHigh, t.ink3, '', [1, 3]);
  mark(depth.exactLow, t.ink3, '', [1, 3]);
  mark(depth.mid, t.ink1, `mid ${fmtPrice(depth.mid)}`, [4, 3], t.ink1);
}

function depthNote(depth, bp) {
  const band = fmtPct(bp?.bandPct ?? 0.25);
  const parts = [`Pressione book = quota in $ dei bid su bid + ask entro ±${band}% dal prezzo, media ~${bp?.smoothingSec ?? 30} s: sopra 50% prevalgono gli ordini in acquisto, sotto 50% quelli in vendita.`];
  if (bp) parts.push(`Ora: bid ${fmtUsd(bp.bidUsd)}, ask ${fmtUsd(bp.askUsd)}, istantaneo ${(bp.raw * 100).toFixed(0)}% bid${bp.synced ? '' : ' (fermo: book in risincronizzazione)'}.`);
  if (!depth) return parts.join(' ');
  parts.push(`Fasce da ${fmtPrice(depth.step)} (${fmtPct((depth.step / depth.mid) * 100)}%), barra più lunga ${fmtUsd(Math.max(...depth.bids, ...depth.asks))}.`);
  const n = depth.bids.length;
  if (outsideExact(depth, depth.mid - n * depth.step) || outsideExact(depth, depth.mid + n * depth.step)) {
    parts.push('Linea punteggiata: limite dello snapshot di Binance (1000 livelli); oltre, barre chiare con i soli livelli noti dagli aggiornamenti (possono mancare ordini fermi).');
  }
  return parts.join(' ');
}

const cvdModeOf = (tf) => (tf === '4h' || tf === '1d' ? 'cumulativo' : 'giornaliero');

function setChartTitle(tf, mode) {
  document.getElementById('chart-title').textContent = `Prezzo ${tf} · CVD ${mode}`;
}

function renderTfButtons() {
  for (const b of document.querySelectorAll('#tf-select [data-tf]')) b.setAttribute('aria-pressed', String(b.dataset.tf === state.tf));
}

// Cambio di asset o timeframe: si annulla la richiesta in corso e si svuota il grafico,
// cosi' non restano a schermo candele dell'asset o del timeframe precedente.
function resetChart() {
  state.detailCtl?.abort();
  state.detailCtl = null;
  state.needsFit = true;
  state.rev = null;
  state.lastT = null;
  const note = document.getElementById('chart-note');
  note.hidden = true;
  note.textContent = '';
  if (!state.chart) return;
  state.candles.setData([]);
  state.cvdLine.setData([]);
  for (const pl of state.priceLines) state.candles.removePriceLine(pl);
  state.priceLines = [];
}

// Una richiesta alla volta: il poll salta il giro se la precedente e' ancora in corso, e una
// risposta arrivata dopo un cambio di asset o timeframe viene scartata.
async function loadDetail({ reset = false } = {}) {
  if (!state.selected || (state.detailCtl && !reset)) return;
  if (reset) resetChart();
  const ctl = new AbortController();
  state.detailCtl = ctl;
  const { selected: asset, tf } = state;
  // Con una serie gia' a schermo si chiedono solo le candele da lastT in poi.
  const since = state.rev && state.lastT ? `&since=${state.lastT}&rev=${encodeURIComponent(state.rev)}` : '';
  try {
    const res = await fetch(`/api/snapshot/${asset}?tf=${tf}${since}`, { signal: ctl.signal });
    const d = res.ok ? await res.json() : null;
    if (d && state.detailCtl === ctl && state.selected === asset && state.tf === tf) renderDetail(d);
  } catch {
    // Annullata o errore di rete: il prossimo giro riprova, con la serie intera se l'errore e' di questa richiesta.
    if (state.detailCtl === ctl) state.rev = null;
  } finally {
    if (state.detailCtl === ctl) state.detailCtl = null;
  }
}

function selectTf(tf) {
  if (!TFS.includes(tf) || tf === state.tf) return;
  state.tf = tf;
  saveTf(tf);
  renderTfButtons();
  setChartTitle(tf, cvdModeOf(tf));
  if (state.selected) loadDetail({ reset: true });
}

// Cambio di asset: via intestazione e pannelli del precedente finche' non arriva la nuova risposta.
function clearDetail(asset) {
  document.getElementById('d-title').textContent = `${asset} · …`;
  document.getElementById('d-sub').textContent = 'Caricamento…';
  for (const id of ['gex-canvas', 'vp-canvas', 'depth-canvas']) setupCanvas(document.getElementById(id));
  for (const id of ['depth-note', 'd-reasons', 'd-zones', 'd-big']) document.getElementById(id).replaceChildren();
}

function selectAsset(asset) {
  const detail = document.getElementById('detail');
  if (state.selected === asset) { closeDetail(); return; }
  state.selected = asset;
  detail.hidden = false;
  clearDetail(asset);
  clearInterval(state.detailTimer);
  loadDetail({ reset: true });
  state.detailTimer = setInterval(loadDetail, 2000);
  renderCards();
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  detail.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
}

function closeDetail() {
  state.selected = null;
  clearInterval(state.detailTimer);
  state.detailCtl?.abort();
  state.detailCtl = null;
  document.getElementById('detail').hidden = true;
  renderCards();
}

// ---------- eventi e stream ----------
document.getElementById('cards').addEventListener('click', (e) => {
  const card = e.target.closest('[data-card]');
  if (card) selectAsset(card.dataset.card);
});
document.getElementById('cards').addEventListener('keydown', (e) => {
  const card = e.target.closest('[data-card]');
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectAsset(card.dataset.card); }
});
document.getElementById('close-detail').addEventListener('click', closeDetail);
document.getElementById('tf-select').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tf]');
  if (btn) selectTf(btn.dataset.tf);
});
renderTfButtons();
setChartTitle(state.tf, cvdModeOf(state.tf));
document.getElementById('copy-levels').addEventListener('click', async (e) => {
  if (!state.selected) return;
  const res = await fetch(`/api/levels/${state.selected}`);
  const { pine } = await res.json();
  try {
    await navigator.clipboard.writeText(pine);
    e.target.textContent = 'Copiato ✔';
  } catch {
    window.prompt('Copia questi livelli nell\'indicatore "Meteo Livelli":', pine);
  }
  setTimeout(() => { e.target.textContent = 'Copia livelli per TradingView'; }, 1800);
});

function setConn(on, text) {
  document.getElementById('conn-dot').classList.toggle('on', on);
  document.getElementById('conn-text').textContent = text;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`);
  ws.onopen = () => setConn(true, 'Live');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'summary') { state.assets = msg.assets; renderCards(); }
  };
  ws.onclose = () => { setConn(false, 'Riconnessione…'); setTimeout(connect, 2000); };
}

setInterval(() => { document.getElementById('clock').textContent = new Date().toLocaleTimeString('it-IT'); }, 1000);
fetch('/api/snapshot').then((r) => r.json()).then((a) => { state.assets = a; renderCards(); }).catch(() => {});
connect();
