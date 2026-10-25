-- 20261025032315_a_page_recompute_finds_its_own_club_unaccrued_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file changes ONE function, by anchored edits of its
-- installed definition:
--   FUNCTION public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])
-- It writes no row, moves no chip and changes no accounting outcome.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS (2026-10-25 03:00-03:50 UTC)
--
-- The rakeback settler's durable cursor (daemon_state 'rakeback_settler')
-- stopped at 2026-10-24 17:21:38.049714 and did not move after 23:21 UTC:
-- 124,821 rake records above it at 03:45, zero first-attempt cash source
-- receipts after 23:21, every cycle re-running the same 1,000-row page.
--
-- That page holds rake of five clubs. Its period recompute for four of them
-- returns in well under a second (cash_source_receipts_incomplete, a durable
-- deferral). For Lightning Internal Pilot (e14bc9f7, week 2026-10-19) it never
-- returns: its request row last committed at 2026-10-24 23:21:04 (attempts
-- 1330), and postgres logged "canceling statement due to statement timeout"
-- through every cycle. The settler reads the durable receipt back for its
-- 300 s + 15 s window, finds none, counts a failure and holds the cursor for
-- every club (RakebackSettlerService "A FAILED RECOMPUTE MUST NOT ADVANCE THE
-- WATERMARK"). So no cash commission or player rakeback accrued anywhere.
--
-- Why that one call is slow. The page door (20260926091232) answers
-- cash_source_receipts_incomplete without the calculator when it sees an
-- unaccrued hand of this club among the week's NEWEST 200 CASH RECORDS OF
-- EVERY CLUB. The pilot club stopped dealing at 23:23:38 (its games were shut
-- down when Lightning went live in Midway Union), so its 1,352 unaccrued hands
-- above the cursor fell out of that shared window - all 200 newest records are
-- Midway hands - and the call went to fn_calculate_cash_rakeback_periods.
-- That calculator's page path reuses a per-club evidence checkpoint only while
-- fn_accounting_clubs_scope_digest() is unchanged; e14's was taken 2026-10-22
-- 23:39 and five clubs have been created since, so it re-reads the week from
-- its first batch (748,833 batches, 927,997 cash records this week) and runs
-- into its 300 s statement_timeout every time. Even if it finished, it would
-- answer the same refusal: 1,352 of the club's attributions this week have no
-- accrued batch.
--
-- WHAT CHANGES
--
-- 1. The page door, when the shared window finds nothing, also reads THIS
--    club's newest 200 attributions in the week (idx_rake_attributions_club_
--    created, an index range) under the window's exact predicate: a cash
--    record of the accounting week (launch start applied) with a hand and no
--    accrued batch. Each row it counts is an attribution the calculator counts
--    as `incomplete` and refuses on, so the door returns the calculator's own
--    answer, cash_source_receipts_incomplete with a lower-bound source_count,
--    as the existing door already does. A club whose newest hands are all
--    accrued still goes to the unchanged calculator.
-- 2. The witness wait before the lock first asks the same club-scoped question
--    once. A club that has stopped dealing has no new hand to wait for, so 16
--    half-second sleeps bought nothing but 8 s per call.
--
-- Unchanged: the whole-period call (p_user_ids NULL), the weekly close, the
-- calculator, the lock order, the request row writes and every receipt shape.
--
-- PROVED FIRST (CLAUDE.md 11.5), in ONE Supabase MCP call ending in RAISE
-- (rolled back), the post-image installed as pg_temp.probe_recompute, page
-- calls with p_user_ids '{}' for week 2026-10-19, at 03:49 UTC:
--   e14bc9f7 Lightning Internal Pilot  new 263 ms  blocked
--            cash_source_receipts_incomplete source_count 200 (the pre-image
--            exceeds its 300 s statement_timeout on every cycle since 23:21)
--   2a1132b9 Deep Stack Society  old 49 ms / new 5 ms, identical receipt
--            (blocked, cash_source_receipts_incomplete, source_count 246)
--   a41434bb KINGS CLUB          old 83 ms / new 5 ms, identical (199)
--   a0000000 The Felt Society    old 91 ms / new 5 ms, identical (185)
--   fade0000 Midway Union        new 235 ms, blocked, incomplete (200)
-- Afterwards the installed definition was still 754c7b90 and every request
-- row's attempts and attempted_at were unchanged: nothing persisted.
--
-- Release: no row is touched. The settler's next cycle submits the same page;
-- e14's page call now returns its durable deferral directly, every group of
-- the page is accounted for, and the cursor is saved past the page.
--
-- Pinned by tests/a-page-recompute-finds-its-own-club-unaccrued-hand.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='33d4eb0fe9e4944668e6899ab0da8c41' AND md5(pg_get_functiondef(oid))='34534e8ec5452e854db21fb4e7b4bc3a' FROM pg_proc WHERE oid='public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $page_door$
DECLARE
  v_fn  regprocedure := 'public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure;
  v_src text; v_find text; v_n integer; v_acl text; v_owner text; v_secdef boolean; v_config text[];
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text, p.proowner::regrole::text, p.prosecdef, p.proconfig
    INTO v_src, v_acl, v_owner, v_secdef, v_config
    FROM pg_proc p WHERE p.oid = v_fn;
  IF md5(v_src) <> '754c7b903771621ccc4d3e90b2dd8454' THEN
    RAISE EXCEPTION 'PAGE_DOOR_PREIMAGE_DRIFT: fn_rakeback_recompute_periods is %, read it before re-running', md5(v_src);
  END IF;
  -- edit 1
  v_find := ' defer_request_lock boolean:=false;' || chr(10)
    || 'BEGIN' || chr(10)
    || '';
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'PAGE_DOOR_ANCHOR_1: anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
       ' defer_request_lock boolean:=false; v_club_from timestamptz;' || chr(10)
    || 'BEGIN' || chr(10)
    || '');

  -- edit 2
  v_find := '  IF cutover IS NOT NULL AND v_from>=cutover AND clock_timestamp()<v_to' || chr(10)
    || '     AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN' || chr(10)
    || '   LOOP' || chr(10)
    || '';
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'PAGE_DOOR_ANCHOR_2: anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
       '  IF cutover IS NOT NULL AND v_from>=cutover AND clock_timestamp()<v_to' || chr(10)
    || '     AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN' || chr(10)
    || '   -- A CLUB''S OWN UNACCRUED HAND IS ITS WITNESS (20261025032315). A club whose' || chr(10)
    || '   -- tables have stopped (Lightning Internal Pilot, last hand 2026-10-24 23:23)' || chr(10)
    || '   -- deals no new hand to wait for; when its newest attributions still lack an' || chr(10)
    || '   -- accrued batch the door below refuses anyway, so the half-second waits buy' || chr(10)
    || '   -- nothing. Read once, holding nothing; the door still decides under the lock.' || chr(10)
    || '   v_club_from:=public.fn_ca_launch_accounting_start(''club'',p_club_id,v_from);' || chr(10)
    || '   SELECT EXISTS(SELECT 1 FROM (SELECT a.rake_record_id FROM public.rake_attributions a' || chr(10)
    || '            WHERE a.club_id=p_club_id AND a.created_at>=v_club_from AND a.created_at<v_to' || chr(10)
    || '            ORDER BY a.created_at DESC LIMIT 200) ca' || chr(10)
    || '     JOIN public.rake_records r ON r.id=ca.rake_record_id' || chr(10)
    || '     WHERE r.created_at>=v_club_from AND r.created_at<v_to AND r.rake_amount>0' || chr(10)
    || '       AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.hand_id IS NOT NULL' || chr(10)
    || '       AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches b' || chr(10)
    || '                       WHERE b.rake_record_id=r.id AND b.status=''accrued'')) INTO witnessed;' || chr(10)
    || '   IF NOT witnessed THEN' || chr(10)
    || '   LOOP' || chr(10)
    || '');

  -- edit 3
  v_find := '   END LOOP;' || chr(10)
    || '  END IF;' || chr(10)
    || ' END IF;' || chr(10)
    || ' PERFORM pg_advisory_xact_lock(';
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'PAGE_DOOR_ANCHOR_3: anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
       '   END LOOP;' || chr(10)
    || '   END IF;' || chr(10)
    || '  END IF;' || chr(10)
    || ' END IF;' || chr(10)
    || ' PERFORM pg_advisory_xact_lock(');

  -- edit 4
  v_find := '                       WHERE b.rake_record_id=w.id AND b.status=''accrued'');' || chr(10)
    || '   END IF;' || chr(10)
    || '  END IF;' || chr(10)
    || '  IF unaccrued>0 THEN' || chr(10)
    || '';
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'PAGE_DOOR_ANCHOR_4: anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
       '                       WHERE b.rake_record_id=w.id AND b.status=''accrued'');' || chr(10)
    || '    -- THE DOOR ALSO LOOKS AT THIS CLUB''S OWN NEWEST HANDS (20261025032315).' || chr(10)
    || '    -- The window above is the week''s newest 200 cash records of EVERY club.' || chr(10)
    || '    -- When one club stops dealing while another keeps going, its unaccrued' || chr(10)
    || '    -- hands fall out of that window although nothing about them changed, and' || chr(10)
    || '    -- the call goes to the full-week calculator only to be refused the same' || chr(10)
    || '    -- way. Measured 2026-10-25: Lightning Internal Pilot''s page recompute for' || chr(10)
    || '    -- week 2026-10-19 ran into the 300 s statement_timeout every cycle from' || chr(10)
    || '    -- 23:21 UTC (its evidence checkpoint was taken under an older clubs digest,' || chr(10)
    || '    -- so the calculator re-read 514k records), the settler could not confirm' || chr(10)
    || '    -- the call and held its cursor for every club. So when the shared window' || chr(10)
    || '    -- finds nothing, read this club''s newest 200 attributions in the week' || chr(10)
    || '    -- (idx_rake_attributions_club_created) under the same predicate. Every row' || chr(10)
    || '    -- it counts is an attribution of this club on a cash record of the' || chr(10)
    || '    -- accounting week with no accrued batch, which the calculator counts as' || chr(10)
    || '    -- incomplete and refuses on, so the answer is the one the calculator can' || chr(10)
    || '    -- only reach; the count is a lower bound like the window''s.' || chr(10)
    || '    IF unaccrued=0 THEN' || chr(10)
    || '     v_club_from:=public.fn_ca_launch_accounting_start(''club'',p_club_id,v_from);' || chr(10)
    || '     SELECT count(*) INTO unaccrued FROM (SELECT a.rake_record_id FROM public.rake_attributions a' || chr(10)
    || '            WHERE a.club_id=p_club_id AND a.created_at>=v_club_from AND a.created_at<v_to' || chr(10)
    || '            ORDER BY a.created_at DESC LIMIT 200) ca' || chr(10)
    || '     JOIN public.rake_records r ON r.id=ca.rake_record_id' || chr(10)
    || '     WHERE r.created_at>=v_club_from AND r.created_at<v_to AND r.rake_amount>0' || chr(10)
    || '       AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.hand_id IS NOT NULL' || chr(10)
    || '       AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches b' || chr(10)
    || '                       WHERE b.rake_record_id=r.id AND b.status=''accrued'');' || chr(10)
    || '    END IF;' || chr(10)
    || '   END IF;' || chr(10)
    || '  END IF;' || chr(10)
    || '  IF unaccrued>0 THEN' || chr(10)
    || '');
  IF md5(v_src) <> '34534e8ec5452e854db21fb4e7b4bc3a' THEN
    RAISE EXCEPTION 'PAGE_DOOR_POSTIMAGE: the edited definition is %, not the proved post-image', md5(v_src);
  END IF;
  EXECUTE v_src;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '33d4eb0fe9e4944668e6899ab0da8c41'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = v_fn) <> '34534e8ec5452e854db21fb4e7b4bc3a'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_acl
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_owner
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_secdef
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_config
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'PAGE_DOOR_POSTIMAGE: installed body, owner, ACL or settings differ from the proved post-image';
  END IF;
END
$page_door$;

COMMIT;
