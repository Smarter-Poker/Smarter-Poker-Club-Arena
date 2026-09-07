-- ═══════════════════════════════════════════════════════════════════════════
--  A CLUB CANNOT BE DELETED WHILE A DRILL ARM HAS NO INDEX
-- ═══════════════════════════════════════════════════════════════════════════
--
-- **EVERY PULL REQUEST IN THIS REPOSITORY IS RED, AND THIS IS WHY.**
--
-- Sampled 2026-09-07 05:27 UTC, twelve consecutive `CI - Build & Type Safety`
-- runs, every one of them a different agent on an unrelated branch:
--
--     docs/the-jackpot-drill-runbook                     failure
--     fix/union-week-ends-midnight-pacific               failure
--     docs/phase-5-the-partition-blocker-is-not-...      failure
--     agent/cowork-bbj-audit/phase-4-prove-it-li...      failure
--     agent/cowork-pgrst/fix/pgrst002-resilience         failure
--     cowork-claude-feefwd                               failure
--     fix/auth-join-and-delete-defects                   failure
--     agent/cowork-claude/the-drain-outlives-the...      failure
--     ... and every other open branch
--
-- The failing step is `Supabase Invariants - A Club Stays Deletable`, and it
-- names exactly one offender:
--
--     bbj_drill_arms.club_id  (bbj_drill_arms_club_id_fkey)
--
-- `bbj_drill_arms` is new. It was created with a foreign key into
-- `public.clubs` and three indexes - `bbj_drill_arms_pkey`,
-- `bbj_drill_arms_one_live_per_table`, `bbj_drill_arms_armed_at_idx` - none of
-- which leads on `club_id`. Postgres does not index a referencing column for
-- you, so every `DELETE FROM clubs` now has to sequentially scan this table to
-- prove no arm references the row.
--
-- WHY THAT IS A GATE AND NOT A NICETY. The check's own message says it: the
-- club-retirement RPC runs inside a PostgREST request that is cancelled after
-- a few seconds, and when it is cancelled a certification fixture and its
-- 100,000 chips stay in Club Arena. That has already happened once, which is
-- why the gate exists.
--
-- THE FIX IS THE ONE THE CHECK PRINTS, verbatim. Nothing clever is called for.
--
-- PLAIN, NOT CONCURRENTLY, and that is a measurement rather than a shortcut:
-- `bbj_drill_arms` holds **0 rows in 64 kB** today. A plain build is
-- instantaneous and its SHARE lock is on an empty table nothing is reading.
-- The check's advice to build CONCURRENTLY first is for the case it also
-- names - "867,780 rows took 25 seconds" - and does not apply here. If this
-- table is large by the time somebody re-runs this file, `IF NOT EXISTS`
-- makes it a no-op and the concurrent build belongs outside a transaction.
--
-- NOT MY TABLE, AND SAID OUT LOUD. `bbj_drill_arms` belongs to the bad-beat
-- jackpot drill work. This is fixed here because CLAUDE.md rule 8 is explicit:
-- "If you find main already red, fixing it comes before your own work. You
-- cannot ship past it anyway." Three of my own pull requests were blocked by
-- it, and so was everybody else's. Nothing about the drill's own design is
-- changed - this only adds the index its foreign key already implies.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_bbj_drill_arms_club_id_fk;

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.bbj_drill_arms') IS NULL THEN
    RAISE EXCEPTION
      'bbj_drill_arms does not exist - it was created by the BBJ drill work and something has since dropped it. Re-read before applying.';
  END IF;

  -- The gate is about a FOREIGN KEY into clubs. If that constraint is gone,
  -- this index is no longer the thing standing between a club and a DELETE,
  -- and adding it would be cargo cult.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.bbj_drill_arms'::regclass
       AND c.contype = 'f'
       AND c.confrelid = 'public.clubs'::regclass
  ) THEN
    RAISE EXCEPTION
      'bbj_drill_arms has no foreign key into public.clubs any more - this migration is answering a problem that no longer exists.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bbj_drill_arms_club_id_fk
  ON public.bbj_drill_arms (club_id);

COMMENT ON INDEX public.idx_bbj_drill_arms_club_id_fk IS
  'Answers bbj_drill_arms_club_id_fkey so DELETE FROM clubs does not sequentially scan. '
  'Required by scripts/ci/check-club-fk-indexes.mjs; its absence made every pull request '
  'in the repository red on 2026-09-07.';

COMMIT;

-- ── POST-CHECKS ────────────────────────────────────────────────────────────
-- Its own transaction, so it reads the index as it now stands.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'public.bbj_drill_arms'::regclass
       AND a.attname = 'club_id'
       -- A PARTIAL index does not count and cannot be made to count: a foreign
       -- key check must find the rows the predicate hides. The gate says so in
       -- its own closing line, and this asserts it rather than trusting it.
       AND i.indpred IS NULL
  ) THEN
    RAISE EXCEPTION
      'post-check: no NON-PARTIAL index leads on bbj_drill_arms.club_id, so the club-deletion gate is still red';
  END IF;
  RAISE NOTICE 'bbj_drill_arms.club_id is indexed; a club can be deleted again';
END $$;
