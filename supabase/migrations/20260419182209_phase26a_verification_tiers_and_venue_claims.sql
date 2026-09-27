-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419182209 "phase26a_verification_tiers_and_venue_claims"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ffcb69c55eb549f1d4b116bf0bc2e139 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 26 PART A + B — Verification tiers + venue claim workflow
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- Verification tier column on profiles
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE profiles 
    ADD COLUMN IF NOT EXISTS verification_tier text 
        CHECK (verification_tier IN ('none','email','phone','id','premium'))
        DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS verification_note text;

CREATE INDEX IF NOT EXISTS idx_profiles_verification_tier 
    ON profiles (verification_tier) WHERE verification_tier <> 'none';

COMMENT ON COLUMN profiles.verification_tier IS
  'Phase 26/A: Trust tier. none → email (confirmed) → phone (SMS OTP) → id (gov ID) → premium (Stripe Identity). Monotonically rising.';

-- Backfill: anyone with phone_verified=true → 'phone' tier; email_verified=true → 'email' tier
UPDATE profiles SET verification_tier = 'phone', verified_at = COALESCE(verified_at, NOW())
 WHERE phone_verified = true AND verification_tier = 'none';
UPDATE profiles SET verification_tier = 'email', verified_at = COALESCE(verified_at, NOW())
 WHERE email_verified = true AND verification_tier = 'none';

-- ════════════════════════════════════════════════════════════════════════
-- Verification submissions — audit log + pending review queue
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_verification_submissions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tier_requested    text NOT NULL CHECK (tier_requested IN ('email','phone','id','premium')),
    method            text NOT NULL CHECK (method IN ('email_link','sms_otp','stripe_identity','manual_review','govid_upload')),
    status            text NOT NULL DEFAULT 'pending' 
                        CHECK (status IN ('pending','approved','rejected','expired')),
    evidence          jsonb DEFAULT '{}',     -- document URLs, Stripe session ID, etc.
    reviewer_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
    reviewer_note     text,
    reviewed_at       timestamptz,
    submitted_at      timestamptz NOT NULL DEFAULT NOW(),
    expires_at        timestamptz,
    ip_address        inet,
    user_agent        text
);

CREATE INDEX idx_verif_submissions_user ON commander_verification_submissions(user_id, submitted_at DESC);
CREATE INDEX idx_verif_submissions_pending 
    ON commander_verification_submissions(status, submitted_at) WHERE status = 'pending';

