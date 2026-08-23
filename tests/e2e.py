#!/usr/bin/env python3
"""E2E do editor de PDF: abre, tarja definitiva, exporta e valida."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root
PDF1 = os.path.join(BASE, 'tests', 'teste-pagina1.pdf')
OUT_BURN = '/tmp/editado-tarja-definitiva.pdf'
OUT_SOFT = '/tmp/editado-tarja-visual.pdf'
URL = 'http://127.0.0.1:8093/index.html'

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

    page.goto(URL)
    page.wait_for_function("typeof PDFLib !== 'undefined' && typeof pdfjsLib !== 'undefined'")
    print('1. libs carregadas')

    page.set_input_files('#fileOpen', PDF1)
    page.wait_for_selector('#canvasHolder:not([hidden])')
    page.wait_for_selector('.thumb')
    n_thumbs = page.locator('.thumb').count()
    print(f'2. PDF aberto, miniaturas: {n_thumbs}')
    assert n_thumbs == 1

    # desenha tarja sobre a linha do CPF (linha 2 da página: y≈130–165 pt do topo,
    # texto começa em x=72 e se estende até ≈470 pt)
    page.click('label[for="toolRedact"]')
    box = page.locator('#overlay').bounding_box()
    s = box['width'] / 595.28
    x1, y1 = box['x'] + 55 * s, box['y'] + 128 * s
    x2, y2 = box['x'] + 500 * s, box['y'] + 168 * s
    page.mouse.move(x1, y1)
    page.mouse.down()
    page.mouse.move(x2, y2, steps=10)
    page.mouse.up()
    page.wait_for_timeout(200)
    n_rect = page.locator('#overlay .rect:not(.rubber)').count()
    n_badge = page.locator('.thumb .badge').count()
    print(f'3. tarjas no overlay: {n_rect} | selo na miniatura: {n_badge}')
    assert n_rect == 1 and n_badge == 1
    page.screenshot(path='/tmp/editor-com-tarja.png', full_page=False)

    # exporta SEM tarja definitiva (tarja apenas visual)
    page.uncheck('#chkBurn')
    with page.expect_download() as dl:
        page.click('#btnExport')
    dl.value.save_as(OUT_SOFT)
    print('4. exportado (tarja visual):', OUT_SOFT)

    # exporta COM tarja definitiva
    page.check('#chkBurn')
    with page.expect_download() as dl:
        page.click('#btnExport')
    dl.value.save_as(OUT_BURN)
    print('5. exportado (tarja definitiva):', OUT_BURN)

    # junta com outro PDF (merge) e exporta de novo -> 2 páginas
    page.set_input_files('#fileMerge', os.path.join(BASE, 'tests', 'teste-anexo.pdf'))
    page.wait_for_function("document.querySelectorAll('.thumb').length === 2")
    with page.expect_download() as dl:
        page.click('#btnExport')
    dl.value.save_as('/tmp/editado-juntado.pdf')
    print('6. merge concluído, exportado: /tmp/editado-juntado.pdf')

    page.screenshot(path='/tmp/editor-final.png')
    browser.close()

    real_errors = [e for e in errors if 'favicon' not in e]
    if real_errors:
        print('ERROS DE CONSOLE:', real_errors[:5])
        sys.exit(1)
print('E2E OK')
