/* Editor de PDF — DPCI. 100% local: pdf.js (render) + pdf-lib (manipulação).
   Interface no padrão visual PCI/GO (ver DESIGN.md). */
'use strict';

const pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
const { PDFDocument, StandardFonts, rgb, BlendMode } = PDFLib;

/* ---------- estado ---------- */
let sources = {};        // tag -> { name, bytes, pdfjsDoc }
let pages = [];          // [{ src: tag, idx: int, overlays: [] }]
let cur = -1;            // página aberta no visor
let mainRender = null;   // tarefa de renderização em curso
let renderSeq = 0;       // só o pedido mais recente pode desenhar no canvas
let tagSeq = 0;

/* ---------- util ---------- */
const $ = s => document.querySelector(s);
const holder = $('#canvasHolder'), canvas = $('#mainCanvas'),
      ctx = canvas.getContext('2d'), overlay = $('#overlay'), hint = $('#hint'),
      textLayer = $('#textLayer');
let view = { scale: 1 }; // viewport atual da página aberta

const tamanhoLegivel = b => b >= 1048576
  ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB'
  : Math.max(1, Math.round(b / 1024)) + ' KB';

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
/* modo 'confirm': sem campo, devolve true/false · modo 'prompt' (padrão): devolve texto ou null.
   Com `naoPerguntar` (rótulo da caixa), confirmar com a caixa marcada devolve 'sempre'
   em vez de true — quem chamou decide o que faz com isso. */
