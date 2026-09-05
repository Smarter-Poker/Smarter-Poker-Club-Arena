# The board squeeze is a VIP perk: all-in only, per viewer, and in the player's hand

2026-09-05

Dan, verbatim, at the end of the previous session:

> "1, IS THE 'RIVER SQUEEZE' JUST AN ANIMATIONS OR DOES IT ALLOW THE USER TO
> ACTUALLY CONTROL THE 'SQUEEZE' ON DESKTOP DRAGGING IT TO 'OPEN' AND MOBILE
> WITH TOUCHING AND SLOWLY SQUEEZING IT? ...
> 2, THIS FEATURE SHOULD ONLY BE PRESENTED AS AN OPTION AND DISPLAYED ON 'ALL
> INS' (BEFORE THE RIVER OBVIOUSLY) AND SHOULD NEVER APPEAR ON RUN IT 2X OR 3X.
> AND THIS SHOULD BE A VIP GATED PERK AND 'TURNED ON' BY DEFAULT. IF A NONE VIP
> MEMBER TRIES TO TURN IT ON THEY SHOULD BE INSTRUCTED THAT THEY NEED A VIP
> CARD TO USE THIS FEATURE. AND ONLY TO THE USERS THAT ARE 'ALL IN' THE BOARD
> AND RUN OUT SHOULD APPEAR 'NORMAL' AND NO DIFFERENT FOR ANY OTHER USERS AT
> THE TABLE. IF ANY OTHER 'ALL IN PLAYERS' DON'T HAVE VIP, OR HAVE IT 'TURNED
> OFF' IT SHOULD ONLY DISPLAY FOR THE USERS WHO HAVE ACCESS TO IS, AND HAVE IT
> ENABLED."

Two things were put to him this session and both are now decided:

- **Interactive, not animation only.** The all-in VIP drags (desktop) or
  touch-squeezes (mobile) each run-out card open; it opens on its own before
  the next street lands if they do not.
- **Every run-out card, the river included.** "Before the river" describes
  the all-in, not the streets: an all-in that happens before the river has
  cards still to come, and every one of them squeezes. The river is the money
  card.

Two more were settled from the repo rather than asked:

- **"A VIP card" is the membership.** `is_vip` + `vip_tier` + `vip_expires_at`
  resolved by `src/utils/vipStatus.ts`, VIP or Lifetime VIP; there is no other
  rung (`docs/laws.d/vip-is-not-a-ladder.md`).
- **The per-user toggle does not collide with Animation Law 10.6.** Recorded
  as a ruling in `docs/LAWS.md` so the next agent does not "fix" it.

## What was there

Since 2026-09-04 every turn and river ran the squeeze, and on an all-in
run-out EVERY seat at the table got the `all-in` profile: the card lay face
down for `ALL_IN_STREET_REVEAL_MS` (1750ms) and snapped over exactly as the
server's equity gate opened. Nothing was interactive on the board (the
hole-card peel in SeatSlot is; `grep -rn onPointerDown src/presentation/`
returned nothing). Run It Twice avoided the all-in profile only by an accident
of state ordering: `allInEquities` happened to be cleared before the RIT
boards drew.

## What is there now

### Who sees it

`viewerMaySqueeze()` (`src/presentation/cardPresentation/squeezeEligibility.ts`)
is Dan's sentence as four booleans: the viewer is seated and `all_in` this
hand, holds a VIP card, has `all_in_squeeze` on, and the hand is not being run
more than once. TablePage computes it from what the client already knows and
passes it to the board as `squeezeEligible`. **Nothing is broadcast for it** -
a wire field saying who is squeezing would tell the table who is a VIP, and
the test pins that `ServerTableEngineRunout.ts` mentions neither squeeze nor
VIP.

`resolveCardAnimationProfile` now requires `allIn && squeeze` to choose the
`all-in` profile. An all-in run-out without the right falls through to the
ordinary profile for the platform and mode - byte-for-byte what a non-all-in
street resolves to, pinned across every platform/mode/focus combination. That
is R7: the folded player, the spectator, the all-in opponent with no VIP card
or the perk off, all see the normal reveal on the normal rhythm.

