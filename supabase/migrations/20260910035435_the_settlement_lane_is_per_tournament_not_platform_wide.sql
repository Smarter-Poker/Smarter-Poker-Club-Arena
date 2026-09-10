-- 20260910035245_the_settlement_lane_is_per_tournament_not_platform_wide
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-10 03:52:45 UTC.
--
-- WHAT HAPPENED (2026-09-10, 03:13-03:35 UTC / 22:13-22:35 CDT)
--
-- CRITICAL: /api/cron/table-socket-probe failed 3x in a row, outcome
-- handshake_timeout (HTTP 503). Then pick_table failed: "no table this
-- account may open has dealt a hand in the last 10 minutes". The fleet had
-- stopped dealing. There was ONE engine instance the whole time (1-e1790665,
-- the container started at the 02:55 break); its log from 03:05 onward is
-- thousands of
--
--     [GameServer.table_lease_lost] Lost the deal-lease on table <id> to
--         another engine instance                                  (3,065)
--     [Tournament.lease_proof_expired] lease generation expired before it
--         was renewed                                              (1,004)
--     [tournament-lease] claim_tournament_lease rpc_error (supabase_timeout)
--
-- i.e. the engine's own database calls were timing out, so it could not renew
-- the leases it held, and it read its own expired leases as another instance.
-- Docker's healthcheck only flipped at 03:34:18; autoheal restarted the
-- container at 03:34:30 and the new instance (1-ecb10c3d) recovered the fleet.
--
-- WHY THE DATABASE CALLS TIMED OUT
--
-- postgres_logs for 03:00-03:15 carry ~2,200 lock-wait lines (baseline ~15 per
-- five minutes), every one of them on the same advisory lock:
--
--     still waiting for ShareLock on advisory lock [5,4265093629,1253463894,1]
--
-- That key is hashtextextended('ca:tournament-terminal-settlement:v1',0), the
-- "one transaction lane" introduced on 2026-09-09 by
-- tournament_cash_settlement_has_one_atomic_authority and widened through the
-- day. Its contract, per its own comment: "Every rolling and terminal money
-- authority enters one transaction lane". 28 tournament money functions take
-- it EXCLUSIVE. And the accepted-hand authority - fn_ca_commit_hand_settlement,
-- every hand on every table, cash included - takes it SHARED.
--
-- That pairing is a lock convoy. Postgres grants lock requests in arrival
-- order: the moment one exclusive request queues, every later shared request
-- queues behind it, and the exclusive request itself cannot proceed until all
-- in-flight shared holders finish. pg_stat_statements over the preceding hour:
--
--     fn_ca_commit_hand_settlement     13,907 calls   avg 239 ms   max 5.9 s
--     fn_seat_horse_in_seat_first_game  2,846 calls   avg 357 ms   max 5.9 s
--
-- The second is Spin bot seating; it goes through
-- fn_ca_lock_tournament_seat_acquisition, which takes the lane exclusively.
-- ~0.8 exclusive acquisitions per second, each held ~360 ms and each draining
-- ~4 hands/s of shared holders in front of it, is a lane that is effectively
-- always contended. A cash hand at a bot table in Club A waited for a Spin
-- seat purchase in Club B; the seat purchase waited for every hand in flight.
-- Under the evening ramp the waits crossed the engine's statement and RPC
-- timeouts and the lease renewals - which share the same connection budget -
-- starved with them. Before 2026-09-09 there was no lane at all: hand
-- settlement and tournament authorities ran fully concurrently for months.
--
-- WHAT THIS CHANGES. NO AUTHORITY LOSES ITS EXCLUSION; THE LANE IS SCOPED.
--
-- Three advisory keys replace the one:
--
--   G = 'ca:tournament-terminal-settlement:v1'          (unchanged key)
--       Still taken EXCLUSIVE by every one of the 28 authorities. Authorities
--       remain serialised against each other exactly as before, and the three
--       trigger guards that verify "the caller holds G exclusive"
--       (fn_tournament_live_seat_acquisition_requires_authority,
--       fn_tournament_payouts_are_append_only,
--       fn_satellite_target_player_provenance_is_immutable) are untouched
--       and keep passing for exactly the callers they passed for yesterday.
--
--   B = 'ca:hand-settlement-barrier:v1'                  (new)
--       Taken SHARED by every hand settlement, cash or tournament. Taken
--       EXCLUSIVE, after G, by the TERMINAL and RARE authorities - terminal
--       settlement, cancellation, satellite delivery, final-table deals,
--       managed-game close/commands, rake and bounty sweeps (20 functions,
--       tens of calls per hour). For those, the exclusion is byte-for-byte
--       what it was yesterday: while one runs, no hand on the platform
--       commits.
--
--   T(id) = 'ca:tournament-terminal-settlement:v1:' || tournament_id   (new)
--       Taken SHARED by the hand settlement of a TOURNAMENT table, after B.
--       Taken EXCLUSIVE, after G, by the ROLLING per-tournament authorities
--       that name their tournament - seat acquisition, registration (ticket
--       and horse), rebuy, unregistration, bounty collect/reserve, the
--       per-tournament bounty sweep (8 functions, thousands of calls per
--       hour). A Spin seat purchase now waits only for hands of THAT Spin,
--       and only hands of that Spin wait for it. A cash hand never waits for
--       a tournament registration again.
--
-- Lock order is G -> B -> T -> 'atomic-table:<id>' -> rows, everywhere. Hand
-- settlement takes B -> T -> atomic-table (it never takes G; it never did).
-- Rolling authorities take G -> T. Terminal authorities take G -> B. Every
-- path acquires in the same global order and every acquisition happens at the
-- top of the function before any row lock, so no wait-for cycle is possible
-- across the three keys. fn_ca_lock_tournament_seat_acquisition may be handed
-- a table instead of a tournament; the helper resolves the tournament from
-- public.tables exactly as the function does, and when it cannot (a caller
-- that named neither) it falls back to the full barrier B - i.e. yesterday's
-- semantics - rather than to no lock.
--
-- HOW THE 30 FUNCTIONS ARE EDITED
--
-- Each of the 28 exclusive takers contains exactly one
--     PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
-- and each of the 2 shared takers exactly one
--     PERFORM pg_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0));
-- (measured on production before writing this; the DO block below re-measures
-- and refuses to run if the count is anything else). That single statement is
-- replaced by a call to the matching helper; nothing else in any function
-- body changes. The rewrite reads the live definition through
-- pg_get_functiondef and re-issues it, so it cannot clobber an edit another
-- migration makes to one of these bodies between now and apply time - it
-- would either carry the edit forward or fail loudly on the count check.
-- Twelve agents work this repo; a migration that pasted 30 bodies captured
-- an hour earlier would be a silent revert waiting to happen.
--
-- Helpers are SECURITY INVOKER: they run as whatever the calling SECURITY
-- DEFINER authority already runs as, and the only table they read is
-- public.tables.

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_global()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- G then B. Terminal / rare authorities: serialised against every other
  -- authority AND against every hand settlement, as on 2026-09-09.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(
  p_tournament_id uuid,
  p_table_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- G first: still one authority at a time, still what the trigger guards
  -- look for.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to. Keep yesterday's exclusion rather than none.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- T(id): only this tournament's hands wait, and only for this tournament's
  -- rolling authorities.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_ca_share_settlement_lane_for_table(
  p_table_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_tournament_id uuid;
BEGIN
  -- B shared: yields to terminal authorities, concurrent with every other
  -- hand and with rolling authorities of OTHER tournaments.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));

  IF p_table_id IS NULL THEN
    RETURN;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
  FROM public.tables tb
  WHERE tb.id = p_table_id;

  IF v_tournament_id IS NOT NULL THEN
    -- T(id) shared: yields to this tournament's own rolling authorities.
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_global() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_ca_lock_settlement_lane_global() IS
  'Terminal/rare tournament money authorities: G (ca:tournament-terminal-settlement:v1) exclusive, then B (ca:hand-settlement-barrier:v1) exclusive. Excludes every hand settlement on the platform for the duration. See the 2026-09-10 lane migration.';
