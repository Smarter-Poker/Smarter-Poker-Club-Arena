-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820132404 "union_law_cascading_commission_scalar_agent_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1c65f2b28ce3bf24531183336bdf27ad of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Fix: v_agent was a plpgsql `record` that stays unassigned when the player has
-- no player_agent_assignments row, so referencing v_agent.id outside the
-- IF FOUND block raised "record is not assigned yet". Scalars instead.
CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(p_hand_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_player_user_id uuid DEFAULT NULL::uuid, p_rake_amount numeric DEFAULT 0, p_rake_record_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_assignment    record;
  v_sub_agent     record;
  v_agent_id      uuid;
  v_agent_user    uuid;
  v_agent_rate    numeric;
  v_club_owner_id uuid;
  v_remaining     numeric;
  v_slice         numeric;
  v_rate          numeric;
  v_results       jsonb := '[]'::jsonb;
  v_commission_id uuid;
  v_book_club     uuid;
  v_agent_from_member uuid;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 OR p_club_id IS NULL OR p_player_user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'commissions', v_results, 'skipped', 'missing_inputs');
  END IF;

  v_remaining := p_rake_amount;

  -- UNION LAW: attribute to the player's own club, not the union house club.
  v_book_club := COALESCE(
    public.fn_resolve_player_club_for_agent(p_player_user_id, p_club_id, p_table_id),
    p_club_id);

  SELECT * INTO v_assignment
    FROM public.player_agent_assignments
   WHERE player_id = p_player_user_id AND club_id = v_book_club;

  IF FOUND THEN
    IF v_assignment.sub_agent_id IS NOT NULL THEN
      SELECT s.id, s.parent_agent_id, s.commission_pct, s.user_id
        INTO v_sub_agent
        FROM public.sub_agents s
       WHERE s.id = v_assignment.sub_agent_id AND s.status = 'active';

      IF FOUND THEN
        v_rate := CASE WHEN v_sub_agent.commission_pct > 1
                       THEN v_sub_agent.commission_pct / 100.0
                       ELSE v_sub_agent.commission_pct END;
        v_slice := ROUND(v_remaining * v_rate::numeric, 4);
        IF v_slice > 0 THEN
          INSERT INTO public.agent_commissions
            (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
          VALUES
            (v_book_club, v_sub_agent.user_id, v_slice, v_sub_agent.commission_pct,
             'rake', COALESCE(p_rake_record_id, p_hand_id), 'sub_agent slice')
          RETURNING id INTO v_commission_id;
          v_results := v_results || jsonb_build_object('tier', 'sub_agent',
            'user_id', v_sub_agent.user_id, 'amount', v_slice, 'commission_id', v_commission_id);
          v_remaining := v_remaining - v_slice;
        END IF;

        SELECT id, user_id, commission_rate INTO v_agent_id, v_agent_user, v_agent_rate
          FROM public.agents WHERE id = v_sub_agent.parent_agent_id AND status = 'active';
      END IF;
    ELSIF v_assignment.agent_id IS NOT NULL THEN
      SELECT id, user_id, commission_rate INTO v_agent_id, v_agent_user, v_agent_rate
        FROM public.agents WHERE id = v_assignment.agent_id AND status = 'active';
    END IF;
  END IF;

  -- No assignment row: use the club membership's agent link, which is how this
  -- platform actually records the agent/player relationship.
  IF v_agent_id IS NULL THEN
    SELECT cm.agent_id INTO v_agent_from_member
      FROM club_members cm
     WHERE cm.user_id = p_player_user_id AND cm.club_id = v_book_club
       AND cm.agent_id IS NOT NULL
     LIMIT 1;
    IF v_agent_from_member IS NOT NULL THEN
      SELECT id, user_id, commission_rate INTO v_agent_id, v_agent_user, v_agent_rate
        FROM public.agents
       WHERE user_id = v_agent_from_member AND status = 'active'
       ORDER BY (club_id = v_book_club) DESC
       LIMIT 1;
    END IF;
  END IF;

  IF v_agent_id IS NOT NULL THEN
    v_rate := CASE WHEN v_agent_rate > 1 THEN v_agent_rate / 100.0 ELSE v_agent_rate END;
    v_slice := ROUND(v_remaining * COALESCE(v_rate,0)::numeric, 4);
    IF v_slice > 0 THEN
      INSERT INTO public.agent_commissions
        (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
      VALUES
        (v_book_club, v_agent_user, v_slice, v_agent_rate,
         'rake', COALESCE(p_rake_record_id, p_hand_id), 'agent slice')
      RETURNING id INTO v_commission_id;
      v_results := v_results || jsonb_build_object('tier', 'agent',
        'user_id', v_agent_user, 'amount', v_slice, 'commission_id', v_commission_id);
      v_remaining := v_remaining - v_slice;
    END IF;
  END IF;

  SELECT owner_id INTO v_club_owner_id FROM public.clubs WHERE id = v_book_club;
  IF v_club_owner_id IS NOT NULL AND v_remaining > 0 THEN
    INSERT INTO public.agent_commissions
      (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
    VALUES
      (v_book_club, v_club_owner_id, v_remaining, NULL,
       'rake', COALESCE(p_rake_record_id, p_hand_id), 'club owner residual')
    RETURNING id INTO v_commission_id;
    v_results := v_results || jsonb_build_object('tier', 'owner',
      'user_id', v_club_owner_id, 'amount', v_remaining, 'commission_id', v_commission_id);
  END IF;

  UPDATE public.club_wallets
     SET period_commission_paid   = period_commission_paid   + p_rake_amount,
         lifetime_commission_paid = lifetime_commission_paid + p_rake_amount,
         updated_at = NOW()
   WHERE club_id = v_book_club;

  RETURN jsonb_build_object('success', true, 'hand_id', p_hand_id, 'club_id', v_book_club,
    'player_user_id', p_player_user_id, 'rake_amount', p_rake_amount, 'commissions', v_results);
END;
$function$;

