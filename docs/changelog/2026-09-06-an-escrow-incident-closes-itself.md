# 2026-09-06 - An escrow incident closes itself when the leg lands (H2)

Chip-accounting programme, phase 2 of 9, item H2 of the handoff backlog:
thirty open `fn_ca_escrow_vs_counter_check` incidents, all Midway Union
(`fade0000-...-0001`). The handoff's first question was whether this was the
same stale read as H1 (`fn_ca_escrow_on_close`). It was not - this detector
reads `fn_ca_tournament_escrow`, computed from the journal - but re-reading
the thirty was still the whole answer. Thirty to zero, no chips moved.

## Three migrations, all applied to production and at file parity

**`20260906145058_an_escrow_incident_closes_itself_when_the_leg_lands`**
(applied 14:52 UTC)

- New `fn_ca_escrow_incident_closes_when_the_leg_lands(uuid)`: re-reads one
  open escrow incident against the live escrow; if the event balances
  0.00/0.00/0.00 it resolves the incident, naming the leg that landed (fee
  via `tournament_rake_settlements`, prize via `tournament_payouts`), its
  source, and how many minutes after close. Failures go to
  `ca_incident_file_failures`, not only the Postgres log (Part 7.3).
- `fn_ca_escrow_vs_counter_check` now runs that re-read over everything it
  holds open, first thing, every run, and its summary carries
  `open_incidents_reread` / `open_incidents_self_closed`. Otherwise byte-
  identical to `20260903014000`.
- Seven settled 2026-09-02 events closed by hand, each `UPDATE` asserting
  the live residual it closes (aborts if the board moved).
- Shape B closed through the new code path itself: 23 re-read, 22 closed.
- Self-proof: a rolled-back probe files an escrow incident for an event that
  still owes and asserts the helper returns false and leaves it open.

**`20260906145706_an_unregistration_fee_reversal_is_attribution_not_escrow_mon`**
(applied 14:57 UTC). The one Shape B incident the re-read could not close:
Midweek Bounty, "prize 0.98, fee -0.98. Held 600.00, paid 600.00". One
player unregistered on 09-01; `fn_unregister_from_tournament` refunded the
whole 10.00 and wrote a -1.00 `rake_records` row. The shadow counted the
reversal, read fee_in 59 and prize_in 361, and apportioned the refund
6.02/3.00/0.98 against the entry's real 6/3/1. Chip standard 5.3 already
excludes a cancel's reversal as attribution; an unregistration's is the
identical case and is now excluded the same way. Measured blast radius:
exactly one completed non-spin event in 7 days carries such a reversal, this
one. After: 360-354-6, 180-177-3, 60-59-1, all 0.00; the helper closed it.

**`20260906145936_the_mirror_catches_up_with_the_incidents_resolved_before_it_`**
(applied 15:00 UTC). `20260906113923` made resolution propagate both ways
by trigger from 11:39 UTC but did not look back: 75 `financial_alerts`
mirrors were still open for incidents resolved before the trigger existed
(oldest 09-02 20:35; 17 `fn_ca_supply_snapshot`, 12 `fn_ca_guard_defs_watch`,
11 `fn_bbj_reconcile`, ...). Closed with the same note the trigger writes,
carrying each incident's own resolution text. 75 before, 75 closed, 0 after.

## What the thirty actually were

**Shape B, 23: a leg that landed after the detector looked.** Every one
balances now.

- Fee leg: `tournament_rake_settlements.source = 'sweep'` 10-50 minutes
  after close on 09-03 (81 rows) and 09-04 (25). The engine's own
  `engine_finish` had missed them. Zero `sweep` rows on 09-05 and 09-06;
  fixed upstream, not here.
- Prize leg: `tournament_payouts.source = 'reconcile'` between 12:41 and
  13:08 UTC today, after "WINNER prize credit failed after 3 retries"
  (`financial_alerts` 12:47, 12:52:41, 12:52:42) - a window of deadlocks and
  failed credits around the 12:55 restart. 13 events; the 14:00 hour is
  clean (0 of 11 multi-place SNGs needed the reconciler).
- Distribution, 15,107 completed non-spin events over 3 days: fee and prize
  legs land BEFORE `ended_at` at p50 and p95 (-0.25s, -0.10s). 63 events
  (0.4%) had a leg land more than 60s late; worst 3,029s.

**Shape A, 7: settled, recorded, Dan-ruled 2026-09-02 events.**

- Union Grand Championship (-920), Union Mystery Bounty (-700), Evening
  Mystery Bounty (-350), Turbo Tuesday Opener (-32): the guarantee overlay
  paid twice, 01:19 by the back-payment migration and 03:54 by the
  reconciler that could not see it. Verified per player - same user,
  position, amount, both times; nine players, 460.00 in the Grand
  Championship. Fixed by `20260902041907` and `20260902042044`; Dan ruled no
  clawback; the house absorbed 1,001.00 across the four. Closed with
  `20260902042044` as `correction_ref`.
- $100 Freeroll 12:00 AM (-41.71) and 6:00 PM (-100.00): the 10.9
  settlement `20260902162954`. The 41.71 is the overpay its header says was
  absorbed; the 100.00 is a freeroll guarantee paid to the players owed it
  with no bank -> prize_liability leg, because that leg did not exist on
  09-02.
- Sunday Deep Stack Satellite $5 (-92.00): one seat honoured as 200.00
  chips against 108.00 collected; the union paid the seat it promised. The
  satellite `pool_transfer` leg is `20260903020000`.
- None recurs: 8,905 asserted events ended since 09-04, every one balanced.

## Board

|                                 | 14:29 UTC | 15:00 UTC |
| ------------------------------- | --------- | --------- |
| open drift incidents            | 109       | 79        |
| critical                        | 42        | 42        |
| `fn_ca_escrow_vs_counter_check` | 30        | 0         |
| unresolved `financial_alerts`   | 264       | 157       |
| pages since the 13:35 gate      | 0         | 0         |

The 42 criticals are untouched by this work; they are H3-H8.

## What this did not do

It did not fix why the engine's finish path missed 13 prize legs today
between 12:41 and 13:08 (the reconciler caught every one, at lag 0 for most,
1,657s for one). That window is worth its own read: `Tournament.escrow_short`
and `fn_settle_tournament_obligation` refusals for the 20 Chip Spin PLO4
(55.20 held against 60.00 owed) are in the same window and still open.
