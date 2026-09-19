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
  sels.clear();
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
let sels = new Set();           // índices selecionados na página aberta (pode ser vários)
let grupoSeq = 0;               // cada gesto de destaque vira um grupo, apagado de uma vez
const MIN_RECT = 4;             // pt — tarja menor que isso some da vista
const MIN_FONT = 5, MAX_FONT = 200;
const LINE_H = 1.15;            // igual ao line-height de #overlay .txt

/* desenha os elementos sobrepostos da página atual */
function drawOverlay() {
  overlay.innerHTML = '';
  const p = pages[cur]; if (!p) return;
  for (const k of [...sels]) if (k >= p.overlays.length) sels.delete(k);
  // o ✕ aparece uma vez só, no elemento mais acima da seleção; a alça de
  // redimensionar só faz sentido quando há exatamente um elemento marcado
  const marcados = [...sels];
  const dono = marcados.length ? marcados.reduce((a, b) =>
    (p.overlays[b].y < p.overlays[a].y ||
     (p.overlays[b].y === p.overlays[a].y && p.overlays[b].x < p.overlays[a].x)) ? b : a) : null;
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
    if (sels.has(k)) {
      el.classList.add('sel');
      if (k === dono) decorarSelecionado(el, o, marcados.length === 1);
    }
    overlay.appendChild(el);
  }
}

/* moldura do selecionado: ✕ exclui · alça (canto ↘) redimensiona */
function decorarSelecionado(el, o, comAlca) {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'itemDel';
  del.textContent = '✕';
  del.title = comAlca ? 'Excluir este elemento (tecla Del)'
                      : `Excluir os ${sels.size} trechos selecionados (tecla Del)`;
  del.setAttribute('aria-label', 'Excluir o que está selecionado');
  del.addEventListener('pointerdown', ev => ev.stopPropagation()); // não inicia arrasto
  del.addEventListener('click', ev => { ev.stopPropagation(); deleteSelected(); });
  el.appendChild(del);

  if (!comAlca) return;            // seleção múltipla: mover sim, redimensionar não
  const alca = document.createElement('div');
  alca.className = 'hnd';
  alca.title = o.type === 'text' ? 'Arraste para mudar o tamanho da letra'
             : o.type === 'mark' ? 'Arraste para redimensionar o destaque'
                                 : 'Arraste para redimensionar a tarja';
  el.appendChild(alca);
}

/* Um arrasto do Destaque gera um retângulo por linha de texto. Eles formam UM
   destaque só: selecionar ou excluir qualquer um vale para o conjunto — sem
   isso, apagar uma marcação de 13 linhas exigiria 13 exclusões. */
function indicesDoGrupo(p, k) {
  const g = p?.overlays[k]?.g;
  if (g == null) return [k];
  const saida = [];
  for (let i = 0; i < p.overlays.length; i++) if (p.overlays[i].g === g) saida.push(i);
  return saida;
}

/* k = null larga a seleção; somar mantém o que já estava marcado (Shift) */
function selectOverlay(k, somar) {
  if (!somar) sels.clear();
  if (k != null) for (const i of indicesDoGrupo(pages[cur], k)) sels.add(i);
  drawOverlay();
  syncHint();
}

/* Shift no elemento: entra ou sai da seleção sem desfazer o resto */
function alternarSelecao(k) {
  const ix = indicesDoGrupo(pages[cur], k);
  const dentro = ix.every(i => sels.has(i));
  for (const i of ix) dentro ? sels.delete(i) : sels.add(i);
  drawOverlay(); syncHint();
}

const selUnico = () => sels.size === 1 ? [...sels][0] : null;

/* o que o arrasto vai levar junto: todo elemento selecionado, com seu
   deslocamento em relação ao ponto onde o ponteiro pegou */
function itensSelecionados(x, y) {
  const p = pages[cur];
  return [...sels].map(k => {
    const o = p.overlays[k];
    return { o, el: overlay.querySelector(`[data-k="${k}"]`), dx: x - o.x, dy: y - o.y };
  });
}

/* laço: marca tudo que encostar na caixa arrastada */
function selecionarNaCaixa(b, somar) {
  const p = pages[cur]; if (!p) return;
  if (!somar) sels.clear();
  for (let k = 0; k < p.overlays.length; k++) {
    const o = p.overlays[k];
    const larg = o.type === 'text' ? (o.text.length * o.size * .5) : o.w;
    const alt  = o.type === 'text' ? o.size * LINE_H : o.h;
    if (o.x < b.x + b.w && o.x + larg > b.x && o.y < b.y + b.h && o.y + alt > b.y) sels.add(k);
  }
  drawOverlay(); syncHint();
  if (sels.size) toast(sels.size === 1 ? '1 trecho selecionado.' : `${sels.size} trechos selecionados. Del exclui todos.`);
}

