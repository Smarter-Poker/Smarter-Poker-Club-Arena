-- 20261031202247_the_lightning_pilot_assignment_tables_drop_before_their_door.sql
--
-- SUPERSEDES 20261031190132, which never installed: the applier sent it at
-- 20:21 UTC and the database refused it whole after 238 ms (ERROR 2BP01: the
-- CHECK constraint lightning_pilot_assignment_reviewed_manifest_check depends
-- on fn_lightning_pilot_assignment_players_20261023, so that function cannot be
-- dropped while the table stands). Nothing committed. This is the same change
-- with the two tables dropped before the seven doors; everything else is
-- byte-for-byte the earlier file.
--
-- OWNER INSTRUCTION (Dan, 2026-10-31, verbatim): "REMOVE THE LIGHTNING INTERNAL
-- PILOT, AND ANY AND ALL TRACES OF IT IF ITS NO LONGER NEEDED FOR ANYTHING."
--
-- 20261031184340 settled and retired the pilot club (95087). This removes what
-- the database still kept for it:
--
--  - The standing pilot assignment: tables lightning_pilot_assignment (one row,
--    inactive since 2026-10-24 22:29 UTC) and lightning_pilot_assignment_receipts,
--    and its seven doors (fn_lightning_pilot_assignment_blocks / _players /
--    _players_20261023 / _set / _status, fn_lightning_pilot_withdraw_zero,
--    fn_lightning_pilot_withdrawal_receipt).
--  - The two callers of the assignment gate, fn_register_horse_for_tournament
--    and fn_seat_horse_in_seat_first_game, each opened with
--    "IF fn_lightning_pilot_assignment_blocks(...) THEN ... END IF;". With no
--    active assignment that gate is always false, so cutting the block changes
--    no outcome: it only stops taking a shared advisory lock on every horse
--    registration and stops naming a table about to be dropped.
--  - fn_lightning_rollout_readiness exempted fn_lightning_pilot_assignment_set
--    by md5 from its "no Lightning door names a horse" law; with the door gone
--    the exemption is dead and is cut.
--  - fn_ca_house_board_allows_automation named the pilot club as a fifth house
--    board (Dan's 2026-10-14 ruling, 20261015032740). A retired club seats no
--    one, so the entry is cut and the list is back to the four legacy boards.
--  - The money RPC registry row for fn_lightning_pilot_withdraw_zero becomes
--    'retired' (kept, as for every retired door).
--  - The pilot's horse-roster exemption row, the run-state rows of its two
--    six-seat Clusters (lightning_cluster_control, the integrity-scan entries in
--    lightning_alert_sweep_state), and its 142 still-open integrity signals,
--    all horse against horse inside a retired house club, are cleared by the
--    platform identity with the reason recorded. Drain history, hands and the
--    retired club's own records stay.
--
-- Each function is patched in place from its live definition on an exact
-- anchor that must occur once; anything else refuses the whole transaction.
-- The four patched bodies were compiled as pg_temp functions against
-- production at 19:10 UTC (temporary objects only, rolled back): every anchor
-- occurred once and no patched body names the pilot.
-- One transaction, so one schema-cache reload. No hot table is locked: the
-- functions are replaced in pg_proc and the only rows touched are the pilot's.
--
-- @live-proof: to_regclass('public.lightning_pilot_assignment') IS NULL AND to_regclass('public.lightning_pilot_assignment_receipts') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND (p.proname LIKE 'fn\_lightning\_pilot\_%' OR p.prosrc LIKE '%lightning\_pilot\_assignment%')) AND NOT EXISTS (SELECT 1 FROM public.ca_horse_roster_exempt_clubs WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d') AND EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname = 'fn_lightning_pilot_withdraw_zero' AND status = 'retired') AND position('e14bc9f7' IN pg_get_functiondef('public.fn_ca_house_board_allows_automation(uuid)'::regprocedure)) = 0

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $remove$
DECLARE
 c_club     constant uuid := 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
 c_platform constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';  -- Smarter.Poker Official
 c_note     constant text := 'Lightning Internal Pilot removed (owner, 2026-10-31); the club is retired and these horse-against-horse signals in it need no review.';
 v_target regprocedure;
 v_def text;
 v_patched text;
 v_i int;
 v_j int;
 v_open text := E'  IF public.fn_lightning_pilot_assignment_blocks(p_user_id,p_tournament_id) THEN\n';
 v_close text := E'\n  END IF;\n';
 v_law_anchor text := E'\n                          AND NOT (p.oid = to_regprocedure(''public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'')\n                            AND md5(pg_get_functiondef(p.oid)) = ''729f257c117c4c2493f718e72683939e'')';
 v_board_anchor text := E'''2a1132b9-5ba2-42e6-9f01-30a7fcffebe3''::uuid,   -- Deep Stack Society\n          -- Lightning Internal Pilot: Dan''s ruling 2026-10-14 (20261015032740)\n          ''e14bc9f7-736d-425f-8f2c-e78305ebac1d''::uuid\n';
 v_board_after text := E'''2a1132b9-5ba2-42e6-9f01-30a7fcffebe3''::uuid    -- Deep Stack Society\n';
 v_meta_before jsonb;
 v_meta_after jsonb;
 v_n int;
BEGIN
 -- The club must already be retired by 20261031184340, and the assignment off.
 IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = c_club AND lifecycle_status = 'retired') THEN
  RAISE EXCEPTION 'PILOT_REMOVAL_CLUB_NOT_RETIRED' USING ERRCODE = '55000';
 END IF;
 IF EXISTS (SELECT 1 FROM public.lightning_pilot_assignment WHERE active) THEN
  RAISE EXCEPTION 'PILOT_REMOVAL_ASSIGNMENT_STILL_ACTIVE' USING ERRCODE = '55000';
 END IF;

 -- 1. The two horse entry doors lose the pilot gate block.
 FOREACH v_target IN ARRAY ARRAY[
   'public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure,
   'public.fn_seat_horse_in_seat_first_game(uuid,uuid)'::regprocedure]
 LOOP
  SELECT pg_get_functiondef(p.oid),
         jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'secdef', p.prosecdef, 'cfg', p.proconfig)
    INTO v_def, v_meta_before FROM pg_proc p WHERE p.oid = v_target;
  IF (length(v_def) - length(replace(v_def, v_open, ''))) / length(v_open) <> 1
     OR (length(v_def) - length(replace(v_def, 'lightning_pilot', ''))) / length('lightning_pilot') <> 2 THEN
   RAISE EXCEPTION 'PILOT_REMOVAL_GATE_ANCHOR_CHANGED %', v_target USING ERRCODE = '55000';
  END IF;
  v_i := strpos(v_def, v_open);
  v_j := strpos(substr(v_def, v_i), v_close);
  IF v_j = 0 THEN RAISE EXCEPTION 'PILOT_REMOVAL_GATE_END_NOT_FOUND %', v_target; END IF;
  v_patched := substr(v_def, 1, v_i - 1) || substr(v_def, v_i + v_j - 1 + length(v_close));
  IF v_patched LIKE '%lightning_pilot%' OR v_patched NOT LIKE '%fn_ca_lock_tournament_seat_acquisition%' THEN
   RAISE EXCEPTION 'PILOT_REMOVAL_GATE_CUT_WRONG %', v_target;
  END IF;
  EXECUTE v_patched;
  SELECT jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'secdef', p.prosecdef, 'cfg', p.proconfig)
    INTO v_meta_after FROM pg_proc p WHERE p.oid = v_target;
  IF v_meta_after IS DISTINCT FROM v_meta_before THEN
   RAISE EXCEPTION 'PILOT_REMOVAL_METADATA_CHANGED % % %', v_target, v_meta_before, v_meta_after;
  END IF;
 END LOOP;

 -- 2. The readiness law loses its dead md5 exemption for the pilot set door.
 v_target := 'public.fn_lightning_rollout_readiness(uuid)'::regprocedure;
 SELECT pg_get_functiondef(p.oid),
        jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'secdef', p.prosecdef, 'cfg', p.proconfig)
   INTO v_def, v_meta_before FROM pg_proc p WHERE p.oid = v_target;
 IF (length(v_def) - length(replace(v_def, v_law_anchor, ''))) / length(v_law_anchor) <> 1 THEN
  RAISE EXCEPTION 'PILOT_REMOVAL_READINESS_ANCHOR_CHANGED' USING ERRCODE = '55000';
 END IF;
 v_patched := replace(v_def, v_law_anchor, '');
 IF v_patched LIKE '%lightning_pilot%' THEN RAISE EXCEPTION 'PILOT_REMOVAL_READINESS_CUT_WRONG'; END IF;
 EXECUTE v_patched;
 SELECT jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'secdef', p.prosecdef, 'cfg', p.proconfig)
   INTO v_meta_after FROM pg_proc p WHERE p.oid = v_target;
 IF v_meta_after IS DISTINCT FROM v_meta_before THEN
  RAISE EXCEPTION 'PILOT_REMOVAL_READINESS_METADATA_CHANGED';
 END IF;

 -- 2b. The house-board list loses the retired pilot club.
 v_target := 'public.fn_ca_house_board_allows_automation(uuid)'::regprocedure;
 SELECT pg_get_functiondef(p.oid),
        jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'secdef', p.prosecdef, 'cfg', p.proconfig, 'vol', p.provolatile)
   INTO v_def, v_meta_before FROM pg_proc p WHERE p.oid = v_target;
 IF (length(v_def) - length(replace(v_def, v_board_anchor, ''))) / length(v_board_anchor) <> 1 THEN
  RAISE EXCEPTION 'PILOT_REMOVAL_HOUSE_BOARD_ANCHOR_CHANGED' USING ERRCODE = '55000';
 END IF;
 v_patched := replace(v_def, v_board_anchor, v_board_after);
 IF v_patched LIKE '%e14bc9f7%' THEN RAISE EXCEPTION 'PILOT_REMOVAL_HOUSE_BOARD_CUT_WRONG'; END IF;
 EXECUTE v_patched;
 SELECT jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'secdef', p.prosecdef, 'cfg', p.proconfig, 'vol', p.provolatile)
   INTO v_meta_after FROM pg_proc p WHERE p.oid = v_target;
 IF v_meta_after IS DISTINCT FROM v_meta_before THEN
  RAISE EXCEPTION 'PILOT_REMOVAL_HOUSE_BOARD_METADATA_CHANGED';
 END IF;

 -- 3. The pilot's own state rows.
 DELETE FROM public.ca_horse_roster_exempt_clubs WHERE club_id = c_club;
 DELETE FROM public.lightning_cluster_control
  WHERE cluster_id IN (SELECT id FROM public.cash_games WHERE club_id = c_club);
 DELETE FROM public.lightning_alert_sweep_state
  WHERE key IN (SELECT 'integrity_scan:' || id::text FROM public.cash_games WHERE club_id = c_club);
 UPDATE public.lightning_integrity_signal
    SET status = 'cleared', reviewed_by = c_platform, reviewed_at = now(), updated_at = now(),
        notes = CASE WHEN coalesce(notes, '') = '' THEN c_note ELSE notes || E'\n' || c_note END
  WHERE status = 'open'
    AND cluster_id IN (SELECT id FROM public.cash_games WHERE club_id = c_club);
 GET DIAGNOSTICS v_n = ROW_COUNT;
 RAISE NOTICE 'pilot integrity signals cleared: %', v_n;
 UPDATE public.ca_money_rpc_registry
    SET status = 'retired',
        notes = notes || ' Retired 2026-10-31 with the Lightning Internal Pilot (owner instruction); the function is dropped.'
  WHERE proname = 'fn_lightning_pilot_withdraw_zero' AND status <> 'retired';

 -- 4. The assignment doors and tables.
 -- The tables first: a CHECK constraint on the assignment calls a door.
 DROP TABLE public.lightning_pilot_assignment_receipts, public.lightning_pilot_assignment;
 DROP FUNCTION public.fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid);
 DROP FUNCTION public.fn_lightning_pilot_withdrawal_receipt(uuid,uuid,uuid,uuid);
 DROP FUNCTION public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text);
 DROP FUNCTION public.fn_lightning_pilot_assignment_status();
 DROP FUNCTION public.fn_lightning_pilot_assignment_blocks(uuid,uuid);
 DROP FUNCTION public.fn_lightning_pilot_assignment_players_20261023();
 DROP FUNCTION public.fn_lightning_pilot_assignment_players();

 -- Nothing in the public schema may still name the pilot assignment.
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND (p.proname LIKE 'fn\_lightning\_pilot\_%' OR p.prosrc LIKE '%lightning\_pilot\_assignment%')) THEN
  RAISE EXCEPTION 'PILOT_REMOVAL_A_DOOR_STILL_NAMES_THE_PILOT';
 END IF;
END $remove$;

COMMIT;
