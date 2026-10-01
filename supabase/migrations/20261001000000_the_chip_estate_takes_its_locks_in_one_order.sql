-- ============================================================================
-- THE CHIP ESTATE TAKES ITS LOCKS IN ONE ORDER
-- ============================================================================
--
-- Production counted 3,605 deadlocks in the 24 hours to 2026-09-30 23:16 UTC
-- (one "detected deadlock while waiting" line per deadlock in the Postgres log,
-- log_lock_waits on, caught ones included; pg_stat_database agrees). Ranked by
-- the rows the victim was waiting for when it was chosen:
--
--   1,111  commission rollups   the cash accrual batch
--          (agent_commission_unsettled_rollup,   (fn_credit_agent_commissions_batch)
--          ca_club_commission_daily)           against a tournament finish
--   961    player_stats         the cash accrual batch against the hand's stats
--                               projection and its promo playthrough (PR #5542's
--                               pair - not changed here, see below)
--   837    vip_points_carry,    a tournament finish against a raked hand's
--          club_wallets,        post-commit obligations (atomic_distribute_rake)
--          ca_club_rake_daily
--   346    profiles             a finish (and the batch) against the horse claims,
--                               through the player_stats trigger
--   271    horse_mind_*         two horse-mind flushes against each other
--   79     everything else      (clubs at launch, club_members at seat, bbj)
--
-- Evidence, commands and the isolated reproductions: docs/evidence/
-- chip-deadlocks-2026-10-01.md and scripts/qualification/chip-deadlocks.py.
--
-- THE ONE ORDER. Every chip door takes, from the outside in:
--   1. lanes and scopes (advisory): the settlement lanes, the table and hand
--      keys, the accounting week keys (shared, in key order), and the club's
--      commission key 'agent-commission:<club>' in club order before any
--      commission rollup row of that club;
--   2. the tournament row and its evidence;
--   3. the banks: club_wallets, then union_wallets, then clubs (the order
--      fn_complete_tournament_terminal_pre_seat_guard already declares);
--   4. the club-day rollups, under their club's bank or commission key;
--   5. the player rows in player order (vip_points_carry, player_stats,
--      profiles), and the horse-mind rows in key order.
--
-- WHAT CHANGES (asserted substitutions over the pinned live text, one each):
--   atomic_distribute_rake             locks the club wallet before the rake
--                                      record, whose triggers take the players'
--                                      VIP carry and the club's day rake rows
--                                      (was: after them).
--   trg_agent_commission_rollup_insert takes the club's commission key, in club
--                                      order, before its agent and day rows.
--   fn_credit_agent_commissions_batch  take every club's commission key before
--   fn_retry_cash_accounting_sources   their first item, in club order.
--   fn_sync_profile_total_hands        does not rewrite a profile when the
--                                      player_stats UPDATE left hands_played
--                                      where it was.
--   upsert_horse_mind_pairs, _stats,   take their rows in key order (repeats of
--   _stats_scoped                      one key keep their input order).
--
-- Nothing else: no amount, no receipt, no refusal and no grant changes. The
-- new keys are advisory and transaction-scoped. The pins below are the live
-- definitions read on 2026-09-30; the after-md5 of each is the text
-- scripts/qualification/chip-deadlocks.py measured, by executing this file's
-- substitution block against the same bodies on its own cluster.
--
-- NOT CHANGED HERE: the player_stats pair. PR #5542 (open, draft, its owner
-- inactive since 2026-09-28 20:06 UTC) orders Projection 2 of
-- fn_project_hand_side_effects_after_post_commit_20260908. It cannot land as
-- written - it redefines the function with its 2026-09-28 body and would drop
-- Projection 4b (20260930043000) - and its clause removes only the inversion
-- inside one hand: the cash accrual batch is one transaction over many hands,
-- so it keeps rows from earlier hands while taking later ones, and the
-- reproduction deadlocks with that clause in place. Reported, not guessed.
--
-- lock_timeout 2s, statement_timeout 60s; one transaction.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-09-30, and AFTER:
--   atomic_distribute_rake             0ef820b10c57d902b5ab2d5f9e2be8a6 -> ea7a4a403969a0fbe69f2216d63a0436
--   trg_agent_commission_rollup_insert 50cb43eb54b7924b39c25b9816f450a0 -> c7e84377219a39d955783d0feae6642b
--   fn_credit_agent_commissions_batch  3b9313fc37e62ca2c0b0bbbc7fdc6dc0 -> 5ebf5489eabbe478d393e2e040683fe8
--   fn_retry_cash_accounting_sources   cf43f5cc8e7d47994025cc7682cc18bc -> 4b62b13c70191e56fe55644070303a97
--   fn_sync_profile_total_hands        918a9211cf484127ab5d326aea1e47b3 -> f6ee538e4bcfc329dd0e46673b05dc30
--   upsert_horse_mind_pairs            c73cb456bd033f8d3f5a03e53b9934b0 -> 389109138a65a4d150b48da5ffa209bb
--   upsert_horse_mind_stats            84df6d650c905cedba86f2698f1fbd3d -> 6802f13c3b1e7b94e62694d1dc1e5fb1
--   upsert_horse_mind_stats_scoped     73884faf30f48913dba34053fdd33337 -> 199192476497889e659b8455c38ea631
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = 'ea7a4a403969a0fbe69f2216d63a0436' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = 'c7e84377219a39d955783d0feae6642b' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'trg_agent_commission_rollup_insert')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '5ebf5489eabbe478d393e2e040683fe8' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_credit_agent_commissions_batch')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '4b62b13c70191e56fe55644070303a97' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_retry_cash_accounting_sources')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = 'f6ee538e4bcfc329dd0e46673b05dc30' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_sync_profile_total_hands')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '389109138a65a4d150b48da5ffa209bb' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'upsert_horse_mind_pairs')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '6802f13c3b1e7b94e62694d1dc1e5fb1' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'upsert_horse_mind_stats')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '199192476497889e659b8455c38ea631' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'upsert_horse_mind_stats_scoped')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- THE SUBSTITUTIONS
-- ---------------------------------------------------------------------------
DO $subs$
DECLARE
  s record; v_def text; v_after text; v_n integer; v_acl text; v_owner text; v_secdef boolean;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)', '0ef820b10c57d902b5ab2d5f9e2be8a6', 'ea7a4a403969a0fbe69f2216d63a0436',
      E'  PERFORM public.fn_lock_cash_bank_accounting_week(p_club_id,v_union_id,transaction_timestamp());\n'
      || E'\n'
      || E'  INSERT INTO public.rake_records (\n',
      E'  PERFORM public.fn_lock_cash_bank_accounting_week(p_club_id,v_union_id,transaction_timestamp());\n'
      || E'\n'
      || E'  /* THE CLUB WALLET BEFORE THE RAKE RECORD (2026-10-01). The rake record''s\n'
      || E'     insert triggers take the hand''s players'' VIP carry rows and the club''s\n'
      || E'     daily rake row, and the wallet UPDATE below came after them. A tournament\n'
      || E'     finish takes this same club_wallets row first (tournament, club_wallets,\n'
      || E'     union_wallets, clubs - fn_complete_tournament_terminal_pre_seat_guard)\n'
      || E'     and credits its players'' VIP carry rows last, so a finish and a raked\n'
      || E'     hand of one club took the same rows in opposite orders and deadlocked\n'
      || E'     (vip_points_carry, club_wallets, ca_club_rake_daily). Taken bare, here,\n'
      || E'     the wallet comes first as it does for the finish; the UPDATE below\n'
      || E'     re-takes a lock this transaction already holds. Only the order changes. */\n'
      || E'  PERFORM 1 FROM public.club_wallets WHERE club_id = p_club_id FOR NO KEY UPDATE;\n'
      || E'\n'
      || E'  INSERT INTO public.rake_records (\n'),
    ('trg_agent_commission_rollup_insert()', '50cb43eb54b7924b39c25b9816f450a0', 'c7e84377219a39d955783d0feae6642b',
      E'AS $function$\n'
      || E'BEGIN\n'
      || E'  INSERT INTO public.agent_commission_unsettled_rollup AS r\n',
      E'AS $function$\n'
      || E'DECLARE v_club uuid;\n'
      || E'BEGIN\n'
      || E'  /* ONE KEY PER CLUB, IN CLUB ORDER, BEFORE ITS ROLLUP ROWS (2026-10-01).\n'
      || E'     Each commission row takes its agent''s unsettled row and then the club''s\n'
      || E'     day row, so a writer with two tiers held the day row while it asked for\n'
      || E'     its second agent''s row - which a tournament finish, holding that agent''s\n'
      || E'     row, was waiting to pass on its way to the day row. The club''s\n'
      || E'     commission key comes first, in club order: the cash accrual batch takes\n'
      || E'     every key it will need before its first item (fn_credit_agent_commissions_batch,\n'
      || E'     fn_retry_cash_accounting_sources), a finish takes them here source by\n'
      || E'     source in club order, and within one club only its holder writes these\n'
      || E'     rows. The sums below are unchanged. */\n'
      || E'  FOR v_club IN SELECT DISTINCT n.club_id FROM new_rows n WHERE n.club_id IS NOT NULL ORDER BY n.club_id LOOP\n'
      || E'    PERFORM pg_advisory_xact_lock(hashtextextended(''agent-commission:''||v_club::text,0));\n'
      || E'  END LOOP;\n'
      || E'\n'
      || E'  INSERT INTO public.agent_commission_unsettled_rollup AS r\n'),
    ('fn_credit_agent_commissions_batch(jsonb)', '3b9313fc37e62ca2c0b0bbbc7fdc6dc0', '5ebf5489eabbe478d393e2e040683fe8',
      E'DECLARE it jsonb;r jsonb;receipts jsonb:=''[]'';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;\n'
      || E'BEGIN\n'
      || E' IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION ''cash_source_not_authorised'' USING ERRCODE=''42501''; END IF;\n'
      || E' IF p_items IS NULL OR jsonb_typeof(p_items)<>''array'' OR jsonb_array_length(p_items)>2000 THEN\n'
      || E'  RETURN jsonb_build_object(''ok'',0,''failed'',0,''error'',''p_items must be a jsonb array of at most 2000 items''); END IF;\n'
      || E' FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP\n',
      E'DECLARE it jsonb;r jsonb;receipts jsonb:=''[]'';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;v_gate uuid;\n'
      || E'BEGIN\n'
      || E' IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION ''cash_source_not_authorised'' USING ERRCODE=''42501''; END IF;\n'
      || E' IF p_items IS NULL OR jsonb_typeof(p_items)<>''array'' OR jsonb_array_length(p_items)>2000 THEN\n'
      || E'  RETURN jsonb_build_object(''ok'',0,''failed'',0,''error'',''p_items must be a jsonb array of at most 2000 items''); END IF;\n'
      || E' -- EVERY CLUB''S COMMISSION KEY FIRST, IN CLUB ORDER (2026-10-01). This batch is\n'
      || E' -- one transaction over many hands: it keeps each item''s rows until it ends,\n'
      || E' -- so it cannot take the clubs'' commission keys item by item without taking\n'
      || E' -- them out of order. It takes them all here, before its first item and in\n'
      || E' -- club order, for the clubs its cash items earn in (the attributions the\n'
      || E' -- accrual plan reads); trg_agent_commission_rollup_insert takes them in club\n'
      || E' -- order for every other writer. An item the set misses still takes its key\n'
      || E' -- in the trigger. Nothing is written here and no item is refused here.\n'
      || E' FOR v_gate IN SELECT DISTINCT a.club_id FROM public.rake_attributions a\n'
      || E'   WHERE a.rake_record_id = ANY (ARRAY(SELECT (x.value->>''source_id'')::uuid FROM jsonb_array_elements(p_items) x\n'
      || E'     WHERE x.value->>''source_type''=''cash_rake_record''\n'
      || E'       AND x.value->>''source_id'' ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''))\n'
      || E'     AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP\n'
      || E'  PERFORM pg_advisory_xact_lock(hashtextextended(''agent-commission:''||v_gate::text,0));\n'
      || E' END LOOP;\n'
      || E' FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP\n'),
    ('fn_retry_cash_accounting_sources(integer)', 'cf43f5cc8e7d47994025cc7682cc18bc', '4b62b13c70191e56fe55644070303a97',
      E'DECLARE w record;r jsonb;receipts jsonb:=''[]'';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;v_parked bigint:=0;\n'
      || E'BEGIN\n'
      || E' IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION ''cash_source_not_authorised'' USING ERRCODE=''42501''; END IF;\n'
      || E' IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION ''invalid_cash_retry_limit'' USING ERRCODE=''22023''; END IF;\n',
      E'DECLARE w record;r jsonb;receipts jsonb:=''[]'';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;v_parked bigint:=0;v_gate uuid;\n'
      || E'BEGIN\n'
      || E' IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION ''cash_source_not_authorised'' USING ERRCODE=''42501''; END IF;\n'
      || E' IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION ''invalid_cash_retry_limit'' USING ERRCODE=''22023''; END IF;\n'
      || E' -- EVERY CLUB''S COMMISSION KEY FIRST, IN CLUB ORDER (2026-10-01), as\n'
      || E' -- fn_credit_agent_commissions_batch takes them: this retry is one transaction\n'
      || E' -- over many sources too. Read from the rows the loop below selects; a source\n'
      || E' -- that becomes due in between still takes its key in the trigger.\n'
      || E' FOR v_gate IN SELECT DISTINCT a.club_id FROM public.rake_attributions a\n'
      || E'   WHERE a.rake_record_id = ANY (ARRAY(SELECT s.rake_record_id FROM public.accounting_cash_source_work s\n'
      || E'     WHERE s.status=''blocked'' AND s.next_attempt_at<=clock_timestamp()\n'
      || E'     ORDER BY s.next_attempt_at,s.rake_record_id LIMIT p_limit))\n'
      || E'     AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP\n'
      || E'  PERFORM pg_advisory_xact_lock(hashtextextended(''agent-commission:''||v_gate::text,0));\n'
      || E' END LOOP;\n'),
    ('fn_sync_profile_total_hands()', '918a9211cf484127ab5d326aea1e47b3', 'f6ee538e4bcfc329dd0e46673b05dc30',
      E'  IF v_user IS NULL THEN\n'
      || E'    RETURN COALESCE(NEW, OLD);\n'
      || E'  END IF;\n',
      E'  IF v_user IS NULL THEN\n'
      || E'    RETURN COALESCE(NEW, OLD);\n'
      || E'  END IF;\n'
      || E'\n'
      || E'  /* A WRITE THAT LEAVES hands_played WHERE IT WAS DOES NOT TOUCH THE PROFILE\n'
      || E'     (2026-10-01). The trigger fires for every UPDATE that names the column,\n'
      || E'     and a tournament''s rake recognition names it with +0 for every entrant\n'
      || E'     (apply_rakeback_player_stats(..., 0, ...)): the sum below cannot move,\n'
      || E'     but its UPDATE locked each entrant''s profile row, in club order, while\n'
      || E'     the horse claims hold profile rows in claim order - and the two\n'
      || E'     deadlocked. The same player and the same count leave the same sum. */\n'
      || E'  IF TG_OP = ''UPDATE'' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id\n'
      || E'     AND NEW.hands_played IS NOT DISTINCT FROM OLD.hands_played THEN\n'
      || E'    RETURN NEW;\n'
      || E'  END IF;\n'),
    ('upsert_horse_mind_pairs(jsonb)', 'c73cb456bd033f8d3f5a03e53b9934b0', '389109138a65a4d150b48da5ffa209bb',
      E'  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP\n',
      E'  -- KEY ORDER, INPUT ORDER WITHIN A KEY (2026-10-01). Concurrent flushes upserted\n'
      || E'  -- overlapping keys in the order each caller listed them and deadlocked on this\n'
      || E'  -- table. Every caller now takes the rows in key order; repeats of one key keep\n'
      || E'  -- their input order, so the value each column ends with is unchanged.\n'
      || E'  FOR r IN SELECT e.value FROM jsonb_array_elements(rows) WITH ORDINALITY AS e(value, ord)\n'
      || E'            ORDER BY e.value->>''attacker_id'', e.value->>''victim_id'', e.ord LOOP\n'),
    ('upsert_horse_mind_stats(jsonb)', '84df6d650c905cedba86f2698f1fbd3d', '6802f13c3b1e7b94e62694d1dc1e5fb1',
      E'  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP\n',
      E'  -- KEY ORDER, INPUT ORDER WITHIN A KEY (2026-10-01). Concurrent flushes upserted\n'
      || E'  -- overlapping keys in the order each caller listed them and deadlocked on this\n'
      || E'  -- table. Every caller now takes the rows in key order; repeats of one key keep\n'
      || E'  -- their input order, so the value each column ends with is unchanged.\n'
      || E'  FOR r IN SELECT e.value FROM jsonb_array_elements(rows) WITH ORDINALITY AS e(value, ord)\n'
      || E'            ORDER BY e.value->>''user_id'', e.ord LOOP\n'),
    ('upsert_horse_mind_stats_scoped(jsonb)', '73884faf30f48913dba34053fdd33337', '199192476497889e659b8455c38ea631',
      E'  for r in select * from jsonb_array_elements(rows) loop\n',
      E'  -- KEY ORDER, INPUT ORDER WITHIN A KEY (2026-10-01). Concurrent flushes upserted\n'
      || E'  -- overlapping keys in the order each caller listed them and deadlocked on this\n'
      || E'  -- table. Every caller now takes the rows in key order; repeats of one key keep\n'
      || E'  -- their input order, so the value each column ends with is unchanged.\n'
      || E'  for r in select e.value from jsonb_array_elements(rows) with ordinality as e(value, ord)\n'
      || E'            order by e.value->>''user_id'', e.value->>''scope'', e.ord loop\n')
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
      RAISE EXCEPTION '% is not the text the harness measured (md5 %)', s.signature, md5(v_after);
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
END $subs$;

