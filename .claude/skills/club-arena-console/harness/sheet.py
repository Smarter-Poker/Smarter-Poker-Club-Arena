"""Build the before/after sheet Dan reviews.

    python3 sheet.py out.jpg 760 "Rebuy Popup:/tmp/before/rebuy.png:/tmp/after/rebuy.png" ...

Each argument after the height is TITLE:BEFORE:AFTER (AFTER may be omitted for a
single-column sheet). Shots are trimmed to their content, scaled to one height
and pasted on black, because a surface floating in a full-page screenshot is
impossible to judge.
"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Linux first, then the Mac - this runs on both. A missing font used to leave
# FONT as None and the crash named `truetype`, not the font list.
FONT = None
for p in ('/root/.fonts/inter.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          '/System/Library/Fonts/Supplemental/Arial.ttf',
          '/System/Library/Fonts/Helvetica.ttc'):
    try:
        ImageFont.truetype(p, 12); FONT = p; break
    except Exception:
        pass
if FONT is None:
    sys.exit('sheet.py: no usable font on this machine. Add one to the list at '
             'the top of this file; do not guess a path that is not there.')

def trim(path, pad=16):
    im = Image.open(path).convert('RGB')
    a = np.array(im.convert('L')); ys, xs = np.where(a > 16)
    return im.crop((max(0, xs.min() - pad), max(0, ys.min() - pad),
                    min(im.width, xs.max() + pad), min(im.height, ys.max() + pad)))

def main():
    out, h, items = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
    f26 = ImageFont.truetype(FONT, 26); f18 = ImageFont.truetype(FONT, 18)
    rows = []
    for it in items:
        title, *paths = it.split(':')
        ims = [trim(p) for p in paths if p]
        ims = [im.resize((int(im.width * h / im.height), h)) for im in ims]
        w = sum(i.width for i in ims) + 40 * len(ims)
        row = Image.new('RGB', (w, h + 80), (0, 0, 0)); d = ImageDraw.Draw(row)
        d.text((20, 16), title, fill=(228, 231, 236), font=f26)
        labels = ['BEFORE', 'AFTER'] if len(ims) == 2 else ['']
        x = 20
        for im, lab in zip(ims, labels):
            d.text((x, 50), lab, fill=(69, 173, 255) if lab == 'AFTER' else (154, 165, 179), font=f18)
            row.paste(im, (x, 76)); x += im.width + 40
        rows.append(row)
    W = max(r.width for r in rows)
    sheet = Image.new('RGB', (W, sum(r.height for r in rows) + 16 * len(rows)), (0, 0, 0))
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height + 16
    sheet.save(out, quality=90)
    print(out, sheet.size)

main()
