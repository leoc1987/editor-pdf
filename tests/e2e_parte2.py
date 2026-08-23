#!/usr/bin/env python3
"""E2E parte 2: inserir texto, página em branco, excluir página."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF1 = os.path.join(BASE, 'tests', 'teste-pagina1.pdf')
URL = os.environ.get('EDITOR_URL', 'http://127.0.0.1:8093/index.html')

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("typeof PDFLib !== 'undefined'")
    page.set_input_files('#fileOpen', PDF1)
    page.wait_for_selector('.thumb')

    # inserir texto (abre o dialogo proprio da ferramenta Texto)
    page.click('label[for="toolText"]')
    box = page.locator('#overlay').bounding_box()
    page.mouse.click(box['x'] + 60 * 2, box['y'] + 250 * 2)  # pt->px aprox (scale ~2)
    page.wait_for_selector('#epdf-dialog')
    page.fill('#epdf-dialog-input', 'SELO DPCI')
    page.click('#epdf-dialog [data-act="ok"]')
    page.wait_for_timeout(150)
    n_txt = page.locator('#overlay .txt').count()
    print(f'1. texto inserido no overlay: {n_txt}')
    assert n_txt == 1
    # ao inserir, o texto ja fica selecionado (moldura + alca)
    assert page.locator('#overlay .txt.sel .hnd').count() == 1, 'texto novo nao veio selecionado'

    # 1b. clicar no texto ja inserido SELECIONA — nao abre outro "Inserir texto"
    page.keyboard.press('Escape')                             # larga a selecao
    page.wait_for_timeout(100)
    assert page.locator('#overlay .txt.sel').count() == 0, 'Esc nao largou a selecao'
    tb = page.locator('#overlay .txt').bounding_box()
    page.mouse.click(tb['x'] + tb['width'] / 2, tb['y'] + tb['height'] / 2)
    page.wait_for_timeout(200)
    assert page.locator('#epdf-dialog').count() == 0, 'clicar no texto reabriu o dialogo'
    assert page.locator('#overlay .txt').count() == 1, 'clicar no texto criou outro por cima'
    assert page.locator('#overlay .txt.sel .hnd').count() == 1, 'faltou a alca de redimensionar'
    print('1b. clique no texto seleciona (sem duplicar)')

    # 1c. arrastar move o texto
    o0 = page.evaluate("() => ({...pages[0].overlays[0]})")
    tb = page.locator('#overlay .txt').bounding_box()
    page.mouse.move(tb['x'] + tb['width'] / 2, tb['y'] + tb['height'] / 2)
    page.mouse.down()
    page.mouse.move(tb['x'] + tb['width'] / 2 + 60, tb['y'] + tb['height'] / 2 + 30, steps=10)
    page.mouse.up()
    o1 = page.evaluate("() => ({...pages[0].overlays[0]})")
    print(f"1c. mover: x {o0['x']:.1f} -> {o1['x']:.1f} | y {o0['y']:.1f} -> {o1['y']:.1f}")
    assert o1['x'] > o0['x'] + 5 and o1['y'] > o0['y'] + 5, 'o texto nao se moveu'

    # 1d. a alca aumenta o corpo da letra
    hb = page.locator('#overlay .txt.sel .hnd').bounding_box()
    page.mouse.move(hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2)
    page.mouse.down()
    page.mouse.move(hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2 + 40, steps=10)
    page.mouse.up()
    o2 = page.evaluate("() => ({...pages[0].overlays[0]})")
    print(f"1d. redimensionar: {o1['size']:.1f} -> {o2['size']:.1f} pt")
    assert o2['size'] > o1['size'] + 2, 'a alca nao aumentou a letra'

    # 1e. Delete apaga o selecionado
    page.keyboard.press('Delete')
    page.wait_for_timeout(150)
    assert page.locator('#overlay .txt').count() == 0, 'Delete nao apagou o texto'
    print('1e. Delete apagou o texto selecionado')

    # reinsere o texto (o resto do teste valida a gravacao no PDF)
    page.mouse.click(box['x'] + 60 * 2, box['y'] + 250 * 2)
    page.wait_for_selector('#epdf-dialog')
    page.fill('#epdf-dialog-input', 'SELO DPCI')
    page.click('#epdf-dialog [data-act="ok"]')
    page.wait_for_selector('#overlay .txt')

    # 1f. duplo clique reabre o texto para edicao (com o valor atual no campo)
    page.locator('#overlay .txt').dblclick()
    page.wait_for_selector('#epdf-dialog')
    assert page.input_value('#epdf-dialog-input') == 'SELO DPCI'
    page.click('#epdf-dialog [data-act="cancel"]')
    print('1f. duplo clique abre a edicao com o texto atual')

    # adicionar página em branco
    n0 = page.locator('.thumb').count()
    page.click('#btnBlank')
    page.wait_for_function(f"document.querySelectorAll('.thumb').length === {n0+1}")
    print(f'2. pagina em branco adicionada: {n0} -> {page.locator(".thumb").count()}')

    # exportar com texto -> validar conteudo
    with page.expect_download() as dl:
        page.click('#btnExport')
    dl.value.save_as('/tmp/editado-com-texto.pdf')

    # mais uma pagina em branco: sao duas exclusoes para testar o "nao perguntar"
    page.click('#btnBlank')
    page.wait_for_function(f"document.querySelectorAll('.thumb').length === {n0+2}")

    # 3. excluir a pagina 2 marcando "nao perguntar de novo nesta sessao"
    page.locator('.thumb:nth-child(2)').hover()
    page.locator('.thumb:nth-child(2) .del').click()
    page.wait_for_selector('#epdf-dialog')
    page.check('#epdf-dialog-again-box')
    page.click('#epdf-dialog [data-act="ok"]')
    page.wait_for_function(f"document.querySelectorAll('.thumb').length === {n0+1}")
    print('3. pagina excluida com a caixa marcada:', page.locator('.thumb').count())

    # 3b. a proxima exclusao sai direto, sem dialogo
    page.locator('.thumb:nth-child(2)').hover()
    page.locator('.thumb:nth-child(2) .del').click()
    page.wait_for_function(f"document.querySelectorAll('.thumb').length === {n0}")
    assert page.locator('#epdf-dialog').count() == 0, 'ainda perguntou depois de "nao perguntar"'
    print('3b. exclusao seguinte sem perguntar: voltou para', page.locator('.thumb').count())

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