-- ---------------------------------------------------------------------------
-- THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_sig text; v_txt text; v_bad text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)',
    'trg_agent_commission_rollup_insert()',
    'fn_credit_agent_commissions_batch(jsonb)',
    'fn_retry_cash_accounting_sources(integer)',
    'fn_sync_profile_total_hands()',
    'upsert_horse_mind_pairs(jsonb)',
    'upsert_horse_mind_stats(jsonb)',
    'upsert_horse_mind_stats_scoped(jsonb)'
  ] LOOP
    IF has_function_privilege('anon', 'public.' || v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.' || v_sig, 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.' || v_sig, 'EXECUTE')
       OR (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = ('public.' || v_sig)::regprocedure) <> '{postgres=X/postgres,service_role=X/postgres}' THEN
      RAISE EXCEPTION '% is reachable by a client, or no longer by the engine', v_sig;
    END IF;
  END LOOP;
  v_txt := pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure);
  IF position('PERFORM 1 FROM public.club_wallets WHERE club_id = p_club_id FOR NO KEY UPDATE;' IN v_txt) = 0
     OR position('PERFORM 1 FROM public.club_wallets WHERE club_id = p_club_id FOR NO KEY UPDATE;' IN v_txt)
        > position('INSERT INTO public.rake_records (' IN v_txt) THEN
    RAISE EXCEPTION 'the raked hand does not take the club wallet before the rake record';
  END IF;
  v_txt := pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure);
  IF position('''agent-commission:''' IN v_txt) = 0
     OR position('''agent-commission:''' IN v_txt) > position('INSERT INTO public.agent_commission_unsettled_rollup' IN v_txt) THEN
    RAISE EXCEPTION 'the commission rollup does not take the club key before its rows';
  END IF;
  v_txt := pg_get_functiondef('public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure);
  IF position('''agent-commission:''' IN v_txt) = 0
     OR position('''agent-commission:''' IN v_txt) > position('FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP' IN v_txt) THEN
    RAISE EXCEPTION 'the cash accrual batch does not take its club keys before its first item';
  END IF;
  v_txt := pg_get_functiondef('public.fn_retry_cash_accounting_sources(integer)'::regprocedure);
  IF position('''agent-commission:''' IN v_txt) = 0
     OR position('''agent-commission:''' IN v_txt) > position('FOR w IN SELECT rake_record_id' IN v_txt) THEN
    RAISE EXCEPTION 'the cash retry does not take its club keys before its first source';
  END IF;
  v_txt := pg_get_functiondef('public.fn_sync_profile_total_hands()'::regprocedure);
  IF position('NEW.hands_played IS NOT DISTINCT FROM OLD.hands_played' IN v_txt) = 0
     OR position('NEW.hands_played IS NOT DISTINCT FROM OLD.hands_played' IN v_txt) > position('UPDATE public.profiles p' IN v_txt) THEN
    RAISE EXCEPTION 'the profile total is still rewritten by a write that left hands_played alone';
  END IF;
  IF NOT COALESCE((public.fn_ca_settlement_lane_doctrine()->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'the settlement lane doctrine no longer holds: %', public.fn_ca_settlement_lane_doctrine()->'violations';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
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
  RAISE NOTICE 'the chip estate takes its locks in one order: eight bodies re-ordered, nothing else changed, nothing opened';
END $m$;

COMMIT;
