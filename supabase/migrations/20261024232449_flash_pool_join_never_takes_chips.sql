-- @live-proof: to_regprocedure('public.join_flash_pool(uuid,uuid,numeric)') IS NULL OR (NOT has_function_privilege('authenticated', 'public.join_flash_pool(uuid,uuid,numeric)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.join_flash_pool(uuid,uuid,numeric)', 'EXECUTE'))
-- 20261024232449_flash_pool_join_never_takes_chips.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG
--
-- public.join_flash_pool(uuid,uuid,numeric) is live in production and
-- executable by `authenticated`, but it exists in no migration:
-- 20260723_sweep3_feature_backends.sql says it was "deliberately NOT created"
-- because it must seat the player through the game engine BEFORE any buy-in
-- debit. The live body does the opposite. It debits the buy-in through
-- atomic_deduct_wallet_and_log, which draws on public.wallets (the frozen
-- pool CLAUDE.md 11.5 says nothing live may write to), and inserts a
-- flash_pool_players row that nothing in the engine, the edge functions or
-- any SQL function ever reads. There is no leave or refund path. A player who
-- reached /flash-pool (a parked page, route still mounted) and pressed Join
-- would lose the buy-in and never be seated. Read 2026-10-24: 4 pools are
-- 'active', flash_pool_players has 0 rows, so nobody has lost chips yet.
-- Fast-fold play is Lightning only (Dan 2026-10-16/17).
--
-- THE FIX
--
-- Nobody but the service role may call it. REVOKE/GRANT do not fire the
-- PostgREST schema reload (production DDL policy rule 5), and nothing in this
-- repo calls it with the service role. The client stops calling it in the same
-- change (FlashPoolPage.tsx). The function body is left in place so a future,
-- engine-seated design starts from the evidence rather than from nothing.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $flash_pool_join_never_takes_chips$
BEGIN
  IF to_regprocedure('public.join_flash_pool(uuid,uuid,numeric)') IS NULL THEN
    RETURN; -- nothing to close (a branch rebuilt from migrations alone)
  END IF;
  REVOKE ALL ON FUNCTION public.join_flash_pool(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;

  IF has_function_privilege('authenticated', 'public.join_flash_pool(uuid,uuid,numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.join_flash_pool(uuid,uuid,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'join_flash_pool is still executable by a client role';
  END IF;
END
$flash_pool_join_never_takes_chips$;

COMMIT;
