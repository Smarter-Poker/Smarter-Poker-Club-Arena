-- 20260921171249_a_silence_is_a_failure_the_board_can_see
--
-- Applied to production as version 20260912093734 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- RECORDED AFTER THE FACT. These objects were applied straight to production on
-- 2026-09-12 and were never written into the repository. Every definition below
-- was read back out of the live catalog with pg_get_functiondef on 2026-09-21
-- and is reproduced byte for byte. Nothing here is new, improved, renamed or
-- refactored: this file changes the REPOSITORY, not the database.
--
-- ===========================================================================
-- WHY AN UNRECORDED DETECTOR IS WORSE THAN AN UNRECORDED ANYTHING ELSE
--
-- A repo-only grep for fn_ca_orphaned_running_tournaments finds no caller and
-- no definition, so main says the function does not exist. It does. It runs
-- hourly, it is wired at severity 'critical', and on 2026-09-21 it held an
-- open incident at escalation level 4 with 77 occurrences.
--
-- That gap has already cost one wasted investigation: an agent auditing the
-- function concluded from the repository that it was dead code. The next step
-- after "this is dead" is "delete it", and deleting this one removes the only
-- watcher that can see the failure it was written for.
--
-- ===========================================================================
-- WHAT THE FIVE WATCH, AND WHY THEY ARE NOT LIKE THE CHECKS ABOVE THEM
--
-- Every other check in fn_ca_conservation_sweep measures an ERROR: a sum that
-- does not balance, a row that should not exist. These four measure an
-- ABSENCE, which is what five hours of zero hands on 2026-09-12 actually
-- looked like on the wire. Nothing was unbalanced. Nothing was orphaned in a
-- way any conservation check could name. The tables simply stopped being
-- dealt, every lease row looked healthy, and no alarm in the estate was
-- capable of noticing.
--
--   fn_ca_orphaned_running_tournaments  RUNNING with no lease, or a lease
--                                       nobody renews. Tests heartbeat
--                                       FRESHNESS, not row existence.
--   fn_ca_knockout_door_stalled         busts that stopped being recorded.
--   fn_ca_tables_that_cannot_deal       a RUNNING event whose busiest table
--                                       holds one player: it cannot be dealt
--                                       a hand by definition.
--   fn_ca_stranded_completing_tournaments  events parked in COMPLETING.
--
-- fn_ca_conservation_sweep is recorded here too, because the repository's
-- newest copy of it is 20260902051634 and predates all of this: rebuilt from
-- main, the sweep would run without a single one of the silences and the
-- platform would once again have no watcher for the failure they exist for.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT RECORDED HERE
--
-- fn_ca_rake_rollup_writer_silent is the fifth silence and was created by this
-- same 2026-09-12 application, and it is NOT in this file.
--
-- It was REPLACED on 2026-09-14 by 20260914011009_rake_rollup_daily_deadline,
-- which is committed, and whose text is the one production holds today. The
-- 2026-09-12 body differs from the live one. Recording that older text "for
-- completeness" would hand production a silent revert of a change that was
-- properly recorded two days later - the precise accident this discipline
-- exists to prevent. The already-recorded definition stands untouched.
--
-- ===========================================================================
-- WHAT THIS CHANGES IN PRODUCTION
--
-- Nothing. Five CREATE OR REPLACE statements whose text equals the live text,
-- four COMMENT ON statements whose text equals the live comments, and grants
-- that restate the ACL production already has. The pre-image guard refuses the
-- file outright if any body differs, so it cannot overwrite a later change;
-- the post-image assertion proves body, owner, SECURITY DEFINER, volatility,
-- search_path and ACL are what was read. Against a fresh rebuild the same file
-- creates the five objects and the same assertion proves the result matches.
--
-- @live-proof: (SELECT count(*) = 5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_ca_orphaned_running_tournaments','fn_ca_knockout_door_stalled','fn_ca_tables_that_cannot_deal','fn_ca_stranded_completing_tournaments','fn_ca_conservation_sweep'))
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';


DO $preimage$
/* ---------------------------------------------------------------------------
   PRE-IMAGE GUARD.

   This file DECLARES a definition that production already holds. There are
   exactly two trees it may legitimately meet:

     1. PRODUCTION, where the function exists and its body is byte-for-byte the
        one recorded below. Re-declaring it is then a no-op.
     2. A FRESH REBUILD, where the function does not exist yet and this file is
        the thing that creates it.

   Any third tree - the function exists with a DIFFERENT body - means somebody
   changed it after this record was read, and replaying the older text would
   silently revert their change. That is the one outcome a reconciliation must
   never produce, so it refuses instead.
   --------------------------------------------------------------------------- */
DECLARE
  e record;
  v_oid oid;
  v_live text;
BEGIN
  FOR e IN
    SELECT * FROM (VALUES
      ('public.fn_ca_orphaned_running_tournaments(integer)', '72d9bc1f2d219a958dca284c30a86e78', 's', 'search_path=public'),
      ('public.fn_ca_knockout_door_stalled(integer)', '4028912f205fa8bb08c0bea4e1f517e6', 's', 'search_path=public'),
      ('public.fn_ca_tables_that_cannot_deal(integer)', '85d8595b5fce02a05ccc399af031475d', 's', 'search_path=public'),
      ('public.fn_ca_stranded_completing_tournaments(integer)', '5573dc0a1189f790e2dd0389b52dc4df', 's', 'search_path=public'),
      ('public.fn_ca_conservation_sweep()', 'e279afe105ab24523aba7ab405f66706', 'v', 'search_path=public, pg_temp')
    ) v(sig, want_md5, want_vol, want_cfg)
  LOOP
    v_oid := to_regprocedure(e.sig);

    IF v_oid IS NULL THEN
      RAISE NOTICE 'pre-image: % is absent - this tree is a fresh build and this file creates it', e.sig;
      CONTINUE;
    END IF;

    SELECT md5(p.prosrc) INTO v_live FROM pg_proc p WHERE p.oid = v_oid;

    IF v_live IS DISTINCT FROM e.want_md5 THEN
      RAISE EXCEPTION
        'PRE-IMAGE REFUSED: % has body md5 % in this database, but this file records %. '
        'It was changed after this record was read. Re-read the live definition and '
        'record that instead - do not let a reconciliation overwrite a real change.',
        e.sig, v_live, e.want_md5;
    END IF;
  END LOOP;

  RAISE NOTICE 'pre-image: every function this file records is absent or already byte-identical';
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_ca_orphaned_running_tournaments(p_dwell_minutes integer DEFAULT 10)
 RETURNS TABLE(tournament_id uuid, tournament_name text, club_id uuid, condition text, lease_instance text, heartbeat_age_seconds numeric, running_minutes numeric, open_seats bigint, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT t.id, t.name, t.club_id,
         CASE WHEN l.tournament_id IS NULL THEN 'no_lease' ELSE 'lease_not_renewed' END,
         l.instance_id,
         round(extract(epoch FROM (now() - l.heartbeat_at))::numeric, 1),
         round((extract(epoch FROM (now() - COALESCE(t.started_at, t.created_at))) / 60.0)::numeric, 1),
         (SELECT count(*) FROM public.table_seats s
            JOIN public.tables tb ON tb.id = s.table_id
           WHERE tb.tournament_id = t.id AND s.left_at IS NULL),
         CASE WHEN l.tournament_id IS NULL THEN
           'RUNNING for '
             || round((extract(epoch FROM (now() - COALESCE(t.started_at, t.created_at))) / 60.0)::numeric, 1)
             || ' minute(s) with NO engine_tournament_leases row at all - no engine '
             || 'has claimed this event, so nobody is dealing it'
         ELSE
           'RUNNING and leased by ' || COALESCE(l.instance_id, '?')
             || ', but the lease has not been renewed for '
             || round((extract(epoch FROM (now() - l.heartbeat_at)) / 60.0)::numeric, 1)
             || ' minute(s). A held lease is not a live engine: the row looks '
             || 'healthy and the heartbeat is dead, which is how five hours of '
             || 'zero hands on 2026-09-12 went unremarked'
         END
    FROM public.tournaments t
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = t.id
   WHERE t.status = 'RUNNING'
     AND COALESCE(t.started_at, t.created_at)
           < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1))
     AND (l.tournament_id IS NULL
          OR l.heartbeat_at IS NULL
          OR l.heartbeat_at < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1)))
   ORDER BY 6 DESC NULLS FIRST
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_knockout_door_stalled(p_stall_minutes integer DEFAULT 15)
 RETURNS TABLE(last_resolved_at timestamp with time zone, stalled_minutes numeric, pending_candidates bigint, pending_past_prompt bigint, oldest_expired_prompt_minutes numeric, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH k AS (
    SELECT max(resolved_at) AS last_resolved_at,
           count(*) FILTER (WHERE resolved_at IS NULL) AS pending,
           count(*) FILTER (WHERE resolved_at IS NULL
                              AND rebuy_prompt_until < now()) AS past_prompt,
           min(rebuy_prompt_until) FILTER (WHERE resolved_at IS NULL
                              AND rebuy_prompt_until < now()) AS oldest_prompt
      FROM public.tournament_knockout_candidates
  )
  SELECT k.last_resolved_at,
         round((extract(epoch FROM (now() - k.last_resolved_at)) / 60.0)::numeric, 1),
         k.pending, k.past_prompt,
         round((extract(epoch FROM (now() - k.oldest_prompt)) / 60.0)::numeric, 1),
         'the knockout door has not resolved a single candidate for '
           || round((extract(epoch FROM (now() - k.last_resolved_at)) / 60.0)::numeric, 1)
           || ' minute(s) while ' || k.past_prompt
           || ' candidate(s) are waiting whose rebuy prompt has already expired, '
           || 'the oldest for '
           || round((extract(epoch FROM (now() - k.oldest_prompt)) / 60.0)::numeric, 1)
           || ' minute(s). Healthy is a gap of 2.04s (p50) and 19.19s (p99): '
           || 'this is not a quiet door, it is a stopped one, and every player '
           || 'behind it is neither eliminated nor allowed to rebuy'
    FROM k
   WHERE k.past_prompt > 0
     AND (k.last_resolved_at IS NULL
          OR k.last_resolved_at < now() - make_interval(mins => GREATEST(p_stall_minutes, 1)))
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tables_that_cannot_deal(p_dwell_minutes integer DEFAULT 5)
 RETURNS TABLE(tournament_id uuid, tournament_name text, club_id uuid, tables_with_open_seats bigint, max_open_seats_on_any_table bigint, total_open_seats numeric, stuck_minutes numeric, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH per_table AS (
    SELECT tb.tournament_id AS tid, tb.id AS table_id, count(*) AS open_seats,
           GREATEST(max(s.joined_at), max(tb.opened_at)) AS last_change
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE s.left_at IS NULL
       AND tb.tournament_id IS NOT NULL
     GROUP BY tb.tournament_id, tb.id
  ), per_event AS (
    SELECT t.id, t.name, t.club_id,
           count(*) AS tbls,
           max(p.open_seats) AS max_open,
           sum(p.open_seats)::numeric AS total_open,
           COALESCE(max(p.last_change), to_timestamp(0)) AS last_change
      FROM public.tournaments t
      JOIN per_table p ON p.tid = t.id
     WHERE t.status = 'RUNNING'
     GROUP BY t.id, t.name, t.club_id
  )
  SELECT e.id, e.name, e.club_id, e.tbls, e.max_open, e.total_open,
         round((extract(epoch FROM (now() - e.last_change)) / 60.0)::numeric, 1),
         'this RUNNING event holds open seats on ' || e.tbls
           || ' table(s) and the busiest of them has exactly 1 open seat, so no '
           || 'player anywhere in it has an opponent. It cannot be dealt a hand, '
           || 'by definition, and it has been in this shape for '
           || round((extract(epoch FROM (now() - e.last_change)) / 60.0)::numeric, 1)
           || ' minute(s) - far past any table balance in flight'
    FROM per_event e
   WHERE e.tbls > 1
     AND e.max_open = 1
     AND e.last_change < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1))
   ORDER BY e.tbls DESC, e.total_open DESC
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_stranded_completing_tournaments(p_dwell_minutes integer DEFAULT 15)
 RETURNS TABLE(tournament_id uuid, tournament_name text, club_id uuid, completing_minutes numeric, prize_pool numeric, prize_held numeric, players integer, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT t.id, t.name, t.club_id,
         round((extract(epoch FROM (now() - COALESCE(t.ended_at, t.updated_at))) / 60.0)::numeric, 1),
         round(COALESCE(t.prize_pool, 0), 2),
         round(COALESCE((SELECT e.prize_balance FROM public.tournament_escrow e
                          WHERE e.tournament_id = t.id), 0), 2),
         t.current_players,
         'status COMPLETING for '
           || round((extract(epoch FROM (now() - COALESCE(t.ended_at, t.updated_at))) / 60.0)::numeric, 1)
           || ' minute(s) with NO row in tournament_terminal_settlements. Every one '
           || 'of 15,869 healthy settlements was written in the same transaction '
           || 'that ended the event (settled_at - ended_at = 0.00s at p50, p95, p99 '
           || 'and max), so this event is not slow, it is refused - and the '
           || round(COALESCE((SELECT e.prize_balance FROM public.tournament_escrow e
                              WHERE e.tournament_id = t.id), 0), 2)
           || ' chips in its escrow are paid to nobody until somebody looks. This '
           || 'is the Breakfast Turbo shape, refused for three days to Sentry only'
    FROM public.tournaments t
   WHERE t.status = 'COMPLETING'
     AND COALESCE(t.ended_at, t.updated_at)
           < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1))
     AND NOT EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s
                      WHERE s.tournament_id = t.id)
   ORDER BY 4 DESC
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_conservation_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c record; v_n bigint; v_rows jsonb; v_verdict jsonb;
  v_found int := 0; v_failed int := 0; v_ran int := 0;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('fn_chip_integrity_report',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_chip_integrity_report() where severity <> ''ok'' limit 20) t',
       'warning'),
      ('fn_settlement_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_settlement_conservation_check() limit 20) t',
       'critical'),
      ('fn_union_chip_integrity_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_chip_integrity_check() limit 20) t',
       'critical'),
      ('fn_union_money_path_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_money_path_check() limit 20) t',
       'warning'),
      ('fn_club_arena_global_wallet_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_club_arena_global_wallet_check() limit 20) t',
       'warning'),
      ('fn_tournament_chip_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_chip_conservation_check(0.01) limit 20) t',
       'warning'),
      ('fn_satellite_conservation_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_satellite_conservation_audit(24) limit 20) t',
       'warning'),
      ('fn_tournament_prize_disbursement_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_prize_disbursement_audit(24) limit 20) t',
       'warning'),
      ('fn_union_credit_risk_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_credit_risk_check() limit 20) t',
       'warning'),
      ('fn_union_governance_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_governance_check() limit 20) t',
       'warning'),
      ('fn_union_house_club_stamp_check',
       'select v.n, case when v.n > 0 then jsonb_build_object(''unstamped_union_tables'', v.n) end from (select public.fn_union_house_club_stamp_check() as n) v',
       'warning'),
      ('fn_union_law_integrity_breaches',
       'select coalesce(jsonb_array_length(v.j),0), case when coalesce(jsonb_array_length(v.j),0) > 0 then v.j end from (select public.fn_union_law_integrity_breaches() as j) v',
       'critical'),
      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning'),
      ('fn_rake_spec_self_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_rake_spec_self_check() limit 20) t',
       'warning'),
      ('fn_spin_ladder_drift_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_spin_ladder_drift_check(7) limit 20) t',
       'warning'),
      ('fn_ca_payout_rows_without_money',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_payout_rows_without_money(3) limit 20) t',
       'warning'),
      ('fn_ca_undeclared_leg_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_undeclared_leg_check(24) limit 20) t',
       'warning'),
      ('fn_ca_stranded_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_tournament_players() limit 20) t',
       'warning'),
      ('fn_ca_absent_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_absent_tournament_players(10) limit 20) t',
       'critical'),
      ('fn_ca_hand_commit_refusals',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_hand_commit_refusals(24) limit 20) t',
       'warning'),
      ('fn_ca_chip_store_coverage_gaps',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_chip_store_coverage_gaps() limit 20) t',
       'warning'),
      /* THE SILENCES (2026-09-12). Every check above this line measures an
         ERROR. The five below measure an ABSENCE, which is what five hours of
         zero hands actually looked like on the wire. */
      ('fn_ca_orphaned_running_tournaments',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_orphaned_running_tournaments(10) limit 20) t',
       'critical'),
      ('fn_ca_knockout_door_stalled',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_knockout_door_stalled(15) limit 20) t',
       'critical'),
      ('fn_ca_tables_that_cannot_deal',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_tables_that_cannot_deal(5) limit 20) t',
       'critical'),
      ('fn_ca_stranded_completing_tournaments',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_completing_tournaments(15) limit 20) t',
       'critical'),
      ('fn_ca_rake_rollup_writer_silent',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_rake_rollup_writer_silent(26) limit 20) t',
       'warning')
    ) v(check_name, q, sev)
  LOOP
    BEGIN
      v_ran := v_ran + 1;
      EXECUTE c.q INTO v_n, v_rows;
      IF COALESCE(v_n,0) > 0 THEN
        v_found := v_found + 1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:' || c.check_name, 'ledger_imbalance', c.sev,
          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          0, NULL, v_n::numeric, 'ledger', c.check_name,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          c.check_name || ' returned ' || v_n || ' finding(s) - an invariant does not hold',
          false, jsonb_build_object('rows', v_rows, 'row_count', v_n));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'check could not run: ' || SQLERRM
          || ' - a check that errors is as silent as one that never runs',
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  FOR c IN
    SELECT * FROM (VALUES
      ('fn_bbj_conservation_check',   'select public.fn_bbj_conservation_check()',   'healthy'),
      ('fn_bbj_promo_bank_check',     'select public.fn_bbj_promo_bank_check()',     'reconciles'),
      ('fn_settler_lag_check',        'select public.fn_settler_lag_check()',        'healthy'),
      ('fn_tournament_guarantee_check','select public.fn_tournament_guarantee_check(24)','__guarantee')
    ) v(check_name, q, health_key)
  LOOP
    BEGIN
      v_ran := v_ran + 1;
      EXECUTE c.q INTO v_verdict;

      IF (c.health_key = '__guarantee'
            AND (COALESCE((v_verdict->>'short_of_guarantee')::numeric,0) > 0
              OR COALESCE((v_verdict->>'paid_nothing')::numeric,0) > 0))
         OR (c.health_key <> '__guarantee'
            AND COALESCE((v_verdict->>c.health_key)::boolean, true) IS NOT TRUE)
      THEN
        v_found := v_found + 1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:' || c.check_name, 'ledger_imbalance', 'warning',
          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          COALESCE((v_verdict->>'drift_from_baseline')::numeric,
                   (v_verdict->>'over_swept')::numeric,
                   (v_verdict->>'chips_short')::numeric, 0),
          NULL, NULL, 'ledger', c.check_name,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          c.check_name || ' reports a conservation failure',
          false, v_verdict);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'check could not run: ' || SQLERRM,
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_conservation_sweep',
          jsonb_build_object('checks_run', v_ran, 'with_findings', v_found, 'errored', v_failed));

  RETURN jsonb_build_object('ok', true, 'checks_run', v_ran,
                            'with_findings', v_found, 'errored', v_failed);
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_orphaned_running_tournaments(integer) IS
  'A RUNNING tournament with no engine lease, or with a lease nobody is renewing. Tests heartbeat FRESHNESS, not row existence: on 2026-09-12 every one of 652 leases was held and none was renewed for five hours, and engine_table_leases looked healthy the whole time. Dwell 10 min = 2x the :55 maintenance break and ~680x the measured p99 heartbeat age of 0.9s.';

