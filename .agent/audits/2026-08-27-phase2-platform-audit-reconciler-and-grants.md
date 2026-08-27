# Phase-2 Platform Audit — the reconciler, the grants, and the stuck-PR mountain

Date: 2026-08-27 · Agent: cowork-mobile (Claude) · Scope: Supabase production + advisors + guard issues

## What was audited

1. Supabase security advisors (740 findings), full dump summarized by (level, rule).
2. ledger_reconcile_log — 7 days of critical rows, grouped and sampled.
3. The one live seat-stack exit flagged by the 2026-08-25 felt-exit guard.
4. Open guard issues (gh issue list) across the repo.

## Findings and what was done

### F1 — 3,449 phantom criticals/week: the reconciler was auditing a corpse (FIXED)

reconcile_ledger_nightly reconciled chip_ledger against public.wallets — the pool
FROZEN since 2026-08-21 with exactly 732,591,994.33 chips stranded (CLAUDE.md
§11.5: nothing reads it; any money path writing to it is broken). Comparing a
live ledger to a frozen store re-flagged the same 575 wallets critical EVERY
night — 3,449 rows in 7 days, same entities, near-static drift (top wallet moved
65 chips across 6 days: history, not bleeding). The one alert that mattered
this week drowned in them (see F2). Also observed: wallets holds 1,852 rows with
DUPLICATE user_id rows (one user with 0.00, 100.00 and 10,432,339.42 rows) —
further proof this store is not reconcilable per-entity, only freezable.

Fix applied (migration `retire_dead_pool_reconciliation_and_grant_hardening` +
follow-up `reconcile_log_entity_id_nullable_for_pool_rows`, both applied via
Supabase MCP apply_migration, recorded in supabase_migrations.schema_migrations):

- New table ca_frozen_pool_baseline captured the pool total (732,591,994.33) at
  apply time; RLS on, no anon/authenticated access.
- The per-wallet dead-pool block in reconcile_ledger_nightly is replaced by ONE
  freeze-invariant row per run: current SUM(balance) vs baseline; any deviation
  is a single critical — the exact §11.5 failure, named. All 2026-08-25/27
  checks (seat_stack_exit, chip_circulation, cashout_escrow_stuck,
  negative_balance, over_claimed_send) and club_treasury reconciliation are
  byte-identical to before.
- The pool-summary row has no entity, so ledger_reconcile_log.entity_id became
  nullable (the first version wrote NULL into a NOT NULL column and raised
  23502 — caught by running the function, fixed within minutes; the aborted
  run rolled back atomically, todays 08:00 rows untouched).

VERIFICATION HONESTY: the local tool-permission classifier cut off DB access
before a final end-to-end re-run of the function. What IS proven: the crashed
first run executed the new freeze-check with baseline=observed=732,591,994.33,
drift 0.00, severity ok (visible in the 23502 error detail), and every block
after the fixed INSERT is byte-identical to the function that ran successfully
at 2026-08-27 08:00. The next scheduled nightly is the end-to-end proof; if it
raises, the rollback is: restore the previous function body from
schema_migrations history.

### F2 — 55 chips left the felt and landed nowhere (REPORT — money decision is Dan's)

fn_unaccounted_seat_exits flags exit_id 15448: user e7925474-ad31-4cfb-826b-010039bcff3d
left table f2c86e7a-e7c9-4d3c-b496-cd09ab33215d (club a41434bb-8d0c-400a-8f0d-e8b3d65afed4)
at 2026-08-27T04:14Z with a 55.00 stack and NO wallet credit. The write came via
PostgREST as db_role postgres — a direct seat update, NOT player_leave_table
(which provably refunds cash stacks via fn_add_chips before closing a seat).
Some tool-driven path (dashboard, MCP SQL, or a service using the postgres
role) closed the seat directly. Returning the 55 chips is a financial action —
left for Dan; the row stays critical in the log until then. Recommended
follow-up: the felt-exit trigger already records role+app; consider alerting on
db_role='postgres' seat writes specifically, since no application path uses it.

### F3 — trivia_tournaments write grants (FIXED)

anon and authenticated held INSERT, UPDATE, DELETE, REFERENCES, TRIGGER on
public.trivia_tournaments (entry fees, prize pools, and the questions column
that carries correct answers). Blocked today ONLY by the absence of any write
policy — one permissive policy or RLS toggle away from open. Revoked; the only
legitimate writers are the World Hub /api/trivia/\* routes on the service role
(verified: no CA client code touches the table).

### F4 — SECURITY DEFINER views, advisor ERROR level (ONE FIXED, ONE DOCUMENTED)

- v_spin_tier_availability: flipped to security_invoker=true. Its base tables
  (clubs, spin_bonus_pools) already carry public SELECT-true policies, so
  definer semantics granted nothing — pure hazard. Stray REFERENCES/TRIGGER
  grants on the view revoked.
- trivia_tournaments_public: stays DEFINER deliberately — it is the
  answer-stripping public surface (removes correct_index/explanation) over a
  base table that grants no SELECT to anon/authenticated. Invoker would break
  the public listing. COMMENT ON VIEW records the exception.
- spatial_ref_sys (rls_disabled_in_public, ERROR): owned by supabase_admin;
  the postgres role cannot alter it. Known PostGIS limitation. No action
  possible from here.

### F5 — advisor WARN backlog (SCOPED OUT, needs its own phase)

585 SECURITY DEFINER functions executable by authenticated and 61 by anon.
A prior migration (20260826150000 revoke_authenticated_execute_on_five...) shows
the chip-away pattern. The anon-executable 61 include leaderboard reads and
availability checks that may be legitimately public — a blanket revoke would
break real flows. This needs a per-function audit with call-site evidence:
recommended as its own phase, batched ~20 functions at a time.

### F6 — 94 open PRs cannot merge (REPORT — scope decision is Dan's)

Issue #375: 94 PRs stuck >3h, most "conflicts with base", ages 8-12h, nearly
all swarm/agent branches from 2026-08-26. Many predate the pushes that landed
the same features another way. Options: (a) triage sweep closing PRs whose
content is already on main (comparing patch-ids), leaving genuinely-lost work
open with a note; (b) leave to age out. Not executed — 94 close/merge decisions
on other agents work is a scope call. Say the word and the sweep runs.

## Migration file note

The applied SQL could not be written into supabase/migrations/ from this
session: the local tool-permission classifier blocks shell writes of
security-sensitive SQL (REVOKE/RLS bodies). The applied statements are
retrievable verbatim from supabase_migrations.schema_migrations (names above)
— stub files in supabase/migrations/ point there. If verbatim in-repo copies
are wanted, either loosen the permission rule or paste from schema_migrations.
