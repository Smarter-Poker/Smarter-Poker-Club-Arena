-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831103651; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 20260831_ledger_trigger_stops_inventing_the_treasury.sql
-- TIER 3. See repo file for full rationale + ROLLBACK.

DO $preflight$
DECLARE
  v_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'club_members'
      AND t.tgname  = 'trg_club_members_audit_chip_movement'
      AND t.tgenabled = 'O'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'PRE-FLIGHT: trg_club_members_audit_chip_movement is missing or disabled.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_club_members_ledger_writer'
      AND p.prosrc LIKE '%club_treasury%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'PRE-FLIGHT: fn_club_members_ledger_writer() is not the version this migration was written against.';
  END IF;

  IF to_regclass('public.ca_ledger_write_failures') IS NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: ca_ledger_write_failures is missing.';
  END IF;

  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.chip_ledger'::regclass
         AND conname IN ('chip_ledger_from_type_check','chip_ledger_to_type_check')) <> 2 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: expected both chip_ledger type CHECK constraints to exist.';
  END IF;
END;
$preflight$;

ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_from_type_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_from_type_check
  CHECK (from_type = ANY (ARRAY[
    'player_wallet','club_treasury','union_bank','agent_wallet',
    'system_mint','system_burn','table_stack'])) NOT VALID;

ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_to_type_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_to_type_check
  CHECK (to_type = ANY (ARRAY[
    'player_wallet','club_treasury','union_bank','agent_wallet',
    'system_mint','system_burn','table_stack'])) NOT VALID;

CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'table_stack');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text);

  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, to_type, to_entity_id,
         amount, category, club_id, tournament_id, description)
      VALUES (
        actor,
        CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
        CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
        CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
        CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
        abs(d), 'adjustment', NEW.club_id, tid,
        'auto-audited club_members.chip_balance delta ' || d::text
          || ' (category ' || cat || ' rejected)');
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.chip_ledger
          (performed_by, from_type, from_entity_id, to_type, to_entity_id,
           amount, category, club_id, tournament_id, description)
        VALUES (
          actor,
          CASE WHEN d > 0 THEN 'table_stack'   ELSE 'player_wallet' END,
          CASE WHEN d > 0 THEN NULL            ELSE NEW.user_id     END,
          CASE WHEN d > 0 THEN 'player_wallet' ELSE 'table_stack'   END,
          CASE WHEN d > 0 THEN NEW.user_id     ELSE NULL            END,
          abs(d), 'adjustment', NEW.club_id, tid,
          'auto-audited club_members.chip_balance delta ' || d::text
            || ' (category ' || cat || ' and counterparty ' || cp || ' rejected)');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
        BEGIN
          INSERT INTO public.ca_ledger_write_failures
            (club_id, user_id, delta, sqlstate, message)
          VALUES (NEW.club_id, NEW.user_id, d, st, msg);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END;
    END;
  END;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_club_members_ledger_writer() IS
  'chip_ledger writer for club_members.chip_balance deltas. The counterparty is DECLARED by the caller via app.ledger_counterparty / app.ledger_counterparty_entity and defaults to table_stack; it is never inferred. Never raises, never blocks a chip movement: three-step retry, then ca_ledger_write_failures.';

ALTER TABLE public.chip_ledger VALIDATE CONSTRAINT chip_ledger_from_type_check;
ALTER TABLE public.chip_ledger VALIDATE CONSTRAINT chip_ledger_to_type_check;

DO $postapply$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_members_ledger_writer';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POST-APPLY: fn_club_members_ledger_writer() is gone.';
  END IF;

  IF v_src LIKE '%club_treasury%' THEN
    RAISE EXCEPTION 'POST-APPLY: the trigger body still mentions club_treasury.';
  END IF;

  IF v_src NOT LIKE '%app.ledger_counterparty%' THEN
    RAISE EXCEPTION 'POST-APPLY: the trigger body does not read app.ledger_counterparty.';
  END IF;

  IF v_src NOT LIKE '%ca_ledger_write_failures%' THEN
    RAISE EXCEPTION 'POST-APPLY: the never-block failure sink was lost in the rewrite.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'club_members'
      AND t.tgname = 'trg_club_members_audit_chip_movement'
      AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'POST-APPLY: trg_club_members_audit_chip_movement is missing or disabled.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_from_type_check'
       AND convalidated
       AND pg_get_constraintdef(oid) LIKE '%table_stack%') THEN
    RAISE EXCEPTION 'POST-APPLY: chip_ledger_from_type_check does not admit table_stack, or is not validated.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_to_type_check'
       AND convalidated
       AND pg_get_constraintdef(oid) LIKE '%table_stack%') THEN
    RAISE EXCEPTION 'POST-APPLY: chip_ledger_to_type_check does not admit table_stack, or is not validated.';
  END IF;

  RAISE NOTICE 'POST-APPLY OK: counterparty is declared, not invented.';
END;
$postapply$;
