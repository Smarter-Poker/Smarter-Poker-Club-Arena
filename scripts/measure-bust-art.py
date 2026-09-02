#!/usr/bin/env python3
"""
Regenerate src/components/table/bustArtGain.ts from the shipped avatar art.

WHY THIS EXISTS
---------------
Bust avatars are drawn free-floating over the name box and sized by CSS:

    scale(--sp-bust-scale * --sp-bust-gain)

`--sp-bust-scale` is one global number every breakpoint tunes. `--sp-bust-gain`
is the PER-CHARACTER correction, and it exists because the assets are not
drawn to a common scale. Every file is a 125x170 canvas, but the character
inside that canvas occupies anywhere from 64% to 100% of the canvas height.
`object-fit: contain` fits the CANVAS, so whatever headroom the artist left is
rendered as empty pixels and the character reads small.

On 2026-08-23 that correction was two hand-typed entries, `viking: 2` and
`chef: 2`, written from a four-row sample. The chef genuinely is small (71%).
The viking is the 6th LARGEST asset of 100 (95%), and multiplying it by 2 gave
it a 2.9x render that swallowed the seat and spilled onto the felt. The two
characters were named in one sentence and given one number; they sit at
opposite ends of the distribution.

So the gain is no longer typed by hand for a handful of characters. It is
MEASURED, for every character, from the art itself:

    gain = REFERENCE_SHARE / subject_share

A character occupying the reference share gets 1.0 and is untouched. Anyone
drawn smaller than the reference is scaled up to match; anyone drawn larger is
scaled down. That is the definition of "they all look the same size", and it
cannot drift from the art, because the art is what it is computed from.

REFERENCE_SHARE is the MEDIAN of the shipped library, deliberately. Using the
median means half the roster moves up and half moves down, so the table keeps
the overall visual weight it has today and only the outliers move. Using the
max would inflate all 100 characters at once.

USAGE
-----
    pip3 install Pillow
    python3 scripts/measure-bust-art.py [path-to-avatars/table]

Default asset path is the World Hub checkout, which is where the art is
served from:  ~/Documents/Smarter-Poker-World-Hub/public/avatars/table

Re-run this whenever new bust art ships. It rewrites the TS file in place;
commit the result. Nothing at runtime reads an image, so there is no
measurement cost in the browser and no CORS surface.
"""

from __future__ import annotations

import statistics
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - operator-facing guidance
    sys.exit(
        "Pillow is required to measure the art.\n"
        "  pip3 install Pillow\n"
        "The generated TS file is committed, so you only need this when new "
        "avatar art ships."
    )

DEFAULT_ASSET_DIR = (
    Path.home() / "Documents" / "Smarter-Poker-World-Hub" / "public" / "avatars" / "table"
)

OUT_PATH = (
    Path(__file__).resolve().parent.parent / "src" / "components" / "table" / "bustArtGain.ts"
)

# A gain outside this band means the art itself is wrong (a near-empty canvas
# or a subject bleeding past its frame). Clamp rather than emit it, and say so.
GAIN_MIN = 0.75
GAIN_MAX = 1.40


def subject_share(path: Path) -> float | None:
    """Fraction of canvas HEIGHT occupied by non-transparent pixels.

    Height, not width: the avatar slot is square and the canvas is portrait
    (125x170), so `object-fit: contain` always fits to height. Height is the
    constrained axis and therefore the one that decides apparent size.
    """
    with Image.open(path) as im:
        rgba = im.convert("RGBA")
        bbox = rgba.getchannel("A").getbbox()
        if not bbox:
            return None
        return (bbox[3] - bbox[1]) / rgba.size[1]


