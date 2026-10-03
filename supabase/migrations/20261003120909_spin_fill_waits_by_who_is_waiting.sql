-- 20261003120909_spin_fill_waits_by_who_is_waiting
--
-- WHO IS WAITING ON A PARTLY FILLED SPIN, AND FOR HOW LONG
--
-- SpinUnfilledBacklog (`poker_spin_unfilled_waits > 5`) fired all night on
-- 2026-10-02/03 at 12 to 66 boards and again at 11:00 UTC after the 10:55
-- restart. Measured on production 2026-10-03 against the same rows:
--
--   * Every Spin created 22:00-12:00 UTC started (8,832 of 8,835; the other
--     3 were still open at 12:00) and none was CANCELLED, so
--     fn_spin_expire_unfilled had nothing to refund. Creation to start:
--     median ~250 s, p90 ~360-650 s, worst ~15 min, every hour.
--   * Steady state at 12:0x UTC: 47 REGISTERING boards = 33 at 2/3 (horses
--     inside the human window) + 14 held empty at 0/3; 2 past their window.
--   * The window is Dan's rule (TournamentRecurringService,
--     SEAT_FIRST_HUMAN_WINDOW_*: the last seat is a human's for 90-350 s
--     before a horse may take it). ~700 Spins an hour x a ~220 s window is
--     ~40 boards at 2/3 at any instant, so a count of partly filled boards
--     above five is true by construction every minute of every hour.
--   * The third horse arrives a median 11 s after the window closes; every
--     board later than 120 s past its window in the last three hours had its
--     window close at :52-:55, i.e. inside the hourly platform freeze.
--   * No human sat at a Spin in those 14 hours. The one human Spin of the
--     week (2026-10-02 18:40) was dealt 26 s after the seat; a held-empty
--     probe at 12:06 UTC today (0/3 board, 1/3 after the seat) was full in
--     8.5 s and RUNNING in 17.5 s. Plain query timing of the body: 13 ms.
--
-- So the gauge counts the product working, and says nothing about the case
-- that matters: a REAL player who has paid for a seat and is waiting for
-- opponents. This function measures exactly that, plus the horse-only boards
-- whose human window closed and still did not fill (a genuine fill failure),
-- so the alert can be pointed at those instead of at the board itself.
--
-- Read-only: one STABLE SECURITY DEFINER read over the same predicate as
-- v_spin_unfilled_waits (spin, REGISTERING/ANNOUNCED, never started, 1 to
-- max-1 live seats). `is_horse` is used only to IDENTIFY who is in the seat
-- (CLAUDE.md 10.5, "Identification"); nothing is filtered out of a payout,
-- count or rule. The existing fn_spin_metrics and its unfilled_waits count
-- are untouched.
--
-- Columns:
--   human_unfilled_waits          partly filled boards with >= 1 live human seat
--   human_oldest_wait_seconds     longest any live human seat on those boards has
--                                 waited; 0 when no human is waiting (a measured
--                                 zero, not an unknown)
--   unfilled_past_window          partly filled boards whose human window
--                                 (start_time) closed more than 120 s ago
--   unfilled_oldest_wait_seconds  oldest live seat on any partly filled board; 0
--                                 when there is none
--
-- Applied with the merged-migration workflow outside the :50-:03 window,
-- one transaction, lock_timeout set (CLAUDE.md 2, rules 1, 7, 8).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_spin_fill_waits()
RETURNS TABLE(
  human_unfilled_waits bigint,
  human_oldest_wait_seconds numeric,
  unfilled_past_window bigint,
  unfilled_oldest_wait_seconds numeric
)
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
$function$;

COMMENT ON FUNCTION public.fn_spin_fill_waits() IS
  'Partly filled open Spins split by who is waiting: boards holding a live human seat and that human''s wait, boards whose human window closed >120s ago, and the oldest live seat. Read by the engine SpinMetrics collector; see docs/runbooks/spin-unfilled-backlog.md.';

REVOKE ALL ON FUNCTION public.fn_spin_fill_waits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_fill_waits() TO service_role;

COMMIT;
