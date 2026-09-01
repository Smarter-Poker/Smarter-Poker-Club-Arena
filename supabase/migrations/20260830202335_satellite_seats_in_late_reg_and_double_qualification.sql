-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830202335; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- SATELLITE AWARDS: SEATS IN LATE REG, AND A SECOND WIN IS NEVER WORTH ZERO
-- 2026-08-30 (Claude/Cowork satellite audit)
--
-- Two findings, one function:
--
-- 1. WIRING GAP left by PR #1935. The TypeScript gate
--    (isSatelliteTargetOpen) now treats a RUNNING target inside late
--    registration as open, but fn_award_satellite_seat still refused every
--    status except ANNOUNCED/REGISTERING. So the exact case #1935 was built
--    for — a satellite that ends after its target started — got
--    'target_closed' from this function and fell to the cash path anyway.
--    It only worked today because the target happened to be reset to
--    REGISTERING minutes before the satellite settled.
--
-- 2. DOUBLE QUALIFICATION PAID NOTHING. On unique_violation the function
--    returned ok/awarded=false and the engine treated that as success.
--    A player who won seats in two satellites received one seat and nothing
--    for the second win. Four such wins are back-paid below at ticket value
--    (200), idempotently. The function now reports WHICH satellite seated
--    the player, so the engine can distinguish a recovery re-drive (pay
--    nothing again) from a cross-satellite double win (pay ticket value).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tournament_players
  ADD COLUMN IF NOT EXISTS source_satellite_id uuid;

CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(
  p_satellite_id uuid, p_target_id uuid, p_user_id uuid,
  p_username text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
  v_cap      integer;
  v_existing uuid;
BEGIN
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
         max_players, current_players, current_level,
         late_reg_levels, rebuy_levels
    INTO v_t
    FROM public.tournaments
   WHERE id = p_target_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_not_found');
  END IF;

  -- Mirror of server/src/tournament/satelliteTargetOpen.ts, which is the
  -- authority the engine consults BEFORE calling this. The two must agree:
  -- ANNOUNCED/REGISTERING are open; RUNNING is open only inside late
  -- registration (late_reg_levels, falling back to rebuy_levels, both
  -- meaning "no late reg" when 0/NULL); everything else is closed.
  IF v_t.status IN ('ANNOUNCED', 'REGISTERING') THEN
    NULL; -- open
  ELSIF v_t.status = 'RUNNING' THEN
    v_cap := COALESCE(NULLIF(v_t.late_reg_levels, 0), NULLIF(v_t.rebuy_levels, 0), 0);
    IF v_cap <= 0 OR COALESCE(v_t.current_level, 0) > v_cap THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
  END IF;

  IF v_t.max_players IS NOT NULL
     AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_full');
  END IF;

  SELECT COALESCE(NULLIF(p_username, ''),
                  NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_name
    FROM public.profiles WHERE id = p_user_id;
  v_name := COALESCE(v_name, COALESCE(NULLIF(p_username, ''), 'Player'));

  BEGIN
    INSERT INTO public.tournament_players
      (tournament_id, user_id, username, chips, status,
       is_satellite_qualifier, source_satellite_id)
    VALUES (p_target_id, p_user_id, v_name, 0, 'registered', true, p_satellite_id)
    RETURNING id INTO v_seat_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already seated. Move nothing — the pool was credited when the seat was
    -- first taken. But SAY WHO SEATED THEM: a re-drive of THIS satellite must
    -- stay silent, while a win in a DIFFERENT satellite deserves the ticket
    -- value in cash, and only the caller can pay it.
    SELECT source_satellite_id INTO v_existing
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite',
      (v_existing IS NOT NULL AND v_existing = p_satellite_id));
  END;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool      = COALESCE(prize_pool, 0) + COALESCE(v_t.buy_in_amount, 0),
         total_rake      = COALESCE(total_rake, 0) + COALESCE(v_t.buy_in_fee, 0)
   WHERE id = p_target_id;

  IF COALESCE(v_t.buy_in_fee, 0) > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_t.buy_in_fee,
            COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 1, 0,
            true, p_target_id, 'fn_award_satellite_seat',
            jsonb_build_object('kind', 'satellite_seat_entry_fee',
                               'user_id', p_user_id,
                               'satellite_id', p_satellite_id,
                               'registration_id', v_seat_id));
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'awarded', true, 'registration_id', v_seat_id,
    'prize_contribution', COALESCE(v_t.buy_in_amount, 0),
    'rake', COALESCE(v_t.buy_in_fee, 0));
