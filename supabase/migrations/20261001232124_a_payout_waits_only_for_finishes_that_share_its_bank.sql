-- 20261001232124_a_payout_waits_only_for_finishes_that_share_its_bank.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A PAYOUT WAITS ONLY FOR FINISHES THAT SHARE ITS BANK
-- ===========================================================================
--
-- Measured 2026-10-01 21:30-23:20Z (Postgres log, 55P03 by statement context):
-- 440 tournament payouts (fn_complete_tournament_terminal) were refused at
--   SELECT pg_advisory_xact_lock(hashtextextended('ca:tournament-finish-lane:v1', 0))
-- in fn_ca_lock_settlement_lane_for_finish, after waiting the full 8 s lock
-- timeout. F is ONE platform-wide mutex: every Spin, Sit & Go and MTT payout
-- on the platform waits for every other one, including payouts of unrelated
-- clubs whose own rows are stuck behind a hot bank row (the mean finish holds
-- F for ~3.1 s, the longest 44 s). At 23:10Z 274 decided Spins and Sit & Gos
-- were unpaid across two bank scopes (Midway Union 142, Deep Stack Society 127)
-- while the platform completed 10-17 a minute.
--
-- F was made exclusive among finishes (20260917113717) so that two finishes
-- could not take the SAME shared money rows (club wallet, union bank, club
-- treasury, the players' wallets in those clubs) in opposite orders. Two
-- finishes whose events belong to different bank scopes share none of those
-- rows: a club's members, wallets and treasury belong to that club, and a
-- union-affiliated club's events all reach that union's bank. So F is now
-- taken per BANK SCOPE:
--
--   ordinary finish : G shared, F shared, F(scope) exclusive, T(id) exclusive
--   satellite finish / sweep member (unchanged): G shared, F exclusive, T...
--
-- scope = the host club's union when it has one, else the host club. Within
-- one scope payouts stay one at a time, exactly as before. A satellite finish
-- or a sweep still holds F exclusively and so still excludes every ordinary
-- finish on the platform, as before. The lock order is unchanged (G, F, then
-- the narrower keys, then T), re-entry inside a held lane takes nothing new,
-- and no amount, row or receipt changes: this only lets two different banks'
-- payouts run side by side.
--
-- Law: tests/a-payout-waits-only-for-finishes-that-share-its-bank.law.test.ts

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_lock_settlement_lane_for_finish(uuid)'::regprocedure
       AND md5(p.prosrc) = '58962520e072fe177eaa29809db909f3'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
       AND NOT p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_lock_settlement_lane_for_finish is not the definition read 2026-10-01';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_held text := COALESCE(current_setting('ca.finish_lane_tournament', true), '');
  v_held_scope text := COALESCE(current_setting('ca.finish_lane_scope', true), '');
  -- Unknown until the row proves it is a plain tournament: the whole lane.
  v_satellite boolean := true;
  v_scope text;
BEGIN
  -- Re-entry: this transaction already holds a finish lane. Every key below
  -- is already held by this backend, so nothing waits; a second tournament
  -- is refused, a transaction never holds two tournaments' lanes. (Inside a
  -- satellite finish or a sweep, F is held exclusively by this backend, so F
  -- shared is granted at once and no scope key is named.)
  IF v_held <> '' THEN
    IF p_tournament_id IS NOT NULL AND v_held <> p_tournament_id::text THEN
      RAISE EXCEPTION 'finish lane is held for tournament %, refused for %',
        v_held, p_tournament_id USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-finish-lane:v1', 0));
    IF v_held_scope <> '' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('ca:tournament-finish-lane:v1:scope:' || v_held_scope, 0));
    END IF;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_held, 0));
    RETURN;
  END IF;

  -- Resolve the tournament before any lock. variant, tournament_type and the
  -- satellite target are fixed for the life of the row, so reading them
  -- unlocked gives the answer reading them under the lane would. The bank
  -- scope is the host club's union, else the host club; the finish itself
  -- refuses (40001) if the club changes union before it holds the banks.
  IF p_tournament_id IS NOT NULL THEN
    SELECT (lower(COALESCE(t.variant::text, '')) = 'satellite'
            OR upper(COALESCE(t.tournament_type::text, '')) = 'SATELLITE'
            OR t.satellite_target_id IS NOT NULL
            OR t.satellite_target IS NOT NULL),
           COALESCE(c.union_id::text, t.club_id::text, '')
      INTO v_satellite, v_scope
      FROM public.tournaments t
      LEFT JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      v_satellite := true;
    END IF;
  END IF;

  -- A satellite finish writes the target tournament's rows, and an unknown
  -- tournament cannot be scoped: the whole lane, as it always was.
  IF v_satellite OR COALESCE(v_scope, '') = '' THEN
    PERFORM public.fn_ca_lock_settlement_lane_global();
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, the rare global authorities (G
  -- exclusive) and nothing else.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  -- F SHARED: satellite finishes and sweeps hold F exclusively and still
  -- exclude every ordinary finish; ordinary finishes no longer exclude
  -- each other platform-wide.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-finish-lane:v1', 0));
  -- F(scope) EXCLUSIVE: one finish at a time per bank scope, so finishes
  -- that share a club wallet, union bank, club treasury or the players'
  -- wallets in those clubs keep the order they had under F exclusive.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-finish-lane:v1:scope:' || v_scope, 0));
  -- T(id) EXCLUSIVE: this tournament's hands (T shared) and rolling
  -- authorities (T exclusive) wait for the finish, and the proof-of-
  -- authority guards read it as this backend's authority over the rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));
  -- The rest of this transaction re-enters this lane through
  -- fn_ca_lock_settlement_lane_global; transaction-local, gone at commit.
  PERFORM set_config('ca.finish_lane_scope', v_scope, true);
  PERFORM set_config('ca.finish_lane_tournament', p_tournament_id::text, true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) TO service_role;

DO $post$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.fn_ca_lock_settlement_lane_for_finish(uuid)'::regprocedure
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
     AND p.proconfig::text = '{"search_path=public, pg_temp"}'
     AND NOT p.prosecdef AND p.provolatile = 'v';
  IF v_src IS NULL
     OR strpos(v_src, 'hashtextextended(''ca:tournament-finish-lane:v1:scope:'' || v_scope, 0)') = 0
     OR v_src ~ 'pg_advisory_xact_lock\(\s*hashtextextended\(''ca:tournament-finish-lane:v1'', 0\)\)' THEN
    RAISE EXCEPTION 'POSTIMAGE: the ordinary finish does not take F shared and F(scope) exclusive';
  END IF;
  IF (SELECT public.fn_ca_settlement_lane_doctrine() ->> 'ok') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'POSTIMAGE: the settlement lane doctrine refuses: %', public.fn_ca_settlement_lane_doctrine();
  END IF;
END
$post$;

COMMIT;
