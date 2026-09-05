# The KO knockout: full audit (bounty / PKO / mystery-pre tournaments)

2026-09-04. Dan: "SEE HOW WE BUILT THE ANIMATION FOR THE KO INSIDE BOUNTY
TOURNAMENTS, WE BUILT THIS PERFECTLY FRAME BY FRAME, DO A DEEP DIVE AND AUDIT."

Read against **current `origin/main` (`ddcabab7`)**, which is also exactly what
production serves (`build-info.json` `ca_sha` = `ddcabab7de58...`, built
2026-09-05T00:40Z). Nothing below is taken from a worktree. Note: the checkout
at `~/Documents/club-arena` is parked on a dead branch
(`fix/agent-open-pr-skip-ci-2`, upstream gone) and its `TablePage.tsx` is
1,149 lines away from main; the knockout regions inside it happen to be
byte-identical to main, but the rest of that tree should not be trusted.

## 1. Status in one paragraph

Shipped in two PRs: #1687 (2026-08-28, architecture + timing, one SVG glove)
and #1766 (2026-08-29, Dan's two branded gloves, the flurry, sound rebuilt
from measurements, throwable reuse). One cosmetic commit since (#2273, the
aria-label went Title Case). Tests: `tests/components/BountyAnimations.test.tsx`

- `tests/animations-always-play.law.test.ts` run green today, 103/103.
  Both glove renders are live on production (HTTP 200, `image/webp`, 49 KB and
  50 KB). The engine path that fires it has run **7,508 times** since 08-28
  (`tournament_bounties`), so the pipeline is exercised hourly; what has NOT
  happened is a human on the receiving end. Since the flurry landed at
  2026-08-29 11:53 there are **zero** rows where a human was the knocker or the
  victim. Every knockout in production since then has been horse-on-horse.
  Whether a human was sitting at one of those tables as a third party cannot be
  told from that table.

## 2. Files

| Role                      | File                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Component + timing consts | `src/components/table/SeatKnockout.tsx` (680 lines)                                                                           |
| Every keyframe            | `src/components/table/SeatKnockout.css` (932 lines)                                                                           |
| Art                       | `public/images/knockout/glove-left.webp`, `glove-right.webp` (512px)                                                          |
| Trigger, dedupe, bounty   | `src/pages/TablePage.tsx` (handler ~L11809, ship effect ~L16330)                                                              |
| Sound                     | `src/services/SoundService.ts` `playKnockoutFlurry`, `scheduleKnockoutCall`, `playBountyCollected`                            |
| Seat reaction hook        | `src/components/table/SeatSlot.tsx` (`data-seat-num`, `.seat__cards`)                                                         |
| Throwable reuse           | `src/components/table/ThrowAnimation.tsx` (`boxing_glove` -> `KnockoutFlurry`)                                                |
| Engine                    | `server/src/tournament/TournamentManagerEliminations.ts` `eliminatePlayer` -> `processBountyCollection`                       |
| Money                     | `fn_collect_bounty` (latest: `20260902222000_bounties_and_refunds_settle_through_obligations.sql`)                            |
| Darkroom                  | `scripts/dev/preview-seat-knockout.mjs` (40 KB)                                                                               |
| Pins                      | `tests/animations-always-play.law.test.ts`, `tests/components/BountyAnimations.test.tsx`, `tests/e2e/live-animations.spec.ts` |
| History                   | `docs/changelog/2026-08-28-the-knockout-happens-at-the-seat.md`, `2026-08-29-seat-knockout-graphics-rebuild.md`               |

## 3. Architecture (the four decisions everything else hangs on)

1. **It happens at the seat.** `SeatKnockoutLayer` is mounted INSIDE
   `.table-scaler`, a SIBLING of the seat ring, and positions each hit from
   the same hero-rotated `seatPositions` percentages the seats, dealer button
   and deal animation use. Sibling, not child, because `player_eliminated`
   nulls the seat within milliseconds and the KO stamp must keep burning over
   the empty chair.
2. **An array of live hits, not a queue.** Two victims in one hand get two
   gloves, two stars, two stamps on the same frames. `useAnimationQueue` is
   deliberately not used here (pinned).
3. **Nothing covers the felt.** `.sko-layer` is `pointer-events: none`,
   z-index 615 (over seats and chip fans, under `.pot-win-float` at 620).
