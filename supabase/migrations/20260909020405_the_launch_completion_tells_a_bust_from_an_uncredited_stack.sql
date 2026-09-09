DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_old_roster  CONSTANT text := 'OR COALESCE(p.chips, 0) <= 0';
  v_new_roster  CONSTANT text := 'OR COALESCE(p.chips, 0) < 0';
  v_old_seat    CONSTANT text := 'OR COALESCE(s.stack, 0) <= 0';
  v_new_seat    CONSTANT text := 'OR COALESCE(s.stack, 0) < 0';
  v_old_if      CONSTANT text :=
    'IF v_active_count < v_required_field OR v_bad_roster_count <> 0 THEN';
  v_new_if      CONSTANT text :=
'IF (SELECT COALESCE(sum(p2.chips), 0)
         FROM public.tournament_players p2
        WHERE p2.tournament_id = p_tournament_id
          AND p2.status IN (''registered'', ''playing''))
      < v_active_count * COALESCE(
          (SELECT t2.starting_chips FROM public.tournaments t2
            WHERE t2.id = p_tournament_id), 0)
     OR (SELECT COALESCE(sum(s2.stack), 0)
           FROM public.table_seats s2
           JOIN public.tables t3 ON t3.id = s2.table_id
          WHERE t3.tournament_id = p_tournament_id
            AND s2.left_at IS NULL)
        < v_active_count * COALESCE(
            (SELECT t2.starting_chips FROM public.tournaments t2
              WHERE t2.id = p_tournament_id), 0) THEN
    RETURN jsonb_build_object(
      ''ok'', false,
      ''reason'', ''launch_stacks_uncredited'',
      ''active_players'', v_active_count
    );
  END IF;

  IF v_active_count < v_required_field OR v_bad_roster_count <> 0 THEN';
BEGIN
  v_src := pg_get_functiondef(
    'public.fn_complete_tournament_launch_before_lease_generation'::regproc);

  IF position(v_old_roster in v_src) = 0
     OR position(v_old_seat in v_src) = 0
     OR position(v_old_if in v_src) = 0 THEN
    RAISE EXCEPTION
      'the live definition is not the shape this migration expects; read it before re-running';
  END IF;

  v_new := replace(v_src, v_old_roster, v_new_roster);
  v_new := replace(v_new, v_old_seat, v_new_seat);
  v_new := replace(v_new, v_old_if, v_new_if);

  IF position('launch_stacks_uncredited' in v_new) = 0
     OR position(v_old_roster in v_new) <> 0
     OR position(v_old_seat in v_new) <> 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;

  IF position('launch_receipt_state_mismatch' in v_new) = 0
     OR position('launch_roster_unproven' in v_new) = 0
     OR position('launch_seats_unproven' in v_new) = 0
     OR position('launch_tables_unproven' in v_new) = 0
     OR position('launch_spin_settlement_unproven' in v_new) = 0
     OR position('tournament launch status changed inside its completion transaction' in v_new) = 0 THEN
    RAISE EXCEPTION 'a proof went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid, uuid)
  FROM PUBLIC, anon, authenticated;