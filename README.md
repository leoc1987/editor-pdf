# Editor de PDF — DPCI

Editor de PDF **100% no navegador**: o arquivo nunca é enviado a nenhum servidor.
Feito para ocultação de dados sensíveis e organização de documentos na Polícia Científica de Goiás.

**Usar online:** https://leoc1987.github.io/editor-pdf/

## Funções

- ✂️ **Excluir páginas** (botão ✕ na miniatura)
- ➕ **Adicionar páginas** em branco ou juntar outros PDFs ("Juntar PDF")
- 🔀 **Reordenar** arrastando as miniaturas
- 🖍️ **Tarja** sobre dados sensíveis, com dois modos:
  - *Tarja normal*: cobertura visual rápida
  - ☑️ *Tarja definitiva* (no momento de exportar): rasteriza a página — o texto ocultado **deixa de existir** no arquivo gerado (nada fica selecionável/copiável)
- 🔤 **Inserir texto** (selos, carimbos, correções)

## Como usar

1. Abra o endereço acima (ou o `index.html` local — funciona offline)
2. "Abrir PDF" → edite → "Exportar PDF"

## Privacidade

Sem servidor, sem banco de dados, sem telemetria. Todo processamento acontece
na sua máquina via JavaScript (bibliotecas pdf.js e pdf-lib embutidas no repositório).
Recomendação: use a **tarja definitiva** sempre que o documento for circular fora do ambiente de sigilo.

## Testes

```
python3 tests/make_test_pdfs.py        # gera PDFs de teste
python3 -m http.server 8093            # serve o editor
python3 tests/e2e.py                   # suíte ponta-a-ponta (Playwright)
python3 tests/e2e_parte2.py            # texto, página em branco, excluir
```

---

Desenvolvido por @leoc1987 · MIT
