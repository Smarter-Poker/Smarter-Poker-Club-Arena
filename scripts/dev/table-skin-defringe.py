#!/usr/bin/env python3
"""
REMOVE THE WHITE EDGING FROM A TABLE SKIN (2026-08-29)

Dan: "ALL THAT WHITE EDGING AROUND THE TABLES MUST NEVER BE THERE EITHER."

WHAT IT IS. Seven of the fourteen skins were exported from a tool that
composited them against WHITE and then wrote an alpha channel. The fully
opaque interior is fine, but every partially transparent pixel on the
silhouette kept its white RGB. Over the app's dark background those pixels
composite as a white halo tracing the whole table.

It is measurable rather than a matter of taste -- count the pixels with
12 < alpha < 243 and ask how many are near-white:

    golden sand       89.1%        crimson            0.0%
    carbon red        81.2%        final table        0.0%
    amethyst cavern   74.0%        ice cavern         0.0%
    carbon ion        65.6%        mahogany red       0.0%
    jade city         57.3%        neon city          0.0%
    electric purple   50.8%        ocean blue         0.0%
    classic green     40.6%        arctic white       0.6% (a white table)

WHAT THIS DOES. It does NOT redraw anything and it does NOT touch alpha, so
the silhouette, the soft edge and the artwork are bit-identical where they
were already right. It only replaces the COLOUR of edge pixels with the
colour bleeding outward from the nearest fully opaque pixels -- the standard
fix for a matte fringe. An edge pixel then carries the table's own colour at
whatever transparency it already had, and composites to a soft edge instead
of a white line.

WHY NOT JUST PREMULTIPLY. Premultiplied alpha fixes the halo only if the
renderer expects premultiplied input; the browser does not. Bleeding the
colour is correct for straight alpha, which is what a PNG carries.

USAGE
    python3 scripts/dev/defringe-table-skins.py [--apply] [--only NAME ...]

Prints the before/after fringe measurement for every skin. Without --apply it
writes nothing.
"""
import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image

SKIN_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'assets', 'tables')

# A pixel is "edge" when it is neither clearly inside nor clearly outside.
EDGE_LO, EDGE_HI = 12, 243
# "Solid" enough to be a trustworthy colour source.
SOLID = 250
# Near-white, for the measurement only.
WHITE = 190
# How far the bleed is allowed to reach. The fringe is one or two pixels wide;
# 8 is slack, and a pixel with no solid neighbour inside it is left alone
# rather than guessed at.
MAX_RADIUS = 8

# THE COLOUR SOURCE IS ONE PIXEL DEEPER THAN "SOLID". Measured: bleeding from
# the first fully-opaque ring leaves a third of the halo behind, because on
# these exports that ring is ITSELF part of the matte -- fully opaque and
# still white. Eroding the source mask by one pixel takes the colour from
# under the matte instead of from its innermost row, and every skin then lands
# within +/-2.4 of neutral instead of +30.
SOURCE_ERODE = 1

# A skin is only rewritten when its edge genuinely reads BRIGHTER than the
# artwork behind it. Some skins have a deliberately DARK outer edge (ice
# cavern reads -72) and that is art, not a matte; "no white edging" is not
# "every edge must be neutral".
HALO_THRESHOLD = 20.0


def erode(mask: np.ndarray, n: int) -> np.ndarray:
    """Shrink a boolean mask by n pixels (8-connected)."""
    m = mask.copy()
    for _ in range(n):
        e = m.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                e &= np.roll(np.roll(m, dy, axis=0), dx, axis=1)
        m = e
    return m


