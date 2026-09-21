#!/usr/bin/env python3
"""Raw per-page text / image / drawing numbers for ONE pdf, written as JSON.

    pdf_stats.py <in.pdf> <out.json>

Runs in the WSL venv (PyMuPDF). rank_dcps.js calls it once per PDF.

Per page we record  [chars, big_rasters, raster_coverage, drawings]:
  chars            non-whitespace characters of extractable text
  big_rasters      images at least 200x200 px (icons and logos do not count)
  raster_coverage  share of the page covered by those big images (0..1, capped)
  drawings         vector paths on the page (many DCP diagrams are vector, not raster)

No scoring happens here on purpose. What counts as "image-dominated" is defined once, in scripts/lib/score.js,
so the definition can be changed and re-run without re-reading a single PDF.
"""
import json
import sys
import time

import fitz  # PyMuPDF

MIN_SIDE = 200  # px, per the exercise: "raster image larger than 200x200"


def page_row(page):
    area = page.rect.width * page.rect.height
    text = page.get_text("text")
    chars = sum(1 for ch in text if not ch.isspace())
    big = 0
    covered = 0.0
    for im in page.get_image_info():
        if im.get("width", 0) >= MIN_SIDE and im.get("height", 0) >= MIN_SIDE:
            big += 1
            x0, y0, x1, y1 = im["bbox"]
            covered += max(0.0, x1 - x0) * max(0.0, y1 - y0)
    coverage = min(covered / area, 1.0) if area else 0.0
    drawings = len(page.get_cdrawings())
    return [chars, big, round(coverage, 3), drawings]


def main(pdf_path, out_path):
    started = time.time()
    result = {"file": pdf_path, "status": "ok"}
    try:
        doc = fitz.open(pdf_path)
        # PyMuPDF also opens .md/.txt/.html/.epub as "documents"; an HTML error page saved as .pdf must not be ranked
        if not doc.is_pdf:
            raise RuntimeError("not a PDF")
        if doc.needs_pass:
            raise RuntimeError("encrypted")
        meta = doc.metadata or {}
        result.update(
            creator=(meta.get("creator") or "").strip(),
            producer=(meta.get("producer") or "").strip(),
            page_count=doc.page_count,
        )
        rows = []
        for page in doc:
            try:
                rows.append(page_row(page))
            except Exception:  # one bad page must not lose the whole document
                rows.append([0, 0, 0.0, 0])
        result["page_stats"] = rows
    except Exception as e:  # corrupt / encrypted / not a pdf
        result["status"] = "error"
        result["error"] = f"{type(e).__name__}: {e}"
    result["seconds"] = round(time.time() - started, 1)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f)
    print(f"{result['status']}  pages={result.get('page_count')}  {result['seconds']}s")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
