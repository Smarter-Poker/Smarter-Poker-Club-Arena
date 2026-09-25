"""Derive the Diamond Spins selector holder and pointer (owner ruling 2026-09-21, R5).

The approved selector mount (wheel-selector-mount-v1.png, 2081 x 755) carries
two long side arcs whose curvature is about twice as tight as the wheel rim, so
their ends dive into the prize cards. The owner wants ONLY the centre holder:
the hub disc, its two hinge clamps and the stub of arm that carries the blue
light into them. Nothing is drawn: the holder is cut from the master around
the hub's own axis and the two cuts are feathered over a short horizontal ramp
so no hard edge or matte shows where the arcs used to continue.

The pointer (wheel-selector-matte-v1.png, 1024 x 1536, 1.86 MB) rendered as a
26 x 39 unit sprite through an SVG feDropShadow and an animated CSS filter. It
ships here at sprite scale with that shadow baked into its own alpha, plus a
second "glow" frame (the 50% keyframe of the old selector-reflection filter:
brightness 1.14 and a blue halo) that the wheel cross-fades with opacity only.

  python3 scripts/art/derive-wheel-selector.py public/assets/diamond-spins

Outputs (append-only origin: new filenames, v1 files untouched):
  wheel-selector-holder-v2.png        holder only, 520 x 310, hub axis at x=260
  wheel-selector-pointer-v2.png       pointer with baked shadow, 42 x 59 units at 10 px/unit
  wheel-selector-pointer-glow-v2.png  the lit frame, same canvas
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

OUT = sys.argv[1] if len(sys.argv) > 1 else 'public/assets/diamond-spins'

# ── Holder ────────────────────────────────────────────────────────────────────
# Column profile of the master (alpha > 40): the hub top rises from y=158 at
# x=920 to y=110 at x=1030..1050 and falls back by x=1160, so the axis is
# x=1040. The hinge clamps end near x=890 and x=1190; the arm's blue channel
# turns into its chevron at x=790 and x=1290. Cutting at 780..1300 keeps both
# clamps whole with the run of channel into them and leaves the arcs behind,
# which is the extent of the owner's reference crop.
HUB_X = 1040
HALF = 260
Y0, Y1 = 104, 414
FEATHER = 36  # px of alpha ramp at each cut

mount = Image.open(os.path.join(OUT, 'wheel-selector-mount-v1.png')).convert('RGBA')
holder = np.array(mount.crop((HUB_X - HALF, Y0, HUB_X + HALF, Y1))).astype(np.float32)
ramp = np.ones(holder.shape[1], dtype=np.float32)
ramp[:FEATHER] = np.linspace(0, 1, FEATHER, endpoint=False)
ramp[-FEATHER:] = np.linspace(1, 0, FEATHER, endpoint=False)
holder[:, :, 3] *= ramp[None, :]
Image.fromarray(np.clip(holder, 0, 255).astype(np.uint8)).save(
    os.path.join(OUT, 'wheel-selector-holder-v2.png'), optimize=True
)

# ── Pointer ───────────────────────────────────────────────────────────────────
# The sprite is 26 x 39 wheel units; ship 10 px per unit (260 x 390), which is
# 3x its largest CSS size. The old SVG filter was feDropShadow dy=8 std=7
# opacity .9 on a filter region of -30%..130% x / -30%..140% y, plus a CSS
# drop-shadow(0 3px 2px rgba(0,0,0,.8)). Both are baked at the same scale on a
# padded canvas: 8 units each side, 4 above, 16 below -> 42 x 59 units.
PX = 10
UNITS_W, UNITS_H = 26, 39
PAD_L, PAD_T, PAD_R, PAD_B = 8, 4, 8, 16
canvas_w, canvas_h = (UNITS_W + PAD_L + PAD_R) * PX, (UNITS_H + PAD_T + PAD_B) * PX

source = Image.open(os.path.join(OUT, 'wheel-selector-matte-v1.png')).convert('RGBA')
sprite = source.resize((UNITS_W * PX, UNITS_H * PX), Image.LANCZOS)


def shadow(alpha, dx, dy, sigma, colour, opacity):
    layer = Image.new('RGBA', (canvas_w, canvas_h), colour + (0,))
    mask = Image.new('L', (canvas_w, canvas_h), 0)
    mask.paste(alpha, (PAD_L * PX + dx, PAD_T * PX + dy))
    mask = mask.filter(ImageFilter.GaussianBlur(sigma))
    mask = mask.point(lambda v: int(v * opacity))
    layer.putalpha(mask)
    return layer


def compose(base, glow_blue):
    alpha = base.getchannel('A')
    out = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    # feDropShadow on the pointer group.
    out.alpha_composite(shadow(alpha, 0, 8 * PX, 7 * PX, (0, 0, 0), 0.9))
    if glow_blue:
        # selector-reflection at 50%: drop-shadow(0 3px 3px rgb(31 142 255 / 45%))
        out.alpha_composite(shadow(alpha, 0, 3 * PX, 3 * PX, (31, 142, 255), 0.45))
    else:
        # .selectorCrystal at rest: drop-shadow(0 3px 2px rgb(0 0 0 / 80%))
        out.alpha_composite(shadow(alpha, 0, 3 * PX, 2 * PX, (0, 0, 0), 0.8))
    out.alpha_composite(base, (PAD_L * PX, PAD_T * PX))
    return out


compose(sprite, False).save(os.path.join(OUT, 'wheel-selector-pointer-v2.png'), optimize=True)

lit = np.array(sprite).astype(np.float32)
lit[:, :, :3] = np.clip(lit[:, :, :3] * 1.14, 0, 255)  # brightness(1.14)
compose(Image.fromarray(lit.astype(np.uint8)), True).save(
    os.path.join(OUT, 'wheel-selector-pointer-glow-v2.png'), optimize=True
)

for name in ('wheel-selector-holder-v2', 'wheel-selector-pointer-v2', 'wheel-selector-pointer-glow-v2'):
    path = os.path.join(OUT, name + '.png')
    im = Image.open(path)
    print(name, im.size, os.path.getsize(path), 'bytes')
