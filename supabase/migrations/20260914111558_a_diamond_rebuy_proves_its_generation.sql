-- ============================================================================
-- A DIAMOND REBUY PROVES ITS GENERATION
-- ============================================================================
--
-- Phase 8 of the Diamond Arena programme, found by the Phase 9 survey and
-- closed here. Both knockout doors - fn_eliminate_tournament_player_atomic
-- (a plain event) and fn_claim_tournament_bounty_elimination (a bounty
-- event) - resolve a player's older pending knockout generation as "bought
-- back" only when a posted chip_ledger 'rebuy' leg moved that player's own
-- wallet into the event's prize liability after the generation was captured
-- and before the next one was. A Diamond rebuy or re-entry writes no chip
-- leg; it writes a 'rebuy' or 'reentry' row on poker_diamond_tournament_ledger
-- (fn_poker_diamond_tournament_charge, through the same purchase core). So in
-- a Diamond rebuy event a player who busted, bought back and busted again
-- would have carried an unproven older generation for ever, and every later
-- real bust of theirs would have been refused with an alert for a ruling.
--
-- Each door learns the Diamond proof in place: the same window, the same
-- player, the same event, a Diamond ledger row of kind rebuy or re-entry with
-- a positive amount. Everything else in both doors is byte for byte what it
-- was: the live md5 is pinned, each clause occurs exactly once, and the
-- reverse substitution is proved. tournaments_enabled stays false. Applied
-- once to kuklfnapbkmacvwxktbh.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_eliminate_tournament_player_atomic(uuid, uuid, integer, numeric, numeric)  fa7affc52441a40dfc8f1a530f39d9e4
--   fn_claim_tournament_bounty_elimination                                        031511013eac6b76d12efe899b8d90d3
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE PLAIN KNOCKOUT DOOR
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := 'public.fn_eliminate_tournament_player_atomic(uuid, uuid, integer, numeric, numeric)'::regprocedure;
  v_def text; v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_n integer; v_back text;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'fa7affc52441a40dfc8f1a530f39d9e4' THEN
    RAISE EXCEPTION 'fn_eliminate_tournament_player_atomic is not the pinned text (md5 %)', md5(v_def);
  END IF;
  -- the head of the chip proof
  v_old1 := E'     AND EXISTS (\n'
         || E'       SELECT 1 FROM public.chip_ledger l\n'
         || E'        WHERE l.from_entity_id=p_user_id\n';
  v_new1 := E'     AND (\n'
         || E'       -- DIAMOND PHASE 8: a Diamond rebuy or re-entry is a Diamond ledger\n'
         || E'       -- row, not a chip leg; it proves the generation the same way.\n'
         || E'       EXISTS (\n'
         || E'       SELECT 1 FROM public.poker_diamond_tournament_ledger d\n'
         || E'        WHERE d.user_id=p_user_id\n'
         || E'          AND d.tournament_id=p_tournament_id\n'
         || E'          AND d.kind IN (''rebuy'',''reentry'')\n'
         || E'          AND d.amount>0\n'
         || E'          AND d.created_at>c.created_at\n'
         || E'          AND d.created_at<(\n'
         || E'            SELECT n.created_at\n'
         || E'              FROM public.tournament_knockout_candidates n\n'
         || E'             WHERE n.tournament_id=p_tournament_id\n'
         || E'               AND n.eliminated_user_id=p_user_id\n'
         || E'               AND n.hand_number>c.hand_number\n'
         || E'             ORDER BY n.hand_number,n.id\n'
         || E'             LIMIT 1))\n'
         || E'       OR EXISTS (\n'
         || E'       SELECT 1 FROM public.chip_ledger l\n'
         || E'        WHERE l.from_entity_id=p_user_id\n';
  -- the tail of the chip proof, which now also closes the OR
  v_old2 := E'             ORDER BY n.hand_number,n.id\n'
         || E'             LIMIT 1));';
  v_new2 := E'             ORDER BY n.hand_number,n.id\n'
         || E'             LIMIT 1)));';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'plain door: the proof head occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'plain door: the proof tail occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  v_back := replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2);
  IF md5(v_back) <> 'fa7affc52441a40dfc8f1a530f39d9e4' THEN
    RAISE EXCEPTION 'plain door: the reverse substitution does not reproduce the pinned text';
  END IF;