COMMENT ON FUNCTION public.fn_ca_knockout_door_stalled(integer) IS
  'Critical when max(resolved_at) on tournament_knockout_candidates is older than the stall window WHILE pending candidates sit past their rebuy_prompt_until. Measured over 50,153 gaps in 7 days: p50 2.04s, p99 19.19s, p99.9 461.5s; only 19 gaps (0.038%) passed 15 minutes and every one was a stall. On 2026-09-12 this froze at 00:03:15 for 265.1 minutes.';

COMMENT ON FUNCTION public.fn_ca_tables_that_cannot_deal(integer) IS
  'A RUNNING tournament with open seats on more than one table where the maximum open seats on any one table is 1 - definitionally unable to deal. 45 events matched during the 2026-09-12 outage; 68 match now. Dwell 5 min only guards a balance in flight: the freshest current match has been stuck 42.5 minutes, so the dwell excludes 0 of 68.';

COMMENT ON FUNCTION public.fn_ca_stranded_completing_tournaments(integer) IS
  'A tournament stuck in COMPLETING with no tournament_terminal_settlements row. Measured healthy dwell in COMPLETING is 0.00s across 15,869 settlements (settled_at = completed_at = ended_at in every one), so any visible COMPLETING row has already committed without its settlement. Breakfast Turbo c1f15c30 sat here for three days with a 180.00 prize pool and reported only to Sentry.';

