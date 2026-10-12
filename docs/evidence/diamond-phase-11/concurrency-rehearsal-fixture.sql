-- ============================================================================
-- DIAMOND PHASE 11, LINE 2 - THE BUY-IN FIX, REHEARSED IN ONE SESSION
-- ============================================================================
-- REHEARSAL ONLY. Run by the swarm's rehearse.sh against production, once with
-- an empty migration (the "before" run) and once with
-- 20260930121500_a_diamond_cash_buy_in_reaches_the_wallet.sql (the "after"
-- run). Each run is ONE transaction that ends in a deliberate
-- RAISE EXCEPTION 'REHEARSAL OK ...', so NOTHING persists: the two sessions,
-- the admin role on the system account and the Diamond cash table the staff
-- door opens exist only inside the rolled-back transaction. No switch is
-- opened, no Diamond moves, no real person's account is used: the staff is the
-- platform's system account, the player the synthetic horse_final_56@hydra.bot
-- account the Phase 9 rehearsal also used.
--
-- What it proves in production's own catalogue, one session, no concurrency:
--   * a player's own door may move a Diamond cash table's seat count - refused
--     BEFORE the migration ("Diamond Games Require Platform Operations", the
--     generated-column misread) and admitted AFTER it;
--   * a player may still not change a Diamond table's structure, before or after;
--   * a player's JWT still cannot write a wallet outside a named money door;
--   * the identity and both switches are exactly as the run found them.
-- The concurrent, duplicate and crash cases - and the profile guard admitting
-- the real buy-in route, which needs an open cash switch - run on the isolated
-- fixture: tests/sql/run-diamond-concurrency.py.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
DO $rehearsal$
DECLARE
  v_staff CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_player CONSTANT uuid := '00000000-0000-0000-0000-000000000056';
  v_identity numeric; v_table uuid; v_msg text; v_fixed boolean; v_wallet integer;
  v_mode text;
BEGIN
  v_identity := (SELECT difference FROM public.fn_ca_diamond_register_vs_supply());
  v_fixed := position('a.attrelid = TG_RELID AND a.attgenerated' IN
                      pg_get_functiondef('public.fn_poker_guard_arena_structure()'::regprocedure)) > 0;
  v_mode := CASE WHEN v_fixed THEN 'after' ELSE 'before' END;
  SELECT diamonds INTO v_wallet FROM public.profiles WHERE id = v_player;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch is open; this rehearsal expects both closed';
  END IF;

  -- The scene, inside this transaction only.
  INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES
    (uuid_in(md5('p11-concurrency:' || v_staff::text)::cstring), v_staff, now(), now()),
    (uuid_in(md5('p11-concurrency:' || v_player::text)::cstring), v_player, now(), now());
  UPDATE public.profiles SET role = 'admin' WHERE id = v_staff;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff,
    'session_id', uuid_in(md5('p11-concurrency:' || v_staff::text)::cstring))::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_table := public.fn_poker_diamond_open_cash_table('Phase 11 concurrency rehearsal', 1, 2, 40, 200, 6, 'nlh');

  -- From here on, the player.
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_player,
    'session_id', uuid_in(md5('p11-concurrency:' || v_player::text)::cstring))::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_player::text, true);

  -- 1. The seat count a buy-in moves.
  BEGIN
    UPDATE public.tables SET current_players = 1 WHERE id = v_table;
    v_msg := 'admitted';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_fixed AND v_msg <> 'admitted' THEN
    RAISE EXCEPTION 'after the migration a player''s seat count is still refused: %', v_msg;
  ELSIF NOT v_fixed AND v_msg NOT LIKE '%Diamond Games Require Platform Operations%' THEN
    RAISE EXCEPTION 'before the migration the seat count was expected to be refused by the arena guard, got: %', v_msg;
  END IF;

  -- 2. The table's structure stays platform operations only.
  BEGIN
    UPDATE public.tables SET small_blind = 2 WHERE id = v_table;
    v_msg := 'admitted';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg NOT LIKE '%Diamond Games Require Platform Operations%' THEN
    RAISE EXCEPTION 'a player changed a Diamond table''s blinds: %', v_msg;
  END IF;

  -- 3. A wallet write outside a named money door stays refused.
  BEGIN
    UPDATE public.profiles SET diamonds = diamonds - 1 WHERE id = v_player;
    v_msg := 'admitted';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg NOT LIKE '%profiles.diamonds is server-managed%' THEN
    RAISE EXCEPTION 'a player''s JWT wrote a wallet outside a money door: %', v_msg;
  END IF;

  -- 4. As it was found.
  IF (SELECT diamonds FROM public.profiles WHERE id = v_player) IS DISTINCT FROM v_wallet THEN
    RAISE EXCEPTION 'the synthetic player''s wallet moved';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) IS DISTINCT FROM v_identity THEN
    RAISE EXCEPTION 'the Diamond identity moved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch was opened';
  END IF;
  RAISE EXCEPTION 'REHEARSAL OK [%]: seat count %, blinds refused, wallet write refused, identity % unchanged, switches closed',
    v_mode, CASE WHEN v_fixed THEN 'admitted' ELSE 'refused by the arena guard (the defect)' END, v_identity;
END $rehearsal$;
