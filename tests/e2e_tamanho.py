#!/usr/bin/env python3
"""E2E de tamanho: o PDF exportado tem de ficar na ordem de grandeza da soma
dos originais. Guarda a correcao do copyPages: copiando pagina a pagina, uma
imagem usada por varias paginas entrava uma vez POR PAGINA e o arquivo saia
varias vezes maior (medido: 8x)."""
import os, sys
from playwright.sync_api import sync_playwright

URL = os.environ.get('EDITOR_URL', 'http://127.0.0.1:8093/index.html')
SAIDA = '/tmp/editado-tamanho.pdf'

# 2 PDFs de 6 paginas, cada um com UMA imagem repetida em todas as paginas
GERA = """async () => {
  const c = document.createElement('canvas'); c.width = 1000; c.height = 1400;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = `hsl(${Math.random() * 360},40%,${40 + Math.random() * 50}%)`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 12, 5);
  }
  const jpg = new Uint8Array(await (await fetch(c.toDataURL('image/jpeg', .7))).arrayBuffer());
  const dt = new DataTransfer();
  for (let d = 0; d < 2; d++) {
    const doc = await PDFLib.PDFDocument.create();
    const img = await doc.embedJpg(jpg);
    for (let i = 0; i < 6; i++) doc.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    dt.items.add(new File([await doc.save()], `digitalizado-${d + 1}.pdf`, { type: 'application/pdf' }));
  }
  document.querySelector('#mergeBack').dispatchEvent(
    new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}"""

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("typeof PDFLib !== 'undefined' && typeof pdfjsLib !== 'undefined'")

    page.click('#btnMerge')
    page.wait_for_selector('#mergeBack:not([hidden])')
    page.evaluate(GERA)
    page.wait_for_function("document.querySelectorAll('.merge-item').length === 2")

    soma = page.evaluate("() => fila.reduce((n, it) => n + it.size, 0)")
    estimado = page.evaluate("() => tamanhoEstimado()")
    print(f'1. fila: soma {soma/1024:.0f} KB · estimativa mostrada {estimado/1024:.0f} KB')
    assert abs(estimado - soma) < soma * .05, 'estimativa fora da soma dos arquivos'
    assert '≈' in page.locator('#mergeCount').inner_text(), 'o contador nao mostra a estimativa'

    page.click('#mergeOk')
    page.wait_for_function("document.querySelectorAll('.thumb').length === 12")
    with page.expect_download() as dl:
        page.click('#btnExport')
    dl.value.save_as(SAIDA)
    real = os.path.getsize(SAIDA)
    print(f'2. exportado: {real/1024:.0f} KB ({real/soma:.2f}x a soma)')
    assert real < soma * 1.4, f'arquivo inflado: {real/soma:.2f}x a soma dos originais'

    browser.close()
    reais = [e for e in errors if 'favicon' not in e]
    if reais:
        print('ERROS:', reais[:5]); sys.exit(1)
print('E2E-TAMANHO OK')
