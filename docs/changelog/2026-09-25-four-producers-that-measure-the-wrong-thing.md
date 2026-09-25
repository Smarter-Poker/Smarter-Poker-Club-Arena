# Four producers that measure the wrong thing, and one of them stopped retention

2026-09-25. Migration `20260925143224_four_producers_that_measure_the_wrong_thing`.

The drift board had 31 rows open when I started on it. Five of them came from
four producers, and in every case what needed changing was the producer, not
the row. One of the four was a live outage that had been running for hours and
reported itself only as a cron failure count.

## 1. Hand-history retention had stopped, and only a counter said so

`sp_prune_hand_history_10m` had failed 12 times in two hours with zero
successes (incident `54809ab1`, `fn_ca_cron_failure_watch`). Read from
`cron.job_run_details`:

```
ERROR:  recorded_cash_earning_source_is_immutable
CONTEXT:  PL/pgSQL function fn_accounting_cash_source_immutable() line 16
  SQL statement "DELETE FROM public.rake_attributions WHERE hand_id=ANY(v_doomed)"
  PL/pgSQL function sp_prune_hand_history(integer) line 109
```

Two correct components disagreeing, which means one of them is asking for the
wrong thing:

- `accounting_cash_source_immutable` refuses to move a `rake_attributions` row
  once `accounting_cash_accrual_batches` holds a batch for its rake record.
  That attribution **is** the recorded earning source - the basis under every
  rakeback figure and every agent commission. It is right to refuse.
- the pruner deleted those attributions on its way to deleting the hand.

**It never had to.** There is no foreign key from `rake_attributions.hand_id`
to `hand_history.id` - the only foreign keys on that table point at `agents`
and `profiles` - so nothing referential required the delete. It was a storage
job tidying up an accounting record.

And it was worse than unnecessary. `rake_attributions` also carries
`trg_ca_club_rake_daily_user_del`, so every deleted attribution **decrements
the per-club per-user daily rake rollup**, which is the rakeback basis cache. A
retention pass that had run to completion would have quietly reduced recorded
club rake for every horse in every pruned hand. Horses are players (CLAUDE.md
10.5) and that is their money.

Dan's retention ruling is explicitly a **storage** decision about hand
_history_ - eight days since 2026-09-17, and 10.5 names it the one sanctioned
asymmetry in the whole law for exactly that reason. It says nothing about the
money ledger, and the money ledger is not pruned. So the fix is one line
removed.

Proved first in a rolled-back transaction (11.5), one call, one `DO` block
ending in `RAISE EXCEPTION`:

```
PROBE OK (rolled back): retention=8 days, hands=5, attributions on them=16
of which accounted=16; without the rake_attributions DELETE the prune
completed: idx=18 commits=5 history=5
```

All 16 attributions on the five oldest doomed hands were already accounted,
which is why every single run raised. No DDL was probed (DDL policy rules 3
and 7).

**Proof it is fixed, from the job itself:** `failed@14:23`, migration applied
14:32, `succeeded@14:33`.

Pinned by
`tests/a-retention-pass-never-deletes-a-recorded-earning-source.law.test.ts`.
The delete reads as obvious tidying - the hand is going, so its rows should go
with it - and nothing in the pruner said why one of those four tables is
different. A reader reconstructing the cleanup from the other three would put
it back.

## 2. A critical alarm that asked for a banned repair job

Incident `b310c260`, `fn_ca_guard_integrity_check`, CRITICAL, 35 occurrences:
"3 zero-drift guard(s) are MISSING or disabled - a protection was dropped".

The three were not protections. They were compensation jobs that law 10.12
required to stop running, each unscheduled by a migration that says so:

| job                          | retired by                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `ca-auto-reconcile-tick`     | `20260924025037_the_incident_tick_that_repairs_nothing_stops_running`            |
| `ca-promo-accrual-retry-10m` | `20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running` |
| `ca-payout-sweep-hourly`     | `20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running` |

`tests/a-retired-compensation-job-is-never-scheduled-again.law.test.ts` forbids
all three from ever being scheduled again. **So a CRITICAL alarm stood over the
board demanding the one action a law forbids, and the cheapest way to silence it
was to commit that violation.** That is not a cosmetic false positive; it is a
trap pointed at the next agent who wants a clean board.

