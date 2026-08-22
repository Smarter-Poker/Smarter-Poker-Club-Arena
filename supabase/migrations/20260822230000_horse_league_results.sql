-- ═══════════════════════════════════════════════════════════════════════════
-- V12 HORSE LEAGUE RESULTS (Dan 2026-08-22)
--
-- Nightly duplicate-deal self-play: every strategy layer of the horse brain
-- plays thousands of identical-card hands against the engine without it, and
-- the chip difference (bb/100, with a standard error) lands here. This is
-- the permanent instrument that turns "the horses feel better" into a
-- measured number, and catches a regressed layer as a sign flip within days.
--
-- Service-role only: RLS enabled with NO policies.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.horse_league_results (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_date        date NOT NULL,
  matchup         text NOT NULL,
  hands           integer NOT NULL DEFAULT 0,
  bb100           numeric NOT NULL DEFAULT 0,
  stderr          numeric NOT NULL DEFAULT 0,
  config_a        jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_b        jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms     integer NOT NULL DEFAULT 0,
  illegal_actions integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT horse_league_results_once UNIQUE (run_date, matchup)
);

ALTER TABLE public.horse_league_results ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS horse_league_results_matchup_idx
  ON public.horse_league_results (matchup, run_date DESC);
