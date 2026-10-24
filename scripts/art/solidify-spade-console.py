#!/usr/bin/env python3
"""
solidify-spade-console.py - derive spade-console-v2 from spade-console-v1.

Dan 2026-10-24, on the Tournament Break card: "YOU SHOULDN'T SEE ANYTHING
INSIDE THE FRAME OR IN THE CARD, IT SHOULD BE 100% SOLID ALL THE WAY THROUGH
THE FRAME AND INSIDE OF THE CARD."

The v1 slices were cut with windows inside the frame: the gap between the
outer frame and the header well, the band under the head's chrome rule, the
channels between the rail strands, the chamfered corners, the closing cap and
the glass between the rails. SpadeConsole.css lays the glass tone under the
rectangle between the rails, but nothing reaches the rest, so over a live
felt the seats and their chips showed through the frame itself.

Method, per slice, on the stacked console (head + rails + foot):
  1. "Opaque" is alpha >= 128. The frame's silhouette is closed with a disc of
     radius 4 so the hairline gaps between rail strands count as frame.
  2. Everything reachable from the image border through what is left is the
     outside of the card (grown 2px so the anti-aliased outer edge keeps its
     softness). That is left exactly as v1 ships it.
  3. Every other pixel - the whole inside of the silhouette - is composited
     over the master's glass tone #0a0b0d and set to full alpha. The art on
     top is unchanged; only what was see-through behind it becomes glass.

Two repairs ride along, both from the master's own pixels:
  - bottom-plates.png was cut with its outer left strand broken (rows 0-215
    start at x 17, 21 or 31). The straight side rails of mid.png are laid
    under it down to the closing chamfer.
  - bottom-foot.png's last ten rows are replaced by bottom-plates.png's,
    which match it to the pixel above them (rows 40-51 against 245-256) and
    whose closing rail is not broken.

v1 is never edited: a shipped asset URL keeps its bytes
(tests/unit/pooledRuntimeUrlsAreFrozen.test.ts). Run from the repo root:

    python3 scripts/art/solidify-spade-console.py
"""
import os

import numpy as np
from PIL import Image
from scipy import ndimage

SRC = 'public/assets/club-buttons/console/spade-console-v1'
OUT = 'public/assets/club-buttons/console/spade-console-v2'
GLASS = np.array([10, 11, 13], np.float32)  # #0a0b0d, the head's own well
CLOSE_R = 4
TOPS = ['top', 'top-flat', 'top-diamond', 'top-club', 'top-vip-v2']
FEET = ['bottom-foot', 'bottom-plates']
REPEATS = 6


def load(name):
    return np.array(Image.open(f'{SRC}/{name}.png').convert('RGBA'))


def inside(stack):
    alpha = stack[..., 3]
    opaque = alpha >= 128
    yy, xx = np.mgrid[-CLOSE_R : CLOSE_R + 1, -CLOSE_R : CLOSE_R + 1]
    disc = (xx * xx + yy * yy) <= CLOSE_R * CLOSE_R
    padded = np.pad(opaque, CLOSE_R + 1)
    closed = ndimage.binary_closing(padded, structure=disc)[
        CLOSE_R + 1 : -CLOSE_R - 1, CLOSE_R + 1 : -CLOSE_R - 1
    ] | opaque
    passable = np.pad(~closed, 1, constant_values=True)
    labels, _ = ndimage.label(passable)
    outside = (labels == labels[0, 0])[1:-1, 1:-1]
    outside = ndimage.binary_dilation(outside, iterations=2)
    return (alpha < 255) & ~outside


def solid(img, mask):
    out = img.astype(np.float32)
    a = out[..., 3:4] / 255
    over = out[..., :3] * a + GLASS * (1 - a)
    out[..., :3] = np.where(mask[..., None], over, out[..., :3])
    out[..., 3] = np.where(mask, 255, out[..., 3])
    return out.round().astype(np.uint8)


def save(arr, name):
    Image.fromarray(arr).save(f'{OUT}/{name}.png', optimize=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    mid = load('mid')
    mh = mid.shape[0]

    plates = load('bottom-plates')
    rails = np.zeros_like(plates)
    rows = 216
    tile = np.concatenate([mid] * (rows // mh + 1), 0)[:rows]
    rails[:rows, :74] = tile[:, :74]
    rails[:rows, 924:] = tile[:, 924:]
    under = Image.fromarray(rails)
    under.alpha_composite(Image.fromarray(plates))
    feet = {'bottom-foot': load('bottom-foot'), 'bottom-plates': np.array(under)}

    done = set()
    for top_name in TOPS:
        top = load(top_name)
        h = top.shape[0]
        for foot_name in FEET:
            foot = feet[foot_name]
            stack = np.concatenate([top] + [mid] * REPEATS + [foot], 0)
            mask = inside(stack)
            if top_name not in done:
                save(solid(top, mask[:h]), top_name)
                done.add(top_name)
            if foot_name not in done:
                save(solid(foot, mask[h + mh * REPEATS :]), foot_name)
                done.add(foot_name)
            if 'mid' not in done:
                band = mask[h + mh * (REPEATS // 2) : h + mh * (REPEATS // 2 + 1)]
                save(solid(mid, band), 'mid')
                done.add('mid')

    foot = np.array(Image.open(f'{OUT}/bottom-foot.png').convert('RGBA'))
    plates_out = np.array(Image.open(f'{OUT}/bottom-plates.png').convert('RGBA'))
    foot[52:72] = plates_out[257:277]
    save(foot, 'bottom-foot')


if __name__ == '__main__':
    main()
