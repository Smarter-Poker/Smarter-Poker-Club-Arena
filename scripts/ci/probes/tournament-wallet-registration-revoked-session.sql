-- Disposable PostgreSQL rehearsal only. The public wallet-funded tournament
-- registration door must reject a revoked authenticated session before it
-- reaches tournament locks, wallet money, a roster row, or refund evidence.
-- The final PASS exception deliberately rolls every probe definition back.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.fn_register_for_tournament(uuid)') IS NULL
     OR to_regprocedure('public.fn_caller_session_is_live()') IS NULL
     OR to_regclass('public.wallet_transactions') IS NULL
     OR to_regclass('public.tournament_players') IS NULL
     OR to_regclass('public.tournament_refund_entitlements') IS NULL THEN
    RAISE EXCEPTION
      'revoked-session registration probe requires a disposable tournament rehearsal database';
  END IF;
END;
$fixture_guard$;

CREATE TABLE IF NOT EXISTS auth.sessions(
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  not_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $probe_auth$
  SELECT '92000000-0000-4000-8000-000000000001'::uuid
$probe_auth$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $probe_auth$
  SELECT 'authenticated'::text
$probe_auth$;

SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","session_id":"92000000-0000-4000-8000-000000000002"}',
  true
);

DO $revoked_session$
DECLARE
  v_sqlstate text;
BEGIN
  BEGIN
    PERFORM public.fn_register_for_tournament(
      '92000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'revoked wallet registration was accepted';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    v_sqlstate := SQLSTATE;
  END;

  IF v_sqlstate IS DISTINCT FROM '28000' THEN
    RAISE EXCEPTION 'FAIL revoked registration returned SQLSTATE %',v_sqlstate;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id='92000000-0000-4000-8000-000000000003'
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players p
        WHERE p.tournament_id='92000000-0000-4000-8000-000000000003'
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id='92000000-0000-4000-8000-000000000003'
     ) THEN
    RAISE EXCEPTION 'FAIL revoked registration created entry or financial evidence';
  END IF;
END;
$revoked_session$;

DO $pass$
BEGIN
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: revoked authenticated wallet registration failed before tournament lookup, money, roster, or refund evidence; all probe work rolled back';
END;
$pass$;
