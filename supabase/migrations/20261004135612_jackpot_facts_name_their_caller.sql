-- 20261004135612_jackpot_facts_name_their_caller.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- JACKPOT FACTS NAME THEIR CALLER
--
-- What happened. At 04:15 UTC on 2026-10-04 fn_check_ungated_money_rpcs (job
-- 150) filed a critical: "1 money-mutating SECURITY DEFINER function(s) are
-- callable by authenticated with no authorization gate:
-- fn_bbj_pool_facts(p_pool_id uuid)", and the drift incident 0fc14cd0 it paged
-- holds the launch gate red.
--
-- fn_bbj_pool_facts (20261003215434_jackpot_facts_read_closed_hours_once) is the
-- jackpot page's read. Its only write is the derived hourly reporting cache
-- bbj_pool_contribution_hours, filled from bbj_contributions; it moves no chips.
-- It does gate its caller - a signed-in player or the service - but it says so
-- through auth.role(), and the detector recognises a gate only by the
-- authorization helpers and auth.uid (fn_ungated_money_rpcs). The detector's
-- table pattern 'bbj_' matches the cache's name.
--
-- The fix is at the function: the same rule, stated by identity. A caller is
-- admitted when it is a signed-in user (auth.uid() is set; every
-- 'authenticated' JWT carries a subject) or the service (auth.role() is
-- 'service_role', or no JWT at all, as for pg_cron and direct SQL). anon is
-- refused exactly as before. The detector is not weakened.
--
-- @live-proof: position('auth.uid() IS NULL' in pg_get_functiondef('public.fn_bbj_pool_facts(uuid)'::regprocedure)) > 0
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.fn_ungated_money_rpcs() WHERE fn = 'fn_bbj_pool_facts')
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 s:='public.fn_bbj_pool_facts(uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'99a822c978dc293b526abfa49c937393' THEN RAISE EXCEPTION 'facts preimage %',md5(d); END IF;
 a:=$a$  IF COALESCE(auth.role(), 'service_role') NOT IN ('authenticated', 'service_role') THEN$a$;
 r:=$r$  -- 20261004135612: the same rule, stated by identity - a signed-in user
  -- (auth.uid) or the service (service_role, or no JWT: pg_cron, direct SQL).
  IF auth.uid() IS NULL AND COALESCE(auth.role(), 'service_role') <> 'service_role' THEN$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'facts anchor count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'facts postimage differs from the substituted text'; END IF;
 IF EXISTS (SELECT 1 FROM public.fn_ungated_money_rpcs() WHERE fn = 'fn_bbj_pool_facts') THEN
  RAISE EXCEPTION 'fn_bbj_pool_facts still reads as ungated';
 END IF;
END
$mig$;

COMMIT;