/* Del/Backspace e o ✕ excluem na hora; o botão direito continua pedindo confirmação */
function deleteSelected() {
  const p = pages[cur]; if (!p || !sels.size) return;
  const ix = [...sels].sort((a, b) => b - a);          // de trás para frente: os índices não deslizam
  const tipos = new Set(ix.map(k => p.overlays[k].type));
  for (const k of ix) p.overlays.splice(k, 1);
  sels.clear();
  drawOverlay(); refreshThumb(cur); syncHint();
  const um = { rect: 'Tarja excluída.', mark: 'Destaque excluído.', text: 'Texto excluído.' };
  toast(ix.length === 1 ? um[[...tipos][0]]
      : tipos.size === 1 && tipos.has('mark') ? `Destaque excluído (${ix.length} linhas).`
      : `${ix.length} trechos excluídos.`);
}

async function removeOverlayAt(p, k) {
  const ix = indicesDoGrupo(p, k);
  const ok = await appDialog({
    title: 'Remover elemento',
    message: ix.length > 1
      ? `O destaque inteiro — ${ix.length} linhas — será retirado do documento.`
      : 'O trecho marcado será retirado do documento.',
    mode: 'confirm',
    okLabel: 'Remover'
  });
  if (!ok) return;
  for (const i of [...ix].sort((a, b) => b - a)) p.overlays.splice(i, 1);
  sels.clear();
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
  const g = ++grupoSeq;                                // marca o gesto: apaga-se inteiro
  for (const n of novos) pages[cur].overlays.push({ type: 'mark', g, ...n });
  sels.clear();
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
  const u = selUnico(), o = u != null ? pages[cur]?.overlays[u] : null;
  if (o) {
    hint.textContent = { rect: 'Tarja selecionada', mark: 'Destaque selecionado',
                         text: 'Texto selecionado (duplo clique edita)' }[o.type] +
      ' · arraste para mover · alça ↘ redimensiona · Del exclui';
    return;
  }
  if (sels.size) {
    hint.textContent = `${sels.size} trechos selecionados · arraste para mover · Del exclui todos`;
    return;
  }
  hint.textContent = {
    redact: 'Arraste sobre o trecho que deve ser ocultado.',
    mark: temTexto()
      ? 'Arraste sobre o trecho — o amarelo se ajusta às linhas · um clique destaca a linha inteira.'
      : 'Página sem texto (escaneada): arraste a caixa do destaque sobre o trecho.',
    text: 'Clique no ponto onde o texto deve entrar.'
  }[activeTool()] || (pages[cur]?.overlays.length
    ? 'Arraste um laço sobre vários trechos para selecioná-los · Ctrl+A marca todos · Del exclui.'
    : '');
}

