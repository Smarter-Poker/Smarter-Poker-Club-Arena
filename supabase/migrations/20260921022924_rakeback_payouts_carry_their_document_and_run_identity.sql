-- 20260921022924_rakeback_payouts_carry_their_document_and_run_identity.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- On 2026-09-14 between 00:29:59.518620Z and 06:27:40.482241Z, 420 posted
-- `rakeback` legs moved 84,041.00 from `settlement_suspense` to
-- `player_wallet` across 420 distinct recipients. Measured read-only against
-- production before this file was written: every one of those rows has
-- `settlement_id` NULL, `idempotency_key` NULL, `correlation_id` NULL and
-- `metadata` NULL; its description is the string
-- `auto-audited club_members.chip_balance delta <d>`; not one has a row in
-- `settlement_invoices` (`source_ledger_id`), and
-- `accounting_routed_settlement_runs` has never held a row. Its paired
-- `adjustment` leg (`club_treasury` -> `settlement_suspense`, 420 rows,
-- 84,041.00, same timestamps, same performer) is equally undocumented. A
-- player who disputes that money cannot be shown an invoice, a receipt, or the
-- settlement run it was paid under.
--
-- THE WRITER. Not a payer at all: `public.fn_club_members_ledger_writer()`,
-- the AFTER UPDATE OF chip_balance journal trigger
-- `trg_club_members_audit_chip_movement` on `public.club_members`. It takes
-- the leg's *category* from the session GUC `app.ledger_category` and its
-- counterparty from `app.ledger_counterparty`, defaulting the counterparty to
-- `settlement_suspense`. So any caller that moved `club_members.chip_balance`
-- with `app.ledger_category` declared as `rakeback`, without standing the
-- trigger down, produced exactly the observed shape: category `rakeback`,
-- `settlement_suspense` -> `player_wallet`, and no key, no period, no
-- certificate, no payout row, no run and no document, because this trigger
-- has none of those facts to write. All 2,111 `rakeback` ->
-- `player_wallet` legs in production have this shape, and all 2,111 have no
-- invoice. It is still reachable: the trigger is enabled and the function has
-- no rakeback clause.
--
-- WHY THE DOCUMENT AUTHORITY DID NOT CATCH IT. It does now, and only now.
-- `accounting_transfer_document` on `chip_ledger` learned the
-- `(from_type='settlement_suspense' AND category='rakeback')` arm after
-- 2026-09-14, so today an anonymous leg of this shape does get a receipt - but
-- a receipt with no period, no certificate and no run behind it, which is not
-- what a disputing player needs. The missing half of the invariant is the
-- settlement/run identity, and nothing enforces it.
--
-- WHAT IS NOT DONE HERE. The 420 historical rows are NOT touched, NOT
-- reclassified and NOT given invented invoices; the gap stays on the record.
-- No cron job, watcher, reconciler, polling repair or scheduled cleanup is
-- created, no second payer and no second document authority. No existing
-- assertion is weakened or removed.
--
-- WHAT IS DONE HERE, AT THE OWNING SOURCE:
--
--   1. `fn_club_members_ledger_writer` refuses to journal a `rakeback`
--      movement at all, with the named error
--      `rakeback_requires_accounting_authority`. Rakeback is paid by
--      `public.fn_settle_accounting_rakeback_stage`, which stands this trigger
--      down with `app.ledger_autoskip_club_members` and writes its own leg
--      carrying the key, the period, the certificate, the payout row and the
--      run. A caller that reaches this trigger with `rakeback` declared is by
--      construction a caller that has none of that, so it must refuse rather
--      than mint an anonymous twin. This is the retirement shape of
--      20260914145000_legacy_claims_enter_only_automatic_weekly_accounting.
--      The clause is inserted with the estate's read-the-installed-definition,
--      single-occurrence-needle, EXECUTE-replace pattern (see 20260917234315
--      and 20260920232503), so no other line of the writer can move by
--      accident and so the change applies identically to the exact definition
--      installed in any qualified cluster.
--
--   2. A deferrable constraint trigger states the invariant for EVERY writer,
--      present or future: a posted `rakeback` leg into `player_wallet` cannot
--      reach commit without, in the same transaction, its routed accounting
--      identity (idempotency key, routing_version 3, period, certificate,
--      payout, scope and period bounds), the settlement run it was paid under
--      in `accounting_routed_settlement_runs`, the paid
--      `rakeback_period_payouts` row, the certificate it was computed from,
--      and exactly one source-linked paid receipt in `settlement_invoices`.
--      It is DEFERRABLE INITIALLY DEFERRED for the same reason
--      `zz_ca_issuance_leg_is_registered` is: the document is written by the
--      AFTER INSERT document authority on the same row, and the run journal is
--      written when the stage completes, both inside the one transaction. The
--      named error is `rakeback_payout_leg_undocumented`.
--
-- WHY THIS CANNOT BREAK THE FIRST SETTLEABLE WEEK (Sep 21-28, due
-- 2026-09-28T09:00Z). Every clause the constraint requires is something
-- `fn_settle_accounting_rakeback_stage` already writes and, for the receipt,
-- already asserts itself with `routed_rakeback_invoice_delivery_incomplete`
-- immediately after its INSERT. The constraint is a strict subset of that
-- assertion: it does not require `message_sent`, `deductions=0`, or - and this
-- matters - `chip_ledger.settlement_id`, which the v3 authority deliberately
-- does NOT populate on the payout leg. Requiring settlement_id would have been
-- exactly the constraint that fails on 2026-09-28; the run identity lives in
-- `metadata` and in `accounting_routed_settlement_runs`, and that is what is
-- required here. The stage writes no leg at all when the amount is zero, and
-- `fn_union_weekly_rakeback_close` pays `union_wallet` -> `club_treasury`,
-- never into a player wallet, so neither is in scope.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

