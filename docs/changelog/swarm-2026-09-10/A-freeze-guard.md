# A - zz_freeze_guard / fn_refuse_while_frozen

Project kuklfnapbkmacvwxktbh, measured 2026-09-10 03:05-03:20 UTC (2XL, not frozen, engine_maintenance_break empty, 416 live cash seats). All probes rolled back (every DO ended in PROBE_ROLLED_BACK). No DDL run.

## 1. What is there

Triggers using fn_refuse_while_frozen (all `BEFORE ... FOR EACH ROW`, tgenabled=O):

| table | events | TG_ARGV |
|---|---|---|
| chip_ledger | INSERT/DELETE/UPDATE | (none) |
| chip_transactions | INSERT/DELETE/UPDATE | (none) |
| club_members | INSERT/DELETE/UPDATE | chip_balance |
| clubs | UPDATE | chip_pool, total_rake |
| table_seats | INSERT/DELETE/UPDATE | stack, left_at, sit_out_at |
| wallet_transactions | INSERT/DELETE/UPDATE | (none) |
| wallets | INSERT/DELETE/UPDATE | balance |

fn_refuse_new_entries_while_frozen: table_seats `zz_freeze_entry_guard` (INSERT OR UPDATE OF left_at, user_id), tournament_players (INSERT), tournaments `zz_freeze_launch_guard` (UPDATE OF status, WHEN new RUNNING).

Order of checks in fn_refuse_while_frozen today (verbatim def in the .sql rollback section):
1. UPDATE with TG_ARGV: `to_jsonb(NEW)->col IS DISTINCT FROM to_jsonb(OLD)->col` per listed column; none changed -> RETURN NEW
2. club_members INSERT with chip_balance 0 -> RETURN NEW
3. fn_freeze_bypass_active() (`app.freeze_bypass = 'on'`) -> RETURN
4. chip_ledger AND pg_trigger_depth() > 1 -> RETURN
5. request.jwt.claims role = service_role -> RETURN (errors swallowed)
6. fn_platform_frozen() -> RAISE 55006, else RETURN

1-5 are the exemptions; all of them must keep winning over "frozen" (they return the row even during the break). Only writes that survive all five reach step 6.

## 2. Measurements (before)

Component costs, warm, in one session (2000-iteration loops, us per iteration):

| piece | us |
|---|---|
| 2 x to_jsonb(table_seats row, 27 cols) + `->` compare | 26 |
| 2 x to_jsonb(club_members row, 47 cols) | 50 |
| jwt BEGIN/EXCEPTION block incl. current_setting | 1.3 (no claims) |
| fn_freeze_bypass_active() | 5 |
| EXISTS on engine_maintenance_break (0 rows) | 9 |
| **fn_platform_frozen()** (plan cached) | **293-310** |
| of which fn_active_maintenance_release_boundary() | 252-270 |
| of which the engine_maintenance_thaws query alone | 229 |
| fn_platform_frozen() as a fresh statement (SQL-language body re-planned) | 950-1050; first call in session 5,400-6,800 |

zz_freeze_guard trigger time from `EXPLAIN (ANALYZE) UPDATE` inside rolled-back DO blocks, ms:

| probe | cold (1st in session) | runs 2-5 | steady (run 6+) |
|---|---|---|---|
| table_seats stack = stack + 1, postgres session, no JWT | 3.9 - 4.4 | 0.87 - 1.01 | 0.34 - 0.40 |
| same, `request.jwt.claims` role = authenticated | 0.94 | 0.36 - 0.45 | 0.36 |
| same, role = **service_role** (what the engine sends) | 0.10 | 0.058 - 0.065 | 0.06 |
| club_members chip_balance = chip_balance (column unchanged -> step 1 exits) | 4.4 | 0.072 - 0.084 | 0.07 |

Whole UPDATE on that seat row: 18.7 ms cold / 2.8-3.0 ms warm, 16 triggers, zz_freeze_guard is ~1/3 warm.

