-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420010139 "phase7_kyc_stub"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a3cb68e91fc581a555dcdd694463ac83 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7.1.4 — Identity & KYC stub
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds KYC columns to profiles + an audit trail table for webhook events.
-- For play-money launch, age_verified=true is the only gate. Real-money
-- deposits (when enabled) will require kyc_status='APPROVED'.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Profile columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (kyc_status IN ('NONE','PENDING','APPROVED','REJECTED','EXPIRED')),
  ADD COLUMN IF NOT EXISTS kyc_provider TEXT
    CHECK (kyc_provider IS NULL OR kyc_provider IN ('persona','veriff','jumio','onfido','stub')),
  ADD COLUMN IF NOT EXISTS kyc_inquiry_id TEXT,
  ADD COLUMN IF NOT EXISTS kyc_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS age_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS age_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS jurisdiction_country TEXT;

COMMENT ON COLUMN public.profiles.kyc_status IS 'Phase 7.1.4: NONE|PENDING|APPROVED|REJECTED|EXPIRED. Required APPROVED for real-money deposits.';
COMMENT ON COLUMN public.profiles.age_verified IS 'Phase 7.1.4: true after user confirms 18+ (jurisdiction-dependent). Required for play-money launch.';
COMMENT ON COLUMN public.profiles.jurisdiction_country IS 'Phase 7.1.4: ISO 3166-1 alpha-2 country code. Overrides profiles.country for compliance checks; falls back to country if NULL.';

-- Backfill jurisdiction_country from country where possible
UPDATE public.profiles
   SET jurisdiction_country = UPPER(SUBSTRING(country FROM 1 FOR 2))
 WHERE jurisdiction_country IS NULL
   AND country IS NOT NULL
   AND LENGTH(country) >= 2;

-- Index for the deposit gate (real-money path)
CREATE INDEX IF NOT EXISTS idx_profiles_kyc_status
  ON public.profiles (kyc_status)
  WHERE kyc_status IN ('PENDING','APPROVED','REJECTED');

-- 2) KYC event audit trail
CREATE TABLE IF NOT EXISTS public.kyc_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'inquiry_created','inquiry_started','inquiry_completed',
      'inquiry_approved','inquiry_rejected','inquiry_expired',
      'age_gate_passed','age_gate_failed',
      'status_overridden'
    )),
  provider TEXT,
  inquiry_id TEXT,
  payload JSONB,
  previous_status TEXT,
  new_status TEXT,
  source TEXT NOT NULL CHECK (source IN ('webhook','user_action','admin_override','stub')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kyc_events_user_id ON public.kyc_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_events_inquiry_id ON public.kyc_events (inquiry_id) WHERE inquiry_id IS NOT NULL;

ALTER TABLE public.kyc_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kyc_events_service_all ON public.kyc_events;
CREATE POLICY kyc_events_service_all ON public.kyc_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS kyc_events_user_select_own ON public.kyc_events;
CREATE POLICY kyc_events_user_select_own ON public.kyc_events
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS kyc_events_admin_select_all ON public.kyc_events;
CREATE POLICY kyc_events_admin_select_all ON public.kyc_events
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin','owner','super_agent')
  ));

COMMENT ON TABLE public.kyc_events IS 'Phase 7.1.4: immutable audit trail of KYC inquiry lifecycle and age-gate events. Source of truth for dispute resolution.';

-- 3) Start-a-KYC-inquiry RPC (stub — returns fake inquiry_id; swap body for Persona/Veriff call post-launch)
CREATE OR REPLACE FUNCTION public.fn_kyc_start_inquiry(
  p_user_id UUID,
  p_provider TEXT DEFAULT 'stub',
  p_jurisdiction_country TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inquiry_id TEXT;
  v_existing_status TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  IF p_provider NOT IN ('persona','veriff','jumio','onfido','stub') THEN
    RAISE EXCEPTION 'Unknown KYC provider: %', p_provider;
  END IF;

  SELECT kyc_status INTO v_existing_status FROM public.profiles WHERE id = p_user_id;
  IF v_existing_status = 'APPROVED' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'already_approved',
      'kyc_status', v_existing_status
    );
  END IF;

  -- Generate inquiry ID (stub: prefix with provider name + timestamp)
  v_inquiry_id := p_provider || '_' || to_char(now(), 'YYYYMMDDHH24MISSMS') || '_' ||
                  substr(md5(p_user_id::text || now()::text), 1, 12);

  UPDATE public.profiles
     SET kyc_status           = 'PENDING',
         kyc_provider         = p_provider,
         kyc_inquiry_id       = v_inquiry_id,
         jurisdiction_country = COALESCE(p_jurisdiction_country, jurisdiction_country, country),
         kyc_rejection_reason = NULL,
         kyc_completed_at     = NULL
   WHERE id = p_user_id;

  INSERT INTO public.kyc_events (user_id, event_type, provider, inquiry_id,
                                 previous_status, new_status, source, payload)
  VALUES (p_user_id, 'inquiry_created', p_provider, v_inquiry_id,
          COALESCE(v_existing_status, 'NONE'), 'PENDING', 'user_action',
          jsonb_build_object('stub', p_provider = 'stub'));

  RETURN jsonb_build_object(
    'ok', true,
    'inquiry_id', v_inquiry_id,
    'provider', p_provider,
    'kyc_status', 'PENDING',
    -- Stub: in production, this URL is returned by the provider's API
    'inquiry_url', 'https://stub.kyc.local/inquiry/' || v_inquiry_id,
    'is_stub', p_provider = 'stub'
  );
