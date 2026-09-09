# 2026-09-09 — Busts are processed in the order they happened

## What the backlog fix uncovered

#3912 unjammed the elimination sweep. As the backlog drained, a defect that had
been hidden behind it surfaced immediately:

```
[Tournament.bounty_elimination_claim_failed] atomic bounty elimination claim
FAILED for 554e1529 at place 19: pko_order_already_advanced
```

**79 in six minutes.** Measured across production: **49 knockout candidates left
permanently behind the PKO settlement watermark, in all three live PKO events.**
Forty-nine players who could not be eliminated and whose bounties could not be
paid — not delayed, stranded.

## Why

`fn_claim_bounty_legacy_candidate` keeps a per-tournament watermark and refuses
any claim for a hand _before_ it:

```sql
IF v_pko_watermark IS NOT NULL AND p_hand_number < v_pko_watermark THEN
  RETURN jsonb_build_object('ok',false,'reason','pko_order_already_advanced', ...)
```

That guard is correct. A progressive bounty's halves must settle in hand order,
and settling them out of order corrupts the arithmetic. But the hand number of a
bust never changes, so a claim that arrives late is refused **for ever**.

And the sweep was handing them over in the wrong order. It sorted the busted
batch by chips:

```ts
let bustedOrdered = [...busted].sort((a, b) => (a.chips ?? 0) - (b.chips ?? 0));
```

Every candidate in that batch holds **zero** — that is what makes them busted —
so the comparator returned 0 for every pair and the order was whatever Postgres
happened to return. Under a backlog, that reliably interleaves hands, the
watermark advances past an earlier one, and the earlier one can never land.

## Two things were wrong, not one

The arbitrary order was also wrong for the **standings**. The first entry in the
batch takes the worst remaining place, and the player who busted first is the
player who finished last. Chips cannot say who busted first. The hand number can,
and it is the witness that was actually there (CLAUDE.md 10.9).

## The fix

Order the batch by the hand the bust actually happened in, read from the pending
knockout candidates:

1. **refusal streak** — still first, because it is the deadlock breaker from
   #3912: a player who cannot be eliminated at all must not hold the queue;
2. **hand number** — the order the busts happened, so the watermark advances
   monotonically and cannot overtake a claim not yet made;
3. **chips** — last resort, for a candidate with no recorded hand.

A failed read is UNKNOWN, not "no order": it reports and falls back to the chip
tiebreak rather than inventing one. A missing hand number sorts **last**, so it
can never claim it busted first and take a place belonging to somebody the engine
watched.

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `npx vitest run src/tournament/`: **115 files, 1,193 tests, 0 failures.**
- The pin I wrote an hour earlier asserted the chip comparator was the primary
  sort. It is not any more, so it moved to the new mechanism in the same commit
  (CLAUDE.md rule 8) and now also asserts the streak is compared _before_ the
  hand number.

## Still owed, and named so it is not lost

This stops new strandings. It does **not** release the 49 already behind their
watermarks — their hand numbers are still below it, and letting them through
now would settle progressive halves out of order, which is the corruption the
guard exists to prevent. That settlement needs its own read of each affected
tournament's bounty arithmetic and is tracked separately.
