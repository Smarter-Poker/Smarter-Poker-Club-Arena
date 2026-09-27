-- RESERVED CERTIFICATION IDENTITIES LEAVE THEIR LEDGER ACTOR TESTIMONY.
--
-- Creating a certification club correctly leaves immutable opening-grant
-- journal rows whose performed_by actor is the disposable certificate user.
-- Cleanup must not delete those movements, change an amount or balance, or
-- invent a replacement actor. Preserve each complete row in a private,
-- immutable archive, verify it byte-for-byte, and then detach only the live
-- foreign-key pointer before deleting the reserved Auth account.
--
-- New writes still require a real non-null actor. The only permitted actor
-- detachment is an UPDATE from a real actor to NULL while the exact guarded
-- certification cleanup maintenance reason is active and the matching whole
-- old row is already archived. Every other performed_by change is refused.
-- @live-proof: (SELECT to_regclass('public.ca_test_account_ledger_actor_archive') IS NOT NULL AND NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid='public.chip_ledger'::regclass AND attname='performed_by' AND NOT attisdropped) AND position('ca_test_account_ledger_actor_archive' in pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) > 0 AND position('certification-cleanup:%' in pg_get_functiondef('public.enforce_chip_ledger_performed_by()'::regprocedure)) > 0 AND NOT has_table_privilege('authenticated', 'public.ca_test_account_ledger_actor_archive', 'SELECT') AND has_function_privilege('service_role', 'public.cleanup_reserved_certification_account(uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.cleanup_reserved_certification_account(uuid)', 'EXECUTE'))

BEGIN;

SET LOCAL lock_timeout = '4s';

-- Acquire the only hot-table lock before this transaction creates or locks
-- any archive/catalog object. This fixed order prevents a schema observer
-- holding chip_ledger from deadlocking against the new archive relation.
LOCK TABLE public.chip_ledger IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.chip_ledger ALTER COLUMN performed_by DROP NOT NULL;

CREATE TABLE public.ca_test_account_ledger_actor_archive (
  ledger_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  actor_email text NOT NULL,
  ledger_row jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archive_reason text NOT NULL DEFAULT 'guarded_certification_account_deletion'
    CHECK (archive_reason = 'guarded_certification_account_deletion')
);

COMMENT ON TABLE public.ca_test_account_ledger_actor_archive IS
  'Immutable whole-row testimony for a chip_ledger actor detached only by the exact reserved certification-account cleanup door.';

ALTER TABLE public.ca_test_account_ledger_actor_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_test_account_ledger_actor_archive
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_test_account_ledger_actor_archive TO service_role;

CREATE FUNCTION public.fn_guard_test_account_ledger_actor_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Test-account ledger actor testimony is append-only';
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guard_test_account_ledger_actor_archive()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_ca_test_account_ledger_actor_archive_immutable
BEFORE UPDATE OR DELETE ON public.ca_test_account_ledger_actor_archive
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_test_account_ledger_actor_archive();

DO $preimage$
DECLARE
  v_trigger text;
