-- ============================================================================
-- THE CHIP LEGS REFUSE A DIAMOND ROW
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme, line "Remove every inherited
-- union/agent distribution and chip treasury dependency": the part of it that
-- needs no decision (docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md, section 4,
-- step 0). Dan's ruling 16 already says it: "No unions, agents, commissions,
-- chip wallets, chip ledgers or chip conversion" in the Diamond Arena. Every
-- piece below either stops a chip reader from counting a Diamond or makes a
-- chip writer refuse (or skip) a Diamond Arena row by name. Nothing is priced,
-- nothing is routed, no switch is opened.
--
--   1. The chip supply meter (fn_ca_supply_snapshot, a watched guard) no
--      longer reads a Diamond seat, a Diamond pending add-on or a Diamond
--      event's pools as chips. Unfenced, the first busy hour of Diamond play
--      would have read as unexplained chip supply and paged as a chip leak.
--   2. The two chip guarantee triggers refuse a Diamond event by name instead
--      of reading the Diamond Arena's chip treasury.
--   3. The Diamond creation door refuses by name the money keys the estate's
--      builder sends and the door never reads (guaranteedPrize, isRebuy,
--      isReentry, addOnAvailable, addOnCost, addOnFromStart). Its own keys
--      (guarantee, rebuy, reentry, addOn, addonCost) are unchanged.
--   4. The accepted-hand door stops refusing every Diamond cash hand that is
--      not hold'em: it admits the games the arena deals, by the same rule the
--      settler and the admission door already use (fn_poker_diamond_cash_variant).
--   5. Found by this migration's rehearsal: NO Diamond cash hand, hold'em
--      included, could commit. The chip provenance receipt added on 2026-09-17
--      (fn_cash_accept_hand_provenance) demands a chip settlement claim the
--      Diamond settler never writes, so the core rolled every Diamond hand
--      back ("query returned no rows"). A Diamond hand now writes no chip
--      provenance receipt and no union P&L cash outcome (the deferred capture
--      would have filed it as a blocked chip outcome with asset 'chips'); it
--      is receipted by its own settler (poker_diamond_hand_receipts).
--
-- The other half of step 0, the chip money tables refusing a Diamond Arena
-- row, is 20260929160100_the_chip_money_tables_refuse_a_diamond_row. It is a
-- migration of its own because its triggers lock the hottest money tables
-- (chip_ledger, rake_records and eight more) until their transaction ends:
-- rehearsed together with the hands, the meter and the cash-out below, that
-- lock was held for the whole fixture and stalled production. Apart, each
-- rehearsal holds it for a fraction of a second.
--
-- Every chip function changes by asserted substitution: the live md5 pinned,
-- each old clause present exactly once, the reverse substitution proved to
-- reproduce the pinned text. The Diamond creation door is shared with two
-- other Phase 9 pieces this round, so it changes the same way, by one small
-- insertion after its configuration check.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_ca_supply_snapshot                   261db1022bd41955c49ea8248390ae92  (watched)
--   trg_tournaments_guarantee_affordable    91f977eaec85de7f6b478d37184e9732
--   fn_ca_fund_overlay_on_lock              93f3e46a957abb7a42d4a2cfaff42fcb
--   fn_poker_diamond_create_tournament      55c2176b75c5bb1499960f7bb846d3aa  (as the satellites piece left it)
--   fn_ca_commit_hand_settlement            c5f1e51d639f29e6650ae4560af5fb24
--   fn_cash_accept_hand_provenance          9e276af576abbcc871e78746c4210fee
--   fn_union_pnl_capture_accepted_cash      3c1f76f12a6ba30888a1c295a90ddf60
--   fn_poker_diamond_cash_variant           929c207a922004eb0e764011a2fe386c  (read, not changed)
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is already on somewhere; this migration expects both closed';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE CHIP SUPPLY METER COUNTS NO DIAMOND
-- ---------------------------------------------------------------------------
-- felt, pending_addons and tourn_liab exclude a table or event whose club's
-- asset is 'diamonds'. No Diamond seat, add-on or event has ever existed, so
-- every figure the meter has taken is unchanged and its basis stays
-- 'pending-addon-v4': the next hourly reading compares like with like.
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_old3 text; v_new3 text;
BEGIN
  v_oid := to_regprocedure('public.fn_ca_supply_snapshot()');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '261db1022bd41955c49ea8248390ae92' THEN
    RAISE EXCEPTION 'fn_ca_supply_snapshot is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'                           AND t.tournament_id IS NOT NULL))            AS felt,';
  v_new1 := E'                           AND (t.tournament_id IS NOT NULL\n'
         || E'                                /* DIAMOND PHASE 9, STEP 0 (2026-09-29): a Diamond seat holds\n'
         || E'                                   Diamonds that no chip_ledger row moves. Counted here they read\n'
         || E'                                   as unexplained chip supply and page as a chip leak. */\n'
         || E'                                OR EXISTS (SELECT 1 FROM public.clubs c\n'
         || E'                                            WHERE c.id = t.club_id AND c.asset = ''diamonds''))))            AS felt,';
  v_old2 := E'                           AND t.tournament_id IS NOT NULL))            AS pending_addons,';
  v_new2 := E'                           AND (t.tournament_id IS NOT NULL\n'
         || E'                                /* DIAMOND PHASE 9, STEP 0: scoped exactly like felt. */\n'
         || E'                                OR EXISTS (SELECT 1 FROM public.clubs c\n'
         || E'                                            WHERE c.id = t.club_id AND c.asset = ''diamonds''))))            AS pending_addons,';
  v_old3 := E'      WHERE (e.tournament_id IS NOT NULL\n'
         || E'             AND COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)\n'
         || E'                 + COALESCE(e.fee_balance,0) <> 0)\n'
         || E'         OR (e.tournament_id IS NULL\n'
         || E'             AND t.status NOT IN (''COMPLETED'',''CANCELLED'')))            AS tourn_liab,';
  v_new3 := E'      WHERE ((e.tournament_id IS NOT NULL\n'
         || E'             AND COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)\n'
         || E'                 + COALESCE(e.fee_balance,0) <> 0)\n'
         || E'         OR (e.tournament_id IS NULL\n'
         || E'             AND t.status NOT IN (''COMPLETED'',''CANCELLED'')))\n'
         || E'        /* DIAMOND PHASE 9, STEP 0: a Diamond event''s pools and its escrow\n'
         || E'           shadow are Diamonds in custody, not a chip liability. */\n'
         || E'        AND NOT EXISTS (SELECT 1 FROM public.clubs c\n'
         || E'                         WHERE c.id = t.club_id AND c.asset = ''diamonds''))            AS tourn_liab,';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'meter: the felt clause occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'meter: the pending add-on clause occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'meter: the tournament liability clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  IF md5(replace(replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3))
     <> '261db1022bd41955c49ea8248390ae92' THEN
    RAISE EXCEPTION 'meter: the reverse substitution does not reproduce the pinned text';
  END IF;
  PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_supply_snapshot', 'migration the_chip_legs_refuse_a_diamond_row');
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE CHIP GUARANTEE TRIGGERS REFUSE A DIAMOND EVENT BY NAME
-- ---------------------------------------------------------------------------
-- The creation door refuses a Diamond guarantee first today; these are the
-- backstop the guarantee migration (design section 3.3) needs in place.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := to_regprocedure('public.trg_tournaments_guarantee_affordable()');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '91f977eaec85de7f6b478d37184e9732' THEN
    RAISE EXCEPTION 'trg_tournaments_guarantee_affordable is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'  if coalesce(new.guaranteed_prize, 0) <= 0 or new.club_id is null then\n'
        || E'    return new;\n'
        || E'  end if;\n';
  v_new := v_old
        || E'\n'
        || E'  -- DIAMOND PHASE 9, STEP 0 (2026-09-29): a Diamond event has no chip bank. Reading\n'
        || E'  -- the Diamond Arena''s chip treasury would refuse it in chips or file a chip alert;\n'
        || E'  -- its guarantee waits for a Diamond destination.\n'
        || E'  if exists (select 1 from public.clubs c where c.id = new.club_id and c.asset = ''diamonds'') then\n'
        || E'    raise exception ''diamond_guarantee_has_no_chip_bank'' using errcode = ''55000'';\n'
        || E'  end if;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'guarantee check: the early return occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '91f977eaec85de7f6b478d37184e9732' THEN
    RAISE EXCEPTION 'guarantee check: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := to_regprocedure('public.fn_ca_fund_overlay_on_lock()');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '93f3e46a957abb7a42d4a2cfaff42fcb' THEN
    RAISE EXCEPTION 'fn_ca_fund_overlay_on_lock is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'  v_short := GREATEST(0, v_guarantee - v_pool_before);\n'
        || E'  IF v_short <= 0 THEN RETURN NEW; END IF;\n';
  v_new := v_old
        || E'\n'
        || E'  /* DIAMOND PHASE 9, STEP 0 (2026-09-29): a Diamond event is never topped up from a\n'
        || E'     chip bank. A shortfall (a guarantee, or a satellite''s guaranteed seats) waits for a\n'
        || E'     Diamond destination; until one exists the start is refused by name rather than\n'
        || E'     funded from the Diamond Arena''s chip treasury or started without its overlay. */\n'
        || E'  IF EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = NEW.club_id AND c.asset = ''diamonds'') THEN\n'
        || E'    RAISE EXCEPTION ''diamond_overlay_has_no_chip_bank'' USING ERRCODE = ''55000'';\n'
        || E'  END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'overlay: the shortfall clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '93f3e46a957abb7a42d4a2cfaff42fcb' THEN
    RAISE EXCEPTION 'overlay: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 3. THE DIAMOND CREATION DOOR REFUSES THE MONEY KEYS IT DOES NOT READ
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := to_regprocedure('public.fn_poker_diamond_create_tournament(jsonb)');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '55c2176b75c5bb1499960f7bb846d3aa' THEN
    RAISE EXCEPTION 'fn_poker_diamond_create_tournament is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'  IF p_config IS NULL OR jsonb_typeof(p_config)<>''object'' THEN\n'
        || E'    RAISE EXCEPTION ''diamond_tournament_requires_a_configuration'' USING ERRCODE=''22023'';\n'
        || E'  END IF;\n';
  v_new := v_old
        || E'  -- DIAMOND PHASE 9, STEP 0 (the_chip_legs_refuse_a_diamond_row): the estate''s builder\n'
        || E'  -- (TournamentService.buildRpcConfig) sends these money keys, and this door reads\n'
        || E'  -- guarantee, rebuy, reentry, addOn and addonCost instead. A value in one of them\n'
        || E'  -- would be dropped and the event created without it, so it is refused by name.\n'
        || E'  -- The builder''s own default (0, false or null) means what the door does without\n'
        || E'  -- the key, and is admitted.\n'
        || E'  IF EXISTS (SELECT 1 FROM jsonb_each(p_config) k\n'
        || E'              WHERE k.key IN (''guaranteedPrize'',''isRebuy'',''isReentry'',''addOnAvailable'',''addOnCost'',''addOnFromStart'')\n'
        || E'                AND k.value NOT IN (''0''::jsonb, ''false''::jsonb, ''null''::jsonb)) THEN\n'
        || E'    RAISE EXCEPTION ''diamond_tournament_money_key_not_read: %'', (\n'
        || E'      SELECT string_agg(k.key, '', '' ORDER BY k.key) FROM jsonb_each(p_config) k\n'
        || E'       WHERE k.key IN (''guaranteedPrize'',''isRebuy'',''isReentry'',''addOnAvailable'',''addOnCost'',''addOnFromStart'')\n'
        || E'         AND k.value NOT IN (''0''::jsonb, ''false''::jsonb, ''null''::jsonb))\n'
        || E'      USING ERRCODE = ''22023'';\n'
        || E'  END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'creation door: the configuration check occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '55c2176b75c5bb1499960f7bb846d3aa' THEN
    RAISE EXCEPTION 'creation door: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 4. THE ACCEPTED-HAND DOOR ADMITS EVERY GAME THE ARENA DEALS
