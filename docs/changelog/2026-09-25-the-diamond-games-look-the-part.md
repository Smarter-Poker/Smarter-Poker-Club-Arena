# The Diamond Games Look The Part: Plinko In The House Colours, A Night Highway, A Sky For The Jet, And A 25x Ceiling

Owner rulings of 2026-09-21 (Dan), the four the earlier lanes left open:

1. "Inside of diamonds to chips, the mobile play is very choppy" (the wheel):
   delivered on 2026-09-21 as R20 (`2026-09-21-the-wheel-turns-on-the-compositor.md`)
   and live at `41e9a06158`. Re-measured today from this tree with
   `scripts/dev/diamond-wheel-render.mjs perf 4 6` (393 x 852 at device pixel
   ratio 3, CPU throttled 4x): idle median 12.0 ms, p95 26.0 ms; spin median
   12.4 ms, p95 26.2 ms; 0 frames over 50 ms, 0 long tasks. Nothing further to do.
2. "On Diamond Plinko the bottom is rainbow colored instead of smarter.poker
   color schema."
3. "On Donkey Cross ... the graphics are very crude, basic and boring, instead
   of dynamic, and high def. Also if a user books a win, it should tell them how
   far they could of gone." (The slant was fixed on 2026-09-21; the rest is here.)
4. "For Crash, the graphics are very crude ... the back round is terrible, and
   the multiplier should be 25x max and that should be displayed to the user ...
   it should never CRASH before 1.1x and if a user books the win it should show
   them how high it would have gone." (The 1.10x floor landed on 2026-09-21 in
   `20260921203512`; the rest is here.)

## Plinko: the bucket scale is the house palette

`TINT_RAMP` in `src/components/plinko/PlinkoBoard.tsx` ran blue, teal, green,
yellow, orange, red. It now runs deep navy `#1c3d74`, royal blue `#1877f2`,
light blue `#45adff`, ice `#9fd3ff`, chrome `#e4e7ec`, gold `#ffd700` to
amber `#ffb300`. The scale is still absolute and logarithmic on the multiplier
(`bucketHeat` unchanged), so 20x is the same gold on every table and the 3D
slot row, the engraved ink and the legend's value bars all read from it. The
legend says "Gold Pays The Most." `PlinkoBoardPresentation.test.tsx` pins the
new schema: cold is blue-dominant, hot is gold, and no tint on the whole scale
is green-dominant or pulls red more than 90 away from green.

## Donkey Cross: a night highway, and the route you did not take

`src/components/games/ChoiceScene.tsx` (CrossingScene only) and its stylesheet.
The road is one merged plane wearing a seeded procedural asphalt DataTexture
(grain, mottle, two darker and smoother tyre tracks per lane, a lighter lane
centre) under a light clearcoat, so the lamp and the headlights lie on it as
wet streaks. Lane markings are one merged geometry, cat's-eyes one
InstancedMesh (blue-white on dividers, gold on the edge lines), kerbs on both
shoulders, lamp pools every second street. Exactly three lights: a shadow
casting key, the blue rim, and one warm SpotLight that follows the camera focus.
The 30 lane cars are eight instanced draws (new silhouette: belt line, tinted
clearcoat cabin, arches, seams, mirrors, chrome bumpers and hubs, lit headlamps
with a beam texture on the road, red tail wash, blue underglow); the three cars
that come to the donkey's street are Groups from the same parts, so the
approach-and-brake, anticipation, collision and sealed-proof ordering are
untouched. Street signs are one mesh reading a 4 x 4 canvas atlas in the house
style (black glass, chrome bevel, number in light blue, multiplier in gold; blue
LED edge on current and next, chrome once crossed, gold to gold-red by hazard
band, bust red only on the crash). The camera pose of 2026-09-21 is unchanged:
no yaw, no roll, the road prints straight.

When a win is booked and the sealed road end is known, a gold-edged plate
prints "How Far You Could Have Gone / You Could Have Gone To Street N At X.XXx /
You Booked Street S At Y.YYx" (variants: "All The Way To Street N", "The Next
Street Was The Crash", "The Donkey Would Have Stopped Before Street 1"). As the
ghost walks, every street it would have survived lights gold on its sign and in
the strip (`data-route="reachable"`), and the street that would have hit it
gets a red-edged sign with the car standing on it (`data-route="crash"`). The
readout copy the tests assert on is unchanged.

