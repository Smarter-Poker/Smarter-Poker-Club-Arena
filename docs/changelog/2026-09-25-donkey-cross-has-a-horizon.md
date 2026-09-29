# 2026-09-25: Donkey Cross Has A Horizon

Owner request (Dan): bring the horizon into the Donkey Cross frame with a sky,
a skyline and lamp posts, and keep the road straight. Mobile spins programme,
Phase 3 of 7. Scene only: no money, RPC, fairness or copy changes.

## Shipped

- **The camera sees the horizon.** `CROSSING_CAMERA` (`src/utils/crossingScene.ts`)
  goes from a 22 degree lens pitched 37 degrees down (ground only, horizon 26
  degrees above the top edge) to a 56 degree lens pitched 19.5 degrees down,
  standing nearer and lower (distance 13.6, target 4.3 past the donkey's line).
  The horizon prints about a sixth of the way down the frame, so the far road,
  the skyline and the sky take roughly the top quarter at 393x852 and at
  1280x820. The donkey keeps its size on screen (the camera is nearer by the
  factor the lens is wider) and the street signs stay above the multiplier
  strip. Still no yaw and no roll: the camera stands over the x it looks at,
  and a line across the road prints horizontal. A narrow scene now measures
  its minimum road width at the donkey's own line.
- **Sky.** One vertex-coloured dome, unlit and unfogged: a faint royal-blue
  glow at the horizon (`#0f2446`) through deep navy to obsidian, the whole
  ramp spent in the eight and a half degrees of sky the camera can see. A
  sparse static starfield (190 seeded points) sits only where the fixed camera
  can see it.
- **One haze, no seam.** The fog colour is the sky's horizon colour, and the
  fog is now complete about 120 units past the target (it was 51 at the old
  pose and 255 in the first draft), so the road runs into the haze before it
  reaches the city and the far asphalt never shows its grain at a grazing
  angle. The asphalt ends at z = -150, where the fog is already complete, and
  a dark land plane carries the haze on. The wheel tracks in the asphalt
  texture wander much less (0.004, was 0.018), which removed a ripple pattern
  the old wander printed across the far road at the new, lower angle.
- **Skyline.** About a hundred blocks in two rows beyond the end of the
  highway, merged into one unlit mesh: a seeded window texture generated once
  (most windows dark, some warm white at their own brightness, a few royal
  blue), shading painted on the side faces, and heights chosen so the tallest
  tower tops out about half way up the visible sky. The tallest carry red and
  blue beacons (one instanced draw). A single gradient strip of the haze
  colour stands in front of the city's foot, so the blocks rise out of the
  same navy the road runs into. The city takes no fog and stands behind the
  end of the traffic, so it never covers the road or a sign.
- **Lamp posts.** Every painted lamp pool (every second street) gets a chrome
  post on the median with a cobra arm over its street: one instanced draw for
  the poles, one for the warm heads, one for an additive glow disc at each
  head. Geometry and emissive only; the real light budget is unchanged (three
  lights, one shadow caster).
- **Idle attract.** Before the first street the traffic keeps flowing (the
  lane loop now runs from z = +12 to -40 and a car shrinks away in its last
  five units rather than popping), the donkey flicks an ear every 3.4 s and
  shifts its weight every 5.2 s, and two lamp heads flicker very slightly
  (instance colour only, rewritten only when a level changes). All of it is
  timed against Animation Speed and none of it runs under reduced motion.
- **Mount cost kept down.** The sky and the haze strip share one program,
  the lamp glows share the painted pools' program, the poles share the
  program of the cars' plain standard parts, the lamp heads share the cat's
  eyes' program, and the city is a basic (unlit) material, so the new scenery adds as few shader programs as it can.
  Nothing new is allocated or repainted per frame; the sky, the city and the
  posts are built once.

## Performance

`node scripts/dev/diamond-scene-perf.mjs crossing 4 6` (4x CPU throttle,
393x852 at 3x, SwiftShader, same Mac). The round sample includes the scene
remounting when the fixture page starts a round.

| Sample                      | Before (origin/main, 3 runs)      | After (this change, 3 warm runs)  |
| --------------------------- | --------------------------------- | --------------------------------- |
| Idle frames in 6 s          | 455, 439, 440                     | 449, 434, 435 (and 446)           |
| Idle median / p95           | 11.7 to 12.0 ms / 26.3 to 26.8 ms | 11.8 to 12.1 ms / 26.0 to 26.5 ms |
| Idle max, frames over 50 ms | 27.3 to 28.7 ms, 0                | 27.3 to 27.9 ms, 0                |
| Round median / p95          | 11.4 to 11.9 ms / 27.1 ms         | 12.0 to 12.3 ms / 26.5 to 27.1 ms |
| Round max (the remount)     | 316, 636, 662 ms                  | 812, 410, 400 ms                  |
| Round frames over 50 ms     | 6, 4, 4                           | 6, 5, 2                           |
| Long tasks                  | 0                                 | 0                                 |

Steady frames are unchanged. The one stall at a round's start is the fixture
page remounting the scene and compiling its programs; on SwiftShader it runs
from about 300 to 800 ms either side of this change, and single runs vary
more than the change moves them. (A first draft of this change, before the
program sharing above, measured 755 to 913 ms there.)

The quality governor (Phase 1) settled on tier 0 (best) in every run, at one
canvas pixel per CSS pixel.

## Tests

- `tests/unit/crossingCamera.test.ts`: the structural assertions (no yaw, no
  roll, the far edge level, no street leaning) are unchanged. The far edge the
  level assertions project is now the far end of the lane traffic (z = -40)
  instead of the old slab edge, and one new case pins the horizon between 0.55
  and 0.8 of the way up the frame at every aspect and focus, with the donkey
  below the centre and its sign above the strip.