function appDialog({ title, message = '', placeholder = '', value = '', mode = 'prompt',
                     okLabel = 'Confirmar', naoPerguntar = '' }) {
  return new Promise(resolve => {
    const isConfirm = mode === 'confirm';
    const bd = document.createElement('div');
    bd.id = 'epdf-dialog-backdrop';
    bd.innerHTML = `
      <div id="epdf-dialog" role="dialog" aria-modal="true" aria-label="${escapeHTML(title)}">
        <div id="epdf-dialog-title">${escapeHTML(title)}</div>
        ${message ? `<div id="epdf-dialog-msg">${escapeHTML(message)}</div>` : ''}
        ${isConfirm ? '' : '<input id="epdf-dialog-input" class="field" placeholder="' + escapeHTML(placeholder) + '">'}
        ${naoPerguntar ? `<label id="epdf-dialog-again">
          <input type="checkbox" id="epdf-dialog-again-box">${escapeHTML(naoPerguntar)}</label>` : ''}
        <div class="actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancelar</button>
          <button type="button" class="btn btn-primary" data-act="ok">${escapeHTML(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const input = bd.querySelector('#epdf-dialog-input');
    const dlg = bd.querySelector('#epdf-dialog');
    if (input) input.value = value;

    function close(result) { bd.remove(); document.removeEventListener('keydown', onKey, true); resolve(result); }
    const caixa = bd.querySelector('#epdf-dialog-again-box');
    function accept() {
      close(isConfirm ? (caixa?.checked ? 'sempre' : true) : ((input?.value.trim()) || null));
    }
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
    setTimeout(() => {
      const alvo = input || dlg.querySelector('[data-act="ok"]');
      alvo.focus();
      if (input && input.value) input.select(); // editar: o texto atual já vem marcado
    }, 0);
  });
}

async function readAsBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/* alguns sistemas entregam o PDF sem o type preenchido — a extensão decide */
const ehPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/* ---------- carregamento ---------- */
/* `at` omitido => acrescenta no final; com valor, insere naquela posição.
   `docPronto` evita reabrir o arquivo que a fila do "Juntar PDFs" já leu. */
async function addSource(name, bytes, at, docPronto) {
  const tag = 's' + (++tagSeq);
  const pdfjsDoc = docPronto || await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  sources[tag] = { name, bytes, pdfjsDoc };
  const novas = [];
  for (let i = 0; i < pdfjsDoc.numPages; i++) novas.push({ src: tag, idx: i, overlays: [] });
  const start = at == null ? pages.length : Math.max(0, Math.min(at, pages.length));
  pages.splice(start, 0, ...novas);
  return start; // índice da 1ª página nova
}

function mostrarEditor() {
  $('#emptyMsg').hidden = true;
  holder.hidden = false;
  $('#viewBar').hidden = false;
}

async function openFiles(fileList, replace) {
  const files = [...fileList].filter(ehPdf);
  if (!files.length) return toast('Selecione um arquivo PDF.', 'warn');
  if (replace) { sources = {}; pages = []; }
  try {
    for (const f of files) {
      const start = await addSource(f.name, await readAsBytes(f));
      if (replace || pages.length === start) { cur = start; }
    }
    mostrarEditor();
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

  // a miniatura avisa o que a página já recebeu, sem precisar abri-la
  for (const [tipo, rotulo, dica] of [
    ['rect', 'tarja', 'Esta página tem trecho coberto por tarja'],
    ['mark', 'destaque', 'Esta página tem trecho destacado em amarelo']]) {
    if (!p.overlays.some(o => o.type === tipo)) continue;
    const b = document.createElement('span');
    b.className = 'badge badge-' + tipo;
    b.title = dica;
    b.textContent = rotulo;
    d.appendChild(b);
  }

  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '✕';
  del.title = 'Excluir página'; del.setAttribute('aria-label', `Excluir página ${i + 1}`);
  del.onclick = ev => { ev.stopPropagation(); deletePage(i); };
  d.appendChild(del);

  const add = document.createElement('button');
  add.className = 'add'; add.textContent = '+';
  add.title = 'Inserir página aqui';
  add.setAttribute('aria-label', `Inserir página depois da página ${i + 1}`);
  add.setAttribute('aria-haspopup', 'menu');
  add.onclick = ev => { ev.stopPropagation(); openInsertMenu(add, i + 1); };
  d.appendChild(add);

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
  src.pdfjsDoc.getPage(p.idx + 1).then(pg => {
    const vp = pg.getViewport({ scale: 160 / pg.getViewport({ scale: 1 }).width });
    const dpr = window.devicePixelRatio || 1;
    // sem definir width/height o canvas fica no padrão 300x150 (paisagem): a
    // miniatura saía achatada e com a página cortada
    c.width = Math.round(vp.width * dpr);
    c.height = Math.round(vp.height * dpr);
    return pg.render({
      canvasContext: c.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
    }).promise;
  });
  return d;
}

function refreshThumb(i) {
  const box = $('#thumbs');
  if (box.children[i]) box.replaceChild(makeThumb(pages[i], i), box.children[i]);
}

/* ---------- operações de página ---------- */
/* desligada pela caixa do diálogo; volta ao normal quando a página é recarregada */
let confirmarExclusao = true;

async function deletePage(i) {
  if (confirmarExclusao) {
    const ok = await appDialog({
      title: 'Excluir página',
      message: `A página ${i + 1} será retirada do documento. O arquivo original no seu computador não é alterado.`,
      mode: 'confirm',
      okLabel: 'Excluir página',
      naoPerguntar: 'Não perguntar de novo nesta sessão'
    });
    if (!ok) return;
    if (ok === 'sempre') confirmarExclusao = false;
  }
  pages.splice(i, 1);
  if (!pages.length) { cur = -1; holder.hidden = true; $('#viewBar').hidden = true; $('#emptyMsg').hidden = false; }
  else if (cur >= pages.length) cur = pages.length - 1;
  else if (cur > i) cur--;
  buildThumbs();
  if (cur >= 0) show(cur);
  toast(`Página ${i + 1} excluída.`);
}

function movePage(from, to) {
  const [p] = pages.splice(from, 1);
  pages.splice(to, 0, p);
  cur = to;
  buildThumbs();
  show(to);
}

async function insertBlankAt(at) {
  const noFim = at >= pages.length;
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]); // A4
  cur = await addSource('em branco', await doc.save(), at);
  mostrarEditor();
  buildThumbs();
  await show(cur);
  toast(noFim ? 'Página em branco adicionada ao final.'
              : `Página em branco inserida na posição ${cur + 1}.`);
}

const addBlankPage = () => insertBlankAt(pages.length);

/* páginas de outro PDF inseridas a partir da posição `at` */
async function insertPdfAt(fileList, at) {
  const files = [...fileList].filter(ehPdf);
  if (!files.length) return toast('Selecione um arquivo PDF.', 'warn');
  try {
    let pos = at, total = 0;
    for (const f of files) {
      const start = await addSource(f.name, await readAsBytes(f), pos);
      const n = sources[pages[start].src].pdfjsDoc.numPages;
      pos = start + n;
      total += n;
    }
    cur = at;
    mostrarEditor();
    buildThumbs();
    await show(cur);
    toast(total === 1 ? '1 página inserida.' : `${total} páginas inseridas.`);
  } catch (e) {
    console.error(e);
    toast('Não foi possível abrir este arquivo. Ele pode estar danificado.', 'warn');
  }
}

/* ---------- menu do "+" (inserir página) ---------- */
let insertAt = null; // posição pendente enquanto o seletor de arquivo está aberto

function openInsertMenu(anchor, at) {
  $('#epdf-menu-backdrop')?.remove();
  const bd = document.createElement('div');
  bd.id = 'epdf-menu-backdrop';
  bd.innerHTML = `
    <div id="epdf-menu" role="menu" aria-label="Inserir página">
      <button type="button" role="menuitem" data-act="blank">Página em branco</button>
      <button type="button" role="menuitem" data-act="pdf">Páginas de outro PDF…</button>
    </div>`;
  document.body.appendChild(bd);

  // posiciona junto ao "+", sem deixar o menu sair da tela
  const menu = bd.querySelector('#epdf-menu');
  menu.style.visibility = 'hidden';
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - mw / 2, innerWidth - mw - 8)) + 'px';
  menu.style.top = (r.bottom + 6 + mh > innerHeight - 8 ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + 'px';
  menu.style.visibility = '';

  function close() { bd.remove(); document.removeEventListener('keydown', onKey, true); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  document.addEventListener('keydown', onKey, true);
  bd.onclick = ev => {
    const b = ev.target.closest('[data-act]');
    close();
    if (!b) return;                                  // clique fora fecha
    if (b.dataset.act === 'blank') insertBlankAt(at);
    else { insertAt = at; $('#fileInsert').click(); }
  };
  menu.querySelector('button').focus();
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
  sel = null;
  [...$('#thumbs').children].forEach((el, k) => el.classList.toggle('selected', k === cur));
  const p = pages[cur];
  const pg = await sources[p.src].pdfjsDoc.getPage(p.idx + 1);
  await applyFit(pg);
  await renderMain(pg);
  syncZoomUI();
  syncHint();
}

async function renderMain(pg) {
  const meu = ++renderSeq;

  // Só o pedido mais recente desenha: segurando a seta de página, as trocas
  // intermediárias são descartadas em vez de renderizadas uma a uma. A tarefa
  // anterior é cancelada E esperada antes de tocar no canvas — o pdf.js recusa
  // dois render() simultâneos no mesmo canvas.
  const anterior = mainRender;
  if (anterior) {
    try { anterior.cancel(); } catch (_) {}
    try { await anterior.promise; } catch (_) {}
  }
  if (meu !== renderSeq) return; // um pedido mais novo assumiu; este desiste

  const vp = pg.getViewport({ scale: view.scale });
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(vp.width * dpr);
  canvas.height = Math.round(vp.height * dpr);
  canvas.style.width = vp.width + 'px';
  canvas.style.height = vp.height + 'px';
  // Atenção: NÃO aplicar a escala do dpr aqui. O pdf.js MULTIPLICA o `transform`
  // abaixo pela matriz corrente do contexto (ele nunca a zera). Fazer os dois
  // desenhava a página em dpr² — em tela Retina (dpr 2) o conteúdo saía com o
  // dobro do tamanho do canvas e só aparecia o quadrante superior esquerdo.
  const tarefa = pg.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
  mainRender = tarefa;
  try { await tarefa.promise; } catch (_) { return; } // cancelada: quem cancelou redesenha
  if (meu !== renderSeq) return;
  mainRender = null;
  drawOverlay();
  montarCamadaTexto(pg, vp, meu);   // em paralelo: o destaque pode esperar o texto
}

/* Camada de texto do pdf.js: spans transparentes alinhados ao desenho da página.
   É o que permite SELECIONAR o texto do documento para destacar, em vez de
   arrastar uma caixa à mão. O pdf.js 3.x dimensiona esses spans por
   `var(--scale-factor)`, então a variável tem de acompanhar o zoom. */
async function montarCamadaTexto(pg, vp, meu) {
  textLayer.innerHTML = '';
  textLayer.style.setProperty('--scale-factor', view.scale);
  if (typeof pdfjsLib.renderTextLayer !== 'function') return;  // build sem camada de texto
  try {
    const tc = await pg.getTextContent();
    if (meu !== renderSeq) return;
    await pdfjsLib.renderTextLayer({ textContentSource: tc, container: textLayer, viewport: vp }).promise;
    if (meu !== renderSeq) { textLayer.innerHTML = ''; return; }
    esconderMarcadores();
    syncHint();        // só agora se sabe se esta página tem texto para ajustar o destaque
  } catch (_) {
    textLayer.innerHTML = '';   // sem camada de texto o modo caixa continua valendo
  }
}

/* O Diário Oficial embute marcadores invisíveis (<#ABC#…>, branco de 2pt) para
   delimitar cada matéria. Eles não são conteúdo: fora da seleção do usuário. */
function esconderMarcadores() {
  for (const el of textLayer.querySelectorAll('span'))
    if (el.textContent.includes('<#')) el.style.display = 'none';
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
  $('#pageInfo').textContent = `Página ${cur + 1} de ${pages.length}`;
  $('#btnZoomReset').textContent = pct + '%';
  $('#btnFitPage').classList.toggle('active', fitMode === 'page');
  $('#btnFitWidth').classList.toggle('active', fitMode === 'width');
}


/* ---------- elementos sobrepostos: selecionar, mover, redimensionar ---------- */
/* Clicar num elemento já inserido NUNCA cria outro por cima: ele fica
   selecionado, com moldura, alça para redimensionar e ✕ / Del para excluir. */
let sel = null;                 // índice do overlay selecionado na página aberta
const MIN_RECT = 4;             // pt — tarja menor que isso some da vista
const MIN_FONT = 5, MAX_FONT = 200;
const LINE_H = 1.15;            // igual ao line-height de #overlay .txt

/* desenha os elementos sobrepostos da página atual */
function drawOverlay() {
  overlay.innerHTML = '';
  const p = pages[cur]; if (!p) return;
  if (sel != null && sel >= p.overlays.length) sel = null;
  const s = view.scale;
  for (let k = 0; k < p.overlays.length; k++) {
    const o = p.overlays[k], el = document.createElement('div');
    el.dataset.k = k;
    if (o.type === 'rect' || o.type === 'mark') {
      el.className = o.type === 'mark' ? 'mark' : 'rect';
      el.style.cssText += `left:${o.x * s}px;top:${o.y * s}px;width:${o.w * s}px;height:${o.h * s}px`;
    } else {
      el.className = 'txt'; el.textContent = o.text;
      el.style.cssText += `left:${o.x * s}px;top:${o.y * s}px;font-size:${o.size * s}px;font-weight:700`;
    }
    el.oncontextmenu = ev => {
      ev.preventDefault();
      removeOverlayAt(p, k);
    };
    if (k === sel) {
      el.classList.add('sel');
      decorarSelecionado(el, o);
    }
    overlay.appendChild(el);
  }
}

/* moldura do selecionado: ✕ exclui · alça (canto ↘) redimensiona */
function decorarSelecionado(el, o) {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'itemDel';
  del.textContent = '✕';
  del.title = 'Excluir este elemento (tecla Del)';
  del.setAttribute('aria-label', 'Excluir o elemento selecionado');
  del.addEventListener('pointerdown', ev => ev.stopPropagation()); // não inicia arrasto
  del.addEventListener('click', ev => { ev.stopPropagation(); deleteSelected(); });
  el.appendChild(del);

  const alca = document.createElement('div');
  alca.className = 'hnd';
  alca.title = o.type === 'text' ? 'Arraste para mudar o tamanho da letra'
             : o.type === 'mark' ? 'Arraste para redimensionar o destaque'
                                 : 'Arraste para redimensionar a tarja';
  el.appendChild(alca);
}

function selectOverlay(k) {
  sel = k;
  drawOverlay();
  syncHint();
}

/* Del/Backspace e o ✕ excluem na hora; o botão direito continua pedindo confirmação */
function deleteSelected() {
  const p = pages[cur]; if (!p || sel == null) return;
  const o = p.overlays[sel]; if (!o) return;
  p.overlays.splice(sel, 1);
  sel = null;
  drawOverlay(); refreshThumb(cur); syncHint();
  toast({ rect: 'Tarja excluída.', mark: 'Destaque excluído.', text: 'Texto excluído.' }[o.type]);
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
  if (sel === k) sel = null;
  else if (sel != null && sel > k) sel--;
  drawOverlay(); refreshThumb(cur); syncHint();
}

/* ---------- ferramentas ---------- */
function activeTool() {
  if ($('#toolRedact').checked) return 'redact';
  if ($('#toolMark').checked) return 'mark';
  if ($('#toolText').checked) return 'text';
  return null;
}

/* No modo Destaque o ponteiro pertence à camada de texto (para selecionar);
   nas demais ferramentas ele pertence ao overlay (para criar, mover, excluir). */
const temTexto = () => textLayer.querySelector('span') != null;

/* ---------- destaque ajustado às linhas de texto ---------- */
/* A camada de texto NÃO serve para selecionar com o mouse: a ordem do DOM que o
   pdf.js gera não acompanha a ordem de leitura das duas colunas do Diário —
   arrastar do título de uma portaria até o fim dela selecionava outro bloco da
   página. Ela é usada como RÉGUA: a caixa arrastada é recortada exatamente nas
   linhas de texto que ela cobre, e o resultado é o que se vê sendo arrastado. */
const MIN_DESTAQUE = 2;   // pt — abaixo disso a linha não foi tocada

/* posição de cada linha de texto da página, em pontos do PDF */
function linhasDeTexto() {
  const base = holder.getBoundingClientRect(), s = view.scale, saida = [];
  for (const el of textLayer.querySelectorAll('span')) {
    if (el.style.display === 'none' || !el.textContent.trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    saida.push({ x: (r.left - base.left) / s, y: (r.top - base.top) / s,
                 w: r.width / s, h: r.height / s });
  }
  return saida;
}

/* recorta a caixa arrastada nas linhas que ela cobre */
function destaquesDaCaixa(b) {
  const linhas = linhasDeTexto();
  if (!linhas.length) return [{ ...b }];          // página sem texto (escaneada): caixa crua
  const saida = [];
  for (const l of linhas) {
    const meio = l.y + l.h / 2;
    if (meio < b.y || meio > b.y + b.h) continue; // linha fora da faixa arrastada
    const x0 = Math.max(l.x, b.x), x1 = Math.min(l.x + l.w, b.x + b.w);
    if (x1 - x0 >= MIN_DESTAQUE) saida.push({ x: x0, y: l.y, w: x1 - x0, h: l.h });
  }
  return juntarEmLinhas(saida);
}

/* clique sem arrastar destaca a linha inteira sob o ponteiro */
function linhaNoPonto(x, y) {
  const l = linhasDeTexto().find(l => x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h);
  return l ? [{ ...l }] : [];
}

function aplicarDestaque(caixa, x0, y0) {
  if (cur < 0) return;
  const clique = !caixa || (caixa.w < 3 && caixa.h < 3);
  const novos = clique ? linhaNoPonto(x0, y0) : destaquesDaCaixa(caixa);
  if (!novos.length) return;
  for (const n of novos) pages[cur].overlays.push({ type: 'mark', ...n });
  sel = null;
  drawOverlay(); refreshThumb(cur); syncHint();
  toast(novos.length === 1 ? 'Trecho destacado.' : `${novos.length} linhas destacadas.`);
}

/* O navegador devolve um retângulo por fragmento de texto. Junta os da MESMA
   linha num só — sem nunca atravessar a calha entre as duas colunas do Diário:
   fragmentos separados por um vão largo continuam destaques distintos. */
function juntarEmLinhas(caixas) {
  const linhas = [];
  for (const c of [...caixas].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const vao = l => Math.max(l.h, c.h) * 1.2;
    const alvo = linhas.find(l =>
      Math.abs((l.y + l.h / 2) - (c.y + c.h / 2)) < Math.min(l.h, c.h) * .6 &&
      c.x <= l.x + l.w + vao(l) && c.x + c.w >= l.x - vao(l));
    if (!alvo) { linhas.push({ ...c }); continue; }
    const dir = Math.max(alvo.x + alvo.w, c.x + c.w), fim = Math.max(alvo.y + alvo.h, c.y + c.h);
    alvo.x = Math.min(alvo.x, c.x); alvo.y = Math.min(alvo.y, c.y);
    alvo.w = dir - alvo.x; alvo.h = fim - alvo.y;
  }
  return linhas;
}
document.querySelectorAll('#toolbar input[name=tool]').forEach(r =>
  r.onchange = () => {
    overlay.style.cursor = activeTool() ? 'crosshair' : 'default';
    syncHint();
  });

/* dica ao lado das ferramentas: explica o que dá para fazer agora */
function syncHint() {
  const o = sel != null ? pages[cur]?.overlays[sel] : null;
  if (o) {
    hint.textContent = { rect: 'Tarja selecionada', mark: 'Destaque selecionado',
                         text: 'Texto selecionado (duplo clique edita)' }[o.type] +
      ' · arraste para mover · alça ↘ redimensiona · Del exclui';
    return;
  }
  hint.textContent = {
    redact: 'Arraste sobre o trecho que deve ser ocultado.',
    mark: temTexto()
      ? 'Arraste sobre o trecho — o amarelo se ajusta às linhas · um clique destaca a linha inteira.'
      : 'Página sem texto (escaneada): arraste a caixa do destaque sobre o trecho.',
    text: 'Clique no ponto onde o texto deve entrar.'
  }[activeTool()] || '';
}

/* ---------- gestos sobre o documento ---------- */
let drag = null;
overlay.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;                       // o botão direito remove (contextmenu)
  const r = overlay.getBoundingClientRect();
  const x = (ev.clientX - r.left) / view.scale, y = (ev.clientY - r.top) / view.scale;
  const el = ev.target.closest('.txt, .rect:not(.rubber)');

  if (el) {
    const k = +el.dataset.k, o = pages[cur].overlays[k];
    if (ev.target.classList.contains('hnd')) {
      drag = { mode: 'size', o, el, x0: x, y0: y, w0: o.w, h0: o.h, size0: o.size };
    } else {
      if (k !== sel) selectOverlay(k);               // redesenha: o elemento antigo saiu do DOM
      drag = { mode: 'move', o, el: overlay.querySelector(`[data-k="${k}"]`), dx: x - o.x, dy: y - o.y };
    }
    overlay.setPointerCapture(ev.pointerId);
    ev.preventDefault();                             // não seleciona o texto da página
    return;
  }

  if (sel != null) selectOverlay(null);              // clique fora larga a seleção
  const tool = activeTool(); if (!tool) return;
  if (tool === 'redact' || tool === 'mark') {
    drag = { mode: 'rect', x0: x, y0: y, el: null, tipo: tool === 'mark' ? 'mark' : 'rect' };
    overlay.setPointerCapture(ev.pointerId);
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
  sel = pages[cur].overlays.length - 1;              // já entra selecionado, pronto para ajustar
  drawOverlay(); refreshThumb(cur); syncHint();
}

/* duplo clique corrige o texto sem precisar excluir e inserir de novo.
   O ouvinte fica no #overlay porque, com o ponteiro capturado por ele durante o
   arrasto, o duplo clique chega com o próprio overlay como alvo — quem estava
   sob o ponteiro é descoberto pela posição. */
overlay.addEventListener('dblclick', ev => {
  const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#overlay .txt');
  if (el) editTextAt(+el.dataset.k);
});

async function editTextAt(k) {
  const o = pages[cur]?.overlays[k];
  if (!o || o.type !== 'text') return;
  const txt = await appDialog({
    title: 'Editar texto',
    message: 'Altere o que aparece neste ponto do documento.',
    placeholder: 'Texto a inserir',
    value: o.text,
    okLabel: 'Salvar'
  });
  if (!txt || txt === o.text) return;
  o.text = txt;
  drawOverlay(); refreshThumb(cur);
}

overlay.addEventListener('pointermove', ev => {
  if (!drag) return;
  const r = overlay.getBoundingClientRect(), s = view.scale;
  const x = (ev.clientX - r.left) / s, y = (ev.clientY - r.top) / s;
  const o = drag.o;

  if (drag.mode === 'move') {
    o.x = Math.max(0, x - drag.dx);
    o.y = Math.max(0, y - drag.dy);
    drag.el.style.left = o.x * s + 'px';
    drag.el.style.top = o.y * s + 'px';
    drag.mexeu = true;
    return;
  }
  if (drag.mode === 'size') {
    if (o.type === 'rect' || o.type === 'mark') {
      o.w = Math.max(MIN_RECT, drag.w0 + (x - drag.x0));
      o.h = Math.max(MIN_RECT, drag.h0 + (y - drag.y0));
      drag.el.style.width = o.w * s + 'px';
      drag.el.style.height = o.h * s + 'px';
    } else {
      // a alça acompanha o ponteiro: a caixa do texto tem ~LINE_H vezes o corpo da letra
      o.size = Math.min(MAX_FONT, Math.max(MIN_FONT, drag.size0 + (y - drag.y0) / LINE_H));
      drag.el.style.fontSize = o.size * s + 'px';
    }
    drag.mexeu = true;
    return;
  }

  const nx = Math.min(drag.x0, x), ny = Math.min(drag.y0, y);
  const w = Math.abs(x - drag.x0), h = Math.abs(y - drag.y0);
  if (!drag.el) {
    drag.el = document.createElement('div');
    drag.el.className = drag.tipo === 'mark' ? 'mark rubber' : 'rect rubber';
    overlay.appendChild(drag.el);
  }
  drag.el.style.cssText = `left:${nx * s}px;top:${ny * s}px;width:${w * s}px;height:${h * s}px`;
  drag.box = { x: nx, y: ny, w, h };
});

function endDrag(ev) {
  if (!drag) return;
  const d = drag; drag = null;
  try { overlay.releasePointerCapture(ev.pointerId); } catch (_) {}

  if (d.mode === 'rect') {
    const b = d.box;
    d.el?.remove();
    if (d.tipo === 'mark') { aplicarDestaque(b, d.x0, d.y0); return; }
    if (b && b.w > .02 * canvas.width / view.scale / 5 && b.w > 2) { // mínimo visível
      pages[cur].overlays.push({ type: 'rect', ...b });
      sel = pages[cur].overlays.length - 1;
      drawOverlay(); refreshThumb(cur); syncHint();
    }
    return;
  }
  if (d.mexeu) { drawOverlay(); refreshThumb(cur); } // recoloca alça e ✕ na posição nova
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

/* ---------- exportação ---------- */
async function buildOutputPdf(burnRects) {
  const out = await PDFDocument.create();
  const precisaBurn = rec => burnRects && rec.overlays.some(o => o.type === 'rect');

  // Cada origem é copiada numa ÚNICA chamada de copyPages. O pdf-lib refaz a
  // cópia dos recursos a cada chamada: página a página, uma imagem usada por
  // várias páginas entrava uma vez POR PÁGINA e o arquivo saía múltiplas vezes
  // maior que a soma dos originais.
  const porOrigem = {};
  for (const rec of pages) {
    if (precisaBurn(rec)) continue;                // vira raster: não é copiada
    (porOrigem[rec.src] ||= []).push(rec.idx);
  }
  const copias = {};                               // tag -> Map(idx -> página copiada)
  for (const tag of Object.keys(porOrigem)) {
    const doc = await PDFDocument.load(sources[tag].bytes, { ignoreEncryption: true });
    const idxs = porOrigem[tag];
    const feitas = await out.copyPages(doc, idxs);
    copias[tag] = new Map(idxs.map((ix, n) => [ix, feitas[n]]));
  }

  for (let i = 0; i < pages.length; i++) {
    const rec = pages[i];
    const needsBurn = precisaBurn(rec);
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
      page = out.addPage(copias[rec.src].get(rec.idx));
      W = page.getWidth(); H = page.getHeight();
    }

    const helv = helvCache ||= (await out.embedFont(StandardFonts.HelveticaBold));
    for (const o of drawList) {
      if (o.type === 'mark')
        page.drawRectangle({ x: o.x, y: H - o.y - o.h, width: o.w, height: o.h,
                             color: rgb(1, .922, .231), blendMode: BlendMode.Multiply });
      else if (o.type === 'rect')
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
    toast(`PDF exportado (${tamanhoLegivel(bytes.length)}).` +
          (burn ? ' As tarjas foram aplicadas em definitivo.' : ''));
  } catch (e) {
    console.error(e);
    toast('Não foi possível gerar o PDF. Tente novamente.', 'warn');
  }
}

/* ---------- eventos ---------- */
$('#fileOpen').onchange = e => openFiles(e.target.files, true) | (e.target.value = '');
$('#fileMerge').onchange = e => filaAdicionar(e.target.files) | (e.target.value = '');
$('#fileInsert').onchange = e => {
  const at = insertAt ?? pages.length;
  insertAt = null;
  insertPdfAt(e.target.files, at);
  e.target.value = '';
};
$('#btnBlank').onclick = addBlankPage;
$('#btnExport').onclick = exportPdf;

/* barra de visualização (rodapé) */
$('#btnFitPage').onclick = () => { if (cur >= 0) { fitMode = 'page'; show(cur); } };
$('#btnFitWidth').onclick = () => { if (cur >= 0) { fitMode = 'width'; show(cur); } };
$('#btnZoomIn').onclick = () => setZoom(view.scale * ZOOM_STEP);
$('#btnZoomOut').onclick = () => setZoom(view.scale / ZOOM_STEP);
$('#btnZoomReset').onclick = () => setZoom(1);

/* setas da legenda de atalhos: mesma navegação do teclado */
$('#btnPrevPage').onclick = () => goToPage(cur - 1);
$('#btnNextPage').onclick = () => goToPage(cur + 1);

/* ---------- arrastar e soltar arquivos ---------- */
/* Solto em qualquer ponto da janela o arquivo é aceito; a área do documento
   acende para indicar o destino. Sem isso o navegador abriria o PDF solto e
   a edição em curso seria perdida. */
const dropZone = $('#pageArea');
let dragDepth = 0;

/* ignora o arrasto das miniaturas (que carrega text/plain, não arquivos) */
const isFileDrag = ev => [...(ev.dataTransfer?.types || [])].includes('Files');

function setDropHint(on) {
  if (!on) dragDepth = 0;
  dropZone.classList.toggle('drag-active', on);
}

window.addEventListener('dragenter', ev => {
  if (!isFileDrag(ev) || juntarAberto()) return;
  ev.preventDefault();
  if (++dragDepth === 1) setDropHint(true);
});
window.addEventListener('dragover', ev => { if (isFileDrag(ev)) ev.preventDefault(); });
window.addEventListener('dragleave', ev => {
  if (!isFileDrag(ev)) return;
  if (--dragDepth <= 0) setDropHint(false);
});
window.addEventListener('dragend', () => setDropHint(false));
window.addEventListener('drop', ev => {
  if (!isFileDrag(ev) || juntarAberto()) return;
  ev.preventDefault();
  setDropHint(false);
  dropFiles(ev.dataTransfer.files);
});

/* documento vazio: abre · documento em edição: confirma antes de juntar
   (substituir apagaria as tarjas e os textos já aplicados) */
async function dropFiles(fileList) {
  const files = [...fileList].filter(ehPdf);
  if (!files.length) return toast('Solte um arquivo PDF.', 'warn');
  if (!pages.length) return openFiles(files, true);

  const alvo = files.length === 1
    ? `“${files[0].name}” será adicionado`
    : `${files.length} arquivos serão adicionados`;
  const ok = await appDialog({
    title: 'Juntar ao documento',
    message: `${alvo} ao final do documento aberto (${pages.length} pág.). ` +
             'Para começar um documento novo, use “Abrir PDF” no topo da tela.',
    mode: 'confirm',
    okLabel: 'Juntar ao final'
  });
  if (ok) openFiles(files, false);
}

/* ---------- juntar PDFs: fila ordenável ---------- */
/* A ordem da lista é a ordem do documento final. O filtro serve só para achar um
   arquivo no meio de muitos: com ele ativo o reordenamento fica travado, senão a
   posição vista na tela não seria a posição real. */
let fila = [];          // [{ id, name, size, bytes, doc }]
let filaSeq = 0;
let ordemAZ = true;     // direção que o próximo clique em "Ordenar" aplica
let arrastandoId = null;

const mergeBack = $('#mergeBack');
const juntarAberto = () => !mergeBack.hidden;
/* numeric: "Laudo 2" vem antes de "Laudo 10"; sensitivity: acento e caixa não separam */
const colador = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const semAcento = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function juntarAbrir() {
  filaDescartar();
  ordemAZ = true;
  $('#mergeSearch').value = '';
  mergeBack.hidden = false;
  filaRender();
  $('#mergeDrop').focus();
}

/* fechar sem juntar devolve a memória dos arquivos que a fila tinha lido */
function filaDescartar() {
  for (const it of fila) { try { it.doc.destroy(); } catch (_) {} }
  fila = [];
}

function juntarFechar(descartar = true) {
  if (descartar) filaDescartar();
  mergeBack.hidden = true;
  $('#fileMerge').value = '';
}

async function filaAdicionar(fileList) {
  const files = [...fileList].filter(ehPdf);
  if (!files.length) return toast('Escolha arquivos PDF.', 'warn');
  let repetidos = 0, ruins = 0;
  for (const f of files) {
    if (fila.some(it => it.name === f.name && it.size === f.size)) { repetidos++; continue; }
    try {
      const bytes = await readAsBytes(f);
      // a cópia é obrigatória: o pdf.js assume o buffer e `bytes` ainda vai para a exportação
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      fila.push({ id: ++filaSeq, name: f.name, size: f.size, bytes, doc });
    } catch (e) { console.error(e); ruins++; }
  }
  filaRender();
  if (ruins) toast(`${ruins} arquivo(s) não puderam ser abertos.`, 'warn');
  else if (repetidos) toast(`${repetidos} arquivo(s) já estavam na lista.`, 'warn');
}

const plural = (n, um, muitos) => `${n} ${n === 1 ? um : muitos}`;

function filaRender() {
  const busca = $('#mergeSearch').value.trim();
  const filtrando = busca !== '';
  const vazia = !fila.length;
  const paginas = fila.reduce((n, it) => n + it.doc.numPages, 0);

  $('#mergeDrop').classList.toggle('compact', !vazia);
  $('#mergeDropTitulo').textContent = vazia ? 'Arraste aqui os PDFs para juntar' : '+ Adicionar mais PDFs';
  $('#mergeDropSub').hidden = !vazia;
  $('#mergeTools').hidden = vazia;
  $('#mergeCount').textContent = vazia ? ''
    : `${plural(fila.length, 'arquivo', 'arquivos')} · ${plural(paginas, 'página', 'páginas')}` +
      ` · ≈ ${tamanhoLegivel(tamanhoEstimado())} no total`;
  $('#mergeCount').title = 'Estimativa pela soma dos arquivos, com o documento aberto entrando ' +
    'na proporção das páginas que sobraram. O tamanho real varia um pouco: PDFs muito compactados ' +
    'crescem no arquivo gerado. Com “tarja definitiva” a página vira imagem e a conta muda bastante.';
  $('#mergeSort').textContent = ordemAZ ? 'Ordenar A–Z' : 'Ordenar Z–A';
  $('#mergeTravado').hidden = !filtrando;
  $('#mergeOk').disabled = vazia;
  $('#mergeOk').textContent = fila.length > 1 ? `Juntar ${fila.length} arquivos` : 'Juntar';

  // o documento aberto continua na frente: a fila entra depois dele
  const nota = $('#mergeInto');
  nota.hidden = !pages.length;
  if (pages.length) nota.textContent =
    `As páginas entram no fim do documento aberto (${plural(pages.length, 'página', 'páginas')}).`;

  const lista = $('#mergeList');
  lista.innerHTML = '';
  const alvo = filtrando ? semAcento(busca) : '';
  let visiveis = 0;
  fila.forEach((it, i) => {
    if (filtrando && !semAcento(it.name).includes(alvo)) return;
    visiveis++;
    lista.appendChild(filaLinha(it, i, filtrando));
  });
  $('#mergeSemResultado').hidden = !(filtrando && !visiveis);
}

/* O PDF final é, na prática, a soma das partes: o pdf-lib copia as páginas de
   cada origem para um documento novo. Do documento aberto entra só a fração de
   páginas que sobrou (quem abriu 100 páginas e excluiu 90 não leva as 90). */
function tamanhoEstimado() {
  const mantidas = {};
  for (const p of pages) mantidas[p.src] = (mantidas[p.src] || 0) + 1;
  let n = 0;
  for (const tag of Object.keys(mantidas))
    n += sources[tag].bytes.length * (mantidas[tag] / sources[tag].pdfjsDoc.numPages);
  for (const it of fila) n += it.size;
  return n;
}

function filaLinha(it, i, filtrando) {
  const li = document.createElement('li');
  li.className = 'merge-item';
  li.dataset.id = it.id;
  li.draggable = !filtrando;

  const grip = document.createElement('span');
  grip.className = 'grip'; grip.textContent = '⣿'; grip.setAttribute('aria-hidden', 'true');
  grip.title = 'Arraste para mudar a ordem';

  const pos = document.createElement('span');
  pos.className = 'pos'; pos.textContent = i + 1;

  const nome = document.createElement('span');
  nome.className = 'nome'; nome.textContent = it.name; nome.title = it.name;

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${it.doc.numPages} pág. · ${tamanhoLegivel(it.size)}`;

  const mv = document.createElement('span');
  mv.className = 'mv';
  const sobe = document.createElement('button');
  sobe.type = 'button'; sobe.textContent = '↑';
  sobe.title = 'Subir na ordem'; sobe.setAttribute('aria-label', `Subir ${it.name}`);
  sobe.disabled = filtrando || i === 0;
  sobe.onclick = () => filaMover(i, i - 1);
  const desce = document.createElement('button');
  desce.type = 'button'; desce.textContent = '↓';
  desce.title = 'Descer na ordem'; desce.setAttribute('aria-label', `Descer ${it.name}`);
  desce.disabled = filtrando || i === fila.length - 1;
  desce.onclick = () => filaMover(i, i + 1);
  mv.append(sobe, desce);

  const rm = document.createElement('button');
  rm.type = 'button'; rm.className = 'rm'; rm.textContent = '✕';
  rm.title = 'Tirar da lista'; rm.setAttribute('aria-label', `Tirar ${it.name} da lista`);
  rm.onclick = () => {
    try { it.doc.destroy(); } catch (_) {}
    fila.splice(fila.indexOf(it), 1);
    filaRender();
  };

  li.append(grip, pos, nome, meta, mv, rm);
  ligarArrasto(li, it);
  return li;
}

function filaMover(de, para) {
  if (para < 0 || para >= fila.length) return;
  const [it] = fila.splice(de, 1);
  fila.splice(para, 0, it);
  filaRender();
}

/* arrasto entre linhas: a marca de ouro mostra onde o arquivo vai cair */
function ligarArrasto(li, it) {
  const limpar = () => $('#mergeList').querySelectorAll('.over-top, .over-bottom')
    .forEach(n => n.classList.remove('over-top', 'over-bottom'));
  const depoisDoMeio = ev => {
    const r = li.getBoundingClientRect();
    return ev.clientY - r.top > r.height / 2;
  };

  li.addEventListener('dragstart', ev => {
    arrastandoId = it.id;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(it.id));
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => { arrastandoId = null; li.classList.remove('dragging'); limpar(); });
  li.addEventListener('dragover', ev => {
    if (arrastandoId == null) return;              // arrasto de arquivo: quem trata é a caixa
    ev.preventDefault(); ev.stopPropagation();
    limpar();
    li.classList.add(depoisDoMeio(ev) ? 'over-bottom' : 'over-top');
  });
  li.addEventListener('drop', ev => {
    if (arrastandoId == null) return;
    ev.preventDefault(); ev.stopPropagation();
    limpar();
    const de = fila.findIndex(f => f.id === arrastandoId);
    let para = fila.indexOf(it) + (depoisDoMeio(ev) ? 1 : 0);
    if (de < para) para--;                         // tirar o item de cima encurta a lista
    arrastandoId = null;
    if (de !== para) filaMover(de, para);
  });
}

async function juntarConfirmar() {
  if (!fila.length) return;
  const itens = fila.slice();
  juntarFechar(false);                             // os documentos lidos passam a ser do editor
  try {
    for (const it of itens) {
      const start = await addSource(it.name, it.bytes, undefined, it.doc);
      if (cur < 0) cur = start;
    }
    mostrarEditor();
    buildThumbs();
    await show(cur);
    toast(`${plural(itens.length, 'arquivo juntado', 'arquivos juntados')}: ` +
          `${plural(pages.length, 'página', 'páginas')} no documento.`);
  } catch (e) {
    console.error(e);
    toast('Não foi possível juntar os arquivos.', 'warn');
  }
}

$('#btnMerge').onclick = juntarAbrir;
$('#mergeClose').onclick = $('#mergeCancel').onclick = () => juntarFechar();
$('#mergeOk').onclick = juntarConfirmar;
$('#mergeDrop').onclick = () => $('#fileMerge').click();
$('#mergeSearch').oninput = filaRender;
$('#mergeSort').onclick = () => {
  fila.sort((a, b) => colador.compare(a.name, b.name) * (ordemAZ ? 1 : -1));
  ordemAZ = !ordemAZ;
  filaRender();
};

/* soltar arquivos em qualquer ponto da caixa alimenta a fila (e não o editor atrás) */
['dragenter', 'dragover'].forEach(t => mergeBack.addEventListener(t, ev => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault(); ev.stopPropagation();
  mergeBack.classList.add('drop-on');
}));
mergeBack.addEventListener('dragleave', ev => {
  if (ev.target === mergeBack) mergeBack.classList.remove('drop-on');
});
mergeBack.addEventListener('drop', ev => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault(); ev.stopPropagation();
  mergeBack.classList.remove('drop-on');
  filaAdicionar(ev.dataTransfer.files);
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape' || !juntarAberto()) return;
  ev.stopPropagation();
  juntarFechar();
}, true);

