-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831203955; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_spin_unpaid_settlements(
  p_since_hours integer default 72
)
returns table (
  tournament_id uuid,
  chips_short numeric,
  verdict text,
  seats_at_first bigint,
  ended_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id,
    round(d.prize_drawn - coalesce(p.prize_credited, 0), 2),
    case
      when coalesce(p.prize_credited, 0) = 0 then 'nobody_paid'
      when coalesce(p.prize_credited, 0) < d.prize_drawn then 'under_paid'
      else 'over_paid'
    end,
    coalesce(s.seats_at_first, 0),
    t.ended_at
  from public.tournaments t
  cross join lateral (
    select sum(-l.amount) as prize_drawn, max(l.created_at) as drawn_at
    from public.spin_reserve_ledger l
    where l.tournament_id = t.id and l.kind = 'jackpot_draw'
  ) d
  left join lateral (
    select sum(w.amount) as prize_credited
    from public.wallet_transactions w
    where w.related_entity_id = t.id and w.type = 'credit' and w.category = 'prize'
  ) p on true
  left join lateral (
    select
      count(*) filter (where tp.position is null) as unranked_seats,
      count(*) filter (where tp.position = 1)     as seats_at_first
    from public.tournament_players tp
    where tp.tournament_id = t.id
  ) s on true
  where t.variant = 'spin'
    and t.created_at > now() - (greatest(p_since_hours, 1) || ' hours')::interval
    and d.prize_drawn is not null
    and round(d.prize_drawn - coalesce(p.prize_credited, 0), 2) <> 0
    and (
      (t.status in ('COMPLETED', 'CANCELLED', 'CANCELED')
        and coalesce(t.ended_at, d.drawn_at) < now() - interval '10 minutes')
      or (d.drawn_at < now() - interval '2 hours'
        and t.status not in ('RUNNING', 'REGISTERING'))
    )
    and not (
      coalesce(p.prize_credited, 0) > d.prize_drawn
      and t.spin_multiplier is not null
      and coalesce(p.prize_credited, 0) = round(t.buy_in_amount * t.spin_multiplier, 2)
    )
    and coalesce(s.unranked_seats, 0) = 0
    and coalesce(s.seats_at_first, 0) = 1;
$$;

revoke all on function public.fn_spin_unpaid_settlements(integer) from public;
revoke all on function public.fn_spin_unpaid_settlements(integer) from anon, authenticated;
grant execute on function public.fn_spin_unpaid_settlements(integer) to service_role;

comment on function public.fn_spin_unpaid_settlements(integer) is
  'The ranked_but_unpaid rows of v_spin_unpaid_settlements, bounded to spins created in the last p_since_hours and driven by idx_tournaments_spin_draws. Same predicate, same verdicts; the view stays the unbounded auditor for humans, this is what a repair running every ten minutes under an 8s statement timeout can afford.';
