# Phase 7 verification: what an adversarial pass found before phase 8

2026-09-08. Club Arena. A deliberate hunt for gaps, stubs and regressions in
everything phase 7 built, before starting phase 8. The money model held. Three
real defects came out of it, one of them a scheduled false alarm on the
platform's own financial monitoring.

## The model itself is sound, and this is how that was established

Round 2 and the agent claim were run against production inside transactions
that were rolled back by their own `RAISE`. One union, one hour-long period,
83 (club, agent) pairs:

```
owed in window before          4,730.87
owed in window after                  0
settlement rows written              83   covering 12,971 commission rows
paid                           4,730.87   = exactly what was owed
second identical run              0.00    0 payees, no new settlement rows
run 1 / run 2                  3,240 ms / 57 ms
rollup vs view, worst drift        0.00
shortfalls                            0
```

Conservation is exact, the model is idempotent (the `ON CONFLICT (club_id,
user_id, period_start, period_end) DO NOTHING` means a repeated close cannot
pay twice), and the rollup recompute round 2 performs leaves the rollup in
exact agreement with the period-aware view. Twelve thousand nine hundred and
seventy-one row updates became eighty-three inserts.

Also confirmed: the two functions `20260908032512` dropped
(`fn_agent_commission_open_intervals`, `fn_agent_commission_owed_rows`) are
gone and have no caller left anywhere - no function, view, policy, trigger, or
line of TypeScript. Every index the phase relies on exists, including
`agent_commissions_open_idx (club_id, user_id, created_at) INCLUDE (amount, id)
WHERE settled_at IS NULL`, which is what makes "oldest open row first" free for
the claim. The rollup's three statement triggers are present and enabled.

## Defect 1: the currency meter was going to cry wolf on the first close

`fn_ca_currency_meter` compares, per agent, the outstanding commission it
computes itself against `agent_commission_unsettled_rollup`, and raises a
**critical** `ledger_imbalance` incident on any disagreement. It computed its
own side as `FROM public.agent_commissions WHERE settled_at IS NULL` - the
question this platform asked before phase 7. The rollup it compares against is
built from `agent_commissions_unsettled`, which asks the new question.

Nobody was careless. The meter was written at 03:03 UTC; the model changed at
02:56 UTC. Seven minutes, two agents, neither aware of the other.

The two were therefore guaranteed to diverge by exactly the amount round 2 had
paid. Measured, in a rolled-back transaction, after one hour-long close:

```
meter (settled_at IS NULL only)   1,012,983.49
rollup (period aware)             1,008,252.62
overstatement                         4,730.87   = exactly what was paid
agents reported as drifted                  83   worst single 870.11
```

A critical incident on every run, carrying the text "the rollup is kept by
statement triggers and the rows are append-only; seeing it means one of those
was bypassed" - which would have sent whoever read it hunting a bypassed
trigger that does not exist. It had not fired yet only because
`agent_commission_settlements` still holds zero rows: round 2 has not run since
the model changed. This landed before the close that would have produced it.

Fixed in `20260908042554` by one `FROM` clause. The migration is a transform
rather than a pasted function body: the meter is ~130 lines covering four
currencies and retyping the other three risks altering a financial alert by
accident, so it asserts the old clause is present exactly once, replaces only
that clause, re-executes, and asserts the VIP and rakeback sections survived.
Verified after applying, same scenario:

```
meter   1,008,323.53
rollup  1,008,323.53
drifted 0        worst 0.00
```

## Defect 2: phase 7 built the honest reader and wired nothing to it

`v_agent_commissions` exists, is `security_invoker = true`, denies `anon`, and
returns exactly what a screen needs: `settled_at` as `COALESCE(own stamp, the
settlement's paid_at)` plus `settled_via` of `'claim'` or `'round2'`. It was
created by the model change and **no reader was ever pointed at it**.

Meanwhile three client surfaces still read the bare table and decided claimed
versus unclaimed from `settled_at` alone. `AgentCommissionDashboard` labelled
each row `r.settled_at ? 'claimed' : 'unclaimed'`, above a comment stating
"settled_at is what says whether it has been claimed" - true when it was
written, false since 02:56. The effect on an agent's screen is that money
round 2 has already paid them reads as unclaimed, and the CSV export's "Claimed
At" column is blank for it.

`AgentCommissionDashboard.tsx` and both queries in `AgentDashboardPage.tsx` now
read `v_agent_commissions` and carry `settled_via`, so a row paid by the close
says `settled` rather than `unclaimed`. The realtime subscription stays on the
table, because you cannot subscribe to a view.