4. **One speed variable, three clocks.** Every CSS duration is
   `calc(<n>s * var(--animation-speed, 1))`; every JS timer multiplies by
   `getAnimationSpeed()`; the audio cue takes `speed` and schedules on the
   AudioContext clock. Reduced motion collapses the drama and keeps the stamp
   (`data-motion="keep"`).

Sizing: `--sko-unit` = `--seat-avatar-base` (56 / 66 / 84 / 104 px by
breakpoint). Box 3.6u x 4.4u with `contain: layout paint size` (was clipping
the star until 08-29). No `will-change` anywhere; measured at eight
simultaneous knockouts: 240 animations, mean 16.67 ms/frame, p95 17.5 ms.

## 4. The master timeline, frame by frame (speed 1.0, t0 = hit mounted)

Every number below is read out of the shipping CSS/TS/audio code, not the
changelogs. Percentages are of the 930 ms glove pass.

| t (ms)   | Visual                                                                                                                             | Seat                                                                          | Audio                                                                                                             | Money                                                                                                                                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0        | RIGHT glove appears lower-right at (+0.882u, +1.021u), scale 0.8, rot -5deg; opacity 1 by 46 ms                                    |                                                                               | wind-up: swept noise 800->2600 Hz, ~171 ms                                                                        |                                                                                                                                                                                                                                                                                                |
| 112      | LEFT glove starts to appear lower-left at (-0.771u, +1.108u); opacity 1 by 167 ms                                                  |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| **180**  | **RIGHT LANDS** at (+0.144u, +0.167u) scale 1.04; warm burst `.sko__hit` at (+0.26u, +0.13u) scale 0.62                            | flinch #1 (200 ms, +0.07u/2.6deg jolt); `.seat__cards` desaturate over 500 ms | jab: 86 Hz + 129 Hz sines, 55 ms noise crack @1500 Hz, gain 0.5                                                   |                                                                                                                                                                                                                                                                                                |
| 214      | right follow-through to (+0.235u, +0.272u)                                                                                         |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 242      | warm burst 1 gone                                                                                                                  |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 279      | burst element repositioned to the left side (invisible)                                                                            |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 307      | right glove retracted to (+0.523u, +0.606u)                                                                                        |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| **320**  | **LEFT LANDS** at (-0.126u, +0.181u) scale 1.04; warm burst 2 at (-0.26u, +0.13u) scale 0.66                                       | flinch #2                                                                     | jab 2 (same recipe)                                                                                               |                                                                                                                                                                                                                                                                                                |
| 353      | left follow-through                                                                                                                |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 391      | burst 2 gone; right glove holding                                                                                                  |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 409      | left retracted to (-0.457u, +0.657u)                                                                                               |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 420      |                                                                                                                                    |                                                                               | **"K.O." call** starts (impact - 40 ms), 300 ms, F0 342->157 Hz                                                   |                                                                                                                                                                                                                                                                                                |
| 430      | second star (`.sko__star-alt`, 40%) starts, 280 ms                                                                                 |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 440      | felt light starts (1.5u, 500 ms); main star + shards start (240 ms each)                                                           |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| **460**  | **BOTH LAND** at (+0.209u, +0.242u) / (-0.183u, +0.263u) scale 1.14; core flash (0.42u, 340 ms); ring crack (0.7u -> 2.5x, 300 ms) | flinch #3                                                                     | **finisher**: body sines + 120 ms crack @2600 Hz + 3800->1500 Hz snap, gain 0.85 (hero 1.0); haptic medium/strong |                                                                                                                                                                                                                                                                                                |
| 469      | main star at full size (12% of 240 ms)                                                                                             |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 502      | gloves settle scale 1.06                                                                                                           |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 540      | 16 embers begin, staggered 0..210 ms, lifetimes 440..590 ms, ballistic arc, stretched along velocity                               |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 550      | star peak 1.07x                                                                                                                    |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 651      | gloves withdrawing                                                                                                                 |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 680      | main star + shards gone                                                                                                            |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 710      | alt star gone                                                                                                                      |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 720      |                                                                                                                                    |                                                                               | call ends                                                                                                         |                                                                                                                                                                                                                                                                                                |
| 760      | ring gone                                                                                                                          |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 800      | core gone                                                                                                                          |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 893      | gloves invisible (96%; capture measured +860)                                                                                      |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| **930**  | **KO STAMP** starts (`skoStampLife` 1470 ms): enters scale 2.2 rot -4deg; white frame flash (260 ms); red shockwave ring (420 ms)  |                                                                               | stamp tick: 880 Hz square 140 ms + 440 Hz triangle 200 ms                                                         | **TablePage timer fires**: chip streams (3-8 sprites, 40 ms apart) from EACH victim seat to the knocker; ONE `+N` `.pot-win-float` (measured PokerBros yellow #ffe94a) rides the first stream, parks above the winner, rises and fades over 2.2 s; hero gets `playBountyCollected` (cha-ching) |
| 940      | felt light gone                                                                                                                    |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 1003     | stamp slams: opacity 1, scale 0.93, rot +1.5deg                                                                                    |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 1062     | overshoot 1.03                                                                                                                     |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 1136     | settled 1.0 / 0deg (capture: square and readable by ~1020)                                                                         |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 1190     | stamp flash gone                                                                                                                   |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| ~1340    | last ember dies                                                                                                                    |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 1350     | shockwave ring gone                                                                                                                |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| 2135     | stamp begins to fade (82%)                                                                                                         |                                                                               |                                                                                                                   |                                                                                                                                                                                                                                                                                                |
| **2400** | stamp gone (scale 1.22); `onDone(id)` -> hit removed from `koHits`                                                                 |                                                                               |                                                                                                                   | float cleaned at 2400                                                                                                                                                                                                                                                                          |

Meanwhile the seat itself: `player_eliminated` arrives a beat after
`bounty_collected` and TablePage nulls the seat immediately, so the chair
reads EMPTY under a stamp that is still burning. That is the reference.

**Reduced motion:** gloves, bursts, star, core, ring, light, shards, embers,
flash, shockwave and flinch all `animation: none; opacity: 0`. Only the stamp
plays (`skoStampReduced`, 1.1 s, no delay: in by 110 ms, hold to ~900 ms, out
by 1100 ms). Audio collapses to one hit at 0 ms and the stamp tick at 120 ms.
`onDone` at 1400 ms.

**Background table (multi-table):** visuals run, audio does not
(`playSounds` read through a ref so a tab switch cannot restart a knockout).

## 5. Each element and where its numbers came from

- **Gloves**: Dan's renders, pre-rotated, so the CSS translates along each
  glove's own diagonal ((-0.653, -0.757) right, (0.571, -0.821) left) and
  rotates by at most 8deg. Width 0.86u. The negative margins put THE FIST on
  the seat: fist measured off each alpha channel at (0.658, 0.207) left and
  (0.292, 0.226) right; `transform-origin` is that point so a snap pivots at
  the contact. Landings are deliberately a fifth of a unit short so the face
  stays readable. Preloaded at module scope (`new Image()`), served via
  `mediaUrl()` so they can move to a CDN with `VITE_MEDIA_BASE`.
- **Warm bursts (jabs)**: ONE `<svg class="sko__hit">` that flashes twice,
  transparent between, orange-gold gradient (#fffdf4 -> #ff6a12). Half the
  size of the finisher on purpose so three landings do not read as a drum roll.
- **Star (finisher)**: two hand-authored irregular paths, 15 needles (tips
  34-105 vs valleys 10-16, clustered, not 360/15) plus a 13-needle second set
  at 40% and a different rotation. Core measured (251,252,255) white, holds
  past 45% of the radius. Two dead ends recorded: valleys 13-23 = snowflake,
  22-34 = sheriff's badge. `transform-box: view-box` + origin (100,100)
  because the bbox centre of an irregular star is 12 units off. Bloom via two
  static `drop-shadow`s on the whole SVG (one filter per knockout, not per
  path). Longest needle 1.05u, about two seat widths across.
- **Shards**: six hard-edged slivers on the impact frame, gone in 240 ms.
- **Core**: 0.42u, `mix-blend-mode: screen` (real here because the star is in
  the same stacking context; NOT used on the felt light, where it would blend
  against nothing).
- **Ring crack**: 0.7u -> 2.5x, 300 ms, one frame behind the star.
- **Felt light**: 1.5u translucent warm bloom, small on purpose (the old
  full-screen overlay's sin).
- **Embers**: 16 fixed `[dx, dy, size, delayStep]` entries (never
  `Math.random()`), sizes 0.026-0.078u, rotation = atan2(dy, dx) so each
  stretches along its own path (scale 3.4x1 while fast), apex carries the
  only upward bias, colour burns white -> gold -> orange -> nothing.
- **Stamp**: SVG glyph paths, not a font ('Arial Black' does not exist on
  Android). Face gradient #ff5a44 / #fc0000 (measured red) / #b60000,
  extrusion #5c0000 offset 4 down, top bevel stroke #ff9d86, skewX(-7deg).
  Width 0.95u, sits at -55% (across the card faces). Gradient ids are
  `useId()`-scoped (multi-table safety, pinned).
- **Seat flinch**: `.seat--ko-flinch` on the busted `SeatSlot`, found via
  `rootRef.closest('.table-page')` + `[data-seat-num=index+1]` (1-based), once
  per landing with a forced reflow between remove/add so the 2nd and 3rd
  actually retrigger; removed at 280 ms; uses `translate:`/`rotate:` (never
  `transform:`, which would stomp the seat's own hero/active/winner scale).
  Distance is a fraction of `--seat-avatar-base`, not pixels.
- **Victim cards**: `.seat--ko-flinch .seat__cards` desaturate + darken over
  500 ms to cover the gap until the seat nulls.
- **Hero variant**: `.sko--hero` only warms the stamp glow. Timing identical.
  This is the one deliberate deviation from the reference.

## 6. Sound, measured not guessed

`playKnockoutFlurry({ isHero, speed, punchesAtMs, stampAtMs, withCall })`,
one cue on the AudioContext clock (a `setTimeout` on a main thread re-laying
out a table that just lost a seat drifts, and the 50 ms priority window then
eats it). Speed clamped 0.1-4. Measurements off `KO KNOCKOUT.MOV` by onset
detection + STFT: seven onsets in 0.9 s (gaps 64/180/215/99/75 ms), decays
46-186 ms, body partials 86/129/172 Hz, cracks at 1.4 kHz or 3.7 kHz, band
energy 26% 120-400 Hz / 22% 400-1200 / 35% 1.2-4k / 8% above 4k. The "K.O."
is a synthesised source-and-formant voice (sawtooth 342->157 Hz, formants
640->230 and 1000->650 Hz, plosive burst) because the capture's recording is
PokerBros' asset. Replace with a real 300 ms falling close-mic'd recording at
`public/images/knockout/ko-call.webm` (the code comment names `KO_VOICE_URL`;
that constant does not exist yet, so wiring is still needed). The hero also
gets `playBountyCollected` on the money beat.

## 7. The data path, in order

Engine `eliminatePlayer(userId, position)`:

1. status -> `eliminated` (guarded; second call only re-releases the seat);
2. `bustedTableId` captured, THEN `releaseTournamentSeat` stamps
   `table_seats.left_at` (order matters: 08-24..08-27 every bounty died
   because the lookup ran after the stamp);
3. prize / bubble protection settle through `tournament_obligations`;
4. knocker found from the victim's LAST hand at that table via
   `attributeKnockout` (pot that held the final chips, tied pots -> weighted
   `claimants`);
5. `fn_collect_bounty(tournament, eliminated, collector, claimants)`: mode
   `regular` / `pko` / `mystery_pre`, capped at the unpaid pool, idempotent on
   `(tournament, eliminated_player)`, PKO half onto the knocker's head;
6. **`broadcast('bounty_collected', { mode, amount: paid_cash, addedToHead,
eliminatedName, eliminatedUserId, eliminatedAvatar, knockerName,
knockerUserId, avgBounty, poolRemaining, prizeRank, tableId })`** on the
   tournament channel (`t-break-<id>`);
7. `broadcast('player_eliminated', ...)`.

If the mystery phase is ACTIVE, step 5-6 are replaced by the chest path
(`mystery_bounty_pending` / `mystery_bounty_revealed`), so a mystery event
gets the flurry for pre-phase busts and the chest once chests open. Correct,
and verified at source.

Client (`TablePage` broadcast handler, the `else` of `mystery_bounty_revealed`):

- table scope: `if (b.tableId && b.tableId !== tableId) return;`
- one stamp per busted player: `koSeenRef` keyed by `eliminatedUserId`
  (a reconnect replay or the 5 s sweep re-emit cannot double-punch);
- seat: live roster first (the bounty broadcast precedes `player_eliminated`),
  else `lastSeatOfUserRef` (every roster change records where each user sat);
- `setKoHits([...prev, { id, seatIndex, eliminatedName, isHero }])`;
- money: accumulated per knocker in `bountyAwardAccRef`; the FIRST arrival
  starts a `SKO_STAMP_AT_MS * speed` timer; everything in that window sums;
  the timer ships `setBountyAwardFly`, whose effect flies one chip stream per
  victim seat (pot anchor fallback if a victim was never seen here) and ONE
  `+total` float. Timers cleared on unmount; refs cleared on table change;
- `bountyMap`: victim's head deleted, `addedToHead` added to the knocker.

## 8. Laws, tests, harness

- `tests/animations-always-play.law.test.ts` (row in `docs/LAWS.md`): no
  queue, sibling layer + `lastSeatOfUserRef`, flinch scoped/1-based/individual
  properties/once per landing/removed, stamp not a font + #fc0000, gloves via
  `mediaUrl` + preloaded + asymmetric fist anchors, throwable reuse (no
  stamp, no call, no caption, no voice line, `--sko-unit` from impact size),
  `useId` gradient ids, bounty on the stamp beat summed per winner, the
  CSS/JS speed pairs (0.93/0.24/0.46/0.93), `playSoundsRef`, reduced motion.
- `tests/components/BountyAnimations.test.tsx`: one cue on the audio clock
  with the beat table, hero flag, pointer-events none, every piece drawn,
  no hardcoded gradient id, stamp exempt from reduced-motion, expires and
  reports done per seat, an unplaceable hit still expires, silent in
  background.
- `tests/e2e/live-animations.spec.ts`: real `getAnimations()` durations:
  punchRight/Left/flurryHit 930, coreFlash 340, starBurst 240, ringCrack 300,
  ember 440, seatFlinch 200, stampLife 1470.
- `scripts/dev/preview-seat-knockout.mjs`: fifteen beats beside the capture's
  frames, eight simultaneous, four seat rungs, reduced-motion pass, real
  `.pot-win-float` rule read from `TablePage.css`, sound button.

## 9. What the audit found (new, verified against production)

**A. Split-pot knockouts are animated wrong.** The 2026-08-31 ruling made
`fn_collect_bounty` split a tied pot's bounty by claim weight and return
`shares: [{user_id, cash, to_head}]` plus `paid_cash` = the TOTAL. The engine
still broadcasts `amount: paid_cash` and ONE `knockerUserId`, and never reads
`shares`. So the client flies the whole bounty and shows `+total` at one of
the two winners; the other winner's seat gets nothing; and in a PKO the
client adds the full `addedToHead` to one head badge. Money in the DB is
right (7.50 + 7.50). Measured: **55 split knockouts since 08-30**, all
two-way, 0.7% of knockouts. Fix: broadcast `shares`, fan out one float +
head delta per share on the client.

**B. The `+N` float rounds cents away.** `spawnPotWinFloat` labels with
`Math.round(amount)` when amount >= 1, so a 7.50 bounty reads `+8` while the
seat's own `stackDelta` (which uses the 2 dp formatter) reads `+7.50` beside
it. **401 of 7,508 bounties (5.3%)** carried cents. Against Dan's 08-29
"exact to the cent" rule. Same code path labels cash-game pot floats. Fix:
one formatter (`formatStack`-style: integer when whole, 2 dp otherwise).

**C. Two numbers on the winner** (known since 08-29, still open): the bounty
`+N` float AND SeatSlot's automatic `stackDelta` `+N` both fire. Both true,
but two labels. Dan's call which one wins.

**D. A rebuy bust pays no bounty and plays no KO.** A busted player entitled
to a rebuy is removed from the elimination sweep before `eliminatePlayer`
runs, so no `fn_collect_bounty`, no broadcast, no glove. PokerBros pays the
knocker the head and gives the rebuyer a fresh one. This is a rule about what
players are owed, so it is Dan's decision, recorded here rather than changed.

**E. Latent, zero occurrences:** `koSeenRef` is keyed by `eliminatedUserId`
and cleared only on table change, and `fn_collect_bounty` refuses a second
collection for the same `(tournament, eliminated)`. A player who re-enters
after being bounty-collected and busts again at the same table would get
neither a stamp nor a second bounty. No re-entry after a bounty exists in
production since 08-28, so this is a note, not a bug report.

**F. Still true from the 08-29 doc:** never photographed on a real table (the
DB now confirms no human has been in a knockout since the flurry shipped); the
60 fps number is desktop at 84 px; the K.O. call is a synth; `z-index: 615`
is reasoned, not observed; the hero-warmer bloom is a deviation from the
reference; `KO_VOICE_URL` is mentioned in a comment but does not exist.

**G. Payload cruft:** `eliminatedAvatar` is still looked up and broadcast for
the deleted full-screen overlay; nothing reads it. One `profiles` query per
knockout for nothing. Harmless, removable.

Nothing in A-G changes a payout. A and B are display fixes with a clear path;
C and D are Dan's rulings.
