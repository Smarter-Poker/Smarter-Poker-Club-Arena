-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423232435 "20260421084000_home_games_compliance_tos_age_jurisdiction"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fb26e0ee32714d978ddcd27a3aee2206 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PHASE 5 (GAP-D): Legal/compliance surface
--
-- Schema + RPC infrastructure to support:
--   • TOS acceptance log (versioned, auditable)
--   • Age self-attestation (≥18) + a flag to gate home-game actions
--   • Jurisdiction acknowledgement (player confirms home poker is legal
--     where they play) — liability-shifting disclosure
--   • Money-policy acknowledgement (player confirms platform does not
--     hold/transfer/process money)
--   • Responsible gaming resource links (declared in platform_policies
--     so clients can render consistent resources)
--
-- Design principle: the platform shifts liability by requiring explicit,
-- logged acknowledgements before allowing Home Games actions. UI work
-- (modal flows, acceptance screens) is separate and lives in the next
-- code deploy. DB is the source of truth.

BEGIN;

-- ═══ user_tos_acceptances ═════════════════════════════════════════════
-- Immutable append-only log of TOS / policy acceptances. Queried by
-- fn_user_has_accepted_home_games_terms below.

CREATE TABLE IF NOT EXISTS public.user_tos_acceptances (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  policy_key     text        NOT NULL,
  policy_version text        NOT NULL,
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  ip_address     inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per (user, policy_key, policy_version). Users can re-accept
-- newer versions; each is a new row in the log.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_tos_acceptances_user_policy_version
  ON public.user_tos_acceptances (user_id, policy_key, policy_version);

CREATE INDEX IF NOT EXISTS idx_user_tos_acceptances_user
  ON public.user_tos_acceptances (user_id, policy_key, accepted_at DESC);

ALTER TABLE public.user_tos_acceptances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_tos_acceptances_self_read ON public.user_tos_acceptances;
CREATE POLICY user_tos_acceptances_self_read ON public.user_tos_acceptances
  FOR SELECT USING (user_id = auth.uid());

-- No INSERT policy — all writes through SECURITY DEFINER RPC below.

-- ═══ profiles additions ═══════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS over_18_attested_at        timestamptz,
  ADD COLUMN IF NOT EXISTS jurisdiction_country       text,
  ADD COLUMN IF NOT EXISTS jurisdiction_region        text,
  ADD COLUMN IF NOT EXISTS jurisdiction_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS home_games_onboarded_at    timestamptz;

-- ═══ Policy keys that govern Home Games ═══════════════════════════════
INSERT INTO public.platform_policies (key, value, description) VALUES
  ('home_games.tos.version',
   '1.0',
   'Current TOS version required to use Home Games. Increment when materially changing terms; existing users must re-accept.'),
  ('home_games.tos.url',
   '/legal/home-games-terms',
   'Path to the Home Games Terms page.'),
  ('home_games.privacy.version',
   '1.0',
   'Current Privacy policy version.'),
  ('home_games.privacy.url',
   '/legal/privacy',
   'Path to the Privacy page.'),
  ('home_games.community_guidelines.version',
   '1.0',
   'Current community guidelines version.'),
  ('home_games.community_guidelines.url',
   '/legal/community-guidelines',
   'Path to the community guidelines page.'),
  ('home_games.minimum_age',
   '18',
   'Minimum age (in years) required to use Home Games. Self-attested at signup; no ID verification. Regional laws may require higher minimums; clients SHOULD enforce higher thresholds where applicable.'),
  ('home_games.jurisdiction.disclaimer',
   'Home poker games are legal in many jurisdictions but not all. You are responsible for ensuring the games you host or attend comply with the laws of your state, province, and municipality. Smarter Poker does not provide legal advice.',
   'Jurisdiction disclaimer shown to every user once at Home Games onboarding.'),
  ('home_games.responsible_gaming.url',
   'https://www.ncpgambling.org/help-treatment/',
   'External resource for problem-gambling help.'),
  ('home_games.responsible_gaming.hotline',
   '1-800-GAMBLER',
   'US problem-gambling hotline.')
ON CONFLICT (key) DO UPDATE
  SET value       = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at  = now();

-- ═══ fn_record_tos_acceptance ═════════════════════════════════════════
-- User-callable (authenticated). Records an acceptance row AND updates
-- derived columns on profiles where relevant.
CREATE OR REPLACE FUNCTION public.fn_record_tos_acceptance(
  p_caller_user_id uuid,
  p_policy_key     text,
  p_policy_version text,
  p_ip_address     inet DEFAULT NULL,
  p_user_agent     text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_expected_version text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_policy_key NOT IN (
    'home_games.tos',
    'home_games.privacy',
    'home_games.community_guidelines',
    'home_games.money_policy',
    'home_games.jurisdiction'
  ) THEN
    RAISE EXCEPTION 'INVALID_POLICY_KEY';
  END IF;

  -- Verify the version matches the CURRENT version the platform
  -- advertises (prevents clients from submitting stale versions).
  SELECT value INTO v_expected_version
    FROM public.platform_policies
   WHERE key = p_policy_key || '.version';
  IF v_expected_version IS NOT NULL AND v_expected_version <> p_policy_version THEN
    RAISE EXCEPTION 'STALE_POLICY_VERSION'
          USING HINT = 'current version is ' || v_expected_version;
  END IF;

  INSERT INTO public.user_tos_acceptances
    (user_id, policy_key, policy_version, ip_address, user_agent)
  VALUES
    (p_caller_user_id, p_policy_key, p_policy_version, p_ip_address, p_user_agent)
  ON CONFLICT (user_id, policy_key, policy_version) DO NOTHING
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success',      true,
    'acceptance_id', v_id,
    'policy_key',    p_policy_key,
    'policy_version', p_policy_version
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_record_tos_acceptance(uuid,text,text,inet,text) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_record_tos_acceptance(uuid,text,text,inet,text) TO authenticated;

-- ═══ fn_attest_over_18 ════════════════════════════════════════════════
-- User self-attests to being at least 18. Platform does not verify;
-- liability shifts to the user. One-way flag (can be re-set if age
-- verification becomes mandatory later but cannot be un-set by user).
CREATE OR REPLACE FUNCTION public.fn_attest_over_18(
  p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  UPDATE public.profiles
     SET over_18_attested_at = COALESCE(over_18_attested_at, now())
   WHERE id = p_caller_user_id;

  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_attest_over_18(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_attest_over_18(uuid) TO authenticated;

-- ═══ fn_set_user_jurisdiction ═════════════════════════════════════════
-- Records user's claimed jurisdiction. No validation; again, liability
-- shifts via the TOS acceptance flow that accompanies this.
CREATE OR REPLACE FUNCTION public.fn_set_user_jurisdiction(
  p_caller_user_id uuid,
  p_country_code   text,
  p_region         text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_country_code IS NULL OR length(trim(p_country_code)) < 2 THEN
    RAISE EXCEPTION 'COUNTRY_CODE_REQUIRED';
  END IF;
  IF length(p_country_code) > 8 THEN
    RAISE EXCEPTION 'COUNTRY_CODE_TOO_LONG';
  END IF;
  IF length(COALESCE(p_region, '')) > 64 THEN
    RAISE EXCEPTION 'REGION_TOO_LONG';
  END IF;

  UPDATE public.profiles
     SET jurisdiction_country       = upper(trim(p_country_code)),
         jurisdiction_region        = NULLIF(trim(COALESCE(p_region, '')), ''),
         jurisdiction_acknowledged_at = now()
   WHERE id = p_caller_user_id;

  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_set_user_jurisdiction(uuid,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_set_user_jurisdiction(uuid,text,text) TO authenticated;

-- ═══ fn_get_home_games_onboarding_status ══════════════════════════════
-- Single call that returns everything the client needs to decide whether
-- to show onboarding/acceptance screens. Called at Home Games feature
-- entry. Returns which acceptances are still required.
CREATE OR REPLACE FUNCTION public.fn_get_home_games_onboarding_status(
  p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profile RECORD;
  v_tos_v   text;
  v_priv_v  text;
  v_cg_v    text;
  v_money_v text;
  v_min_age int;
  v_needs jsonb := '[]'::jsonb;
  v_has_tos      boolean := false;
  v_has_priv     boolean := false;
  v_has_cg       boolean := false;
  v_has_money    boolean := false;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT id, over_18_attested_at, jurisdiction_country,
         jurisdiction_acknowledged_at, home_games_onboarded_at
    INTO v_profile
    FROM public.profiles WHERE id = p_caller_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_NOT_FOUND'; END IF;

  SELECT value INTO v_tos_v   FROM public.platform_policies WHERE key = 'home_games.tos.version';
  SELECT value INTO v_priv_v  FROM public.platform_policies WHERE key = 'home_games.privacy.version';
  SELECT value INTO v_cg_v    FROM public.platform_policies WHERE key = 'home_games.community_guidelines.version';
  SELECT value INTO v_money_v FROM public.platform_policies WHERE key = 'home_games.money_policy.version';
  SELECT value::int INTO v_min_age
    FROM public.platform_policies WHERE key = 'home_games.minimum_age';
  IF v_min_age IS NULL THEN v_min_age := 18; END IF;

  -- Check each acceptance
  SELECT EXISTS (SELECT 1 FROM public.user_tos_acceptances
                  WHERE user_id=p_caller_user_id AND policy_key='home_games.tos'
                    AND policy_version = v_tos_v) INTO v_has_tos;
  SELECT EXISTS (SELECT 1 FROM public.user_tos_acceptances
                  WHERE user_id=p_caller_user_id AND policy_key='home_games.privacy'
                    AND policy_version = v_priv_v) INTO v_has_priv;
  SELECT EXISTS (SELECT 1 FROM public.user_tos_acceptances
                  WHERE user_id=p_caller_user_id AND policy_key='home_games.community_guidelines'
                    AND policy_version = v_cg_v) INTO v_has_cg;
  SELECT EXISTS (SELECT 1 FROM public.user_tos_acceptances
                  WHERE user_id=p_caller_user_id AND policy_key='home_games.money_policy'
                    AND policy_version = v_money_v) INTO v_has_money;

  IF v_profile.over_18_attested_at IS NULL THEN
    v_needs := v_needs || jsonb_build_array('over_18_attestation');
  END IF;
  IF v_profile.jurisdiction_acknowledged_at IS NULL THEN
    v_needs := v_needs || jsonb_build_array('jurisdiction_acknowledgement');
  END IF;
  IF NOT v_has_tos      THEN v_needs := v_needs || jsonb_build_array('tos_acceptance');                  END IF;
  IF NOT v_has_priv     THEN v_needs := v_needs || jsonb_build_array('privacy_acceptance');              END IF;
  IF NOT v_has_cg       THEN v_needs := v_needs || jsonb_build_array('community_guidelines_acceptance'); END IF;
  IF NOT v_has_money    THEN v_needs := v_needs || jsonb_build_array('money_policy_acknowledgement');    END IF;

  -- Mark fully-onboarded if nothing still required
  IF jsonb_array_length(v_needs) = 0 AND v_profile.home_games_onboarded_at IS NULL THEN
    UPDATE public.profiles
       SET home_games_onboarded_at = now()
     WHERE id = p_caller_user_id;
  END IF;

  RETURN jsonb_build_object(
    'success',     true,
    'onboarded',   (jsonb_array_length(v_needs) = 0),
    'needs',       v_needs,
    'versions',    jsonb_build_object(
                     'tos',                  v_tos_v,
                     'privacy',              v_priv_v,
                     'community_guidelines', v_cg_v,
                     'money_policy',         v_money_v
                   ),
    'minimum_age', v_min_age,
    'current_attestations', jsonb_build_object(
       'over_18_at',                v_profile.over_18_attested_at,
       'jurisdiction_country',      v_profile.jurisdiction_country,
       'jurisdiction_region',       v_profile.jurisdiction_region,
       'jurisdiction_ack_at',       v_profile.jurisdiction_acknowledged_at
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_get_home_games_onboarding_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_get_home_games_onboarding_status(uuid) TO authenticated;

COMMIT;
