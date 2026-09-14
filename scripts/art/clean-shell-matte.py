"""
CUT THE WHITE MATTE OFF A CLUB ARENA SHELL.

Dan, 2026-09-10: "the bottom and sides must look like the top ... that shitty
white broken background can not be there."

Several painted shells were exported with their glow rendered as WHITE rather
than cut out. A smooth neutral ramp sits OUTSIDE the frame at full alpha, with
a torn dashed edge where it was clipped. The top of a plate looks right only
because the art is cropped flush there; the bottom and sides carry the matte.

The frame always begins, from any outside direction, with a STRUCTURED pixel -
a dark outline, a blue-tinted bevel or LED, or brushed chrome. The matte never
is. So: flood inward from the transparent exterior through matte-like pixels
only, then trim whatever still sits past the locally smooth silhouette, and
repeat, because trimming a tooth exposes the matte behind it.

A flood rather than a per-row scan: one speck of tear left in a row would
shadow the rest of that row and strand a wedge against a chamfer.

ONLY ALPHA IS WRITTEN. No pixel is recoloured, so every kept pixel of the
frame is bit-identical to the master.

numpy + Pillow only, on purpose: this has to run wherever the art lives.

    python3 clean_shell_matte.py --check  <png>...     report, change nothing
    python3 clean_shell_matte.py          <png>...     clean in place
"""
import sys

import numpy as np
from PIL import Image

STRUCT = 22.0   # local range below this is smooth matte, not brushed metal
NEUTRAL = 5.0   # the matte is grey: |B-R| and green deviation within this
FLOOR = 70.0    # a dark pixel is frame outline or well, never matte
TRIM = 3        # how far past the locally smooth silhouette a pixel may sit
PASSES = 3
MIN_FRACTION = 0.005   # below this, treat the art as already clean


def _shifts(x):
    """The nine 3x3 neighbourhood shifts of x, edge-replicated."""
    p = np.pad(x, 1, mode='edge')
    h, w = x.shape
    return [p[dy:dy + h, dx:dx + w] for dy in (0, 1, 2) for dx in (0, 1, 2)]


def _local_range(lum, opaque):
    """max-min over OPAQUE neighbours only.

    Letting transparent pixels count as black invents a hard edge along the
    whole alpha boundary - exactly where the matte starts - and the fill would
    stop dead on its first step.
    """
    hi = np.stack(_shifts(np.where(opaque, lum, -1e6))).max(0)
    lo = np.stack(_shifts(np.where(opaque, lum, 1e6))).min(0)
    return hi - lo


def matte_mask(a):
    R, G, B, A = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    lum = 0.299 * R + 0.587 * G + 0.114 * B
    opaque = A > 20
    neutral = (np.abs(B - R) <= NEUTRAL) & (np.abs(G - (R + B) / 2) <= NEUTRAL)
    return opaque & neutral & (_local_range(lum, opaque) < STRUCT) & (lum > FLOOR)


def _flood_from_border(passable):
    """Everything reachable from the image border through `passable`."""
    seen = np.zeros_like(passable)
    seen[0], seen[-1], seen[:, 0], seen[:, -1] = True, True, True, True
    seen &= passable
    while True:
        grown = seen.copy()
        for s in _shifts(seen):
            grown |= s
        grown &= passable
        if grown.sum() == seen.sum():
            return seen
        seen = grown


def _median1d(v, k):
    half = k // 2
    p = np.pad(v.astype(np.float64), half, mode='edge')
    win = np.lib.stride_tricks.sliding_window_view(p, k)
    return np.median(win, axis=-1)


def _edge_profile(op, axis, last):
    n = op.shape[1 - axis]
    out = np.full(n, -1)
    for i in range(n):
        line = op[:, i] if axis == 0 else op[i]
        idx = np.where(line)[0]
        if idx.size:
            out[i] = idx.max() if last else idx.min()
    return out


def _ragged(op, tol):
    """Opaque pixels sitting past the median-smoothed silhouette on any side.

    A median filter reproduces a straight ramp exactly, so the 45-degree
    chamfers survive untouched while an outlier tooth is clipped.
    """
    h, w = op.shape
    bad = np.zeros((h, w), bool)
    ys = np.arange(h)[:, None]
    xs = np.arange(w)[None, :]
    for axis, last in ((0, True), (0, False), (1, True), (1, False)):
        prof = _edge_profile(op, axis, last)
        known = prof >= 0
        if not known.any():
            continue
        sm = _median1d(np.where(known, prof, np.median(prof[known])), 41)
        if axis == 0:
            lim = sm[None, :]
            bad |= (ys > lim + tol) if last else (ys < lim - tol)
        else:
            lim = sm[:, None]
            bad |= (xs > lim + tol) if last else (xs < lim - tol)
    return bad & op


def clean_array(a):
    out = a.copy()
    removed = np.zeros(a.shape[:2], bool)
    for _ in range(PASSES):
        A_now = out[..., 3]
        passable = (A_now <= 20) | matte_mask(out)
        gone = _flood_from_border(passable) & (A_now > 20)
        out[gone, 3] = 0
        removed |= gone
        rag = _ragged(out[..., 3] > 20, TRIM)
        out[..., 3] = np.where(rag, 0, out[..., 3])
        removed |= rag
    return out, removed


def process(path, check_only):
    im = Image.open(path).convert('RGBA')
    a = np.array(im).astype(np.float32)
    was = int((a[..., 3] > 20).sum())
    if not was:
        return 0.0
    out, removed = clean_array(a)
    frac = removed.sum() / was
    if frac >= MIN_FRACTION and not check_only:
        Image.fromarray(out.astype(np.uint8), 'RGBA').save(path)
    return frac


if __name__ == '__main__':
    args = sys.argv[1:]
    check = '--check' in args
    files = [x for x in args if not x.startswith('--')]
    for f in files:
        frac = process(f, check)
        flag = 'MATTE' if frac >= MIN_FRACTION else 'clean'
        print(f'{flag:5s} {100 * frac:5.1f}%  {f}')
