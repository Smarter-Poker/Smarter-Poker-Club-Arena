-- ARCHIVE AND RETIRE ONE EXACT PRE-ARCHIVE CERTIFICATION IDENTITY.
--
-- The September 6 certification signup a28421ff lost Auth/profile state during
-- the old non-atomic sweeper but retained public.users plus one signup failure.
-- Unlike the five clean August shadows, this identity also has immutable
-- diamond testimony: one profile-deletion row, one balance-audit row, four
-- incidents, and one archived journal row. Those financial rows must never be
-- deleted, rewritten, or detached from their original identity.
--
-- Preserve the complete public.users identity, signup diagnostic, profile
-- deletion testimony, and all six diamond rows in a private immutable snapshot
-- with no foreign key to a hot table. Verify every source as whole-row JSON,
-- refuse every other authority/custody surface, then delete only signup_errors
-- id 9105 and the exact public.users shadow. The financial testimony remains
-- byte-identical in its original tables.
-- @live-proof: (SELECT NOT public.fn_platform_frozen() AND to_regclass('public.ca_test_account_identity_archive') IS NOT NULL AND EXISTS (SELECT 1 FROM public.ca_test_account_identity_archive a WHERE a.identity_id='a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid AND md5(a.public_user_row::text)='0de97dc17503cdd1e1b4cd97cb03bd74' AND md5(a.diamond_balance_audit_rows::text)='774df5bcc15c39b338c42597c8fd544e' AND md5(a.diamond_incident_rows::text)='01fd90e79a651f8651e5b6ceed916e2b' AND md5(a.diamond_journal_archive_rows::text)='5884303966cf2c055b16e5b39f1926a2') AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id='a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid) AND NOT EXISTS (SELECT 1 FROM public.signup_errors e WHERE e.id=9105 AND e.user_id='a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid))

BEGIN;

SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '5min';

DO $preflight$
DECLARE
  v_id constant uuid := 'a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid;
  v_surface record;
  v_surface_exists boolean;
BEGIN
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_ARCHIVE_REFUSES_PLATFORM_FREEZE'
      USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.ca_test_account_identity_archive') IS NOT NULL
     OR to_regprocedure('public.fn_guard_test_account_identity_archive()') IS NOT NULL THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_ARCHIVE_ALREADY_PRESENT'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.users u
   WHERE u.id = v_id
     AND u.email = 'ca-customization-cert-postdeploy-1788659737460-da18c019-9c82-45d6-9fa1-d5e5a98f2a10@example.invalid'
     AND u.username = 'PostDeploya98f2'
     AND u.avatar_url IS NULL
     AND u.created_at = '2026-09-06T01:55:37.703383Z'::timestamptz
     AND u.updated_at = '2026-09-06T01:55:37.703383Z'::timestamptz
     AND length(to_jsonb(u)::text) = 309
     AND md5(to_jsonb(u)::text) = '0de97dc17503cdd1e1b4cd97cb03bd74'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_PUBLIC_USER_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*) FROM public.signup_errors e WHERE e.user_id = v_id) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.signup_errors e
        WHERE e.id = 9105
          AND e.user_id = v_id
          AND e.email = 'ca-customization-cert-postdeploy-1788659737460-da18c019-9c82-45d6-9fa1-d5e5a98f2a10@example.invalid'
          AND e.trigger_name = 'handle_new_user_v2_create_wallet'
          AND e.error_code = '55006'
          AND e.occurred_at = '2026-09-06T01:55:37.703383Z'::timestamptz
          AND e.raw_meta IS NULL
          AND e.forwarded_to_sentry = '2026-09-06T02:00:37.028Z'::timestamptz
          AND length(e.error_msg) = 132
          AND md5(e.error_msg) = '7d0f88ba3a6d0777977b4dce80dc072a'
          AND length(to_jsonb(e)::text) = 524
          AND md5(to_jsonb(e)::text) = '974f2f79005e7df290bf2ed4e1f364d5'
     ) THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_SIGNUP_ERROR_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*) FROM public.ca_profile_deletions p WHERE p.profile_id = v_id) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.ca_profile_deletions p
        WHERE p.id = 1627
          AND p.profile_id = v_id
          AND p.username = 'PostDeploya98f2'
          AND p.is_horse IS FALSE
          AND p.diamonds = 500
          AND p.diamond_balance = 500
          AND p.profile_created_at = '2026-09-06T01:55:37.703383Z'::timestamptz
          AND p.deleted_at = '2026-09-06T02:00:03.378099Z'::timestamptz
          AND p.deleted_by_role = 'postgres'
          AND p.application_name = 'PostgREST 14.5'
          AND length(to_jsonb(p)::text) = 334
          AND md5(to_jsonb(p)::text) = '03f600358c345cb9bcce9a39e6581cc4'
     ) THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_PROFILE_DELETION_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*) FROM public.ca_diamond_balance_audit d WHERE d.user_id = v_id) <> 1
     OR (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_balance_audit d WHERE d.user_id = v_id)
          IS DISTINCT FROM '774df5bcc15c39b338c42597c8fd544e'
     OR (SELECT length(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_balance_audit d WHERE d.user_id = v_id) <> 296
     OR (SELECT count(*) FROM public.ca_diamond_incidents d WHERE d.user_id = v_id) <> 4
     OR (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_incidents d WHERE d.user_id = v_id)
          IS DISTINCT FROM '01fd90e79a651f8651e5b6ceed916e2b'
     OR (SELECT length(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_incidents d WHERE d.user_id = v_id) <> 2385
     OR (SELECT count(*) FROM public.ca_diamond_journal_archive d WHERE d.user_id = v_id) <> 1
     OR (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_journal_archive d WHERE d.user_id = v_id)
          IS DISTINCT FROM '5884303966cf2c055b16e5b39f1926a2'
     OR (SELECT length(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_journal_archive d WHERE d.user_id = v_id) <> 737 THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_DIAMOND_TESTIMONY_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_id)
     OR EXISTS (SELECT 1 FROM auth.sessions WHERE user_id::text = v_id::text)
     OR EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id::text = v_id::text)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE id = v_id)
     OR EXISTS (SELECT 1 FROM public.ca_test_account_audit_archive WHERE actor_id = v_id)
     OR EXISTS (SELECT 1 FROM public.ca_test_account_ledger_actor_archive WHERE actor_id = v_id)
     OR EXISTS (SELECT 1 FROM public.audit_trail WHERE actor_id = v_id)
     OR EXISTS (SELECT 1 FROM public.club_members WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = v_id)
     OR EXISTS (SELECT 1 FROM public.unions WHERE owner_id = v_id)
     OR EXISTS (SELECT 1 FROM public.agents WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.table_seats WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.wallets WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.diamond_wallets WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.diamond_transactions WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.chip_transactions
                 WHERE from_user_id = v_id OR to_user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = v_id)
     OR EXISTS (SELECT 1 FROM public.client_shell_telemetry WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM storage.objects o
                 WHERE o.bucket_id = 'club-assets'
                   AND o.name LIKE 'club-logos/' || v_id::text || '%') THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_PROTECTED_SURFACE_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  FOR v_surface IN
    SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND a.atttypid = 'uuid'::regtype
       AND (
         a.attname = 'user_id'
         OR a.attname LIKE '%\_user\_id' ESCAPE '\'
         OR a.attname LIKE '%\_by' ESCAPE '\'
         OR a.attname IN (
           'player_id', 'player_a', 'player_b', 'actor', 'actor_id', 'owner_id',
           'recipient_id', 'sender_id', 'from_user_id', 'to_user_id', 'performed_by',
           'referrer_id', 'referee_id', 'challenger_id', 'challengee_id',
           'winner_id', 'loser_id', 'author_id', 'viewer_id', 'requester_id',
           'approver_id', 'caller_id', 'callee_id', 'caller_uid', 'jwt_sub'
         )
       )
       AND (c.relname, a.attname) NOT IN (
         ('signup_errors', 'user_id'),
         ('ca_diamond_balance_audit', 'user_id'),
         ('ca_diamond_incidents', 'user_id'),
         ('ca_diamond_journal_archive', 'user_id')
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_constraint fk
          WHERE fk.contype = 'f'
            AND fk.conrelid = c.oid
            AND a.attnum = ANY (fk.conkey)
       )
     ORDER BY c.relname, a.attname
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I = $1)',
      v_surface.table_name,
      v_surface.column_name
    ) INTO v_surface_exists USING v_id;
    IF v_surface_exists THEN
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_UNEXPECTED_SURFACE: %.%',
        v_surface.table_name, v_surface.column_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'public.users'::regclass AND NOT t.tgisinternal
     ) OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint fk
        WHERE fk.contype = 'f' AND fk.confrelid = 'public.users'::regclass
     ) THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_DELETE_GRAPH_CHANGED'
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