/* ---------- gestos sobre o documento ---------- */
let drag = null;
overlay.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;                       // o botão direito remove (contextmenu)
  const r = overlay.getBoundingClientRect();
  const x = (ev.clientX - r.left) / view.scale, y = (ev.clientY - r.top) / view.scale;
  // o destaque também é clicável: sem `.mark` aqui ele só podia ser removido
  // pelo botão direito, uma linha de cada vez
  const el = ev.target.closest('.txt, .rect:not(.rubber), .mark:not(.rubber)');

  if (el) {
    const k = +el.dataset.k, o = pages[cur].overlays[k];
    if (ev.target.classList.contains('hnd')) {
      drag = { mode: 'size', o, el, x0: x, y0: y, w0: o.w, h0: o.h, size0: o.size };
    } else {
      if (ev.shiftKey) alternarSelecao(k);           // Shift soma ou tira da seleção
      else if (!sels.has(k)) selectOverlay(k);       // redesenha: o elemento antigo saiu do DOM
      drag = { mode: 'move', itens: itensSelecionados(x, y) };
    }
    overlay.setPointerCapture(ev.pointerId);
    ev.preventDefault();                             // não seleciona o texto da página
    return;
  }

  if (sels.size && !ev.shiftKey) selectOverlay(null); // clique fora larga a seleção
  const tool = activeTool();
  if (!tool) {                                       // sem ferramenta: laço de seleção
    drag = { mode: 'laco', x0: x, y0: y, el: null, somar: ev.shiftKey };
    overlay.setPointerCapture(ev.pointerId);
    return;
  }
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
  sels = new Set([pages[cur].overlays.length - 1]);  // já entra selecionado, pronto para ajustar
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
    for (const it of drag.itens) {
      it.o.x = Math.max(0, x - it.dx);
      it.o.y = Math.max(0, y - it.dy);
      if (!it.el) continue;
      it.el.style.left = it.o.x * s + 'px';
      it.el.style.top = it.o.y * s + 'px';
    }
    drag.mexeu = true;
    return;
  }

  if (drag.mode === 'laco') {
    const nx = Math.min(drag.x0, x), ny = Math.min(drag.y0, y);
    const w = Math.abs(x - drag.x0), h = Math.abs(y - drag.y0);
    if (!drag.el) {
      drag.el = document.createElement('div');
      drag.el.className = 'laco';
      overlay.appendChild(drag.el);
    }
    drag.el.style.cssText = `left:${nx * s}px;top:${ny * s}px;width:${w * s}px;height:${h * s}px`;
    drag.box = { x: nx, y: ny, w, h };
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

  if (d.mode === 'laco') {
    d.el?.remove();
    if (d.box && (d.box.w > 2 || d.box.h > 2)) selecionarNaCaixa(d.box, d.somar);
    return;
  }

  if (d.mode === 'rect') {
    const b = d.box;
    d.el?.remove();
    if (d.tipo === 'mark') { aplicarDestaque(b, d.x0, d.y0); return; }
    if (b && b.w > .02 * canvas.width / view.scale / 5 && b.w > 2) { // mínimo visível
      pages[cur].overlays.push({ type: 'rect', ...b });
      sels = new Set([pages[cur].overlays.length - 1]);
      drawOverlay(); refreshThumb(cur); syncHint();
    }
    return;
  }
  if (d.mexeu) { drawOverlay(); refreshThumb(cur); } // recoloca alça e ✕ na posição nova
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

/* ---------- exportação ---------- */
/* `lista` permite exportar um SUBCONJUNTO das páginas, com overlays próprios —
   é o que a exportação por publicação usa para gerar um arquivo por matéria. */
async function buildOutputPdf(burnRects, lista = pages) {
  const out = await PDFDocument.create();
  const precisaBurn = rec => burnRects && rec.overlays.some(o => o.type === 'rect');

  // Cada origem é copiada numa ÚNICA chamada de copyPages. O pdf-lib refaz a
  // cópia dos recursos a cada chamada: página a página, uma imagem usada por
  // várias páginas entrava uma vez POR PÁGINA e o arquivo saía múltiplas vezes
  // maior que a soma dos originais.
  const porOrigem = {};
  for (const rec of lista) {
    if (precisaBurn(rec)) continue;                // vira raster: não é copiada
    (porOrigem[rec.src] ||= []).push(rec.idx);
  }
  let helv = null;                                 // embutida sob demanda, uma vez por documento
  const copias = {};                               // tag -> Map(idx -> página copiada)
  for (const tag of Object.keys(porOrigem)) {
    const doc = await PDFDocument.load(sources[tag].bytes, { ignoreEncryption: true });
    const idxs = porOrigem[tag];
    const feitas = await out.copyPages(doc, idxs);
    copias[tag] = new Map(idxs.map((ix, n) => [ix, feitas[n]]));
  }

  for (let i = 0; i < lista.length; i++) {
    const rec = lista[i];
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

    // a fonte pertence a ESTE documento: guardá-la entre exportações faria o
    // segundo arquivo apontar para um objeto que não existe nele
    helv ||= await out.embedFont(StandardFonts.HelveticaBold);
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

/* ---------- a roda do mouse atravessa as páginas ---------- */
/* O documento continua sendo uma página por vez no visor. Chegando ao fim da
   página, continuar rolando passa para a seguinte — e no topo, para a anterior.
   Em "Página inteira" não há o que rolar, então cada rolagem já vira a página. */
const BORDA = 2;              // px — folga para o arredondamento do navegador
const DESCANSO = 350;         // ms de espera após virar: uma rolagem = uma página
const EMPURRAO = 200;         // px a rolar na borda antes de virar (~2 voltas da roda)
const ESQUECE = 600;          // ms parado na borda: o empurrão recomeça do zero
let ultimaVirada = 0, acumulado = 0, ultimoNaBorda = 0;

async function virarPagina(dir) {
  const alvo = cur + dir;
  ultimaVirada = performance.now();
  acumulado = 0;
  await show(alvo);
  $('#thumbs').children[alvo]?.scrollIntoView({ block: 'nearest' });
  // descendo entra pelo topo da página nova; subindo, pelo rodapé — a leitura
  // continua de onde parou em vez de saltar
  const el = $('#pageArea');
  el.scrollTop = dir > 0 ? 0 : Math.max(0, el.scrollHeight - el.clientHeight);
}

$('#pageArea').addEventListener('wheel', ev => {
  if (cur < 0 || juntarAberto() || pubAberto()) return;
  if (ev.ctrlKey || ev.metaKey) return;          // rolar com Ctrl é zoom, não navegação
  const dy = ev.deltaY;
  if (!dy) return;

  const el = $('#pageArea');
  const sobra = el.scrollHeight - el.clientHeight;
  const rolavel = sobra > BORDA;
  const naBorda = dy > 0 ? el.scrollTop >= sobra - BORDA : el.scrollTop <= BORDA;

  if (rolavel && !naBorda) { acumulado = 0; return; }   // ainda há página para rolar
  if (performance.now() - ultimaVirada < DESCANSO) return;

  // Numa página que rola, exige um empurrão a mais depois de encostar no fim:
  // senão a mesma rolagem que chega à borda já viraria a página. O empurrão tem
  // de ser um gesto contínuo — parando na borda, recomeça do zero.
  if (rolavel) {
    const agora = performance.now();
    if (agora - ultimoNaBorda > ESQUECE) acumulado = 0;
    ultimoNaBorda = agora;
    acumulado += Math.abs(dy);
    if (acumulado < EMPURRAO) return;
  }
  const dir = dy > 0 ? 1 : -1;
  if (cur + dir < 0 || cur + dir >= pages.length) { acumulado = 0; return; }
  ev.preventDefault();          // síncrono: segurar a rolagem não pode esperar o render
  virarPagina(dir);
}, { passive: false });

document.addEventListener('keydown', ev => {
  if (cur < 0) return;
  // Ctrl/Cmd+A marca tudo que foi inserido na página — o caminho curto para
  // limpar a marcação inteira antes de destacar a publicação seguinte
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'a' || ev.key === 'A')) {
    const p = pages[cur];
    if (!p?.overlays.length) return;
    ev.preventDefault();
    sels = new Set(p.overlays.map((_, k) => k));
    drawOverlay(); syncHint();
    toast(`${sels.size} trechos selecionados. Del exclui todos.`);
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if ($('#epdf-dialog-backdrop') || $('#epdf-menu-backdrop') || juntarAberto() || pubAberto()) return; // diálogo/menu/painel têm prioridade
  const t = ev.target;
  // campos de digitação ficam de fora; rádio/checkbox não (o preventDefault
  // abaixo impede que a seta troque a ferramenta selecionada)
  if (t instanceof Element && (t.isContentEditable ||
      t.matches('input:not([type=radio]):not([type=checkbox]), textarea, select'))) return;

  switch (ev.key) {
    case 'Delete': case 'Backspace':
      if (!sels.size) return;
      deleteSelected(); break;
    case 'Escape':
      if (!sels.size) return;
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

/* ==========================================================================
   PUBLICAÇÕES DA POLÍCIA CIENTÍFICA NO DIÁRIO OFICIAL
   --------------------------------------------------------------------------
   O Diário Oficial de Goiás traz duas estruturas que permitem achar as nossas
   publicações sem depender de procurar texto solto:

   1. BARRA AMARELA (#FFCC00, largura de coluna) abre a seção de cada órgão. O
      texto dentro dela é o nome do órgão. A barra SEGUINTE, na ordem de leitura,
      fecha a seção anterior — é um limite exato, não um palpite. Procurar a
      seção pela barra, e não pelo texto, ignora por construção as menções a
      "Diretoria da Polícia Científica" no corpo de publicações da SSP.

   2. MARCADORES INVISÍVEIS delimitam cada matéria: texto branco de 2pt na forma
      <#ABC#652905#22#745443> (abre) e <#ABC#652905#23#745443/> (fecha). Eles
      acompanham a matéria ATRAVESSANDO colunas e páginas, o que resolve o caso
      de uma portaria começar numa página e terminar na outra.

   Se um dia o Diário mudar de layout nada quebra: a detecção não acha nada e o
   destaque manual continua valendo.
   ========================================================================== */

const BARRA_RGB = [255, 204, 0];          // #FFCC00 — a barra de seção do Diário
const COLUNA_MEIO = 300;                  // pt — calha entre as duas colunas A4
const ASC = .8;                           // topo da linha = base − ASC × altura (aferido: erro < .2pt)
const RX_MARCA = /<#ABC#(\d+)#(\d+)#\d+(\/)?>/;
const RX_DOE   = /DI[ÁA]RIO\s+OFICIAL\/GO\s+N[°ºo]\s*([\d.]+)/i;
const RX_ORGAO = /Pol[íi]cia\s+Cient[íi]fica/i;
/* últimas linhas do cabeçalho e primeira do rodapé — servem de limite do corpo */
const RX_CABECALHO = /DI[ÁA]RIO\s+OFICIAL\/GO\s+N[°ºo]|^ANO\s+\d+\s*-/i;
const RX_RODAPE = /DIARIO\s+OFICIAL\s+DO\s+ESTADO\s+DE\s+GOIAS|CODIGO\s+DE\s+AUTENTICACAO/i;
/* o Diário encerra cada matéria com este rótulo, e ele é a fronteira mais
   confiável quando o layout foge das duas colunas (tabelas ocupando a largura
   inteira, por exemplo, quebram a ordem coluna-a-coluna) */
const RX_PROTOCOLO = /^Protocolo\s+(\d+)\s*$/i;
/* "PORTARIA DPCI Nº 250 - DGDP, DE 12 DE..." -> tipo, número, sigla */
const RX_TITULO = /^([A-ZÇÃÁÉÍÓÚÂÊÔÕ][A-ZÇÃÁÉÍÓÚÂÊÔÕ\s]{3,60}?)\s+(?:DPCI\s+)?N[ºo°]\s*([\dA-Za-z./-]+?)\s*(?:-\s*([A-ZÇ]{2,12}))?\s*,\s*DE\s/i;

const coluna = x => x < COLUNA_MEIO ? 0 : 1;
/* ordem de leitura do Diário: página, depois coluna, depois altura */
const antes = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/* matriz 3x2 do PDF: composição e aplicação a um ponto */
const mtxMul = (a, b) => [a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1],
                          a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3],
                          a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5]];
const mtxApl = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];

/* retângulos amarelos da página, já em coordenadas de tela (origem no topo) */
async function barrasDaPagina(pg, H) {
  const ol = await pg.getOperatorList(), OPS = pdfjsLib.OPS;
  let ctm = [1, 0, 0, 1, 0, 0], pilha = [], cor = null;
  const saida = [];
  for (let k = 0; k < ol.fnArray.length; k++) {
    const fn = ol.fnArray[k], a = ol.argsArray[k];
    if (fn === OPS.save) pilha.push([...ctm]);
    else if (fn === OPS.restore) ctm = pilha.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mtxMul(ctm, a);
    else if (fn === OPS.setFillRGBColor) cor = a;
    else if (fn === OPS.constructPath && cor &&
             Math.abs(cor[0] - BARRA_RGB[0]) < 24 &&
             Math.abs(cor[1] - BARRA_RGB[1]) < 24 &&
             Math.abs(cor[2] - BARRA_RGB[2]) < 24) {
      const [ops, args] = a;
      let j = 0;
      for (const op of ops) {
        if (op !== OPS.rectangle) { j += passoDoPath()[op] ?? 0; continue; }
        const [x, y, w, h] = args.slice(j, j + 4); j += 4;
        const p1 = mtxApl(ctm, x, y), p2 = mtxApl(ctm, x + w, y + h);
        saida.push({ x: Math.min(p1[0], p2[0]), w: Math.abs(p2[0] - p1[0]),
                     y: H - Math.max(p1[1], p2[1]), h: Math.abs(p2[1] - p1[1]) });
      }
    }
  }
  return saida.filter(r => r.w > 50 && r.h > 8);   // barra de seção, não filete
}
/* Quantos números cada comando consome na lista de constructPath. Os códigos
   vêm do próprio pdf.js — fixá-los à mão quebraria numa troca de versão. */
let passoCache = null;
function passoDoPath() {
  if (passoCache) return passoCache;
  const O = pdfjsLib.OPS;
  return passoCache = {
    [O.moveTo]: 2, [O.lineTo]: 2, [O.curveTo]: 6, [O.curveTo2]: 4,
    [O.curveTo3]: 4, [O.closePath]: 0, [O.rectangle]: 4
  };
}

/* Varre o documento inteiro uma vez: número da edição, barras de seção,
   marcadores de matéria e a geometria de cada linha de texto. */
async function varrerDiario() {
  const barras = [], marcas = [], linhas = [];
  let doe = null;
  for (let i = 0; i < pages.length; i++) {
    const pg = await sources[pages[i].src].pdfjsDoc.getPage(pages[i].idx + 1);
    const H = pg.getViewport({ scale: 1 }).height;

    for (const b of await barrasDaPagina(pg, H))
      barras.push({ pos: [i, coluna(b.x), b.y], pag: i, cx: b });

    const tc = await pg.getTextContent();
    for (const it of tc.items) {
      const t = (it.str || '').trim();
      if (!t) continue;
      const x = it.transform[4], base = H - it.transform[5];
      const pos = [i, coluna(x), base];
      const m = RX_MARCA.exec(t);
      if (m) { marcas.push({ pos, pag: i, id: m[1], fecha: !!m[3] }); continue; }
      if (!doe) { const g = RX_DOE.exec(t); if (g) doe = g[1].replace(/\./g, ''); }
      // largura 0 = fonte vetorial do cabeçalho (o logo "Diário Oficial")
      if (it.width > 0)
        linhas.push({ pos, pag: i, t, cx: { x, y: base - it.height * ASC, w: it.width, h: it.height } });
    }
  }
  barras.sort((a, b) => antes(a.pos, b.pos));
  marcas.sort((a, b) => antes(a.pos, b.pos));
  linhas.sort((a, b) => antes(a.pos, b.pos));
  return { doe, barras, marcas, linhas: semCabecalhoNemRodape(linhas) };
}

/* O número da página e a tarja do cabeçalho ficam na coluna da direita, no alto:
   pela ordem de leitura eles caem DENTRO do intervalo de uma matéria que segue
   da coluna esquerda para a direita, e entravam no destaque. O próprio Diário
   marca esses limites — a linha "ANO 190 - DIÁRIO OFICIAL/GO N° …" fecha o
   cabeçalho e a linha "DIARIO OFICIAL DO ESTADO DE GOIAS …" abre o rodapé. */
function semCabecalhoNemRodape(linhas) {
  const topo = {}, base = {};
  for (const l of linhas) {
    if (RX_CABECALHO.test(l.t)) topo[l.pag] = Math.max(topo[l.pag] ?? 0, l.pos[2]);
    if (RX_RODAPE.test(l.t))    base[l.pag] = Math.min(base[l.pag] ?? 1e9, l.pos[2]);
  }
  return linhas.filter(l => {
    const t = topo[l.pag] ?? 50;                 // sem cabeçalho reconhecido: margem padrão A4
    const b = base[l.pag] ?? 1e9;
    return l.pos[2] > t + 2 && l.pos[2] < b - 2;
  });
}

const maiusculasParaTitulo = s => s.toLowerCase().split(/\s+/)
  .map(p => /^(de|da|do|das|dos|e)$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))
  .join(' ');

