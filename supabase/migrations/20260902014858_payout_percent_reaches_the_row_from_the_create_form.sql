-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902014858; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- The Field Paid selector on the create form sends payoutPercent in p_config.
-- The row it lands on is written by fn_create_tournament_governed_legacy - a
-- large INSERT owned by another workstream, and surgically editing its column
-- list is exactly the kind of change that breaks tournament creation for
-- everybody. So the thin wrapper stamps it instead, immediately after the
-- create, while the tournament still has no registrations and therefore
-- nothing for fn_guard_managed_game_lifecycle to object to.
--
-- Only 10, 15 and 20 are accepted; anything else falls back to 10, matching
-- the column default and the CHECK constraint. A tournament created without
-- the key keeps the default of 10, which is what every existing live
-- tournament was backfilled to.

CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
  v_pct smallint;
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_authenticated');
  END IF;
  IF NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('success',false,'error','not_authorised');
  END IF;

  v_res := public.fn_create_tournament_governed_legacy(p_club_id,p_config);

  /* What share of the field finishes in the money (Dan, 2026-09-02). The
     payout TABLE itself is derived at lock from this and the field that
     actually entered, so the places always match the entrants. */
  BEGIN
    v_pct := CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20)
                  THEN (p_config->>'payoutPercent')::smallint ELSE 10 END;
    v_id := COALESCE(NULLIF(v_res->>'tournamentId',''), NULLIF(v_res->>'id',''))::uuid;
    IF v_id IS NOT NULL AND v_pct IS DISTINCT FROM 10 THEN
      UPDATE public.tournaments SET payout_percent = v_pct WHERE id = v_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- a bad or absent payoutPercent must never fail a tournament create
  END;

  RETURN v_res;
END $function$;

