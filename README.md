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
- 🖱️ **Rolar entre as páginas**: a roda do mouse rola a página aberta e, chegando ao fim,
  passa para a seguinte (no topo, volta para a anterior). Descendo, entra pelo topo da página nova;
  subindo, pelo rodapé — a leitura continua de onde parou. Em "Página inteira", onde não há o que
  rolar, cada rolagem já vira a página
- 🖍️ **Tarja** sobre dados sensíveis, com dois modos:
  - *Tarja normal*: cobertura visual rápida
  - ☑️ *Tarja definitiva* (no momento de exportar): rasteriza a página — o texto ocultado **deixa de existir** no arquivo gerado (nada fica selecionável/copiável)
- 🖍️ **Destaque** amarelo sobre o texto, no estilo marca-texto. Arraste sobre o trecho:
  o amarelo **se ajusta sozinho às linhas** do documento, sem precisar acertar a caixa à mão,
  e nunca atravessa a calha entre as duas colunas. Um clique destaca a linha inteira.
  O texto por baixo **continua legível e selecionável** no arquivo exportado (ao contrário da tarja, que cobre).
  Em página escaneada, sem texto, a ferramenta vira caixa arrastada
- 🔤 **Inserir texto** (selos, carimbos, correções)
- 🖱️ **Ajustar o que já foi inserido**: clique na tarja, no destaque ou no texto para selecionar — arraste para mover,
  use a alça do canto para redimensionar (no texto, muda o corpo da letra), <kbd>Del</kbd> ou o ✕ exclui.
  No texto, o duplo clique reabre a caixa para corrigir o que está escrito.
- 🧹 **Apagar em conjunto**: um destaque feito num arrasto é **um só** — clicar em qualquer linha dele
  seleciona a marcação inteira, e <kbd>Del</kbd> apaga tudo de uma vez.
  Para limpar vários de uma vez: com a ferramenta em "Nenhuma", **arraste um laço** sobre a região
  (o que encostar nele entra na seleção), use <kbd>Shift</kbd>+clique para somar ou tirar trechos,
  ou <kbd>Ctrl</kbd>+<kbd>A</kbd> para marcar tudo o que foi inserido na página.

## Publicações do Diário Oficial (DPCI)

O botão **Publicações** localiza sozinho as matérias da Polícia Científica na edição aberta
e gera **um arquivo por publicação**, cada um com apenas aquela publicação destacada —
no lugar do ciclo manual de destacar, salvar, apagar o destaque, destacar a próxima e salvar de novo.

- **Como encontra**: o Diário abre a seção de cada órgão com uma barra amarela (`#FFCC00`) e
  delimita cada matéria com marcadores invisíveis (`<#ABC#…>`). Procurar a seção pela barra,
  e não pelo texto, ignora por construção as menções a "Diretoria da Polícia Científica"
  no corpo de publicações da SSP. Os marcadores acompanham a matéria **atravessando colunas e páginas**,
  então uma portaria que vira a página sai inteira
- **Nome do arquivo**: montado a partir do número da edição e do título da matéria —
  `DOE 24867 - Portaria 060 - GAB`. Serve para qualquer tipo (`Extrato de Despacho`, etc.)
  e **é editável** linha a linha antes de exportar
- **Corte de páginas**: o painel sugere a primeira e a última página da seção, as duas editáveis,
  e o botão "Excluir as demais" tira o resto do Diário de uma vez
- **Escopo de cada arquivo**: por padrão sai só a página da publicação (as duas, se ela virar a página);
  desmarcando a opção do rodapé, cada arquivo leva todas as páginas mantidas

Se a edição do dia não tiver publicação nossa, ou se o Diário mudar de formato, o painel avisa
e o destaque manual continua disponível.

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
