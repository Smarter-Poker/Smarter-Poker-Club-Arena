# Phase 2 of 6 — a seat nobody paid for

2026-09-02. Every other money check on this platform asks whether the money
that came in reached the players it was owed to. This one asks the question
underneath them: did it come in at all.

## What I expected to find, and what was actually there

I opened this phase expecting to fix a live leak — my own note from the end of
Phase 1 said "271 seats across 35 events, 3,034.10 chips, still live". That
figure was wrong in both directions and the word "live" was the part that
mattered.

Re-derived from scratch against production, the real population is **464 seats
across 81 events, 2,530.80 chips of entry that was never collected — every one
of them between 2026-08-19 00:01 and 2026-08-20 23:45.** Nothing since.

The cause: horses were **seeded** into fields rather than **registered** into
them. Two independent witnesses agree, which is why I trust it. No
`wallet_transactions` debit, and no `chip_transactions` row either — so no
wallet moved, on either ledger. And `rake_records` proves the register
functions never ran at all: across the 39 COMPLETED events in that window there
is exactly **one** rake row, and it came from `fn_spin_settle_game`. Those 39
events collected 6.00 chips of entry money and 0.00 in fees, and paid out
1,734.00 in prizes, of which 1,373.00 was guaranteed money the club had already
promised.

**The cause was fixed before this phase existed, and not by me.**
`fn_register_horse_for_tournament` began charging horses real chips on
2026-08-19 — the change `tournamentRecovery` records as "the day the old rule
'horses paid nothing' became false" — and the last unfunded seat on the
platform was created the following night at 23:45:28. A horse now pays the same
buy-in, the same fee and the same rake as anybody else, which is section 10.5
and not a tuning knob.

So there was nothing here to fix and nobody here to pay. What there was, was
nothing that would have noticed it running, and nothing that would notice it
coming back.

## Verifying the instrument before believing the reading

Two checks I ran on myself, because the first pass of this analysis produced a
number I could not reproduce.

**The chip_transactions matcher was proved before it was believed.** Matching a
seat to its wallet debit by name and time could easily find nothing because it
is broken rather than because nothing is there. Pointed at seats that provably
DO have a `wallet_transactions` row it found **11,626 of 11,626, 100%**;
pointed at the 464 it found 0. Both witnesses, independently, say the same
thing.

**The detector was pointed at the known-bad window before it was shipped.**
A detector that returns zero everywhere is not a detector. The identical logic
against 2026-08-19/20 returns 464 seats / 81 events / 2,530.80 chips — the same
figures reached independently from `chip_transactions`. Against the live 48
hours it returns 0.

## What shipped

**`fn_uncollected_entry_check(hours)`** — the four ways a seat is legitimately
paid for, **enumerated rather than inferred**:

1. a `wallet_transactions` `tournament_buyin` debit — the ordinary door, human
   or horse;
2. a satellite seat award — the player already paid, in the satellite, and the
   seat IS the prize;
3. a flight advancement — a day past the first is bought by surviving day one;
4. the event charges nothing.

Anything else is a seat nobody paid for. Enumerating is the whole design: a
check that decides for itself what "looks legitimate" will eventually excuse
the next leak too. The satellite exemption reads **three** witnesses, because
each has a birthday — `is_satellite_qualifier` has only been written since
2026-08-27, `source_satellite_id` since 2026-08-30, and a zero-fee target
writes no rake row at all. Any one alone would call a legitimately free seat a
leak.

It moves no money, files one deduped alert for the condition rather than one
per seat, is registered in `money_check_heartbeat` from the moment it exists,
and is stamped by the driver on every hourly pass — in its own `try` block,
with the health board still reading last.

**It refuses a window it cannot answer.** `wallet_transactions` has only
carried `tournament_buyin` since 2026-08-19, when `log_wallet_transaction` was
wired into the register path. Before that date an absent debit proves the
LOGGER was absent, not the payment — 22,981 perfectly healthy seats sit behind
it, and a check reaching back past it would report a catastrophe that never
happened. The 48-hour cap makes that unreachable; the function asserts it
anyway, because caps get raised by people who did not read the comment.

## The live finding: a satellite seat is a payout, and not one had ever been recorded

Chasing the one event that still showed unfunded seats — Sunday $200 Deep Stack
— turned up something real, and it is not what I went looking for.

The event is fully and correctly funded. 115 seats: 92 registrations and 23
satellite seats. `prize_pool` 44,640 plus `total_rake` 4,960 is 49,600, which
is exactly 248 x 200. And 248 is exactly `92 registrations, 23 satellite seats
and 133 rebuys` — every increment has a source, and nothing is missing.

