-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827212742; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- GUARANTEE OVERLAY ALERT — ONE PER CLUB, NOT ONE PER TOURNAMENT (2026-08-27)
--
-- The negative-treasury alarm added with fn_apply_prize_guarantee fires on
-- every overlay funded while a club's treasury is under water. The events that
-- carry guarantees are RECURRING, so within a day one club produced five
-- alerts for "Sunrise Bounty", four for "Afternoon Bounty", and so on — 24
-- open alerts describing a single fact: one club's treasury is negative.
--
-- That is the FeeReconciler failure shape again (988 criticals, 93% noise) and
-- it is the same fix: the alert describes the CLUB's condition, so it dedupes
-- on the club. One open alert per club, carrying the running total, until an
-- operator resolves it.
--
-- Worth recording plainly, because the alarm is NOT crying wolf about
-- insolvency: since this went live clubs funded 4,841.50 chips of overlay
-- while tournament rake collected 9,887.88 in the same 24 hours. The rake goes
-- to the UNION rake wallet and comes back to club treasuries as the weekly 90%
-- rakeback close, so a negative treasury mid-week is a CASH-FLOW TIMING
-- artifact — guarantees are paid daily, rake is returned weekly — not a club
-- spending money it does not earn. The alert is still right to exist: an
-- operator should know a treasury is under water, and a club whose guarantees
-- genuinely outrun its rake would look identical until the weekly close failed
-- to cover it.

CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_overlay numeric; v_final numeric; v_claimed integer;
  v_treasury numeric; v_club_name text; v_updated integer;
BEGIN
  SELECT t.id, t.club_id, t.name, COALESCE(t.prize_pool, 0) AS pool,
         COALESCE(t.guaranteed_prize, 0) AS gtd, COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_t.finalized THEN
    RETURN jsonb_build_object('ok', true, 'already_finalized', true, 'prize_pool', v_t.pool);
  END IF;

  v_final := GREATEST(v_t.pool, v_t.gtd);
  v_overlay := round(v_final - v_t.pool, 2);

  IF v_overlay > 0 THEN
    INSERT INTO public.tournament_guarantee_overlays
      (tournament_id, club_id, amount, pool_before, pool_after, source)
    VALUES (p_tournament_id, v_t.club_id, v_overlay, v_t.pool, v_final, COALESCE(p_source, 'engine'))
    ON CONFLICT (tournament_id) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;

    IF v_claimed = 0 THEN
      UPDATE public.tournaments SET prize_pool_finalized = true WHERE id = p_tournament_id;
      RETURN jsonb_build_object('ok', true, 'already_funded', true, 'prize_pool', v_t.pool);
    END IF;

    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury, 0) - v_overlay,
           updated_at = now()
     WHERE id = v_t.club_id
     RETURNING chip_treasury, name INTO v_treasury, v_club_name;

    UPDATE public.tournament_guarantee_overlays
       SET treasury_after = v_treasury
     WHERE tournament_id = p_tournament_id;

    IF v_treasury IS NOT NULL AND v_treasury < 0 THEN
      -- ONE ALERT PER CLUB. Refresh the open one if it exists (so the figure
      -- stays current), otherwise raise it. Keyed on club_id in context.
      UPDATE public.financial_alerts
         SET message = 'Club treasury is negative from funding advertised guarantees: '
                       || COALESCE(v_club_name, v_t.club_id::text),
             context = jsonb_build_object(
                         'club_id', v_t.club_id,
                         'treasury_after', v_treasury,
                         'latest_tournament_id', p_tournament_id,
                         'latest_overlay', v_overlay,
                         'note', 'Guarantees are funded daily; union rake returns to club '
                                 || 'treasuries at the weekly 90% rakeback close, so a '
                                 || 'mid-week negative is usually timing. Escalate if it '
                                 || 'survives a close.'),
             created_at = now()
       WHERE source = 'fn_apply_prize_guarantee'
         AND resolved IS NOT TRUE
         AND context->>'club_id' = v_t.club_id::text;
      GET DIAGNOSTICS v_updated = ROW_COUNT;

      IF v_updated = 0 THEN
        INSERT INTO public.financial_alerts (severity, source, message, context)
        VALUES ('warning', 'fn_apply_prize_guarantee',
                'Club treasury is negative from funding advertised guarantees: '
                  || COALESCE(v_club_name, v_t.club_id::text),
                jsonb_build_object(
                  'club_id', v_t.club_id,
                  'treasury_after', v_treasury,
                  'latest_tournament_id', p_tournament_id,
                  'latest_overlay', v_overlay,
                  'note', 'Guarantees are funded daily; union rake returns to club '
                          || 'treasuries at the weekly 90% rakeback close, so a '
                          || 'mid-week negative is usually timing. Escalate if it '
                          || 'survives a close.'));
      END IF;
    END IF;
  END IF;

  UPDATE public.tournaments
     SET prize_pool = v_final, prize_pool_finalized = true
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'prize_pool', v_final,
    'overlay', COALESCE(v_overlay, 0), 'treasury_after', v_treasury);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(uuid, text) FROM PUBLIC, anon, authenticated;

-- Collapse the existing per-tournament backlog into one open alert per club.
WITH ranked AS (
  SELECT id, context->>'club_id' AS club_id,
         row_number() OVER (PARTITION BY context->>'club_id' ORDER BY created_at DESC) AS rn
    FROM public.financial_alerts
   WHERE source = 'fn_apply_prize_guarantee' AND resolved IS NOT TRUE
     AND context ? 'club_id'
)
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now()
  FROM ranked r
 WHERE fa.id = r.id AND r.rn > 1;

-- Older alerts raised before club_id was in context cannot be grouped; retire
-- them, the per-club alert above now carries the same fact with the number.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now()
 WHERE source = 'fn_apply_prize_guarantee' AND resolved IS NOT TRUE
   AND NOT (context ? 'club_id');

DO $$
DECLARE v_open integer; v_clubs integer;
BEGIN
  SELECT count(*), count(DISTINCT context->>'club_id') INTO v_open, v_clubs
    FROM public.financial_alerts
   WHERE source = 'fn_apply_prize_guarantee' AND resolved IS NOT TRUE;
  IF v_open > v_clubs THEN
    RAISE EXCEPTION 'ASSERT FAILED: % open overlay alert(s) across only % club(s)', v_open, v_clubs;
  END IF;
  RAISE NOTICE 'overlay alerts: % open across % club(s)', v_open, v_clubs;
END $$;
