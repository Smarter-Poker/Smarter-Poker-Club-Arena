DO $mig$
DECLARE r record; v_n int := 0;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* FOUR NEW DEFINERS ARE OPERATOR TELEMETRY, AND CLOSE THEIR DOORS.    */
  /*                                                                     */
  /* The repository's definer-authorization gate refused the push and was */
  /* right to. Four functions written today are SECURITY DEFINER, run as  */
  /* the owner past RLS, and were executable by anon because Postgres     */
  /* grants EXECUTE to PUBLIC by default and Supabase publishes every     */
  /* public function. None of them asks who is calling, because none of   */
  /* them was ever meant to be called by a person:                        */
  /*                                                                     */
  /*   fn_ca_suspense_regression_check           - a cron detector        */
  /*   fn_ca_drain_orphaned_post_commit_envelopes - a cron sweep          */
  /*   fn_tournament_double_paid_obligations      - a reconciler report   */
  /*   fn_ca_payout_rows_without_money            - a sweep check         */
  /*                                                                     */
  /* Read-only is not the same as harmless: the last two return player    */
  /* ids, tournament ids and amounts to anybody who asks. PUBLIC is named */
  /* alongside the roles, because anon inherits whatever PUBLIC holds and */
  /* revoking anon alone reads as a fix and does nothing.                 */
  /* =================================================================== */

  /* None of these may be an RLS policy helper - revoking one that is would
     lock a table for everybody. Checked, not assumed. */
  FOR r IN
    SELECT p.polrelid::regclass::text AS rel, p.polname
      FROM pg_policy p
     WHERE pg_get_expr(p.polqual, p.polrelid) ~ '(fn_ca_suspense_regression_check|fn_ca_drain_orphaned_post_commit_envelopes|fn_tournament_double_paid_obligations|fn_ca_payout_rows_without_money)'
        OR pg_get_expr(p.polwithcheck, p.polrelid) ~ '(fn_ca_suspense_regression_check|fn_ca_drain_orphaned_post_commit_envelopes|fn_tournament_double_paid_obligations|fn_ca_payout_rows_without_money)'
  LOOP
    RAISE EXCEPTION 'refusing to revoke: % is used by policy % on %', r.polname, r.polname, r.rel;
  END LOOP;

  REVOKE ALL ON FUNCTION public.fn_ca_suspense_regression_check() FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_ca_suspense_regression_check() TO service_role;

  REVOKE ALL ON FUNCTION public.fn_ca_drain_orphaned_post_commit_envelopes(interval, integer) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_ca_drain_orphaned_post_commit_envelopes(interval, integer) TO service_role;

  REVOKE ALL ON FUNCTION public.fn_tournament_double_paid_obligations(integer) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_tournament_double_paid_obligations(integer) TO service_role;

  REVOKE ALL ON FUNCTION public.fn_ca_payout_rows_without_money(integer) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_ca_payout_rows_without_money(integer) TO service_role;

  /* and the door opened for closing a period, which was revoked from PUBLIC
     when it was created but never granted to the service that runs it */
  REVOKE ALL ON FUNCTION public.fn_union_close_unsettleable_period(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_union_close_unsettleable_period(uuid, text) TO service_role;

  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_ca_suspense_regression_check','fn_ca_drain_orphaned_post_commit_envelopes',
                         'fn_tournament_double_paid_obligations','fn_ca_payout_rows_without_money',
                         'fn_union_close_unsettleable_period')
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
            OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  LOOP
    RAISE EXCEPTION 'still reachable without service_role: %(%)', r.proname, r.args;
  END LOOP;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_ca_suspense_regression_check','fn_ca_drain_orphaned_post_commit_envelopes',
                       'fn_tournament_double_paid_obligations','fn_ca_payout_rows_without_money',
                       'fn_union_close_unsettleable_period')
     AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_n <> 5 THEN RAISE EXCEPTION 'expected 5 functions executable by service_role, found %', v_n; END IF;
END
$mig$;