(That sum was written with arithmetic signs on the first pass, and Prettier read
a wrapped line starting `+ 133 rebuys` as a markdown bullet and normalised it to
`- 133 rebuys`. A plus silently became a minus in a sentence about money. Words
instead of signs here, and the same care is owed anywhere a formatter can reach
a number.)

What IS missing is the record. `fn_award_satellite_seat` writes a
`tournament_payouts` row for the seat it awards — the seat is worth the
target's buy-in plus fee, paid out of the satellite. That block arrived in
migration `20260831192927` at 2026-08-31 19:29. The most recent satellite seat
on this platform was awarded 2026-08-30 20:10.

**The block is not broken. It has never once executed.** Zero
`source='satellite_seat'` rows existed platform-wide, and no alert either,
because the failure path never ran either. 23 seats worth **4,600.00 chips** of
prize value had been paid to players and were absent from the payout ledger —
the same record-completeness hole the structure-prize backfill closed in the
previous phase, in a different door.

Back-filled, every field reconstructed from the rake row
`fn_award_satellite_seat` itself wrote, under the key the live function uses so
a re-drive writes nothing. Positions came from each player's recorded finish in
their satellite; all 23 were known, and an unknown one would have been left
NULL rather than guessed.

## Evidence

Applied to production as `20260902041336`. Function body verified against
`pg_proc.prosrc` by md5 rather than assumed:

```
fn_uncollected_entry_check   525d8b466979e1eb5cb764be8e867973   5912 bytes
```

```
fn_uncollected_entry_check(24)   1453 ms   12,678 seats checked   0 unfunded
fn_uncollected_entry_check(48)   1386 ms                          0 unfunded
tournament_payouts source=satellite_seat   23 rows   4,600.00 chips   0 positions unknown
money_check_heartbeat                       7 checks registered (was 6)
ACL on the new function        postgres, service_role — no anon, no authenticated
```

**The index helped less than the migration predicts, and the honest number is
recorded next to the prediction.** The planner does now take
`idx_tournament_players_registered_at` (14,489 rows in 132ms instead of a
parallel seq scan discarding 93,727), but total runtime moved only 1.85s to
1.45s: the remaining second is the `wallet_transactions` read, not the roster
read. The index is worth keeping — it is the term that grows with the roster —
but it is not what makes this check fast, and whoever next hunts a slow run
here should look at `wallet_transactions` first.

22 new pins in `ASeatNobodyPaidFor.law.test.ts`, registered in `docs/LAWS.md`.
Post-merge with `origin/main`: server **3623/3623**, client **11407/11407**,
both `tsc --noEmit` clean, `check-definer-authorization` OK on the committed
migration, law registry **74 assertions**.

A re-drive of the back-fill was proved harmless the way section 11.5 requires,
inside a transaction that was rolled back: the identical INSERT writes **0
rows**. And no satellite seat has been awarded since the record block landed
(0 awards after 2026-08-31 19:29), so the live path is still unproven by
execution — the first real award will be its first run.

## Two things found on the way that are not this phase's work

**Main was red on `tests/law-registry.law.test.ts`.**
`server/src/services/spinRepairsCanFinish.law.test.ts` is on `main` with no row
in the registry, which is exactly what that test exists to refuse. Fixed here
rather than routed around, per fix-first: you cannot ship past a red main
anyway. The row is described from the law's own header, not guessed at.

**The alert-noise fix from the previous phase has not shipped, and the record
said otherwise.** `2026-09-01-the-last-unwatched-money.md` reported the backlog
cut to 244 -> 1 and 18 -> 2. That measured rows I had just resolved, not a
condition I had stopped: the dedupe key is passed from the ENGINE, which has
not restarted onto that code, so `FeeReconciler.bbj_unlinkable` is back to 102
open rows for a single subject. A correction is now written into that file. The
evidence is a clean natural experiment — `fn_money_check_health` raises from
inside the database and its 7 open alerts carry 7 distinct keys; every
engine-driven source carries none.

## What this phase did NOT do, and why

**No money moved to anyone.** The 1,728.00 chips those 39 events paid out
beyond what their fields funded went to players who were over-paid relative to
what they staked, not under-paid. Dan's 2026-08-28 ruling stands: no clawback
from players, the hosting club absorbs it. Nobody is owed anything from this
window, and the club's cost is already sunk and already 13 days old.

**The engine was not changed.** The register path already charges every entrant
and has since 2026-08-19. Re-fixing a fixed bug to make a phase look busier is
how a repo acquires two laws demanding opposite things.
