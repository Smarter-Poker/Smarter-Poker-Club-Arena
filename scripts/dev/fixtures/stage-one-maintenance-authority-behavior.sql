\set ON_ERROR_STOP on
BEGIN;
DO $behavior$
DECLARE
  v_steps text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_complete jsonb;
BEGIN
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'An empty maintenance fixture cannot freeze admissions';
  END IF;
  INSERT INTO public.engine_maintenance_break(
    phase, announced_at, enforce_freeze, ownership_token)
  VALUES('last_hand', clock_timestamp() - interval '10 minutes', true,
    'f1000000-0000-4000-8000-000000000001');
  IF NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'An unreleased last-hand announcement expired silently';
  END IF;
  UPDATE public.engine_maintenance_break
     SET phase='counting_down', break_started_at=announced_at+interval '2 minutes',
         break_ends_at=announced_at+interval '7 minutes';
  IF NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'Countdown expiry bypassed its explicit release';
  END IF;
  UPDATE public.engine_maintenance_break SET break_started_at=announced_at-interval '1 second';
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'A malformed countdown was treated as valid authority';
  END IF;
  DELETE FROM public.engine_maintenance_break;
  INSERT INTO public.engine_maintenance_thaws(contract_version, release_target_at, shifted)
  VALUES(3,clock_timestamp()+interval '2 minutes','{"complete":true}');
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'An incomplete release certificate acquired authority';
  END IF;
  SELECT jsonb_object_agg(step,0) || '{"complete":true}'::jsonb
    INTO v_complete FROM unnest(v_steps) step;
  UPDATE public.engine_maintenance_thaws SET shifted=v_complete;
  IF NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'A complete future release boundary was ignored';
  END IF;
  UPDATE public.engine_maintenance_thaws SET contract_version=2;
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'An obsolete release contract acquired authority';
  END IF;
  UPDATE public.engine_maintenance_thaws SET contract_version=3,
    release_target_at=clock_timestamp()-interval '1 second';
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'A completed release boundary continued freezing admissions';
  END IF;
END;
$behavior$;
ROLLBACK;
SELECT 'Eight maintenance admission and release behaviors passed' AS result;
