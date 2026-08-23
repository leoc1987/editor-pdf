/* Editor de PDF — DPCI. 100% local: pdf.js (render) + pdf-lib (manipulação).
   Interface no padrão visual PCI/GO (ver DESIGN.md). */
'use strict';

const pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
const { PDFDocument, StandardFonts, rgb } = PDFLib;

/* ---------- estado ---------- */
let sources = {};        // tag -> { name, bytes, pdfjsDoc }
let pages = [];          // [{ src: tag, idx: int, overlays: [] }]
let cur = -1;            // página aberta no visor
let mainRender = null;   // tarefa de renderização em curso
let tagSeq = 0;

/* ---------- util ---------- */
const $ = s => document.querySelector(s);
const holder = $('#canvasHolder'), canvas = $('#mainCanvas'),
      ctx = canvas.getContext('2d'), overlay = $('#overlay'), hint = $('#hint');
let view = { scale: 1 }; // viewport atual da página aberta

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- toast flutuante (um por vez) ---------- */
function toast(msg, kind) {
  document.querySelectorAll('.epdf-toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'epdf-toast' + (kind === 'warn' ? ' warn' : '');
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.remove(), kind === 'warn' ? 3500 : 2000);
}

/* ---------- diálogo próprio (substitui alert/confirm/prompt nativos) ---------- */
/* modo 'confirm': sem campo, devolve true/false · modo 'prompt' (padrão): devolve texto ou null */
function appDialog({ title, message = '', placeholder = '', mode = 'prompt', okLabel = 'Confirmar' }) {
  return new Promise(resolve => {
    const isConfirm = mode === 'confirm';
    const bd = document.createElement('div');
    bd.id = 'epdf-dialog-backdrop';
    bd.innerHTML = `
      <div id="epdf-dialog" role="dialog" aria-modal="true" aria-label="${escapeHTML(title)}">
        <div id="epdf-dialog-title">${escapeHTML(title)}</div>
        ${message ? `<div id="epdf-dialog-msg">${escapeHTML(message)}</div>` : ''}
        ${isConfirm ? '' : '<input id="epdf-dialog-input" class="field" placeholder="' + escapeHTML(placeholder) + '">'}
        <div class="actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancelar</button>
          <button type="button" class="btn btn-primary" data-act="ok">${escapeHTML(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const input = bd.querySelector('#epdf-dialog-input');
    const dlg = bd.querySelector('#epdf-dialog');

    function close(result) { bd.remove(); document.removeEventListener('keydown', onKey, true); resolve(result); }
    function accept() { close(isConfirm ? true : ((input?.value.trim()) || null)); }
    function onKey(e) {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') { e.preventDefault(); accept(); }
    }
    function onClick(e) {
      if (e.target.closest('[data-act="ok"]')) accept();
      else if (e.target.closest('[data-act="cancel"]') || e.target === bd) close(false);
    }
    document.addEventListener('keydown', onKey, true);
    dlg.addEventListener('click', onClick);
    setTimeout(() => (input || dlg.querySelector('[data-act="ok"]')).focus(), 0);
  });
}

async function readAsBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/* ---------- carregamento ---------- */
async function addSource(name, bytes) {
  const tag = 's' + (++tagSeq);
  const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  sources[tag] = { name, bytes, pdfjsDoc };
  const start = pages.length;
  for (let i = 0; i < pdfjsDoc.numPages; i++)
    pages.push({ src: tag, idx: i, overlays: [] });
  return start; // índice da 1ª página nova
}

async function openFiles(fileList, replace) {
  const files = [...fileList].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) return toast('Selecione um arquivo PDF.', 'warn');
  if (replace) { sources = {}; pages = []; }
  try {
    for (const f of files) {
      const start = await addSource(f.name, await readAsBytes(f));
      if (replace || pages.length === start) { cur = start; }
    }
    $('#emptyMsg').hidden = true;
    holder.hidden = false;
    $('#viewBar').hidden = false;
    buildThumbs();
    await show(cur);
    toast(files.length === 1 ? `${files[0].name}: ${pages.length} pág.` : `${files.length} arquivos juntados.`);
  } catch (e) {
    console.error(e);
    toast('Não foi possível abrir este arquivo. Ele pode estar danificado.', 'warn');
  }
}

/* ---------- miniaturas ---------- */
function buildThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  pages.forEach((p, i) => box.appendChild(makeThumb(p, i)));
}

function makeThumb(p, i) {
  const d = document.createElement('div');
  d.className = 'thumb' + (i === cur ? ' selected' : '');
  d.draggable = true;
  d.dataset.i = i;

  const num = document.createElement('span');
  num.className = 'num'; num.textContent = i + 1;
  d.appendChild(num);

  if (p.overlays.some(o => o.type === 'rect')) {
    const b = document.createElement('span');
    b.className = 'badge'; b.title = 'Esta página tem trecho coberto por tarja';
    b.textContent = 'tarja';
    d.appendChild(b);
  }

  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '✕';
  del.title = 'Excluir página'; del.setAttribute('aria-label', `Excluir página ${i + 1}`);
  del.onclick = ev => { ev.stopPropagation(); deletePage(i); };
  d.appendChild(del);

  const c = document.createElement('canvas');
  d.appendChild(c);

  d.onclick = () => show(i);
  d.addEventListener('dragstart', ev => ev.dataTransfer.setData('text/plain', String(i)));
  d.addEventListener('dragover', ev => { ev.preventDefault(); d.classList.add('drag-over'); });
  d.addEventListener('dragleave', () => d.classList.remove('drag-over'));
  d.addEventListener('drop', ev => {
    ev.preventDefault(); d.classList.remove('drag-over');
    const from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(from) && from !== i) movePage(from, i);
  });

  const src = sources[p.src];
  src.pdfjsDoc.getPage(p.idx + 1).then(pg =>
    pg.render({
      canvasContext: c.getContext('2d'),
      viewport: pg.getViewport({ scale: 160 / pg.getViewport({ scale: 1 }).width })
    }).promise
  );
  return d;
}

function refreshThumb(i) {
  const box = $('#thumbs');
  if (box.children[i]) box.replaceChild(makeThumb(pages[i], i), box.children[i]);
}

/* ---------- operações de página ---------- */
async function deletePage(i) {
  const ok = await appDialog({
    title: 'Excluir página',
    message: `A página ${i + 1} será retirada do documento. O arquivo original no seu computador não é alterado.`,
    mode: 'confirm',
    okLabel: 'Excluir página'
  });
  if (!ok) return;
  pages.splice(i, 1);
  if (!pages.length) { cur = -1; holder.hidden = true; $('#viewBar').hidden = true; $('#emptyMsg').hidden = false; }
  else if (cur >= pages.length) cur = pages.length - 1;
  else if (cur > i) cur--;
  buildThumbs();
  if (cur >= 0) show(cur);
}

function movePage(from, to) {
  const [p] = pages.splice(from, 1);
  pages.splice(to, 0, p);
  cur = to;
  buildThumbs();
  show(to);
}

async function addBlankPage() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]); // A4
  const start = await addSource('em branco', await doc.save());
  cur = pages.length - 1;
  $('#emptyMsg').hidden = true; holder.hidden = false;
  $('#viewBar').hidden = false;
  buildThumbs();
  show(cur);
  toast('Página em branco adicionada ao final.');
}

/* ---------- visualizador ---------- */
const MIN_ZOOM = .25, MAX_ZOOM = 5, ZOOM_STEP = 1.2;
let fitMode = 'page'; // padrão: página inteira visível ('page' | 'width' | null = zoom manual)

function availSize() {
  const area = $('#pageArea');
  return { w: Math.max(80, area.clientWidth - 40), h: Math.max(80, area.clientHeight - 36) };
}

/* aplica o modo de ajuste atual (largura / página inteira) */
async function applyFit(pg) {
  const raw = pg.getViewport({ scale: 1 });
  const { w, h } = availSize();
  if (fitMode === 'width') {
    view.scale = Math.max(MIN_ZOOM, Math.min(w / raw.width, MAX_ZOOM));
  } else {
    view.scale = Math.max(MIN_ZOOM, Math.min(w / raw.width, h / raw.height, MAX_ZOOM));
    $('#pageArea').scrollTop = 0; $('#pageArea').scrollLeft = 0;
  }
}

async function show(i) {
  if (i < 0 || i >= pages.length) return;
  cur = i;
  [...$('#thumbs').children].forEach((el, k) => el.classList.toggle('selected', k === cur));
  const p = pages[cur];
  const pg = await sources[p.src].pdfjsDoc.getPage(p.idx + 1);
  await applyFit(pg);
  await renderMain(pg);
  syncZoomUI();
}

async function renderMain(pg) {
  if (mainRender) { try { mainRender.cancel(); } catch (_) {} }
  const vp = pg.getViewport({ scale: view.scale });
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = vp.width + 'px';
  canvas.style.height = vp.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mainRender = pg.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
  try { await mainRender.promise; } catch (_) {}
  drawOverlay();
}

async function setZoom(scale) {
  if (cur < 0) return;
  const p = pages[cur];
  const pg = await sources[p.src].pdfjsDoc.getPage(p.idx + 1);
  view.scale = Math.max(MIN_ZOOM, Math.min(scale, MAX_ZOOM));
  fitMode = null; // zoom manual desativa o ajuste automático
  await renderMain(pg);
  syncZoomUI();
}

/* reflete o estado na barra do rodapé */
function syncZoomUI() {
  const pct = Math.round(view.scale * 100);
  $('#btnZoomReset').textContent = pct + '%';
  $('#btnFitPage').classList.toggle('active', fitMode === 'page');
  $('#btnFitWidth').classList.toggle('active', fitMode === 'width');
}


/* desenha os elementos sobrepostos da página atual */
function drawOverlay() {
  overlay.innerHTML = '';
  const p = pages[cur]; if (!p) return;
  const s = view.scale;
  for (let k = 0; k < p.overlays.length; k++) {
    const o = p.overlays[k], el = document.createElement('div');
    el.dataset.k = k;
    if (o.type === 'rect') {
      el.className = 'rect';
      el.style.cssText += `left:${o.x * s}px;top:${o.y * s}px;width:${o.w * s}px;height:${o.h * s}px`;
    } else {
      el.className = 'txt'; el.textContent = o.text;
      el.style.cssText += `left:${o.x * s}px;top:${o.y * s}px;font-size:${o.size * s}px;font-weight:700`;
    }
    el.oncontextmenu = ev => {
      ev.preventDefault();
      removeOverlayAt(p, k);
    };
    overlay.appendChild(el);
  }
}

async function removeOverlayAt(p, k) {
  const ok = await appDialog({
    title: 'Remover elemento',
    message: 'O trecho marcado será retirado do documento.',
    mode: 'confirm',
    okLabel: 'Remover'
  });
  if (!ok) return;
  p.overlays.splice(k, 1);
  drawOverlay(); refreshThumb(cur);
}

/* ---------- ferramentas ---------- */
function activeTool() {
  if ($('#toolRedact').checked) return 'redact';
  if ($('#toolText').checked) return 'text';
  return null;
}
document.querySelectorAll('#toolbar input[name=tool]').forEach(r =>
  r.onchange = () => { overlay.style.cursor = activeTool() ? 'crosshair' : 'default'; });

let drag = null;
overlay.addEventListener('pointerdown', ev => {
  const tool = activeTool(); if (!tool) return;
  const r = overlay.getBoundingClientRect();
  const x = (ev.clientX - r.left) / view.scale, y = (ev.clientY - r.top) / view.scale;
  if (tool === 'redact') {
    drag = { type: 'rect', x0: x, y0: y, el: null };
    try { ev.target.setPointerCapture(ev.pointerId); } catch (_) {}
  } else if (tool === 'text') {
    insertTextAt(x, y);
  }
});

async function insertTextAt(x, y) {
  const txt = await appDialog({
    title: 'Inserir texto',
    message: 'Escreva o que deve aparecer neste ponto do documento (ex.: um carimbo ou uma correção).',
    placeholder: 'Texto a inserir'
  });
  if (!txt) return;
  pages[cur].overlays.push({ type: 'text', x, y, text: txt, size: 12 });
  drawOverlay(); refreshThumb(cur);
}

overlay.addEventListener('pointermove', ev => {
  if (!drag) return;
  const r = overlay.getBoundingClientRect();
  const x = (ev.clientX - r.left) / view.scale, y = (ev.clientY - r.top) / view.scale;
  const nx = Math.min(drag.x0, x), ny = Math.min(drag.y0, y);
  const w = Math.abs(x - drag.x0), h = Math.abs(y - drag.y0);
  if (!drag.el) {
    drag.el = document.createElement('div');
    drag.el.className = 'rect rubber';
    overlay.appendChild(drag.el);
  }
  drag.el.style.cssText = `left:${nx * view.scale}px;top:${ny * view.scale}px;width:${w * view.scale}px;height:${h * view.scale}px`;
  drag.box = { x: nx, y: ny, w, h };
});
overlay.addEventListener('pointerup', () => {
  if (!drag) return;
  const b = drag.box;
  drag.el?.remove();
  if (b && b.w > .02 * canvas.width / view.scale / 5 && b.w > 2) { // mínimo visível
    pages[cur].overlays.push({ type: 'rect', ...b });
    drawOverlay();
    refreshThumb(cur);
  }
  drag = null;
});

/* ---------- exportação ---------- */
async function buildOutputPdf(burnRects) {
  const out = await PDFDocument.create();
  const cache = {};
  for (let i = 0; i < pages.length; i++) {
    const rec = pages[i];
    if (!cache[rec.src]) cache[rec.src] = await PDFDocument.load(sources[rec.src].bytes, { ignoreEncryption: true });

    const needsBurn = burnRects && rec.overlays.some(o => o.type === 'rect');
    let page, W, H;
    // elementos que ainda precisam ser desenhados por cima (tarjas definitivas
    // são assadas no raster e NÃO consomem o estado — reexportar continua seguro)
    const drawList = needsBurn ? rec.overlays.filter(o => o.type !== 'rect') : rec.overlays;

    if (needsBurn) {
      // TARJA DEFINITIVA: página NOVA contendo apenas o raster — o texto
      // original nem entra no arquivo gerado (nada para copiar/selecionar)
      const jpg = await rasterizePage(rec);
      const img = await out.embedJpg(jpg);
      const pj = await sources[rec.src].pdfjsDoc.getPage(rec.idx + 1);
      const v1 = pj.getViewport({ scale: 1 });
      W = v1.width; H = v1.height;
      page = out.addPage([W, H]);
      page.drawImage(img, { x: 0, y: 0, width: W, height: H });
    } else {
      const [copied] = await out.copyPages(cache[rec.src], [rec.idx]);
      page = out.addPage(copied);
      W = page.getWidth(); H = page.getHeight();
    }

    const helv = helvCache ||= (await out.embedFont(StandardFonts.HelveticaBold));
    for (const o of drawList) {
      if (o.type === 'rect')
        page.drawRectangle({ x: o.x, y: H - o.y - o.h, width: o.w, height: o.h, color: rgb(.066, .066, .066) });
      else
        page.drawText(o.text, { x: o.x, y: H - o.y - o.size, size: o.size, font: helv, color: rgb(0, 0, 0) });
    }
  }
  // useObjectStreams:false => máxima compatibilidade com visualizadores antigos
  return out.save({ useObjectStreams: false });
}
let helvCache = null;

/* renderiza a página via pdf.js em alta resolução e devolve JPEG (bytes) */
async function rasterizePage(rec) {
  const pg = await sources[rec.src].pdfjsDoc.getPage(rec.idx + 1);
  const S = 2; // ~144 dpi
  const vp = pg.getViewport({ scale: S });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;

  // desenha as tarjas por cima do raster (coordenadas pt -> px)
  const g = c.getContext('2d');
  for (const o of rec.overlays) {
    if (o.type !== 'rect') continue;
    g.fillStyle = '#111';
    g.fillRect(o.x * S, o.y * S, o.w * S, o.h * S);
  }
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', .92));
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportPdf() {
  if (!pages.length) return toast('Abra um PDF antes de exportar.', 'warn');
  const burn = $('#chkBurn').checked;
  try {
    toast('Gerando PDF…');
    const bytes = await buildOutputPdf(burn);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = 'editado.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('PDF exportado.' + (burn ? ' As tarjas foram aplicadas em definitivo.' : ''));
  } catch (e) {
    console.error(e);
    toast('Não foi possível gerar o PDF. Tente novamente.', 'warn');
  }
}

/* ---------- eventos ---------- */
$('#fileOpen').onchange = e => openFiles(e.target.files, true) | (e.target.value = '');
$('#fileMerge').onchange = e => openFiles(e.target.files, false) | (e.target.value = '');
$('#btnBlank').onclick = addBlankPage;
$('#btnExport').onclick = exportPdf;

/* barra de visualização (rodapé) */
$('#btnFitPage').onclick = () => { if (cur >= 0) { fitMode = 'page'; show(cur); } };
$('#btnFitWidth').onclick = () => { if (cur >= 0) { fitMode = 'width'; show(cur); } };
$('#btnZoomIn').onclick = () => setZoom(view.scale * ZOOM_STEP);
$('#btnZoomOut').onclick = () => setZoom(view.scale / ZOOM_STEP);
$('#btnZoomReset').onclick = () => setZoom(1);

window.addEventListener('resize', () => {
  if (cur < 0) return;
  if (fitMode === null) return; // zoom manual não é alterado pelo redimensionamento
  show(cur);
});
