-- 20261023165614_daily_digest_counts_phone_verification_honestly.sql
--
-- THE DAILY DIGEST COUNTS PHONE VERIFICATION HONESTLY (2026-10-23)
--
-- DailyDigest.phone_verification_low for Thursday Oct 22 said "Only 4 of 10
-- new players verified their phone" beside growth.otp_codes_sent = 1. Both
-- figures were wrong in different ways:
--
--   1. otp_codes_sent counted rows in public.sms_otp_codes, a scratch table:
--      /api/sms/verify-otp deletes a code the moment it is used and
--      /api/sms/send-otp purges every expired code on each send. Only codes
--      nobody ever entered survive until the digest runs. Twilio's own record
--      shows 11 codes delivered in the Oct 22 Central day (0 failures); the
--      digest saw the 1 that was never used. The send route now writes one row
--      per send attempt to public.sms_otp_send_log (no phone number, no code),
--      and the digest counts that: codes sent and send failures.
--
--   2. The rate's denominator was every real signup, including players who
--      cannot or need not verify: phone verification is US only, and a player
--      the owner already paid the welcome package by hand (signup:<uid> in the
--      Mint register while unverified - Rocking64, Canada; WooWoo, whose
--      confirmation email never arrived) has nothing left to claim. The digest
--      now reports signups_phone_eligible (verified, or US with the package
--      still waiting on the phone) and signups_phone_skipped, and the
--      attention rule measures verified against eligible. A failed send is its
--      own warning (phone_otp_send_failed).
--
-- Both function rewrites are exact substitutions that refuse if the text they
-- replace has moved, and are skipped if already applied. One transaction.

-- @live-proof: position('sms_otp_send_log' IN pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)) > 0 AND position('signups_phone_eligible' IN pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure)) > 0

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS public.sms_otp_send_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  purpose text NOT NULL CHECK (purpose IN ('phone_verify', 'mfa')),
  outcome text NOT NULL CHECK (outcome IN ('sent', 'failed', 'rate_limited')),
  user_id uuid,
  provider_error_code text
);
COMMENT ON TABLE public.sms_otp_send_log IS
  'One row per SMS verification code send attempt (no phone number, no code). sms_otp_codes is a scratch store whose rows are deleted on use, so it cannot count sends. Written by /api/sms/send-otp; read by fn_sp_daily_metrics_compute.';
CREATE INDEX IF NOT EXISTS sms_otp_send_log_created_idx ON public.sms_otp_send_log (created_at);
ALTER TABLE public.sms_otp_send_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_otp_send_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.sms_otp_send_log TO service_role;

DO $mig$
DECLARE
  v_old_m text := $q$'otp_codes_sent', (SELECT count(*) FROM public.sms_otp_codes WHERE created_at >= s AND created_at < e),$q$;
  v_new_m text := $q$'otp_codes_sent', (SELECT count(*) FROM public.sms_otp_send_log WHERE purpose = 'phone_verify' AND outcome = 'sent' AND created_at >= s AND created_at < e),
    'otp_send_failures', (SELECT count(*) FROM public.sms_otp_send_log WHERE purpose = 'phone_verify' AND outcome = 'failed' AND created_at >= s AND created_at < e),
    /* WHO CAN STILL EARN THE WELCOME PACKAGE BY PHONE (2026-10-23): verified,
       or a US player whose package is not already in the Mint register.
       Phone verification is US only; an owner grant leaves nothing to claim. */
    'signups_phone_eligible', (SELECT count(*) FROM hu JOIN public.profiles pp ON pp.id = hu.id
                                WHERE hu.created_at >= s AND hu.created_at < e
                                  AND (hu.phone_verified
                                       OR ((pp.country IS NULL OR pp.country IN ('United States', 'US'))
                                           AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger ml WHERE ml.op_id = 'signup:' || hu.id::text)))),
    'signups_phone_skipped', (SELECT count(*) FROM hu JOIN auth.users au ON au.id = hu.id
                               WHERE hu.created_at >= s AND hu.created_at < e AND NOT hu.phone_verified
                                 AND au.raw_user_meta_data ? 'phone_prompt_dismissed_at'),$q$;
  v_old_decl text := $q$  v numeric; v2 numeric; avg7 numeric; t text; r record;$q$;
  v_new_decl text := $q$  v numeric; v2 numeric; avg7 numeric; t text; r record; v_elig numeric;$q$;
  v_old_a text := $q$  IF v >= 2 AND v2 < v * public.fn_sp_setting('phone_verify_min_rate',0.5) THEN
    a := a || jsonb_build_object('rule','phone_verification_low','severity','warning',
      'title', format('Only %s of %s new players verified their phone', v2, v), 'detail', jsonb_build_object('signups', v, 'verified', v2));
  END IF;$q$;
  v_new_a text := $q$  -- Measured against players who can still earn the package by phone
  -- (US, not already paid by hand); older metrics without the figure fall
  -- back to every signup.
  v_elig := COALESCE((p_metrics#>>'{growth,signups_phone_eligible}')::numeric, v);
  IF v_elig >= 2 AND v2 < v_elig * public.fn_sp_setting('phone_verify_min_rate',0.5) THEN
    a := a || jsonb_build_object('rule','phone_verification_low','severity','warning',
      'title', format('Only %s of %s eligible new players verified their phone (%s skipped the offer)', v2, v_elig,
                      COALESCE((p_metrics#>>'{growth,signups_phone_skipped}')::numeric, 0)),
      'detail', jsonb_build_object('signups', v, 'eligible', v_elig, 'verified', v2,
                                   'skipped', (p_metrics#>>'{growth,signups_phone_skipped}')::numeric,
                                   'otp_codes_sent', (p_metrics#>>'{growth,otp_codes_sent}')::numeric));
  END IF;
  IF COALESCE((p_metrics#>>'{growth,otp_send_failures}')::numeric, 0) > 0 THEN
    a := a || jsonb_build_object('rule','phone_otp_send_failed','severity','warning',
      'title', format('%s phone verification codes failed to send', (p_metrics#>>'{growth,otp_send_failures}')::numeric),
      'detail', jsonb_build_object('failed', (p_metrics#>>'{growth,otp_send_failures}')::numeric,
                                   'sent', (p_metrics#>>'{growth,otp_codes_sent}')::numeric));
  END IF;$q$;
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure);
  IF position('sms_otp_send_log' IN v_def) = 0 THEN
    IF position(v_old_m IN v_def) = 0 THEN
      RAISE EXCEPTION 'fn_sp_daily_metrics_compute no longer contains the otp_codes_sent expression this migration rewrites';
    END IF;
    EXECUTE replace(v_def, v_old_m, v_new_m);
  END IF;

  v_def := pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure);
  IF position('signups_phone_eligible' IN v_def) = 0 THEN
    IF position(v_old_a IN v_def) = 0 OR position(v_old_decl IN v_def) = 0 THEN
      RAISE EXCEPTION 'fn_sp_digest_attention no longer contains the phone_verification_low rule this migration rewrites';
    END IF;
    EXECUTE replace(replace(v_def, v_old_decl, v_new_decl), v_old_a, v_new_a);
  END IF;
END $mig$;

COMMIT;
