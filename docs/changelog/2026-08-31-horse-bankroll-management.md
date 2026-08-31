# 2026-08-31 — Bankroll management, for every horse

Dan: _"we will have to add bankroll management fundamentals to all the horses
where they need to be aware of their current bankroll when choosing what games
to play... they need to understand the fundamentals of bankroll management and
learn how to book wins and not risk more of their stack than they should,
going down or up in stakes as their bankroll grows or shrinks."_

Every horse is being reset to 10,000 chips. From that moment
`club_members.chip_balance` stops being a number nobody consults and becomes
the constraint it should always have been.

## Why buy-ins, never chips

A bankroll rule stated in chips is meaningless across a ladder: 10,000 chips
is **fifty** buy-ins at 1/2 and **twenty** at 2/5. Every rule here is
denominated in buy-ins of the game being considered — the way the
fundamentals are actually taught, and the only unit that compares across
stakes.

The reference buy-in is a NORMAL stack (100bb, clamped to the table's own
spread), not the table minimum. Pricing the rule off the minimum would let a
horse sit games it cannot actually play at a normal stack — a mutation
confirmed it: switching to the minimum breaks five pins.

## The seven fundamentals, each pinned

1. **Sit only what you cover** — a stake needs `buyInsToSit` behind it.
2. **Move up on a cushion, not on a heater** — `buyInsToMoveUp` is strictly
   higher than `buyInsToSit`, so one winning session cannot promote a horse
   into a game it cannot sustain.
3. **Move down early** — dropping below `moveDownAt` steps down while there
   is still a roll to rebuild from. Deliberately a higher bar than going
   broke: the point of moving down is never to get there.
4. **Never bring too much** — one buy-in is capped at `maxBankrollFraction`
   of the roll whatever the table allows. A 400 max buy-in is not an
   instruction to a horse with 3,000 to its name.
5. **Book wins** — up `stopWinBuyIns` for the session, rack up and leave.
   The part players find hardest, and the reason Dan asked for it by name.
6. **Stop losses** — down `stopLossBuyIns`, the session is over.
7. **Broke means freerolls** — below one buy-in of the cheapest game there is
   no cash play at all, only freerolls and the weekly rakeback.

The session verdict reads the session's **P&L**, not the stack in front of
it, so a deep-stacked horse that is stuck is never mistaken for a winner.

## Temperament, so the fleet is not a single organism

584 horses moving up and down in lockstep would be visible. Temperament comes
from the id hash and is stable per horse: **nit** needs 40 buy-ins,
**standard** 25, **gambler** 12. Every temperament still obeys all seven
rules — the numbers move, the discipline does not, and a test asserts the
ordering holds for each.

## Wired at both decision points

- The **candidate filter** now refuses a horse that cannot cover the stake.
  It sits ALONGSIDE the earned stake band, not instead of it: a band says
  what a horse has EARNED, the bankroll says what it can AFFORD, and both
  must agree.
- The **buy-in** is capped to the policy's share of the roll and re-clamped
  to the table's limits, keeping the human-looking 5bb rounding. A zero cap
  skips the seat rather than buying in short.

Bankrolls load ONCE per seeding cycle, keyed per (club, user) because a horse
belongs to several clubs and its roll in one is not its roll in another.

**An incomplete read disables the gate rather than emptying the floor.**
Treating a short page as "everyone is broke" would clear the entire fleet on
one bad read; `atomic_table_buyin` still refuses a seat the balance cannot
cover, so the worst case is exactly the pre-bankroll behaviour.

## Verification

- tsc clean both roots; services **612 tests / 56 files**, engine
  **1,502 / 133**.
- 30 new pins.
- **Six mutations, every one caught**: move-up bar collapsed to the sit bar
  (3 fail), share-of-bankroll ceiling removed (2), stop-win removed (1),
  reference buy-in priced off the minimum (5), move-up no longer stricter
  (1), the seating gate unwired (2).

## One thing for Dan before the reset

The floor currently runs **1/2 and 2/5 only** — there are no micro games. A
standard horse needs 5,000 to sit 1/2, so after the reset a horse that loses
half its 10,000 has nowhere to rebuild except freerolls. That is exactly the
behaviour asked for, but it means **the freeroll schedule and the weekly
rakeback are now load-bearing**, and a micro tier (0.10/0.25) would give the
ladder a bottom rung to climb back up. Flagged rather than invented: adding
stakes to the floor is a product decision.
