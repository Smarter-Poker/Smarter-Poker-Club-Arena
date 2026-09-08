-- 20260908030006_the_other_currencies_get_their_guards.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- PHASE 8 OF THE CHIP-ACCOUNTING PROGRAMME, roadmap 9.7, part two of two.
-- Part one (20260908030358_the_other_currencies_get_a_meter) built the meter
-- and rewrote fn_award_vip_credit to write its leg ONCE, final, so that a
-- guard forbidding updates can be attached to vip_points_ledger at all. Read
-- that migration's header for the measurements; this one attaches the guards.
--
-- WHY IT IS ITS OWN MIGRATION. CREATE TRIGGER takes ACCESS EXCLUSIVE on its
-- table, and vip_points_ledger and agent_commissions take a write on every
-- raked hand. Part one's proof scans 5.75M legs (10.2 s); holding these locks
-- for that long would have failed VIP awards outright, because the engine's
-- service_role carries an 8 s statement_timeout. Everything inside THIS
-- transaction is sub-second: four sanctioned refusals and one recorded
-- delete, all rolled back. The lock is taken up front, on every table at
-- once, with a timeout - a busy moment fails cleanly and is simply retried,
-- rather than deadlocking (the first attempt did, 40P01, at 02:19).
--
--   vip_points_ledger        no UPDATE at all, no DELETE outside the
--                            sanctioned maintenance path
--   agent_commissions        only settled_at, NULL -> a time, once
--   rakeback_period_payouts  only the payout's own bookkeeping; DELETE is
--                            ALLOWED because fn_close_settlement_period
--                            inserts the row as its idempotency claim before
--                            debiting the treasury and deletes it again on a
--                            shortfall - and every such delete is RECORDED in
--                            ca_ledger_mutation_log, which the meter counts
--   vip_points               moves only when a writer has declared itself for
--                            the transaction (app.vip_points_writer, which
--                            part one taught both writers to set), never
--                            negative, lifetime never shrinking
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- THE STRONGEST LOCK FIRST (handoff trap, 2026-09-07): CREATE TRIGGER on a
-- table the engine writes several times a second needs ACCESS EXCLUSIVE, and
-- taking it after other locks deadlocked the first apply (40P01) against an
-- in-flight award. Take every table this migration alters, up front, in one
-- statement, with a timeout so a busy moment fails cleanly and is retried
-- rather than deadlocking.
SET LOCAL lock_timeout = '25s';
LOCK TABLE public.vip_points_ledger, public.agent_commissions, public.rakeback_period_payouts, public.vip_points
  IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. The append-only guard learns three more journals.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
  v_j jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSIF TG_TABLE_NAME = 'vip_points_ledger' THEN
      /* Phase 8 (2026-09-08). A VIP leg is written once, final: the award
         writer no longer inserts 0 and updates it afterwards. Nothing on this
         table may change. */
      v_allowed_update := false;
    ELSIF TG_TABLE_NAME = 'agent_commissions' THEN
      /* Phase 8. A commission row is what was earned on one hand. The only
         thing that happens to it afterwards is being settled, once. */
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
        AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
        AND NEW.commission_rate IS NOT DISTINCT FROM OLD.commission_rate
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND (OLD.settled_at IS NULL OR NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at);
    ELSIF TG_TABLE_NAME = 'rakeback_period_payouts' THEN
      /* Phase 8. What was paid, to whom, for which period, never changes;
         status, paid_at, wallet_transaction_id and failure_reason are the
         payout's own bookkeeping. */
      v_allowed_update :=
        NEW.payout_amount IS NOT DISTINCT FROM OLD.payout_amount
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.rakeback_period_id IS NOT DISTINCT FROM OLD.rakeback_period_id
        AND NEW.currency IS NOT DISTINCT FROM OLD.currency
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  /* Phase 8. fn_close_settlement_period inserts a payout row as its
     idempotency claim BEFORE debiting the treasury and deletes it again on a
     shortfall, inside the same transaction. That is a compensation, not a
     mutation of history, so this table's DELETE is allowed - and RECORDED,
     every time, so a person can tell a compensation from a hand on the
     table. The meter counts these. */
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'rakeback_period_payouts' THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true),
            COALESCE(v_reason, 'rakeback-payout-delete: compensation on a treasury shortfall, or maintenance without app.ledger_maintenance'),
            to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', 'warning',
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- DR5. The diamond journal is deleted from on an hourly cadence by the
    -- certification fleet. Keep the row and say who took it. Nothing here can
    -- refuse the DELETE the branch above has already permitted.
    IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           (v_j->>'user_id')::uuid, v_reason)
        ON CONFLICT (id) DO NOTHING;

        PERFORM public.fn_ca_diamond_incident(
          'DR5:journal_row_deleted_under_maintenance', 'info',
          (v_j->>'user_id')::uuid, (v_j->>'amount')::numeric,
          'fn_ca_journal_append_only',
          jsonb_build_object('reason', v_reason,
                             'reference_id', v_j->>'reference_id',
                             'type', v_j->>'type',
                             'db_role', current_user));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row deleted under maintenance (%): %',
          v_reason, SQLERRM;
      END;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$;

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.vip_points_ledger;
CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public.vip_points_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();
DROP TRIGGER IF EXISTS trg_ca_append_only ON public.agent_commissions;
CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public.agent_commissions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();
DROP TRIGGER IF EXISTS trg_ca_append_only ON public.rakeback_period_payouts;
CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public.rakeback_period_payouts
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();