ALTER TABLE commander_verification_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY verif_submissions_own_select ON commander_verification_submissions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY verif_submissions_own_insert ON commander_verification_submissions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- RPC: Submit verification request
CREATE OR REPLACE FUNCTION public.submit_verification_request(
    p_caller_user_id  uuid,
    p_tier_requested  text,  -- 'email'|'phone'|'id'|'premium'
    p_method          text,  -- 'email_link'|'sms_otp'|'stripe_identity'|'manual_review'|'govid_upload'
    p_evidence        jsonb DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_id uuid; v_existing int;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_tier_requested NOT IN ('email','phone','id','premium') THEN RAISE EXCEPTION 'INVALID_TIER'; END IF;

    -- Rate limit: max 5 pending submissions per hour per user
    SELECT COUNT(*) INTO v_existing 
      FROM commander_verification_submissions 
     WHERE user_id = p_caller_user_id 
       AND submitted_at > NOW() - INTERVAL '1 hour';
    IF v_existing >= 5 THEN RAISE EXCEPTION 'RATE_LIMITED' USING HINT='max 5 submissions per hour'; END IF;

    INSERT INTO commander_verification_submissions (
        user_id, tier_requested, method, evidence, expires_at
    ) VALUES (
        p_caller_user_id, p_tier_requested, p_method, p_evidence, NOW() + INTERVAL '7 days'
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'submission_id', v_id, 'tier_requested', p_tier_requested);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.submit_verification_request(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.submit_verification_request(uuid, text, text, jsonb) TO authenticated, service_role;

-- RPC: Admin/service approves a submission → elevates user's verification_tier
CREATE OR REPLACE FUNCTION public.approve_verification_submission(
    p_submission_id   uuid,
    p_reviewer_id     uuid,
    p_reviewer_note   text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE 
    v_sub RECORD; 
    v_tier_ordering jsonb := '{"none":0,"email":1,"phone":2,"id":3,"premium":4}'::jsonb;
    v_current_tier text;
BEGIN
    -- Allow self-service approval only for email/phone (automated OTP flows);
    -- manual tiers need reviewer distinct from user.
    SELECT * INTO v_sub FROM commander_verification_submissions WHERE id = p_submission_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'SUBMISSION_NOT_FOUND'; END IF;
    IF v_sub.status <> 'pending' THEN RAISE EXCEPTION 'ALREADY_REVIEWED'; END IF;

    IF v_sub.tier_requested IN ('id','premium') AND p_reviewer_id = v_sub.user_id THEN
        RAISE EXCEPTION 'SELF_APPROVAL_NOT_ALLOWED';
    END IF;

    UPDATE commander_verification_submissions 
       SET status = 'approved', reviewer_id = p_reviewer_id, 
           reviewer_note = p_reviewer_note, reviewed_at = NOW()
     WHERE id = p_submission_id;

    -- Only upgrade — never downgrade
    SELECT verification_tier INTO v_current_tier FROM profiles WHERE id = v_sub.user_id;
    IF (v_tier_ordering->>v_sub.tier_requested)::int > (v_tier_ordering->>v_current_tier)::int THEN
        UPDATE profiles 
           SET verification_tier = v_sub.tier_requested,
               verified_at = NOW(),
               verified_by = p_reviewer_id,
               email_verified = CASE WHEN v_sub.tier_requested IN ('email','phone','id','premium') THEN true ELSE email_verified END,
               phone_verified = CASE WHEN v_sub.tier_requested IN ('phone','id','premium') THEN true ELSE phone_verified END
         WHERE id = v_sub.user_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'new_tier', v_sub.tier_requested);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.approve_verification_submission(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.approve_verification_submission(uuid, uuid, text) TO service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Venue claim workflow
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_venue_claim_requests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id          integer NOT NULL REFERENCES poker_venues(id) ON DELETE CASCADE,
    claimant_user_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    claim_role        text NOT NULL CHECK (claim_role IN ('owner','manager','marketing_manager','poker_room_manager')),
    business_name     text,
    business_email    text,
    business_phone    text,
    evidence_urls     text[],
    evidence_notes    text,
    status            text NOT NULL DEFAULT 'pending' 
                        CHECK (status IN ('pending','reviewing','approved','rejected','duplicate','withdrawn')),
    reviewer_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
    reviewer_note     text,
    submitted_at      timestamptz NOT NULL DEFAULT NOW(),
    reviewed_at       timestamptz
);

CREATE INDEX idx_venue_claim_venue ON commander_venue_claim_requests(venue_id, status);
CREATE INDEX idx_venue_claim_pending 
    ON commander_venue_claim_requests(status, submitted_at) WHERE status IN ('pending','reviewing');
-- Only one active claim request per user + venue
CREATE UNIQUE INDEX idx_venue_claim_unique_active 
    ON commander_venue_claim_requests(venue_id, claimant_user_id) 
    WHERE status IN ('pending','reviewing');

ALTER TABLE commander_venue_claim_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY venue_claims_own_select ON commander_venue_claim_requests
  FOR SELECT TO authenticated USING (claimant_user_id = auth.uid());
CREATE POLICY venue_claims_own_insert ON commander_venue_claim_requests
  FOR INSERT TO authenticated WITH CHECK (claimant_user_id = auth.uid());
CREATE POLICY venue_claims_own_update_withdraw ON commander_venue_claim_requests
  FOR UPDATE TO authenticated 
    USING (claimant_user_id = auth.uid() AND status IN ('pending','reviewing'))
    WITH CHECK (claimant_user_id = auth.uid() AND status = 'withdrawn');

-- RPC: Submit venue claim
CREATE OR REPLACE FUNCTION public.submit_venue_claim(
    p_venue_id          integer,
    p_caller_user_id    uuid,
    p_claim_role        text,
    p_business_name     text DEFAULT NULL,
    p_business_email    text DEFAULT NULL,
    p_business_phone    text DEFAULT NULL,
    p_evidence_urls     text[] DEFAULT NULL,
    p_evidence_notes    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_venue RECORD; v_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_claim_role NOT IN ('owner','manager','marketing_manager','poker_room_manager') THEN RAISE EXCEPTION 'INVALID_CLAIM_ROLE'; END IF;

    SELECT * INTO v_venue FROM poker_venues WHERE id = p_venue_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;
    IF v_venue.is_claimed = true AND v_venue.claimed_by IS NOT NULL AND v_venue.claimed_by <> p_caller_user_id 
    THEN RAISE EXCEPTION 'VENUE_ALREADY_CLAIMED'; END IF;

    INSERT INTO commander_venue_claim_requests (
        venue_id, claimant_user_id, claim_role,
        business_name, business_email, business_phone,
        evidence_urls, evidence_notes
    ) VALUES (
        p_venue_id, p_caller_user_id, p_claim_role,
        p_business_name, p_business_email, p_business_phone,
        p_evidence_urls, p_evidence_notes
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'claim_id', v_id, 'venue_id', p_venue_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.submit_venue_claim(integer, uuid, text, text, text, text, text[], text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.submit_venue_claim(integer, uuid, text, text, text, text, text[], text) TO authenticated, service_role;

-- RPC: Withdraw own claim
CREATE OR REPLACE FUNCTION public.withdraw_venue_claim(
    p_claim_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_claim RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_claim FROM commander_venue_claim_requests WHERE id = p_claim_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;
    IF v_claim.claimant_user_id <> p_caller_user_id THEN RAISE EXCEPTION 'NOT_YOUR_CLAIM'; END IF;
    IF v_claim.status NOT IN ('pending','reviewing') THEN RAISE EXCEPTION 'CANNOT_WITHDRAW'; END IF;

    UPDATE commander_venue_claim_requests 
       SET status = 'withdrawn', reviewed_at = NOW()
     WHERE id = p_claim_id;

    RETURN jsonb_build_object('success', true);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.withdraw_venue_claim(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.withdraw_venue_claim(uuid, uuid) TO authenticated, service_role;

-- RPC: Admin approves — marks venue as claimed, elevates user
CREATE OR REPLACE FUNCTION public.approve_venue_claim(
    p_claim_id        uuid,
    p_reviewer_id     uuid,
    p_reviewer_note   text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_claim RECORD;
BEGIN
    SELECT * INTO v_claim FROM commander_venue_claim_requests WHERE id = p_claim_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;
    IF v_claim.status NOT IN ('pending','reviewing') THEN RAISE EXCEPTION 'ALREADY_REVIEWED'; END IF;

    -- Mark claim approved
    UPDATE commander_venue_claim_requests
       SET status = 'approved', reviewer_id = p_reviewer_id, 
           reviewer_note = p_reviewer_note, reviewed_at = NOW()
     WHERE id = p_claim_id;

    -- Mark venue as claimed
    UPDATE poker_venues 
       SET is_claimed = true, 
           claimed_by = v_claim.claimant_user_id, 
           claimed_at = NOW(),
           primary_contact_id = COALESCE(primary_contact_id, v_claim.claimant_user_id)
     WHERE id = v_claim.venue_id;

    -- Auto-reject other pending claims on this venue (losing duplicates)
    UPDATE commander_venue_claim_requests 
       SET status = 'duplicate', reviewer_id = p_reviewer_id, reviewed_at = NOW(),
           reviewer_note = COALESCE(reviewer_note, 'Superseded by approved claim ' || p_claim_id::text)
     WHERE venue_id = v_claim.venue_id 
       AND id <> p_claim_id 
       AND status IN ('pending','reviewing');

    RETURN jsonb_build_object('success', true, 'venue_id', v_claim.venue_id, 'claimant_user_id', v_claim.claimant_user_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.approve_venue_claim(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.approve_venue_claim(uuid, uuid, text) TO service_role;
