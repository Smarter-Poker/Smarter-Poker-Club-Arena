BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_request(
  p_tournament_id uuid,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_request jsonb;
  v_claim jsonb;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'A live authenticated session is required' USING ERRCODE = '28000';
  END IF;
  IF p_tournament_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Tournament and request identity are required' USING ERRCODE = '22004';
  END IF;
  v_request := jsonb_build_object(
    'tournament_id', p_tournament_id, 'user_id', v_uid, 'funding_kind', 'club_wallet'
  );
  v_claim := public.fn_claim_entry_purchase_receipt(
    'tournament_registration_v1', p_request_id::text, v_request
  );
  IF v_claim->'claimed' = 'false'::jsonb THEN
    RETURN v_claim->'response';
  END IF;

  -- All funding, roster, fee and pool writes remain in the existing core.
  -- Its maintenance gate applies to a new purchase, never to a committed replay.
  v_result := public.fn_register_for_tournament(p_tournament_id, false);
  IF v_result->'ok' = 'false'::jsonb THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'tournament_registration_v1', p_request_id::text, v_request
    );
    RETURN v_result || jsonb_build_object('request_id', p_request_id);
  END IF;
  IF v_result->'ok' IS DISTINCT FROM 'true'::jsonb
     OR NULLIF(v_result->>'registration_id', '') IS NULL THEN
    RAISE EXCEPTION 'Registration did not return a confirmed entry receipt'
      USING ERRCODE = '55000';
  END IF;
  -- Cast verifies the core receipt before any financial write may commit.
  PERFORM (v_result->>'registration_id')::uuid;
  v_result := v_result || jsonb_build_object(
    'request_id', p_request_id, 'tournament_id', p_tournament_id, 'user_id', v_uid
  );
  RETURN public.fn_record_entry_purchase_receipt(
    'tournament_registration_v1', p_request_id::text, v_request, v_result
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament_request(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament_request(uuid,uuid)
  TO authenticated;
COMMIT;
