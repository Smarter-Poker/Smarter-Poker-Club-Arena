-- 20260921202827_diamond_spins_prize_legs_keep_their_ledger_rows_and_issue_no.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (owner ruling 2026-09-21, R17):
--
-- "No push notification or accounting record pushed to the phone after every
-- transaction, for the user or the owner of the club/union. Just a transaction
-- history ledger."
--
-- Read from the installed catalog: every Diamond Spins chip prize is paid by
-- fn_diamond_game_pay_chips, whose autoledger rows on chip_ledger carry the
-- category wheel_prize | plinko_prize | crash_prize | crossing_prize |
-- mines_prize. The trigger accounting_transfer_document (20260914113214) fires
-- on every posted leg from union_wallet, union_bank or club_treasury into a
-- player_wallet, and 20260914121645 deliberately taught the invoice writer those
-- five categories. So a UNION host's every prize (promo leg AND bank leg) and a
-- CLUB host's bank-shortfall leg each produced a settlement_invoices receipt, a
-- Messenger invoice message, a notifications row and a push_outbox push, for
-- the player and for every owner/admin on the host roster. That 2026-09-14
-- ruling is reversed by the owner today for these categories.
--
-- THE ROOT CAUSE IS THE TRIGGER PREDICATE, so that is the one line that moves.
-- The WHEN clause now excludes the Diamond Spins ledger categories, named in
-- ONE place: fn_diamond_spin_ledger_category(text). The trigger, the probes and
-- any later game category (the Diamonds card game, R15) use that function, so
-- the list cannot drift between the predicate and its tests.
--
-- EVERY LEDGER ROW IS KEPT EXACTLY AS TODAY: chip_ledger, chip_transactions,
-- union_wallet_transactions, diamond_transactions and the custody movements are
-- untouched. Only the per-transaction DOCUMENT and its deliveries stop. The
-- transaction history ledger is the record. Documents already issued are
-- immutable (accounting_invoice_immutable) and are not deleted.
--
-- LATENT DEFECT CLOSED BY THE SAME LINE. 20260921052548 gates
-- fn_accounting_party_users so a non-engine caller sees a roster only when it
-- is itself on it. A wheel spin is an authenticated browser RPC, so for a union
-- host's prize the ISSUER roster came back empty for the player and
-- fn_deliver_accounting_invoice raised accounting_invoice_recipient_missing,
-- aborting the whole prize transaction. Reproduced in the private fixture by
-- tests/sql/diamond-spins-quiet-ledger-before.sql (refused, SQLSTATE 23514) and
-- proved gone by tests/sql/diamond-spins-quiet-ledger.sql. Read from production
-- 2026-09-21: 20260921052548 is merged but NOT yet installed, so this migration
-- must be installed with or before it, never after it alone.
--
-- The game-category branch inside fn_invoice_accounting_ledger_transfer
-- (20260914124421) is now unreachable from this trigger and is left in place;
-- the weekly statement issuers do not read transaction_receipt rows by
-- category, and that function is the accounting programme's to prune.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';

-- ---------------------------------------------------------------------------
-- 1. The single place that names a Diamond Spins ledger category.
--    Not STRICT on purpose: a NULL category must read as "not a Diamond Spins
--    leg" so the document trigger keeps firing for it exactly as before.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_diamond_spin_ledger_category(p_category text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT COALESCE(p_category IN ('wheel_prize','plinko_prize','crash_prize','crossing_prize','mines_prize'),false);
$$;
COMMENT ON FUNCTION public.fn_diamond_spin_ledger_category(text) IS
 'True for a chip_ledger category written by the Diamond Spins payer (fn_diamond_game_pay_chips). Owner ruling 2026-09-21 R17: these legs keep every ledger row and issue no per-transaction accounting document, Messenger invoice, notification or push. Add a new Diamond Spins game category here and nowhere else.';
