-- 20261017130300_the_flow_window_proof_follows_the_installed_report
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 13:03:00 UTC.
--
-- THE FLOW WINDOW PROOF FOLLOWS THE INSTALLED REPORT (2026-10-17)
--
-- The 2026-10-05 Midway union close (fade0000) paid round 1 at 2026-10-16
-- 21:15 and has paid nothing since: rounds 2 (club to agents), 3 (agents to
-- players) and 4 (invoices) wait on a certified P&L evidence report.
--
-- Read on production 2026-10-17 13:02 UTC:
--   * public.fn_union_pnl_evidence_report is at md5 7b465b7055e80234bd8c40ed5899f4dd,
--     the postimage of 20261017034258 (the touched proof reuses tournament and
--     registration identities). That file changed only the report's touched
--     step and the report md5 inside smarter_private.original_inventory_proof_sources_match
--     (now aaa32399..., matching, generation original-inventory-245-v1:3e8afc28...).
--   * public.fn_accounting_union_earned_plan_advance (md5 d6bd67ed...) still
--     pins the report's PREVIOUS md5, edecfc5273ee4c96b608baa0ea863578, in the
--     guard that admits the per-window flow proof:
--        OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(...)'))<>'edecfc...'
--        ... THEN RETURN true;
--     So it now returns true at once and never proves a flow window. The
--     report then proves the week's 814,543 flows in one statement (162 s and
--     2 GB of temp files, per 20261015b), which cannot fit job 272's 240 s
--     tick after preparation: every attempt that reaches the flows step is
--     cancelled and rolled back, and the new generation has voided the old
--     flow certificate and its 84 window partials.
--
-- THE FIX: move that one pin to the installed report. The flows step and
-- fn_union_pnl_original_flow_evidence (09745f78..., unchanged and still pinned
-- beside it) are byte-identical to what the window proof was derived from;
-- 20261017034258 touched no flow passage. The advance function is not one of
-- the matcher's sources, so the generation does not move. Nothing else in the
-- function changes: no money, certificate, partial, period, budget, ACL or
-- trigger data.
--
-- GUARDS: refuses in the break window; the live body must be the exact
-- preimage (d6bd67ed...) or already the postimage (64c67ea9..., derived
-- read-only on production with replace()); the old pin occurs exactly once;
-- the report must be at 7b465b... and the flow evidence at 09745f78...; owner,
-- SECURITY DEFINER, configuration and ACL are proven unchanged; the readback
-- must be the exact postimage.
-- @live-proof: md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure)) = '64c67ea9c59eaa94d10eb7e0bff1ccdd'

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'FLOW_WINDOW_PIN_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $install$
DECLARE
  c_sig constant text := 'public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)';
  v_oid oid := to_regprocedure(c_sig);
  v_def text;
  v_new text;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'flow window pin: owner/target mismatch';
  END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))
       <> '7b465b7055e80234bd8c40ed5899f4dd'
     OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))
       <> '09745f78c6cc2ae57f403419020fd1ab' THEN
    RAISE EXCEPTION 'flow window pin: the report or the flow evidence is not the reviewed definition';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = '64c67ea9c59eaa94d10eb7e0bff1ccdd' THEN
    RETURN;
  END IF;
  IF md5(v_def) <> 'd6bd67edc007bf42586c980591fd4707' THEN
    RAISE EXCEPTION 'flow window pin: unexpected live body %', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, 'edecfc5273ee4c96b608baa0ea863578', ''))) / 32 <> 1 THEN
    RAISE EXCEPTION 'flow window pin: the report pin is not exactly once';
  END IF;
  v_new := replace(v_def, 'edecfc5273ee4c96b608baa0ea863578', '7b465b7055e80234bd8c40ed5899f4dd');
  IF md5(v_new) <> '64c67ea9c59eaa94d10eb7e0bff1ccdd' THEN
    RAISE EXCEPTION 'flow window pin: computed postimage is %', md5(v_new);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_new;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'flow window pin: exact readback failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'flow window pin: authority drift';
  END IF;
  IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'flow window pin: the original inventory sources no longer match';
  END IF;
END
$install$;

COMMIT;