CREATE TABLE public.ca_test_account_identity_archive (
  identity_id uuid PRIMARY KEY,
  identity_email text NOT NULL,
  public_user_row jsonb NOT NULL,
  signup_error_row jsonb NOT NULL,
  profile_deletion_row jsonb NOT NULL,
  diamond_balance_audit_rows jsonb NOT NULL,
  diamond_incident_rows jsonb NOT NULL,
  diamond_journal_archive_rows jsonb NOT NULL,
  source_hashes jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archive_reason text NOT NULL DEFAULT 'guarded_prearchive_certification_identity_retirement'
    CHECK (archive_reason = 'guarded_prearchive_certification_identity_retirement')
);

COMMENT ON TABLE public.ca_test_account_identity_archive IS
  'Private immutable whole-row identity and financial-testimony snapshot for an exact Auth-less certification identity retired by a byte-pinned forward migration. Never contains a real-player row.';

ALTER TABLE public.ca_test_account_identity_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_test_account_identity_archive
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_test_account_identity_archive TO service_role;

CREATE FUNCTION public.fn_guard_test_account_identity_archive()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Test-account identity archive is append-only';
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guard_test_account_identity_archive()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_ca_test_account_identity_archive_immutable
BEFORE UPDATE OR DELETE ON public.ca_test_account_identity_archive
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_test_account_identity_archive();

