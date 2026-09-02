-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831204216; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

drop function if exists public.fn_backpay_spin_unpaid_winners(boolean, integer);

create or replace function public.fn_backpay_spin_unpaid_winners(
  p_apply boolean default false,
  p_limit integer default 200,
  p_since_hours integer default 6
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  r record; v_ok boolean;
  v_paid integer := 0; v_chips numeric := 0; v_skipped integer := 0;
  v_owed_before numeric; v_owed_after numeric;
BEGIN
  create temp table if not exists _spin_unpaid_snapshot (
    tournament_id uuid,
    chips_short numeric,
    verdict text,
    seats_at_first bigint,
    ended_at timestamptz
  ) on commit drop;
  /* TRUNCATE, not DELETE: the safeupdate library preloaded on the
     authenticator role rejects a DELETE with no WHERE clause outright. */
  truncate _spin_unpaid_snapshot;

  insert into _spin_unpaid_snapshot
  select s.tournament_id, s.chips_short, s.verdict, s.seats_at_first, s.ended_at
    from public.fn_spin_unpaid_settlements(p_since_hours) s
   where s.chips_short > 0.01;

  select coalesce(sum(chips_short), 0) into v_owed_before
    from _spin_unpaid_snapshot;

  FOR r IN
    SELECT s.tournament_id, s.chips_short, s.verdict,
           (SELECT tp.user_id FROM public.tournament_players tp
             WHERE tp.tournament_id = s.tournament_id AND tp.position = 1
             LIMIT 1) AS winner
      FROM _spin_unpaid_snapshot s
     WHERE NOT EXISTS (SELECT 1 FROM public.spin_unpaid_backpay_log l
                        WHERE l.tournament_id = s.tournament_id)
     ORDER BY s.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    IF r.winner IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF p_apply THEN
      v_ok := public.fn_credit_and_log(
        r.winner, r.chips_short,
        'spin:' || r.tournament_id || ':prize:' || r.winner || ':unpaid_backpay',
        'prize',
        'Spin winner back-pay (prize drawn from the reserve but never credited)',
        r.tournament_id);

      IF COALESCE(v_ok, false) THEN
        UPDATE public.tournament_players
           SET prize = round(COALESCE(prize, 0) + r.chips_short, 2)
         WHERE tournament_id = r.tournament_id AND user_id = r.winner;

        INSERT INTO public.spin_unpaid_backpay_log
          (tournament_id, user_id, amount, verdict)
        VALUES (r.tournament_id, r.winner, r.chips_short, r.verdict)
        ON CONFLICT (tournament_id) DO NOTHING;

        v_paid := v_paid + 1;
        v_chips := v_chips + r.chips_short;
      END IF;
    ELSE
      v_paid := v_paid + 1;
      v_chips := v_chips + r.chips_short;
    END IF;
  END LOOP;

  /* Second measurement, over the SAME window and genuinely re-read. The
     backlog itself must shrink; a count of rows processed proves nothing. */
  SELECT COALESCE(sum(chips_short), 0) INTO v_owed_after
    FROM public.fn_spin_unpaid_settlements(p_since_hours)
   WHERE chips_short > 0.01;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'window_hours', p_since_hours,
    'winners_paid', v_paid, 'chips', round(v_chips, 2),
    'skipped_no_winner', v_skipped,
    'owed_before', round(v_owed_before, 2), 'owed_after', round(v_owed_after, 2));
END;
$function$;

revoke all on function public.fn_backpay_spin_unpaid_winners(boolean, integer, integer) from public;
revoke all on function public.fn_backpay_spin_unpaid_winners(boolean, integer, integer) from anon, authenticated;
grant execute on function public.fn_backpay_spin_unpaid_winners(boolean, integer, integer) to service_role;

comment on function public.fn_backpay_spin_unpaid_winners(boolean, integer, integer) is
  'Credits Spin winners whose prize left the reserve pool and reached no wallet. p_since_hours bounds the sweep: the recurring 10-minute repair uses a short window it can finish inside the 8s statement timeout, and an audit passes a large one. It read the unbounded view three times and timed out every call before 2026-08-31.';
