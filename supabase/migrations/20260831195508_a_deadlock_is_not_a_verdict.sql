-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831195508; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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
