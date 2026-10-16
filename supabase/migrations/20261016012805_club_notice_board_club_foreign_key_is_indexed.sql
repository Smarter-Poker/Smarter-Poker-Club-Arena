-- 20261016012805_club_notice_board_club_foreign_key_is_indexed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Every Post-Deploy E2E run since the Club Messenger notice board was
-- installed stops in both certification jobs at the club deletability gate
-- (scripts/ci/check-club-fk-indexes.mjs), before a single browser test runs.
-- Run 38813876543 (2026-10-16 00:06 UTC), both "Client browser verification"
-- and "Live-table and engine verification":
--
--   A CLUB CANNOT BE DELETED: 1 foreign key(s) into public.clubs would force
--   a sequential scan.
--     club_notice_board.club_id   (club_notice_board_club_id_fkey, size unknown)
--
-- That is the PostDeployVerificationIncomplete episode open since 13:23 UTC
-- on 2026-10-15 (operational_alert_events 254396 and its failed-release
-- receipts).
--
-- Cause, read from production on 2026-10-16 01:27 UTC: migration
-- 20261015223026 (club_messenger_notice_board, installed directly on
-- production; no file for it exists on origin/main, so the pull-request gate
-- scripts/ci/check-added-club-fk-indexes.mjs never read it) created
-- public.club_notice_board with `club_id uuid NOT NULL REFERENCES
-- public.clubs(id)` and only two PARTIAL indexes leading on club_id
-- (club_notice_board_history WHERE NOT is_deleted, club_notice_board_pins
-- WHERE is_pinned AND ...). A partial index cannot answer a foreign key
-- check, because the check must find exactly the rows the predicate hides, so
-- fn_ca_fk_index_gaps('public.clubs') names it and every DELETE FROM clubs
-- would scan the table.
--
-- Fix: one plain, non-partial index leading on club_id, the index the gate
-- itself prescribes. The table held 0 rows at 01:27 UTC, so a plain build
-- inside this short transaction holds its SHARE lock for milliseconds and no
-- CONCURRENTLY pre-build is needed; lock_timeout makes the migration fail
-- instead of queueing behind a writer.
--
-- Pre-image guard: club_notice_board_club_id_fkey exists and is a
-- single-column foreign key from club_notice_board(club_id) to clubs(id).
-- Post-image guard: the index exists, is valid, is not partial, leads on
-- club_id, and fn_ca_fk_index_gaps('public.clubs') lists no gap at all.
-- No row, balance, constraint, privilege or accounting rule is changed.
--
-- Regression: scripts/ci/check-club-fk-indexes.mjs (post-deploy, against
-- production) is the gate that found this and turns green once it installs;
-- scripts/ci/check-added-club-fk-indexes.mjs reads this file and accepts the
-- key as indexed.
--
-- @live-proof: (SELECT count(*) FROM jsonb_array_elements(public.fn_ca_fk_index_gaps('public.clubs')->'gaps')) = 0
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_namespace chn ON chn.oid = ch.relnamespace
    JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.conname = 'club_notice_board_club_id_fkey'
      AND c.contype = 'f'
      AND chn.nspname = 'public'
      AND ch.relname = 'club_notice_board'
      AND c.confrelid = 'public.clubs'::regclass
      AND cardinality(c.conkey) = 1
      AND cardinality(c.confkey) = 1
      AND ca.attname = 'club_id'
      AND pa.attname = 'id'
  ) THEN
    RAISE EXCEPTION
      'NOTICE_BOARD_CLUB_FK_INDEX: pre-image refused, club_notice_board_club_id_fkey is not a single-column foreign key from public.club_notice_board(club_id) to public.clubs(id)';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_club_notice_board_club_id_fk
  ON public.club_notice_board (club_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace icn ON icn.oid = ic.relnamespace
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE icn.nspname = 'public'
      AND ic.relname = 'idx_club_notice_board_club_id_fk'
      AND i.indrelid = 'public.club_notice_board'::regclass
      AND i.indisvalid
      AND i.indpred IS NULL
      AND a.attname = 'club_id'
  ) THEN
    RAISE EXCEPTION
      'NOTICE_BOARD_CLUB_FK_INDEX: post-image refused, idx_club_notice_board_club_id_fk is missing, invalid, partial or does not lead on club_id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.fn_ca_fk_index_gaps('public.clubs')->'gaps') AS gap
  ) THEN
    RAISE EXCEPTION 'NOTICE_BOARD_CLUB_FK_INDEX: fn_ca_fk_index_gaps(''public.clubs'') still lists a gap: %',
      public.fn_ca_fk_index_gaps('public.clubs')->'gaps';
  END IF;
END;
$$;

COMMIT;
