-- Minimal pre-migration schema, read-only catalog checked 2026-09-30.
-- No foreign keys, live data or external service connections.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.horse_mind_stats (
  user_id text NOT NULL,
  hands integer NOT NULL DEFAULT 0,
  vpip integer NOT NULL DEFAULT 0,
  pfr integer NOT NULL DEFAULT 0,
  three_bet integer NOT NULL DEFAULT 0,
  aggr integer NOT NULL DEFAULT 0,
  passive integer NOT NULL DEFAULT 0,
  folds integer NOT NULL DEFAULT 0,
  faced_aggr integer NOT NULL DEFAULT 0,
  cbet_opps integer NOT NULL DEFAULT 0,
  cbet_folds integer NOT NULL DEFAULT 0,
  f3b_opps integer NOT NULL DEFAULT 0,
  f3b_folds integer NOT NULL DEFAULT 0,
  bigbet_sd integer NOT NULL DEFAULT 0,
  bigbet_sd_strong integer NOT NULL DEFAULT 0,
  post_aggr integer NOT NULL DEFAULT 0,
  post_passive integer NOT NULL DEFAULT 0,
  river_bet_opps integer NOT NULL DEFAULT 0,
  river_bet_folds integer NOT NULL DEFAULT 0,
  checks integer NOT NULL DEFAULT 0,
  snap_bet_sd integer NOT NULL DEFAULT 0,
  snap_bet_sd_strong integer NOT NULL DEFAULT 0,
  tank_bet_sd integer NOT NULL DEFAULT 0,
  tank_bet_sd_strong integer NOT NULL DEFAULT 0,
  r_hands real NOT NULL DEFAULT 0,
  r_folds real NOT NULL DEFAULT 0,
  r_faced_aggr real NOT NULL DEFAULT 0,
  r_aggr real NOT NULL DEFAULT 0,
  r_passive real NOT NULL DEFAULT 0,
  r_checks real NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);
ALTER TABLE public.horse_mind_stats ENABLE ROW LEVEL SECURITY;
GRANT SELECT, REFERENCES, TRIGGER ON public.horse_mind_stats TO anon, authenticated;
GRANT ALL ON public.horse_mind_stats TO service_role;

CREATE TABLE public.horse_mind_stats_scoped (
  user_id text NOT NULL,
  scope text NOT NULL CHECK (scope ~ '^(holdem|omaha|sixplus):(hu|short|full)$'),
  hands integer NOT NULL DEFAULT 0,
  vpip integer NOT NULL DEFAULT 0,
  pfr integer NOT NULL DEFAULT 0,
  three_bet integer NOT NULL DEFAULT 0,
  aggr integer NOT NULL DEFAULT 0,
  passive integer NOT NULL DEFAULT 0,
  folds integer NOT NULL DEFAULT 0,
  faced_aggr integer NOT NULL DEFAULT 0,
  cbet_opps integer NOT NULL DEFAULT 0,
  cbet_folds integer NOT NULL DEFAULT 0,
  f3b_opps integer NOT NULL DEFAULT 0,
  f3b_folds integer NOT NULL DEFAULT 0,
  bigbet_sd integer NOT NULL DEFAULT 0,
  bigbet_sd_strong integer NOT NULL DEFAULT 0,
  post_aggr integer NOT NULL DEFAULT 0,
  post_passive integer NOT NULL DEFAULT 0,
  river_bet_opps integer NOT NULL DEFAULT 0,
  river_bet_folds integer NOT NULL DEFAULT 0,
  checks integer NOT NULL DEFAULT 0,
  snap_bet_sd integer NOT NULL DEFAULT 0,
  snap_bet_sd_strong integer NOT NULL DEFAULT 0,
  tank_bet_sd integer NOT NULL DEFAULT 0,
  tank_bet_sd_strong integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,scope)
);
ALTER TABLE public.horse_mind_stats_scoped ENABLE ROW LEVEL SECURITY;
GRANT SELECT, REFERENCES, TRIGGER ON public.horse_mind_stats_scoped TO anon, authenticated;
GRANT ALL ON public.horse_mind_stats_scoped TO service_role;