REVOKE ALL ON FUNCTION public.fn_ca_orphaned_running_tournaments(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_orphaned_running_tournaments(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_knockout_door_stalled(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_knockout_door_stalled(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tables_that_cannot_deal(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tables_that_cannot_deal(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_stranded_completing_tournaments(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_stranded_completing_tournaments(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_conservation_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_conservation_sweep() TO service_role;

DO $postimage$
/* ---------------------------------------------------------------------------
   POST-IMAGE ASSERTION.

   Body, owner, SECURITY DEFINER, volatility, search_path and the full ACL -
   asserted per object. The ACL is checked as a SET of grantee:privilege pairs
   rather than a string compare, so entry order cannot make a correct database
   look wrong.

   service_role is stated EXPLICITLY. This database grants it EXECUTE on new
   functions by DEFAULT PRIVILEGE, so a file that revokes only PUBLIC, anon and
   authenticated ends up with a grant it never declared, and an assertion that
   did not expect it would refuse a correct tree.
   --------------------------------------------------------------------------- */
DECLARE
  e record;
  v_oid oid;
  v_md5 text; v_owner text; v_secdef boolean; v_vol "char"; v_cfg text; v_acl text;
BEGIN
  FOR e IN
    SELECT * FROM (VALUES
      ('public.fn_ca_orphaned_running_tournaments(integer)', '72d9bc1f2d219a958dca284c30a86e78', 's', 'search_path=public'),
      ('public.fn_ca_knockout_door_stalled(integer)', '4028912f205fa8bb08c0bea4e1f517e6', 's', 'search_path=public'),
      ('public.fn_ca_tables_that_cannot_deal(integer)', '85d8595b5fce02a05ccc399af031475d', 's', 'search_path=public'),
      ('public.fn_ca_stranded_completing_tournaments(integer)', '5573dc0a1189f790e2dd0389b52dc4df', 's', 'search_path=public'),
      ('public.fn_ca_conservation_sweep()', 'e279afe105ab24523aba7ab405f66706', 'v', 'search_path=public, pg_temp')
    ) v(sig, want_md5, want_vol, want_cfg)
  LOOP
    v_oid := to_regprocedure(e.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POST-IMAGE: % does not exist after this migration ran', e.sig;
    END IF;

    SELECT md5(p.prosrc), pg_get_userbyid(p.proowner), p.prosecdef, p.provolatile,
           COALESCE(array_to_string(p.proconfig, ', '), '')
      INTO v_md5, v_owner, v_secdef, v_vol, v_cfg
      FROM pg_proc p WHERE p.oid = v_oid;

    IF v_md5 IS DISTINCT FROM e.want_md5 THEN
      RAISE EXCEPTION 'POST-IMAGE: % body md5 is %, expected %', e.sig, v_md5, e.want_md5;
    END IF;
    IF v_owner IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'POST-IMAGE: % is owned by %, expected postgres', e.sig, v_owner;
    END IF;
    IF v_secdef IS NOT TRUE THEN
      RAISE EXCEPTION 'POST-IMAGE: % is not SECURITY DEFINER', e.sig;
    END IF;
    IF v_vol IS DISTINCT FROM e.want_vol THEN
      RAISE EXCEPTION 'POST-IMAGE: % volatility is %, expected %', e.sig, v_vol, e.want_vol;
    END IF;
    IF v_cfg IS DISTINCT FROM e.want_cfg THEN
      RAISE EXCEPTION 'POST-IMAGE: % search_path is [%], expected [%]', e.sig, v_cfg, e.want_cfg;
    END IF;

    SELECT COALESCE(string_agg(g, ',' ORDER BY g), '(no acl)') INTO v_acl
      FROM (
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                    ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS g
          FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.oid = v_oid
      ) s;
    IF v_acl IS DISTINCT FROM 'postgres:EXECUTE,service_role:EXECUTE' THEN
      RAISE EXCEPTION 'POST-IMAGE: % ACL is [%], expected [%]', e.sig, v_acl, 'postgres:EXECUTE,service_role:EXECUTE';
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-IMAGE: % is reachable by a browser role', e.sig;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- THE WIRING, NOT JUST THE OBJECTS. A sweep that exists but no longer names
  -- the silences is the same outage with a tidier catalog.
  ---------------------------------------------------------------------------
  DECLARE v_def text; v_missing text := '';
  BEGIN
    SELECT pg_get_functiondef(to_regprocedure('public.fn_ca_conservation_sweep()')) INTO v_def;
    FOREACH v_cfg IN ARRAY ARRAY[
      'fn_ca_orphaned_running_tournaments',
      'fn_ca_knockout_door_stalled',
      'fn_ca_tables_that_cannot_deal',
      'fn_ca_stranded_completing_tournaments',
      'fn_ca_rake_rollup_writer_silent'
    ] LOOP
      IF position(v_cfg in v_def) = 0 THEN
        v_missing := v_missing || v_cfg || ' ';
      END IF;
    END LOOP;
    IF v_missing <> '' THEN
      RAISE EXCEPTION 'POST-IMAGE: the sweep no longer calls: %', v_missing;
    END IF;
  END;

  RAISE NOTICE 'post-image: every recorded definition matches production byte for byte';
END
$postimage$;

COMMIT;