`tests/the-agents-books-tell-the-truth.law.test.ts` pinned
`.from('agent_commissions')` on that dashboard. That pin was written when the
screen was reading `commission_records`, a table that never held a row. The pin
moved to `v_agent_commissions` in the same commit and the `commission_records`
prohibition stayed, because the law's intent - read the real ledger - is
exactly what this change serves. Weakening it was not an option; 24 tests pass
on the moved pin.

## Defect 3: two admin buttons that deleted the ledger and called it payment

`AdminDashboardPage` had "Mark Paid" and "Mark All As Paid". Both ran a
`DELETE` against `agent_commissions`. They moved no chips to any agent, and
they destroyed the rows every total, the nightly reconciliation and the
currency meter are computed from. `pay_all` deleted every agent's rows for the
club since the period start, not only the one on screen.

Neither ever worked, which is the only reason this is not an incident: RLS on
`agent_commissions` has SELECT-only policies for `authenticated` and reserves
writes to `service_role`, so the DELETE matched zero rows and returned success.
The button reported payment, changed nothing, and the row was still there after
the refresh. `20260908035653` revoked the table-level write grants as well,
which would have turned that silent lie into a visible 403.

Both actions and both buttons are removed. An agent is paid by exactly two
paths - `fn_agent_claim_commission` and `fn_settle_round2_club_to_agents` -
each of which debits a real treasury and records the period it covered. Wiring
an admin-initiated payment to either one decides what somebody is owed, so that
is Dan's call and not a repair; the code says so where the buttons used to be.

## Also fixed: the branch could not merge

`CI - Build & Type Safety` failed on the phase 7 branch at
`Supabase Invariants - New Migrations Were Applied`, reporting four unapplied
objects (`agent_commissions_unsettled`, `v_agent_commissions`,
`fn_agent_commission_paid_by_period`). All of them exist in production. The
gate reads the nightly base snapshot, which predates 02:56 UTC, so it could not
see anything phase 7 created. CLAUDE.md 11.0 forbids hand-editing the shared
manifest; the sanctioned path is a fragment under
`scripts/ci/schema-manifest.d/`, which the gates read as a union with the base.
Thirteen objects were verified present in the live schema before the fragment
was written, and the nightly refresh goes red on any fragment that names
something production does not have.

## Defect 4: the filename version and the recorded version were not the same number

`apply_migration` stamps the migration with **its own** timestamp, taken when
it runs. `scripts/reserve-migration-version.sh` hands out a version for the
filename earlier, when the file is created. The two are minutes apart, so the
repo and `supabase_migrations.schema_migrations` end up naming the same
migration differently:

```
file 20260908035532   database 20260908035653   the_commission_ledger_grants_no_writes_to_a_browser_role
file 20260908040611   database 20260908040743   the_rollup_rebuild_survives_safeupdate_...
file 20260908042306   database 20260908042554   the_currency_meter_asks_the_same_question_...
```

Supabase keys `schema_migrations` on the version, so a rebuild from this repo
would find those filename versions unrecorded and **run those files again**.
All three of mine are idempotent, so re-running them is harmless; that is luck,
not design. The three files are renamed here to the versions the database
actually recorded, so the repo and the ledger agree.

**This is not only mine.** Of the 43 migration files dated 2026-09-08 on
`main`, **12 carry a version that appears nowhere in `schema_migrations`** -
ten of them other agents', written the same way in the same window. Nothing
catches it: `check-applied-migrations-are-recorded` asks whether the database
holds migrations the repo lacks, and `check-migrations-applied` asks whether
the objects a migration declares exist. Neither asks whether the version on the
file is the version that ran. The other ten are left alone rather than renamed
underneath the agents who own them, and are reported instead.

## What was checked and found clean

- Every database function referencing `agent_commissions` (31 of them) was
  classified as period-aware or not. `fn_ca_currency_meter` was the only one
  asking the old question. `generate_period_settlements` sums by date range
  with no settled filter, which is "earned in period" and correct as it stands;
  `fn_ca_journal_append_only` guards immutability rather than deciding what is
  owed.
- Both views over the ledger are period-aware, `security_invoker`, and closed
  to `anon`.
- Round 2 refuses a period ending within five minutes, skips a club whose
  treasury cannot cover the debt rather than overdrawing it, and reports the
  shortfall.
