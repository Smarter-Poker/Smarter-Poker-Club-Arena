-- 20260911081910_a_seat_exit_guard_without_its_consumer_refuses_nothing
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-11 08:19:10 UTC.
--
-- WHAT HAPPENED (2026-09-11, all figures read from production)
--
-- No tournament with a seated winner has finished since about 05:05 UTC.
-- Every finish was refused with
--
--   [Tournament.atomic_finish_refused] TerminalSettlementRefusedError:
--     tournament seat-exit authority left 1 live seat(s) unconsumed  (P0404)
--
-- 532 of those in the 75 minutes before 08:15, with 0 'COMPLETE - winner'
-- lines. The engine replays each refusal five times with sleeps, and every
-- replay takes the settlement lane's global lock (G and B exclusive), so
-- the refusals also stalled hand settlement across the platform: hand
-- commits were waiting on advisory locks in about half of all samples, and
-- the elimination queue grew past 600 with a 20-minute oldest wait.
--
-- HOW
--
-- 20260911050554_final_deal_receipts_survive_real_terminal_settlement
-- (applied 05:05, from agent/codex-live-realtime/stage-b-clean-v3 commit
-- ee3e351c6d, not on main) put fn_complete_tournament_terminal behind the
-- seat-exit authority wrapper from 20260909014545, which closes it with
--
--   fn_ca_close_tournament_seat_exit_authority(v_token, <result ok>)
--
-- so a successful finish requires every authorization row to have been
-- CONSUMED. Rows are consumed by exactly one thing: the trigger
-- zy_tournament_live_seat_exit_requires_authority on public.table_seats.
-- That trigger does not exist in production. 20260909014545 (the full
-- cutover that installs it) was never applied, and 20260910051125 left the
-- trigger out on purpose: installing it without that cutover would refuse
-- every elimination, unregistration and zero-stack vacate, none of which
-- open an authority. Only fn_ca_open_tournament_seat_exit_authority and this
-- function touch tournament_seat_exit_authorizations. So a finish that
-- succeeded always left its winner's authorization row behind, and the
-- close always raised. 20260910051125 hit the same trap for
-- fn_move_tournament_player and fixed that one call site by passing false.
--
-- fn_ca_settle_bounty_rebuy_generation_v1 (20260911052648, same branch) has
-- the same shape: it requires consumption whenever its claim succeeds.
--
-- WHAT THIS DOES
--
-- Fixes the guard where it lives instead of at each call site. The close
-- still counts and deletes the rows and clears the session settings, byte
-- for byte. It raises only when the consumer exists and is enabled for
-- ordinary sessions (tgenabled 'O' or 'A'). Without the consumer, requiring
-- consumption cannot witness anything; it can only refuse the exit it was
-- opened for. When the full cutover installs the trigger, the requirement
-- comes back on its own, with no further migration and no call site
-- edited.
--
-- No wrapper is replaced, so fn_complete_tournament_terminal and
-- fn_ca_settle_bounty_rebuy_generation_v1 keep the md5s their owner's
-- preflights pin (96a61ea5..., and the bounty function's). Only this
-- function's source changes. Its signature, owner, SECURITY DEFINER,
-- search_path and ACL are checked unchanged below.
--
-- No data is written. No table is locked beyond the catalog row of this one
-- function.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE seat_exit_close_before ON COMMIT DROP AS
SELECT to_jsonb(p) - 'prosrc' AS metadata
  FROM pg_proc p
 WHERE p.oid = 'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)'::regprocedure;

DO $preflight$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc
   WHERE oid = 'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)'::regprocedure;
  -- Already applied: the body this migration installs. Re-applying is a no-op.
  IF md5(v_src) = '319441969e49923b3ee8d65f8f0b1e82' THEN
    RETURN;
  END IF;
  IF md5(v_src) <> '0811b7a7795234ed8bc84c606d9a5a62' THEN
    RAISE EXCEPTION
      'fn_ca_close_tournament_seat_exit_authority source differs from the measured production body (md5 %); re-measure',
      md5(v_src);
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  p_token uuid,
  p_require_consumed boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $close_seat_exit_authority$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  DELETE FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  PERFORM set_config('app.tournament_seat_exit_token','',true);
  PERFORM set_config('app.tournament_seat_exit_operation','',true);
  -- 2026-09-11 (20260911081910): only zy_tournament_live_seat_exit_requires_authority
  -- on table_seats consumes a row. Without it nothing can, and requiring
  -- consumption only refuses the exit it was opened for: every finish
  -- from 05:05 UTC. The requirement returns when the consumer exists.
  IF COALESCE(p_require_consumed,true) AND v_remaining<>0
     AND EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid='public.table_seats'::regclass
          AND t.tgname='zy_tournament_live_seat_exit_requires_authority'
          AND NOT t.tgisinternal
          AND t.tgenabled IN ('O','A')) THEN
    RAISE EXCEPTION
      'tournament seat-exit authority left % live seat(s) unconsumed',v_remaining
      USING ERRCODE='P0404';
  END IF;
  RETURN v_remaining;
END;
$close_seat_exit_authority$;

-- Owner-only, exactly as 20260909014545 left it: only the SECURITY DEFINER
-- wrappers that open an authority ever close one. (A no-op on production,
-- whose ACL is already {postgres=X/postgres}; GRANT/REVOKE cause no schema
-- cache reload.)
REVOKE ALL ON FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

DO $postflight$
DECLARE
  v_src text;
  v_meta jsonb;
BEGIN
  SELECT prosrc, to_jsonb(p) - 'prosrc' INTO v_src, v_meta
    FROM pg_proc p
   WHERE p.oid = 'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)'::regprocedure;
  IF md5(v_src) <> '319441969e49923b3ee8d65f8f0b1e82' THEN
    RAISE EXCEPTION 'the close did not install the reviewed body (md5 %)', md5(v_src);
  END IF;
  IF v_meta IS DISTINCT FROM (SELECT metadata FROM seat_exit_close_before) THEN
    RAISE EXCEPTION 'the close changed more than its source: % vs %',
      v_meta, (SELECT metadata FROM seat_exit_close_before);
  END IF;
  IF position('zy_tournament_live_seat_exit_requires_authority' IN v_src) = 0
     OR position('DELETE FROM public.tournament_seat_exit_authorizations' IN v_src) = 0
     OR position($s$set_config('app.tournament_seat_exit_token','',true)$s$ IN v_src) = 0
     OR position($s$set_config('app.tournament_seat_exit_operation','',true)$s$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the close lost part of its body';
  END IF;
  IF has_function_privilege('anon','public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'the close became callable outside its owner';
  END IF;
END;
$postflight$;

COMMIT;