`ca_guard_inventory` already had the right shape: the check reads `WHERE
active`, and `ca-bbj-repair-unbanked-15m` was deactivated the same way on
2026-09-20 with a note naming its retiring migration. These three get identical
treatment, rows kept rather than deleted so what was once demanded stays
readable, and the migration asserts that none of the three is scheduled
afterwards.

## 3. A warning that is true six days out of every seven

Incidents `7a7a08d6` (`fn_union_credit_risk_check`) and `c8fa487e`
(`fn_union_governance_check`), 87 occurrences each - and **one** cause, because
governance delegates to credit risk. Both reported `union_eco_not_recorded`:

```sql
AND NOT EXISTS (SELECT 1 FROM union_eco_ledger l
                 WHERE l.union_id = un.id
                   AND l.period_start >= fn_union_week_start())
```

`fn_union_week_start()` is the start of the week **in progress**. The ECO ledger
is written when a week **closes**. The invariant therefore asked for a row that
cannot exist yet, and was unsatisfiable from the moment each week began. It
first fired at 2026-09-21 07:52 - fifty-two minutes after the week rolled over
at 07:00 - and on every conservation sweep since. Midway Union is the only ECO
union and both of its closed weeks are on file (09-07 closed 09-14 07:05,
09-14 closed 09-17 16:57). Nothing was missing.

The invariant worth having is the one it was reaching for: once a week has
closed, its ECO must be on file. The fence moves back one week, and the detail
sentence moves with it, because a predicate about the closed week under a
message about the current one is the next reader's wasted hour. A week that
closes without ECO now fires at the next sweep instead of drowning in six days
of noise.

## 4. A helper is not a check

Incident `a6323605`, `fn_ca_orphaned_checks_watch`: "1 integrity check
function(s) exist that nothing ever runs." The function was
`fn_ca_integrity_json_numeric(p_value jsonb, p_key text)` - a scalar helper
that pulls a number out of a jsonb payload. It finds nothing and reports
nothing, so every remedy the alert offered (schedule it, add it to the sweep,
exempt it) was wrong for it.

`fn_ca_orphaned_checks` already drew this distinction under the heading
**A DOOR IS NOT A CHECK**, excluding anything whose arguments name an actor, an
op id, a case id or a request id. `p_value` joins that list for the same reason
one step further: a function **handed** the data to inspect is a helper, while
a check goes and finds its own.

## How the five were closed

Every fix is re-measured inside the same transaction that made it, and the
incidents are closed with `closure_basis = 'verified_remeasured'` - which the
column comment defines as "a detector that reads the whole standing state ran
again and did not report it". The migration aborts if any of them still reports:

- `fn_ca_guard_integrity_check()` - 0 findings
- `fn_union_credit_risk_check()` and `fn_union_governance_check()` - 0
  `union_eco_not_recorded`
- `fn_ca_orphaned_checks()` - 0 orphans
- `sp_prune_hand_history(500)` - returns without refusal

## What this is not

No cron, sweep, healer, backfill, re-drive or catch-up is created, and none is
revived (10.12). No money moves. The only DML is three rows of inventory
metadata, five incident resolutions, and one call to the platform's own
retention job, whose schedule **is** the product - 10.12's first exception.

Every function body is changed by asserted substitution rather than retyped:
the anchor must appear exactly once in the live definition before anything is
replaced, so a function that is not the one this was derived against aborts the
whole transaction instead of being silently overwritten.

## Two more closed on the same day, on a re-measurement rather than a fix of mine

`28c8e143` (`fn_ca_kill_switch_trip`) and `abcde69a` (the same event relayed
from `financial_alerts`) both recorded the kill switch crossing its 1000
threshold on 2026-09-21 06:40: `fn_ca_ledger_replay` found one account
disagreeing with the journal by -2,624.78. That was the Spin seed return
writing `spin_reserve -> spin_reserve` with no destination entity, because
`fn_ca_declare_ledger` `set_config`'d all three GUCs unconditionally and
overwrote a declaration `fn_spin_settle_game` had already made.

