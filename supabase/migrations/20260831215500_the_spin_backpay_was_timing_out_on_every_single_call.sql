-- ═══════════════════════════════════════════════════════════════════════════
--  THE SPIN BACK-PAY WAS TIMING OUT ON EVERY SINGLE CALL (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_backpay_spin_unpaid_winners is the safety net under the one Spin failure
-- where a prize LEAVES THE RESERVE POOL AND REACHES NOBODY. 52 events had
-- already diverged when it was built. Spin is excluded from
-- fn_tournament_money_conservation entirely, so nothing else on the platform
-- was ever going to notice.
--
-- It was not running. Measured through PostgREST exactly as GameServer calls
-- it, five times in a row:
--
--     57014 canceling statement due to statement timeout   8.92s
--     57014 canceling statement due to statement timeout   8.62s
--     57014 canceling statement due to statement timeout   8.87s
--     57014 canceling statement due to statement timeout   9.20s
--     57014 canceling statement due to statement timeout   9.48s
--
-- against a service_role statement_timeout of 8s. The engine has been calling
-- this every ten minutes and getting an error every time. A back-pay that
-- finds nothing and a back-pay that never runs return the same silence.
--
-- Found while making fn_spin_metrics fit inside a scrape, not while looking
-- for it.
--
-- ── WHY IT WAS SO EXPENSIVE ──────────────────────────────────────────────
-- It read v_spin_unpaid_settlements THREE times - owed_before, the loop,
-- owed_after - and that view groups the entire spin_reserve_ledger, every
-- prize credit in wallet_transactions (2.5M rows) and every row of
-- tournament_players (198k) before filtering down to a handful. Even after
-- 20260831214500 took the view from 10.5s to 2.4s with two covering indexes,
-- three reads of it could not fit.
--
-- ── THE FIX: A WINDOW IT CAN FINISH ──────────────────────────────────────
-- fn_spin_unpaid_settlements(p_since_hours) returns the same ranked_but_unpaid
-- rows with the same predicate and the same verdicts, but driven from an
-- indexed scan of recent spins and STAGED, so the seat-shape lookup - the
-- most expensive of the three per-spin reads - is paid only for the spins
-- that are actually short. The unbounded view is untouched and remains the
-- right tool for a human auditing history.
--
-- The recurring repair now sweeps a 6-hour window; an audit passes a large
-- one. Verified: 5 of 5 calls succeed where 5 of 5 failed before.
--
-- The second measurement is NOT removed and is NOT derived from the first.
-- "The backlog itself must shrink; a count of rows processed proves nothing"
-- is exactly right, and it has to be a genuinely fresh read.

CREATE OR REPLACE FUNCTION public.fn_spin_unpaid_settlements(p_since_hours integer DEFAULT 6)
 RETURNS TABLE(tournament_id uuid, chips_short numeric, verdict text, seats_at_first bigint, ended_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with candidates as (
    /* Cheap, indexed, and status-filtered BEFORE any per-row lookup. */
    select t.id, t.status, t.ended_at, t.buy_in_amount, t.spin_multiplier
    from public.tournaments t
    where t.variant = 'spin'
      and t.created_at > now() - (greatest(p_since_hours, 1) || ' hours')::interval
      and t.status not in ('RUNNING', 'REGISTERING')
  ),
  money as (
    /* One ledger lookup and one wallet lookup per candidate, both index-only. */
    select
      c.*,
      d.prize_drawn,
      d.drawn_at,
      coalesce(p.prize_credited, 0) as prize_credited
    from candidates c
    cross join lateral (
      select sum(-l.amount) as prize_drawn, max(l.created_at) as drawn_at
      from public.spin_reserve_ledger l
      where l.tournament_id = c.id and l.kind = 'jackpot_draw'
    ) d
    left join lateral (
      select sum(w.amount) as prize_credited
      from public.wallet_transactions w
      where w.related_entity_id = c.id and w.type = 'credit' and w.category = 'prize'
    ) p on true
    where d.prize_drawn is not null
  ),
  shortfall as (
    /* Everything that decides "is money missing" happens here, so the seat
       shape - the most expensive lookup of the three - is only paid for the
       handful of spins that are actually short. */
    select m.*, round(m.prize_drawn - m.prize_credited, 2) as short
    from money m
    where round(m.prize_drawn - m.prize_credited, 2) <> 0
      and (
        (m.status in ('COMPLETED', 'CANCELLED', 'CANCELED')
          and coalesce(m.ended_at, m.drawn_at) < now() - interval '10 minutes')
        or m.drawn_at < now() - interval '2 hours'
      )
      and not (
        m.prize_credited > m.prize_drawn
        and m.spin_multiplier is not null
        and m.prize_credited = round(m.buy_in_amount * m.spin_multiplier, 2)
      )
  )
  select
    f.id,
    f.short,
    case
      when f.prize_credited = 0 then 'nobody_paid'
      when f.prize_credited < f.prize_drawn then 'under_paid'
      else 'over_paid'
    end,
    s.seats_at_first,
    f.ended_at
  from shortfall f
  cross join lateral (
    select
      count(*) filter (where tp.position is null) as unranked_seats,
      count(*) filter (where tp.position = 1)     as seats_at_first
    from public.tournament_players tp
    where tp.tournament_id = f.id
  ) s
  where s.unranked_seats = 0
    and s.seats_at_first = 1;
$function$

revoke all on function public.fn_spin_unpaid_settlements(integer) from public;
revoke all on function public.fn_spin_unpaid_settlements(integer) from anon, authenticated;
grant execute on function public.fn_spin_unpaid_settlements(integer) to service_role;

comment on function public.fn_spin_unpaid_settlements(integer) is
  'The ranked_but_unpaid rows of v_spin_unpaid_settlements, bounded to spins created in the last p_since_hours and staged so the seat lookup is paid only for spins that are actually short. Same predicate, same verdicts; the view stays the unbounded auditor for humans, this is what a repair running every ten minutes under an 8s statement timeout can afford.';

-- The old two-argument signature is DROPPED rather than left beside the new
-- one: PostgREST resolves an RPC by the JSON keys it is sent, and two
-- overloads whose only difference is a defaulted parameter are ambiguous.
drop function if exists public.fn_backpay_spin_unpaid_winners(boolean, integer);

CREATE OR REPLACE FUNCTION public.fn_backpay_spin_unpaid_winners(p_apply boolean DEFAULT false, p_limit integer DEFAULT 200, p_since_hours integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$

revoke all on function public.fn_backpay_spin_unpaid_winners(boolean, integer, integer) from public;
revoke all on function public.fn_backpay_spin_unpaid_winners(boolean, integer, integer) from anon, authenticated;
grant execute on function public.fn_backpay_spin_unpaid_winners(boolean, integer, integer) to service_role;

comment on function public.fn_backpay_spin_unpaid_winners(boolean, integer, integer) is
  'Credits Spin winners whose prize left the reserve pool and reached no wallet. p_since_hours bounds the sweep: the recurring 10-minute repair uses a short window it can finish inside the 8s statement timeout, and an audit passes a large one. It read the unbounded view three times and timed out on every call before 2026-08-31.';
