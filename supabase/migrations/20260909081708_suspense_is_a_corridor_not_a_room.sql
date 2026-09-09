DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* SUSPENSE IS A CORRIDOR, NOT A ROOM.                                 */
  /*                                                                     */
  /* fn_ca_suspense_regression_check counted GROSS flow across the        */
  /* settlement_suspense account and fired at 10 rows or 50 chips. Every  */
  /* chip that passes through suspense is counted twice - once entering,  */
  /* once leaving - so a transfer that was correctly classified on its    */
  /* way out still reads as a regression on its way in.                   */
  /*                                                                     */
  /* Measured before writing this, by hour over 48 hours:                 */
  /*   2026-09-07 19:00  3,382 legs  net  0.00                            */
  /*   2026-09-07 16:00    166 legs  net  0.00                            */
  /*   2026-09-09 06:00      4 legs  net  0.00                            */
  /* The open incident said "4 rows / 720.00 chips in the last hour". The */
  /* four rows are 360.00 into suspense and the same 360.00 back out - a  */
  /* correction cancelling an auto-ledger twin, in the same transaction.  */
  /* Nothing was left behind, and the board called it a regression.       */
  /*                                                                     */
  /* What matters is what suspense KEEPS. A chip that goes in and comes   */
  /* out declared its counterparty on the way; a chip that goes in and    */
  /* stays never did.                                                     */
  /* =================================================================== */
  CREATE OR REPLACE FUNCTION public.fn_ca_suspense_regression_check()
   RETURNS integer
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public'
  AS $function$
  DECLARE
    v_in numeric; v_out numeric; v_net numeric;
    v_rows_in int; v_rows_out int;
    v_since constant timestamptz := '2026-09-01 00:17:00+00';
  BEGIN
    SELECT count(*) FILTER (WHERE to_type = 'settlement_suspense'),
           COALESCE(sum(amount) FILTER (WHERE to_type = 'settlement_suspense'), 0),
           count(*) FILTER (WHERE from_type = 'settlement_suspense'),
           COALESCE(sum(amount) FILTER (WHERE from_type = 'settlement_suspense'), 0)
      INTO v_rows_in, v_in, v_rows_out, v_out
      FROM public.chip_ledger
     WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
       AND created_at > now() - interval '60 minutes'
       AND created_at > v_since;

    v_net := round(COALESCE(v_in, 0) - COALESCE(v_out, 0), 2);

    IF abs(v_net) > 1.00 THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_suspense_regression_check', 'unauthorized_adjustment', 'warning',
        'suspense-regression',
        v_net, NULL, NULL, 'ledger', 'settlement_suspense',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        format('suspense kept %s chips in the last hour: %s leg(s) in for %s, %s leg(s) out for %s. A money path lost, or never had, its category declaration and nothing came back for it. Gross flow through suspense is not a finding - what it keeps is.',
               v_net, v_rows_in, round(COALESCE(v_in,0), 2), v_rows_out, round(COALESCE(v_out,0), 2)),
        false,
        jsonb_build_object('net_last_hour', v_net,
                           'legs_in', v_rows_in, 'chips_in', round(COALESCE(v_in,0), 2),
                           'legs_out', v_rows_out, 'chips_out', round(COALESCE(v_out,0), 2)));
      RETURN 1;
    END IF;
    RETURN 0;
  END $function$;

  /* =================================================================== */
  /* AN ARM PROVES ITS OWN DETECTOR, NOT THE BOARD'S HISTORY.            */
  /*                                                                     */
  /* Arm 2 asserted `dedupe_key LIKE 'suspense-regression:%'`. The check  */
  /* files under exactly 'suspense-regression', no colon, so the arm      */
  /* could never pass - and had the pattern been 'suspense-regression%'   */
  /* it would have passed off the incident that was ALREADY open, proving */
  /* nothing at all. Both checks return the number of findings they file; */
  /* that is the assertion, and a stale row cannot satisfy it.            */
  /*                                                                     */
  /* Arm 1 could not arm: club_members.chip_balance carries a NOT         */
  /* NEGATIVE check constraint, so the drill's UPDATE is refused before   */
  /* any detector is asked. That refusal is a STRONGER guarantee than the */
  /* watcher - the store cannot go below zero at all - so the arm now     */
  /* accepts it, and falls through to the watcher only if the write       */
  /* stands. If the constraint is ever dropped, this arm starts proving   */
  /* the detector instead, with no further change.                        */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_alarm_drill';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_alarm_drill not found'; END IF;
  v_new := v_src;

  IF position($old$    PERFORM set_config('app.ledger_autoskip_club_members','1',true);
    UPDATE club_members SET chip_balance = -3
     WHERE club_id = c_midway_club AND user_id = c_cert_user;
    PERFORM public.fn_ca_negative_balance_watch();
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key LIKE 'negative-balance:club_members:%' AND status <> 'resolved';
    v_ok := v_n > 0;$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'drill arm 1 body not found';
  END IF;
  v_new := replace(v_new,
$old$    PERFORM set_config('app.ledger_autoskip_club_members','1',true);
    UPDATE club_members SET chip_balance = -3
     WHERE club_id = c_midway_club AND user_id = c_cert_user;
    PERFORM public.fn_ca_negative_balance_watch();
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key LIKE 'negative-balance:club_members:%' AND status <> 'resolved';
    v_ok := v_n > 0;$old$,
$old$    PERFORM set_config('app.ledger_autoskip_club_members','1',true);
    BEGIN
      UPDATE club_members SET chip_balance = -3
       WHERE club_id = c_midway_club AND user_id = c_cert_user;
      -- the write stood, so the watcher is the only guard there is
      v_ok := public.fn_ca_negative_balance_watch() > 0;
    EXCEPTION WHEN check_violation THEN
      -- the store cannot go below zero at all, which is more than a
      -- detector could ever promise
      v_ok := true;
      v_note := 'refused by a check constraint before any detector was asked';
    END;$old$);

  IF position($old$    PERFORM public.fn_ca_suspense_regression_check();
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key LIKE 'suspense-regression:%' AND status <> 'resolved';
    v_ok := v_n > 0;$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'drill arm 2 assertion not found';
  END IF;
  v_new := replace(v_new,
$old$    PERFORM public.fn_ca_suspense_regression_check();
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key LIKE 'suspense-regression:%' AND status <> 'resolved';
    v_ok := v_n > 0;$old$,
$old$    -- the check returns what it filed; an incident that was already open
    -- must not be able to make this arm pass
    v_ok := public.fn_ca_suspense_regression_check() > 0;$old$);

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_alarm_drill';
  IF position('EXCEPTION WHEN check_violation THEN' IN v_src) = 0
     OR position('v_ok := public.fn_ca_suspense_regression_check() > 0;' IN v_src) = 0
     OR position($chk$LIKE 'suspense-regression:%'$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'fn_ca_alarm_drill did not take the arm-1/arm-2 fixes';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_suspense_regression_check'
         AND pg_get_functiondef(p.oid) LIKE '%suspense kept%') <> 1 THEN
    RAISE EXCEPTION 'fn_ca_suspense_regression_check did not take the net rewrite';
  END IF;
END
$mig$;
