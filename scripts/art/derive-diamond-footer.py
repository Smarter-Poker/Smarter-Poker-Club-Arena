"""Derive the Diamond Arena footer frame from the approved chip footer master.

Technique (club-arena-console skill, section 5): the interior well is quilted
leather, a periodic texture, so a clean stretch between two painted icons is
tiled across the well with a short crossfade at each seam, row for row so the
vertical vignette survives exactly, and brightness matched to the master's own
horizontal profile so the well stays one tone. The chrome rim, corners and
gutter are untouched. Nothing is drawn.
"""
import sys
import numpy as np
from PIL import Image

SRC, OUT = sys.argv[1], sys.argv[2]
im = Image.open(SRC).convert('RGBA')
a = np.array(im).astype(np.float32)
g = a[:, :, :3].mean(axis=2)
H, W = g.shape

Y0, Y1 = 29, 231          # interior well rows (inside the top and bottom rims)
X0, X1 = 92, 1828         # interior columns, clear of the rounded corners
SX0, SX1 = 640, 757       # clean quilt stretch between Players and Cashier (3 quilt periods)
FADE = 12

# Horizontal brightness profile of the master, from its clean stretches.
clean = [(92, 170), (640, 760), (930, 1030), (1225, 1340), (1490, 1590), (1770, 1828)]
cx = np.array([(x0 + x1) / 2 for x0, x1 in clean])
cv = np.array([g[40:220, x0:x1].mean() for x0, x1 in clean])
profile = np.interp(np.arange(W), cx, cv)
src_mean = g[40:220, SX0:SX1].mean()

src = a[Y0:Y1, SX0:SX1, :].copy()      # rows x 117 x 4
tw = src.shape[1]
out = a.copy()

# Lay tiles left to right with a linear crossfade over FADE columns.
x = X0
prev = None
filled = np.zeros((Y1 - Y0, X1 - X0, 4), dtype=np.float32)
weight = np.zeros((Y1 - Y0, X1 - X0), dtype=np.float32)
while x < X1:
    w = min(tw, X1 - x)
    tile = src[:, :w, :]
    ramp = np.ones(w, dtype=np.float32)
    if x > X0:
        ramp[:FADE] = np.linspace(0, 1, FADE)
    if x + w < X1:
        ramp[-FADE:] = np.minimum(ramp[-FADE:], np.linspace(1, 0, FADE))
    filled[:, x - X0:x - X0 + w, :] += tile * ramp[None, :, None]
    weight[:, x - X0:x - X0 + w] += ramp[None, :]
    x += tw - FADE
filled /= np.maximum(weight, 1e-6)[:, :, None]

# Brightness match to the master's own horizontal profile (RGB only).
scale = (profile[X0:X1] / src_mean).astype(np.float32)
filled[:, :, :3] *= scale[None, :, None]
filled[:, :, 3] = a[Y0:Y1, X0:X1, 3]

# Feather into the untouched master at both ends of the well.
edge = np.ones(X1 - X0, dtype=np.float32)
edge[:FADE] = np.linspace(0, 1, FADE)
edge[-FADE:] = np.linspace(1, 0, FADE)
region = out[Y0:Y1, X0:X1, :]
out[Y0:Y1, X0:X1, :] = region * (1 - edge)[None, :, None] + filled * edge[None, :, None]

out = np.clip(out, 0, 255).astype(np.uint8)
Image.fromarray(out, 'RGBA').save(OUT, lossless=True, method=6)
print('wrote', OUT, out.shape)
