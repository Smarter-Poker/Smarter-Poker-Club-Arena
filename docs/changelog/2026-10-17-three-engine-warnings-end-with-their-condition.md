# Three engine warnings end with their condition (2026-10-17)

Three warnings stayed open after the condition they describe had ended.

## The Free Buy audit and the frozen guarantees

On 2026-10-16 the board moved to "a real room's day": Free Buys at 8:30,
12:30, 4:30, 8:30 and 12:30 Chicago, guarantees doubled to 500 and 1,000. The
28 occurrences already spawned for 2026-10-17..19 were moved onto the half
hour by `20261017105003`. Their guarantees could not be raised:
`trg_freeze_registered_tournament_settlement_contract` freezes a guarantee at
the first entrant, for every caller including the engine, because a
registered player's advertised contract is immutable.

The hourly audit judged those events against the doubled tier and would have
reported "guarantee 250, the standard tier is 500" until they played out.
`auditFreeBuyRow` now accepts the guarantee a date before
`FREE_BUY_HALF_HOUR_BOARD_FROM` (2026-10-20) was published with. The
half-hour start is still required on every date, a guarantee that matches
neither tier is still wrong, and from 2026-10-20 only the doubled tier passes.
Read live after the move: every future Free Buy is on :30; dates before 10-20
hold 250/500, and 10-20 holds 500. The watch closes its own alert on a clean
read, as before.

## The Stable Hand counter write

All three `HorseFleet.stableHandState` warnings ever raised were transient and
each was closed by hand. The 2026-10-16 13:02 one was the first cycle after
the thaw: its upsert never reached the API (no POST in the edge log), and the
next cycle, 30 seconds later, wrote. Two changes:

- `writeStateRows` sends a failed chunk once more inside the same cycle. It is
  a full-row upsert keyed on `horse_id`, so the second attempt is the same
  write.
- The fleet closes the warning after a cycle in which every folded row was
  accepted (`stableHandStateAlert.ts`), checked at most every ten minutes and
  read from the database, so a warning left by a replaced engine also closes.

## The rake spec checksum

`RakeSpec.checksum_unavailable` describes one unreadable tick, and every later
tick of 2026-10-17 matched. The guard now resolves open rows on the next
readable tick (match or mismatch), and on its first readable tick after boot.

Pinned in `FreeBuy.test.ts`, `stableHandStateAlert.test.ts` and
`rakeSpecGuard.test.ts`.
