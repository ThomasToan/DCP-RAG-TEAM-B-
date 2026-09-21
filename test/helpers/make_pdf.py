#!/usr/bin/env python3
"""Build a 5-page PDF with a KNOWN answer for pdf_stats.py. Usage: make_pdf.py <out.pdf>"""
import sys

import fitz

doc = fitz.open()

# 1  text-heavy page: plenty of text, nothing else
p = doc.new_page()
p.insert_textbox(fitz.Rect(50, 50, 545, 790), "lorem ipsum dolor sit amet " * 200, fontsize=9)

# 2  a big image (500x500 px placed over ~62% of the page) and one caption line
p = doc.new_page()
pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 500, 500), False)
pix.set_rect(pix.irect, (200, 30, 30))
p.insert_image(fitz.Rect(40, 100, 555, 700), pixmap=pix)
p.insert_text((50, 60), "Figure 3: setback", fontsize=12)

# 3  blank page (a divider or cover)
doc.new_page()

# 4  vector diagram: 60 lines and a 7-character caption, no raster at all
p = doc.new_page()
for i in range(60):
    p.draw_line((50 + i * 8, 100), (50 + i * 8, 400))
p.insert_text((50, 60), "Diagram", fontsize=12)

# 5  text-heavy page with a small 100x100 icon: the icon must NOT count as a big raster
p = doc.new_page()
p.insert_textbox(fitz.Rect(50, 150, 545, 790), "lorem ipsum dolor sit amet " * 150, fontsize=9)
icon = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 100, 100), False)
icon.set_rect(icon.irect, (30, 30, 200))
p.insert_image(fitz.Rect(50, 40, 100, 90), pixmap=icon)

doc.save(sys.argv[1])
