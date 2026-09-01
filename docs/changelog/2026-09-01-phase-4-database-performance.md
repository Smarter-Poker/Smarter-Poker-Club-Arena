# Phase 4 - database performance

2026-09-01. Four migrations applied and verified in production, one destructive
change deliberately NOT applied and left as a decision.

## The headline numbers were stale, so they were remeasured

The handoff carried "11 auth_rls_initplan warnings, 47 multiple_permissive_policies,
20 unindexed foreign keys, 1,461 never-scanned indexes / 1,352 MB". Measured fresh
against the live catalog on 2026-09-01:

| item                                            | handoff          | measured           |
| ----------------------------------------------- | ---------------- | ------------------ |
| policies with an unhoisted `auth.*` call        | 11               | **15**             |
| multiple-permissive groups (table x role x cmd) | 47 rows          | **12 groups**      |
| unindexed foreign keys                          | 20               | **25**             |
| never-scanned droppable indexes                 | 1,461 / 1,352 MB | **1,146 / 414 MB** |

None of the four was right. Advisor output moves; inherited counts are not evidence.

## Shipped

### 1. `20260901121709_rls_initplan_hoist_auth_uid`

15 policies across 13 tables called `auth.uid()` bare, so it was re-evaluated once
per row instead of hoisted into an InitPlan. Wrapped as `(SELECT auth.uid())`.
Semantics are identical - `auth.uid()` reads a session GUC and cannot vary by row.

Not cosmetic on two of them:

- `tournament_payouts` - 4,189 rows, **1,441,841** lifetime index scans, and its
  SELECT policy called `auth.uid()` **three times per row**.
- `vip_points_carry` - 791 rows, 91,662 lifetime index scans.

`ALTER POLICY` was used rather than DROP + CREATE, so the role list and the command
cannot be changed by a transcription mistake and there is no window in which the
table is unprotected.

Verified: the guard below reports 0.

### 2. `20260901121741_fk_index_only_where_evidence_supports_it`

The advisor reports 25 unindexed foreign keys. **One** index was created.

An unindexed FK costs something only when the parent row is deleted or its key
updated. Measured lifetime `n_tup_del` on the parents: `profiles` 180, `clubs` 8,
and **zero** for `poker_venues`, `promotions`, `unions`, `theme_preset_catalog`,
`avatar_shop_catalog`, `leak_drill_sessions`,
`leaderboard_reward_program_versions`. Every child table of those in the unindexed
set holds <= 832 rows and most hold 0.

The exception, and the only one indexed: `client_shell_telemetry.user_id` ->
`auth.users`, ON DELETE SET NULL, 17,587 rows. Account deletion is a real recurring
event and each one currently seq-scans the whole telemetry table.

Adding the other 24 would have meant answering a lint about unused indexes by
creating 24 more indexes that will never be scanned, in a database that already
carries 1,146 of them.

### 3. `20260901122027_guard_redundant_dead_indexes_report_only`

`fn_redundant_dead_indexes()` - reports indexes that are BOTH never scanned AND
structurally redundant. Reports only; it drops nothing. See the proposal below.

### 4. `20260901122257_guard_rls_initplan_regression`

`fn_rls_policies_with_unhoisted_auth()` - must return zero rows.

This exists because **seven** migrations had already "fixed" the initplan lint
before today, the most recent of them yesterday:

```
20260520000002_security_advisor_rls_and_initplan_fixes
20260622143935_mlb_hr_bets_rls_initplan_optimization
20260721184857_db_hygiene_fk_indexes_rls_initplan_agents_policy_20260721
20260808222940_perf_wrap_auth_calls_in_rls_initplan
20260824193111_rls_initplan_and_duplicate_indexes
20260827000323_rake_rls_initplan_optimisation
20260830213957_rls_initplan_auth_uid_wrapped        <- yesterday
```

And 15 policies were still bare this morning. The sweep is not what fails; nothing
stops the next policy being written with a bare `auth.uid()`. Same shape as the
Phase 3 definer finding, and the same answer: a guard, not an eighth sweep.

Both guard functions are `SECURITY INVOKER` and were explicitly revoked from
PUBLIC/anon/authenticated, per the Phase 3 law that Postgres grants EXECUTE to
PUBLIC on every new function unless the REVOKE is written.

## Two things measured and deliberately NOT changed

### `multiple_permissive_policies` - the advisor's premise is wrong here

The lint says each permissive policy "must be executed for every relevant query".
On this database that is not what happens. `EXPLAIN` on `club_members` (4 permissive
SELECT policies for `authenticated`) shows Postgres has already merged them into a
single OR'd filter:

```
Filter: (((InitPlan 2).col1 AND fn_union_oversees_club(...))
      OR ((fn_club_cashier_scope(...) = 'downline') AND fn_club_cashier_can_transact(...))
      OR (user_id = (InitPlan 6).col1)
      OR is_club_admin(club_id, (InitPlan 7).col1)
      OR (ANY (club_id = (hashed SubPlan 11).col1)))
```

Merging them by hand would produce the same plan, while fusing four separately
named security rules into one anonymous blob on the table that holds
`chip_balance`. Recommendation: dismiss this lint rather than act on it.

### `club_members` roster reads - real but smaller than it first looked

While measuring the above I recorded 13.6 s to read `club_members`. **That number
is wrong as a description of production** and is recorded here so nobody repeats
it: it came from an unfiltered `SELECT` with no WHERE clause, which no client
issues. The real shapes:

| query                                         | time                     |
| --------------------------------------------- | ------------------------ |
| `WHERE user_id = <self>` (the common path)    | **18 ms**                |
| `WHERE club_id = <largest club, 593 members>` | **345 ms**               |
| no WHERE clause (not a real client query)     | 4.1 s warm / 13.6 s cold |

345 ms on a roster is real and grows linearly with club size. The cause is visible
in the plan: `fn_club_cashier_scope` and `is_club_admin` are SECURITY DEFINER
functions called **per row**, while the club-owner arm of the same policy already
does it correctly as a hashed SubPlan evaluated once. Making the other arms
set-based the same way is worth roughly an order of magnitude - but it rewrites the
security boundary on the money table, so it is a Tier-3 change and it is Dan's
call, not a rider on a performance PR.

## Not applied: dropping 130 redundant dead indexes

See `docs/proposals/2026-09-01-drop-redundant-dead-indexes.md`. The analysis is
finished and the criterion held on every entry, but a destructive sweep across 130
production indexes is a decision, not a chore.
