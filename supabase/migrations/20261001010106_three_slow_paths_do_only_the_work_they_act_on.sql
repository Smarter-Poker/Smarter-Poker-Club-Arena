-- ============================================================================
-- THREE SLOW PATHS DO ONLY THE WORK THEY ACT ON
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-01 00:39-01:10 UTC.
-- Every number below was read from pg_stat_statements, pg_stat_activity
-- sampling (0.1-0.2 s), cron.job_run_details, or a rolled-back probe. The full
-- evidence is docs/changelog/2026-10-01-three-slow-paths-do-only-the-work-they-act-on.md.
--
-- 1. atomic_table_buyin: 7,519 calls at 7,269 ms mean, 2,186 timeouts today.
--    Sampled buy-in backends: 0 lock waits, 39 of 44 samples in
--    DataFileRead/DataFilePrefetch - its own reads, not the hand-commit chain.
--    The reads are fn_nit_check's MAINTAIN branch: with no live roster row (a
--    fresh buy-in) it counts the player's whole ca_hand_facts history in the
--    game through idx_ca_hand_facts_user_pos (10,760 rows, 8,767 page reads,
--    14.65 s for one horse; 7.7 s and 14.5 s cold for two more in rolled-back
--    probes; the rest of the buy-in measured 21-138 ms). The buy-in refuses on
--    'career_vpip' only (atomic_table_buyin_before_maintenance_announcement_gate),
--    so the maintain answer it paid for was discarded on every call. The door
--    now asks fn_nit_career_check: fn_nit_check's career block, verbatim.
--    Same refusal, same rows written (rolled-back equivalence probe in the
--    changelog), without the scan.
--
-- 2. sp_drain_daily_challenge_event_outbox: 13,191 calls at 12,577 ms mean.
--    One event's own work is 3-13 ms (probe). Sampling 1,278 drain-backend
--    states: 41% Lock/advisory - every one blocked by
--    SELECT public.fn_ca_horse_claim_due(500), which holds each horse it claims
--    until its run commits (avg 23.9 s, max 120 s); 21% WAL flush at the
--    per-player COMMIT; 14% DataFileRead; 14% CPU; 9% MultiXact SLRU.
--    (a) fn_drain_daily_challenge_event_outbox_user waited 250 ms (3 s after
--        three skips) for a player the claim held, then skipped anyway. It
--        now tries the player key once and takes the same skip path at once.
--    (b) Each per-player transaction books the event and deletes its outbox
--        row together, so it commits with synchronous_commit off: a crash
--        that loses an unflushed commit loses both and the event is drained
--        again, and any later synchronous commit flushes it first.
--    The claim's lock span is fn_ca_horse_claim_due's design and is NOT
--    changed here (another lane changed it at 20260930233500); reported.
--
-- 3. ca_club_data_snapshot (shark-club, 14 days): 14 s cold, 4.5 s of it in
--    fn_ca_club_game_rows. recent_tournament_ids ordered by
--    start_time DESC NULLS LAST, which idx_tournaments_start_time read backward
--    cannot produce (it yields DESC NULLS FIRST), so every call read all
--    299,393 tournaments (parallel index-only scan, 12,557 buffers, 9.85 s
--    cold) and sorted them to keep 100. tournaments.start_time is NOT NULL, so
--    DESC is the same order; with it the plan walks the index backward and
--    stops at 370 rows (10.5 ms). The summary read the club's daily rows
--    through the primary key with a heap fetch per row (55,649 buffers for
--    53,688 rows); a covering (club_id, stat_date) index makes it index-only,
--    and the table, never autovacuumed (relallvisible 1,712 of 5,666), gets
--    thresholds so the visibility map that index-only scans need stays fresh.
--
-- Not changed: statement_timeout, lock_timeout, the platform freeze, the
-- post-hand chain, fn_nit_check itself, fn_ca_horse_claim_due.
--
-- LOCKING: the index is built CONCURRENTLY, alone, before BEGIN (the
-- apply-merged-migration installer sends it on its own). The transaction
-- takes lock_timeout 2s and replaces four function bodies by asserted
-- substitution over md5-pinned live text, as 20261001000000 does.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure)) = '0bea051bd3b92d3c42ab870f6fad02b4')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_drain_daily_challenge_event_outbox_user(uuid,integer)'::regprocedure)) = '1f9a8c14027257664a61830770854b0b')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.sp_drain_daily_challenge_event_outbox(integer,integer,integer)'::regprocedure)) = '61635cfbedf05addc77a53c781963b68')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_club_game_rows(uuid,date,date,text,text,text,integer)'::regprocedure)) = '97180802749f9963f8e973f740e84bb1')
-- @live-proof: (SELECT to_regprocedure('public.fn_nit_career_check(uuid,uuid)') IS NOT NULL)
-- @live-proof: (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'ca_club_tournament_daily_club_day_cover_idx' AND i.indisvalid) = 1

CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_club_tournament_daily_club_day_cover_idx
  ON public.ca_club_tournament_daily (club_id, stat_date)
  INCLUDE (tournament_id, fee, winnings, updated_at);

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- The visibility map is what makes the covering index index-only. Same idiom
-- as ca_mint_ledger (20260929130144), scaled to this table.
ALTER TABLE public.ca_club_tournament_daily SET (
  autovacuum_vacuum_scale_factor        = 0.0,
  autovacuum_vacuum_threshold           = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.0,
  autovacuum_vacuum_insert_threshold    = 20000,
  autovacuum_analyze_scale_factor       = 0.0,
  autovacuum_analyze_threshold          = 5000
);

-- fn_nit_check's career block, verbatim (20260909181230), and nothing else.
CREATE OR REPLACE FUNCTION public.fn_nit_career_check(p_table_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_on            boolean;
  v_career_min    integer;
  v_maintain_n    integer;
  v_career_floor  integer;
  v_career_hands  integer;
  v_career_vpip   numeric;
BEGIN
  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.career_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1)
    INTO v_on, v_career_min, v_maintain_n
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;

  IF NOT COALESCE(v_on, false) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'nit_game_off');
  END IF;

  -- CAREER
  IF v_career_min > 0 THEN
    v_career_floor := GREATEST(v_maintain_n * 10, 100);
    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO v_career_hands, v_career_vpip
      FROM public.ca_hand_facts f
     WHERE f.user_id = p_user_id;

    IF v_career_hands >= v_career_floor AND v_career_vpip < v_career_min THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'career_vpip',
        'vpip', v_career_vpip, 'required', v_career_min, 'hands', v_career_hands);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', 'within_limits');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_nit_career_check(uuid, uuid) FROM PUBLIC, anon, authenticated;

DO $subs$
DECLARE
  s record; v_def text; v_after text; v_n integer; v_acl text; v_owner text; v_secdef boolean;