-- ---------------------------------------------------------------------------
-- 2. The VIP balance moves only with a leg.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_vip_points_move_only_with_a_leg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_writer text := NULLIF(current_setting('app.vip_points_writer', true), '');
BEGIN
  IF NEW.current_points < 0 THEN
    RAISE EXCEPTION 'vip_points.current_points cannot go negative (% for %)', NEW.current_points, NEW.user_id
      USING ERRCODE = 'P0403';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF (NEW.current_points <> 0 OR NEW.lifetime_points <> 0) AND v_writer IS NULL THEN
      RAISE EXCEPTION 'a vip_points row is born at zero unless a ledger writer (fn_award_vip_credit) creates it with its first leg'
        USING ERRCODE = 'P0403';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lifetime_points < OLD.lifetime_points THEN
    RAISE EXCEPTION 'vip_points.lifetime_points cannot shrink (% -> % for %)', OLD.lifetime_points, NEW.lifetime_points, NEW.user_id
      USING ERRCODE = 'P0403';
  END IF;
  IF (NEW.current_points IS DISTINCT FROM OLD.current_points OR NEW.lifetime_points IS DISTINCT FROM OLD.lifetime_points)
     AND v_writer IS NULL THEN
    RAISE EXCEPTION
      'vip_points for % moves only through fn_award_vip_credit or fn_redeem_vip_points, which write the leg in the same transaction. A balance with no leg is the defect this guard exists for.',
      NEW.user_id USING ERRCODE = 'P0403';
  END IF;
  RETURN NEW;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_vip_points_move_only_with_a_leg() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_vip_points_move_only_with_a_leg ON public.vip_points;
CREATE TRIGGER zz_vip_points_move_only_with_a_leg
  BEFORE INSERT OR UPDATE ON public.vip_points
  FOR EACH ROW EXECUTE FUNCTION public.fn_vip_points_move_only_with_a_leg();

