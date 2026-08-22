-- ═══════════════════════════════════════════════════════════════════════════
-- V12 HORSE SELF-IMPROVEMENT LOG (Dan 2026-08-22: per-horse "self improvement
-- mapping")
--
-- The nightly HorseSelfTuner studies every horse's OWN play from real
-- hand_history (VPIP / PFR / 3-bet / fold-to-3-bet / WWSF / aggression /
-- net bb), diagnoses leaks against winning-player benchmarks, and writes
-- bounded corrective modifiers into profiles.horse_profile — the jsonb the
-- live engine already reads through resolveHorseStyle. This table is the
-- audit trail: one row per horse per run, with the stats measured, the mods
-- before/after, and the human-readable reasons for every nudge.
--
-- Service-role only: RLS enabled with NO policies.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.horse_self_tune_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  horse_id    text NOT NULL,
  run_date    date NOT NULL,
  hands       integer NOT NULL DEFAULT 0,
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
  mods_before jsonb,
  mods_after  jsonb,
  reasons     text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT horse_self_tune_log_once_per_day UNIQUE (horse_id, run_date)
);

ALTER TABLE public.horse_self_tune_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS horse_self_tune_log_horse_idx
  ON public.horse_self_tune_log (horse_id, run_date DESC);