Reading of the numbers:
- The exemption chain (steps 1-5) costs 30-70 us. The "expensive work first" premise is not what the DB shows: to_jsonb is 13-25 us per call.
- The expensive thing is step 6, fn_platform_frozen(): 0.3 ms warm, ~1 ms during plpgsql's first five custom-plan executions per session (the planner re-parses the SQL-language body trying to inline it), 4-7 ms on a fresh connection (pg_cron opens one per run). 77% of its warm cost is fn_active_maintenance_release_boundary(): a seq scan of engine_maintenance_thaws (167 rows, +24/day, no retention seen) on which the planner evaluates `shifted ?& <14 keys>` FIRST on every row, then contract_version = 3, then release_target_at > clock_timestamp(). Zero rows have contract_version = 3, so 167 jsonb ops per call for nothing.
- The engine (server/src/services/supabase/client.ts uses SUPABASE_SERVICE_ROLE_KEY; pg_stat_statements: 10,980 guarded-write top-level calls by service_role vs 2 by postgres) exits at step 5 and never pays step 6. The 0.9 ms figure is what a postgres/pg_cron or authenticated-user session pays, and only for its first five statements; afterwards 0.35 ms.

## 3. The requested reorder ("frozen check first") - verdict: do not apply

Equivalence (as asked): in the original, when fn_platform_frozen() is false every path ends in RETURN (steps 1-5 return, step 6's RAISE is skipped, the final RETURN COALESCE(NEW, OLD) fires; RETURN NEW and RETURN COALESCE(NEW, OLD) are the same row for INSERT/UPDATE and OLD for DELETE). So "IF NOT fn_platform_frozen() THEN RETURN COALESCE(NEW, OLD)" as the first statement, followed by the original body verbatim, returns the same row for every not-frozen write and runs the original code for every frozen write. That argument holds ONLY IF fn_platform_frozen() cannot raise. It can: fn_active_maintenance_release_boundary() raises 42501 when the session has no JWT role and session_user is not postgres/supabase_admin/service_role/superuser (e.g. supabase_auth_admin, the GoTrue signup trigger path, or cli_login_postgres). Today exempt writes in such a session never call it; with the reorder they would, and a previously-allowed write would fail. Making that airtight needs a BEGIN/EXCEPTION wrapper around the early check, which measured +110-125 us per call (293 -> 407-420 us) because it puts a subtransaction around the SQL-function call.

Cost effect of the reorder, measured against the table above:
- service_role (engine) writes: 0.06 ms -> ~0.35 ms warm (+0.3 ms per row, x35 triggers' worth of rows per settlement) - a regression on the hottest path in the database.
- unchanged-column UPDATEs (table_seats status/is_away/time_bank/..., club_members non-balance): 0.07 ms -> ~0.35 ms.
- authenticated/postgres non-exempt writes: saves the 26-50 us of to_jsonb, i.e. 0.35 -> ~0.32 ms.
Net: negative. The current order is already cheap-first; step 6 is the cost and it is paid only by the callers that need it.

The body as requested is kept in the .sql under "NOT PROPOSED" for the record.

## 4. What actually cuts the cost (proposed)

**A1 (in the .sql): fence the thaws query in fn_active_maintenance_release_boundary()** so the two cheap scalar quals run before the jsonb quals:

    FROM (SELECT t.release_target_at, t.shifted FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3 AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
    WHERE COALESCE((t.shifted->>'complete')::boolean, false) AND t.shifted ?& c_required_steps

Measured as a plain SELECT (EXPLAIN ANALYZE, then 2000-iteration loop): 229 us -> 32 us per call; plan shows Subquery Scan with the jsonb filter above a Seq Scan filtered on contract_version/clock. Expected effect: fn_platform_frozen() ~300 -> ~100 us; zz_freeze_guard steady state for non-exempt callers ~0.35 -> ~0.15 ms; fn_entry_purchases_frozen() (same call) and the zz_freeze_entry_guard get the same cut. No caller path changes.

Why it is behavior-identical: same table, same four quals ANDed, same max(); OFFSET 0 only stops the planner from flattening the subquery, so the jsonb quals are evaluated only on rows that already passed contract_version = 3 AND release_target_at > clock_timestamp(). clock_timestamp() is evaluated per row in both versions. The only theoretical difference is WHICH rows the `::boolean` cast is tried on (original: rows passing `?&`, cv and time in planner order; fenced: rows passing cv and time, then `?&` first in the outer filter per the plan) - a difference only for a future contract_version = 3 row whose shifted.complete is not a boolean literal, which would already be a broken thaw receipt. Everything else in the function (caller checks, SECURITY DEFINER, search_path, owner/grants via CREATE OR REPLACE) is verbatim.

Alternative A1' if you would rather not touch a SECURITY DEFINER function: `CREATE INDEX CONCURRENTLY engine_maintenance_thaws_v3_release_idx ON public.engine_maintenance_thaws (release_target_at) WHERE contract_version = 3;` The planner takes the empty partial index (release_target_at > clock_timestamp() cannot be an index condition because clock_timestamp() is volatile, but the predicate match alone makes it the cheapest path). It degrades again as v3 rows accumulate (24/day once the contract moves to v3); the fence does not. Untested on production (would be DDL).

**A2 (optional, analysis only): fn_platform_frozen and fn_entry_purchases_frozen as LANGUAGE plpgsql** with the identical expression (`RETURN EXISTS (...) OR COALESCE(...)`). Removes the per-plan inline attempt that costs ~0.6 ms on each of a session's first five guarded statements and part of the 4-7 ms first call. Warm steady state unchanged. Worth it for pg_cron (fresh connection per run) only; skip unless cron write latency is being chased.

Not proposed: caching the frozen flag per transaction, making fn_platform_frozen STABLE (it must see clock_timestamp() and the break row written moments ago), or any change to the exemption order.

## 5. fn_refuse_new_entries_while_frozen (zz_freeze_entry_guard)

Same shape, no reorder needed: it classifies non-entries first (cheap column compares, one tables lookup for table_seats), takes the shared advisory try-lock, then bypass, then fn_entry_purchases_frozen(). It has NO service_role exemption, so the engine pays fn_entry_purchases_frozen() (= the same 0.3 ms boundary call) on every cash seat INSERT and every left_at/user_id change. A1 cuts that too. Do not add a service_role exemption there: the entry guard is meant to bind the engine (rule 13.1: the guard must be absent from engine memory, present in Postgres). Leave the function as is.

## 6. Pre-existing bug found on the way (not this workstream, needs an owner)

fn_active_maintenance_release_boundary() raises 42501 `MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED` for any session without a JWT role whose session_user is not postgres/supabase_admin/service_role/superuser. GoTrue's signup trigger `on_auth_user_created_wallet` -> handle_new_user_v2_create_wallet -> INSERT public.wallets runs as supabase_auth_admin (not superuser), reaches step 6, and now fails: public.signup_errors id 9318 at 2026-09-10 03:06:46 UTC, trigger handle_new_user_v2_create_wallet, sqlstate 42501. The function is not in supabase/migrations (applied out of band). Every signup since it landed loses its PLAYER wallet row (swallowed into signup_errors). A1 does not change this either way.

## 7. Risks and rollback

- A1 risk: a plan-shape change inside a SECURITY DEFINER function on the freeze path. Verified by EXPLAIN ANALYZE as a plain SELECT; result set provably the same conjunction. One DDL statement = one ~28 s PostgREST reload.
- Rollback: the original definition is in the .sql ROLLBACK section; re-running it restores byte-identical behaviour.
- The requested fn_refuse_while_frozen reorder is not proposed; if applied anyway, use the wrapped form in the .sql (NOT PROPOSED section) so exempt writes cannot inherit the 42501.
