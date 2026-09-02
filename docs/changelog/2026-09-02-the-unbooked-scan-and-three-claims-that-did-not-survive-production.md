# The unbooked scan, and three claims that did not survive production

2026-09-02. Spins audit, continuing from the previous session's handoff.

## What I changed

One index.

```sql
create index idx_tournaments_spin_unbooked_scan
  on public.tournaments (started_at)
  where variant = 'spin' and status in ('RUNNING', 'COMPLETED');
```

`idx_tournaments_variant` indexes `variant` alone, which is not selective on a
table where 41k of 71k rows are spins: it returned every spin ever played and
the filter then discarded 37,986 of them. Two hot paths were paying for that on
every call - the `ub` CTE in `fn_spin_metrics`, which runs on every `/metrics`
scrape, and the scan in `fn_spin_sweep_unbooked`, which runs every fifteen
minutes as `service_role` under an eight-second `statement_timeout`.

Measured on production, before and after (the after includes a one-off
`VACUUM (ANALYZE)` on `spin_reserve_ledger`, whose stale visibility map was
costing 3,131 heap fetches per call):

| path                                   | before  | after      |
| -------------------------------------- | ------- | ---------- |
| `fn_spin_metrics` `ub` CTE (24h)       | 877 ms  | **252 ms** |
| sweep scan (14d, what the cron passes) | 1244 ms | 983 ms     |
| heap fetches, ledger anti-join         | 16,340  | 59         |
| planner cost, 24h                      | 14,061  | 1,501      |

The metrics win is the real one. The sweep's own window genuinely has to look at
33,770 rows, so its gain is the heap fetches rather than the walk - but that is
1.2s of an 8s budget that has already failed once, handed back.

Migration `20260901130329` sized `p_limit=25` around "a settle costs ~60ms and
the scan ahead of it 1.2s". This is that 1.2s.

## What I did not change, and why

Three claims inherited from the previous session's handoff. I checked each
against production before acting, and none of them survived. Writing them down
so the next agent does not spend the afternoon re-finding the same nothing.

**1. There is no three-hour sweep cliff.** `fn_spin_sweep_unbooked` defaults to
`p_lookback_mins 180`, and I was ready to call that a permanent-loss cliff.
It is not: `/api/cron/spin-sweep.js` passes the value explicitly,
`LOOKBACK_MINS = 14 * 24 * 60`, so the default never applies in production.
Changing it would have been a no-op that read like a fix.

**2. `booking_gaps` is not blind.** Issue #2454 reports that
`v_spin_draw_booking_gaps` guards on `d.drawn is not null` and so cannot see a
spin with no reserve row at all. True, and correct: that view asks whether a
_booked_ spin paid more than it drew. "Was it booked at all" is a different
question and `fn_spin_metrics` already answers it separately, as
`unbooked_spins`. Two questions, two numbers, both published.

The 112 completed Spins at Deep Stack Society on 08-31 that booked sixteen
hours late are real - I confirmed the ledger rows were written 09-01 15:30-16:30
against tournaments that ran 08-31 23:03-23:34. They are also already fixed:
the sweep was dying on 57014 statement timeouts until `20260901130329` capped
the pass, and that backlog is what drained at 15:30.

**3. `tournament_payouts.paid_at` does not lie.** The handoff reported `paid_at`
set on payments that never occurred. Joining payouts to `category = 'prize'`
credits alone, that looks like 3,135 rows and ~23,700 chips across the bounty
variants. It is a join artefact. Bounties credit under their own category, and
satellites award a seat rather than chips. Counting all three award mechanisms:

| variant            | payout rows | unaccounted                                           |
| ------------------ | ----------- | ----------------------------------------------------- |
| spin               | 36,272      | 0                                                     |
| sng                | 29,082      | 0                                                     |
| bounty             | 6,834       | 0                                                     |
| freezeout          | 5,595       | 0                                                     |
| mystery_bounty     | 3,581       | 0                                                     |
| progressive_bounty | 3,582       | 22 rows worth 0.00                                    |
| satellite          | 60          | 23 rows, all 23 registered into `satellite_target_id` |

Every satellite winner was registered into the target event. `paid_at` is
truthful everywhere.

**Also not a defect:** spins sitting in `COMPLETING`. There were two, at 27 and
28 minutes. Both had paid their prizes correctly (10.00 on a 5.00 x2, 30.00 on
a 10.00 x3) and both had booked their ledger rows. `fn_tournament_metrics`
already gauges this with `p_completing_minutes`, and none survive past a day.
No reaper needed.

## Verified live while I was in there

Zero spins unbooked at any age. Every `jackpot_draw` row in the last eight
hours booked in-line, worst lag 0 minutes. `booking_gaps` 0, `unbooked_spins` 0,
`attribution_gaps` 0, `unpaid_settlements` 0.

The one number that is bad is the one PR #2612 addresses: reveal p50 is
14,768 ms and 139 of the last 140 spins were past the one-second lead-in.

## Horses

Nothing here reads `is_horse`. A spin is scanned, swept, counted and reported
identically whoever sat in it (CLAUDE.md 10.5).
