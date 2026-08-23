#!/usr/bin/env python3
"""Debug: onde o texto se perde entre estado e arquivo."""
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:8093/index.html'
PDF1 = '/opt/data/editor-pdf/tests/teste-pagina1.pdf'

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page(viewport={'width': 1280, 'height': 900})
    msgs = []
    page.on('console', lambda m: msgs.append(f'{m.type}: {m.text}'))
    def on_dialog(d):
        d.accept('SELO DPCI') if d.type == 'prompt' else d.accept()
    page.on('dialog', on_dialog)

    page.goto(URL)
    page.wait_for_function("typeof PDFLib !== 'undefined'")
    page.set_input_files('#fileOpen', PDF1)
    page.wait_for_selector('.thumb')

    page.click('label[for="toolText"]')
    box = page.locator('#overlay').bounding_box()
    print('overlay box:', {k: round(v) for k, v in box.items()})
    page.mouse.click(box['x'] + 120, box['y'] + 500)
    page.wait_for_timeout(150)
    st = page.evaluate("JSON.stringify(pages.map(p => p.overlays))")
    print('estado overlays:', st)
    sc = page.evaluate("view.scale")
    print('view.scale:', sc)

    with page.expect_download() as dl:
        page.evaluate("exportPdf()")
        # capturar bytes ANTES do download via hook
    dl.value.save_as('/tmp/debug-texto.pdf')
    b.close()

for m in msgs:
    if 'favicon' not in m:
        print('console>', m)

import re, zlib
d = open('/tmp/debug-texto.pdf','rb').read()
print('bruto:', b'SELO DPCI' in d)
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.S):
    try:
        dec = zlib.decompress(m.group(1))
        if b'Tj' in dec or b'SELO' in dec:
            print('stream com operadores de texto:', dec[:300])
    except Exception:
        pass