-- Exact live predecessors, read-only. Refuse concurrent drift before any DDL.
-- These bind by needle rather than by whole-definition hash on purpose: the
-- writer and the stage are patched/verified in place, and a qualified cluster
-- may legitimately hold an earlier captured vintage of either body. A needle
-- that has moved, multiplied or disappeared is drift and refuses here.
DO $installed_preconditions$
DECLARE source text; needle text; occurrences int;
BEGIN
 -- (a) The journal trigger this migration hardens must exist and be enabled.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname='club_members'
     AND t.tgname='trg_club_members_audit_chip_movement' AND NOT t.tgisinternal
     AND t.tgenabled<>'D' AND t.tgfoid=to_regproc('public.fn_club_members_ledger_writer'))
 THEN RAISE EXCEPTION 'club_members_journal_trigger_missing' USING ERRCODE='55000'; END IF;

 -- (b) The existing document authority already covers this leg shape. This
 --     migration adds no second document authority and relies on that one.
 SELECT pg_get_triggerdef(t.oid) INTO source FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='chip_ledger' AND t.tgname='accounting_transfer_document';
 IF NOT FOUND OR position($needle$(new.from_type = 'settlement_suspense'::text) AND (new.category = 'rakeback'::text)$needle$ IN source)=0
  OR to_regproc('public.fn_invoice_accounting_ledger_transfer')IS NULL
 THEN RAISE EXCEPTION 'accounting_document_authority_preimage_drift' USING ERRCODE='55000'; END IF;

 -- (c) The one legitimate rakeback payout writer must still record every fact
 --     the new constraint requires, and must still stand this journal down.
 source:=pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure);
 FOR needle IN SELECT unnest(ARRAY[
   $n$PERFORM set_config('app.ledger_autoskip_club_members','1',true)$n$,
   $n$'routing_version',3$n$,
   $n$'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id$n$,
   $n$'certificate_id',r.certificate_id$n$,
   $n$'payout_id',payout_id$n$,
   $n$'round3-period:v3:'$n$,
   $n$routed_rakeback_invoice_delivery_incomplete$n$,
   $n$INSERT INTO public.accounting_routed_settlement_runs$n$])
 LOOP
  IF position(needle IN source)=0 THEN
   RAISE EXCEPTION 'routed_rakeback_authority_preimage_drift' USING ERRCODE='55000', DETAIL=needle; END IF;
 END LOOP;

 -- (d) The writer clause is inserted once, at a site that occurs exactly once,
 --     and the writer must not already carry a rakeback clause.
 source:=pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure);
 needle:=$n$  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');$n$;
 occurrences:=(length(source)-length(replace(source,needle,'')))/length(needle);
 IF occurrences<>1 THEN
  RAISE EXCEPTION 'club_members_journal_category_site_changed' USING ERRCODE='55000'; END IF;
 IF position('rakeback' IN source)>0 THEN
  RAISE EXCEPTION 'club_members_journal_already_carries_a_rakeback_clause' USING ERRCODE='55000'; END IF;

 -- (e) The constraint must not already exist under this name.
 IF EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname='chip_ledger'
     AND t.tgname='zz_ca_rakeback_payout_leg_is_documented')
 THEN RAISE EXCEPTION 'rakeback_payout_constraint_preexists' USING ERRCODE='55000'; END IF;
