# 2026-09-04 — River Squeeze + Card Presentation Engine

Dan: "IM UPLOADING A VIDEO OF HOW THE CARD SLIDE SHOULD WORK AND FUNCTION ON
THE RIVER. I WANT YOU TO REVIEW THE VIDEO FRAME BY FRAME AND WATCH HOW THE
RIVER CARD." Plus the River Presentation Engine spec (130 sections).

## What the video shows (RIVER SQUEEZE ANIMATION.MOV, 220x480 @ 30fps, 412 frames)

| Frames  | Time   | What the client does                                                                                          |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| 155-288 | ~4.4s  | River arrives FACE DOWN in the fifth slot. Board `4d 7s As Td [back]`. Nothing on the felt moves.             |
| 289     | +0ms   | Back starts compressing horizontally; a dark edge shows on the left. A `rotateY` flip, not a `scaleX` squash. |
| 290     | +33ms  | Back is a ~25%-wide sliver, still the back pattern.                                                           |
| 291     | +66ms  | Face `7s` already at ~100% width. Edge-on and expansion fell between two captured frames.                     |
| 292-293 | +130ms | Slight settle, then static.                                                                                   |

So the reveal is a ~100-130ms snap, back -> sliver -> face, after a deliberate
face-down hold. The hold is the tension; the squeeze is the flip.

## What was there before

- `ccRiverReveal` (700ms): a ONE-SIDED face flying in from a 50/65px offset,
  spinning mirrored through `rotateY(180 -> 0)`, with a `brightness(1.4)`
  flash and scale pops. The generic travel-and-scale the spec forbids.
- The all-in `slow-reveal` path (land via `ccFlopLand`, hold 0.75s, `ccFlopFanOpen`)
  already had the two-surface land-then-flip, hand-tuned to 1.25s.
- Undealt slots rendered `null`, so the centred row slid left by half a card
  when the turn landed and again on the river, the 60% / 80% separators only
  lined up once five were out, and the community area's height changed every
  street (it is `translate(-50%, -50%)` centred, so it moved vertically too).

## What changed

### `src/presentation/cardPresentation/` (new, street-generic)

- `types.ts` — profile, event, phase, telemetry types. Frame-by-frame findings in the header.
- `profiles.ts` — THE ONLY place a duration is written: cash 560 / tournament 640 /
  lightning 420 / mobile 360 / replay 960 / background 280 / reduced 120 / off 0,
  and `allIn`, whose hold is DERIVED from `HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS`
  so it totals exactly 1250ms. `SQUEEZE_KEYFRAME_SPLIT` pins the CSS percentages.
- `resolveProfile.ts` — reduced-motion > hidden > all-in > background > mobile > mode.
  Table focus is an INPUT (the multi-table manager owns it). No "off" preference exists.
- `animationKey.ts` — `table/hand/board/street/slot`; per-table-per-board lanes.
- `CardPresentationEngine.ts` — idempotent registry (bounded), stale-hand rejection,
  lane pre-emption, one completion timer per presentation, phases by monotonic
  clock, cancel/skip/cancelTable/forgetTable/dispose, listeners, telemetry.
  Reads no poker state; nothing waits on it.
- `telemetry.ts` — PostHog via `src/lib/analytics`, 5% sampled for start/complete,
  every cancel/skip/duplicate. Never carries the card.
- `CardPresentationDebug.tsx` — `?rsDebug` overlay, `import.meta.env.DEV` only.

### `CommunityCards.tsx` / `.css`

- The river, and the all-in turn, call `cardPresentationEngine.presentCard()`.
  `started` -> mount the two-surface `.community-cards__flip` markup with the
  profile as inline `--rs-prepare/--rs-hold/--rs-flip/--rs-overshoot/--rs-stagger`.
  `duplicate` / `stale` / `instant` -> the slot renders its final face, no animation.
- CSS: `ccRiverMaterialize` (prepare: opacity + scaleX 0.9 -> 1, in place, no
  travel) on `.community-cards__card--squeeze`, then `ccRiverSqueeze` on the
  flip: `rotateY 0 -> 90` (ease-in, back to its edge) at 37.5%, `90 -> 180`
  (ease-out, face expands) at 75%, `scale(--rs-overshoot)` at 90%, rest at 100%.
  Transform + opacity only. Resting state face up. `--river` stays as a marker.
- `ccRiverReveal`, `--cc-river-duration`, the `slow-reveal` block, and the
  `.table-page--allin-mode` 1s/1.3s `!important` overrides are deleted.
- Undealt slots render `.community-cards__slot-reserve` (`visibility: hidden`,
  same flex sizing on the felt). Dan's 2026-08-26 "no ghost outlines" holds:
  nothing is drawn. The board is now five fixed positions at every street.
- Interrupts: new hand / hidden table / unmount cancel the presentation and
  the board renders its authoritative state.
- New props: `tableId`, `handId`, `boardIndex`, `gameMode`, `isFocused`,
  `isVisible`. TablePage passes them at all four board sites (RIT runs use
  their `boardIndex`; bomb-pot boards 2/3 stagger by the profile).

### Other

- `handCompletionSpec.ts` (both copies, byte-identical): the
  `ALL_IN_STREET_REVEAL_MS` comment now describes the squeeze.
- `tests/e2e/live-animations.spec.ts` beat 8: `ccRiverMaterialize` 80 +
  `ccRiverSqueeze` 480 on the real markup (was `ccRiverReveal` 700).
- `tests/protected-features.json`: `river-squeeze-presentation` entry.

## Law compliance

- 10.6 Animations always play: no toggle was added. `off` is only ever
  resolved for a table that is not on screen; every visible table animates.
  Every CSS duration is `calc(X * var(--animation-speed, 1))`; the JS window is
  `max(1400, profile + 100) * getAnimationSpeed()` and outlives the CSS.
- Reduced motion: the global 1ms rule collapses the squeeze and the flip's
  resting transform is face up, so the board is simply correct.
- The spec's "Animation: Full / Reduced / Off" player setting (section 119)
  was NOT added: it contradicts 10.6 and Dan's law outranks the spec.
- 10.5 Horses: presentation-only; nothing here inspects who is seated.

## Tests

- `tests/unit/cardPresentation/engine.test.ts` (16), `profiles.test.ts` (16),
  `riverSqueezeStylesheet.test.ts` (12), `tests/components/RiverSqueeze.test.tsx` (12).
- Existing: `animations-always-play.law`, `handCompletionLaw`,
  `GameplayAnimations.simulation`, `winningCardHighlight`,
  `mobileBoardAndActionBar`, `noUnreachableSettingsUi`, `inlineAnimationsResolve`,
  `stylesheetIntegrity`, `bombPotGuards`, `rabbitHuntInteraction`,
  `protectedFeatures`, `heroCardsNeverCollideWithBoard.law` all green.

## Not in this PR (honest scope)

- Lightning mode: profile exists, no lightning table type exists in Club Arena
  to resolve it. Replay: `HandReplay.tsx` does not use `CommunityCards`; the
  replay profile is defined but not wired. Feature flags: the repo has no flag
  system; rollback is reverting this PR (presentation-only, no migration).
- Visual regression screenshots at 25/50/75/100% (spec 106) and the
  1,000-hand leak test (spec 98): the engine's `activeCount` is asserted to
  return to zero, but no long-run harness was added.

## Concurrent work

A second agent was building a different river squeeze at the same time
(`card_slide` opt-in DB setting, flat `scaleX` squeeze, no hold, no flip).
Flagged to Dan in chat; the two branches conflict on the same files.
