-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819225100 "ca_player_stats_full_rpc_v10_stakes_breakdown"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 75a9814f3b4cf52f403dc10945fdd14d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v10: add a per-stake (big blind) cash breakdown so a player can see which
-- game size is carrying or bleeding their results instead of one blended
-- number. Mirrors repo file 20260819_ca_player_stats_full_rpc.sql.
DO $mig$
DECLARE
  src text;
  anchor_cte text := 'variants AS (';
  stakes_cte text := $s$stakes AS (
  SELECT big_blind,
         count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit), 0), 2) AS profit,
         CASE WHEN count(*) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)), 0) / count(*) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored
  WHERE is_cash AND big_blind > 0
  GROUP BY big_blind
  ORDER BY big_blind DESC
),
variants AS ($s$;
  anchor_out text := $o$      'bb100', bb100)) FROM variants), '[]'::jsonb),$o$;
  stakes_out text := $p$      'bb100', bb100)) FROM variants), '[]'::jsonb),
  'stakes', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'big_blind', big_blind,
      'hands', hands,
      'hands_won', hands_won,
      'profit', profit,
      'bb100', bb100) ORDER BY big_blind DESC) FROM stakes), '[]'::jsonb),$p$;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);
  IF position('''stakes''' IN src) <> 0 THEN RAISE EXCEPTION 'stakes already present'; END IF;
  IF position(anchor_cte IN src) = 0 THEN RAISE EXCEPTION 'variants CTE not found'; END IF;
  IF position(anchor_out IN src) = 0 THEN RAISE EXCEPTION 'variants output block not found'; END IF;
  src := replace(src, anchor_cte, stakes_cte);
  src := replace(src, anchor_out, stakes_out);
  EXECUTE src;
END $mig$;