END $installed_preconditions$;

-- 1. THE WRITER REFUSES. Rakeback is not journalled from the balance column.
DO $retire_rakeback_from_the_journal_writer$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure);
 needle:=$n$  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');$n$;
 replacement:=needle||$r$

  /* RAKEBACK IS NOT JOURNALLED FROM HERE (2026-09-21). This trigger takes the
     category from app.ledger_category and the counterparty from
     app.ledger_counterparty, and it knows no period, certificate, payout row,
     settlement run or document. On 2026-09-14 that produced 420 anonymous
     rakeback legs moving 84,041.00 into 420 player wallets with no invoice, no
     receipt and no run to tie them to. Rakeback is paid by
     public.fn_settle_accounting_rakeback_stage, which stands this journal down
     with app.ledger_autoskip_club_members and writes its own leg carrying all
     of those facts. A caller that reaches this line with rakeback declared is
     by construction a caller that has none of them, so it refuses instead of
     minting an anonymous twin. The 420 historical rows are left exactly as
     they are. */
  IF cat = 'rakeback' THEN
    RAISE EXCEPTION 'rakeback_requires_accounting_authority'
      USING ERRCODE = '42501',
            DETAIL  = 'club_members.chip_balance moved under app.ledger_category=rakeback outside public.fn_settle_accounting_rakeback_stage',
            HINT    = 'The weekly accounting authority stands this journal down with app.ledger_autoskip_club_members and writes its own documented, period- and run-identified rakeback leg.';
  END IF;$r$;
 EXECUTE replace(source,needle,replacement);
END $retire_rakeback_from_the_journal_writer$;

-- 2. THE INVARIANT, FOR EVERY WRITER. A rakeback payout leg cannot reach
--    commit without its source-linked document and its settlement/run identity.
CREATE OR REPLACE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn_ca_rakeback_payout_leg_is_documented$
DECLARE
  m        jsonb := COALESCE(NEW.metadata,'{}'::jsonb);
  v_period uuid; v_cert bigint; v_payout uuid;
  v_kind   text; v_scope uuid; v_start timestamptz; v_end timestamptz;
  v_docs   int;
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key)='' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' carries no idempotency key';
  END IF;
  IF m->>'routing_version' IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has no routed accounting identity';
  END IF;
  BEGIN
    v_period:=(m->>'period_id')::uuid;   v_cert :=(m->>'certificate_id')::bigint;
    v_payout:=(m->>'payout_id')::uuid;   v_kind :=m->>'accounting_scope_kind';
    v_scope :=(m->>'accounting_scope_id')::uuid;
    v_start :=(m->>'period_start')::timestamptz;
    v_end   :=(m->>'period_end')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has an unreadable routed accounting identity';
  END;
  IF v_period IS NULL OR v_cert IS NULL OR v_payout IS NULL OR v_kind IS NULL
     OR v_scope IS NULL OR v_start IS NULL OR v_end IS NULL THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' is missing part of its period, certificate or payout identity';
  END IF;

  -- The settlement run a disputing player is shown the payment under.
  IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind=v_kind AND r.scope_id=v_scope AND r.period_start=v_start
      AND r.period_end=v_end AND r.round_no=3 AND r.routing_version=3) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no routed settlement run';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp
    WHERE pp.id=v_payout AND pp.rakeback_period_id=v_period AND pp.club_id=NEW.club_id
      AND pp.user_id=NEW.to_entity_id AND pp.status='paid' AND pp.payout_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching paid rakeback period payout';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c
    WHERE c.id=v_cert AND c.period_id=v_period AND c.club_id=NEW.club_id
      AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching rakeback certificate';
  END IF;

  SELECT count(*) INTO v_docs FROM public.settlement_invoices i
   WHERE i.source_ledger_id=NEW.id AND i.status='paid' AND i.chips_transferred
     AND i.gross_amount=NEW.amount AND i.net_amount=NEW.amount;
  IF v_docs<>1 THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has '||v_docs::text||' source-linked paid receipts, expected exactly 1';
  END IF;
  RETURN NULL;