REVOKE ALL ON FUNCTION public.fn_diamond_spin_ledger_category(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_ledger_category(text) TO authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 2. Refuse loudly if the installed trigger is not the exact definition this
--    migration was written against (20260914113214 as captured on production).
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE installed text;
BEGIN
 SELECT pg_get_triggerdef(t.oid,true) INTO installed FROM pg_trigger t
  WHERE t.tgrelid='public.chip_ledger'::regclass AND t.tgname='accounting_transfer_document' AND NOT t.tgisinternal;
 IF installed IS NULL THEN RAISE EXCEPTION 'accounting_transfer_document is not installed on public.chip_ledger'; END IF;
 IF md5(installed)<>'cfc40f7000da06231a1ff6aaaed495d4' THEN
  RAISE EXCEPTION 'accounting_transfer_document preimage changed (md5 %); re-read it before excluding the Diamond Spins categories',md5(installed);
 END IF;
END $guard$;

DROP TRIGGER accounting_transfer_document ON public.chip_ledger;
CREATE TRIGGER accounting_transfer_document AFTER INSERT ON public.chip_ledger FOR EACH ROW
 WHEN (NEW.status='posted' AND NOT public.fn_diamond_spin_ledger_category(NEW.category)
   AND (NEW.from_type IN ('union_wallet','union_bank','club_treasury','player_wallet','agent_wallet') OR (NEW.from_type='settlement_suspense' AND NEW.category='rakeback'))
   AND NEW.to_type IN ('union_wallet','union_bank','club_treasury','player_wallet','agent_wallet'))
 EXECUTE FUNCTION public.fn_accounting_transfer_document_on_insert();

-- A money trigger declares itself in the migration that (re)creates it.
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
 VALUES('chip_ledger','accounting_transfer_document',
  'Only transfers between accounting wallets, treasuries and banks, plus the existing rakeback clearing leg; excludes hand stacks and prize pools. Since 20260921202827 (owner ruling 2026-09-21 R17) it also excludes every Diamond Spins prize category named by fn_diamond_spin_ledger_category (wheel_prize, plinko_prize, crash_prize, crossing_prize, mines_prize): those legs keep their chip_ledger, chip_transactions and union_wallet_transactions rows and produce no document, Messenger invoice, notification or push. Creates a source-linked invoice and private Messenger plus notification receipts in the same transaction for every other matching leg; any failure rolls back the transfer. No balance writes.')
 ON CONFLICT (table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;

-- ---------------------------------------------------------------------------
-- 3. Read the change back inside the same transaction.
-- ---------------------------------------------------------------------------
DO $readback$
DECLARE installed text; enabled "char"; undeclared bigint;
BEGIN
 SELECT pg_get_triggerdef(t.oid,true),t.tgenabled INTO installed,enabled FROM pg_trigger t
  WHERE t.tgrelid='public.chip_ledger'::regclass AND t.tgname='accounting_transfer_document' AND NOT t.tgisinternal;
 IF installed IS NULL OR enabled<>'O'
  OR position('NOT fn_diamond_spin_ledger_category(new.category)' IN installed)=0
  OR position('new.status = ''posted''::text' IN installed)=0
  OR position('fn_accounting_transfer_document_on_insert()' IN installed)=0 THEN
  RAISE EXCEPTION 'accounting_transfer_document was not re-created with the Diamond Spins exclusion: %',COALESCE(installed,'<missing>');
 END IF;
 IF NOT public.fn_diamond_spin_ledger_category('wheel_prize') OR NOT public.fn_diamond_spin_ledger_category('plinko_prize')
  OR NOT public.fn_diamond_spin_ledger_category('crash_prize') OR NOT public.fn_diamond_spin_ledger_category('crossing_prize')
  OR NOT public.fn_diamond_spin_ledger_category('mines_prize')
  OR public.fn_diamond_spin_ledger_category('rakeback') OR public.fn_diamond_spin_ledger_category('spin_prize')
  OR public.fn_diamond_spin_ledger_category('transfer') OR public.fn_diamond_spin_ledger_category(NULL) THEN
  RAISE EXCEPTION 'fn_diamond_spin_ledger_category does not name exactly the five Diamond Spins categories';
 END IF;
 IF to_regproc('public.fn_undeclared_money_triggers') IS NOT NULL THEN
  EXECUTE 'SELECT count(*) FROM public.fn_undeclared_money_triggers()' INTO undeclared;
  IF undeclared<>0 THEN RAISE EXCEPTION '% money trigger(s) undeclared after re-creating accounting_transfer_document',undeclared; END IF;
 END IF;
END $readback$;

COMMIT;