BEGIN
  IF md5(pg_get_functiondef('public.enforce_chip_ledger_performed_by()'::regprocedure))
       <> 'ce4ab3013be283d66ab9afd1e861b552' THEN
    RAISE EXCEPTION 'CHIP_LEDGER_ACTOR_GUARD_PREIMAGE_CHANGED'
      USING ERRCODE = '55000';
  END IF;
  SELECT pg_get_triggerdef(t.oid)
    INTO v_trigger
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.chip_ledger'::regclass
     AND t.tgname = 'trg_chip_ledger_performed_by'
     AND NOT t.tgisinternal;
  IF v_trigger IS NULL OR v_trigger NOT LIKE
       'CREATE TRIGGER trg_chip_ledger_performed_by BEFORE INSERT ON public.chip_ledger%' THEN
    RAISE EXCEPTION 'CHIP_LEDGER_ACTOR_TRIGGER_PREIMAGE_CHANGED: %', v_trigger
      USING ERRCODE = '55000';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.enforce_chip_ledger_performed_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.performed_by IS NOT DISTINCT FROM OLD.performed_by THEN
      RETURN NEW;
    END IF;
    IF OLD.performed_by IS NOT NULL
       AND NEW.performed_by IS NULL
       AND v_reason LIKE 'certification-cleanup:%'
       AND EXISTS (
         SELECT 1
           FROM public.ca_test_account_ledger_actor_archive a
          WHERE a.ledger_id = OLD.id
            AND a.actor_id = OLD.performed_by
            AND a.ledger_row = to_jsonb(OLD)
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'chip_ledger.performed_by is immutable except after exact archived certification cleanup'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.performed_by IS NULL THEN
    RAISE EXCEPTION 'chip_ledger.performed_by must name a real user'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NEW.performed_by = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'chip_ledger.performed_by must be a real user, got all-zero sentinel'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_chip_ledger_performed_by()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_chip_ledger_performed_by() TO service_role;

DROP TRIGGER trg_chip_ledger_performed_by ON public.chip_ledger;
CREATE TRIGGER trg_chip_ledger_performed_by
BEFORE INSERT OR UPDATE OF performed_by ON public.chip_ledger
FOR EACH ROW EXECUTE FUNCTION public.enforce_chip_ledger_performed_by();

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES (
  'chip_ledger',
  'trg_chip_ledger_performed_by',
  'Create Club certification hardening: inserts still require a real actor; actor updates are refused except an exact reserved certification actor-to-null detachment after its complete old ledger row has been preserved in the immutable private archive.'
)
ON CONFLICT (table_name, trigger_name) DO UPDATE
SET note = EXCLUDED.note;

DO $patch$
DECLARE
  v_fn regprocedure := 'public.cleanup_reserved_certification_account(uuid)'::regprocedure;
  v_old text := pg_get_functiondef(v_fn);
  v_new text;
BEGIN
  IF md5(v_old) <> 'f525ae6f43f60a993524f9e43ecfba71' THEN
    RAISE EXCEPTION 'CERT_ACCOUNT_LEDGER_ACTOR_PREIMAGE_CHANGED: %', md5(v_old)
      USING ERRCODE = '55000';
  END IF;

  v_new := replace(
    v_old,
    $$  v_archived_count integer;$$,
    $$  v_archived_count integer;
  v_ledger_count integer;
  v_ledger_archived_count integer;$$
  );

  v_new := replace(
    v_new,
    $$  SELECT count(*) INTO v_audit_count
    FROM public.audit_trail WHERE actor_id = p_user_id;$$,
    $$  -- Refuse every financial row except the exact Create Club opening
  -- grant contract or one of the two pre-contract certification-only opening
  -- variants. Namespace admission alone is not enough: an unrelated mint or
  -- adjustment must keep its live actor and block account deletion.
  IF EXISTS (
    SELECT 1
      FROM public.chip_ledger l
     WHERE l.performed_by = p_user_id
       AND (
         l.hand_id IS NOT NULL
         OR l.table_id IS NOT NULL
         OR l.tournament_id IS NOT NULL
         OR l.status IS DISTINCT FROM 'posted'
         OR NOT (
           (
             l.category = 'mint'
             AND l.amount = 100000
             AND l.from_type IN ('issuance_reserve', 'system_mint')
             AND l.from_entity_id IS NULL
             AND l.to_type = 'club_treasury'
             AND l.to_entity_id = l.club_id
             AND l.idempotency_key IS NOT NULL
             AND l.idempotency_key ~
                   ('^club-opening-grant:' || l.club_id::text || '(:[0-9]+)?$')
           )
           OR (
             l.category = 'adjustment'
             AND l.amount = 100000
             AND l.idempotency_key IS NULL
             AND l.from_entity_id IS NULL
             AND (
               (
                 l.from_type = 'settlement_suspense'
                 AND l.to_type = 'club_treasury'
                 AND l.to_entity_id = l.club_id
               )
               OR (
                 l.from_type = 'table_stack'
                 AND l.to_type = 'player_wallet'
                 AND l.to_entity_id = p_user_id
               )
             )
           )
         )
         OR EXISTS (
           SELECT 1
             FROM public.accounting_tournament_fee_recognitions r
            WHERE r.bank_journal_id = l.id
         )
       )
  ) THEN
    RAISE EXCEPTION 'Reserved Certification Identity % Has Non-Club-Creation Ledger Evidence',
      p_user_id USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_ledger_count
    FROM public.chip_ledger WHERE performed_by = p_user_id;

  INSERT INTO public.ca_test_account_ledger_actor_archive
    (ledger_id, actor_id, actor_email, ledger_row)
  SELECT l.id, p_user_id, v_email, to_jsonb(l)
    FROM public.chip_ledger l
   WHERE l.performed_by = p_user_id
  ON CONFLICT (ledger_id) DO NOTHING;

  SELECT count(*) INTO v_ledger_archived_count
    FROM public.ca_test_account_ledger_actor_archive x
    JOIN public.chip_ledger l ON l.id = x.ledger_id
   WHERE x.actor_id = p_user_id
     AND x.actor_email = v_email
     AND x.ledger_row = to_jsonb(l)
     AND l.performed_by = p_user_id;
  IF v_ledger_archived_count <> v_ledger_count THEN
    RAISE EXCEPTION
      'Reserved Certification Ledger Actor Archive Copied % Of % Rows For %',
      v_ledger_archived_count, v_ledger_count, p_user_id;
  END IF;

  UPDATE public.chip_ledger
     SET performed_by = NULL
   WHERE performed_by = p_user_id;
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = p_user_id) THEN
    RAISE EXCEPTION 'Reserved Certification Ledger Actor % Was Not Detached', p_user_id;
  END IF;

  SELECT count(*) INTO v_audit_count
    FROM public.audit_trail WHERE actor_id = p_user_id;$$
  );

  IF v_new = v_old
     OR length(v_new) - length(replace(
          v_new, 'ca_test_account_ledger_actor_archive', ''))
        <> length('ca_test_account_ledger_actor_archive') * 2 THEN
    RAISE EXCEPTION 'CERT_ACCOUNT_LEDGER_ACTOR_PATCH_DID_NOT_ADD_EXACT_ARCHIVE_PATH'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE v_new;
END
$patch$;

REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;

COMMENT ON FUNCTION public.cleanup_reserved_certification_account(uuid) IS
  'Service-only removal for exact reserved certification identities. Complete audit rows and chip-ledger actor testimony are archived before the disposable identity is deleted; financial amounts and balances never change.';

COMMIT;