/* nome do arquivo a partir do título da matéria, no padrão pedido:
   "PORTARIA DPCI Nº 250 - DGDP, DE …"  ->  "DOE 24867 - Portaria 250 - DGDP" */
function nomeDaPublicacao(doe, titulo) {
  const g = RX_TITULO.exec(titulo || '');
  const prefixo = doe ? `DOE ${doe} - ` : '';
  if (!g) return prefixo + (titulo || 'Publicação').slice(0, 60).trim();
  return prefixo + maiusculasParaTitulo(g[1]) + ' ' + g[2] + (g[3] ? ' - ' + g[3].toUpperCase() : '');
}

/* Resultado: seção da DPCI (início, fim e páginas) + uma entrada por matéria,
   com as linhas a destacar já calculadas. */
async function detectarPublicacoes() {
  const { doe, barras, marcas, linhas } = await varrerDiario();
  const k = barras.findIndex(b => {
    const dentro = linhas.filter(l => l.pag === b.pag &&
      l.pos[2] >= b.cx.y && l.pos[2] <= b.cx.y + b.cx.h + 4 &&
      l.cx.x >= b.cx.x - 4 && l.cx.x <= b.cx.x + b.cx.w);
    return RX_ORGAO.test(dentro.map(l => l.t).join(' '));
  });
  if (k < 0) return { doe, secao: null, publicacoes: [] };

  const ini = barras[k].pos;
  const fim = barras[k + 1] ? barras[k + 1].pos : [1e9, 9, 9];

  const publicacoes = [], abertas = new Map();
  for (const m of marcas) {
    if (!m.fecha) { abertas.set(m.id, m); continue; }
    const a = abertas.get(m.id);
    if (!a) continue;
    abertas.delete(m.id);
    if (antes(a.pos, ini) < 0 || antes(a.pos, fim) >= 0) continue;   // fora da nossa seção

    let dentro = linhas.filter(l => antes(l.pos, a.pos) > 0 && antes(l.pos, m.pos) < 0);
    // Uma tabela de largura inteira pertence à matéria anterior, mas pela ordem
    // coluna-a-coluna cai dentro desta janela. O rótulo "Protocolo <id>" de
    // OUTRA matéria, encontrado aqui dentro, marca onde aquela terminou: tudo
    // até ele é dela.
    // O corte vale só DENTRO DA MESMA COLUNA: pela ordem de leitura a coluna
    // esquerda inteira vem antes da direita, e cortar por ela derrubaria o
    // começo da própria matéria.
    const cortes = [];
    for (const l of dentro) {
      const g = RX_PROTOCOLO.exec(l.t);
      if (g && g[1] !== m.id) cortes.push(l.pos);
    }
    if (cortes.length)
      dentro = dentro.filter(l => !cortes.some(c =>
        l.pos[0] === c[0] && l.pos[1] === c[1] && l.pos[2] <= c[2]));
    dentro = dentro.filter(l => !RX_PROTOCOLO.test(l.t));   // o rótulo não é conteúdo
    if (!dentro.length) continue;
    const titulo = dentro.find(l => l.t.length > 12)?.t || '';
    publicacoes.push({
      id: m.id,
      nome: nomeDaPublicacao(doe, titulo),
      titulo,
      pag0: a.pag, pag1: m.pag,
      caixas: dentro.map(l => ({ pag: l.pag, ...l.cx })),
      marcada: true
    });
  }
  const paginas = publicacoes.length
    ? { de: Math.min(...publicacoes.map(p => p.pag0)), ate: Math.max(...publicacoes.map(p => p.pag1)) }
    : { de: ini[0], ate: fim[0] === 1e9 ? pages.length - 1 : fim[0] };
  return { doe, secao: { ini, fim, ...paginas }, publicacoes };
}

