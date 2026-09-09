/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BURN-IN GATE MEASURES WHAT STAYED IN SUSPENSE, NOT WHAT PASSED THROUGH
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Companion to ca_suspense_today_is_what_stayed_not_what_passed_through, which
 * fixed the same arithmetic in the dashboard metric. The gate was still
 * counting ROWS that touched settlement_suspense and summing their amounts
 * GROSS, so it read 116 rows / 82,229.96 on a day when the net residual was
 * 0.00 at every hour, with no mint and no burn leg among them.
 *
 * chip_ledger is a transfer journal. A chip that enters suspense and later
 * leaves writes two rows, and a correction that cancels an auto-ledger twin
 * writes two more. Counting rows means the gate can only pass on a day when
 * nothing ever needed classifying, and summing gross means FIXING a
 * misclassification makes the number go UP: on 2026-09-09 the figure doubled
 * at 11:00:50, the exact minute the corrections landed.
 *
 * What the gate is actually there to refuse is money LEFT SITTING in suspense
 * at the moment it is asked. That is the net, so that is what it now reads.
 * The row count stays in the payload as traffic, beside the residual, because
 * an operator still wants to see how much classifying went on.
 *
 * Patched in place by anchored replacement so the other eleven checks are
 * carried across byte for byte.
 */

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_old_select text := $anchor$  SELECT count(*), COALESCE(sum(amount),0) INTO c_suspense_rows, c_suspense_chips$anchor$;
  v_new_select text := $anchor$  SELECT count(*), COALESCE(sum(CASE WHEN to_type = 'settlement_suspense' THEN amount ELSE -amount END),0) INTO c_suspense_rows, c_suspense_chips$anchor$;
  v_old_check  text := $anchor$'zero_suspense_flow',                jsonb_build_object('pass', c_suspense_rows = 0, 'rows', c_suspense_rows, 'chips', round(c_suspense_chips,2))$anchor$;
  v_new_check  text := $anchor$'zero_suspense_flow',                jsonb_build_object('pass', round(c_suspense_chips,2) = 0, 'rows', c_suspense_rows, 'chips', round(c_suspense_chips,2))$anchor$;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc
   WHERE proname = 'fn_ca_midway_burnin_gate' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_midway_burnin_gate not found';
  END IF;

  IF position(v_old_select IN v_src) = 0 THEN
    RAISE EXCEPTION 'the suspense SELECT anchor has moved - refusing to patch blind';
  END IF;
  IF position(v_old_check IN v_src) = 0 THEN
    RAISE EXCEPTION 'the zero_suspense_flow check anchor has moved - refusing to patch blind';
  END IF;

  v_new := replace(v_src, v_old_select, v_new_select);
  v_new := replace(v_new, v_old_check,  v_new_check);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'replacement produced no change';
  END IF;

  EXECUTE v_new;
END
$mig$;

REVOKE ALL ON FUNCTION public.fn_ca_midway_burnin_gate(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_midway_burnin_gate(integer) FROM anon;
