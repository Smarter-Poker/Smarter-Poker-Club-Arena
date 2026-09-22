# Diamond Spins Art

Generated with the built-in image tool for the owner's September 17 single-video wheel reference and Club Arena Console direction. No reference-video pixels or audio are included.

- `wheel-chrome-housing-v1.png`: transparent face-on polished chrome housing, quilted black metal and blue lighting. Generated using the approved Spade Console top as the visual reference. Native 1254 by 1254 RGBA.
- `wheel-prize-atlas-v2.png`: transparent 1448 by 1086 RGBA prize collection, with dimensional Plinko, aircraft, donkey, mines, chips, diamond, Upgrade, throwable, time-bank and rabbit artwork. The second generation separates the prize regions to prevent neighboring art bleeding into sectors.

The application uses native aspect ratios and independent atlas regions. Live sectors, rotation, lighting, pointer motion and reveal transitions are rendered by the wheel components. Prototype atlas v1 is not shipped.

## September 21 selector and WebP derivatives (owner rulings R5, R20)

- `wheel-selector-holder-v2.png` / `.webp`: the centre holder only, cut from `wheel-selector-mount-v1.png` around its own hub axis by `scripts/art/derive-wheel-selector.py`, the two cuts feathered over 36 px. The owner's ruling of 2026-09-21 removes the mount's long side arcs, whose curvature does not follow the wheel rim. 520 by 310 RGBA.
- `wheel-selector-pointer-v2.png` / `.webp` and `wheel-selector-pointer-glow-v2.png` / `.webp`: the blue diamond pointer at sprite scale (420 by 590 for a 26 by 39 unit sprite) with its SVG and CSS drop shadows baked in, plus the lit frame of the old reflection keyframe. The wheel cross-fades the two with opacity instead of animating a filter.
- `wheel-prize-throwables-v1.webp`: the approved combination throwables cutout (`public/images/marketplace/throwables/all-throwables-access-v1.png`) right-sized to 640 px for the wheel's prize art.
- `wheel-{main-cards,upgrade-cards,upgrade-titles,prize-atlas-v2,matte-rim}-*.webp`: sealed WebP derivatives of the approved PNGs, written once by `scripts/generate-webp-media.mjs` and committed, because this pool's URLs are permanent. The PNGs stay where they are; nothing overwrites a shipped URL.