/* ---------- painel de publicações ---------- */
let pubs = [], pubDoe = null;
const pubBack = $('#pubBack');
const pubAberto = () => !pubBack.hidden;

async function pubAbrir() {
  if (!pages.length) return toast('Abra o Diário Oficial antes.', 'warn');
  toast('Procurando as publicações…');
  let res;
  try { res = await detectarPublicacoes(); }
  catch (e) { console.error(e); return toast('Não foi possível ler a estrutura deste PDF.', 'warn'); }

  pubDoe = res.doe;
  pubs = res.publicacoes;
  pubBack.hidden = false;

  const aviso = $('#pubAviso');
  if (!res.secao) {
    aviso.hidden = false;
    aviso.textContent = 'Não encontrei a seção da Polícia Científica neste arquivo. ' +
      'Ou a edição não traz publicação nossa no dia, ou o Diário mudou de formato — ' +
      'o destaque manual continua disponível.';
  } else if (!pubs.length) {
    aviso.hidden = false;
    aviso.textContent = 'A seção existe, mas não consegui separar as matérias uma a uma. ' +
      'Use o destaque manual nesta edição.';
  } else {
    aviso.hidden = true;
  }

  $('#pubResumo').textContent = res.secao
    ? `Edição ${res.doe || '—'} · seção da Polícia Científica nas páginas ` +
      `${res.secao.de + 1} a ${res.secao.ate + 1} · ${pubs.length} ` +
      (pubs.length === 1 ? 'publicação encontrada' : 'publicações encontradas')
    : `Edição ${res.doe || '—'} · nada encontrado`;

  const corte = $('#pubCorte');
  corte.hidden = !res.secao;
  if (res.secao) {
    $('#pubDe').value = res.secao.de + 1;
    $('#pubAte').value = res.secao.ate + 1;
    $('#pubDe').max = $('#pubAte').max = pages.length;
  }
  pubRender();
}

