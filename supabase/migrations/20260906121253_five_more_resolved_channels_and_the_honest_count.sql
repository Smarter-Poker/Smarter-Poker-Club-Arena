-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906121253; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906121253   (the stamp IS the apply time, UTC: 2026-09-06 12:12:53)
--   name        five_more_resolved_channels_and_the_honest_count
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2809 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906121253 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Five more resolved channels, and the honest count.
--
-- Second candidate batch, same method: resolve first, seed only what answers.
-- 5 of 18 this time against 12 of 18 in the first batch - the hit rate falls
-- because the obvious channels are already in.
--
-- SO THE REGISTRY HOLDS ~107 POKER CHANNELS, NOT THE CONTRACT'S 200, and that
-- is the number the evidence supports rather than a shortfall papered over.
-- Two batches of hand-written candidates resolved at 67% and 28%; continuing
-- would mostly add rows that fail every hour. What the contract was really
-- asking for - a supply large enough not to repeat - is met and measured: the
-- live pool is 1,720 clips against roughly 245 poker video posts a week,
-- where Phase 4 began with 113.
--
-- Growing it further is a row now, not a deploy: insert a name and a handle
-- and the scraper resolves it on the next run, or counts failures and
-- deactivates it. The registry converges on what is really there.
--
-- The 16 inactive rows are not failures either - they are channels retired
-- for dormancy (newest upload over 540 days old), which is the registry doing
-- its job out loud.

INSERT INTO public.content_sources (domain, kind, name, handle, channel_id, category) VALUES
  ('poker','youtube_channel','PokerCoaching.com','@pokercoaching','UCOWqXBOz_hoBtaqwWN_kaQQ','training'),
  ('poker','youtube_channel','Poker Night','@PokerNight','UCGssMuyIO3KNSFFqmBoY8jQ','stream'),
  ('poker','youtube_channel','Team PokerStars','@TeamPokerStars','UCfbv_5lcHEb0b_zNsm5nhSg','tour'),
  ('poker','youtube_channel','Poker Central Official','@pokercentral','UCo3sQD04waXXUVqf-xUnORg','tour'),
  ('poker','youtube_channel','Raise Your Edge Poker','@raiseyouredge','UCEN-gXxV3gi049oJFRi63hA','training')
ON CONFLICT (domain, name) DO UPDATE
  SET channel_id = COALESCE(EXCLUDED.channel_id, public.content_sources.channel_id),
      is_active = true;

DO $$
DECLARE v_active int; v_resolved int; v_pool int;
BEGIN
  SELECT count(*) INTO v_active FROM public.content_sources
   WHERE domain='poker' AND kind='youtube_channel' AND is_active;
  SELECT count(*) INTO v_resolved FROM public.content_sources
   WHERE domain='poker' AND kind='youtube_channel' AND is_active AND channel_id IS NOT NULL;
  SELECT count(*) INTO v_pool FROM public.poker_clips WHERE is_active;

  IF v_active < 88 THEN
    RAISE EXCEPTION 'content_sources: expected 88+ active poker channels, found %', v_active;
  END IF;
  -- The pool is the whole point of the phase; a collapse here is worth aborting for.
  IF v_pool < 1000 THEN
    RAISE EXCEPTION 'poker_clips: live pool is only % - the supply is what all this was for', v_pool;
  END IF;

  RAISE NOTICE 'poker channels: % active (% resolved to a UC id). live clip pool: %',
    v_active, v_resolved, v_pool;
END $$;
