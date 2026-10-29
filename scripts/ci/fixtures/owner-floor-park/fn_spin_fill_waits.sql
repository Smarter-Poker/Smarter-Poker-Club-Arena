CREATE OR REPLACE FUNCTION public.fn_spin_fill_waits()
 RETURNS TABLE(human_unfilled_waits bigint, human_oldest_wait_seconds numeric, unfilled_past_window bigint, unfilled_oldest_wait_seconds numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with open_spins as (
    select t.id, coalesce(t.max_players, 3) as cap, t.start_time
    from public.tournaments t
    where t.variant = 'spin'
      and t.status in ('REGISTERING', 'ANNOUNCED')
      and t.started_at is null
  ),
  seats as (
    select o.id as tournament_id, o.cap, o.start_time, s.joined_at,
           coalesce(p.is_horse, false) as is_horse
    from open_spins o
    join public.tables tb on tb.tournament_id = o.id
    join public.table_seats s on s.table_id = tb.id and s.left_at is null
    left join public.profiles p on p.id = s.user_id
  ),
  boards as (
    select tournament_id,
           min(start_time) as window_ends,
           min(joined_at) as oldest_seat_at,
           min(joined_at) filter (where not is_horse) as oldest_human_seat_at
    from seats
    group by tournament_id, cap
    having count(*) between 1 and cap - 1
  )
  select
    count(*) filter (where oldest_human_seat_at is not null)::bigint,
    coalesce(round(extract(epoch from now() - min(oldest_human_seat_at))::numeric), 0),
    count(*) filter (where window_ends < now() - interval '120 seconds')::bigint,
    coalesce(round(extract(epoch from now() - min(oldest_seat_at))::numeric), 0)
  from boards;
$function$