function pubRender() {
  const ul = $('#pubLista');
  ul.innerHTML = '';
  pubs.forEach((p, i) => {
    const li = document.createElement('li');
    li.classList.toggle('fora', !p.marcada);

    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = p.marcada;
    chk.setAttribute('aria-label', `Incluir ${p.nome} na exportação`);
    chk.onchange = () => { p.marcada = chk.checked; pubRender(); };
    li.appendChild(chk);

    const nome = document.createElement('input');
    nome.type = 'text'; nome.className = 'pub-nome'; nome.value = p.nome;
    nome.setAttribute('aria-label', 'Nome do arquivo');
    nome.oninput = () => { p.nome = nome.value; pubSyncOk(); };
    li.appendChild(nome);

    const pag = document.createElement('button');
    pag.type = 'button'; pag.className = 'pub-pag';
    pag.textContent = p.pag0 === p.pag1 ? `pág. ${p.pag0 + 1}` : `pág. ${p.pag0 + 1}–${p.pag1 + 1}`;
    pag.title = 'Ir para esta página no documento';
    pag.onclick = () => { pubFechar(); goToPage(p.pag0); };
    li.appendChild(pag);

    ul.appendChild(li);
  });
  pubSyncOk();
}

function pubSyncOk() {
  const n = pubs.filter(p => p.marcada && p.nome.trim()).length;
  $('#pubOk').disabled = !n;
  $('#pubOk').textContent = n ? `Exportar ${n} ${n === 1 ? 'arquivo' : 'arquivos'}` : 'Exportar';
}

