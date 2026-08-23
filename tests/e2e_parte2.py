#!/usr/bin/env python3
"""E2E parte 2: inserir texto, página em branco, excluir página."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF1 = os.path.join(BASE, 'tests', 'teste-pagina1.pdf')
URL = 'http://127.0.0.1:8093/index.html'

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    dialogs = []
    def on_dialog(d):
        d.accept('SELO DPCI') if d.type == 'prompt' else d.accept()
    page.on('dialog', on_dialog)

    page.goto(URL)
    page.wait_for_function("typeof PDFLib !== 'undefined'")
    page.set_input_files('#fileOpen', PDF1)
    page.wait_for_selector('.thumb')

    # inserir texto
    page.click('label[for="toolText"]')
    box = page.locator('#overlay').bounding_box()
    page.mouse.click(box['x'] + 60 * 2, box['y'] + 250 * 2)  # pt->px aprox (scale ~2)
    page.wait_for_timeout(150)
    n_txt = page.locator('#overlay .txt').count()
    print(f'1. texto inserido no overlay: {n_txt}')
    assert n_txt == 1

    # adicionar página em branco
    n0 = page.locator('.thumb').count()
    page.click('#btnBlank')
    page.wait_for_function(f"document.querySelectorAll('.thumb').length === {n0+1}")
    print(f'2. pagina em branco adicionada: {n0} -> {page.locator(".thumb").count()}')

    # exportar com texto -> validar conteudo
    with page.expect_download() as dl:
        page.click('#btnExport')
    dl.value.save_as('/tmp/editado-com-texto.pdf')

    # excluir a pagina em branco (a atual, pagina 2) — confirm auto-aceito
    page.locator('.thumb:nth-child(2)').hover()
    page.locator('.thumb:nth-child(2) .del').click()
    page.wait_for_function(f"document.querySelectorAll('.thumb').length === {n0}")
    print('3. pagina excluida: voltou para', page.locator('.thumb').count())

    browser.close()
    real = [e for e in errors if 'favicon' not in e]
    if real:
        print('ERROS:', real[:5]); sys.exit(1)

d = open('/tmp/editado-com-texto.pdf','rb').read()
# pdf-lib grava texto como string HEX (<53454C4F...>) dentro de stream comprimido
import re, zlib
alvo = 'SELO DPCI'.encode('latin-1').hex().upper().encode()  # hex em MAIÚSCULAS
achou = alvo in d
if not achou:
    for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.S):
        try:
            if alvo in zlib.decompress(m.group(1)):
                achou = True; break
        except Exception:
            pass
assert achou, 'texto nao gravado no PDF'
print('4. texto presente no PDF exportado: OK')
print('E2E-PARTE2 OK')
