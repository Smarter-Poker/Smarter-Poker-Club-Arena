-- 20261017104853_the_weekly_statement_paid_at_issue_is_a_record_rule
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 10:48:53 UTC.
--
-- WHAT WAS WRONG
--
-- 20261015180754_weekly_statement_settled_and_messenger_invoice_threads was
-- applied to production by another agent with no reviewed source: the file on
-- main is only its filename (recorded by #7130 so the ledger check agrees).
-- Among other things it installed trigger trg_weekly_statement_issue_settled,
-- which stamps a weekly statement 'paid' the moment it is issued. Dan asked
-- (2026-10-17) whether "paid at issue" is the right rule. Nothing in the repo
-- said what the trigger does or what it is allowed to touch.
--
-- WHAT WAS MEASURED (production, read-only, 2026-10-17 10:45 UTC)
--
-- The live definition, exactly:
--   BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
--   IF NEW.invoice_type = 'club_weekly_accounting'
--      AND COALESCE(NEW.status, 'generated') = 'generated'
--   THEN NEW.status := 'paid'; END IF;
--   prosrc md5 9a23bbfc5575db47afe7cd9067f65d82, SECURITY INVOKER,
--   search_path=public, owner postgres, trigger enabled ('O').
-- It fires on INSERT only, on one invoice type only, and only moves the
-- default 'generated' to 'paid'. It never updates an existing row.
--
-- settlement_invoices by type on that read: every row of every type is
-- 'paid'. Every row that is a real amount owed carries its payment:
-- agent_to_player 2,992/2,992, agent_to_subagent 426/426, club_to_agent
-- 496/496, transaction_receipt 5,017/5,017, union_club_pnl 2/2 and
-- union_to_club 14/14 have a chip transfer. The trigger cannot reach any of
-- them (wrong invoice_type). The 7 club_weekly_accounting rows have no
-- transfer and never will: a weekly accounting statement is a RECORD of a
-- closed week (rake funding, paid by club, retained), delivered once to the
-- club's messenger and never collected. src/services/ClubWeeklyAccountingReader.ts
-- reads both 'generated' and 'paid' as an issued statement (#7193).
--
-- THE DECISION (Dan 2026-10-17: decide, act, then report)
--
-- "Paid at issue" is the right rule for a record that nobody owes: it keeps
-- an issued statement out of every overdue / reminder / collection path that
-- reads 'generated' as an open bill, and it touches nothing that is a real
-- receivable. So the trigger STAYS, unchanged. This migration makes it a
-- reviewed rule: it asserts the live trigger and function are exactly the
-- measured definition above (it refuses if either has moved, so nobody can
-- widen the rule silently under this record), and writes its scope into the
-- catalog as comments. No row changes. No behaviour changes.
--
-- Pinned by tests/the-weekly-statement-paid-at-issue-is-a-record-rule.law.test.ts.
--
-- @live-proof: (SELECT md5(p.prosrc) = '9a23bbfc5575db47afe7cd9067f65d82' AND obj_description(p.oid, 'pg_proc') LIKE 'RECORD RULE:%' FROM pg_proc p WHERE p.oid = 'public.fn_weekly_statement_issue_settled()'::regprocedure)
-- @live-proof: (SELECT pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_weekly_statement_issue_settled BEFORE INSERT ON public.settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_weekly_statement_issue_settled()' AND t.tgenabled = 'O' FROM pg_trigger t WHERE t.tgname = 'trg_weekly_statement_issue_settled' AND t.tgrelid = 'public.settlement_invoices'::regclass)

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $preimage$
DECLARE
  v_src text;
  v_def text;
  v_secdef boolean;
  v_cfg text;
  v_enabled "char";
BEGIN
  SELECT p.prosrc, p.prosecdef, array_to_string(p.proconfig, ',')
    INTO v_src, v_secdef, v_cfg
    FROM pg_proc p
   WHERE p.oid = 'public.fn_weekly_statement_issue_settled()'::regprocedure;
  IF md5(v_src) IS DISTINCT FROM '9a23bbfc5575db47afe7cd9067f65d82'
     OR v_secdef IS DISTINCT FROM false
     OR v_cfg IS DISTINCT FROM 'search_path=public' THEN
    RAISE EXCEPTION 'WEEKLY_PAID_AT_ISSUE_PREIMAGE: fn_weekly_statement_issue_settled moved (md5 %, secdef %, cfg %)',
      md5(v_src), v_secdef, v_cfg;
  END IF;

  SELECT pg_get_triggerdef(t.oid), t.tgenabled INTO v_def, v_enabled
    FROM pg_trigger t
   WHERE t.tgname = 'trg_weekly_statement_issue_settled'
     AND t.tgrelid = 'public.settlement_invoices'::regclass;
  IF v_def IS DISTINCT FROM
     'CREATE TRIGGER trg_weekly_statement_issue_settled BEFORE INSERT ON public.settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_weekly_statement_issue_settled()'
     OR v_enabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'WEEKLY_PAID_AT_ISSUE_PREIMAGE: trg_weekly_statement_issue_settled moved: % (%)', v_def, v_enabled;
  END IF;
END
$preimage$;

COMMENT ON FUNCTION public.fn_weekly_statement_issue_settled() IS
  'RECORD RULE: a club_weekly_accounting statement is a record of a closed week, never a bill, so it is issued as paid. BEFORE INSERT only; touches only invoice_type club_weekly_accounting arriving as generated (or null). Never updates a row and never touches any receivable or payable invoice type. Reviewed 2026-10-17 by 20261017104853.';

COMMENT ON TRIGGER trg_weekly_statement_issue_settled ON public.settlement_invoices IS
  'RECORD RULE (20261017104853): stamps a newly issued club_weekly_accounting statement paid; see fn_weekly_statement_issue_settled.';

COMMIT;
