-- Captured read-only September 10, 2026. calculate_cascading_commission body MD5 7b9638f98b36f8f73e5ccb2b666830a0
CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(p_hand_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_player_user_id uuid DEFAULT NULL::uuid, p_rake_amount numeric DEFAULT 0, p_rake_record_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_book_club     uuid;
  v_agent_user    uuid;
  v_cur_id        uuid;
  v_cur_user      uuid;
  v_cur_rate      numeric;
  v_cur_role      text;
  v_parent        uuid;
  v_remaining     numeric;
  v_slice         numeric;
  v_rate          numeric;
  v_results       jsonb := '[]'::jsonb;
  v_commission_id uuid;
  v_club_owner_id uuid;
  v_depth         int := 0;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 OR p_club_id IS NULL OR p_player_user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'commissions', v_results, 'skipped', 'missing_inputs');
  END IF;

  v_remaining := p_rake_amount;

  -- UNION LAW: attribute to the player's own club, not the union house club.
  v_book_club := COALESCE(
    public.fn_resolve_player_club_for_agent(p_player_user_id, p_club_id, p_table_id),
    p_club_id);

  -- The player's direct upline.
  SELECT cm.agent_id INTO v_agent_user
    FROM club_members cm
   WHERE cm.user_id = p_player_user_id AND cm.club_id = v_book_club
     AND cm.agent_id IS NOT NULL
   LIMIT 1;

  IF v_agent_user IS NOT NULL THEN
    SELECT a.id, a.user_id, a.commission_rate, a.role, a.parent_agent_id
      INTO v_cur_id, v_cur_user, v_cur_rate, v_cur_role, v_parent
      FROM agents a
     WHERE a.user_id = v_agent_user AND a.status = 'active'
     ORDER BY (a.club_id = v_book_club) DESC
     LIMIT 1;
  END IF;

  -- Climb: sub_agent -> agent -> super_agent, each taking its override on
  -- what remains below it.
  WHILE v_cur_id IS NOT NULL AND v_depth < 10 AND v_remaining > 0 LOOP
    v_depth := v_depth + 1;

    v_rate := CASE WHEN COALESCE(v_cur_rate,0) > 1 THEN v_cur_rate / 100.0
                   ELSE COALESCE(v_cur_rate,0) END;
    v_slice := ROUND(v_remaining * v_rate, 4);

    IF v_slice > 0 THEN
      INSERT INTO public.agent_commissions
        (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
      VALUES
        (v_book_club, v_cur_user, v_slice, v_cur_rate, 'rake',
         COALESCE(p_rake_record_id, p_hand_id),
         COALESCE(v_cur_role,'agent') || ' slice (tier ' || v_depth || ')')
      RETURNING id INTO v_commission_id;

      v_results := v_results || jsonb_build_object(
        'tier', COALESCE(v_cur_role,'agent'), 'depth', v_depth,
        'user_id', v_cur_user, 'amount', v_slice, 'commission_id', v_commission_id);

      v_remaining := v_remaining - v_slice;
    END IF;

    -- step up to the override holder
    IF v_parent IS NULL THEN
      v_cur_id := NULL;
    ELSE
      SELECT a.id, a.user_id, a.commission_rate, a.role, a.parent_agent_id
        INTO v_cur_id, v_cur_user, v_cur_rate, v_cur_role, v_parent
        FROM agents a WHERE a.id = v_parent AND a.status = 'active';
      IF NOT FOUND THEN v_cur_id := NULL; END IF;
    END IF;
  END LOOP;

  -- Whatever survives the chain belongs to the club.
  SELECT owner_id INTO v_club_owner_id FROM public.clubs WHERE id = v_book_club;
  IF v_club_owner_id IS NOT NULL AND v_remaining > 0 THEN
    INSERT INTO public.agent_commissions
      (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
    VALUES
      (v_book_club, v_club_owner_id, v_remaining, NULL, 'rake',
       COALESCE(p_rake_record_id, p_hand_id), 'club owner residual')
    RETURNING id INTO v_commission_id;
    v_results := v_results || jsonb_build_object('tier','owner',
      'user_id', v_club_owner_id, 'amount', v_remaining, 'commission_id', v_commission_id);
  END IF;

  UPDATE public.club_wallets
     SET period_commission_paid   = period_commission_paid   + p_rake_amount,
         lifetime_commission_paid = lifetime_commission_paid + p_rake_amount,
         updated_at = NOW()
   WHERE club_id = v_book_club;

  RETURN jsonb_build_object('success', true, 'hand_id', p_hand_id, 'club_id', v_book_club,
    'player_user_id', p_player_user_id, 'rake_amount', p_rake_amount,
    'tiers_paid', v_depth, 'commissions', v_results);
END;
$function$;

-- Captured read-only September 10, 2026. fn_resolve_player_club_for_agent body MD5 a05131eb6fff1c2438cb7d24eb2eac1b
CREATE OR REPLACE FUNCTION public.fn_resolve_player_club_for_agent(p_user_id uuid, p_club_hint uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_club uuid;
BEGIN
  -- 1. The club stamped on the player's live seat is the truth: it is the club
  --    whose chips they are playing with.
  IF p_table_id IS NOT NULL THEN
    SELECT ts.club_id INTO v_club
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
       AND ts.club_id IS NOT NULL
     LIMIT 1;
    IF v_club IS NOT NULL THEN RETURN v_club; END IF;
  END IF;

  -- 2. The hint is usable only if it is a real member club for this player
  --    with an agent relationship (the union house club never is).
  IF p_club_hint IS NOT NULL AND EXISTS (
       SELECT 1 FROM club_members m
        WHERE m.user_id = p_user_id AND m.club_id = p_club_hint
          AND m.agent_id IS NOT NULL) THEN
    RETURN p_club_hint;
  END IF;

  -- 3. Otherwise fall back to a member club inside the same union that DOES
  --    carry an agent link.
  IF p_club_hint IS NOT NULL THEN
    SELECT COALESCE(uc.union_id, c.union_id) INTO v_union
      FROM clubs c LEFT JOIN union_clubs uc ON uc.club_id = c.id
     WHERE c.id = p_club_hint LIMIT 1;
  END IF;

  IF v_union IS NOT NULL THEN
    SELECT m.club_id INTO v_club
      FROM club_members m
      JOIN union_clubs uc2 ON uc2.club_id = m.club_id AND uc2.union_id = v_union
     WHERE m.user_id = p_user_id AND m.agent_id IS NOT NULL
     ORDER BY m.joined_at ASC NULLS LAST, m.club_id
     LIMIT 1;
    IF v_club IS NOT NULL THEN RETURN v_club; END IF;
  END IF;

  RETURN p_club_hint;
END $function$