BEGIN
  IF NOT (SELECT a.attnotnull FROM pg_attribute a
           WHERE a.attrelid = 'public.tournaments'::regclass AND a.attname = 'start_time') THEN
    RAISE EXCEPTION 'tournaments.start_time is nullable: DESC is no longer DESC NULLS LAST';
  END IF;

  FOR s IN SELECT * FROM (VALUES
    ('atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)',
      'b329fed556008cf1a9a4b8fe7727ac9e', '0bea051bd3b92d3c42ab870f6fad02b4',
      E'    v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);\n',
      E'    /* THE DOOR ASKS ONLY WHAT IT ACTS ON (2026-10-01). This door refuses on\n'
      || E'       career_vpip and on no other answer fn_nit_check gives, and the\n'
      || E'       maintain branch it ignored read the player''s whole hand history in\n'
      || E'       the game (7.7 s and 14.5 s cold for two horses, 8,767 page reads).\n'
      || E'       fn_nit_career_check is the same career statement over the same rows. */\n'
      || E'    v_nit := public.fn_nit_career_check(p_table_id, p_user_id);\n'),
    ('fn_drain_daily_challenge_event_outbox_user(uuid,integer)',
      '7f0038702980eef5f59dba244a398072', '1f9a8c14027257664a61830770854b0b',
      E'    PERFORM public.fn_lock_daily_mission_user(p_user_id);\n\n    FOR r IN\n',
      E'    /* A HELD PLAYER IS SKIPPED, NOT WAITED ON (2026-10-01). 41% of the\n'
      || E'       drain''s time was this wait, every sample behind fn_ca_horse_claim_due,\n'
      || E'       which holds each horse it claims until its run commits; the wait then\n'
      || E'       timed out into the skip below anyway. The player key is tried once\n'
      || E'       and a held player takes the same skip path at once. */\n'
      || E'    IF NOT pg_try_advisory_xact_lock(\n'
      || E'      hashtextextended(''daily-missions-user:'' || p_user_id::text, 0)\n'
      || E'    ) THEN\n'
      || E'      RAISE EXCEPTION ''Daily Missions player % is held by another transaction'', p_user_id\n'
      || E'        USING ERRCODE = ''lock_not_available'';\n'
      || E'    END IF;\n'
      || E'    PERFORM public.fn_lock_daily_mission_user(p_user_id);\n\n    FOR r IN\n'),
    ('sp_drain_daily_challenge_event_outbox(integer,integer,integer)',
      '01561e0421d24ae15ca4c64b7b3561b0', '61635cfbedf05addc77a53c781963b68',
      E'    PERFORM set_config(''search_path'', ''pg_catalog, public, pg_temp'', true);\n',
      E'    PERFORM set_config(''search_path'', ''pg_catalog, public, pg_temp'', true);\n'
      || E'    /* ONE PLAYER''S RECEIPT IS NOT WORTH AN FSYNC (2026-10-01). 21% of the\n'
      || E'       drain''s time was WAL flush at this per-player COMMIT. The event is\n'
      || E'       booked and its outbox row deleted in one transaction, so a crash that\n'
      || E'       loses an unflushed commit loses both and the event is drained again;\n'
      || E'       any later synchronous commit flushes this one first. */\n'
      || E'    PERFORM set_config(''synchronous_commit'', ''off'', true);\n'),
    ('fn_ca_club_game_rows(uuid,date,date,text,text,text,integer)',
      'e0c899aef84c77ed8ab8a2832a832775', '97180802749f9963f8e973f740e84bb1',
      'ORDER BY tr.start_time DESC NULLS LAST,tr.id DESC',
      '/* start_time is NOT NULL: DESC is DESC NULLS LAST, and only DESC can walk'
      || E'\n          idx_tournaments_start_time backward and stop (2026-10-01) */\n'
      || '       ORDER BY tr.start_time DESC,tr.id DESC')
  ) AS x(signature, before_md5, after_md5, old_text, new_text)
  LOOP
    v_def := pg_get_functiondef(('public.' || s.signature)::regprocedure);
    IF md5(v_def) <> s.before_md5 THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', s.signature, md5(v_def);
    END IF;
    v_n := (length(v_def) - length(replace(v_def, s.old_text, ''))) / length(s.old_text);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the clause to change occurs % times in %, expected exactly 1', v_n, s.signature;
    END IF;
    SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef INTO v_acl, v_owner, v_secdef
      FROM pg_proc p WHERE p.oid = ('public.' || s.signature)::regprocedure;
    EXECUTE replace(v_def, s.old_text, s.new_text);
    v_after := pg_get_functiondef(('public.' || s.signature)::regprocedure);
    IF md5(v_after) <> s.after_md5 THEN
      RAISE EXCEPTION '% is not the measured text (md5 %)', s.signature, md5(v_after);
    END IF;
    IF md5(replace(v_after, s.new_text, s.old_text)) <> s.before_md5 THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', s.signature;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = ('public.' || s.signature)::regprocedure
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl AND pg_get_userbyid(p.proowner) = v_owner
                   AND p.prosecdef = v_secdef) THEN
      RAISE EXCEPTION '%: owner, security or grants moved', s.signature;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.fn_nit_career_check(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_nit_career_check(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_nit_career_check is reachable from a browser';
  END IF;
END $subs$;

COMMIT;