COMMENT ON FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(uuid, uuid) IS
  'Rolling per-tournament money authorities: G exclusive, then T(tournament) exclusive. Excludes only that tournament''s hand settlements. Falls back to B when no tournament can be resolved.';
COMMENT ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) IS
  'Accepted-hand authority: B shared, then T(tournament) shared when the table is a tournament table. Cash hands take B only.';

DO $rewrite$
DECLARE
  -- name -> replacement statement. The replacement is the ONLY text that
  -- changes in each body.
  v_plan CONSTANT jsonb := jsonb_build_object(
    -- rolling, per-tournament (G -> T)
    'fn_ca_lock_tournament_seat_acquisition',
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, p_table_id);',
    'fn_register_horse_for_tournament_before_terminal_gate',
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);',
    'fn_ca_register_for_tournament_with_ticket_for',
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);',
    'process_tournament_rebuy',
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);',
    'fn_ca_unregister_tournament_player_exact',
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);',
    'fn_collect_bounty',
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);',
    'fn_mystery_bounty_reserve',
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);',
    'fn_sweep_pending_tournament_bounties',
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);',
    -- terminal / rare (G -> B): yesterday's exclusion, unchanged in effect
    'atomic_cancel_tournament',                          'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_award_satellite_seat',                           'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_backpay_unfinalised_bounty_pools',               'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_ca_return_satellite_entitlement_as_ticket',      'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_close_managed_game',                             'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_complete_tournament_terminal',                   'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_deliver_satellite_ticket_exact',                 'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_execute_managed_game_command',                   'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_finalize_bounty_pool',                           'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_mystery_bounty_pay',                             'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_mystery_bounty_settle',                          'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_resolve_satellite_settlement_outcome',           'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_resolve_tournament_terminal_outcome',            'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_settle_final_table_deal_atomic',                 'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_settle_satellite_finish_atomic',                 'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_settle_satellite_tournament_pre_money_path_gate','PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_settle_tournament_final_table_deal',             'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_settle_tournament_places',                       'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_settle_tournament_rake',                         'PERFORM public.fn_ca_lock_settlement_lane_global();',
    'fn_sweep_unsettled_tournament_rake',                'PERFORM public.fn_ca_lock_settlement_lane_global();',
    -- accepted-hand authority (B shared -> T shared)
    'fn_ca_commit_hand_settlement',
      'PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);',
    'fn_ca_commit_hand_settlement_before_lease_generation',
      'PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);'
  );
  v_excl CONSTANT text :=
    'PERFORM\s+pg_advisory_xact_lock\(\s*hashtextextended\(\s*''ca:tournament-terminal-settlement:v1''\s*,\s*0\s*\)\s*\)\s*;';
  v_shared CONSTANT text :=
    'PERFORM\s+pg_advisory_xact_lock_shared\(\s*hashtextextended\(\s*''ca:tournament-terminal-settlement:v1''\s*,\s*0\s*\)\s*\)\s*;';
  v_name text;
  v_replacement text;
  v_oid oid;
  v_def text;
  v_new text;
  v_pattern text;
  v_hits integer;
  v_done integer := 0;
  v_unplanned text;