function pubFechar() { pubBack.hidden = true; }

/* corte de páginas: conservador — o usuário confere o intervalo antes */
async function pubCortar() {
  const de = parseInt($('#pubDe').value, 10) - 1, ate = parseInt($('#pubAte').value, 10) - 1;
  if (isNaN(de) || isNaN(ate) || de < 0 || ate >= pages.length || de > ate)
    return toast('Intervalo de páginas inválido.', 'warn');
  const fora = pages.length - (ate - de + 1);
  if (!fora) return toast('Não há páginas fora do intervalo.');
  const ok = await appDialog({
    title: 'Excluir as demais páginas',
    message: `Ficam as páginas ${de + 1} a ${ate + 1}. As outras ${fora} serão retiradas ` +
             'do documento. O arquivo original no seu computador não é alterado.',
    mode: 'confirm',
    okLabel: `Excluir ${fora} ${fora === 1 ? 'página' : 'páginas'}`
  });
  if (!ok) return;

  pages = pages.slice(de, ate + 1);
  for (const p of pubs) { p.pag0 -= de; p.pag1 -= de; for (const c of p.caixas) c.pag -= de; }
  cur = 0; sels.clear();
  buildThumbs(); show(0);
  $('#pubDe').value = 1; $('#pubAte').value = pages.length;
  $('#pubDe').max = $('#pubAte').max = pages.length;
  $('#pubResumo').textContent = `Edição ${pubDoe || '—'} · ${pages.length} ` +
    (pages.length === 1 ? 'página mantida' : 'páginas mantidas') + ` · ${pubs.length} publicações`;
  pubRender();
  toast(`${fora} ${fora === 1 ? 'página excluída' : 'páginas excluídas'}.`);
}

