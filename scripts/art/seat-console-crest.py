#!/usr/bin/env python3
"""
Seat a painted crest into the spade console head.

    python3 scripts/art/seat-console-crest.py <crest.png> <name> [height] [top] [max_w]

Reads  public/assets/club-buttons/console/spade-console-v1/top.png       (the master)
       public/assets/club-buttons/console/spade-console-v1/top-flat.png  (rails bridged)
Writes public/assets/club-buttons/console/spade-console-v1/top-<name>.png

The crest is a standalone painted object on a transparent field (see
source/README.md for how it is painted). It is scaled to the master's crest
height, centred on the head's axis, and the rails are re-mitred into it: the
master's own chrome mitre is carried along every row so its face sits a
hairline off the crest's edge, whatever the crest's shape. The crest then
throws a soft shadow on the glass and sits over everything. Outside the crest
window the head is pixel-identical to the master. Dan, 2026-09-09: "every icon
needs its own custom holder like the spade has" - so no crest reuses another's.
"""
import sys, os, numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter, label, binary_fill_holes

KIT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                   'public', 'assets', 'club-buttons', 'console', 'spade-console-v1')
W, H = 1000, 348
RAIL_TOP, RAIL_BOT = 33, 93        # the rows the rails occupy
M_EDGE_Y0, M_SLOPE, Y0 = 478.7, -0.884, 36   # the master crest's left edge at the rail line, and its lean
M_GAP = 2.8                        # the master's hairline between rail end and crest

def load(p):
    return np.array(Image.open(p).convert('RGBA')).astype(float)

def lift(rgba):
    """The crest and only the crest: the largest solid body on the transparent field."""
    a = np.asarray(rgba).astype(float)
    al = a[..., 3] > 100
    lab, n = label(al)
    sizes = np.bincount(lab.ravel()); sizes[0] = 0
    keep = binary_fill_holes(lab == sizes.argmax())
    out = a.copy(); out[..., 3] = np.where(keep, a[..., 3], 0)
    ys, xs = np.where(keep)
    return out[ys.min():ys.max()+1, xs.min():xs.max()+1]

def place(crest, height, cx=499.0, top=10.0, max_w=200.0):
    h0, w0 = crest.shape[:2]
    k = min(height/h0, max_w/w0)
    im = Image.fromarray(np.clip(crest, 0, 255).astype(np.uint8), 'RGBA')
    im = im.resize((max(1, int(round(w0*k))), max(1, int(round(h0*k)))), Image.LANCZOS)
    full = np.zeros((H, W, 4))
    x0 = int(round(cx - im.size[0]/2)); y0 = int(round(top))
    full[y0:y0+im.size[1], x0:x0+im.size[0]] = np.asarray(im).astype(float)
    return full

def junction(flat, master, al, gap=1.6, blend=90.0):
    """Re-mitre the rails into this crest, row by row."""
    out = flat.copy()
    xs_all = np.arange(W, dtype=float)
    for side in (-1, 1):
        for y in range(RAIL_TOP - 3, RAIL_BOT + 5):
            row = np.where(al[y])[0]
            if len(row) == 0:
                continue
            ex = float(row.min()) if side < 0 else float(row.max())
            mcap = M_EDGE_Y0 - M_GAP + M_SLOPE*(y - Y0)
            Lx = xs_all if side < 0 else (999.0 - xs_all)
            L_ex = ex if side < 0 else (999.0 - ex)
            capL = L_ex - gap
            sx = Lx + (mcap - capL)
            sxm = np.clip(sx if side < 0 else (999.0 - sx), 0, W - 1.001)
            x0 = sxm.astype(int); f = (sxm - x0)[:, None]
            samp = master[y, x0]*(1 - f) + master[y, np.minimum(x0 + 1, W - 1)]*f
            half = (xs_all < 499.5) if side < 0 else (xs_all >= 499.5)
            near = np.clip((Lx - (capL - 170.0))/blend, 0, 1)
            w = (half & (Lx <= capL + 0.5))*near
            out[y] = out[y]*(1 - w)[:, None] + samp*w[:, None]
            out[y, half & (Lx > capL) & (Lx < L_ex), 3] = 0.0
    return out

def seat(crest_full, flat, master, gap=1.6):
    al = crest_full[..., 3] > 150
    img = junction(flat, master, al, gap)
    yy = np.mgrid[0:H, 0:W][0].astype(float)
    sh = gaussian_filter(np.roll(crest_full[..., 3]/255.0, 7, axis=0), 5.0)
    sh = np.clip(sh*1.4, 0, 1)*np.clip((yy - (RAIL_BOT - 10))/14.0, 0, 1)
    sh = sh*(img[..., 3] > 8)*(1 - al)
    img[..., :3] = img[..., :3]*(1 - 0.62*sh)[..., None]
    ca = crest_full[..., 3:4]/255.0
    rgb = img[..., :3]*(1 - ca) + crest_full[..., :3]*ca
    a = np.maximum(img[..., 3], crest_full[..., 3])
    return Image.fromarray(np.clip(np.concatenate([rgb, a[..., None]], -1), 0, 255).astype(np.uint8), 'RGBA')

if __name__ == '__main__':
    src, name = sys.argv[1], sys.argv[2]
    height = float(sys.argv[3]) if len(sys.argv) > 3 else 150.0
    top = float(sys.argv[4]) if len(sys.argv) > 4 else 10.0
    max_w = float(sys.argv[5]) if len(sys.argv) > 5 else 200.0
    master = load(os.path.join(KIT, 'top.png')); flat = load(os.path.join(KIT, 'top-flat.png'))
    crest = place(lift(load(src)), height, top=top, max_w=max_w)
    out = os.path.join(KIT, f'top-{name}.png')
    seat(crest, flat, master).save(out)
    print('wrote', out)
