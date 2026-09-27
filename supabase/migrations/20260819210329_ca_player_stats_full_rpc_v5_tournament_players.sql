-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819210329 "ca_player_stats_full_rpc_v5_tournament_players"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6cf299ce5dbfd4ff989fb65f818f38a5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v5: tournament stats came from tournament_registrations, which is EMPTY
-- platform-wide (0 rows) — so the Tournaments tab showed zeros for every
-- player. Real entries live in tournament_players (41,684 rows).
-- Mirrors repo file 20260819_ca_player_stats_full_rpc.sql.
DO $$
DECLARE
  src text;
  old_t text := $r1$tourn AS (
  SELECT count(*)::int AS entries,
         count(*) FILTER (WHERE coalesce(prize_amount, 0) > 0)::int AS cashes,
         count(*) FILTER (WHERE finish_rank = 1)::int AS wins,
         min(finish_rank) FILTER (WHERE finish_rank IS NOT NULL) AS best_finish,
         coalesce(sum(coalesce(buy_in_amount, 0) + coalesce(buy_in_fee, 0)), 0) AS total_buyins,
         coalesce(sum(coalesce(prize_amount, 0)), 0) AS total_winnings
  FROM tournament_registrations WHERE user_id = p_user
),
tourn_recent AS (
  SELECT t.name, t.start_time, t.variant, r.finish_rank, r.status,
         coalesce(r.prize_amount, 0) AS prize,
         coalesce(r.buy_in_amount, 0) + coalesce(r.buy_in_fee, 0) AS buyin
  FROM tournament_registrations r
  JOIN tournaments t ON t.id = r.tournament_id
  WHERE r.user_id = p_user
  ORDER BY t.start_time DESC NULLS LAST LIMIT 25
)$r1$;
  new_t text := $r2$tourn AS (
  SELECT count(*)::int AS entries,
         count(*) FILTER (WHERE coalesce(tp.prize, 0) > 0)::int AS cashes,
         count(*) FILTER (WHERE tp.position = 1 OR tp.status = 'winner')::int AS wins,
         min(tp.position) FILTER (WHERE tp.position IS NOT NULL) AS best_finish,
         coalesce(sum(coalesce(t.buy_in_amount, 0) + coalesce(t.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(t.addon_cost, 0) ELSE 0 END), 0) AS total_buyins,
         coalesce(sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0)), 0) AS total_winnings
  FROM tournament_players tp
  LEFT JOIN tournaments t ON t.id = tp.tournament_id
  WHERE tp.user_id = p_user
),
tourn_recent AS (
  SELECT t.name, t.start_time, t.variant,
         tp.position AS finish_rank, tp.status,
         coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) AS prize,
         coalesce(t.buy_in_amount, 0) + coalesce(t.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(t.addon_cost, 0) ELSE 0 END AS buyin
  FROM tournament_players tp
  JOIN tournaments t ON t.id = tp.tournament_id
  WHERE tp.user_id = p_user
  ORDER BY t.start_time DESC NULLS LAST LIMIT 25
)$r2$;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);
  IF position(old_t IN src) = 0 THEN
    RAISE EXCEPTION 'ca_player_stats_full: tournament_registrations CTE block not found; aborting';
  END IF;
  src := replace(src, old_t, new_t);
  IF position('tournament_registrations' IN src) <> 0 THEN
    RAISE EXCEPTION 'ca_player_stats_full: tournament_registrations still referenced after replace';
  END IF;
  EXECUTE src;
END $$;
