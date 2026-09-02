# Ticker: only an MTT starting, or a real overlay on the last late-reg level

Dan, verbatim:

> the ticker needs to be adjusted to only announce when a MTT Is starting, and
> only if an overlay alert is in the last level of late registration, and has
> less then 50% of the prize pool of the guarantee yet registered

## What the ticker said before

Two things, which is already the right number, but the second one spoke far too
often:

1. A scheduled MTT starting inside five minutes. Unchanged.
2. An overlay, gated on **75% of the late-registration window having elapsed**
   and **at least 10% of the guarantee still missing**.

## What changed

Both overlay gates were replaced, in `src/utils/overlayAnnouncements.ts`.

**When.** `LATE_REG_ANNOUNCE_FRACTION = 0.75` is gone. It measured wall-clock
progress through `lateRegEndMs`, which is a sum of blind-level durations, and
levels run long when a table is short-handed or the clock is paused. Worse, a
row that did not carry `blind_structure` and `level_started_at` could not place
the 75% point at all, so the gate failed closed on events that were in fact on
their final level. The gate is now the level itself: `isInLastLateRegLevel`
asks whether `current_level === late_reg_levels - 1`. `late_reg_levels` is a
0-based cap (the engine keeps the door open while `current_level <
late_reg_levels`), so that comparison IS "the last level of late registration",
exactly, with no estimate anywhere in it.

Checked against production before relying on it: all 2,013 guaranteed MTTs
carry `late_reg_levels`, so the strictness silences nothing real.

**How much.** `MIN_OVERLAY_FRACTION = 0.1` is replaced by
`MAX_REGISTERED_FRACTION = 0.5`, and the test is written the way Dan stated the
rule: the field must have paid in LESS THAN half the guarantee. On a 20,000
guarantee that is a prize pool under 10,000. The old bar spoke about a 2,000
shortfall that one late table closes.

`MIN_OVERLAY_CHIPS = 100` stays as an absolute-nonsense floor.

## Horses

`prize_pool` and `current_players` are the club's own totals and they already
count every horse, at the same buy-in, out of the same club wallet. Nothing in
this module or in the ticker filters on `is_horse`, and a test in
`tests/unit/overlayAnnouncements.test.ts` now asserts that with comments
stripped, so a future "house players should not count" pass goes red instead of
inventing a shortfall the house is not covering (CLAUDE.md 10.5).

## Files

- `src/utils/overlayAnnouncements.ts` — both gates, `isInLastLateRegLevel`,
  `MAX_REGISTERED_FRACTION`, and the marquee copy now says "Last Level Of Late
  Registration" rather than the vaguer "Late Registration Open".
- `src/components/tournament/TournamentStartingTicker.tsx` — the header now
  states the two things this bar is allowed to say; `blind_structure` and
  `level_started_at` are dropped from the overlay query because nothing reads
  them any more.
- `tests/unit/overlayAnnouncements.test.ts` — rewritten. The specs that pinned
  the 75% window and the 10% shortfall pinned rules the product no longer has,
  so they are replaced in the same commit rather than left asserting the old
  behaviour.

## Verified

- `npx tsc --noEmit` clean.
- `npx vitest run` over the ten suites that touch the ticker or the overlay
  module: 160 tests, all passing.
