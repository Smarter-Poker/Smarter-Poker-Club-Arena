# Diamond Spins Art: The September 21 Selector And WebP Derivatives

Owner rulings 2026-09-21, R5 and R20. These notes used to be appended to
`public/assets/diamond-spins/README.md`, which cannot take them: that file is
served from the origin's ADDITIVE runtime pool, where a URL's bytes are
permanent. Appending to it made the publish transaction refuse the release
with "pooled runtime URL would change bytes: diamond-spins/README.md". The
art itself is additive - new files, new URLs - so only this description moved.

## September 21 selector and WebP derivatives (owner rulings R5, R20)

- `wheel-selector-holder-v2.png` / `.webp`: the centre holder only, cut from `wheel-selector-mount-v1.png` around its own hub axis by `scripts/art/derive-wheel-selector.py`, the two cuts feathered over 36 px. The owner's ruling of 2026-09-21 removes the mount's long side arcs, whose curvature does not follow the wheel rim. 520 by 310 RGBA.
- `wheel-selector-pointer-v2.png` / `.webp` and `wheel-selector-pointer-glow-v2.png` / `.webp`: the blue diamond pointer at sprite scale (420 by 590 for a 26 by 39 unit sprite) with its SVG and CSS drop shadows baked in, plus the lit frame of the old reflection keyframe. The wheel cross-fades the two with opacity instead of animating a filter.
- `wheel-prize-throwables-v1.webp`: the approved combination throwables cutout (`public/images/marketplace/throwables/all-throwables-access-v1.png`) right-sized to 640 px for the wheel's prize art.
- `wheel-{main-cards,upgrade-cards,upgrade-titles,prize-atlas-v2,matte-rim}-*.webp`: sealed WebP derivatives of the approved PNGs, written once by `scripts/generate-webp-media.mjs` and committed, because this pool's URLs are permanent. The PNGs stay where they are; nothing overwrites a shipped URL.