END;
$function$;

-- ── BACK-PAY: four wins that received neither seat nor cash ────────────────
-- Each row verified against rake_records (no seat funded for that satellite)
-- and wallet_transactions (no prize cash for that satellite). Idempotent:
-- fn_credit_and_log dedupes on the key, so re-running moves nothing twice.
DO $$
DECLARE
  r record;
  v_moved boolean;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('1a6f53a4-4d39-45fc-8fa8-623a7e45c288'::uuid, '4e5a0000-76ea-4bff-b44e-3c470e5f2434'::uuid, 1, 'Sunday Deep Stack Satellite $10'),
      ('acb14548-79d9-4e62-8da6-d71e54ad5b0c'::uuid, '660d14dc-9f42-425b-9985-55644a95a984'::uuid, 4, 'Sunday Deep Stack Satellite $25'),
      ('e3d3bd1e-d74c-403f-8d78-dd3c2436d879'::uuid, '650f193e-e50c-4239-b243-eb25384a4ae7'::uuid, 1, 'Sunday Deep Stack Satellite $25'),
      ('e3d3bd1e-d74c-403f-8d78-dd3c2436d879'::uuid, '00000000-0000-0000-0000-000000000010'::uuid, 5, 'Sunday Deep Stack Satellite $25')
    ) AS t(sat_id, user_id, pos, sat_name)
  LOOP
    -- Guard: the win must still be unpaid in both forms.
    IF EXISTS (SELECT 1 FROM public.rake_records rr
                WHERE rr.source = 'fn_award_satellite_seat'
                  AND (rr.metadata->>'satellite_id')::uuid = r.sat_id
                  AND (rr.metadata->>'user_id')::uuid = r.user_id)
    THEN
      RAISE EXCEPTION 'back-pay aborted: % / % already has a funded seat', r.sat_id, r.user_id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_transactions wt
                WHERE wt.related_entity_id = r.sat_id
                  AND wt.user_id = r.user_id AND wt.category = 'prize')
    THEN
      RAISE EXCEPTION 'back-pay aborted: % / % already paid cash', r.sat_id, r.user_id;
    END IF;

    v_moved := public.fn_credit_and_log(
      r.user_id, 200,
      'tourney:' || r.sat_id || ':prize:place:' || r.pos,
      'prize',
      'Satellite seat already held - ticket value paid in cash (audit back-pay): ' || r.sat_name,
      r.sat_id);
    IF NOT v_moved THEN
      RAISE EXCEPTION 'back-pay deduped unexpectedly for % / %', r.sat_id, r.user_id;
    END IF;

    UPDATE public.tournament_players SET prize = 200
     WHERE tournament_id = r.sat_id AND user_id = r.user_id;
  END LOOP;
END $$;

-- ── RECORD REPAIR: e3d3bd1e seat winners whose prize stamp silently failed
-- during the 2026-08-30 Supabase degradation. They HOLD the seats
-- (rake_records proves the funding); only the satellite's own record said 0.
UPDATE public.tournament_players tp
   SET prize = 200
  FROM public.rake_records rr
 WHERE tp.tournament_id = 'e3d3bd1e-d74c-403f-8d78-dd3c2436d879'
   AND rr.source = 'fn_award_satellite_seat'
   AND (rr.metadata->>'satellite_id')::uuid = tp.tournament_id
   AND (rr.metadata->>'user_id')::uuid = tp.user_id
   AND COALESCE(tp.prize, 0) = 0;

-- ── POST-APPLY ASSERTIONS ──────────────────────────────────────────────────
DO $$
BEGIN
  IF position('RUNNING' in pg_get_functiondef('public.fn_award_satellite_seat(uuid,uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_award_satellite_seat does not handle RUNNING targets';
  END IF;
  IF (SELECT count(*) FROM public.wallet_transactions
       WHERE category = 'prize'
         AND related_entity_id IN ('1a6f53a4-4d39-45fc-8fa8-623a7e45c288',
                                   'acb14548-79d9-4e62-8da6-d71e54ad5b0c',
                                   'e3d3bd1e-d74c-403f-8d78-dd3c2436d879')
         AND description LIKE 'Satellite seat already held%') < 4 THEN
    RAISE EXCEPTION 'back-pay rows missing';
  END IF;
END $$;