### Run It Twice, explicitly

`ritRunsThisHand` (state, set at `rit_all_accepted` / `rit_mandatory`, cleared
at the hand boundary with the rest of the RIT state) feeds eligibility, and
every RIT board is rendered with `runs={2..3}`, which `boardMaySqueeze()`
refuses regardless of the viewer. Two layers, both pinned, neither relying on
the old ordering accident.

### The player's hand on the card

- `CardAnimationProfile.interactive` marks the `all-in` profile. Its hold is
  no longer a pause but a CEILING.
- `CardPresentationEngine.releaseHold(key)`: on an interactive presentation
  still in prepare/hold, ends the hold NOW and re-bases squeeze -> reveal ->
  settle to that instant, rescheduling the completion and reveal-beat timers.
  The board's owed snap sound therefore follows the player's hand. A new
  `holdTimer` announces `squeeze` at the ceiling, so the ceiling and the
  release take the same path into the pixels.
- `CommunityCards` writes `--rs-drag` (0..1, pointer travel over 0.9 of the
  card width, any direction, `Math.hypot`) straight onto the host on every
  pointermove - no React state per move, because a squeeze is a pointermove
  stream and 95% of players are on phones. Letting go past 0.6 calls
  `releaseHold`; below it the card springs flat. `touch-action: none` keeps a
  thumb from scrolling the felt. Pointer events cover mouse and touch alike.
- `cardSqueeze.css` gains `data-rs-hold`: `drag` parks the keyframes and
  drives `rotateY(calc(var(--rs-drag) * 90deg))` with the spine and shadow
  following; `released` runs `ccCardSqueezeFrom`, the same four beats as
  `ccCardSqueeze` with its first frame at the dragged angle, delay 0.
  Compositor-only throughout.

### The ceiling, derived

`ALL_IN_SQUEEZE_CEILING_MS = ALL_IN_STREET_REVEAL_MS + min(ALL_IN_STREET_PAUSE_MS,
ALL_IN_PRE_SHOWDOWN_PAUSE_MS) - ALL_IN_SQUEEZE_SNAP_RESERVE_MS = 1750 + 1200 -
400 = 2550ms`, in `handCompletionSpec.ts` (both mirrors, still byte-identical).
The two pauses are the engine's own literals copied into the spec and pinned
equal by test; the engine does not read them from here because its pacing
tests grep them as literals. The snap reserve is pinned equal to the profile's
prepare + squeeze + reveal + settle. So a squeezed card is always face up
before the next street or the pot can land, on every street including the
river.

### The equity the squeezer sees waits for the card

