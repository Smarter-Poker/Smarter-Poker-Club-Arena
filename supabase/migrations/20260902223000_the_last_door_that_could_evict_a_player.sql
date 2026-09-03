-- ═══════════════════════════════════════════════════════════════════════════════
--  THE LAST DOOR THAT COULD STILL EVICT A SEATED PLAYER (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Phase 1 moved game lifecycle authority into the database so that no client,
-- no screen and no direct API call could close a table out from under the
-- people sitting at it. `trg_tables_managed_lifecycle_guard` refuses the close
-- while any seat still has `left_at IS NULL`, and the equivalent legacy
-- tournament path, `atomic_cancel_tournament`, had its EXECUTE revoked from
-- `authenticated` in the same pass so only service-role recovery can reach it.
--
-- Its twin was missed. `fn_admin_close_table` is SECURITY DEFINER and was
-- still granted to `authenticated`, and it does not trip the guard because it
-- empties the table FIRST:
--
--     credit every seated stack back to the wallet
--     UPDATE table_seats SET left_at = now() WHERE left_at IS NULL   <-- here
--     UPDATE tables SET status = 'closed'
--
-- By the time the lifecycle trigger looks, no seat has a null `left_at`, so the
-- close is allowed. The frontend stopped calling it in Phase 1, but the whole
-- point of that phase was that the rule must not depend on the frontend: any
-- club admin could still PostgREST straight at it and cash out a live table
-- mid-hand. Under section 10.5 that lands on horses exactly as it lands on
-- humans, which is to say it is the same bug twice.
--
-- Revoked here, matching what Phase 1 did to `atomic_cancel_tournament`.
-- The function itself is left in place: service_role keeps it for genuine
-- recovery, where a human has decided a stuck table must be emptied and is
-- accountable for that decision. The supported operator path is
-- `fn_execute_managed_game_command`, which refuses while anyone is seated and
-- says so.
--
-- SAFE UNDER LIVE TRAFFIC: GRANT/REVOKE is not in `pgrst_ddl_watch`'s event
-- list, so this does not fire a PostgREST schema reload (CLAUDE.md section 2).

BEGIN;

REVOKE EXECUTE ON FUNCTION public.fn_admin_close_table(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_admin_close_table(uuid) FROM anon;

COMMIT;
