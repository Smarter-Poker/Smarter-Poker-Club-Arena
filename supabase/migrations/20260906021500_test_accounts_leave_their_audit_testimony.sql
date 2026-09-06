-- A disposable certification player becomes undeletable the moment it joins
-- the fixture club: the membership audit correctly names that player as both
-- actor and target, while audit_trail.actor_id correctly RESTRICTS deletion.
-- The post-deploy harness therefore failed its cleanup after doing real work.
--
-- Do not solve that contradiction by erasing history. Move only audit rows
-- belonging to a fully guarded machine account into an immutable archive,
-- verify the copy, then let the existing account sweeper do its work. The
-- complete original row, actor id and email survive deletion and remain
-- queryable by service operators.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_test_account_audit_archive (
  audit_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  actor_email text NOT NULL,
  audit_row jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archive_reason text NOT NULL DEFAULT 'guarded_test_account_deletion'
    CHECK (archive_reason = 'guarded_test_account_deletion')
);

COMMENT ON TABLE public.ca_test_account_audit_archive IS
  'Immutable full-row testimony moved from audit_trail only when the guarded '
  'test-account sweeper deletes the synthetic actor. Never contains real-player rows.';

ALTER TABLE public.ca_test_account_audit_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_test_account_audit_archive FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_test_account_audit_archive TO service_role;

CREATE OR REPLACE FUNCTION public.fn_guard_test_account_audit_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Test-account audit testimony is append-only';
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guard_test_account_audit_archive()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ca_test_account_audit_archive_immutable
  ON public.ca_test_account_audit_archive;
CREATE TRIGGER trg_ca_test_account_audit_archive_immutable
BEFORE UPDATE OR DELETE ON public.ca_test_account_audit_archive
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_test_account_audit_archive();

-- Keep the battle-tested 572-FK deletion order intact. The public wrapper
-- below adds the one prerequisite it lacked; nobody may call the old body.
ALTER FUNCTION public.fn_sweep_test_account(uuid)
  RENAME TO fn_sweep_test_account_after_audit_archive;
REVOKE ALL ON FUNCTION public.fn_sweep_test_account_after_audit_archive(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_sweep_test_account(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text;
  v_is_horse boolean;
  v_chips numeric;
  v_audit_count integer;
  v_archived_count integer;
  v_result jsonb;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'platform_is_frozen');
  END IF;

  SELECT u.email, COALESCE(p.is_horse, false)
    INTO v_email, v_is_horse
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
   WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'already_removed');
  END IF;

  -- Repeat every safety gate that precedes the old audit refusal. Archiving
  -- must never become a side effect of a sweep the original body would deny.
  IF NOT (
       v_email ILIKE '%@probe.smarter.poker'
    OR v_email ILIKE '%@smarter-poker.invalid'
    OR v_email ILIKE '%@example.invalid'
    OR v_email ILIKE '%@yopmail.com'
    OR v_email ILIKE 'club-arena-%e2e%@smarter.poker'
    OR v_email ~ '^tester_[0-9a-f-]{36}@test\.com$'
    OR v_email ~ '^god_[0-9a-f-]{36}@test\.com$'
    OR v_email ~ '^logotest_[0-9_]+@example\.com$'
    OR v_email IN ('test@example.com', 'jetski_test_123@example.com')
  ) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'address_is_not_a_test_pattern');
  END IF;
  IF v_is_horse THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'is_a_horse');
  END IF;
  SELECT COALESCE(sum(chip_balance), 0) INTO v_chips
    FROM public.club_members WHERE user_id = p_user_id;
  IF v_chips > 0 THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'holds_club_chips', 'chips', v_chips);
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'is_seated');
  END IF;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'owns_a_club');
  END IF;
  IF EXISTS (SELECT 1 FROM public.diamond_purchases WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'bought_something_with_a_card');
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'acted_on_the_chip_ledger');
  END IF;

  SELECT count(*) INTO v_audit_count
    FROM public.audit_trail WHERE actor_id = p_user_id;

  INSERT INTO public.ca_test_account_audit_archive
    (audit_id, actor_id, actor_email, audit_row)
  SELECT a.id, p_user_id, v_email, to_jsonb(a)
    FROM public.audit_trail a
   WHERE a.actor_id = p_user_id
  ON CONFLICT (audit_id) DO NOTHING;

  SELECT count(*) INTO v_archived_count
    FROM public.ca_test_account_audit_archive x
   WHERE x.audit_id IN (
     SELECT a.id FROM public.audit_trail a WHERE a.actor_id = p_user_id
   );
  IF v_archived_count <> v_audit_count THEN
    RAISE EXCEPTION
      'Refusing test-account deletion: archived % of % audit rows for %',
      v_archived_count, v_audit_count, p_user_id;
  END IF;

  DELETE FROM public.audit_trail WHERE actor_id = p_user_id;

  v_result := public.fn_sweep_test_account_after_audit_archive(p_user_id);
  IF COALESCE((v_result->>'swept')::boolean, false) IS NOT TRUE
     AND v_result->>'reason' <> 'already_removed' THEN
    RAISE EXCEPTION 'Guarded account deletion failed after audit archive: %', v_result;
  END IF;

  RETURN v_result || jsonb_build_object('audit_rows_archived', v_audit_count);
END;
$function$;

COMMENT ON FUNCTION public.fn_sweep_test_account(uuid) IS
  'Deletes one fully guarded machine-generated account. Audit rows are copied '
  'whole into ca_test_account_audit_archive and verified before deletion; all '
  'value, seat, ownership, purchase, horse and chip-ledger refusals remain.';

REVOKE ALL ON FUNCTION public.fn_sweep_test_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_test_account(uuid) TO service_role;

COMMIT;
