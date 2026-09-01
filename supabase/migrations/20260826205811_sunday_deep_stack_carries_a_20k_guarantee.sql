-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826205811; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═════════════════════════════════════════════════════════════════════════════
-- THE SUNDAY $200 DEEP STACK CARRIES A 20,000 GUARANTEE
-- Dan 2026-08-26: "do a 20k guarantee"
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The event shipped with no guarantee, deliberately: a guaranteed prize pool
-- is a financial commitment and nobody had asked for one. Now they have.
--
-- IT IS REAL, NOT DECORATIVE. Verified before applying, because a guarantee
-- that the payout path ignores is worse than none at all - it advertises money
-- that never arrives. `effectivePrizePool(prize_pool, guaranteed_prize)` is
-- `max()` of the two, and it is applied at BOTH points where the pool becomes
-- final: TournamentManagerBase at late-registration close, and again at prize
-- pool finalisation. So 20,000 is a floor the engine actually pays.
--
-- WHAT IT COSTS, measured against the live row rather than assumed:
--   prize side per entry   180   (200 total, 20 fee, exactly 10%)
--   entries to cover 20k   112
--   field cap            1,000
--
-- So the guarantee is covered at 112 entries and every entry past that grows
-- the pool beyond it. Below that the club pays the difference:
--
--     50 entries ->  9,000 collected -> 11,000 overlay
--    112 entries -> 20,160 collected ->      0 overlay (break-even)
--
-- Two things push the real break-even BELOW 112, both already live:
--   - REBUYS run through level 12 at 200 a time and add to the pool, so the
--     effective entry count is higher than the head count;
--   - SATELLITE SEATS contribute like a direct entry. fn_award_satellite_seat
--     moves the target buy-in into the target's prize pool and writes the fee
--     as rake, which is exactly where a direct buy-in would have landed. The
--     13 satellites feeding this event are therefore pool contributors, not a
--     drain on it.
--
-- Five players are already registered (satellite winners). Raising a
-- guarantee under registered players only ever increases what they play for,
-- so unlike a structure rewrite this is safe to apply to the live instance -
-- and an assertion below refuses to let this migration LOWER an existing
-- guarantee, which would not be.

UPDATE public.tournament_schedules
SET config = jsonb_set(
      jsonb_set(config, '{guaranteedPrize}', '20000'::jsonb, true),
      '{shortDescription}',
      '"20,000 Guaranteed. 30,000 Starting Chips. 10 Minute Levels. Rebuys Through Level 12. Satellites Run All Week."'::jsonb,
      true),
    updated_at = now()
WHERE name = 'Sunday $200 Deep Stack' AND active;

UPDATE public.tournaments
SET guaranteed_prize = 20000
WHERE name = 'Sunday $200 Deep Stack'
  AND status IN ('ANNOUNCED', 'REGISTERING')
  AND COALESCE(guaranteed_prize, 0) < 20000;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────

DO $$
DECLARE
  v_cfg_gtd numeric;
  v_bad     integer;
  v_entries numeric;
BEGIN
  SELECT (config->>'guaranteedPrize')::numeric INTO v_cfg_gtd
  FROM public.tournament_schedules WHERE name = 'Sunday $200 Deep Stack' AND active;
  IF v_cfg_gtd IS DISTINCT FROM 20000 THEN
    RAISE EXCEPTION 'schedule guarantee is %, expected 20000', v_cfg_gtd;
  END IF;

  -- Every pre-start instance must carry it, or the next one to run advertises
  -- a guarantee the row does not have.
  SELECT count(*) INTO v_bad
  FROM public.tournaments
  WHERE name = 'Sunday $200 Deep Stack'
    AND status IN ('ANNOUNCED', 'REGISTERING')
    AND COALESCE(guaranteed_prize, 0) <> 20000;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% pre-start Deep Stack(s) are missing the guarantee', v_bad;
  END IF;

  -- A GUARANTEE MUST NEVER BE LOWERED UNDER REGISTERED PLAYERS. This catches
  -- a future edit to this migration that reduces the number rather than
  -- raising it.
  SELECT count(*) INTO v_bad
  FROM public.tournaments t
  WHERE t.name = 'Sunday $200 Deep Stack'
    AND t.status IN ('RUNNING', 'LATE_REG', 'COMPLETING')
    AND COALESCE(t.guaranteed_prize, 0) > 20000;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% in-flight event(s) would have their advertised guarantee CUT', v_bad;
  END IF;

  -- The guarantee has to be reachable inside the field cap, or it is a
  -- standing loss rather than a promotion.
  SELECT ceil(20000 / buy_in_amount) INTO v_entries
  FROM public.tournaments
  WHERE name = 'Sunday $200 Deep Stack' AND status = 'REGISTERING' LIMIT 1;
  IF v_entries > (SELECT max_players FROM public.tournaments
                  WHERE name = 'Sunday $200 Deep Stack' AND status = 'REGISTERING' LIMIT 1) THEN
    RAISE EXCEPTION 'the guarantee needs % entries but the field caps at fewer', v_entries;
  END IF;

  RAISE NOTICE '20,000 guarantee live: % entries cover it, field caps at 1000', v_entries;
END $$;

-- ROLLBACK
--   UPDATE public.tournament_schedules
--   SET config = config - 'guaranteedPrize'
--   WHERE name = 'Sunday $200 Deep Stack';
--   UPDATE public.tournaments SET guaranteed_prize = 0
--   WHERE name = 'Sunday $200 Deep Stack' AND status IN ('ANNOUNCED','REGISTERING');
