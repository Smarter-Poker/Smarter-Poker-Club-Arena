-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906121010; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906121010   (the stamp IS the apply time, UTC: 2026-09-06 12:10:10)
--   name        twelve_more_channels_each_one_resolved_first
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3208 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906121010 IS ALREADY IN
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

-- Twelve more channels, each one resolved against YouTube first.
--
-- The Phase 4 contract asked for 200 poker channels. Guessing handles to hit
-- a number produces rows that fail silently every hour, so every candidate is
-- resolved to its UC... id BEFORE it is written, and only the ones that
-- answer are seeded. channel_id is stored, so the scraper never has to ask
-- again.
--
-- A note on how the first attempt went wrong, because it is a trap worth
-- recording. A shell probe of 30 candidates reported 27 missing. It was
-- wrong twice over:
--
--   * YouTube answers a burst of channel-page requests with a ~755-byte
--     throttle page, HTTP 200. Probing quickly made EVERY handle look dead,
--     including @LiveattheBike and @PhilHellmuth, which had resolved minutes
--     earlier. Reading that as "gone" would have retired the registry.
--   * The probe matched only "channelId", and a real channel page can carry
--     none - @JonathanLittle has no such key at all. The scraper's resolver
--     now tries og:url FIRST, which is the page's own canonical statement of
--     which channel it is and survives the layout changes that move the JSON
--     blobs around.
--
-- Re-run with the real resolver, four seconds apart: 12 of 18 resolved. The
-- instrument was the defect, not the channels.

INSERT INTO public.content_sources (domain, kind, name, handle, channel_id, category) VALUES
  ('poker','youtube_channel','Jonathan Little Poker','@JonathanLittle','UC_o_HlX7ut2GO-IdtQSnLDg','training'),
  ('poker','youtube_channel','Hungry Horse Poker','@HungryHorsePoker','UCFk_6LoABn90_Fzp4NBjtIA','vlog'),
  ('poker','youtube_channel','Poker Fraud Alert','@PokerFraudAlert','UC9OZdpAk5-jagmTB7ozyM7A','celebrity'),
  ('poker','youtube_channel','Hustler Casino','@HustlerCasino','UCBjzjaHYT171sfXCZ3c4iPQ','stream'),
  ('poker','youtube_channel','Global Poker','@GlobalPoker','UCXZPDxjqBw1bAaKAVwmXbmg','tour'),
  ('poker','youtube_channel','Americas Cardroom','@ACRPoker','UCeYXf9JZU5n921o_HybFTvw','tour'),
  ('poker','youtube_channel','High Stakes Poker','@HighStakesPoker','UC1XCcGUES5gh4jTaRbR0FCQ','stream'),
  ('poker','youtube_channel','Natural8','@Natural8','UCedWDmchMCK_KApL0Y02cjw','tour'),
  ('poker','youtube_channel','PokerStars Sports','@PokerStarsSports','UCq4ROkoQkqzVyhCb-6mknGQ','tour'),
  ('poker','youtube_channel','Poker Masters','@PokerMasters','UCrgepoH2Uqm4wKz00tXUGAQ','tour'),
  ('poker','youtube_channel','Bicycle Casino','@TheBicycleCasino','UC1P6VuQNmOJl6jlAkP7PErw','stream'),
  ('poker','youtube_channel','PokerGO Sport','@PokerGOSport','UCGWkDcYbDKP9r--ym28YwAQ','tour')
ON CONFLICT (domain, name) DO UPDATE
  SET channel_id = COALESCE(EXCLUDED.channel_id, public.content_sources.channel_id),
      is_active = true;

DO $$
DECLARE v_total int; v_resolved int;
BEGIN
  SELECT count(*) INTO v_total    FROM public.content_sources
   WHERE domain='poker' AND kind='youtube_channel' AND is_active;
  SELECT count(*) INTO v_resolved FROM public.content_sources
   WHERE domain='poker' AND kind='youtube_channel' AND is_active AND channel_id IS NOT NULL;
  RAISE NOTICE 'poker channels: % active, % already resolved to a UC id', v_total, v_resolved;
END $$;
