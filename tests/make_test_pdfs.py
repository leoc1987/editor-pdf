#!/usr/bin/env python3
"""Gera PDFs mínimos e válidos para teste do editor."""
import os

def build(pages_text, path):
    objs = []          # (num, body)
    n_pages = len(pages_text)
    kids = " ".join(f"{3 + i*2} 0 R" for i in range(n_pages))
    objs.append((1, "<< /Type /Catalog /Pages 2 0 R >>"))
    objs.append((2, f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>"))
    font_num = 3 + n_pages * 2
    for i, txt in enumerate(pages_text):
        pg, ct = 3 + i * 2, 4 + i * 2
        esc = txt.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        lines = esc.split("\n")
        tj = " 0 -30 Td ".join(f"({l}) Tj" if k else f"({l}) Tj" for k, l in enumerate(lines))
        stream = f"BT /F1 {16} Tf 72 720 Td {tj} ET".encode()
        objs.append((pg, f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] "
                         f"/Resources << /Font << /F1 {font_num} 0 R >> >> /Contents {ct} 0 R >>"))
        objs.append((ct, f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream"))
    objs.append((font_num, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"))

    out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets = {}
    for num, body in sorted(objs):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + (body.encode("latin-1") if isinstance(body, str) else body) + b"\nendobj\n"
    maxnum = max(offsets)
    xref_pos = len(out)
    out += f"xref\n0 {maxnum+1}\n0000000000 65535 f \n".encode()
    for n in range(1, maxnum + 1):
        out += f"{offsets[n]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {maxnum+1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    with open(path, "wb") as f:
        f.write(out)
    print(path, os.path.getsize(path), "bytes")

base = os.path.dirname(os.path.abspath(__file__))
build(["DOCUMENTO DE TESTE - DPCI\nCPF DO SUJEITO: 123.456.789-00 DADO SENSIVEL AQUI\nNome: FULANO DE TAL (sigilo)"],
      os.path.join(base, "teste-pagina1.pdf"))
build(["PAGINA 2 - informacao publica, sem sigilo"], os.path.join(base, "teste-anexo.pdf"))
