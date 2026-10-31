CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_free_entry(p_user_id uuid, p_tournament_id uuid, p_registration_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t record; v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL OR p_registration_id IS NULL THEN
    RAISE EXCEPTION 'invalid_diamond_free_entry' USING ERRCODE = '22023';
  END IF;
  SELECT t.club_id, t.buy_in_amount, t.buy_in_fee INTO v_t
    FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_tournament_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE = '23514'; END IF;
  IF COALESCE(v_t.buy_in_amount, 0) <> 0 OR COALESCE(v_t.buy_in_fee, 0) <> 0 THEN
    RAISE EXCEPTION 'diamond_free_entry_requires_a_freeroll' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_arena_settings a
                  WHERE a.id = 1 AND a.club_id = v_t.club_id AND a.tournaments_enabled) THEN
    RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody c
              WHERE c.user_id = p_user_id AND c.purpose = 'tournament_entry'
                AND c.target_id = p_tournament_id AND c.state <> 'released') THEN
    RAISE EXCEPTION 'diamond_tournament_entry_already_held' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.poker_diamond_custody (id, user_id, arena_id, purpose, target_id, entry_key, balance, state)
  VALUES (gen_random_uuid(), p_user_id, v_t.club_id, 'tournament_entry', p_tournament_id,
          'entry:' || p_registration_id::text, 0, 'active')
  RETURNING id INTO v_id;
  UPDATE public.tournaments t SET entry_contract_locked = true
   WHERE t.id = p_tournament_id AND NOT t.entry_contract_locked;
  RETURN jsonb_build_object('success', true, 'free_entry', true, 'custody_id', v_id, 'amount', 0, 'journal_id', NULL);
END $function$

