DO $$ DECLARE j jsonb;BEGIN
 j:=fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',7);
 IF (j->>'window_end')::date-(j->>'window_start')::date<>7 THEN RAISE EXCEPTION 'Old extra-day defect not reproduced'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rollup_calls WHERE day=current_date-3) THEN RAISE EXCEPTION 'Old empty-day work not reproduced'; END IF;
END $$;
TRUNCATE rollup_calls;