-- ---------------------------------------------------------------------------
-- The Diamond clause is reached only when the table is a Diamond cash table
-- (v_diamond); a chip hand never evaluates it.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'c5f1e51d639f29e6650ae4560af5fb24' THEN
    RAISE EXCEPTION 'fn_ca_commit_hand_settlement is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'    OR p_hand_row->>''game_variant'' IS DISTINCT FROM ''nlh''\n';
  v_new := E'    -- DIAMOND PHASE 9, STEP 0: every game the arena deals, as the settler reads it.\n'
        || E'    OR NOT public.fn_poker_diamond_cash_variant(p_hand_row->>''game_variant'')\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'hand door: the hold''em clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'c5f1e51d639f29e6650ae4560af5fb24' THEN
    RAISE EXCEPTION 'hand door: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 5. A DIAMOND HAND LEAVES NO CHIP PROVENANCE AND NO CHIP P&L OUTCOME
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := to_regprocedure('public.fn_cash_accept_hand_provenance(uuid,bigint,uuid,jsonb,numeric,numeric,numeric,text,jsonb)');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '9e276af576abbcc871e78746c4210fee' THEN
    RAISE EXCEPTION 'fn_cash_accept_hand_provenance is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E' IF v_tournament IS NOT NULL THEN RETURN; END IF;\n';
  v_new := v_old
        || E' -- DIAMOND PHASE 9, STEP 0: a Diamond hand is receipted by its own settler\n'
        || E' -- (poker_diamond_hand_receipts) and has no chip settlement claim to prove.\n'
        || E' IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id\n'
        || E'             WHERE t.id=p_table AND c.asset=''diamonds'') THEN RETURN; END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'provenance: the tournament return occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '9e276af576abbcc871e78746c4210fee' THEN
    RAISE EXCEPTION 'provenance: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := to_regprocedure('public.fn_union_pnl_capture_accepted_cash()');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '3c1f76f12a6ba30888a1c295a90ddf60' THEN
    RAISE EXCEPTION 'fn_union_pnl_capture_accepted_cash is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E' frame:=public.fn_union_pnl_original_frame();\n';
  v_new := E' -- DIAMOND PHASE 9, STEP 0: the Diamond Arena is in no union and a Diamond hand\n'
        || E' -- is not a chip cash outcome.\n'
        || E' IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id\n'
        || E'             WHERE t.id=NEW.table_id AND c.asset=''diamonds'') THEN RETURN NULL; END IF;\n'
        || v_old;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'union capture: the frame line occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '3c1f76f12a6ba30888a1c295a90ddf60' THEN
    RAISE EXCEPTION 'union capture: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 6. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text; v_txt text;
