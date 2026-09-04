-- OPERATION STABLE HAND - Section 7 tag storage.
-- Applied to production 2026-09-04 via Supabase MCP apply_migration as
-- `stable_hand_tag_and_state_tables`. This file is the auditable copy.
--
-- Two dedicated tables rather than ~20 new columns on club_members and
-- profiles. club_members is the live chip wallet: every DDL statement against
-- it fires pgrst_ddl_watch and costs a ~28s PostgREST schema reload (CLAUDE.md
-- "Production DDL policy", the 2026-08-31 PGRST002 outage). Tagging is fleet
-- metadata, not money, so it gets its own home and the wallet table is never
-- reshaped for it. One transaction, one reload.
--
-- No money moves here. Section 8.1 seeding is retired per Dan 2026-09-04
-- ("ignore the 10,000 seed, use current balances"), so there is deliberately
-- no balance column below - only a session_start_balance SNAPSHOT, which is
-- read from the wallet and never written back to it.
BEGIN;

CREATE TABLE IF NOT EXISTS public.stable_hand_membership_tags (
  horse_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  club_id           uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  mode              text NOT NULL CHECK (mode IN ('cash','tourney','both')),
  cash_freeroll     boolean NOT NULL DEFAULT false,
  persona_cash      text CHECK (persona_cash IN ('grinder','regular','mixer','night_owl','weekend_heavy')),
  persona_mtt       text CHECK (persona_mtt IN ('mtt_grinder','mtt_regular','mtt_late_reg')),
  variants          text[] NOT NULL DEFAULT '{}',
  preferred_stakes  numeric[] NOT NULL DEFAULT '{}',
  max_tables        smallint NOT NULL DEFAULT 1 CHECK (max_tables BETWEEN 0 AND 4),
  tagged_at         timestamptz NOT NULL DEFAULT now(),
  tag_seed          text NOT NULL,
  PRIMARY KEY (horse_id, club_id),
  CONSTRAINT sh_freeroll_is_cash_only CHECK (NOT cash_freeroll OR mode = 'cash'),
  CONSTRAINT sh_tourney_only_one_table CHECK (mode <> 'tourney' OR max_tables = 1),
  CONSTRAINT sh_cash_persona_presence CHECK (
    (mode = 'tourney' AND persona_cash IS NULL) OR
    (mode <> 'tourney' AND persona_cash IS NOT NULL)
  )
);

COMMENT ON TABLE public.stable_hand_membership_tags IS
  'Operation Stable Hand Section 7: per (horse, club) tags. One row per WALLET, so a body with both a JAQK and a Shark wallet has two rows and one identity in stable_hand_horse_state.';

CREATE INDEX IF NOT EXISTS sh_tags_club_mode_idx
  ON public.stable_hand_membership_tags (club_id, mode);
CREATE INDEX IF NOT EXISTS sh_tags_club_freeroll_idx
  ON public.stable_hand_membership_tags (club_id) WHERE cash_freeroll;

CREATE TABLE IF NOT EXISTS public.stable_hand_horse_state (
  horse_id              uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  rest_weekday          smallint NOT NULL CHECK (rest_weekday BETWEEN 0 AND 6),
  daily_cap_minutes     integer NOT NULL CHECK (daily_cap_minutes BETWEEN 0 AND 1440),
  active_club_id        uuid REFERENCES public.clubs(id),
  active_host_id        uuid REFERENCES public.clubs(id),
  active_seat_count     smallint NOT NULL DEFAULT 0 CHECK (active_seat_count BETWEEN 0 AND 4),
  active_table_ids      uuid[] NOT NULL DEFAULT '{}',
  minutes_played_today  integer NOT NULL DEFAULT 0,
  session_plan          jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_start_balance numeric,
  cash_sits_today       jsonb NOT NULL DEFAULT '{}'::jsonb,
  two_hour_window       jsonb NOT NULL DEFAULT '{}'::jsonb,
  mtt_bullets_by_event  jsonb NOT NULL DEFAULT '{}'::jsonb,
  mtt_addon_taken       jsonb NOT NULL DEFAULT '{}'::jsonb,
  counters_reset_on     date,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sh_seat_count_matches_ids
    CHECK (active_seat_count = cardinality(active_table_ids)),
  CONSTRAINT sh_idle_is_fully_idle CHECK (
    (active_seat_count > 0 AND active_club_id IS NOT NULL AND active_host_id IS NOT NULL)
    OR (active_seat_count = 0 AND active_club_id IS NULL AND active_host_id IS NULL)
  )
);

COMMENT ON TABLE public.stable_hand_horse_state IS
  'Operation Stable Hand Section 11: per BODY state. Occupancy is capped per HOST, not per club - JAQK is a strict subset of Shark (580 of 580 measured 2026-09-04), so per-club caps would count one body twice and deliver 80% peak where 40% was asked for.';

CREATE INDEX IF NOT EXISTS sh_state_active_host_idx
  ON public.stable_hand_horse_state (active_host_id) WHERE active_seat_count > 0;
CREATE INDEX IF NOT EXISTS sh_state_rest_weekday_idx
  ON public.stable_hand_horse_state (rest_weekday);

ALTER TABLE public.stable_hand_membership_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stable_hand_horse_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stable_hand_membership_tags FROM anon, authenticated;
REVOKE ALL ON public.stable_hand_horse_state FROM anon, authenticated;
GRANT ALL ON public.stable_hand_membership_tags TO service_role;
GRANT ALL ON public.stable_hand_horse_state TO service_role;

COMMIT;

DO $$
BEGIN
  IF to_regclass('public.stable_hand_membership_tags') IS NULL THEN
    RAISE EXCEPTION 'stable_hand_membership_tags was not created';
  END IF;
  IF to_regclass('public.stable_hand_horse_state') IS NULL THEN
    RAISE EXCEPTION 'stable_hand_horse_state was not created';
  END IF;
END $$;