END
$m$;

-- ---------------------------------------------------------------------------
-- 2. THE BOUNTY KNOCKOUT DOOR
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_n integer; v_back text;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_claim_tournament_bounty_elimination';
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_claim_tournament_bounty_elimination') <> 1 THEN
    RAISE EXCEPTION 'fn_claim_tournament_bounty_elimination is not one function';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '031511013eac6b76d12efe899b8d90d3' THEN
    RAISE EXCEPTION 'fn_claim_tournament_bounty_elimination is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'     AND EXISTS (\n'
         || E'       SELECT 1 FROM public.chip_ledger l\n'
         || E'        WHERE l.from_entity_id=p_eliminated_user_id\n';
  v_new1 := E'     AND (\n'
         || E'       -- DIAMOND PHASE 8: a Diamond rebuy or re-entry is a Diamond ledger\n'
         || E'       -- row, not a chip leg; it proves the generation the same way.\n'
         || E'       EXISTS (\n'
         || E'       SELECT 1 FROM public.poker_diamond_tournament_ledger d\n'
         || E'        WHERE d.user_id=p_eliminated_user_id\n'
         || E'          AND d.tournament_id=p_tournament_id\n'
         || E'          AND d.kind IN (''rebuy'',''reentry'')\n'
         || E'          AND d.amount>0\n'
         || E'          AND d.created_at>c.created_at\n'
         || E'          AND d.created_at<(\n'
         || E'            SELECT n.created_at\n'
         || E'              FROM public.tournament_knockout_candidates n\n'
         || E'             WHERE n.tournament_id=p_tournament_id\n'
         || E'               AND n.eliminated_user_id=p_eliminated_user_id\n'
         || E'               AND n.hand_number>c.hand_number\n'
         || E'             ORDER BY n.hand_number,n.id\n'
         || E'             LIMIT 1))\n'
         || E'       OR EXISTS (\n'
         || E'       SELECT 1 FROM public.chip_ledger l\n'
         || E'        WHERE l.from_entity_id=p_eliminated_user_id\n';
  v_old2 := E'             LIMIT 1))\n'
         || E'     AND EXISTS (\n'
         || E'       SELECT 1 FROM public.tournament_bounty_obligations o\n'
         || E'        WHERE o.tournament_id=p_tournament_id\n'
         || E'          AND o.eliminated_user_id=p_eliminated_user_id\n'
         || E'          AND o.table_id=c.table_id';
  v_new2 := E'             LIMIT 1)))\n'
         || E'     AND EXISTS (\n'
         || E'       SELECT 1 FROM public.tournament_bounty_obligations o\n'
         || E'        WHERE o.tournament_id=p_tournament_id\n'
         || E'          AND o.eliminated_user_id=p_eliminated_user_id\n'
         || E'          AND o.table_id=c.table_id';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'bounty door: the proof head occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'bounty door: the proof tail occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  v_back := replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2);
  IF md5(v_back) <> '031511013eac6b76d12efe899b8d90d3' THEN
    RAISE EXCEPTION 'bounty door: the reverse substitution does not reproduce the pinned text';
  END IF;
END
$m$;

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text;
BEGIN
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace
              AND p.proname IN ('fn_eliminate_tournament_player_atomic','fn_claim_tournament_bounty_elimination')
  LOOP
    IF position('FROM public.poker_diamond_tournament_ledger d' IN r.def) = 0
       OR position('d.kind IN (''rebuy'',''reentry'')' IN r.def) = 0 THEN
      RAISE EXCEPTION '% does not read a Diamond rebuy', r.proname;
    END IF;
    IF position('FROM public.chip_ledger l' IN r.def) = 0 THEN
      RAISE EXCEPTION '% lost the chip proof', r.proname;
    END IF;
    -- the proof is still a single predicate on the same candidate window
    IF (length(r.def) - length(replace(r.def, 'AND n.hand_number>c.hand_number', ''))) / length('AND n.hand_number>c.hand_number') <> 2 THEN
      RAISE EXCEPTION '% does not name the same window for both proofs', r.proname;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a Diamond rebuy proves its generation: both knockout doors read the Diamond ledger, the chip proof stays, nothing opened';
END
$m$;