A squeeze may legitimately outlive the equity gate (1750 < 2550). For THAT
viewer, and only that viewer, TablePage holds the DISPLAYED equity at the
previous street's numbers until the engine's reveal beat: `useHeldValue`
(`src/hooks/useHeldValue.ts`, a render-time freeze, because an effect would
paint one frame of the river's 100% first) feeds `displayedEquities` into the
per-seat overlay and the seat-wrapper lift. `allInEquities` itself, the ALL IN
banner and the RIT panel are untouched. Dan 2026-08-28 stands: "EQUITY CHANGES
ONLY AFTER THE FLOP IS DISPLAYED, (NOT BEFORE OR DURING)".

The `rabbitAuditFollowups` pin that asserted "face up by the equity gate at
every speed" was rewritten to "face up by the ceiling at every speed" - the
stopwatch this profile answers to moved, the clamp to speed <= 1 did not.

### The setting

`user_table_settings.all_in_squeeze boolean NOT NULL DEFAULT true`, migration
`20260905195426_...sql`, applied to production and verified
(`is_nullable NO`, `column_default true`). Declared in
`scripts/ci/schema-manifest.d/vip-all-in-squeeze.json`. On the
`USER_TABLE_SETTING_COLUMNS` relay allowlist (the #3165 pin would have caught
its absence). `TABLE_SETTINGS_META` row carries `vip: true` and is deliberately
NOT `quick` - the Hero Hub's quick list writes through `toggleSetting` with no
gate in front of it.

`TableSettingsPanel` renders the EFFECTIVE value, `stored && (isVIP ||
vipLoading)` (`effectiveSettingValue`), so a non-VIP sees the switch off
whatever is stored and a VIP never sees it flash while the check is in flight.
A non-VIP tap emits `SHOW_TOAST` with "You Need A VIP Card To Use The All In
Squeeze. Visit The VIP Page To Get One." and writes nothing. Default true for
everyone means a member who becomes a VIP tomorrow finds the perk on.

## The audit before the next phase (same day, same branch)

Dan's standing rule: before moving on, prove the previous phase is fully
built, wired and tested. Read back against the engine and the page, three
gaps and three stale sentences, all fixed on this branch before it merged:

1. **"All in" was too narrow.** Eligibility read `status === 'all_in'`. The
   engine's `ALL_IN_RUNOUT` carries `getActivePlayers()`, which includes the
   player who CALLED the shove with chips behind - no more decisions, money
   in the middle, named in the equity broadcast - and that player would have
   been denied the perk in every heads-up all-in they covered. `heroInRunout`
   is now: status all-in OR named in `allInEquities` (by id, or by seat where
   an entry has no id).
2. **Bomb-pot boards 2 and 3 did not squeeze.** Only board 1 was passed
   `squeezeEligible`, so on a double or triple board the squeezer's second
   board flipped on its own while the first sat under their hand. Every board
   is eligible now, each reports its hold, and the displayed equity waits for
   the UNION of boards still face down (`holdingBoards`).
3. **No keyboard path.** The host announced itself as a button with no way to
   press it. `tabIndex=0`; Enter or Space opens the card from flat.
4. `ALL_IN_STREET_REVEAL_MS`'s doc (both mirrors) still promised "the face is
   up exactly when this gate opens"; the `slowReveal` prop doc still said it
   ran the all-in profile; `cursor: grab` lingered on the opened card. All
   corrected.

Checked and found sound: the settings cache merges defaults so the new key is
never `undefined` on a warm start; no felt-level pointer handler or
pointer-events rule sits between a thumb and the board card; the replay
(`useCardSqueeze`) never passes `allIn`; the `squeeze` phase the engine now
announces is ignored by every other subscriber; the flop path never sets a
hold; reduced motion still outranks the perk.

**One design question left for Dan, not built:** on a PRE-FLOP all-in the
flop is a run-out street too, and it still deals as the three-card fan (one
street, one server window, three cards). Squeezing three cards one by one
does not fit inside the pacing; squeezing the flop as a group would need its
own gesture. The turn and river squeeze regardless of where the all-in
happened.

## What was deliberately not built

- **Reduced motion still outranks the squeeze.** A viewer with
  `prefers-reduced-motion` gets the cross-fade, never the interactive hold.
  The perk is a motion feature; the law says motion collapses.
- **No server change.** The engine's pacing is untouched; only the spec
  mirror under `server/src/config/` moved, and it is config.
- **No new wire field.** See above.
- **The hole-card peel (`card_slide`) is unrelated** and untouched.
- **Lightning** untouched, as instructed.

## Verification

- `npx tsc --noEmit` clean, app and engine.
- Client vitest: 14,089 passed after the two moved component pins were updated
  (`RiverSqueeze.test.tsx`, `CardPresentationInterrupts.test.tsx` rendered the
  squeezer's view with `slowReveal` alone; they now pass `squeezeEligible`,
  and `RiverSqueeze` gained two pins: the ordinary-for-everyone-else board, and
  an early release through the engine).
- Engine vitest: 5,760 passed, 401 files.
- `npm run build:ci` clean.
- `tests/unit/vipAllInSqueeze.test.ts`: 31 pins (the page pin widened by the
  audit); run against the pre-feature tree, 19 failed as designed.
  `RiverSqueeze.test.tsx` gained the keyboard-release pin in the audit.
- Not done: a play-through on a real table with two all-in seats, one VIP and
  one not. The pointer path is exercised by the component test through
  `releaseHold` directly, because happy-dom has no pointer capture. That is
  the item to watch first.
