# The knockout happens at the seat

**2026-08-28 — Dan, with a PokerBros capture attached (KO VIDEO.MOV).**

> "NOTICE THE DETAILS AND ANIMATIONS OF THE BOXING GLOVES KNOCKING OUT THE
> OPPONENT, NOTICE THE BOUNTIES BEING AWARDED AND ANY AND ALL DETAILS, COMPARE
> IT TO WHAT WE HAVE AND MAKE EVERY SINGLE NECESSARY UPGRADE, ENHANCEMENT AND
> OPTIMIZATION NEEDED TO BE A 1:1 SCALE BUT BETTER."

## What the capture actually shows

51.9 seconds, 30fps, two knockouts: one watched (a villain busts another
villain) and one thrown by the hero, taking **two** bounties in the same hand.
Pulled apart frame by frame, taking t0 as the frame the glove first appears:

| Beat         | Offset      | What happens                                                                                                   |
| ------------ | ----------- | -------------------------------------------------------------------------------------------------------------- |
| Glove enters | 0ms         | A red laced glove with a cream cuff slides in from the **left edge of the busted player's own seat plate**     |
| Creep        | 0 → 430ms   | It travels the first third slowly, growing as it comes                                                         |
| **Impact**   | 460ms       | A white-hot spiked star detonates at the centre of that seat; the glove is already driven through to the right |
| Break-up     | 540 → 860ms | The star comes apart into drifting embers; the glove rotates away and exits right                              |
| **KO stamp** | 930ms       | Bold red `KO` slams onto the seat, red bloom, dark edge                                                        |
| Bounty       | ~930ms      | Chips arc from the busted seat to the winner; a gold `+N` floats at the winner's seat                          |
| Seat clears  | ~1200ms     | Cards, avatar and name fade to `EMPTY` — **the stamp is still burning over the empty chair**                   |
| Stamp out    | 2400ms      | It fades                                                                                                       |

Two findings that decided the whole design:

1. **Nothing goes full-screen.** The felt stays live underneath and the hand
   carries on.
2. **Simultaneous knockouts are simultaneous.** In the hero's double
   knockout both victims get their own glove, their own star and their own
   stamp **on the same frames**, and the hero gets **one summed** `+4,175` —
   not two labels stacked on one seat.

The audio is two bursts per knockout, not one: a wind-up over the glove's
travel (t0..+250ms) and the hit itself (+460ms..+1000ms).

## What we had

`src/components/tournament/KnockoutAnimation.tsx` — a 3600ms **full-screen
centre overlay**: vignette, eight rays, two shockwaves, the eliminated
player's head floating in, cracking and falling, a bounty count-up, a coin
scatter and a PKO split panel. Well built, and the wrong shape. Three things a
centre overlay structurally cannot do:

- **It cannot happen where it happened.** It named two players in text and
  left you to find the seat afterwards.
- **It cannot show two knockouts at once.** It was fed through
  `useAnimationQueue` — correct for one centre-stage ceremony — so the second
  knockout of a three-way all-in waited 3.6 seconds and then stamped a seat
  that had been empty for three seconds.
- **It cannot stay out of the way.** `pointer-events: none` meant it never ate
  a click, but it still dimmed and covered the board for 3.6s.

There was also **no seat-level bust animation at all**: `player_eliminated`
set the seat to `null` and it snapped to the `EMPTY` plate with nothing in
between.

## What this ships

**`src/components/table/SeatKnockout.tsx` + `.css`** — the glove, the star,
the embers and the stamp, drawn on the busted player's own chair.

- Mounted **inside `.table-scaler`**, reading the same hero-rotated
  `seatPositions` percentages the seat ring, the dealer button and the deal
  animation render from. A sibling of the scaler (where the old overlay lived)
  resolves those percentages against the wrong box and puts the glove on the
  board.
- A **sibling of the seat ring, not a child of a seat**. The stamp has to
  outlive the seat — `player_eliminated` nulls it within milliseconds, on
  purpose, because the server only stamps `table_seats.left_at` at the end of
  `eliminatePlayer` — and a child of `SeatSlot` would be unmounted mid-punch.
- The glove is **hand-authored inline SVG**: crisp at every seat size, no
  binary asset, no network request (so the _first_ knockout of a session
  animates, which a lazily-fetched sprite cannot promise), and no `<defs>`
  ids — two tables in a multi-table view mount two of these layers and
  duplicated gradient ids in one document repaint each other.
- **An array of live hits, not a queue.** Two heads, two chairs, same frames.
- Every CSS duration is `calc(<n>s * var(--animation-speed, 1))` and every JS
  timer multiplies by `getAnimationSpeed()`. The retired overlay scaled only
  its JS beats, so at 0.5x its CSS ran at double speed against its own timers
  and it stripped its own stamp mid-keyframe.
