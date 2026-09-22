# The Wheel Turns On The Compositor, And Its Selector Is Just The Holder

Owner rulings of 2026-09-21, R4, R5, R7 and R20, for the Diamond Spins wheel face.

## R5: the selector is the holder and the blue diamond pointer

The frame that holds the pointer was the full `wheel-selector-mount-v1.png` bracket, whose long side arcs curve about
twice as tightly as the rim they sit on (arc radius about 184 wheel units against the rim's 344 to 363), so their ends
dived into the prize cards. The wheel now draws only the centre holder, cut from the same approved master around its own
hub axis by `scripts/art/derive-wheel-selector.py` and shipped as `wheel-selector-holder-v2.png/.webp` (520 x 310, the
two cuts feathered over 36 px so no hard edge or matte shows). Its hub keeps the exact position and scale the mount's hub
had, so the holder sits on the wheel's vertical axis with the pointer pivot at (500, 156) and the pointer tip on the same
sector radius as before. Measured in a headless render of the real component: holder centre 196.51 px against a wheel
centre of 196.50 px at 393 px wide, and 640.00 against 640.00 at 1280 px.

The pointer itself was a 1024 x 1536, 1.86 MB PNG drawn 28 CSS px wide through an SVG `feDropShadow` and a CSS filter
animation. It now ships at sprite scale with both shadows baked in (`wheel-selector-pointer-v2`), plus the lit frame of
the old reflection keyframe (`wheel-selector-pointer-glow-v2`), and the reflection is an opacity cross-fade between the
two. Nothing about the look changed; the origin pool keeps every v1 URL.

## R7: the main wheel idles until it is spun

The main wheel froze on its last prize for as long as the player waited: `settledRef` was never cleared, and the page
remounted both wheels on every spin (`key={spinKey}`), which also snapped the angle back to zero. The wheels now stay
mounted (`WheelExperience` keys its own phase by `spinKey` instead), a landed wheel holds only while its receipt is being
revealed, and the moment the reveal is acknowledged it drifts on from its landed angle at the same 3 degrees per second
as the upgrade ring. The next spin leaves from wherever the drift has carried it. `DiamondWheel` exposes `holdResult`
(default `landingOrd !== null`) and `paused` for a covering modal; reduced motion collapses the drift and keeps the owed
spin at its full duration, pegs and landing sound.

## R4: Throwables show the throwables

A Throwables win revealed atlas tile 8, a single tomato. Every place the prize is shown (the win reveal, the prize
gallery in Prizes & More, the hub and the double-down offer, all of which render `WheelPrizeArt`) now shows the approved
combination cutout, right-sized for this use through the repo's own media pipeline as
`assets/diamond-spins/wheel-prize-throwables-v1.webp` (124 KB from a 2.0 MB master).

## R20: mobile smoothness

Root cause: both wheels were whole inline SVGs whose rotor `transform` ATTRIBUTE was rewritten every frame, which
repaints the entire SVG on the main thread - twice, at device pixel ratio 3, forever, including while a modal covered
them. What changed:

1. The rotor is now a promoted HTML layer (`will-change: transform`) holding one SVG of sector art. Rotation is a CSS
   transform, so the face is rasterised once and the compositor moves it. The idle drift is a Web Animation (with the
   frame loop as fallback), so an idling wheel runs no JavaScript at all; the spin keeps its single physical clock.
2. No animated filters anywhere in the wheel: the pointer reflection, the winner's lit edge and the hub shadow are
   baked art, an opacity-only overlay layer and a static gradient.
3. The 48 lamps are HTML elements animating opacity only, pausing off screen.
4. The wheel stops when it cannot be seen: paused while the reveal covers it, frozen where it is when the tab is hidden
   or the frame leaves the viewport (`data-offscreen`).
5. The reveal drops `backdrop-filter` on coarse pointers and small screens for a solid scrim, and the floating prize
   casts a painted shadow there instead of a per-frame `drop-shadow`. The rays were already transform-only.
6. The primary control plate pulses through an opacity overlay instead of re-filtering the button every frame.
7. Card textures encode through `canvas.toBlob` and object URLs instead of 64 synchronous `toDataURL` calls.
8. The wheel's art ships as WebP through `scripts/generate-webp-media.mjs` (sealed derivatives, generated once and
   committed because `public/assets` is an append-only pool of permanent URLs): 12.7 MB of PNG on this route becomes
   about 2.5 MB. The card texture canvas stays capped at 2 device pixels per wheel unit.

Measured with `scripts/dev/diamond-wheel-render.mjs perf`, headless Chromium, 393 x 852 at device pixel ratio 3, CPU
throttled, sampling `requestAnimationFrame` deltas for 10 s of idle and through a spin:

|           | idle median | idle p95 | idle frames over 50 ms | spin median | spin p95 | spin frames over 50 ms | long tasks (idle + spin) |
| --------- | ----------- | -------- | ---------------------- | ----------- | -------- | ---------------------- | ------------------------ |
| 4x before | 33.3 ms     | 50.1 ms  | 18 of 319              | 33.3 ms     | 66.7 ms  | 26 of 262              | 1 (50 ms)                |
| 4x after  | 16.7 ms     | 16.7 ms  | 0 of 601               | 16.7 ms     | 16.8 ms  | 1 of 537               | 0                        |
| 6x before | 33.4 ms     | 66.7 ms  | 56 of 241              | 49.9 ms     | 83.3 ms  | 57 of 200              | 29 (1.67 s)              |
| 6x after  | 16.7 ms     | 16.7 ms  | 0 of 595               | 16.7 ms     | 16.8 ms  | 0 of 529               | 0                        |

First mount at 4x throttling, from script to all 64 painted bands: 9.4 s with 8.2 s of long tasks and a worst single
block of 3.2 s, against 7.6 s with 5.0 s of long tasks and a worst block of 1.75 s.

## The face reads the prize, never the position

The v4 wheel serves an active or lifetime VIP instant chip wins on ords 3, 6 and 9 where everybody else sees
Throwables, Time Bank and Rabbit Hunt. Card and prize art already followed the segment's kind; the chip-stack rule is
now one shared, NaN-safe function (`chipStackCard`: one stack up to 1x, two from 2x, three from 3x), so the 0.2x, 0.25x
and 0.3x VIP wins print their amount on the blank title plate of the single-stack card exactly as 1x Chips does.
Nothing in the face reads a weight, and `tests/components/DiamondWheelVipFace.test.tsx` renders the same face under the
v4 weights, the retired v3 weights and no weights at all and asserts the markup is identical.

## Proof

- `tests/components/DiamondWheelIdle.test.tsx` (10): holds through the reveal, resumes from the landed angle, next spin
  starts from the drifted angle, compositor drift keyframes, off-screen and hidden-tab freezes, reduced motion, and an
  owed spin that is never shortened.
- `tests/components/DiamondWheelLayers.test.tsx` (26): selector geometry on the axis, pointer pivot, the combination
  throwables art in the reveal, the layer structure, no SVG filters, the reveal and control CSS, and the shipped files.
- `tests/components/DiamondWheelVipFace.test.tsx` (7): the VIP face, the gallery, a moved prize and weight independence.
- `tests/components/DiamondWheelAnimation.test.tsx` moved its pin to the rotor's CSS transform in the same commit; the
  e2e spec `tests/e2e/css/diamond-wheel-reveal.spec.ts` now reads the rotor's computed transform and its single Web
  Animation (17 passed).
- `docs/art/matte-baseline.json` records the holder's reading with the inspection behind it; `npm run art:matte` passes.