END $fn_ca_rakeback_payout_leg_is_documented$;
ALTER FUNCTION public.fn_ca_rakeback_payout_leg_is_documented() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_rakeback_payout_leg_is_documented() FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_ca_rakeback_payout_leg_is_documented() IS
 'A posted rakeback leg into a player wallet must carry, in the same transaction, its routed accounting identity, the settlement run it was paid under, its paid payout row, the certificate it was computed from, and exactly one source-linked paid receipt. Deferred for the same reason zz_ca_issuance_leg_is_registered is deferred: the document and the run journal are written later in the same transaction. It requires a strict subset of what fn_settle_accounting_rakeback_stage already asserts, so the weekly authority cannot be refused by it. It does NOT require chip_ledger.settlement_id, which that authority does not populate on the payout leg.';

CREATE CONSTRAINT TRIGGER zz_ca_rakeback_payout_leg_is_documented
AFTER INSERT ON public.chip_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.status='posted' AND NEW.category='rakeback' AND NEW.to_type='player_wallet')
EXECUTE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented();

-- The reviewed money surface owns this trigger from the migration that creates
-- it, never from a later promise.
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('chip_ledger','zz_ca_rakeback_payout_leg_is_documented',
 'Refusal-only guard: DEFERRABLE INITIALLY DEFERRED AFTER INSERT on a posted rakeback leg into a player wallet, raising rakeback_payout_leg_undocumented when the leg lacks its routed accounting identity, its settlement run in accounting_routed_settlement_runs, its paid rakeback_period_payouts row, its accounting_rakeback_period_calculations certificate, or exactly one source-linked paid settlement_invoices receipt. It reads only; it writes no row and moves no balance, and it returns NULL. It requires a strict subset of what fn_settle_accounting_rakeback_stage already writes and already asserts with routed_rakeback_invoice_delivery_incomplete, and it does not require chip_ledger.settlement_id, which that authority does not populate on the payout leg, so it cannot refuse the first settleable week.');

-- Read the change back inside the same transaction.
DO $readback$
DECLARE source text;
BEGIN
 source:=pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure);
 IF (length(source)-length(replace(source,$n$IF cat = 'rakeback' THEN$n$,'')))/length($n$IF cat = 'rakeback' THEN$n$)<>1
  OR position('rakeback_requires_accounting_authority' IN source)=0
  OR position($n$  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');$n$ IN source)=0
 THEN RAISE EXCEPTION 'club_members_journal_rakeback_clause_not_installed' USING ERRCODE='55000'; END IF;
 IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid='public.fn_club_members_ledger_writer()'::regprocedure) IS NOT TRUE
  OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid='public.fn_club_members_ledger_writer()'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=public']
 THEN RAISE EXCEPTION 'club_members_journal_attributes_changed' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname='chip_ledger'
     AND t.tgname='zz_ca_rakeback_payout_leg_is_documented'
     AND t.tgenabled='O' AND t.tgdeferrable AND t.tginitdeferred
     AND t.tgfoid=to_regproc('public.fn_ca_rakeback_payout_leg_is_documented'))
 THEN RAISE EXCEPTION 'rakeback_payout_constraint_not_armed' USING ERRCODE='55000'; END IF;
END $readback$;

COMMIT;
