# The Diamond games audit closes every gap (2026-09-26)

After the seven phases of the mobile spins programme merged, each phase was read again line by line against its brief. This change fixes everything that reading found. No player-facing copy changed except where noted, and no gate was weakened.

## Phase 1: the quality governor and the warm-up

- **Reduced motion no longer reads as a slow phone.** The governor judged every frame against a 30 ms (Crash, Plinko) or 16 ms (Donkey Cross) pace, but a reduced-motion loop draws every 150 to 180 ms by design, so every such frame counted as slow and the scene stepped itself down to the floor tier, remembered for the session. Each scene now hands the governor the pace it is actually drawing at (`kit.render(intervalMs)`, `frames.render(pace)`), Donkey Cross included for its 33 ms idle pace, and a gap over one second (a hidden tab, a paused or off-screen scene, a redraw-on-change scene) is treated as a pause, not a slow frame (`RESUME_GAP_MS`).
- **The shaders compile once the scene is dressed.** `gameRenderer` started `compileAsync` before Crash and Plinko had added their objects, so it compiled only the lights and the first real frame still stalled. The warm-up now starts on the first `render()` call, when the scene is complete.
- **A tier that turns shadows off compiles ahead of the next frame.** Turning shadow maps off re-links every material; that re-link now runs through the same held warm-up, on every scene, instead of stalling a frame on the device that was just found too slow.
- **The first-load placeholder shows.** The WebGL canvases were opaque from the moment their context existed, which covered the CSS placeholder under them. They are now created with `alpha: true`; every drawn frame still clears to the scene's opaque background, so a drawn frame looks the same.

## Phase 2: Crash

- **The launch line breathes only between rounds.** Its animation sat on the base rule, and a running animation overrides `opacity: 0`, so it pulsed over the flight and the result. The animation now lives on the idle rule only, and the reduced-motion rest applies only while idle.
- **An auto cash-out line just under the cap no longer overprints the "Max" label.** When the two labels would collide, the auto label prints under its own line.

## Phase 3 and 4: Donkey Cross, Plinko

- **The idle traffic follows Animation Speed**, like every other motion in the scene.
- **The Plinko sparkle trail lives out its whole fade in a batch.** A batch of about thirty diamonds took a slot of the 96-sparkle ring every frame, so each sparkle was recycled at about a fifth of its life. Each diamond now spaces its sparkles in time by how many are in flight, and a slot that is still fading is never taken over.
- **No per-frame allocation in the Plinko frame loop**: the cabinet's frame description and the batch's struck-peg list are reused.
- `TRAFFIC_Z` is now shared by the scene and its camera test, instead of a copied constant; unused exports were dropped.

## Phase 5: sound and haptics

- **A booked Mines win is celebrated once.** The board played the booked sting and its buzz, and the receipt then played the win chord and a second buzz. The Mines receipt is now silent like Crash and Donkey Cross, whose scenes also sound their own ending. The test fixture page follows the same rule.
- **The Crash engine holds the tapped figure after a cash-out tap**, instead of climbing through the network round trip while the hero figure is frozen.
- **A Plinko board that cannot draw (no WebGL, a lost context) still clinks and buzzes its landing**, once per report, at the best bucket landed.
- **Reduced motion keeps the Donkey Cross beats**: a safe street still squeals to a stop, and the arrival is one hoof step. Plinko's per-peg patter stays off under reduced motion because the diamond does not travel; its landing clink and buzz remain.

## Phase 6: the receipts

- **The Crash crown goes to a round booked at its own cap**, passed from the round (`cap_cents`), not a fixed 25x, so a 20x round booked at 20x wears it and a 25x booking on a higher-capped round does not.
- **A Mines round lost on its first pick shows a single ghost outline**, not a gem, beside "0 Gems Found".

## Phase 7: CI

- **The visual baseline also runs** for `src/pages/diamondGames.module.css`, `src/hooks/useSceneBudget.ts`, `src/utils/animationSpeed.ts`, `src/utils/crossingScene.ts` and `src/styles/**`, which all change the pictures.
- **A retried pass in the other CSS Beat suites is named too.** They have run with one retry for a long time but never reported a flaky pass; their invocation now writes a JSON report that the same summary script reads, in its own step.

## Tests

New or extended: `tests/unit/qualityGovernor.test.ts` (pace per frame, pause gaps), `tests/unit/plinkoSparkle.test.ts`, `tests/components/DiamondGamesSound.test.tsx` (engine holds at the tapped figure, undrawable Plinko clinks, reduced-motion Donkey Cross beats), `tests/components/DiamondChoiceAutoSettle.test.tsx` (a booked Mines receipt is silent), `tests/components/BonusCompletionArt.test.tsx` (crown at the round's cap, the empty Mines fan), `tests/components/CrashCurvePresentation.test.tsx` (the launch line breathes only while idle) and `tests/ci-tells-the-truth-faster.law.test.ts` (the CSS Beat flaky summary).
