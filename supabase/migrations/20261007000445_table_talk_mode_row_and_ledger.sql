-- 20261006183003_table_talk_mode_row_and_ledger.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- TABLE TALK AT THE FELT (Phase 10 of the Fleet Content Programme, 2026-10-06)
--
-- A seated horse may say one short chat line after a hand event at a cash
-- table: a big pot won, a showdown loss with two pair or better, a full house
-- or better shown by a winner, or a player sitting down. The line is an
-- ordinary table_chat row (message_type 'player', the horse's own user_id,
-- the same four columns the browser writes), inserted by the engine through
-- the service role, so every client renders it exactly as a human's line.
-- Writer: server/src/services/HorseTableTalk.ts.
--
-- Two things have to exist in the database before that code is released:
--
--   1. THE SWITCH. horse_post_modes gets a 'table_talk' row, inserted
--      DISABLED. This is the 2026-09-06 rule ("ANYTIME YOU CREATE SOME NEW
--      WAY FOR A HORSE TO POST ... I NEED TO APPROVE IT FIRST",
--      20260906122535): a new way to post starts false, and only the owner
--      turns it on, with one UPDATE and no deploy. The engine reads this row
--      and content_settings.engine_enabled every 30 seconds and writes
--      nothing while either says no. This file never UPDATEs enabled.
--
--   2. THE LEDGER. horse_table_talk_ledger records one row per line said:
--      which horse, at which table, on which hand, which event and voice,
--      and the normalised phrase. UNIQUE (table_id, hand_number) is the
--      claim: an engine process inserts the row BEFORE the chat row, so two
--      processes (a horse sits at up to four tables) can never both speak on
--      one hand at one table, and a conflict is silence, not a retry. The
--      indexes serve the owner's limits, read before every claim: three
--      lines per horse per hour (horse_id, said_at), one line per table per
--      four hands (table_id, said_at), and no repeated phrase within a day
--      for a horse or two hours at a table (phrase_norm, said_at).
--      hand_number is the GLOBAL hand number (global_hand_number_seq), which
--      is why the hands-between rules count hand_history rows at the table
--      rather than subtracting hand numbers.
--
-- Service role only, like horse_phrase_ledger (20260908034354): a row names
-- a horse, and a browser must never be able to read which seats are horses
-- (tests/horse-identity-is-not-readable.law.test.ts). RLS is on with no
-- policy for any browser role, and the post-flight below refuses to commit
-- if a player role can SELECT the table or a read policy exists.
--
-- horse_phrase_ledger.table_id (reserved for table talk on 2026-09-08) is
-- left untouched: its documented rule ("refuse a phrase used by any horse in
-- 48 hours", writer workers ContentLedger.ts) belongs to the social
-- programme and would be exhausted by a fleet speaking from a small pool.
--
-- RELEASE ORDER. Apply this file first; then the engine release
-- (stage-engine-release.yml -> auto-deploy-hetzner.yml) can land, because
-- the Hetzner doors gate requires every object the build touches to exist.
-- Rollback of the behaviour is the same UPDATE with enabled = false, or
-- content_settings.engine_enabled = false; both take effect within 30 s.
--
-- @live-proof: (to_regclass('public.horse_table_talk_ledger') IS NOT NULL AND EXISTS (SELECT 1 FROM public.horse_post_modes WHERE mode = 'table_talk') AND NOT has_table_privilege('authenticated', 'public.horse_table_talk_ledger', 'SELECT'))
--
-- Apply once, outside the :50-:03 UTC break window, as one transaction.
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- 1. THE SWITCH: a new way for a horse to post is OFF until the owner approves it.
INSERT INTO public.horse_post_modes (mode, enabled, description)
VALUES (
  'table_talk',
  false,
  'One short chat line from a seated horse at a cash table after a hand event (big pot won, showdown loss, big hand shown, arrival). Engine-written to table_chat as an ordinary player line. OFF until the owner approves the sample lines.'
)
ON CONFLICT (mode) DO NOTHING;

DO $mode$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.horse_post_modes WHERE mode = 'table_talk') THEN
    RAISE EXCEPTION 'POST-FLIGHT: horse_post_modes has no table_talk row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.horse_post_modes WHERE mode = 'table_talk' AND enabled) THEN
    RAISE EXCEPTION 'POST-FLIGHT: table_talk must ship disabled; only the owner turns it on';
  END IF;
  RAISE NOTICE 'horse_post_modes: table_talk present and disabled, awaiting the owner';
