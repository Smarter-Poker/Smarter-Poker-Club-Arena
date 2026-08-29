#!/usr/bin/env python3
"""
TAKE THE SEAT PLATES OUT OF THE FINAL TABLE (2026-08-29)

Bug 7b. Dan, 2026-08-28: the final table is "broken and distorted around the
table where the seat buttons are".

skin_final_table.png was the only one of the fourteen skins that painted seat
FURNITURE into the rail -- gold plates with amber jewels. Its geometry was
never wrong (605x1000 RGBA like the other thirteen), the plates simply are not
where SEAT_POSITIONS_9MAX puts the seats, so every seat button landed on a
plate edge or on a jewel.

Dan's ruling on the layering, 2026-08-29: "LAYER ONE IS THE BACKGROUND ...
NEXT WOULD BE THE TABLE, LAID SPECIFICALLY ON TOP OF THE BACKGROUND ... THERE
ARE NO PLUS BUTTONS, JUST THE AVATARS, AND WHEN THEY BUST SHOULD HAVE AN
'EMPTY' BUTTON OVERLAYED AS LAYER 3". Seat furniture belongs to layer 3. The
table is layer 2 and carries none of it.

HOW THE RAIL IS REBUILT, without redrawing anything. The table is a stadium:
every point on the rail is at some distance from a vertical spine running
between the two cap centres, and at a GIVEN distance the rail is the same
material all the way round -- that is what a revolve means. So the plates are
replaced with the median colour of the non-plate pixels at the same distance.
The rail's own gradient and sheen come back; nothing is invented.

TWO THINGS THAT MATTER, both learned by getting them wrong first:

  * THE NEON IS NOT A PLATE. The blue ring is not perfectly concentric with
    the fitted stadium, so reconstructing it by distance smears it -- the
    first attempt left the bottom of the ring visibly chewed. Blue-dominant
    pixels are protected outright and come through untouched.

  * ALPHA IS NEVER TOUCHED. The silhouette and the soft edge are the
    original's, bit for bit. Only colour inside the shape changes.

RESULT, measured by tests/table-skin-must-not-paint-seats.law.test.ts:

    sideRailStep        113  ->  32.2   (limit 70)
    midpointDeviation  54.7  ->  15.1   (limit 35)

USAGE
    python3 scripts/dev/remove-final-table-plates.py [--apply]

Kept because the source art still has the plates: if a new final-table export
arrives from the same file, this is how it is cleaned again.
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image

SKIN = os.path.join(os.path.dirname(__file__), '..', '..',
                    'src', 'assets', 'tables', 'skin_final_table.png')

# Outer silhouette of the 605x1000 frame, measured from the alpha channel.
BBOX = (23.0, 577.0, 14.0, 986.0)  # x0, x1, y0, y1


def dilate(mask: np.ndarray, n: int) -> np.ndarray:
    m = mask.copy()
    for _ in range(n):
        o = m.copy()
        o[1:, :] |= m[:-1, :]
        o[:-1, :] |= m[1:, :]
        o[:, 1:] |= m[:, :-1]
        o[:, :-1] |= m[:, 1:]
        m = o
    return m


def boxblur(f: np.ndarray, k: int) -> np.ndarray:
    p = np.pad(f, k, mode='edge')
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0)))
    s = 2 * k + 1
    out = (c[s:, s:] - c[:-s, s:] - c[s:, :-s] + c[:-s, :-s]) / (s * s)
    return out[: f.shape[0], : f.shape[1]]


def remove_plates(rgba: np.ndarray) -> np.ndarray:
    a = rgba.astype(np.float64)
    H, W, _ = a.shape
    al = a[..., 3]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    x0, x1, y0, y1 = BBOX
    cx = (x0 + x1) / 2.0
    R = (x1 - x0) / 2.0
    Y, X = np.mgrid[0:H, 0:W].astype(np.float64)
    # Distance to the spine: the segment between the two cap centres.
    d = np.sqrt((X - cx) ** 2 + (Y - np.clip(Y, y0 + R, y1 - R)) ** 2)

    gold = (r > 90) & (r > b + 30) & (g > b + 8)
    neon = (b > r + 25) & (b > 110)
    protect = dilate(neon, 2)
    mask = dilate(gold, 5) & ~protect

    # The rail's colour profile as a function of distance from the spine,
    # taken only from pixels that are neither plate nor neon.
    BIN = 0.5
    idx = np.round(d / BIN).astype(int)
    maxi = int(idx.max()) + 1
    clean = (~dilate(gold, 6)) & (~protect) & (al > 200)

    ii = idx[clean]
    vals = np.stack([r[clean], g[clean], b[clean]], 1)
    order = np.argsort(ii, kind='stable')
    ii, vals = ii[order], vals[order]

    prof = np.zeros((maxi, 3))
    have = np.zeros(maxi, bool)
    s = 0
    for i in range(maxi):
        e = np.searchsorted(ii, i, side='right')
        if e > s:
            prof[i] = np.median(vals[s:e], 0)
            have[i] = True
        s = e
    # Carry the nearest known profile into any empty bin, both directions.
    last = None
    for i in range(maxi):
        if have[i]:
            last = prof[i]
        elif last is not None:
            prof[i], have[i] = last, True
    for i in range(maxi - 1, -1, -1):
        if have[i]:
            last = prof[i]
        elif last is not None:
            prof[i], have[i] = last, True

    rebuilt = prof[np.clip(idx, 0, maxi - 1)]

    # Feather, so a plate edge does not leave a seam.
    w = np.clip(boxblur(mask.astype(np.float64), 3) * 2.0, 0, 1)
    w[protect] = 0.0

    out = a.copy()
    out[..., :3] = a[..., :3] * (1 - w[..., None]) + rebuilt * w[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    rgba = np.array(Image.open(SKIN).convert('RGBA'))
    fixed = remove_plates(rgba)

    assert fixed.shape == rgba.shape, 'dimensions changed'
    assert (fixed[..., 3] == rgba[..., 3]).all(), 'alpha changed'

    changed = int((fixed[..., :3] != rgba[..., :3]).any(axis=2).sum())
    print(f'{changed} pixel(s) recoloured; alpha and dimensions unchanged')

    if args.apply:
        Image.fromarray(fixed, 'RGBA').save(SKIN, optimize=True)
        print(f'wrote {SKIN}')
    else:
        print('dry run - nothing written (pass --apply)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
