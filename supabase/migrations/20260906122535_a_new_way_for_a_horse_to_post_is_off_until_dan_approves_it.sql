-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906122535; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906122535   (the stamp IS the apply time, UTC: 2026-09-06 12:25:35)
--   name        a_new_way_for_a_horse_to_post_is_off_until_dan_approves_it
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3213 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906122535 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TABLE          public.horse_post_modes
--     POLICY         horse_post_modes_read
--     DROP           POLICY horse_post_modes_read
--     RLS-ENABLE     
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

-- A new way for a horse to post is OFF until Dan approves it.
--
-- Dan, 2026-09-06, on seeing the Phase 3 grounded hand posts live:
--   "WHAT THE HELL ARE THESE POSTS?! THEY ARE PURE TRASH. ANYTIME YOU CREATE
--    SOME NEW WAY FOR A HORSE TO POST, OR GIVE IT AN INSTRUCTION TO 'CREATE
--    NEW CONTENT' I NEED TO APPROVE IT FIRST."
--
-- He is right about the posts. They read as a database row with spaces in it:
--
--   "No hand, all narrative. Qh8c7d6sAd5c on 5s 4s Td 3c 6d. won 184bb"
--   "nah QTs, board came 6c 7c 9c 9h 3s, won 149bb, right."
--
-- Nobody writes that. They were true, they passed every law test written for
-- them, and not one of those tests asked whether a person would want to read
-- one. 59 of them were hidden from the feed today.
--
-- This adds the switch that should have existed before the path shipped. Each
-- WAY a horse can post is a row, and a new one starts FALSE. Turning it on is
-- Dan's, not an agent's - the flag is data, so approving costs him one UPDATE
-- and no deploy.
--
-- grounded_hand is created disabled, which is the point.

CREATE TABLE IF NOT EXISTS public.horse_post_modes (
  mode         text PRIMARY KEY,
  enabled      boolean NOT NULL DEFAULT false,
  description  text NOT NULL,
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.horse_post_modes IS
  'One row per WAY a horse can post. A new mode starts disabled and only Dan turns it on (CLAUDE.md 10.11). Added 2026-09-06 after grounded hand posts reached the feed reading like database rows.';

INSERT INTO public.horse_post_modes (mode, enabled, description, approved_by, approved_at) VALUES
  ('poker_video',   true,  'A poker clip with a written caption. Predates this rule; running.', 'pre-existing', now()),
  ('sports_video',  true,  'A sports clip with a written caption. Predates this rule; running.', 'pre-existing', now()),
  ('poker_news',    true,  'A link to a poker news article with a comment. Predates this rule; running.', 'pre-existing', now()),
  ('sports_news',   true,  'A link to a sports article with a comment. Predates this rule; running.', 'pre-existing', now()),
  ('grounded_hand', false, 'A post about a hand the horse actually played, built from horse_hand_reviews. DISABLED 2026-09-06: shipped reading as raw card notation ("Qh8c7d6sAd5c on 5s 4s Td 3c 6d. won 184bb"). Needs Dan to see and approve the rewritten voice before it runs again.', NULL, NULL),
  ('grounded_session', false, 'A post about the horse''s session results. Same family as grounded_hand and disabled with it.', NULL, NULL)
ON CONFLICT (mode) DO NOTHING;

ALTER TABLE public.horse_post_modes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS horse_post_modes_read ON public.horse_post_modes;
CREATE POLICY horse_post_modes_read ON public.horse_post_modes FOR SELECT USING (true);

DO $$
DECLARE v_off int;
BEGIN
  SELECT count(*) INTO v_off FROM public.horse_post_modes WHERE NOT enabled;
  IF v_off < 2 THEN
    RAISE EXCEPTION 'horse_post_modes: the grounded modes must be disabled, found % disabled', v_off;
  END IF;
  RAISE NOTICE 'horse_post_modes ready: % modes disabled pending approval', v_off;
END $$;
