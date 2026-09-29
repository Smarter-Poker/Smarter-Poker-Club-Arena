# The Diamond Scenes Govern Their Own Quality (Mobile Spins, Phase 1 Of 7)

Dan, 2026-09-21: "the mobile play is very choppy and not smooth and crisp
like it is on desktop". Phase 1 of the mobile spins programme is the
performance foundation under the three WebGL bonus scenes (Crash, Donkey
Cross, Plinko): a device is measured by the frames it delivers, not by the
name it reports.

## What changed

1. **The quality governor** (`src/components/games/qualityGovernor.ts`).
   Every attempted frame hands the governor the clock and whether the frame
   was submitted (gpuFrameRenderer refuses a frame while the last one is still
   on the GPU). After a warm-up of 30 frames and 1.5 s, a rolling window of 60
   attempts is judged: more than 35 percent refused means the GPU is the wall;
   more than 40 percent of drawn frames arriving later than 1.8x the scene's
   own draw interval means the main thread is. Either steps the scene down one
   tier: 2x device pixels, 1.5x, 1x, then 1x with shadow maps off. It only
   steps down (a step up oscillates on exactly the phones that need it), and
   the lowest tier reached is kept in `sessionStorage` so the next scene on
   the same device starts there. A CPU rasteriser (`rendererTier.ts`) starts
   at the floor. Every element, colour and animation stays at every tier.
2. **Applying a tier** (`applyQualityTier` in `sceneKit.ts`): the pixel ratio
   capped at the device's own, the canvas re-sized, and when shadows change
   every material re-linked, because three only reads `shadowMap.enabled`
   when it builds a program.
3. **Shader warm-up for Crash and Plinko** (`warmUp` in `sceneKit.ts`). Donkey
   Cross compiled its programs off the first frame since 2026-09-22; the shared
   game renderer now does the same: `compileAsync` first, no frame submitted
   until the driver answers or 1.5 s pass, so the first frame a phone shows is
   a drawn one instead of a compile stall. `onSettled`, `onProgress` and
   `onLanded` still wait for a submitted frame, as their tests require.
4. **The first-load placeholder.** Each scene's frame now carries, in CSS
   under the canvas, the scene's own tones and the house hairline (Crash: the
   sky gradient; Donkey Cross: the night road; Plinko: the cabinet's steel and
   blue). A WebGL canvas is transparent until its first draw, so a slow phone
   sees the frame it is about to get instead of a black rectangle.
5. **A perf harness for the scenes** (`scripts/dev/diamond-scene-perf.mjs`):
   the wheel's measurement, pointed at the fixture page for each game: rAF
   deltas and long tasks while idle and during a round, at 393 x 852, DPR 3,
   CPU throttled, plus the tier the governor settled on.

## Measured

See the numbers appended below, taken on the Mac with headless Chromium on
SwiftShader (no GPU) at CPU throttle 4x, before (origin/main `ed45f6ddd9`)
and after this change, same machine, same minute.

## Tests

`tests/unit/qualityGovernor.test.ts`: healthy frames never step; a GPU-bound
window steps once and is remembered; a main-thread-bound window steps; a step
is followed by a warm-up and the floor holds; a remembered tier and a CPU
rasteriser start where they should; `applyQualityTier` caps the ratio and
re-links materials; `warmUp` is ready on the driver's answer, on the timeout,
and at once without `compileAsync`. The existing scene, completion, recovery
and presentation suites for all three games are unchanged and green.

## Numbers (headless Chromium, SwiftShader, 393 x 852 at DPR 3, CPU 4x, 6 s samples)

On this renderer both trees already sit at the floor tier (a CPU rasteriser),
so the governor itself cannot step here; what the numbers show is the warm-up
and the first-frame stall. "round" is sampled from the moment Start Test is
pressed, so its maximum is the first drawn frame of the scene.

| scene        | before: round median / p95 / max   | after: round median / p95 / max   |
| ------------ | ---------------------------------- | --------------------------------- |
| Crash        | 12.1 / 26.8 / 1748 ms (307 frames) | 12.0 / 26.7 / 943 ms (375 frames) |
| Donkey Cross | 137.5 / 3077 / 3077 ms (10 frames) | 11.7 / 26.7 / 734 ms (344 frames) |
| Plinko       | 12.4 / 37.4 / 765 ms (328 frames)  | 12.8 / 40.4 / 451 ms (332 frames) |

Idle was 11.6 to 12.6 ms median and 26 to 27 ms p95 on both trees for all
three scenes, with zero long tasks. The governor's stepping on a hardware GPU
that cannot keep up is covered by its unit tests; a real phone is the only
place it can be watched, which is why the tier it settles on is written to
`sessionStorage` under `ca:diamond-scene-quality` and printed by the harness.
