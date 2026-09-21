#!/usr/bin/env python3
"""Look inside a PDF: outline (table of contents), page text, page images.

    inspect_pdf.py toc    <pdf> [max_entries]           bookmarks: level, title, page   (Part -> page ranges for Phase 5)
    inspect_pdf.py parts  <pdf>                         top-level bookmarks with page ranges (the DCP's Parts)
    inspect_pdf.py find   <pdf> <term>                  which pages contain a word (case-insensitive)
    inspect_pdf.py text   <pdf> <page> [chars]          extracted text of one page (1-based)
    inspect_pdf.py render <pdf> <out_dir> <dpi> <p>...  PNG of the listed pages (1-based); `all` renders every page

Runs in the WSL venv (PyMuPDF): wsl --cd <project> -- bash scripts/py.sh scripts/inspect_pdf.py ...
"""
import os
import sys

import fitz


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    cmd, path = argv[1], argv[2]
    doc = fitz.open(path)
    if cmd == "toc":
        toc = doc.get_toc()
        limit = int(argv[3]) if len(argv) > 3 else 120
        print(f"{doc.page_count} pages, {len(toc)} bookmarks")
        for level, title, page in toc[:limit]:
            print(f"{'  ' * (level - 1)}{title.strip()[:90]}  -> p{page}")
    elif cmd == "parts":
        top = [(t.strip(), p) for level, t, p in doc.get_toc() if level == 1]
        for i, (title, start) in enumerate(top):
            end = top[i + 1][1] - 1 if i + 1 < len(top) else doc.page_count
            print(f"p{start:>3}-{end:<3} ({end - start + 1:>3} pages)  {title[:80]}")
    elif cmd == "find":
        term = argv[3].lower()
        hits = [(i + 1, doc[i].get_text("text").lower().count(term)) for i in range(doc.page_count)]
        hits = [(p, n) for p, n in hits if n]
        print(f"'{term}' appears on {len(hits)} pages: " + ", ".join(f"p{p}(x{n})" for p, n in hits[:40]))
    elif cmd == "text":
        page = doc[int(argv[3]) - 1]
        limit = int(argv[4]) if len(argv) > 4 else 1500
        print(page.get_text("text")[:limit])
    elif cmd == "render":
        out_dir, dpi = argv[3], int(argv[4])
        os.makedirs(out_dir, exist_ok=True)
        wanted = [str(n) for n in range(1, doc.page_count + 1)] if argv[5:] == ["all"] else argv[5:]
        for p in wanted:
            out = os.path.join(out_dir, f"p{int(p):04d}.png")
            doc[int(p) - 1].get_pixmap(dpi=dpi).save(out)
            print(out)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
