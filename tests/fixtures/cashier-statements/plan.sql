-- Cashier statements (Phase 5): plan proof, run after regression.sql by
-- scripts/dev/test-cashier-statements.sh, which parses these plans.
-- auto_explain prints every nested plan as a NOTICE. The planner is left
-- alone (no enable_* overrides) after ANALYZE: chip_transactions holds the
-- 20,000-row club C by now, so a Seq Scan on it would be a real choice.
-- Each scenario is framed by a 'MARK <name>' statement.
--   shape  every source branch is a Limit over its index scan (only Result /
--          Sort / Incremental Sort / joins in between) and chip_transactions
--          is never read by a Seq Scan: scope all (first page and a cursor
--          page), self and downline.
--   P3     a cursor page bounds both ledgers' index scans by the cursor
--          instant (created_at <= cursor.at).
--   P4     the escrow terminal lookup is an index range ending at p_to + 1 day.
--   P1     the idempotency anti-join uses the partial unique index
--          ux_chip_transactions_idempotency_key.
--   restore  the restore mirror probe is a SubPlan evaluated only for
--          refunds to a player_wallet, on the player wallet (club_id,
--          to_user_id, created_at) index of chip_transactions.
\o /dev/null
ANALYZE public.chip_transactions, public.chip_ledger, public.profiles, public.club_members;
SET TimeZone = 'UTC';
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_nested_statements = on;
SET auto_explain.log_level = 'notice';
SET ROLE authenticated;
SELECT public.as_user(1);
-- The first page of 30 ends inside the 2026-09-05 15:00 tie on a movement,
-- so the cursor instant is 2026-09-05 15:00:00+00.
CREATE TEMP TABLE plan_cursor AS
SELECT public.fn_cashier_statement_page(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL,30) -> 'next_cursor' AS c;
SELECT 'MARK all-first';
SELECT public.fn_cashier_statement_page(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL,5);
SELECT 'MARK all-cursor';
SELECT public.fn_cashier_statement_page(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,(SELECT c FROM plan_cursor),5);
SELECT public.as_user(20);
SELECT 'MARK self';
SELECT public.fn_cashier_statement_page(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL,5);
SELECT public.as_user(10);
SELECT 'MARK downline';
SELECT public.fn_cashier_statement_page(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL,5);
SELECT 'MARK end';