/* Exportação em lote: um arquivo por publicação, cada um com APENAS aquela
   publicação destacada. É o que substitui o ciclo manual de destacar, salvar,
   apagar o destaque, destacar a seguinte, salvar de novo. */
async function pubExportar() {
  const escolhidas = pubs.filter(p => p.marcada && p.nome.trim());
  if (!escolhidas.length) return;
  const soPagina = $('#pubSoPagina').checked;
  const burn = $('#chkBurn').checked;

  $('#pubOk').disabled = true;
  try {
    for (let n = 0; n < escolhidas.length; n++) {
      const p = escolhidas[n];
      toast(`Gerando ${n + 1} de ${escolhidas.length}: ${p.nome}…`);

      const quais = soPagina
        ? pages.map((_, i) => i).filter(i => i >= p.pag0 && i <= p.pag1)
        : pages.map((_, i) => i);
      // cada página leva o que já estava nela (tarjas, textos) MENOS os
      // destaques de outras publicações, MAIS o desta
      const lista = quais.map(i => ({
        ...pages[i],
        overlays: [
          ...pages[i].overlays.filter(o => o.type !== 'mark' || o.pub == null),
          ...juntarEmLinhas(p.caixas.filter(c => c.pag === i))
            .map(c => ({ type: 'mark', pub: p.id, ...c }))
        ]
      }));

      const bytes = await buildOutputPdf(burn, lista);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      a.download = nomeSeguro(p.nome) + '.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 20000);
      await new Promise(r => setTimeout(r, 350));   // o navegador engasga com downloads em rajada
    }
    toast(`${escolhidas.length} ${escolhidas.length === 1 ? 'arquivo gerado' : 'arquivos gerados'}.`);
    pubFechar();
  } catch (e) {
    console.error(e);
    toast('Não foi possível gerar os arquivos. Tente novamente.', 'warn');
  } finally {
    pubSyncOk();
  }
}

/* nome de arquivo aceito por Windows, macOS e Linux */
const nomeSeguro = s => s.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 120);

$('#btnPub').onclick = pubAbrir;
$('#pubClose').onclick = pubFechar;
$('#pubCancel').onclick = pubFechar;
$('#pubCortar').onclick = pubCortar;
$('#pubOk').onclick = pubExportar;
pubBack.addEventListener('pointerdown', ev => { if (ev.target === pubBack) pubFechar(); });
