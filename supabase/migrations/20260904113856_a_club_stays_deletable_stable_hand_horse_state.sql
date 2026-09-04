-- A club stays deletable (chip standard, 2026-09-04): two foreign keys into
-- public.clubs arrived after 20260904001605 closed the thirteen it found -
-- stable_hand_horse_state.active_club_id and .active_host_id, 1,000 rows,
-- no index on either. fn_ca_fk_index_gaps('public.clubs') named them and
-- the CI gate on #2905 went red on them, correctly. Small table, plain build.
CREATE INDEX IF NOT EXISTS idx_stable_hand_horse_state_active_club_id_fk
  ON public.stable_hand_horse_state (active_club_id);
CREATE INDEX IF NOT EXISTS idx_stable_hand_horse_state_active_host_id_fk
  ON public.stable_hand_horse_state (active_host_id);
DO $$
DECLARE v jsonb;
BEGIN
  v := public.fn_ca_fk_index_gaps('public.clubs');
  IF jsonb_array_length(COALESCE(v->'gaps', '[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'a foreign key into clubs is still unanswerable: %', v->'gaps';
  END IF;
END $$;