/* ---------- atalhos de teclado ---------- */
/* troca de página e mantém a miniatura correspondente à vista */
function goToPage(i) {
  if (cur < 0 || i < 0 || i >= pages.length || i === cur) return;
  show(i);
  $('#thumbs').children[i]?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', ev => {
  if (cur < 0) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if ($('#epdf-dialog-backdrop') || $('#epdf-menu-backdrop') || juntarAberto()) return; // diálogo/menu/fila têm prioridade
  const t = ev.target;
  // campos de digitação ficam de fora; rádio/checkbox não (o preventDefault
  // abaixo impede que a seta troque a ferramenta selecionada)
  if (t instanceof Element && (t.isContentEditable ||
      t.matches('input:not([type=radio]):not([type=checkbox]), textarea, select'))) return;

  switch (ev.key) {
    case 'Delete': case 'Backspace':
      if (sel == null) return;
      deleteSelected(); break;
    case 'Escape':
      if (sel == null) return;
      selectOverlay(null); break;
    case 'ArrowRight': case 'PageDown': goToPage(cur + 1); break;
    case 'ArrowLeft':  case 'PageUp':   goToPage(cur - 1); break;
    case 'Home': goToPage(0); break;
    case 'End':  goToPage(pages.length - 1); break;
    case '+': case '=': setZoom(view.scale * ZOOM_STEP); break;
    case '-': case '_': setZoom(view.scale / ZOOM_STEP); break;
    case '0': setZoom(1); break;
    default: return;
  }
  ev.preventDefault();
});

window.addEventListener('resize', () => {
  if (cur < 0) return;
  if (fitMode === null) return; // zoom manual não é alterado pelo redimensionamento
  show(cur);
});
