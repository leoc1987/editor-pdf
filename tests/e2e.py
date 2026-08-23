#!/usr/bin/env python3
"""E2E do editor de PDF: abre, tarja definitiva, exporta e valida."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root
PDF1 = os.path.join(BASE, 'tests', 'teste-pagina1.pdf')
OUT_BURN = '/tmp/editado-tarja-definitiva.pdf'
OUT_SOFT = '/tmp/editado-tarja-visual.pdf'
URL = os.environ.get('EDITOR_URL', 'http://127.0.0.1:8093/index.html')

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    # device_scale_factor=2 simula tela Retina: com dpr=1 o bug do transform
    # duplicado no render fica invisivel (por isso passou despercebido)
    page = browser.new_page(viewport={'width': 1280, 'height': 900}, device_scale_factor=2)
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

    # 2c. a miniatura tem de manter a proporcao retrato da pagina: sem width/height
    # o canvas fica no padrao 300x150 e a miniatura sai achatada
    tw, th = page.evaluate("() => { const c = document.querySelector('.thumb canvas'); return [c.width, c.height]; }")
    print(f'2c. miniatura {tw}x{th}')
    assert th > tw, f'miniatura achatada: {tw}x{th}'

    # 2b. o conteudo tem de preencher o canvas na mesma proporcao de um render
    # de referencia (scale 1, sem transform). Se o pdf.js receber a escala duas
    # vezes, a pagina sai em dpr^2 e so o quadrante superior esquerdo aparece.
    fr = page.evaluate("""async () => {
      const ink = c => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let maxX = -1, maxY = -1;
        for (let y = 0; y < c.height; y++)
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (d[i] < 200 || d[i+1] < 200 || d[i+2] < 200) {
              if (x > maxX) maxX = x; if (y > maxY) maxY = y;
            }
          }
        return [maxX / c.width, maxY / c.height];
      };
      const p = pages[0];
      const pg = await sources[p.src].pdfjsDoc.getPage(p.idx + 1);
      const vp = pg.getViewport({ scale: 1 });
      const ref = document.createElement('canvas');
      ref.width = Math.round(vp.width); ref.height = Math.round(vp.height);
      await pg.render({ canvasContext: ref.getContext('2d'), viewport: vp }).promise;
      return { visor: ink(document.querySelector('#mainCanvas')), ref: ink(ref) };
    }""")
    print(f'2b. tinta visor {fr["visor"]} | referencia {fr["ref"]}')
    assert all(abs(a - b) < 0.02 for a, b in zip(fr['visor'], fr['ref'])), \
        f'PDF cortado no visor: {fr}'

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

    # 3b. a tarja recem-criada ja fica selecionada e a alca a redimensiona
    assert page.locator('#overlay .rect.sel .hnd').count() == 1, 'tarja nova sem alca'
    w0 = page.evaluate("() => pages[0].overlays[0].w")
    hb = page.locator('#overlay .rect.sel .hnd').bounding_box()
    page.mouse.move(hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2)
    page.mouse.down()
    page.mouse.move(hb['x'] + hb['width'] / 2 + 30, hb['y'] + hb['height'] / 2, steps=10)
    page.mouse.up()
    w1 = page.evaluate("() => pages[0].overlays[0].w")
    print(f'3b. tarja redimensionada: {w0:.1f} -> {w1:.1f} pt')
    assert w1 > w0 + 5, 'a alca nao alargou a tarja'
    assert page.locator('#overlay .rect:not(.rubber)').count() == 1, 'a alca criou outra tarja'

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

    # junta com outros PDFs pela fila do "Juntar PDF"
    page.click('#btnMerge')
    page.wait_for_selector('#mergeBack:not([hidden])')
    # a fila avisa que as paginas entram depois do documento ja aberto
    assert 'documento aberto' in page.locator('#mergeInto').inner_text()
    page.keyboard.press('Escape')                       # Esc fecha sem juntar
    page.wait_for_selector('#mergeBack', state='hidden')
    page.click('#btnMerge')
    page.wait_for_selector('#mergeBack:not([hidden])')

    # 6a. soltar o arquivo em cima da caixa entra na fila; o ✕ tira da fila
    import base64
    b64 = base64.b64encode(open(PDF1, 'rb').read()).decode()
    page.evaluate("""([b64, nome]) => {
      const bin = atob(b64), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], nome, { type: 'application/pdf' }));
      document.querySelector('#mergeBack').dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }""", [b64, 'arrastado.pdf'])
    page.wait_for_function("document.querySelectorAll('.merge-item').length === 1")
    assert page.locator('.merge-item .nome').inner_text() == 'arrastado.pdf'
    page.locator('.merge-item .rm').click()
    page.wait_for_function("document.querySelectorAll('.merge-item').length === 0")
    print('6a. soltar na caixa e tirar da fila OK')

    page.set_input_files('#fileMerge', [os.path.join(BASE, 'tests', 'teste-anexo.pdf'),
                                        os.path.join(BASE, 'tests', 'teste-pagina1.pdf')])
    page.wait_for_function("document.querySelectorAll('.merge-item').length === 2")
    nomes = lambda: page.locator('.merge-item .nome').all_inner_texts()
    print('6. fila:', nomes())

    # 6b. reordenar pelo botao (a fila entra na ordem em que os arquivos foram lidos)
    page.locator('.merge-item').nth(1).locator('.mv button', has_text='↑').click()
    print('6b. apos subir o 2o:', nomes())
    assert nomes()[0] == 'teste-pagina1.pdf'

    # 6c. ordenar pelo nome (A-Z e depois Z-A no segundo clique)
    page.click('#mergeSort')
    print('6c. A-Z:', nomes())
    assert nomes() == ['teste-anexo.pdf', 'teste-pagina1.pdf']
    page.click('#mergeSort')
    assert nomes() == ['teste-pagina1.pdf', 'teste-anexo.pdf'], 'Z-A nao inverteu'
    page.click('#mergeSort')  # volta para A-Z: e essa a ordem que sera juntada

    # 6d. filtrar pelo nome esconde as demais linhas (sem tirar ninguem da fila)
    page.fill('#mergeSearch', 'anexo')
    page.wait_for_function("document.querySelectorAll('.merge-item').length === 1")
    assert nomes() == ['teste-anexo.pdf']
    assert not page.locator('#mergeTravado').is_hidden(), 'faltou avisar que a ordem esta travada'
    page.fill('#mergeSearch', '')
    page.wait_for_function("document.querySelectorAll('.merge-item').length === 2")
    print('6d. filtro pelo nome OK')

    # 6e. juntar: 1 (aberta) + 1 (anexo) + 1 (pagina1) = 3 paginas
    page.click('#mergeOk')
    page.wait_for_function("document.querySelectorAll('.thumb').length === 3")
    page.wait_for_selector('#mergeBack', state='hidden')
    with page.expect_download() as dl:
        page.click('#btnExport')
    dl.value.save_as('/tmp/editado-juntado.pdf')
    print('6e. merge concluído, exportado: /tmp/editado-juntado.pdf')

    page.screenshot(path='/tmp/editor-final.png')
    browser.close()

    real_errors = [e for e in errors if 'favicon' not in e]
    if real_errors:
        print('ERROS DE CONSOLE:', real_errors[:5])
        sys.exit(1)
print('E2E OK')