BEGIN
  v_txt := pg_get_functiondef('public.fn_ca_supply_snapshot()'::regprocedure);
  IF (length(v_txt) - length(replace(v_txt, 'WHERE c.id = t.club_id AND c.asset = ''diamonds''', '')))
       / length('WHERE c.id = t.club_id AND c.asset = ''diamonds''') <> 3
     OR position('pending-addon-v4' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the chip supply meter does not exclude the Diamond seat, add-on and event';
  END IF;
  v_txt := pg_get_functiondef('public.trg_tournaments_guarantee_affordable()'::regprocedure);
  IF position('''diamond_guarantee_has_no_chip_bank''' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the guarantee check does not refuse a Diamond event by name';
  END IF;
  v_txt := pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure);
  IF position('''diamond_overlay_has_no_chip_bank''' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the overlay does not refuse a Diamond event by name';
  END IF;
  v_txt := pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure);
  IF position('diamond_tournament_money_key_not_read' IN v_txt) = 0
     OR position('''guaranteedPrize'',''isRebuy'',''isReentry'',''addOnAvailable'',''addOnCost'',''addOnFromStart''' IN v_txt) = 0
     OR position('v_rebuy := COALESCE((p_config->>''rebuy'')::boolean,false);' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the creation door does not refuse the unread money keys as this migration states';
  END IF;
  v_txt := pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure);
  IF position('OR NOT public.fn_poker_diamond_cash_variant(p_hand_row->>''game_variant'')' IN v_txt) = 0
     OR position('IS DISTINCT FROM ''nlh''' IN v_txt) > 0 THEN
    RAISE EXCEPTION 'the hand door still refuses a Diamond game that is not hold''em';
  END IF;
  IF md5(pg_get_functiondef('public.fn_poker_diamond_cash_variant(text)'::regprocedure)) <> '929c207a922004eb0e764011a2fe386c' THEN
    RAISE EXCEPTION 'fn_poker_diamond_cash_variant is not the rule this migration admits by';
  END IF;
  v_txt := pg_get_functiondef('public.fn_cash_accept_hand_provenance(uuid,bigint,uuid,jsonb,numeric,numeric,numeric,text,jsonb)'::regprocedure);
  IF position('WHERE t.id=p_table AND c.asset=''diamonds'') THEN RETURN; END IF;' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the chip provenance receipt still demands a chip claim of a Diamond hand';
  END IF;
  v_txt := pg_get_functiondef('public.fn_union_pnl_capture_accepted_cash()'::regprocedure);
  IF position('WHERE t.id=NEW.table_id AND c.asset=''diamonds'') THEN RETURN NULL; END IF;' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the union capture still files a Diamond hand as a chip outcome';
  END IF;
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('fn_ca_supply_snapshot','trg_tournaments_guarantee_affordable','fn_ca_fund_overlay_on_lock',
                              'fn_poker_diamond_create_tournament','fn_ca_commit_hand_settlement',
                              'fn_cash_accept_hand_provenance','fn_union_pnl_capture_accepted_cash')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    -- The creation door is a staff door by design (fn_is_platform_admin inside).
    IF r.proname <> 'fn_poker_diamond_create_tournament' AND has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable from a browser', r.proname;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
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
  RAISE NOTICE 'the chip legs refuse a Diamond row: the meter counts no Diamond, the guarantee triggers and the creation door refuse by name, every game the arena deals commits and leaves no chip evidence';
END $m$;

COMMIT;
