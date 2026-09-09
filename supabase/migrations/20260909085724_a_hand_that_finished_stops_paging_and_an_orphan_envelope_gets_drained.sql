DO $mig$
DECLARE v_src text; v_new text; v_n int;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* THE LAST HAND AT A TABLE HAS NOBODY BEHIND IT TO CARRY ITS ENVELOPE. */
  /*                                                                     */
  /* Post-commit obligations - rake distribution, jackpot contribution,   */
  /* promo playthrough, insurance, pending add-ons - are applied in hand  */
  /* order per table, and the applier runs inline on the request that     */
  /* commits the NEXT hand. A table's final hand therefore has no         */
  /* successor to carry it, and nothing scheduled sweeps for stragglers:  */
  /* there is no cron job anywhere that looks for an unapplied envelope.  */
  /*                                                                     */
  /* Measured before writing this: 400,308 commits carry a post-commit    */
  /* payload; 400,295 are applied; 13 are not. Four were seconds old      */
  /* (normal), nine were 3.5 to 7.4 hours old and every one of the nine   */
  /* is the last hand ever committed at its table, with nothing queued    */
  /* behind it. Their payloads carry rake null, jackpot null, promo [],   */
  /* insurance [] - the only unapplied content is a time-bank counter.    */
  /* Zero chips are gated behind the backlog today. The mechanism is      */
  /* still real, and it will keep making orphans, so it gets a sweep.     */
  /* =================================================================== */
  CREATE OR REPLACE FUNCTION public.fn_ca_drain_orphaned_post_commit_envelopes(
    p_older_than interval DEFAULT '10 minutes', p_limit integer DEFAULT 200)
   RETURNS jsonb
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public', 'pg_temp'
  AS $function$
  DECLARE r record; v_seen int := 0; v_done int := 0; v_failed int := 0; v_res jsonb;
  BEGIN
    FOR r IN
      SELECT c.hand_id, c.table_id, c.hand_number, c.committed_at
        FROM public.hand_atomic_commits c
       WHERE c.post_commit_payload IS NOT NULL
         AND c.post_commit_completed_at IS NULL
         AND c.committed_at < now() - p_older_than
         /* the barrier is per table and in hand order: only drain a hand
            whose predecessors have all finished, or the applier will simply
            answer predecessor_pending and we will have learnt nothing */
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_atomic_commits e
            WHERE e.table_id = c.table_id
              AND e.hand_number < c.hand_number
              AND e.post_commit_payload IS NOT NULL
              AND e.post_commit_completed_at IS NULL)
       ORDER BY c.committed_at
       LIMIT GREATEST(p_limit, 1)
    LOOP
      v_seen := v_seen + 1;
      BEGIN
        v_res := public.fn_ca_process_hand_post_commit_obligations(r.hand_id);
        IF COALESCE((v_res->>'ok')::boolean, false) THEN v_done := v_done + 1;
        ELSE v_failed := v_failed + 1; END IF;
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
      END;
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'seen', v_seen, 'applied', v_done, 'failed', v_failed);
  END;
  $function$;

  /* =================================================================== */
  /* A HAND THAT FINISHED STOPS PAGING.                                  */
  /*                                                                     */
  /* Three engine alert sources have no resolution path at all, so their  */
  /* rows stay unresolved forever whatever the hand did afterwards:       */
  /*                                                                     */
  /*  - post_commit_obligations_pending: 111 distinct hand_ids named      */
  /*    across the open alerts, and all 111 have post_commit_completed_at */
  /*    set right now. Every one of them settled; none of them said so.   */
  /*  - hand_history_failed and authoritative_hand_semantic_refusal: the  */
  /*    atomic commit wraps the stacks, the hand history, the commit row, */
  /*    the projection outbox and the roster in one block that rolls back */
  /*    whole, so a refusal leaves nothing partial behind. Of 89 alerted  */
  /*    hands, 10 were retried seconds later and committed normally, 77   */
  /*    were voided and their table went on to deal later hands, and 2    */
  /*    are at tables that have since emptied. Zero chips missing.        */
  /*                                                                     */
  /* An alert is closed here only against evidence that the hand is done: */
  /* the envelope is applied, or the commit row exists, or the table has  */
  /* committed a LATER hand - which is only possible if the refused one   */
  /* was released whole. Nothing is closed on elapsed time.               */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_resolve_settled_financial_alerts';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_resolve_settled_financial_alerts not found'; END IF;

  IF position($old$  IF p_apply THEN$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'apply block not found';
  END IF;

  v_new := replace(v_src,
$old$  v_paid      integer := 0;
  v_overpaid  integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';$old$,
$old$  v_paid      integer := 0;
  v_overpaid  integer := 0;
  v_settled   integer := 0;
  v_released  integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';
  v_settled_ids uuid[] := '{}';
  v_rel_ids   uuid[] := '{}';$old$);

  v_new := replace(v_new,
$old$  IF p_apply THEN$old$,
$old$  -- CLASS 3: the post-commit envelope this alert was raised about has since
  -- been applied. hand_atomic_commits.post_commit_completed_at is the durable
  -- proof; the alert is the memory of a moment when it was not yet set.
  SELECT COALESCE(array_agg(id), '{}') INTO v_settled_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
      JOIN public.hand_atomic_commits c ON c.hand_id = (a.context->>'hand_id')::uuid
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'ServerTableEngine.post_commit_obligations_pending'
       AND a.context->>'hand_id' IS NOT NULL
       AND c.post_commit_completed_at IS NOT NULL
     LIMIT p_limit
  ) s;
  v_settled := COALESCE(array_length(v_settled_ids, 1), 0);

  -- CLASS 4: a refused hand was released whole. Either the commit row for that
  -- exact hand now exists (the retry landed), or the table has since committed
  -- a LATER hand, which the per-table hand-order barrier only permits once the
  -- refused one is no longer in the way. Both are proof the money is settled;
  -- neither is elapsed time.
  SELECT COALESCE(array_agg(id), '{}') INTO v_rel_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source IN ('postHandTasks.hand_history_failed',
                        'ServerTableEngine.authoritative_hand_semantic_refusal')
       AND a.context->>'table_id' IS NOT NULL
       AND a.context->>'hand_number' IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.hand_atomic_commits c
          WHERE c.table_id = (a.context->>'table_id')::uuid
            AND c.hand_number >= (a.context->>'hand_number')::bigint)
     LIMIT p_limit
  ) s;
  v_released := COALESCE(array_length(v_rel_ids, 1), 0);

  IF p_apply THEN
    UPDATE public.financial_alerts a
       SET resolved = true, resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the post-commit envelope for this hand has been applied; post_commit_completed_at is set',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_settled_ids);

    UPDATE public.financial_alerts a
       SET resolved = true, resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the refused hand was released whole: this table has committed that hand or a later one, and an atomic refusal leaves nothing partial behind',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_rel_ids);
  END IF;

  IF p_apply THEN$old$);

  v_new := replace(v_new,
$old$    'settled_after_alert', v_paid,
    'overpay_absorbed', v_overpaid,
    'total', v_paid + v_overpaid,$old$,
$old$    'settled_after_alert', v_paid,
    'overpay_absorbed', v_overpaid,
    'post_commit_applied', v_settled,
    'refused_hand_released', v_released,
    'total', v_paid + v_overpaid + v_settled + v_released,$old$);

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_resolve_settled_financial_alerts';
  IF position('post_commit_applied' IN v_src) = 0
     OR position('refused_hand_released' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_resolve_settled_financial_alerts did not take the two new classes';
  END IF;

  /* ---- schedules ---- */
  PERFORM cron.schedule('ca-post-commit-orphan-drain-10m', '*/10 * * * *',
    $c$SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-post-commit-orphan-drain'))
                THEN (SELECT public.fn_ca_drain_orphaned_post_commit_envelopes())::text
                ELSE 'busy' END$c$);

  PERFORM cron.schedule('ca-spin-return-unawarded-draws-15m', '8,23,38,53 * * * *',
    $c$SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-spin-return-unawarded'))
                THEN (SELECT public.fn_ca_return_unawarded_spin_draws(true, 200))::text
                ELSE 'busy' END$c$);

  PERFORM cron.schedule('ca-resolve-settled-alerts-20m', '4,24,44 * * * *',
    $c$SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-resolve-settled-alerts'))
                THEN (SELECT public.fn_resolve_settled_financial_alerts(true, 5000))::text
                ELSE 'busy' END$c$);

  /* The drill must not depend on its own freeze bypass working: the
     maintenance break owns :55 to :00 of every hour, and this job fired at
     exactly 11:00. */
  PERFORM cron.schedule('ca-alarm-drill-weekly', '7 11 * * 1', 'SELECT public.fn_ca_alarm_drill()');

  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('ca-post-commit-orphan-drain-10m','ca-spin-return-unawarded-draws-15m',
                     'ca-resolve-settled-alerts-20m')
     AND active;
  IF v_n <> 3 THEN RAISE EXCEPTION 'expected 3 new active jobs, found %', v_n; END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'ca-alarm-drill-weekly' AND schedule = '7 11 * * 1';
  IF v_n <> 1 THEN RAISE EXCEPTION 'the alarm drill is still on the hour boundary'; END IF;
END
$mig$;
