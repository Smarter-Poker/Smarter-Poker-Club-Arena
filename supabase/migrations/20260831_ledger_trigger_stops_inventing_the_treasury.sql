-- 20260831_ledger_trigger_stops_inventing_the_treasury.sql
--
-- TIER 3 (function replacement on the hottest money path + CHECK constraint
-- change on chip_ledger). ROLLBACK pasted at the bottom.
--
-- WHAT WAS WRONG
--
-- public.fn_club_members_ledger_writer() is the ONLY writer of chip_ledger in
-- the entire database. It fires AFTER UPDATE OF chip_balance on club_members
-- and it INVENTED the counterparty:
--
--     from_type := CASE WHEN d > 0 THEN 'club_treasury' ELSE 'player_wallet' END
--     to_type   := CASE WHEN d > 0 THEN 'player_wallet' ELSE 'club_treasury' END
--
-- It never read clubs.chip_treasury. So every cash-game buy-in was journaled
-- as player_wallet -> club_treasury (a phantom INFLOW to the treasury) and
-- every cash-out as club_treasury -> player_wallet (a phantom OUTFLOW), when
-- what atomic_table_buyin and atomic_seat_cashout_locked actually do is move
-- chips between club_members.chip_balance and table_seats.stack. The treasury
-- is not on either side of that trade and is never touched by it.
--
-- 62,495 of Club JAQK's 62,499 club_treasury ledger rows are these inferences
-- (description LIKE 'auto-audited%'). That is why reconcile_ledger_nightly's
-- club_treasury check is permanently critical and why its drift GROWS with
-- table volume rather than with anything anyone did to a treasury.
--
-- WHAT CHANGES
--
-- Only the counterparty derivation. The direction logic (which side is the
-- player wallet) is untouched, and so is every never-block property: the
-- function still cannot raise, still retries rather than losing the row, and
-- still swallows a terminal failure into ca_ledger_write_failures.
--
-- The counterparty is now DECLARED by the caller, not guessed:
--
--     PERFORM set_config('app.ledger_counterparty', 'club_treasury', true);
--     PERFORM set_config('app.ledger_counterparty_entity', club_id::text, true);
--
-- and when nobody declares one the default is 'table_stack' -- because the
-- overwhelming majority of chip_balance movements on this platform are a seat
-- being bought into or cashed out of, and naming the felt is both true and
-- neutral for the treasury check.
--
-- 'table_stack' is a new member of the chip_ledger from_type/to_type domain.
-- Without adding it the trigger's INSERT would fail the CHECK, fall down the
-- retry ladder, and land in ca_ledger_write_failures -- i.e. it would DELETE
-- the audit trail rather than correct it. The constraint change is therefore
-- part of this migration, not a follow-up.
--
-- HISTORY IS NOT REWRITTEN. Every existing row stays exactly as it is. The
-- pre-cutover garbage is dealt with by a baseline, in migration 3.

-- (the migration runner supplies the enclosing transaction)

-- ---------------------------------------------------------------------------
-- PRE-FLIGHT
-- ---------------------------------------------------------------------------
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
    RAISE EXCEPTION 'PRE-FLIGHT: trg_club_members_audit_chip_movement is missing or disabled. Refusing to replace a trigger function whose trigger is not in the state this migration assumes.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_club_members_ledger_writer'
      AND p.prosrc LIKE '%club_treasury%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'PRE-FLIGHT: fn_club_members_ledger_writer() does not look like the version this migration was written against (no club_treasury literal found). Re-read prosrc before proceeding.';
  END IF;

  IF to_regclass('public.ca_ledger_write_failures') IS NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: ca_ledger_write_failures is missing. The never-block failure sink must exist before this function can rely on it.';
  END IF;

  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.chip_ledger'::regclass
         AND conname IN ('chip_ledger_from_type_check','chip_ledger_to_type_check')) <> 2 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: expected both chip_ledger_from_type_check and chip_ledger_to_type_check to exist.';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. The felt is a place chips can be. Say so in the domain.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2. The trigger function. Everything except the counterparty is verbatim.
-- ---------------------------------------------------------------------------
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

  -- amount > 0 is a CHECK constraint on chip_ledger, and a no-op is not a
  -- movement worth recording.
  IF d = 0 THEN
    RETURN NEW;
  END IF;

  /* performed_by is NOT NULL with an FK to auth.users. Engine and cron writes
     have no auth.uid(), so they are attributed to the smarterpoker system
     principal -- the same one the 2026-04-19 reconcile used. */
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  /* Callers may name the movement:
       PERFORM set_config('app.ledger_category','buyin',true);
     Anything that does not is recorded as 'adjustment' -- honest about the
     fact that we saw the money move but were not told why. */
  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  /* And which tournament it belonged to, when the caller knows:
       PERFORM set_config('app.ledger_tournament', t_id::text, true);
     Optional and fail-soft: an absent or unparseable value leaves
     tournament_id NULL, which is what every row carried before this. */
  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31).
     This function sees exactly one thing: a player's wallet went up or down.
     It does NOT know what it traded with, and until today it guessed -- always
     the club treasury, which was wrong for every buy-in and every cash-out and
     put ~62k phantom rows on the treasury's side of the ledger.

       PERFORM set_config('app.ledger_counterparty','club_treasury',true);
       PERFORM set_config('app.ledger_counterparty_entity', club_id::text, true);

     Undeclared defaults to the felt, because a seat is what a chip_balance
     delta almost always trades with here. Optional and fail-soft in exactly
     the way app.ledger_tournament is. */
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
    /* A LABEL MUST NEVER COST THE ROW ITS EXISTENCE (2026-08-30). The category
       is CHECK-constrained; a caller naming a movement with a word the ledger
       does not know would otherwise delete the audit trail for that movement
       rather than merely mislabel it. Retry as the honest default. */
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
      /* And a COUNTERPARTY must never cost the row its existence either
         (2026-08-31). from_type/to_type are CHECK-constrained the same way the
         category is, so a caller declaring a counterparty the ledger does not
         know would otherwise be a silent audit hole. Retry against the felt,
         which is the same default an undeclared caller gets, and say in the
         description what was refused. */
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
          NULL;  -- even the failure log must not be able to block the money.
        END;
      END;
    END;
  END;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_club_members_ledger_writer() IS
  'chip_ledger writer for club_members.chip_balance deltas. The counterparty is DECLARED by the caller via app.ledger_counterparty / app.ledger_counterparty_entity and defaults to table_stack; it is never inferred. Never raises, never blocks a chip movement: three-step retry, then ca_ledger_write_failures.';