-- ---------------------------------------------------------------------------
-- 3. PROVE IT, in this transaction, or abort it. Everything here is
--    sub-second: the lock is held for the length of five refusals.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_uid uuid; v_leg uuid; v_comm uuid; v_pay uuid; v_n int;
BEGIN
  -- nothing negative or inverted exists that the guard would now refuse to save
  IF EXISTS (SELECT 1 FROM public.vip_points WHERE current_points < 0 OR lifetime_points < current_points) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a vip_points row already violates the guard; read it before attaching';
  END IF;

  -- the guards are attached
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_ca_append_only'
        AND tgrelid IN ('public.vip_points_ledger'::regclass, 'public.agent_commissions'::regclass, 'public.rakeback_period_payouts'::regclass)) <> 3 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the append-only guard is not on all three journals';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_vip_points_move_only_with_a_leg' AND tgrelid = 'public.vip_points'::regclass) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the vip_points guard is not attached';
  END IF;

  -- a VIP leg cannot be edited or deleted by hand
  -- a COLD leg and a COLD account (11.5): never the busiest one
  SELECT id INTO v_leg FROM public.vip_points_ledger WHERE points <> 0 ORDER BY created_at ASC LIMIT 1;
  BEGIN
    UPDATE public.vip_points_ledger SET points = points + 1 WHERE id = v_leg;
    RAISE EXCEPTION 'VERIFY FAILED: a VIP leg was edited and nothing refused it';
  EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
  END;
  BEGIN
    DELETE FROM public.vip_points_ledger WHERE id = v_leg;
    RAISE EXCEPTION 'VERIFY FAILED: a VIP leg was deleted and nothing refused it';
  EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
  END;

  -- a VIP balance cannot move without a leg, go negative, or lose lifetime
  SELECT user_id INTO v_uid FROM public.vip_points WHERE current_points > 10 ORDER BY updated_at ASC LIMIT 1;
  BEGIN
    UPDATE public.vip_points SET current_points = current_points + 1 WHERE user_id = v_uid;
    RAISE EXCEPTION 'VERIFY FAILED: a VIP balance moved with no leg and nothing refused it';
  EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
  END;
  BEGIN
    PERFORM set_config('app.vip_points_writer', 'probe', true);
    UPDATE public.vip_points SET current_points = -1 WHERE user_id = v_uid;
    RAISE EXCEPTION 'VERIFY FAILED: a VIP balance went negative and nothing refused it';
  EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
  END;
  PERFORM set_config('app.vip_points_writer', '', true);
  -- bookkeeping is not a movement
  UPDATE public.vip_points SET updated_at = updated_at WHERE user_id = v_uid;

  -- a commission row: amount immutable, settled once, never deleted by hand
  SELECT id INTO v_comm FROM public.agent_commissions WHERE settled_at IS NULL ORDER BY created_at LIMIT 1;
  IF v_comm IS NOT NULL THEN
    BEGIN
      UPDATE public.agent_commissions SET amount = amount + 1 WHERE id = v_comm;
      RAISE EXCEPTION 'VERIFY FAILED: a commission amount was edited and nothing refused it';
    EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
    END;
    BEGIN
      DELETE FROM public.agent_commissions WHERE id = v_comm;
      RAISE EXCEPTION 'VERIFY FAILED: a commission row was deleted and nothing refused it';
    EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
    END;
    BEGIN
      UPDATE public.agent_commissions SET settled_at = now() WHERE id = v_comm;   -- allowed, once
      UPDATE public.agent_commissions SET settled_at = NULL WHERE id = v_comm;    -- refused
      RAISE EXCEPTION 'VERIFY FAILED: a settled commission was un-settled and nothing refused it';
    EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
    END;
  END IF;

  -- a payout row: amount immutable; a delete is allowed and recorded
  SELECT id INTO v_pay FROM public.rakeback_period_payouts ORDER BY created_at DESC LIMIT 1;
  IF v_pay IS NOT NULL THEN
    BEGIN
      UPDATE public.rakeback_period_payouts SET payout_amount = payout_amount + 1 WHERE id = v_pay;
      RAISE EXCEPTION 'VERIFY FAILED: a payout amount was edited and nothing refused it';
    EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
    END;
    BEGIN
      DELETE FROM public.rakeback_period_payouts WHERE id = v_pay;
      SELECT count(*) INTO v_n FROM public.ca_ledger_mutation_log WHERE source_table = 'rakeback_period_payouts' AND (old_row->>'id')::uuid = v_pay;
      IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY FAILED: a payout delete was not recorded'; END IF;
      RAISE EXCEPTION 'PROBE_ROLLBACK' USING ERRCODE = 'P0999';
    EXCEPTION WHEN SQLSTATE 'P0999' THEN NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM public.rakeback_period_payouts WHERE id = v_pay) THEN
      RAISE EXCEPTION 'VERIFY FAILED: the probe payout delete survived the rollback';
    END IF;
  END IF;

  -- part one's meter is here and still reads clean through the new guards
  IF to_regprocedure('public.fn_ca_currency_meter()') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: apply 20260908030358_the_other_currencies_get_a_meter first';
  END IF;

  -- nothing new is reachable from a browser except the redeem door, which is the caller's own
  IF has_function_privilege('anon', 'public.fn_vip_points_move_only_with_a_leg()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_vip_points_move_only_with_a_leg()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the vip_points guard is executable by a browser role';
  END IF;

  RAISE NOTICE 'the other currencies get their guards: every journal refuses what it should';
END $verify$;

COMMIT;
