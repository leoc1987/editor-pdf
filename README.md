# Editor de PDF — DPCI

Editor de PDF **100% no navegador**: o arquivo nunca é enviado a nenhum servidor.
Feito para ocultação de dados sensíveis e organização de documentos na Polícia Científica de Goiás.

**Usar online:** https://leoc1987.github.io/editor-pdf/

## Funções

- ✂️ **Excluir páginas** (botão ✕ na miniatura). A confirmação traz a opção **"Não perguntar de novo nesta sessão"** — marcada, as próximas exclusões saem direto (volta a perguntar ao recarregar a página)
- ➕ **Adicionar páginas** em branco ou inserir outro PDF numa posição (botão "+" da miniatura)
- 🧩 **Juntar PDF**: monta uma fila com os arquivos escolhidos (arrastando para a caixa ou pelo seletor).
  Cada arquivo vira uma linha com nome, nº de páginas e tamanho — **a ordem da lista é a ordem do documento final**.
  Dá para reordenar arrastando a linha ou pelas setas ↑ ↓, **ordenar pelo nome** (A–Z / Z–A, com "Laudo 2" antes de "Laudo 10")
  e **filtrar pelo nome** para achar um arquivo no meio de muitos.
  O rodapé da lista mostra o **tamanho final estimado** (soma dos arquivos com o documento aberto);
  depois de exportar, o aviso traz o tamanho real
- 🔀 **Reordenar** arrastando as miniaturas
- 🖍️ **Tarja** sobre dados sensíveis, com dois modos:
  - *Tarja normal*: cobertura visual rápida
  - ☑️ *Tarja definitiva* (no momento de exportar): rasteriza a página — o texto ocultado **deixa de existir** no arquivo gerado (nada fica selecionável/copiável)
- 🔤 **Inserir texto** (selos, carimbos, correções)
- 🖱️ **Ajustar o que já foi inserido**: clique na tarja ou no texto para selecionar — arraste para mover,
  use a alça do canto para redimensionar (no texto, muda o corpo da letra), <kbd>Del</kbd> ou o ✕ exclui.
  No texto, o duplo clique reabre a caixa para corrigir o que está escrito.

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
python3 tests/e2e_parte2.py            # texto: inserir, mover, redimensionar, excluir, editar
python3 tests/e2e_tamanho.py           # o PDF exportado não pode inflar (recursos repetidos)
```

---

Desenvolvido por @leoc1987 · MIT