The root fix is not mine - it is migration
`20260921005621_spin_seed_return_journal_leg_and_nondestructive_declaration`,
which #4985 brought into the repo an hour before this - but nobody had gone back
and asked whether it worked. Re-run on 2026-09-25 15:03Z,
`fn_ca_ledger_replay` reports **disagree 0, worst 0.00 across 275 accounts**.
Both incidents already carried `verdict: UNCONFIRMED` and `persists: false`,
which is the kill switch saying its own reading did not hold. Closed as
`verified_remeasured`, inside a transaction that re-runs the replay first and
aborts if it still disagrees. No chip was moved to close them.

Seven incidents closed in total, all on `verified_remeasured`.

## The analysis is on the rows that stay open

Thirteen open rows now carry a `root_cause`, written while they stay open -
`fn_ca_resolution_needs_a_cause` only fires on the move to `resolved`, so
recording what is known does not require pretending it is finished. The point is
that the next agent reads the finding instead of re-deriving it, and that
nothing was closed to make a count smaller.

The one worth reading is `0f8f8cc6`, which had been reporting -30,000 of
tournament chip drift for five days and is **not missing chips**. Sunday Funday
Six-Card Closer `c7f21a83` started 2026-09-21 04:00 at 30,000 a stack. Four
players hold 24,418 + 28,714 + 30,912 + 35,956 = 120,000, exactly the seated
stack total, so those four conserve perfectly. The fifth, `5330edb2`, a horse,
**registered at 2026-09-22 14:08 - thirty-four hours after the event started** -
and has 0 chips and has never had a `table_seats` row at all.
`fn_tournament_chip_conservation_check` computes expected as
`registered x starting_chips`, so it counts a registration that was never dealt
in and calls the difference chip drift.

Two defects in one row, and neither is the one the alert named:

1. the producer gives _a registration nobody honoured_ the name of _a chip
   leak_, and that wrong name has stood for five days;
2. a late registration was accepted 34 hours past the start and then never
   seated or chipped. Its buy-in is inside the 1,245.00 prize / 25.00 fee
   escrow for five entries, and under 10.5 that horse paid what everybody else
   paid.

It is left open on purpose. The two candidate outcomes are seat-and-chip - wrong
five days and many blind levels into a running event - or withdraw-and-refund
through the platform's own idempotent path, which changes a running event's
prize pool. Both are live-path decisions the frozen engine owns, and I am not
going to guess between them in a compensating write (10.12).

## What I did not close, and why

The board is live and moved while I worked on it - 38 rows open when I stopped, 9 of them critical. Nothing else was closed:

- **Engine-blocked** (the engine has been frozen on `8825af51` for over 158
  hours and a sibling agent owns the cutover): `28f5660c` 20 RUNNING events with
  no `engine_tournament_leases` row at all, `546d9098` 13 events whose every
  table holds exactly one open seat so no player anywhere has an opponent,
  `7ab0dcbe` 20 events holding players with no chips and no chair - 265 of them
  in one event, freezing 111.00, 558.00, 354.00 and 347.00 of prize escrow -
  plus the blind-clock pair, the stranded event, and the rakeback settler
  watermark (`8bf57e5e`, `b68deac6`), last advanced 2026-09-22 10:37.
  These clear when the engine is replaced and not before. Closing them would
  be filing a real obligation as done.
- **Owner's decision, stated by the producer itself**: `c3815241`,
  `settlement_suspense` standing at 4,170,904.48 chips, whose own text says
  "No chip may be moved to make this number smaller: the destination is the
  owner's decision" with `moved_since_baseline` 0.00.
- **Business, not a platform defect**: `f087ad75` and `d21f5350`, Club JAQK
  owing 33,222.29 and SHARK CLUB 11,244.03 on Midway statements 7.02 days past
  due. `fn_union_age_invoices` is doing exactly its job.
- **Not mine, and newly truthful**: 25 `fn_ca_escrow_ttl_sweep` warnings that
  appeared at 14:30, the first sweep after
  `20260925130241_the_escrow_ttl_sweep_reads_the_real_status_domain` taught it
  the real status domain. A producer that has just started telling the truth
  belongs to whoever shipped the correction.
