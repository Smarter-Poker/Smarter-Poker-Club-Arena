-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260814012245 "phase59_create_training_moves"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 935dfa2a21d85b668658a6cec292f570 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 59 — create training_moves
--
-- Found by scripts/ci/check-phantom-tables.mjs (Phase U4.2) on its first run.
-- The table is WRITTEN by shipped code and has never existed, so every insert
-- has failed with 42P01 — and the call site swallows it:
--
--   src/engines/SessionTracker.js:115
--     const { error: movesError } = await supabase.from('training_moves')...
--     if (movesError) console.warn('Failed to save individual moves', ...)
--     // "Session was saved successfully, just moves failed"
--
-- So the parent training_sessions row saved fine while EVERY individual move
-- was discarded. Silent, permanent data loss on the training product's
-- highest-volume write path.
--
-- TYPES are taken from the call sites and the parent table, not guessed:
--   * training_sessions.id is uuid                  -> session_id uuid FK
--   * createMoveRecords() sets board to a JOINED STRING (explicitly, after a
--     2026-07-19 fix for "t.board.join is not a function")  -> board text
--   * HandStateMachine documents heroCards as string[]      -> hero_cards text[]
--
-- TWO PHANTOMS DELIBERATELY NOT CREATED (both recorded in
-- scripts/ci/supabase-invariants.allowlist.json with reasons):
--
--   xp_logs — FORBIDDEN. The database carries an event trigger,
--     xp_ban_guard, enforcing a zero-XP policy that blocks XP-shaped table,
--     column AND function names (including deliberate disguise patterns).
--     Attempting to create it raises
--     'XP_BAN: table "public.xp_logs" violates zero-XP policy'. This is a
--     product decision encoded in the schema, so the correct resolution is
--     to remove the XP write in src/hooks/useTrainingAccountant.ts — a
--     product call, not something to settle by quietly dropping the guard.
--
--   user_dna_profiles — never built. Its only two call sites are READS with
--     working fallbacks, and no table in the database has its
--     storage_used_bytes column, so it is not a rename. An empty table would
--     change nothing.
-- =====================================================================

DO $$
BEGIN
    IF to_regclass('public.training_sessions') IS NULL THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: parent table training_sessions is missing';
    END IF;
    IF (SELECT data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name='training_sessions' AND column_name='id') <> 'uuid' THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: training_sessions.id is not uuid — FK type would mismatch';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.training_moves (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     uuid NOT NULL REFERENCES public.training_sessions(id) ON DELETE CASCADE,
    hand_number    integer,
    street         text,
    hero_cards     text[],
    board          text,
    action_taken   text,
    gto_action     text,
    ev_loss_bb     numeric,
    classification text,
    score          numeric,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_moves_session_id ON public.training_moves(session_id);

COMMENT ON TABLE public.training_moves IS
  'Per-hand detail for a training session. Written in batch by SessionTracker.saveSession(). Created 2026-08-12 (phase59) after check-phantom-tables found every insert had been failing 42P01 since the code shipped.';

ALTER TABLE public.training_moves ENABLE ROW LEVEL SECURITY;

-- Ownership is inherited from the parent session; there is no user_id column.
DROP POLICY IF EXISTS training_moves_select_own ON public.training_moves;
CREATE POLICY training_moves_select_own ON public.training_moves
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.training_sessions s
                    WHERE s.id = training_moves.session_id
                      AND s.user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS training_moves_insert_own ON public.training_moves;
CREATE POLICY training_moves_insert_own ON public.training_moves
    FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM public.training_sessions s
                         WHERE s.id = training_moves.session_id
                           AND s.user_id = (SELECT auth.uid())));

-- Least privilege: no TRUNCATE/TRIGGER/REFERENCES for client roles — the same
-- class of grant Phase 52 had to strip from every home-games table.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.training_moves FROM anon, authenticated;
REVOKE ALL ON TABLE public.training_moves FROM anon;

DO $$
DECLARE v_bad text := '';
BEGIN
    IF to_regclass('public.training_moves') IS NULL THEN v_bad := v_bad || 'table missing; '; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname='training_moves' AND c.relrowsecurity) THEN
        v_bad := v_bad || 'RLS disabled; ';
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='training_moves') < 2 THEN
        v_bad := v_bad || 'fewer than 2 policies; ';
    END IF;
    IF v_bad <> '' THEN RAISE EXCEPTION 'POST-APPLY FAILED: %', v_bad; END IF;
    RAISE NOTICE 'phase59 OK: training_moves created with RLS.';
END $$;
