-- ═══════════════════════════════════════════════════════════════════════════
--  BIGGEST HITS IS ONE ROW PER SPIN, AND IT IS THE WINNER
--  2026-08-31, spins audit part 6
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_spin_leaderboards` builds `biggest_hits` from the `spins` CTE, which is
-- one row per PAID SEAT rather than one row per spin:
--
--     select s.username, s.multiplier, s.buy_in, s.prize, s.ended_at
--       from spins s
--      where s.prize > 0
--      order by s.multiplier desc, s.ended_at desc
--      limit 10
--
-- A Spin at 10x and above pays more than first place — 0.80/0.20 at 10x and
-- 0.80/0.12/0.08 at 25x, 50x and 100x (SPIN_TIERS.payouts). So a single 100x
-- contributes THREE rows, and the tie-break is `ended_at`, which is identical
-- for all three. Measured on production, the live board:
--
--     24.00   2.00 buy-in  100x   <- second place, top of "Biggest Hits"
--     160.00  2.00 buy-in  100x   <- the actual winner, listed below it
--     16.00   2.00 buy-in  100x   <- third place
--     ... and 400.00 at 50x further down again
--
-- Ten rows, four tournaments, headlined by a second-place payout with the
-- winner underneath and a third-place 16.00 above a 400.00. A player reading
-- it sees the same game three times and the wrong name against the number.
-- It also BURIED real wins: a 1,000.00 on a 50-chip 25x was off the board
-- entirely, because three 100x games had eaten six of the ten slots with
-- their 16s and 24s.
--
-- ONE ROW PER SPIN, AND IT IS THE ONE WHO WON IT. `distinct on
-- (tournament_id) ... order by tournament_id, prize desc` takes the largest
-- payout from each game, then the board orders by multiplier (the story a
-- Spin tells) and by prize within it, so a bigger win never sits under a
-- smaller one.
--
-- The response SHAPE is unchanged — username, multiplier, buy_in, prize,
-- ended_at — so no client needs to move. `most_spins` and `best_net` are
-- untouched: both group by username and were already correct, because a seat
-- is exactly what they mean to count.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5): no is_horse filter here, in either
-- direction, exactly as 20260830064500 established.
--
-- APPLIED to production 2026-08-31 as migration 20260831192950. The board
-- immediately afterwards: 10 rows, 10 distinct tournaments, every one a
-- winner, and the 1,000.00 back on it.
CREATE OR REPLACE FUNCTION public.fn_spin_leaderboards(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  with win as (
    select greatest(coalesce(p_days, 7), 1) as days
  ),
  spins as (
    select t.id                                        as tournament_id,
           coalesce(nullif(tp.username, ''), 'Player') as username,
           coalesce(t.spin_multiplier, 0)              as multiplier,
           coalesce(t.buy_in_amount, 0)                as buy_in,
           coalesce(tp.prize, 0)                       as prize,
           t.ended_at
      from public.tournaments t
      join public.tournament_players tp on tp.tournament_id = t.id
     cross join win
     where t.variant = 'spin'
       and t.status = 'COMPLETED'
       and t.ended_at is not null
       and t.ended_at >= now() - make_interval(days => win.days)
       and tp.user_id is not null
  ),
  /* One paid seat per spin: the largest payout, which is first place. */
  winner_seat as (
    select distinct on (s.tournament_id)
           s.tournament_id, s.username, s.multiplier, s.buy_in, s.prize, s.ended_at
      from spins s
     where s.prize > 0
     order by s.tournament_id, s.prize desc
  ),
  biggest as (
    select w.username, w.multiplier, w.buy_in, w.prize, w.ended_at
      from winner_seat w
     order by w.multiplier desc, w.prize desc, w.ended_at desc
     limit 10
  ),
  most as (
    select s.username, count(*) as spins
      from spins s
     group by s.username
     order by count(*) desc
     limit 10
  ),
  net as (
    select s.username,
           round(sum(s.prize) - sum(s.buy_in), 2) as net,
           count(*)                               as spins
      from spins s
     group by s.username
    having round(sum(s.prize) - sum(s.buy_in), 2) > 0
     order by round(sum(s.prize) - sum(s.buy_in), 2) desc
     limit 10
  )
  select jsonb_build_object(
    'ok', true,
    'days', (select days from win),
    'biggest_hits',
      coalesce((select jsonb_agg(to_jsonb(b) order by b.multiplier desc, b.prize desc, b.ended_at desc)
                  from biggest b), '[]'::jsonb),
    'most_spins',
      coalesce((select jsonb_agg(to_jsonb(m) order by m.spins desc) from most m), '[]'::jsonb),
    'best_net',
      coalesce((select jsonb_agg(to_jsonb(n) order by n.net desc) from net n), '[]'::jsonb)
  );
$fn$;

REVOKE ALL ON FUNCTION public.fn_spin_leaderboards(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_leaderboards(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_spin_leaderboards(integer) TO authenticated, service_role;

DO $$
DECLARE v jsonb; n integer; d integer;
BEGIN
  v := public.fn_spin_leaderboards(7);
  IF NOT COALESCE((v->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'fn_spin_leaderboards did not answer ok';
  END IF;

  -- The shape the client reads must survive.
  IF NOT (v ? 'biggest_hits' AND v ? 'most_spins' AND v ? 'best_net') THEN
    RAISE EXCEPTION 'a leaderboard key was lost';
  END IF;

  -- And the whole point: no spin may appear twice. Compare the number of
  -- rows against the number of DISTINCT (multiplier, buy_in, ended_at)
  -- triples, which identify a game.
  SELECT count(*), count(DISTINCT (e->>'multiplier', e->>'buy_in', e->>'ended_at'))
    INTO n, d
    FROM jsonb_array_elements(v->'biggest_hits') e;
  IF n <> d THEN
    RAISE EXCEPTION 'biggest_hits still lists the same spin more than once (% rows, % games)', n, d;
  END IF;
END $$;