END
$mode$;

-- 2. THE LEDGER: one row per line said, claimed before the chat row is written.
CREATE TABLE IF NOT EXISTS public.horse_table_talk_ledger (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id    uuid NOT NULL,
  hand_number bigint NOT NULL,
  horse_id    uuid NOT NULL,
  event       text NOT NULL,
  voice       text NOT NULL,
  phrase_norm text NOT NULL,
  said_at     timestamptz NOT NULL DEFAULT now(),
  chat_id     uuid NULL,
  CONSTRAINT horse_table_talk_ledger_one_line_per_hand UNIQUE (table_id, hand_number)
);

CREATE INDEX IF NOT EXISTS idx_horse_table_talk_ledger_horse_said
  ON public.horse_table_talk_ledger (horse_id, said_at DESC);
CREATE INDEX IF NOT EXISTS idx_horse_table_talk_ledger_table_said
  ON public.horse_table_talk_ledger (table_id, said_at DESC);
CREATE INDEX IF NOT EXISTS idx_horse_table_talk_ledger_phrase_said
  ON public.horse_table_talk_ledger (phrase_norm, said_at DESC);

ALTER TABLE public.horse_table_talk_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.horse_table_talk_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.horse_table_talk_ledger TO service_role;
REVOKE ALL ON SEQUENCE public.horse_table_talk_ledger_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.horse_table_talk_ledger_id_seq TO service_role;

COMMENT ON TABLE public.horse_table_talk_ledger IS
  'Engine-written claim per horse line at the felt; the UNIQUE pair is what makes one line per hand per table true across engine processes. Service role only: a row names a horse. Writer: server/src/services/HorseTableTalk.ts. 2026-10-06.';
COMMENT ON COLUMN public.horse_table_talk_ledger.hand_number IS
  'The global hand number (global_hand_number_seq) the line was said on. Global, so a difference of two values is not a count of hands at the table; the hands-between rules count hand_history rows instead.';
COMMENT ON COLUMN public.horse_table_talk_ledger.phrase_norm IS
  'The template of the line, lowercased, punctuation and placeholder braces dropped, digit runs folded to n. Readers refuse a phrase the same horse used within 24 hours or anyone used at the same table within 2 hours.';
COMMENT ON COLUMN public.horse_table_talk_ledger.chat_id IS
  'Reserved for the table_chat row id of the line. Null in the first release: the chat insert returns no row and nothing reads this yet.';

-- 3. POST-FLIGHT: the shape, and that no browser role can read a horse out of it.
DO $post$
BEGIN
  IF to_regclass('public.horse_table_talk_ledger') IS NULL THEN
    RAISE EXCEPTION 'POST-FLIGHT: horse_table_talk_ledger did not land';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.horse_table_talk_ledger'::regclass
       AND contype = 'u'
       AND conname = 'horse_table_talk_ledger_one_line_per_hand'
  ) THEN
    RAISE EXCEPTION 'POST-FLIGHT: the UNIQUE (table_id, hand_number) claim is missing';
  END IF;
  IF (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'horse_table_talk_ledger'
         AND indexname IN ('idx_horse_table_talk_ledger_horse_said',
                           'idx_horse_table_talk_ledger_table_said',
                           'idx_horse_table_talk_ledger_phrase_said')) <> 3 THEN
    RAISE EXCEPTION 'POST-FLIGHT: a cadence index on horse_table_talk_ledger is missing';
  END IF;
  IF has_table_privilege('anon', 'public.horse_table_talk_ledger', 'SELECT')
     OR has_table_privilege('authenticated', 'public.horse_table_talk_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'POST-FLIGHT: horse_table_talk_ledger grants SELECT to a player role';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.horse_table_talk_ledger'::regclass) THEN
    RAISE EXCEPTION 'POST-FLIGHT: RLS is off on horse_table_talk_ledger';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'horse_table_talk_ledger'
       AND cmd IN ('SELECT', 'ALL') AND roles::text ~ '(public|anon|authenticated)'
  ) THEN
    RAISE EXCEPTION 'POST-FLIGHT: a read policy on horse_table_talk_ledger would expose horse ids';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.horse_table_talk_ledger', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.horse_table_talk_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'POST-FLIGHT: the service role cannot write the ledger the engine claims in';
  END IF;
  RAISE NOTICE 'horse_table_talk_ledger ready: service role only, one line per hand per table';
END
$post$;

COMMIT;