def main() -> int:
    asset_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ASSET_DIR
    if not asset_dir.is_dir():
        sys.exit(f"Asset directory not found: {asset_dir}")

    shares: dict[str, float] = {}
    for path in sorted(asset_dir.glob("*.webp")):
        name = path.stem
        # @2x is the same character at twice the pixels - same share, and the
        # runtime keys on the slug with @2x stripped. SAMPLE_ files are art
        # review leftovers on a non-standard canvas and are never served.
        if name.endswith("@2x") or name.startswith("SAMPLE"):
            continue
        if not (name.startswith("free_") or name.startswith("vip_")):
            continue
        share = subject_share(path)
        if share is None:
            print(f"  skip (fully transparent): {path.name}", file=sys.stderr)
            continue
        shares[name.split("_", 1)[1]] = share

    if not shares:
        sys.exit(f"No free_/vip_ .webp assets found in {asset_dir}")

    reference = statistics.median(shares.values())

    gains: dict[str, float] = {}
    clamped: list[str] = []
    for slug, share in shares.items():
        raw = reference / share
        gain = min(max(raw, GAIN_MIN), GAIN_MAX)
        if abs(gain - raw) > 1e-9:
            clamped.append(f"{slug} ({raw:.3f} -> {gain:.3f})")
        gains[slug] = round(gain, 3)

    lo = min(shares.values()) * 100
    hi = max(shares.values()) * 100

    lines = [
        "/**",
        " * GENERATED FILE - do not edit by hand.",
        " * Regenerate with:  python3 scripts/measure-bust-art.py",
        " *",
        " * Per-character size correction for free-floating bust avatars.",
        " *",
        " * Every asset is a 125x170 canvas but the character inside it is not drawn to",
        " * a common scale - measured across the shipped library the subject occupies",
        f" * anywhere from {lo:.0f}% to {hi:.0f}% of canvas height. `object-fit: contain` fits",
        " * the CANVAS, so an artist's headroom renders as empty pixels and the character",
        " * reads small through no fault of the CSS.",
        " *",
        " * This map corrects for exactly that, and nothing else:",
        " *",
        f" *     gain = {reference * 100:.1f}% (library median) / this character's subject share",
        " *",
        " * A character drawn at the median gets 1.0 and is untouched. It is a",
        " * MULTIPLIER on the global `--sp-bust-scale`, so breakpoints, the top-rail",
        " * cap and the hover state keep owning everything else.",
        " *",
        " * Hand-typing these was the 2026-08-23 bug: `viking: 2` was written from a",
        " * four-character sample, but the viking is the 6th largest asset of 100 and",
        " * rendered at 2.9x, spilling off its seat onto the felt. Measurement replaced",
        " * the guess.",
        " */",
        "export const BUST_ART_GAIN: Readonly<Record<string, number>> = {",
    ]
    for slug in sorted(gains):
        lines.append(f"  {slug}: {gains[slug]},")
    lines += [
        "};",
        "",
        "/**",
        " * Size correction for the bust art at `avatarUrl`, or 1 when the URL is not a",
        " * known library bust (uploaded photos, generated SVG monograms, new art that",
        " * has not been measured yet). 1 means 'render at the global scale', which is",
        " * the correct and safe default for anything unmeasured.",
        " */",
        "export function bustArtGain(avatarUrl: string | null | undefined): number {",
        "  if (!avatarUrl) return 1;",
        "  const m = /\\/avatars\\/table\\/(?:free|vip)_([\\w-]+?)(?:@2x)?\\.webp/.exec(avatarUrl);",
        "  return (m && BUST_ART_GAIN[m[1]]) || 1;",
        "}",
        "",
    ]

    OUT_PATH.write_text("\n".join(lines), encoding="utf-8")

    ordered = sorted(gains.items(), key=lambda kv: kv[1])
    print(f"Measured {len(shares)} assets from {asset_dir}")
    print(f"Reference (median) subject share: {reference * 100:.1f}%")
    print(f"Gain range: {ordered[0][1]} ({ordered[0][0]}) .. {ordered[-1][1]} ({ordered[-1][0]})")
    if clamped:
        print(f"Clamped to [{GAIN_MIN}, {GAIN_MAX}]: {', '.join(clamped)}")
    print(f"Wrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
