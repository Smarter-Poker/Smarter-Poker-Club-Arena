-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815202740 "publish_dead_realtime_subscriptions_platform_wide"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d07e8958375175db3307d9bbb3bc4d67 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PHASE: DEAD-WIRING SWEEP 2026-08-15.
-- Cross-referencing every postgres_changes subscription in both repos (139
-- distinct tables) against the supabase_realtime publication found 30 tables
-- the client listens to that were NEVER published. Each of those subscriptions
-- opens a channel, receives nothing forever, and the UI silently shows only
-- what was true at mount. This is the same defect that made the tournament
-- lobby, standings and bounty badges appear frozen.
--
-- Most consequential: `wallets` — the player's chip balance never updated live
-- anywhere in the product.
--
-- DELIBERATELY EXCLUDED:
--   table_seats  — 4.73 MILLION writes (the engine stack-syncs constantly).
--                  Publishing it would flood realtime, and it is redundant:
--                  seat/stack state already reaches the table over the engine
--                  WebSocket (TableStateHub). The client subscription there is
--                  dead weight and should be removed in the client instead.
--
-- REPLICA IDENTITY: FULL only on low-write tables (so UPDATE/DELETE payloads
-- carry the old row for client-side diffing). The hot tables keep the default
-- primary-key identity to avoid inflating WAL.

DO $$
DECLARE
  v_hot   text[] := ARRAY['wallets','bbj_pools','chip_transactions','unions','union_wallets'];
  v_cold  text[] := ARRAY[
    'anti_cheat_events','anti_cheat_flags','audit_trail','bankroll_trips','bbj_winners',
    'cashout_requests','club_announcements','club_chat','club_diamond_wallets','club_shop_items',
    'club_shop_purchases','diamond_purchases','diamond_transactions','disputes','live_viewers',
    'messages','promotions','social_follows','social_likes','table_waitlist',
    'tournament_registrations','user_leaks','user_table_settings','user_training_leaks'
  ];
  t text;
  v_added int := 0;
  v_skipped int := 0;
BEGIN
  FOREACH t IN ARRAY (v_hot || v_cold) LOOP
    -- Only touch real tables that exist.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
       WHERE c.relname = t AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
    ) THEN
      v_skipped := v_skipped + 1;
      RAISE NOTICE 'skip % (table does not exist)', t;
      CONTINUE;
    END IF;

    IF t = ANY(v_cold) THEN
      EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      v_added := v_added + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'published % tables, skipped % missing', v_added, v_skipped;
END $$;

-- Assertion: wallets in particular must now be live.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND tablename='wallets') THEN
    RAISE EXCEPTION 'wallets is still not published for realtime';
  END IF;
END $$;
