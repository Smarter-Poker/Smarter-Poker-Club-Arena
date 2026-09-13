"""
#ClubArenaConsole - master surgery.

Derive new art from an APPROVED master render, never by drawing. Import this,
or run it as a CLI (see the bottom). Every function takes and returns an
HxWx4 uint8 RGBA numpy array, and none of them ever touch the source file.

    from master_surgery import (load, save, column_runs, is_straight,
                                median_bridge, synth_fill, synth_fill_matched,
                                mirror_close, flat_cap, preview)

The rule behind all of it: the master already contains everything you need.
A rail that runs straight for 14 columns carries across any gap; a texture
beside a hole fills the hole; a symmetric foot can close itself. If you find
yourself inventing a shape, stop and ask for the art.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter


# ── reading and looking ──────────────────────────────────────────────────

def load(path: str) -> np.ndarray:
    return np.array(Image.open(path).convert('RGBA'))


def save(a: np.ndarray, path: str) -> None:
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA').save(path)


def column_runs(a: np.ndarray, x: int, thresh: int = 10) -> list[tuple[int, int]]:
    """The vertical alpha runs in one column: the fingerprint of a rail stack."""
    ys = np.where(a[:, x, 3] > thresh)[0]
    runs, start, prev = [], None, None
    for y in ys:
        if start is None:
            start = prev = y
        elif y != prev + 1:
            runs.append((int(start), int(prev)))
            start = y
        prev = y
    if start is not None:
        runs.append((int(start), int(prev)))
    return runs


def is_straight(a: np.ndarray, x0: int, x1: int, samples: int = 3) -> bool:
    """True when the feature is identical across the band, so ONE cross-section
    carries it. Always check before median_bridge - a band that straddles a
    diagonal produces smeared arrows, which is what a failed bridge looks like."""
    xs = np.linspace(x0, x1 - 1, samples).astype(int)
    first = column_runs(a, int(xs[0]))
    return all(column_runs(a, int(x)) == first for x in xs[1:])


def preview(path: str, out: str, scale: int = 1, on: tuple = (0, 0, 0)) -> None:
    """Composite on a flat colour so alpha is visible, optionally zoomed.
    Use a garish colour (120,20,20) to read the silhouette, black to judge."""
    im = Image.open(path).convert('RGBA')
    bg = Image.new('RGBA', im.size, (*on, 255))
    out_im = Image.alpha_composite(bg, im).convert('RGB')
    if scale != 1:
        out_im = out_im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    out_im.save(out)


# ── the five techniques ──────────────────────────────────────────────────

def median_bridge(a: np.ndarray, x0: int, x1: int, y0: int, y1: int,
                  sx0: int, sx1: int) -> np.ndarray:
    """STRAIGHT FEATURES. One median cross-section of a clean band, tiled across
    the hole. The median averages the film grain away; a random sample leaves
    the rail speckled, which reads as dirt on chrome. Assert is_straight first."""
    f = a.astype(np.float32)
    band = np.median(f[y0:y1, sx0:sx1], axis=1)          # H x 4
    f[y0:y1, x0:x1] = band[:, None, :]
    return f.astype(np.uint8)


def synth_fill(a: np.ndarray, x0: int, x1: int, y0: int, y1: int,
               sx0: int, sx1: int, seed: int = 0, feather: int = 12,
               top_feather: int | None = None, smooth: float = 0.6) -> np.ndarray:
    """TEXTURE. Every output pixel takes a RANDOM source column on its own row,
    so horizontal features survive exactly and nothing tiles.

    `top_feather` defaults to `feather`; set it to 0 when the thing you removed
    sits ABOVE the hole, or the blend will pull its rim back in as a ghost."""
    if top_feather is None:
        top_feather = feather
    rng = np.random.default_rng(seed)
    f = a.astype(np.float32)
    H, W = y1 - y0, x1 - x0
    src = f[y0:y1, sx0:sx1]
    cols = rng.integers(0, sx1 - sx0, size=(H, W))
    patch = src[np.arange(H)[:, None], cols]
    if smooth:
        patch = np.array(
            Image.fromarray(np.clip(patch, 0, 255).astype(np.uint8), 'RGBA')
            .filter(ImageFilter.GaussianBlur(smooth))
        ).astype(np.float32)
    m = _mask(H, W, feather, top_feather)
    orig = f[y0:y1, x0:x1]
    out = orig * (1 - m[:, :, None]) + patch * m[:, :, None]
    out[:, :, 3] = np.maximum(orig[:, :, 3], patch[:, :, 3] * m)
    f[y0:y1, x0:x1] = out
    return np.clip(f, 0, 255).astype(np.uint8)


def synth_fill_matched(a: np.ndarray, x0: int, x1: int, y0: int, y1: int,
                       sx0: int, sx1: int, seed: int = 0, feather: int = 14,
                       top_feather: int | None = None, smooth: float = 0.6,
                       ring: int = 12) -> np.ndarray:
    """TEXTURE INSIDE A VIGNETTE. synth_fill, then the patch's brightness is
    interpolated between the columns either side of the hole, so a well that
    darkens at its edges is not flattened. Horizontal ring only - sampling the
    ring ABOVE bakes in the glow of the thing you are removing."""
    f = a.astype(np.float32)
    H, W = y1 - y0, x1 - x0
    left = f[y0:y1, x0 - ring:x0, :3].mean(axis=1)
    right = f[y0:y1, x1:x1 + ring, :3].mean(axis=1)
    tx = np.linspace(0, 1, W, dtype=np.float32)[None, :, None]
    est = left[:, None, :] * (1 - tx) + right[:, None, :] * tx
    filled = synth_fill(a, x0, x1, y0, y1, sx0, sx1, seed=seed, feather=0,
                        top_feather=0, smooth=smooth).astype(np.float32)
    patch = filled[y0:y1, x0:x1]
    patch[:, :, :3] += est - patch[:, :, :3].mean(axis=(0, 1))
    m = _mask(H, W, feather, feather if top_feather is None else top_feather)
    orig = f[y0:y1, x0:x1]
    out = orig * (1 - m[:, :, None]) + patch * m[:, :, None]
    out[:, :, 3] = orig[:, :, 3]
    f[y0:y1, x0:x1] = out
    return np.clip(f, 0, 255).astype(np.uint8)


def axis_of_symmetry(a: np.ndarray, probe_x: range, candidates: range) -> int:
    """The master's own mirror axis C, where pixel x matches pixel C-x. Probe on
    the OUTER rails (they must line up with mid.png), never on the interior."""
    best, best_score = None, None
    for c in candidates:
        score = sum(float(np.abs(a[:, x].astype(int) - a[:, c - x].astype(int)).mean())
                    for x in probe_x if 0 <= c - x < a.shape[1])
        if best_score is None or score < best_score:
            best, best_score = c, score
    return int(best)


def mirror_close(a: np.ndarray, C: int, from_row: int, bridge: tuple | None = None,
                 ) -> np.ndarray:
    """A CENTRED EMBLEM THE RAILS RUN INTO. Bridge the left half from a straight
    band, then mirror the left onto the right about the master's own axis, so
    the two rails meet in a clean symmetric chevron.

    bridge = (x0, x1, y0, y1, sx0, sx1) for the median_bridge that closes the
    left half first. Mirror only rows at or below `from_row`, so anything
    asymmetric above it (a steel plate left, a blue plate right) is untouched."""
    out = a.copy()
    if bridge:
        out = median_bridge(out, *bridge)
    half = C // 2 + 1
    for x in range(half, C + 1):
        out[from_row:, x] = out[from_row:, C - x]
    out[from_row:, C + 1:] = 0
    return out


def flat_cap(top: np.ndarray, rails: tuple[int, int], emblem_x: tuple[int, int],
             clean_band: tuple[int, int], keep_from: int) -> np.ndarray:
    """A WHOLE CLOSING EDGE, FLAT. The master's own top rails, turned over: same
    rails, same four corner chamfers, no emblem and no dive to the centre.

    rails      = (0, first_row_of_the_well)  - rows that are rails and nothing else
    emblem_x   = (x0, x1) the emblem occupies
    clean_band = (x0, x1) a rail-only band to carry across it
    keep_from  = first row of the cap (a few px above where the rails start)"""
    f = top.astype(np.float32)
    r0, r1 = rails
    band = np.median(f[r0:r1, clean_band[0]:clean_band[1]], axis=1)
    f[r0:r1, emblem_x[0]:emblem_x[1]] = band[:, None, :]
    return f.astype(np.uint8)[keep_from:r1][::-1].copy()


def splice(body: np.ndarray, cut: int, cap: np.ndarray) -> np.ndarray:
    """Close any body with a cap. Cut at a row where the CENTRE is empty (a gap
    between features) so nothing crosses the seam; the side rails are continuous
    at every row, so they always join."""
    out = np.zeros((cut + cap.shape[0], body.shape[1], 4), np.uint8)
    out[:cut] = body[:cut]
    out[cut:] = cap
    return out


def _mask(H: int, W: int, feather: int, top_feather: int) -> np.ndarray:
    m = np.ones((H, W), np.float32)
    for i in range(feather):
        g = (i + 1) / (feather + 1)
        m[:, i] = np.minimum(m[:, i], g)
        m[:, W - 1 - i] = np.minimum(m[:, W - 1 - i], g)
        m[H - 1 - i, :] = np.minimum(m[H - 1 - i, :], g)
    for i in range(top_feather):
        m[i, :] = np.minimum(m[i, :], (i + 1) / (top_feather + 1))
    return m


if __name__ == '__main__':
    import sys
    if len(sys.argv) >= 4 and sys.argv[1] == 'runs':
        a = load(sys.argv[2])
        for x in sys.argv[3].split(','):
            print(x, column_runs(a, int(x)))
    elif len(sys.argv) >= 4 and sys.argv[1] == 'preview':
        preview(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 1)
    else:
        print(__doc__)
