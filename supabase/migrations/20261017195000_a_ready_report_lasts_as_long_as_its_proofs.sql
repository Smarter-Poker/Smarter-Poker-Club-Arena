-- 20261017195000_a_ready_report_lasts_as_long_as_its_proofs
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 19:50:00 UTC.
--
-- A READY REPORT LASTS AS LONG AS THE PROOFS IT RESTS ON (2026-10-17)
--
-- 20261017131056 keeps a READY union P&L evidence report so the next weekly
-- close attempt does not prove it again, and handed it on for 30 minutes. That
-- number was a guess, and it is the wrong measure. Read on production
-- 2026-10-17: the 2026-10-05 Midway close kept its report at 17:08 UTC, and the
-- attempt at 17:13 used it and reached round 3 inside its budget. After that,
-- every attempt found the receipt expired, re-proved the report, hit the 240 s
-- statement timeout, and was rolled back along with the receipt it was about
-- to keep. The close could not reach round 3 again.
--
-- The report of a closed week is computed from that week's certified evidence,
-- under one original inventory generation, and the certificates themselves are
-- reused for fn_accounting_close_proof_lifetime() (72 hours). A ready report
-- cannot be fresher than the proofs it was built on, so it is handed on for
-- exactly that long, and never once any of this union's certificates for that
-- week has been certified again after it: a re-proof sends the next attempt
-- back to proving the report itself. The generation test, the closed-week
-- test, the ready test and the chunked-attempt test are unchanged.
--
-- Only fn_accounting_close_report_seed changes, in one condition. No money,
-- rate, payee, routing, receipt, refusal or certificate changes; no sealed
-- source moves.
--
-- GUARDS: refuses in the break window; the live body must be the exact
-- preimage (e859e4e5..., installed by 20261017131056) or already the postimage
-- (981a3fdf..., derived read-only on production with replace()); the anchor
-- occurs exactly once; owner, SECURITY DEFINER, configuration and ACL are
-- proven unchanged; the readback must be the exact postimage.
-- @live-proof: md5(pg_get_functiondef('public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)'::regprocedure)) = '981a3fdf3bdba29ed736f8656a9e544b'

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'REPORT_LIFETIME_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $install$
DECLARE
  c_sig constant text := 'public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)';
  c_old constant text := $o$    AND r.computed_at>clock_timestamp()-interval '30 minutes';$o$;
  c_new constant text := $n$    AND r.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
    AND NOT EXISTS(SELECT 1 FROM public.accounting_close_certificates c
     WHERE c.union_id=p_union_id AND c.period_start=p_start AND c.period_end=p_end
       AND c.certified_at>r.computed_at);$n$;
  v_oid oid := to_regprocedure(c_sig);
  v_def text; v_new text;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'report lifetime: owner/target mismatch';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = '981a3fdf3bdba29ed736f8656a9e544b' THEN
    RETURN;
  END IF;
  IF md5(v_def) <> 'e859e4e5a081fef8d6116f31ec45d72e' THEN
    RAISE EXCEPTION 'report lifetime: unexpected live body %', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'report lifetime: the anchor is not exactly once';
  END IF;
  v_new := replace(v_def, c_old, c_new);
  IF md5(v_new) <> '981a3fdf3bdba29ed736f8656a9e544b' THEN
    RAISE EXCEPTION 'report lifetime: computed postimage is %', md5(v_new);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_new;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'report lifetime: exact readback failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'report lifetime: authority drift';
  END IF;
  IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'report lifetime: the original inventory sources no longer match';
  END IF;
END
$install$;

COMMIT;