INSERT INTO public.ca_test_account_identity_archive (
  identity_id, identity_email, public_user_row, signup_error_row,
  profile_deletion_row, diamond_balance_audit_rows, diamond_incident_rows,
  diamond_journal_archive_rows, source_hashes
)
SELECT
  u.id,
  u.email,
  to_jsonb(u),
  (SELECT to_jsonb(e) FROM public.signup_errors e WHERE e.id = 9105),
  (SELECT to_jsonb(p) FROM public.ca_profile_deletions p WHERE p.id = 1627),
  (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id)
     FROM public.ca_diamond_balance_audit d WHERE d.user_id = u.id),
  (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id)
     FROM public.ca_diamond_incidents d WHERE d.user_id = u.id),
  (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id)
     FROM public.ca_diamond_journal_archive d WHERE d.user_id = u.id),
  jsonb_build_object(
    'public_user_row', '0de97dc17503cdd1e1b4cd97cb03bd74',
    'signup_error_row', '974f2f79005e7df290bf2ed4e1f364d5',
    'profile_deletion_row', '03f600358c345cb9bcce9a39e6581cc4',
    'diamond_balance_audit_rows', '774df5bcc15c39b338c42597c8fd544e',
    'diamond_incident_rows', '01fd90e79a651f8651e5b6ceed916e2b',
    'diamond_journal_archive_rows', '5884303966cf2c055b16e5b39f1926a2'
  )
FROM public.users u
WHERE u.id = 'a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid
  AND md5(to_jsonb(u)::text) = '0de97dc17503cdd1e1b4cd97cb03bd74';