- Reduced motion collapses the glove, the star and the embers and keeps the
  **stamp** on a real, readable hold (`data-motion="keep"`). The stamp is the
  answer to "why did that chair just empty"; at 1ms it flashes for one frame,
  which is the same as deleting it.

**Two new sound cues** — `playKnockoutSwing()` and
`playKnockoutImpact(isHero)` in `SoundService`. The stamp's tick is scheduled
inside the impact cue on the **AudioContext clock** rather than behind a third
`setTimeout`: a main thread busy laying out a table that just lost a seat
drifts a timer by tens of milliseconds, and the 50ms priority window then eats
the late arrival outright. Same reasoning as `playDealSequence`.

**The bounty, summed and shipped on the stamp beat** (`TablePage.tsx`). The
engine broadcasts `bounty_collected` once per elimination, so a double
knockout arrives as two messages milliseconds apart. They are accumulated per
knocker for the length of one stamp beat and shipped as one number, with a
chip stream leaving **each** busted seat. `.pot-win-float` is reused rather
than reinvented — it is already the measured PokerBros yellow (`#ffe94a`), and
a bounty that looked different from a pot award would imply a difference that
does not exist.

`lastSeatOfUserRef` exists because of an ordering problem worth stating: the
money ships ~930ms after the punch, by which time the busted seat has been
vacated, so the roster no longer knows where to fly the chips **from**.

## Bugs fixed on the way

- **A knockout at another table played on yours.** `bounty_collected` rides
  the tournament channel, which every table in the event subscribes to. The
  mystery-bounty branch had always filtered on `tableId`; the knockout branch
  never did, so a bust on table 3 played a full-screen knockout on tables 1
  and 2, for strangers, over a live hand.
- **Repeat broadcasts stamped the same seat twice.** A reconnect replays the
  message and the 5s elimination sweep can re-emit it. One stamp per busted
  player now, guarded by a ref because the decision is made synchronously
  inside the broadcast handler.
- **A knockout that could not be placed leaked.** A hit for a seat this client
  never saw is now mounted, drawn as nothing, and still expires itself.

## Laws and pins

Per the animation law's own rule — _"if you are DELIBERATELY replacing a
mechanism with a better one, move the pin to the new mechanism in the same
commit and say so"_ — every knockout pin moved, and the ones the new shape
makes possible were added beside them:

- `tests/animations-always-play.law.test.ts` — `playSoundsRef` (unchanged in
  spirit, new file), plus new pins that knockouts are **not** serialised, that
  the stamp outlives the seat, that the bounty coalesces on the stamp beat,
  that the CSS/JS speed pair stays in step, and that reduced motion keeps the
  stamp.
- `tests/components/BountyAnimations.test.tsx` — the `KnockoutAnimation`
  block is replaced by a `SeatKnockout` block, including the two the old
  component could not be asked: simultaneous knockouts land on two seats, and
  an unplaceable knockout still reports done.
- `tests/e2e/live-animations.spec.ts` — the KNOCKOUT beat test now measures
  `skoGloveStrike` / `skoCoreFlash` / `skoRay` / `skoEmber` / `skoStampLife`
  against real `getAnimations()` durations.

## Verification

`npx tsc --noEmit` clean. `npx vitest run tests/` — **8409 passed, 545 files**.
`npm run build` clean.

Beyond that: **it was photographed against the reference.**
`scripts/dev/preview-seat-knockout.mjs` renders the real markup against the
real stylesheet in Playwright and screenshots it at the same timestamps the
capture was measured at, driving `currentTime` by hand rather than sleeping
(a sleep-and-shoot harness photographs a different frame on a loaded machine,
which is the one thing a reference comparison cannot tolerate). Two rounds of
that changed real numbers:

- the impact core was 0.78 units against 0.62-unit rays, and the glow
  swallowed the star — the hit read as a soft flare rather than a strike.
  Core down to 0.58, rays up to 0.88;
- the rays ran gold end to end and photographed as a cartoon sun. They are
  near-white for their inner half now, and carry **three** lengths rather than
  two, because twelve spikes alternating long/short still read as a pattern
  and the reference's star has no pattern in it;
- the glove was cut at 65% of its pass and left a 300ms hole between the hit
  and the stamp. It now rotates away until 96%, matching the +860ms in the
  capture;
- the stamp was wider than the two hole cards it sits on. 0.55 units → 0.46.

## Files

```
added    src/components/table/SeatKnockout.tsx
added    src/components/table/SeatKnockout.css
added    scripts/dev/preview-seat-knockout.mjs
deleted  src/components/tournament/KnockoutAnimation.tsx
deleted  src/components/tournament/KnockoutAnimation.css
changed  src/pages/TablePage.tsx
changed  src/services/SoundService.ts
changed  tests/animations-always-play.law.test.ts
changed  tests/components/BountyAnimations.test.tsx
changed  tests/e2e/live-animations.spec.ts
```
