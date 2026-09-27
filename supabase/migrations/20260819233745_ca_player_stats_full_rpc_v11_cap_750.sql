-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233745 "ca_player_stats_full_rpc_v11_cap_750"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fa1c9f83b6c78e912d297c84aebb49f0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v11: lower the analysis window 1500 -> 750 hands.
-- Measured on production for the heaviest account: 1500 hands = 5.7s warm and
-- an outright cancel under concurrent load, against the 8s statement_timeout on
-- the `authenticated` role. Per-hand cost is ~3.8ms (1500 random heap fetches
-- plus per-hand JSONB expansion of players/actions/winners), so 750 lands near
-- 3s and keeps real headroom.
--
-- This changes nothing for ordinary players: anyone under 750 hands still gets
-- their full history. Above it the window is disclosed in the UI via
-- overall.hand_cap / hands_capped ("Based on your most recent N hands") rather
-- than being passed off as a lifetime total.
DO $mig$
DECLARE src text;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);
  IF position('c_cap  constant int := 1500;' IN src) = 0 THEN
    RAISE EXCEPTION 'expected c_cap 1500';
  END IF;
  IF position('''hand_cap'', 1500,' IN src) = 0 THEN
    RAISE EXCEPTION 'expected hand_cap literal 1500';
  END IF;
  IF position('''hands_capped'', (hands >= 1500)' IN src) = 0 THEN
    RAISE EXCEPTION 'expected hands_capped literal 1500';
  END IF;
  src := replace(src, 'c_cap  constant int := 1500;', 'c_cap  constant int := 750;');
  src := replace(src, '''hand_cap'', 1500,', '''hand_cap'', 750,');
  src := replace(src, '''hands_capped'', (hands >= 1500)', '''hands_capped'', (hands >= 750)');
  EXECUTE src;
END $mig$;