DO $retire$
DECLARE
  v_id constant uuid := 'a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid;
  v_deleted integer;
  v_archive public.ca_test_account_identity_archive%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_archive
    FROM public.ca_test_account_identity_archive a
   WHERE a.identity_id = v_id;

  IF md5(v_archive.public_user_row::text) <> '0de97dc17503cdd1e1b4cd97cb03bd74'
     OR md5(v_archive.signup_error_row::text) <> '974f2f79005e7df290bf2ed4e1f364d5'
     OR md5(v_archive.profile_deletion_row::text) <> '03f600358c345cb9bcce9a39e6581cc4'
     OR md5(v_archive.diamond_balance_audit_rows::text) <> '774df5bcc15c39b338c42597c8fd544e'
     OR md5(v_archive.diamond_incident_rows::text) <> '01fd90e79a651f8651e5b6ceed916e2b'
     OR md5(v_archive.diamond_journal_archive_rows::text) <> '5884303966cf2c055b16e5b39f1926a2'
     OR v_archive.source_hashes <> jsonb_build_object(
       'public_user_row', '0de97dc17503cdd1e1b4cd97cb03bd74',
       'signup_error_row', '974f2f79005e7df290bf2ed4e1f364d5',
       'profile_deletion_row', '03f600358c345cb9bcce9a39e6581cc4',
       'diamond_balance_audit_rows', '774df5bcc15c39b338c42597c8fd544e',
       'diamond_incident_rows', '01fd90e79a651f8651e5b6ceed916e2b',
       'diamond_journal_archive_rows', '5884303966cf2c055b16e5b39f1926a2'
     ) THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_ARCHIVE_COPY_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
        FROM public.ca_diamond_balance_audit d WHERE d.user_id = v_id)
       IS DISTINCT FROM '774df5bcc15c39b338c42597c8fd544e'
     OR (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_incidents d WHERE d.user_id = v_id)
       IS DISTINCT FROM '01fd90e79a651f8651e5b6ceed916e2b'
     OR (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_journal_archive d WHERE d.user_id = v_id)
       IS DISTINCT FROM '5884303966cf2c055b16e5b39f1926a2' THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_DIAMOND_TESTIMONY_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.signup_errors e
   WHERE e.id = 9105
     AND e.user_id = v_id
     AND length(to_jsonb(e)::text) = 524
     AND md5(to_jsonb(e)::text) = '974f2f79005e7df290bf2ed4e1f364d5';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_SIGNUP_DELETE_COUNT: %', v_deleted
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.users u
   WHERE u.id = v_id
     AND u.email = 'ca-customization-cert-postdeploy-1788659737460-da18c019-9c82-45d6-9fa1-d5e5a98f2a10@example.invalid'
     AND u.username = 'PostDeploya98f2'
     AND u.avatar_url IS NULL
     AND u.created_at = '2026-09-06T01:55:37.703383Z'::timestamptz
     AND u.updated_at = '2026-09-06T01:55:37.703383Z'::timestamptz
     AND length(to_jsonb(u)::text) = 309
     AND md5(to_jsonb(u)::text) = '0de97dc17503cdd1e1b4cd97cb03bd74';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_PUBLIC_USER_DELETE_COUNT: %', v_deleted
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE id = v_id)
     OR EXISTS (SELECT 1 FROM public.signup_errors WHERE user_id = v_id)
     OR (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_balance_audit d WHERE d.user_id = v_id)
       IS DISTINCT FROM '774df5bcc15c39b338c42597c8fd544e'
     OR (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_incidents d WHERE d.user_id = v_id)
       IS DISTINCT FROM '01fd90e79a651f8651e5b6ceed916e2b'
     OR (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY d.id)::text)
           FROM public.ca_diamond_journal_archive d WHERE d.user_id = v_id)
       IS DISTINCT FROM '5884303966cf2c055b16e5b39f1926a2' THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_IDENTITY_RETIREMENT_VERIFICATION_FAILED'
      USING ERRCODE = '55000';
  END IF;
END
$retire$;

COMMIT;
