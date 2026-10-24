-- Owner October 22: one-time business configuration update, not a scheduler.
-- Engine creators own future correctness. Keep all first-entrant, custody,
-- funding, finalization and management-contract triggers enabled.
-- Does not change prize pools, earmarks, wallets, entries, start times or fees.
-- Replaying is a no-op. Run once through authorized SQL after qualification.
DO $free_buy_guarantees$
DECLARE
  candidate record;
  current_event public.tournaments%ROWTYPE;
  expected numeric;
  changed integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  PERFORM set_config('statement_timeout', '10s', true);
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'Free Buy guarantee update refused during maintenance';
  END IF;
  FOR candidate IN
    SELECT t.id
      FROM public.tournaments t
      JOIN public.tournament_schedules s ON s.id = t.schedule_id
     WHERE s.active
       AND s.club_id = t.club_id
       AND s.club_id IN ('fade0000-0000-0000-0000-000000000001'::uuid,
                         '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid)
       AND s.time_zone = 'America/Chicago'
       AND t.name = s.name
       AND t.name IN ('Morning Free Buy (NLH)', 'Midday Free Buy (NLH)',
                      'Afternoon Free Buy (NLH)', 'Prime Time Free Buy (NLH)',
                      'Midnight Free Buy (NLH)')
       AND t.start_time > now()
       AND t.status IN ('ANNOUNCED', 'REGISTERING')
       AND t.guaranteed_prize IS DISTINCT FROM
           CASE WHEN t.name IN ('Morning Free Buy (NLH)', 'Midnight Free Buy (NLH)')
                THEN 250 ELSE 500 END
     ORDER BY t.id
     FOR UPDATE OF t
  LOOP
    -- Fresh statement after acquiring the parent lock: registration that won
    -- the race is now visible. The installed first-entrant trigger also stays.
    SELECT * INTO STRICT current_event FROM public.tournaments WHERE id = candidate.id;
    IF COALESCE(current_event.entry_contract_locked, false)
       OR COALESCE(current_event.prize_pool_finalized, false)
       OR COALESCE(current_event.current_players, 0) <> 0
       OR COALESCE(current_event.prize_pool, 0) <> 0
       OR current_event.start_time <= clock_timestamp()
       OR current_event.status NOT IN ('ANNOUNCED', 'REGISTERING')
       OR current_event.tournament_type <> 'MTT'
       OR current_event.game_type <> 'NLH'
       OR COALESCE(current_event.buy_in_amount, 0) <> 0
       OR COALESCE(current_event.buy_in_fee, 0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_players p
                   WHERE p.tournament_id = candidate.id)
    THEN CONTINUE;
    END IF;
    IF public.fn_platform_frozen() THEN
      RAISE EXCEPTION 'Free Buy guarantee update refused during maintenance';
    END IF;
    expected := CASE WHEN current_event.name IN
      ('Morning Free Buy (NLH)', 'Midnight Free Buy (NLH)') THEN 250 ELSE 500 END;
    UPDATE public.tournaments SET guaranteed_prize = expected WHERE id = candidate.id;
    changed := changed + 1;
    RAISE NOTICE 'Free Buy guarantee %: % -> %', candidate.id,
      current_event.guaranteed_prize, expected;
  END LOOP;
  RAISE NOTICE 'Free Buy guarantees changed: %', changed;
END;
$free_buy_guarantees$;
