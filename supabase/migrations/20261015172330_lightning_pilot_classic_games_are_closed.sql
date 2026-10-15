-- RULING. Dan, 2026-10-15 12:19 Central, in his own words: "Approved: close the
-- 9 empty Classic games in the Lightning pilot club."
--
-- WHY. The Lightning Internal Pilot was created with the default Classic board:
-- nine 0.50/1.00 cash games (NLH, FLH, PLO4/5/6/8, FLO8, Short Deck, Pineapple).
-- Nobody plays them, but an enabled game is stake supply to the horse fleet
-- (HorseFleetManager bandsWithAGameByHost), so the pilot read as having a 'low'
-- band game and its low and mid band horses never projected down to the micro
-- Lightning pilot games (projectStakeBandOnto steps a horse down only when its
-- own band has no game on that host). That is why the pilot fill stalled at 8
-- and 8 against the 18 / 27 live players Phase 3 needs.
--
-- CHANGE. Each of the nine games, by id, is closed the way the maintained door
-- fn_close_managed_game('table', main) closes a cluster game: the game goes
-- enabled=false, state='dormant', closed_at, closed_by the club owner, and its
-- tables go closed. When the main table is still open the door itself is called
-- as the owner; when the 16:55 UTC owner wallet reset already closed the table
-- (the door then answers already_closed and leaves the game enabled, so the
-- cluster tick would reopen it), the game row gets the door's own write.
-- Refuses whole if any of the nine has a seated player, an active session or a
-- waitlist entry. The two Lightning Pilot games, every other club and every
-- wallet are untouched; that is asserted.
-- @live-proof: (SELECT count(*) = 0 FROM public.cash_games WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND name LIKE 'Classic %' AND (enabled OR closed_at IS NULL)) AND (SELECT count(*) = 2 FROM public.cash_games WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND name LIKE 'Lightning Pilot%' AND enabled AND lightning_enabled AND closed_at IS NULL)

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $close$
DECLARE
  c_club constant uuid := 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  c_owner constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_games constant uuid[] := ARRAY[
    'e639c83c-f66a-42f9-9ea1-38eed4e26f27', -- Classic NLH
    '60178ffc-883c-4357-b79e-52ccade254ee', -- Classic FLH
    'abac480c-f049-4e2a-9d62-958304b8188f', -- Classic PLO4
    '9869e373-9cfa-4492-aa97-ba5541dbed9e', -- Classic PLO5
    '36d337b4-9b1b-434b-92fd-b6ed33e0e3c9', -- Classic PLO6
    '037bc558-ead6-4143-96e4-3e2d641d0daa', -- Classic PLO8
    '966d8e6b-74c0-42cd-90f2-743ce7378fde', -- Classic FLO8
    '36e26d8d-ca2f-4f32-9f20-3b224796075f', -- Classic Short Deck
    'da86d705-d554-402a-845c-b090d0c72958'  -- Classic Pineapple
  ]::uuid[];
  v_pilot_before jsonb; v_pilot_after jsonb;
  v_other_before text; v_other_after text;
  v_wallets_before numeric; v_wallets_after numeric;
  v_treasury_before numeric; v_treasury_after numeric;
  g uuid; v_main uuid; v_status text; r jsonb; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.cash_games
   WHERE id = ANY (c_games) AND club_id = c_club AND name LIKE 'Classic %' AND NOT lightning_enabled;
  IF v_n <> 9 THEN
    RAISE EXCEPTION 'expected the 9 Classic pilot games, found %', v_n;
  END IF;

  SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) INTO v_pilot_before FROM (
    SELECT id, enabled, state, closed_at, lightning_enabled, cluster_mode FROM public.cash_games
     WHERE club_id = c_club AND name LIKE 'Lightning Pilot%') x;
  SELECT md5(string_agg(id::text || enabled::text || coalesce(closed_at::text, ''), ',' ORDER BY id))
    INTO v_other_before FROM public.cash_games WHERE club_id <> c_club;
  SELECT coalesce(sum(chip_balance), 0) INTO v_wallets_before FROM public.club_members WHERE club_id = c_club;
  SELECT chip_treasury INTO v_treasury_before FROM public.clubs WHERE id = c_club;

  PERFORM 1 FROM public.cash_games WHERE id = ANY (c_games) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tables WHERE cluster_id = ANY (c_games) ORDER BY id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
              WHERE t.cluster_id = ANY (c_games) AND s.left_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.table_sessions ss JOIN public.tables t ON t.id = ss.table_id
                 WHERE t.cluster_id = ANY (c_games) AND coalesce(ss.is_active, false) AND ss.left_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.cash_game_waitlist w
                 WHERE w.game_id = ANY (c_games) AND w.status IN ('waiting', 'notified')) THEN
    RAISE EXCEPTION 'a Classic pilot game has a seated player, an active session or a waitlist entry';
  END IF;

  -- The maintained door reads auth.uid(); act as the club owner for this transaction only.
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', c_owner::text, 'role', 'authenticated')::text, true);

  FOREACH g IN ARRAY c_games LOOP
    SELECT id, status INTO v_main, v_status FROM public.tables
     WHERE cluster_id = g AND role = 'main' ORDER BY created_at DESC LIMIT 1;
    IF v_main IS NOT NULL
       AND lower(coalesce(v_status, '')) NOT IN ('closed', 'completed', 'cancelled', 'finished') THEN
      r := public.fn_close_managed_game('table', v_main);
      IF coalesce(r->>'ok', '') <> 'true' THEN
        RAISE EXCEPTION 'the door refused Classic pilot game %: %', g, r;
      END IF;
    END IF;
    -- The door's own cluster write, for a game whose main table was already closed.
    UPDATE public.cash_games
       SET enabled = false, state = 'dormant', closed_at = now(), closed_by = c_owner, updated_at = now()
     WHERE id = g AND enabled;
    UPDATE public.tables SET status = 'closed', current_players = 0, updated_at = now()
     WHERE cluster_id = g
       AND lower(coalesce(status, '')) NOT IN ('closed', 'completed', 'cancelled', 'finished');
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM public.cash_games WHERE id = ANY (c_games) AND (enabled OR closed_at IS NULL)) THEN
    RAISE EXCEPTION 'a Classic pilot game is still enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables WHERE cluster_id = ANY (c_games)
              AND lower(coalesce(status, '')) NOT IN ('closed', 'completed', 'cancelled', 'finished')) THEN
    RAISE EXCEPTION 'a Classic pilot table is still open';
  END IF;

  SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) INTO v_pilot_after FROM (
    SELECT id, enabled, state, closed_at, lightning_enabled, cluster_mode FROM public.cash_games
     WHERE club_id = c_club AND name LIKE 'Lightning Pilot%') x;
  IF v_pilot_after IS DISTINCT FROM v_pilot_before THEN
    RAISE EXCEPTION 'a Lightning pilot game changed: % -> %', v_pilot_before, v_pilot_after;
  END IF;
  SELECT md5(string_agg(id::text || enabled::text || coalesce(closed_at::text, ''), ',' ORDER BY id))
    INTO v_other_after FROM public.cash_games WHERE club_id <> c_club;
  IF v_other_after IS DISTINCT FROM v_other_before THEN
    RAISE EXCEPTION 'a game outside the pilot club changed';
  END IF;
  SELECT coalesce(sum(chip_balance), 0) INTO v_wallets_after FROM public.club_members WHERE club_id = c_club;
  SELECT chip_treasury INTO v_treasury_after FROM public.clubs WHERE id = c_club;
  IF v_wallets_after <> v_wallets_before OR v_treasury_after <> v_treasury_before THEN
    RAISE EXCEPTION 'chips moved while closing games: wallets % -> %, treasury % -> %',
      v_wallets_before, v_wallets_after, v_treasury_before, v_treasury_after;
  END IF;
END $close$;

COMMIT;
