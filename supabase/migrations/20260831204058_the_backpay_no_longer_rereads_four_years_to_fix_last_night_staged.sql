-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831204058; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_spin_unpaid_settlements(
  p_since_hours integer default 6
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
$$;

revoke all on function public.fn_spin_unpaid_settlements(integer) from public;
revoke all on function public.fn_spin_unpaid_settlements(integer) from anon, authenticated;
grant execute on function public.fn_spin_unpaid_settlements(integer) to service_role;

comment on function public.fn_spin_unpaid_settlements(integer) is
  'The ranked_but_unpaid rows of v_spin_unpaid_settlements, bounded to spins created in the last p_since_hours and staged so the seat lookup is paid only for spins that are actually short. Same predicate, same verdicts; the view stays the unbounded auditor for humans, this is what a repair running every ten minutes under an 8s statement timeout can afford.';