BEGIN
  -- Every public function that mentions the lane key must be either in the
  -- plan or one of the three trigger guards that only CHECK the key.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_unplanned
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosrc LIKE '%ca:tournament-terminal-settlement:v1%'
    AND NOT (v_plan ? p.proname)
    AND p.proname NOT IN (
      'fn_tournament_live_seat_acquisition_requires_authority',
      'fn_tournament_payouts_are_append_only',
      'fn_satellite_target_player_provenance_is_immutable',
      'fn_ca_lock_settlement_lane_global',
      'fn_ca_lock_settlement_lane_for_tournament',
      'fn_ca_share_settlement_lane_for_table');
  IF v_unplanned IS NOT NULL THEN
    RAISE EXCEPTION 'lane migration refused: functions take the lane but are not in the plan: %', v_unplanned;
  END IF;

  FOR v_name, v_replacement IN SELECT key, value #>> '{}' FROM jsonb_each(v_plan) LOOP
    SELECT p.oid INTO v_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'lane migration refused: public.% does not exist', v_name;
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = v_name) <> 1 THEN
      RAISE EXCEPTION 'lane migration refused: public.% is overloaded; the plan names one body', v_name;
    END IF;

    v_pattern := CASE WHEN v_replacement LIKE '%fn_ca_share_settlement_lane_for_table%'
                      THEN v_shared ELSE v_excl END;
    v_def := pg_get_functiondef(v_oid);
    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, v_pattern, 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'lane migration refused: public.% has % lane lock sites, expected exactly 1', v_name, v_hits;
    END IF;

    v_new := regexp_replace(v_def, v_pattern, v_replacement);
    IF v_new = v_def THEN
      RAISE EXCEPTION 'lane migration refused: rewrite of public.% changed nothing', v_name;
    END IF;
    IF v_new LIKE '%ca:tournament-terminal-settlement:v1''%' THEN
      RAISE EXCEPTION 'lane migration refused: public.% still takes the global key directly after rewrite', v_name;
    END IF;

    EXECUTE v_new;
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> 30 THEN
    RAISE EXCEPTION 'lane migration refused: rewrote % functions, expected 30', v_done;
  END IF;
END;
$rewrite$;
