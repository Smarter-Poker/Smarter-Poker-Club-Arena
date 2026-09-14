-- Reserved by scripts/reserve-migration-version.sh. Repair only the outer creator receipt.
-- Authentication, club authorization, delegated financial formulas and all
-- existing funded events retain their current authority. The old key mismatch
-- discarded payoutPercent; the catch-all then concealed any contract failure.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE
  v_def text;
  v_source text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(p.prosrc) INTO v_def,v_source
    FROM pg_proc p WHERE p.oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure;
  IF v_source='b6335e81d6629f8971d2fa378aebe6b1' THEN RETURN; END IF;
  IF v_source IS DISTINCT FROM '16305fb3739f13e64af6a1e8eb3bf165' THEN
    RAISE EXCEPTION 'Unreviewed tournament creator source: %',v_source;
  END IF;
  v_def:=replace(v_def,$old$CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid, p_config jsonb)
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
END $function$
$old$,$new$CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid, p_config jsonb)
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
  v_saved_pct smallint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_authenticated');
  END IF;
  IF NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('success',false,'error','not_authorised');
  END IF;

  -- Preserve the existing 10% fallback for absent or invalid input. Only
  -- input decoding is recoverable: a failed contract write must roll back
  -- the delegated create in the same database transaction.
  BEGIN
    v_pct := CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20)
                  THEN (p_config->>'payoutPercent')::smallint ELSE 10 END;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_pct := 10;
  END;

  v_res := public.fn_create_tournament_governed_legacy(p_club_id,p_config);
  IF v_res->'success' = 'false'::jsonb THEN
    RETURN v_res;
  END IF;
  IF v_res->'success' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Tournament creation returned an unconfirmed receipt';
  END IF;

  -- The governed creator returns tournament_id. A missing, malformed or
  -- cross-club receipt cannot be accepted as a successful creation.
  v_id := NULLIF(v_res->>'tournament_id','')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Tournament creation returned no tournament_id';
  END IF;
  UPDATE public.tournaments SET payout_percent = v_pct
   WHERE id = v_id AND club_id = p_club_id
   RETURNING payout_percent INTO v_saved_pct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament creation receipt does not identify its club event';
  END IF;

  IF v_saved_pct IS DISTINCT FROM v_pct THEN
    RAISE EXCEPTION 'Tournament payout depth was not persisted';
  END IF;

  RETURN v_res;
END $function$
$new$);
  EXECUTE v_def;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure)
     IS DISTINCT FROM 'b6335e81d6629f8971d2fa378aebe6b1' THEN
    RAISE EXCEPTION 'Tournament creator postimage did not match';
  END IF;
END;
$migration$;
COMMIT;