END;
$$;

-- 4) Resolve-KYC-inquiry RPC (called by webhook handler)
CREATE OR REPLACE FUNCTION public.fn_kyc_resolve_inquiry(
  p_inquiry_id TEXT,
  p_outcome TEXT,           -- approved | rejected | expired
  p_rejection_reason TEXT DEFAULT NULL,
  p_raw_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_prev_status TEXT;
  v_new_status TEXT;
  v_event_type TEXT;
BEGIN
  IF p_inquiry_id IS NULL OR p_outcome IS NULL THEN
    RAISE EXCEPTION 'p_inquiry_id and p_outcome are required';
  END IF;

  v_new_status := CASE lower(p_outcome)
    WHEN 'approved' THEN 'APPROVED'
    WHEN 'rejected' THEN 'REJECTED'
    WHEN 'expired'  THEN 'EXPIRED'
    ELSE NULL
  END;
  IF v_new_status IS NULL THEN
    RAISE EXCEPTION 'Invalid outcome: % (expected approved|rejected|expired)', p_outcome;
  END IF;

  v_event_type := CASE v_new_status
    WHEN 'APPROVED' THEN 'inquiry_approved'
    WHEN 'REJECTED' THEN 'inquiry_rejected'
    WHEN 'EXPIRED'  THEN 'inquiry_expired'
  END;

  SELECT id, kyc_status INTO v_user_id, v_prev_status
    FROM public.profiles
   WHERE kyc_inquiry_id = p_inquiry_id;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inquiry_not_found', 'inquiry_id', p_inquiry_id);
  END IF;

  UPDATE public.profiles
     SET kyc_status = v_new_status,
         kyc_completed_at = now(),
         kyc_rejection_reason = CASE WHEN v_new_status = 'REJECTED' THEN p_rejection_reason END
   WHERE id = v_user_id;

  INSERT INTO public.kyc_events (user_id, event_type, inquiry_id,
                                 previous_status, new_status, source, payload)
  VALUES (v_user_id, v_event_type, p_inquiry_id,
          v_prev_status, v_new_status, 'webhook', p_raw_payload);

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_user_id,
    'previous_status', v_prev_status,
    'new_status', v_new_status
  );
END;
$$;

-- 5) Age-gate RPC (called by signup / first-deposit flow)
CREATE OR REPLACE FUNCTION public.fn_set_age_verified(
  p_user_id UUID,
  p_jurisdiction_country TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  UPDATE public.profiles
     SET age_verified = true,
         age_verified_at = COALESCE(age_verified_at, now()),
         jurisdiction_country = COALESCE(p_jurisdiction_country, jurisdiction_country, country)
   WHERE id = p_user_id;

  INSERT INTO public.kyc_events (user_id, event_type, source, payload)
  VALUES (p_user_id, 'age_gate_passed', 'user_action',
          jsonb_build_object('jurisdiction_country', p_jurisdiction_country));

  RETURN jsonb_build_object('ok', true, 'age_verified', true);
END;
$$;

-- 6) Gate helper — callable from any RPC / API route
CREATE OR REPLACE FUNCTION public.fn_require_kyc_approved(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_age_verified BOOLEAN;
BEGIN
  SELECT kyc_status, age_verified INTO v_status, v_age_verified
    FROM public.profiles WHERE id = p_user_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'profile not found for user %', p_user_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'KYC not approved for user % (status=%, age_verified=%)',
      p_user_id, v_status, v_age_verified
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN true;
END;
$$;

-- 7) Play-money gate helper — just requires age_verified
CREATE OR REPLACE FUNCTION public.fn_require_age_verified(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_age_verified BOOLEAN;
BEGIN
  SELECT age_verified INTO v_age_verified FROM public.profiles WHERE id = p_user_id;
  IF v_age_verified IS NULL THEN
    RAISE EXCEPTION 'profile not found for user %', p_user_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT v_age_verified THEN
    RAISE EXCEPTION 'Age verification required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN true;
END;
$$;

-- 8) Verification
DO $$
DECLARE
  v_cols INT;
  v_fns INT;
  v_has_table BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema='public' AND table_name='profiles'
     AND column_name IN ('kyc_status','kyc_provider','kyc_inquiry_id','kyc_completed_at',
                         'kyc_rejection_reason','age_verified','age_verified_at','jurisdiction_country');
  IF v_cols <> 8 THEN
    RAISE EXCEPTION 'profiles KYC columns: expected 8, found %', v_cols;
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='kyc_events') INTO v_has_table;
  IF NOT v_has_table THEN RAISE EXCEPTION 'kyc_events table missing'; END IF;

  SELECT COUNT(*) INTO v_fns FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('fn_kyc_start_inquiry','fn_kyc_resolve_inquiry',
                       'fn_set_age_verified','fn_require_kyc_approved','fn_require_age_verified');
  IF v_fns <> 5 THEN RAISE EXCEPTION 'KYC functions: expected 5, found %', v_fns; END IF;

  RAISE NOTICE 'Phase 7.1.4 KYC stub installed: cols=% fns=% events_table=%', v_cols, v_fns, v_has_table;
END
$$;
