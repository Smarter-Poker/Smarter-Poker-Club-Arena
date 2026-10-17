-- 20261016143729_a_weekly_close_accepts_a_history_only_invoice.sql
--
-- Reserved as 20261016143729 by scripts/new-migration.mjs; renamed to the
-- version the Supabase MCP recorded when it was applied (20261016144115).
--
-- A WEEKLY CLOSE ACCEPTS A HISTORY-ONLY INVOICE (2026-10-16)
--
-- The owner rule. Dan, 2026-10-15 (20261015184608): only cashout documents
-- reach the messenger; "every other invoice is recorded in transaction history
-- only and marked delivered so the weekly close is satisfied".
-- fn_deliver_accounting_invoice has done exactly that since: for every invoice
-- type except cashier_cashout it numbers the invoice, sets message_sent, and
-- writes no accounting_invoice_deliveries row.
--
-- What broke. Seven readers still demanded a messenger delivery row for those
-- invoices, so the weekly close could not be satisfied. Read from production:
-- the union close for the week of 2026-10-05 reached round 1 at 14:20 UTC on
-- 2026-10-16 (attempt 157), paid each club, and then refused its own receipt
-- ("round1_failed: close_failed", "union_close_invoice_receipt_missing",
-- settlement cc2dcb80-4d65-4654-affe-c75f2734add1); the attempt rolled back
-- and the run was marked failed. The same demand sits in the union retained
-- share, the legacy week discharge, the club weekly statement and its
-- summary, and the correction and credit-change document checks.
--
-- The fix. Each of those checks now accepts what the owner rule writes: an
-- invoice other than cashier_cashout is delivered when it is marked sent
-- (message_sent, already required by each check); a cashier_cashout invoice
-- still needs its messenger deliveries, exactly as before. The correction and
-- credit-change checks compare their audience only when deliveries exist, and
-- every delivery that does exist is still checked field by field. Nothing
-- else in any function changes; each is rewritten from its pinned live
-- preimage with the exact count of every replaced phrase checked.
--
-- @live-proof: (SELECT count(*) = 7 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f' AND proname IN ('fn_union_weekly_rakeback_close','fn_union_close_post_rake_debit','fn_accounting_legacy_pay_week','fn_club_weekly_accounting_summary','fn_issue_scope_weekly_accounting','fn_accounting_correction_assert_delivery','fn_accounting_credit_reduction_assert_document') AND strpos(pg_get_functiondef(oid), 'HISTORY-ONLY INVOICE (20261016143729)') > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $patch$
DECLARE
  r record;
  d text;
  n integer;
  cur_sig text;
  marker constant text := '/* HISTORY-ONLY INVOICE (20261016143729) */ ';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    (1, 'public.fn_union_weekly_rakeback_close(uuid,timestamp with time zone,timestamp with time zone)', 'ac88da36fab16f6a26cf60cbae21699a',
      'EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)',
      '(i.invoice_type IS DISTINCT FROM ''cashier_cashout'' OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id))'),
    (2, 'public.fn_union_close_post_rake_debit(jsonb)', '5c19f0b79f3b85e6c46e0ca95b863a5b',
      'EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)',
      '(i.invoice_type IS DISTINCT FROM ''cashier_cashout'' OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id))'),
    (3, 'public.fn_accounting_legacy_pay_week(uuid)', '54e253e6f33ac25bb847022ac52913b8',
      'EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)',
      '(i.invoice_type IS DISTINCT FROM ''cashier_cashout'' OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id))'),
    (4, 'public.fn_club_weekly_accounting_summary(uuid)', '4a49109e7d4f7b84c468bd35c6f472af',
      'OR NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d',
      'OR (i.invoice_type IS NOT DISTINCT FROM ''cashier_cashout'' AND NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d'),
    (5, 'public.fn_club_weekly_accounting_summary(uuid)', '4a49109e7d4f7b84c468bd35c6f472af',
      'n.user_id=d.recipient_id)) AS receipt_bad',
      'n.user_id=d.recipient_id))) AS receipt_bad'),
    (6, 'public.fn_issue_scope_weekly_accounting(text,uuid,timestamp with time zone,timestamp with time zone)', 'e73d9e7d8807ac4244d8131e4b2bc407',
      E'OR expected_users=0 OR EXISTS(\n   SELECT 1 FROM public.fn_accounting_party_users(''club'',club)u WHERE NOT EXISTS(',
      E'OR expected_users=0 OR (SELECT si.message_sent IS NOT TRUE FROM public.settlement_invoices si WHERE si.id=invoice)\n   OR ((SELECT si.invoice_type FROM public.settlement_invoices si WHERE si.id=invoice) IS NOT DISTINCT FROM ''cashier_cashout'' AND EXISTS(\n   SELECT 1 FROM public.fn_accounting_party_users(''club'',club)u WHERE NOT EXISTS('),
    (7, 'public.fn_issue_scope_weekly_accounting(text,uuid,timestamp with time zone,timestamp with time zone)', 'e73d9e7d8807ac4244d8131e4b2bc407',
      E'n.metadata->>''invoice_id''=invoice::text))\n  THEN RAISE EXCEPTION ''club_weekly_statement_delivery_incomplete''',
      E'n.metadata->>''invoice_id''=invoice::text)))\n  THEN RAISE EXCEPTION ''club_weekly_statement_delivery_incomplete'''),
    (8, 'public.fn_accounting_correction_assert_delivery(uuid)', 'bf0496de7a160b50b6fbd758d6c75f72',
      'IF actual_users IS DISTINCT FROM c.audience_user_ids',
      'IF (actual_users IS NOT NULL AND actual_users IS DISTINCT FROM c.audience_user_ids)'),
    (9, 'public.fn_accounting_credit_reduction_assert_document(uuid)', '47e3a585de0756c1d7fa5837e2fcae4f',
      'IF actual_users IS DISTINCT FROM c.audience_user_ids',
      'IF (actual_users IS NOT NULL AND actual_users IS DISTINCT FROM c.audience_user_ids)')
  ) v(step, sig, preimage, old_text, new_text) ORDER BY step LOOP
    -- A function's replacements are applied together and it is compiled once.
    IF cur_sig IS DISTINCT FROM r.sig THEN
      IF cur_sig IS NOT NULL THEN EXECUTE d; END IF;
      cur_sig := r.sig;
      d := pg_get_functiondef(r.sig::regprocedure);
      IF md5(d) <> r.preimage THEN
        RAISE EXCEPTION 'Unexpected preimage: % is %, expected %', r.sig, md5(d), r.preimage;
      END IF;
    END IF;
    n := (length(d) - length(replace(d, r.old_text, ''))) / length(r.old_text);
    IF n <> 1 THEN
      RAISE EXCEPTION 'Step %: expected one occurrence in %, found %', r.step, r.sig, n;
    END IF;
    d := replace(d, r.old_text, CASE WHEN r.step IN (5,7) THEN '' ELSE marker END || r.new_text);
  END LOOP;
  EXECUTE d;

  IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true
     OR smarter_private.original_inventory_basis_generation() IS NULL THEN
    RAISE EXCEPTION 'The inventory proof sources no longer match their seal';
  END IF;
END
$patch$;

COMMIT;
