# 2026-09-05 — Card Presentation Engine: audit fixes

Dan: "do a deep dive and verify that everything you've built in the previous
phase is 100% fully built, coded, wired in and tested. CHECK FOR ANY AND ALL
BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES."

An adversarial read of the merged, **live** code (`2167a74af2`) found eleven
real defects, two of them things a player would see. This fixes all of them,
and — more importantly — replaces the tests that failed to catch them.

## The two that were visible in production

### 1. The replay card disappeared for the whole reveal — CRITICAL

`.hr-felt__card` was `display: inline-flex` with no size, on my reasoning that
it would "hug the CardImage exactly". That is true only while the card is NOT
squeezing: **every** element `SqueezeCard` renders is `position: absolute`, so
during a reveal the wrapper had no in-flow child, collapsed to **0×0**, and
took its absolutely-positioned children with it. The card vanished for ~1s and
the board row reflowed around the hole — on the one surface a player is
deliberately studying.

Measured in Chromium against the shipped bundle: **width 0**. With the fix: 35.

The wrapper carries the card's own box now, pinned by test to the `sm` size
class the replay board renders, so the two cannot drift.

### 2. `cancel()` never reached the pixels — CRITICAL

The engine's cancel path did everything except stop the animation. On a resize,
an orientation change or the tab backgrounding, `cancelAll` dropped the entry,
cleared its timers, released the lane and emitted `animation_cancelled` — and
the browser carried on running the flip to completion, against the geometry
the interrupt existed to escape. **The Phase 2 interrupts were visibly inert.**

Worse, the cue was paid at that moment on the stated reasoning that "an
interrupted squeeze renders the authoritative card immediately", which was not
true. On an all-in river the snap landed up to **750ms before the face
appeared** — the exact defect the owed/paid mechanism was written to fix.

The subscriber now unmounts the temporary markup on `cancelled` (which drops
the card to its authoritative face-up state on the next paint) and only then
pays the cue. Clearing the newly-dealt set covers the flop too.

## The rest

| #   | Defect                                                                                                                                                                                                                                                                                                                                            | Fix                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3   | A started **flop** stored its key nowhere, so unmount/hidden could not cancel it — two live timers ran against a destroyed component and it reported a completed animation for a board that no longer existed                                                                                                                                     | every street registers in `activeSqueezeRef`                                                                                                           |
| 4   | `useCardSqueeze` used **base** ms for its mount window while the CSS scales by `--animation-speed`; at the sanctioned maximum of 3 the replay ran 2.88s against a 1.06s window and snapped face-up mid-flip                                                                                                                                       | scaled, like the felt                                                                                                                                  |
| 5   | The replay hook never heard about a cancel at all                                                                                                                                                                                                                                                                                                 | it subscribes now                                                                                                                                      |
| 6   | The **flop** reported `durationExpected: 560ms` for an animation that takes **1220ms**, and measured itself on the same wrong number, so the two agreed and both were wrong by half                                                                                                                                                               | `FLOP_FAN` / `FLOP_FAN_TOTAL_MS`, read back out of the stylesheet by test                                                                              |
| 7   | `animation_started` used the caller's mode/platform, `animation_completed` used the profile constant — a tournament all-in started `tournament` and completed `cash`; a phone completed `desktop`; a **tablet always** completed desktop, since no profile is one                                                                                 | both ends carry the resolved input                                                                                                                     |
| 8   | `latestHand` and `laneProgress` had no bound and nothing pruned them; `useCardSqueeze` gives every replayed hand its own surface id, so 500 hands in the hand history left 500+ entries in a process-global singleton for the life of the tab                                                                                                     | bounded, oldest-first, like `processed` — and `laneProgressSize` exists now, because the absence of a counter is exactly why the soak could not see it |
| 9   | `isVisible` was never passed by TablePage, so `focus: 'hidden'` and the whole `off` profile were **unreachable in production** — spec 47 was not in force                                                                                                                                                                                         | all four boards pass it                                                                                                                                |
| 10  | The flop's deal stagger was the one number in the fan `--animation-speed` did not touch; below speed 0.4 the second and third cards began turning over **while still in the air**, at the fastest setting a player may choose                                                                                                                     | scaled                                                                                                                                                 |
| 11  | The host's five-layer `box-shadow` and its two full-size pseudo-elements (gloss at z-index 3, sheen at 2) painted over the flipping card, so at the edge-on instant a 2px spine sat inside an unchanged full-size rectangle, and the shadow layer that exists so an edge-on card casts almost nothing was composited on top of a full card shadow | the host lends its decoration to the card that is turning                                                                                              |
| 12  | `phaseAt` had two identical `return 'settle'` branches                                                                                                                                                                                                                                                                                            | one                                                                                                                                                    |

## The tests are the real fix

The audit's sharpest finding was about my own tests. The interrupt behaviour
was "covered" by `expect(tsx).toContain("cancelActiveSqueeze('new-hand')")`
and by a hand-written `{ cancelAll }` stub. **Both pass on a completely broken
component, and both did.**

- `tests/components/CardPresentationInterrupts.test.tsx` renders the real board
  and asserts what is on screen after a cancel. Run against the shipped
  component, **4 of its 7 fail**; against the fix, all 7 pass.
- The replay-box test runs in real Chromium, because happy-dom does no layout —
  every unit test measured zero and could not tell a collapsed card from a
  healthy one. Against the shipped CSS it reports width 0.
- `tests/unit/cardPresentation/auditFixes.test.ts` pins the flop's real
  duration to the stylesheet, the telemetry dimensions across an animation's
  lifetime, and the bounds on the two maps.

## Verification

- `npx tsc --noEmit` clean.
- vitest: **664 files**, all passing.
- Playwright in real Chromium against this commit's own build: **24 passed** —
  `live-animations`, `flop-fan-open` (all five flop beats, unchanged by the
  stagger scaling at speed 1), and the squeeze regression including the two
  new layout/decoration checks.
- Each critical fix was additionally proven by running its new test against
  the pre-fix code and watching it fail.
