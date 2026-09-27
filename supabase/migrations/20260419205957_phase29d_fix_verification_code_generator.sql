-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419205957 "phase29d_fix_verification_code_generator"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f74e11f5810654cb3c7452be2e51793a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.submit_venue_claim_request(
    p_venue_id             integer,
    p_caller_user_id       uuid,
    p_verification_method  text,
    p_claimant_name        text,
    p_claimant_title       text,
    p_claimant_email       text,
    p_claimant_phone       text DEFAULT NULL,
    p_claimant_notes       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_venue RECORD; v_existing_claim RECORD; v_claim_id uuid; v_verification_code text;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;
    IF p_verification_method NOT IN ('email_domain','phone_match','document','business_license','admin_review') THEN
        RAISE EXCEPTION 'INVALID_VERIFICATION_METHOD';
    END IF;
    IF p_claimant_name IS NULL OR length(trim(p_claimant_name)) = 0 THEN 
        RAISE EXCEPTION 'CLAIMANT_NAME_REQUIRED'; 
    END IF;
    IF p_claimant_email IS NULL OR p_claimant_email !~ '^[^@]+@[^@]+\.[^@]+$' THEN
        RAISE EXCEPTION 'INVALID_EMAIL';
    END IF;

    SELECT id, name, is_claimed, claimed_by INTO v_venue 
      FROM poker_venues WHERE id = p_venue_id 
       AND COALESCE(is_active, true) AND NOT COALESCE(is_suppressed, false);
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;
    IF v_venue.is_claimed = true AND v_venue.claimed_by <> p_caller_user_id THEN
        RAISE EXCEPTION 'VENUE_ALREADY_CLAIMED';
    END IF;

    SELECT id, status INTO v_existing_claim FROM venue_claims
     WHERE venue_id = p_venue_id AND user_id = p_caller_user_id
       AND status IN ('pending','under_review')
     LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'DUPLICATE_PENDING_CLAIM',
            'claim_id', v_existing_claim.id, 'status', v_existing_claim.status
        );
    END IF;

    -- Generate 8-char hex verification code using md5 (always available)
    v_verification_code := upper(substring(md5(random()::text || clock_timestamp()::text), 1, 8));

    INSERT INTO venue_claims (
        venue_id, user_id, status, verification_method,
        claimant_name, claimant_title, claimant_email, claimant_phone,
        verification_code, verification_attempts, claimant_notes
    ) VALUES (
        p_venue_id, p_caller_user_id, 'pending', p_verification_method,
        p_claimant_name, p_claimant_title, p_claimant_email, p_claimant_phone,
        v_verification_code, 0, p_claimant_notes
    ) RETURNING id INTO v_claim_id;

    RETURN jsonb_build_object(
        'success', true, 'claim_id', v_claim_id, 'venue_id', p_venue_id,
        'venue_name', v_venue.name, 'status', 'pending',
        'verification_method', p_verification_method,
        'verification_code', v_verification_code,
        'message', 'Claim submitted. Admin will review and contact you at ' || p_claimant_email
    );
END; $fn$;