Not done, on purpose: a sky, skyline and lamp posts. With the ruled camera
(pitch 37, fov 22) the frame is ground from about z = +6 to z = -12 and the
horizon is 26 degrees above the top edge; nothing above the far kerb is ever in
frame, and the camera stays as ruled.

## Crash: a sky instead of a planet, a ceiling you can see, and how high it went

`src/components/crash/CrashCurve.tsx` and its stylesheet. The cartoon planet is
gone. The flight climbs through a shader sky (obsidian to deep navy with a
faint royal-blue nebula) in front of two starfields on different depths that
wrap in the vertex shader and drift against the flight, faster as the
multiplier climbs; a light-blue horizon glow sits under the launch line and a
small dark world sits in the lower corner where the curve never goes. The curve
is an additive ribbon over a soft fill down to the launch line, rewritten in
place per frame, coloured calm blue, gold past 2x and white-gold past 5x like
the hero, red from the head backwards on a crash. The jet is a lathed chrome
fuselage with a clearcoat canopy, royal-blue swept wings, wingtip lights, twin
flickering afterburners and a head glow that agrees with the glass head marker;
wake particles fade behind it. The crash adds a blow-out flash, a shockwave
ring and sparks on the tangent; reduced motion gets the static final frame. The
camera pushes in up to 7 percent along its line to the launch point so the
launch line never moves and the glass, placed by the same camera, stays on the
curve. The frame is black glass with a chrome hairline and four blue LED corners.

The cap: a permanent "Max 25.00x" chip (`data-cap`) top-right, a gold dashed
cap line on the axis once the scale reaches it, and a round settled at the cap
reads "Booked At The 25.00x Max". The page says "Every Round Is Capped At
25.00x." and "It Would Have Booked At The 25.00x Max First." When a booked
flight's replay reaches the sealed crash point, a plate in the lower third
(`data-reveal="would-have-gone"`) prints "It Would Have Gone To 9.50x / You
Booked 2.57x", or "It Crashed Right After You Booked", or "It Would Have Gone
To The 25.00x Max". The existing Cashed and Crashed glass markers, the axis, the
auto and floor lines, `onTick` and `tickerCents`, and every `onSettled` timing
are untouched; `CrashCurvePresentation.test.tsx` gains four pins for the chip,
the line and the plate.

### The 25x cap itself: migration `20260925143159`

Applied to PokerIQ-Production at 14:33 UTC on 2026-09-25 (recorded as
`20260925143307` `20260925143159_diamond_crash_is_capped_at_twenty_five_times_the_stake`).
`fn_crash_config_limits` now clamps `max_multiplier_cents` to 2,500 for every
crash config written (it was 10,000), and both live crash configs (the club
host and the union host) went from 10,000 to 2,500 in the same transaction;
read back: `[{club, cap 2500, k 0.04}, {union, cap 2500, k 0.04}]`. Every round
started from that moment is sealed with `cap_cents = 2500` (a pool that cannot
cover 25x still caps lower, as before); rounds sealed earlier keep their own
`cap_cents` and settle under it. The crash-point distribution, the 1.10x floor,
the 1.11x cash-out opening and the 0.80 return of every target are unchanged;
each round now reserves a quarter of the chips it did. The client's fallback
cap (`DiamondCrashPage.tsx`) is 2,500 as well.

## Verification

- `npx vitest run` over the 29 touched-area files (crash, crossing, choice,
  plinko, replay library, the animations law, the migration-version laws):
  29 files, 611 tests passed.
- `npx tsc --noEmit -p tsconfig.app.json`: clean. `check-title-case.mjs` and
  `check-painted-text-case.mjs`: clean. eslint on every touched file: 0 errors
  (15 pre-existing warnings).
- Headless before and after shots at 393 and 1280 through the new
  `scripts/dev/diamond-test-shots.mjs` (the fixture page, SwiftShader WebGL):
  `test-results/shots-before/`, `shots-donkey/`, `shots-crash/`,
  `shots-crash-crashed/`, `shots-plinko/` in the worktree (not committed;
  `test-results/` is ignored).
