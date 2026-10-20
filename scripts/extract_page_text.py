#!/usr/bin/env python3
"""Write the text layer of every DCP page, for keyword search alongside the image search.

    python scripts/extract_page_text.py <council> <pdf>     -> src/lib/server/page_text/<council>.json

Output: a JSON list, item i = text of PDF page i + 1, whitespace collapsed. Run in the WSL venv (PyMuPDF).
Pages whose words are only in a picture (scanned tables, maps) have little or no text; the image search covers those.
"""
import json
import os
import re
import sys

import fitz

council, pdf = sys.argv[1], sys.argv[2]
doc = fitz.open(pdf)
texts = [re.sub(r'\s+', ' ', page.get_text()).strip() for page in doc]
os.makedirs('src/lib/server/page_text', exist_ok=True)
out = f'src/lib/server/page_text/{council}.json'
json.dump(texts, open(out, 'w', encoding='utf-8'), ensure_ascii=False)
empty = sum(1 for t in texts if len(t) < 200)
print(f'{council}: {len(texts)} pages, {sum(map(len, texts))} characters, {empty} pages with under 200 characters -> {out}')