def halo(rgba: np.ndarray) -> float:
    """How much brighter the edge pixels are than the solid artwork beside them.

    This is the measurement that matters, and it is not "how white is the
    edge": a pale gold rail is legitimately near-white, so counting white
    pixels flags golden sand forever. What a matte actually looks like is an
    edge that does not belong to the picture behind it. Correct anti-aliasing
    reads about zero; a white matte reads +50 to +150.
    """
    a = rgba[..., 3]
    edge = (a > EDGE_LO) & (a < EDGE_HI)
    solid = a >= SOLID
    lum = (0.299 * rgba[..., 0] + 0.587 * rgba[..., 1] + 0.114 * rgba[..., 2]).astype(np.float64)
    acc = np.zeros(a.shape)
    cnt = np.zeros(a.shape)
    for dy in (-2, -1, 0, 1, 2):
        for dx in (-2, -1, 0, 1, 2):
            if dx == 0 and dy == 0:
                continue
            acc += np.roll(np.roll(lum, dy, axis=0), dx, axis=1) * np.roll(np.roll(solid, dy, axis=0), dx, axis=1)
            cnt += np.roll(np.roll(solid, dy, axis=0), dx, axis=1)
    m = edge & (cnt > 0)
    return float(np.mean(lum[m] - acc[m] / cnt[m])) if m.any() else 0.0


def fringe_pct(rgba: np.ndarray) -> tuple[int, int]:
    a = rgba[..., 3]
    edge = (a > EDGE_LO) & (a < EDGE_HI)
    n = int(edge.sum())
    if n == 0:
        return 0, 0
    whitish = ((rgba[..., 0] > WHITE) & (rgba[..., 1] > WHITE) & (rgba[..., 2] > WHITE) & edge)
    return n, int(whitish.sum())


def defringe(rgba: np.ndarray) -> np.ndarray:
    """Bleed opaque colour outward into the edge pixels. Alpha is untouched."""
    out = rgba.copy()
    a = rgba[..., 3]
    solid = erode(a >= SOLID, SOURCE_ERODE)
    todo = (a > 0) & ~solid

    # `known` grows outward one ring at a time; each pass fills the edge pixels
    # that now touch a known one, averaging over the 8 neighbours that are
    # known. Averaging rather than nearest-pixel keeps a gradient rail smooth
    # instead of stepping.
    known = solid.copy()
    colour = rgba[..., :3].astype(np.float64)

    for _ in range(MAX_RADIUS):
        if not todo.any():
            break
        acc = np.zeros(colour.shape, dtype=np.float64)
        cnt = np.zeros(a.shape, dtype=np.float64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                shifted_known = np.roll(np.roll(known, dy, axis=0), dx, axis=1)
                shifted_col = np.roll(np.roll(colour, dy, axis=0), dx, axis=1)
                m = shifted_known
                acc += shifted_col * m[..., None]
                cnt += m
        fillable = todo & (cnt > 0)
        if not fillable.any():
            break
        colour[fillable] = acc[fillable] / cnt[fillable][..., None]
        known = known | fillable
        todo = todo & ~fillable

    out[..., :3] = np.clip(np.round(colour), 0, 255).astype(np.uint8)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='write the files')
    ap.add_argument('--only', nargs='*', default=None, help='basenames to process')
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(SKIN_DIR, '*.png')))
    if args.only:
        files = [f for f in files if os.path.basename(f) in args.only]

    print(f"{'skin':30s} {'halo':>8s} {'after':>8s}  action")
    changed = 0
    for f in files:
        rgba = np.array(Image.open(f).convert('RGBA'))
        h_before = halo(rgba)

        if h_before <= HALO_THRESHOLD:
            print(f'{os.path.basename(f):30s} {h_before:8.1f} {"":>8s}  left alone')
            continue

        fixed = defringe(rgba)
        h_after = halo(fixed)

        # Alpha is the silhouette. If it moved, something is wrong with the
        # bleed and the file must not be written.
        assert (fixed[..., 3] == rgba[..., 3]).all(), f'{f}: alpha changed'

        print(f'{os.path.basename(f):30s} {h_before:8.1f} {h_after:8.1f}  '
              f'{"WRITTEN" if args.apply else "would fix"}')

        if args.apply:
            Image.fromarray(fixed, 'RGBA').save(f, optimize=True)
            changed += 1

    if args.apply:
        print(f'\nwrote {changed} file(s)')
    else:
        print('\ndry run - nothing written (pass --apply)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
