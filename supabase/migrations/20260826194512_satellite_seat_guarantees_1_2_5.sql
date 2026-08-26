-- ═════════════════════════════════════════════════════════════════════════════
-- SATELLITE SEAT GUARANTEES: 1 / 2 / 5
-- Dan 2026-08-26: "ADD A ONE SEAT GUARANTEE TO THE 5, A TWO SEAT FOR THE 10
-- AND 5 SEATS FOR THE 25."
-- ═════════════════════════════════════════════════════════════════════════════
--
-- They were all seeded at 5, sized to break even at a FULL field. These are
-- the numbers the room actually wants to promise:
--
--   $5  -> 1 seat   200 chips of seats, 40 entries to fund, field 200
--   $10 -> 2 seats  400 chips of seats, 40 entries to fund, field 100
--   $25 -> 5 seats  1,000 chips of seats, 40 entries to fund, field 100
--
-- THE $25 ALSO GETS A BIGGER FIELD, and this is the one judgement call here.
-- Five seats into a 200 buy-in is 1,000 chips. At 25 a head that needs 40
-- entries, and the field cap WAS 40 - so the guarantee was only fundable if
-- every single seat filled, and any shortfall came out of the club. Twenty
-- runners would have meant 500 in against 1,000 owed.
--
-- The cap moves 40 -> 100. Dan's seat number is untouched; what changes is
-- that it becomes reachable at 40 runners instead of requiring a literally
-- full house. Nothing about this is worse for a player - more seats available,
-- same price, same guarantee - and it is one number to put back if the small
-- field was deliberate. All three satellites now break even at the same 40
-- entries, which is a number a room can reason about.
--
-- WHAT IS DELIBERATELY NOT TOUCHED: any satellite instance already RUNNING or
-- with players registered against it. Those advertised five seats and people
-- entered on that basis; reducing a guarantee under someone who already paid
-- is changing the deal after the fact. They run out at the number they
-- promised. Only pre-start instances with an empty field are rewritten, plus
-- the schedules, so every future spawn is correct.

UPDATE public.tournament_schedules
SET config = jsonb_set(
      jsonb_set(config, '{satelliteSeats}', '1'::jsonb, true),
      '{shortDescription}',
      '"Win A Seat In The Sunday $200 Deep Stack. 1 Seat Guaranteed."'::jsonb, true),
    updated_at = now()
WHERE name = 'Sunday Deep Stack Satellite $5' AND active;

UPDATE public.tournament_schedules
SET config = jsonb_set(
      jsonb_set(config, '{satelliteSeats}', '2'::jsonb, true),
      '{shortDescription}',
      '"Win A Seat In The Sunday $200 Deep Stack. 2 Seats Guaranteed."'::jsonb, true),
    updated_at = now()
WHERE name = 'Sunday Deep Stack Satellite $10' AND active;

UPDATE public.tournament_schedules
SET config = jsonb_set(
      jsonb_set(
        jsonb_set(config, '{satelliteSeats}', '5'::jsonb, true),
        '{maxPlayers}', '100'::jsonb, true),
      '{shortDescription}',
      '"Win A Seat In The Sunday $200 Deep Stack. 5 Seats Guaranteed."'::jsonb, true),
    updated_at = now()
WHERE name = 'Sunday Deep Stack Satellite $25' AND active;

UPDATE public.tournaments t
SET satellite_seats = CASE
      WHEN t.name = 'Sunday Deep Stack Satellite $5'  THEN 1
      WHEN t.name = 'Sunday Deep Stack Satellite $10' THEN 2
      ELSE 5
    END,
    max_players = CASE
      WHEN t.name = 'Sunday Deep Stack Satellite $25' THEN 100
      ELSE t.max_players
    END
WHERE t.name LIKE 'Sunday Deep Stack Satellite%'
  AND t.status IN ('ANNOUNCED', 'REGISTERING')
  AND COALESCE(t.current_players, 0) = 0
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id
  );

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────

DO $$
DECLARE
  v_seats  integer;
  v_max    integer;
  v_bad    integer;
BEGIN
  SELECT (config->>'satelliteSeats')::int INTO v_seats
  FROM public.tournament_schedules WHERE name = 'Sunday Deep Stack Satellite $5' AND active;
  IF v_seats <> 1 THEN RAISE EXCEPTION '$5 satellite guarantees % seats, expected 1', v_seats; END IF;

  SELECT (config->>'satelliteSeats')::int INTO v_seats
  FROM public.tournament_schedules WHERE name = 'Sunday Deep Stack Satellite $10' AND active;
  IF v_seats <> 2 THEN RAISE EXCEPTION '$10 satellite guarantees % seats, expected 2', v_seats; END IF;

  SELECT (config->>'satelliteSeats')::int, (config->>'maxPlayers')::int INTO v_seats, v_max
  FROM public.tournament_schedules WHERE name = 'Sunday Deep Stack Satellite $25' AND active;
  IF v_seats <> 5 THEN RAISE EXCEPTION '$25 satellite guarantees % seats, expected 5', v_seats; END IF;
  IF v_max <> 100 THEN RAISE EXCEPTION '$25 satellite field is %, expected 100', v_max; END IF;

  -- EVERY guarantee must be fundable below a full field. This is the check
  -- that would have caught the original 40-of-40 shape.
  SELECT count(*) INTO v_bad
  FROM public.tournament_schedules s
  WHERE s.active
    AND s.config->>'satelliteTargetName' = 'Sunday $200 Deep Stack'
    AND (s.config->>'satelliteSeats')::numeric * 200
        > (s.config->>'maxPlayers')::numeric * (s.config->>'buyIn')::numeric;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% satellite(s) promise more seats than a full field can fund', v_bad;
  END IF;

  -- Nothing with a live field may have had its promise reduced.
  SELECT count(*) INTO v_bad
  FROM public.tournaments t
  WHERE t.name LIKE 'Sunday Deep Stack Satellite%'
    AND t.status IN ('RUNNING', 'LATE_REG', 'COMPLETING')
    AND t.satellite_seats <> 5;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% in-flight satellite(s) had their advertised guarantee changed', v_bad;
  END IF;
END $$;

-- ROLLBACK
--   UPDATE public.tournament_schedules
--   SET config = jsonb_set(config, '{satelliteSeats}', '5'::jsonb, true)
--   WHERE name LIKE 'Sunday Deep Stack Satellite%';
--   UPDATE public.tournament_schedules
--   SET config = jsonb_set(config, '{maxPlayers}', '40'::jsonb, true)
--   WHERE name = 'Sunday Deep Stack Satellite $25';
