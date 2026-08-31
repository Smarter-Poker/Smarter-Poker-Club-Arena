-- 2026-08-31 — MTT Phase 3 follow-up: the deal states its own grants.
--
-- Applied to production as version 20260831145003 and recorded there; this file
-- is the repo half of that, added on the completeness sweep after the fact.
--
-- WHY IT EXISTS SEPARATELY. check-definer-authorization blocked the Phase 3
-- push on fn_final_table_deal: SECURITY DEFINER, it writes, and it never asks
-- who is calling - it settles a chop for whichever tournament id it is handed.
-- Production already had it locked to postgres + service_role, so nothing was
-- exploitable. But the migration FILE did not say so, and CREATE OR REPLACE
-- only preserves an ACL that already exists. The day somebody DROPs and
-- re-creates this function, the grant silently becomes EXECUTE to PUBLIC -
-- which is the identical trap documented two migrations earlier for
-- fn_credit_and_log, where the DROP was unavoidable and the ACL had to be
-- restored by hand.
--
-- A money-moving definer function should not depend on an ACL set somewhere
-- else years ago. It states its own.
--
-- The same statements are also repeated at the foot of
-- 20260831133146_the_deal_writes_its_record_once.sql, so that file is
-- self-contained if it is ever replayed alone. Both are idempotent.
--
-- TIER: 2 (grants only, no behaviour change). ROLLBACK: none wanted - undoing
-- this would hand EXECUTE on a money path back to PUBLIC.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_final_table_deal(uuid) TO service_role;

COMMIT;