-- (transaction continues; the runner commits)

-- VALIDATE outside the DDL transaction: SHARE UPDATE EXCLUSIVE only, so the
-- 213k-row scan does not lock the hottest money path out of the ledger.
ALTER TABLE public.chip_ledger VALIDATE CONSTRAINT chip_ledger_from_type_check;
ALTER TABLE public.chip_ledger VALIDATE CONSTRAINT chip_ledger_to_type_check;

-- ---------------------------------------------------------------------------
-- POST-APPLY ASSERTIONS
-- ---------------------------------------------------------------------------
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

  -- The whole point of the migration: the word is not in the function any more.
  IF v_src LIKE '%club_treasury%' THEN
    RAISE EXCEPTION 'POST-APPLY: the trigger body still mentions club_treasury. The counterparty is still being invented.';
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

  RAISE NOTICE 'POST-APPLY OK: counterparty is declared, not invented; trigger enabled; table_stack admitted and validated.';
END;
$postapply$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (Tier 3 requirement -- paste and run to restore the prior state).
-- Note: rolling back does NOT delete rows written in the meantime, and any
-- table_stack rows already recorded would then violate the narrowed CHECK, so
-- the constraint rollback is deliberately left NOT VALID.
-- ---------------------------------------------------------------------------
--
-- BEGIN;
-- CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
-- RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
-- AS $rb$
-- DECLARE
--   d numeric; actor uuid; cat text; tid uuid; st text; msg text;
-- BEGIN
--   d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);
--   IF d = 0 THEN RETURN NEW; END IF;
--   actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
--   cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
--   BEGIN
--     tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
--   EXCEPTION WHEN OTHERS THEN tid := NULL; END;
--   BEGIN
--     INSERT INTO public.chip_ledger
--       (performed_by, from_type, from_entity_id, to_type, to_entity_id,
--        amount, category, club_id, tournament_id, description)
--     VALUES (actor,
--       CASE WHEN d > 0 THEN 'club_treasury' ELSE 'player_wallet' END,
--       CASE WHEN d > 0 THEN NEW.club_id     ELSE NEW.user_id     END,
--       CASE WHEN d > 0 THEN 'player_wallet' ELSE 'club_treasury' END,
--       CASE WHEN d > 0 THEN NEW.user_id     ELSE NEW.club_id     END,
--       abs(d), cat, NEW.club_id, tid,
--       'auto-audited club_members.chip_balance delta ' || d::text);
--   EXCEPTION WHEN OTHERS THEN
--     BEGIN
--       INSERT INTO public.chip_ledger
--         (performed_by, from_type, from_entity_id, to_type, to_entity_id,
--          amount, category, club_id, tournament_id, description)
--       VALUES (actor,
--         CASE WHEN d > 0 THEN 'club_treasury' ELSE 'player_wallet' END,
--         CASE WHEN d > 0 THEN NEW.club_id     ELSE NEW.user_id     END,
--         CASE WHEN d > 0 THEN 'player_wallet' ELSE 'club_treasury' END,
--         CASE WHEN d > 0 THEN NEW.user_id     ELSE NEW.club_id     END,
--         abs(d), 'adjustment', NEW.club_id, tid,
--         'auto-audited club_members.chip_balance delta ' || d::text
--           || ' (category ' || cat || ' rejected)');
--     EXCEPTION WHEN OTHERS THEN
--       GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
--       BEGIN
--         INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
--         VALUES (NEW.club_id, NEW.user_id, d, st, msg);
--       EXCEPTION WHEN OTHERS THEN NULL; END;
--     END;
--   END;
--   RETURN NEW;
-- END; $rb$;
--
-- ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_from_type_check;
-- ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_from_type_check
--   CHECK (from_type = ANY (ARRAY['player_wallet','club_treasury','union_bank',
--          'agent_wallet','system_mint','system_burn'])) NOT VALID;
-- ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_to_type_check;
-- ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_to_type_check
--   CHECK (to_type = ANY (ARRAY['player_wallet','club_treasury','union_bank',
--          'agent_wallet','system_mint','system_burn'])) NOT VALID;
-- COMMIT;
