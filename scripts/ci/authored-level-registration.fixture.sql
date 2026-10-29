-- Run only in an isolated database with the clock trigger and candidate installed.
-- No players, wallets, seats or entry RPCs exist in this fixture.
BEGIN;
DO $fixture$
DECLARE v public.tournaments%ROWTYPE; v_levels text := '[{"level":1,"smallBlind":25,"bigBlind":50,"durationMinutes":8}]';
BEGIN
 -- Satellite shaping supplied level9/minutes45; marked schedule wins last.
 INSERT INTO public.tournaments(schedule_id,status,tournament_type,variant,blind_structure,late_reg_levels,late_reg_mins)
 VALUES ('a70c1028-1600-4000-9000-000000000001','REGISTERING','MTT','satellite',v_levels,9,45) RETURNING * INTO v;
 IF v.late_reg_levels<>10 OR v.late_reg_mins<>0 THEN RAISE EXCEPTION 'Authored insert did not preserve 10/0'; END IF;
 -- A later blind edit must not resurrect a minutes deadline.
 UPDATE public.tournaments SET blind_structure='[{"level":1,"durationMinutes":10}]',late_reg_mins=100 WHERE id=v.id RETURNING * INTO v;
 IF v.late_reg_levels<>10 OR v.late_reg_mins<>0 THEN RAISE EXCEPTION 'Prestart clock edit resurrected minutes'; END IF;
 -- Unmarked schedules retain their existing clock behavior.
 INSERT INTO public.tournaments(status,tournament_type,variant,blind_structure,late_reg_levels,late_reg_mins)
 VALUES ('REGISTERING','MTT','satellite',v_levels,9,45) RETURNING * INTO v;
 IF v.late_reg_levels<>9 OR v.late_reg_mins=0 THEN RAISE EXCEPTION 'Unmarked event changed'; END IF;
 -- Running and finalized event terms are never silently changed.
 INSERT INTO public.tournaments(schedule_id,status,tournament_type,variant,blind_structure,late_reg_levels,late_reg_mins)
 VALUES ('a70c1028-1600-4000-9000-000000000001','RUNNING','MTT','freezeout',v_levels,9,45) RETURNING * INTO v;
 IF v.late_reg_levels<>9 OR v.late_reg_mins=0 THEN RAISE EXCEPTION 'Running terms changed'; END IF;
 INSERT INTO public.tournaments(schedule_id,status,tournament_type,variant,blind_structure,late_reg_levels,late_reg_mins,prize_pool_finalized)
 VALUES ('a70c1028-1600-4000-9000-000000000001','REGISTERING','MTT','freezeout',v_levels,9,45,true) RETURNING * INTO v;
 IF v.late_reg_levels<>9 OR v.late_reg_mins=0 THEN RAISE EXCEPTION 'Finalized terms changed'; END IF;
END $fixture$;
ROLLBACK;
