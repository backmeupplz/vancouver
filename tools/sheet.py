# python3 tools/sheet.py OUT.jpg IMG... [--cols N] [--width W]   (uv run --with pillow python3 tools/sheet.py ...)
import sys, os
from PIL import Image, ImageDraw
a = sys.argv[1:]
def opt(k, d):
    if k in a: i = a.index(k); v = int(a[i + 1]); del a[i:i + 2]; return v
    return d
cols, width = opt('--cols', 3), min(opt('--width', 1600), 1600)
out, imgs = a[0], a[1:]
cols = min(cols, len(imgs)); cw = width // cols; ims = []
for p in imgs:
    im = Image.open(p).convert('RGB'); im = im.resize((cw, round(im.height * cw / im.width))); ims.append((os.path.splitext(os.path.basename(p))[0], im))
rows = [ims[i:i + cols] for i in range(0, len(ims), cols)]; rh = [max(im.height for _, im in r) for r in rows]
sheet = Image.new('RGB', (cw * cols, sum(rh)), 'black'); d = ImageDraw.Draw(sheet); y = 0
for r, h in zip(rows, rh):
    for i, (n, im) in enumerate(r):
        sheet.paste(im, (i * cw, y)); d.rectangle((i * cw, y, i * cw + 7 * len(n) + 8, y + 14), fill='black'); d.text((i * cw + 4, y + 2), n, fill='white')
    y += h
sheet.save(out, quality=80)
print(out, sheet.size)
