-- ═══════════════════════════════════════════════════════════════════════════
--  A DEADLOCK IS NOT A VERDICT (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_backpay_tournament_rake_attribution stamps `attributed_users = -1` when
-- attribution THROWS, so a thrown row is measured rather than left NULL and
-- cannot pin the queue behind it. That was the right call and it is why the
-- 40,055-row drain on 2026-08-31 finished at all.
--
-- But the loop selects `WHERE attributed_users IS NULL`, so once a row is
-- stamped -1 NOTHING EVER RETRIES IT. The stamp that stopped a transient
-- failure from blocking the queue also made it permanent.
--
-- And transient is what these are. Every one of the 18 rows stamped -1 during
-- the drain carried a deadlock message, and every one of them attributed
-- cleanly the moment it was reset by hand and re-run. The attribution loop
-- takes per-user locks; two settlements touching the same player at the same
-- moment is an ordinary, self-resolving collision, not a verdict about the
-- data. (20260831154912 already imposed a fixed lock order to make it rarer;
-- rarer is not never.)
--
-- So the loop now also picks up rows stamped -1 whose recorded error names a
-- retryable condition — deadlock, serialization failure, lock timeout,
-- statement timeout, canceled statement. A row that failed for any OTHER
-- reason keeps its -1 and stays visible in
-- v_tournament_rake_attribution_gaps, because a genuine data fault must be
-- read by a human, not retried in a loop forever.
--
-- The retryable rows are taken oldest-first alongside the never-measured
-- ones, under the same p_limit, so the historical backlog still drains first
-- and this can never turn into an unbounded retry storm.

create or replace function public.fn_backpay_tournament_rake_attribution(
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_row record; v_att jsonb; v_msg text;
  v_users integer; v_members integer;
  v_paid integer := 0; v_chips numeric := 0; v_seen integer := 0;
  v_requeued integer := 0; v_errors integer := 0; v_left integer;
  v_retried integer := 0; v_stuck integer := 0;
BEGIN
  FOR v_row IN
    SELECT tournament_id, (attributed_users = -1) AS is_retry
      FROM public.tournament_rake_settlements
     WHERE amount > 0
       AND settled_at IS NOT NULL
       AND (
         attributed_users IS NULL
         OR (
           attributed_users = -1
           /* Retryable ONLY. A row that failed for some other reason keeps
              its -1 and stays visible for a human to read. */
           AND attribution_error ~* '(deadlock|serializ|lock timeout|statement timeout|canceling statement|could not obtain lock)'
         )
       )
     ORDER BY settled_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_seen := v_seen + 1;
    IF v_row.is_retry THEN v_retried := v_retried + 1; END IF;
    BEGIN
      v_att := public.fn_attribute_tournament_rake(v_row.tournament_id);
      v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
      v_members := COALESCE((v_att->>'members')::int, 0);

      UPDATE public.tournament_rake_settlements
         SET attributed_users = v_users,
             attributed_at = CASE WHEN v_users = 0 AND v_members > 0
                                  THEN NULL ELSE COALESCE(attributed_at, now()) END,
             /* A successful retry must CLEAR the old error, or the row stays
                eligible for retry forever and reads as broken on a dashboard
                that is looking at a row which worked. */
             attribution_error = CASE WHEN v_users = 0 AND v_members > 0
                                      THEN 'attributed_nobody' ELSE NULL END
       WHERE tournament_id = v_row.tournament_id;

      IF v_users > 0 THEN
        v_paid  := v_paid + 1;
        v_chips := v_chips + COALESCE((v_att->>'attributed_chips')::numeric, 0);
      ELSIF v_members > 0 THEN
        v_requeued := v_requeued + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      UPDATE public.tournament_rake_settlements
         SET attributed_users = -1, attribution_error = v_msg
       WHERE tournament_id = v_row.tournament_id;
      v_errors := v_errors + 1;
    END;
  END LOOP;

  SELECT count(*) INTO v_left
    FROM public.tournament_rake_settlements
   WHERE attributed_users IS NULL AND amount > 0 AND settled_at IS NOT NULL;

  /* Rows holding a -1 that this loop will never pick up again. These are the
     ones that need a human, and reporting them separately is what stops them
     hiding inside `remaining`, which counts only never-measured rows. */
  SELECT count(*) INTO v_stuck
    FROM public.tournament_rake_settlements
   WHERE attributed_users = -1 AND amount > 0 AND settled_at IS NOT NULL
     AND (attribution_error IS NULL
          OR attribution_error !~* '(deadlock|serializ|lock timeout|statement timeout|canceling statement|could not obtain lock)');

  RETURN jsonb_build_object('ok', true, 'scanned', v_seen, 'paid', v_paid,
    'chips', round(v_chips, 2), 'requeued', v_requeued, 'errors', v_errors,
    'retried', v_retried, 'remaining', v_left, 'needs_a_human', v_stuck);
END;
$function$;

revoke all on function public.fn_backpay_tournament_rake_attribution(integer) from public;
revoke all on function public.fn_backpay_tournament_rake_attribution(integer) from anon, authenticated;
grant execute on function public.fn_backpay_tournament_rake_attribution(integer) to service_role;

comment on function public.fn_backpay_tournament_rake_attribution(integer) is
  'Drains never-measured rake attribution, and re-attempts rows a transient lock failure stamped -1. A non-retryable -1 keeps its stamp and is reported as needs_a_human.';
