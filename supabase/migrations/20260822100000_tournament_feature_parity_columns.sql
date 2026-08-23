-- ===========================================================================
-- TOURNAMENT FEATURE PARITY - COLUMNS (2026-08-22)
--
-- PokerBros-style MTT template parity for public.tournaments. Every ADD COLUMN
-- is IF NOT EXISTS because prod already carries several of these (max_rebuys,
-- max_reentries, mystery_bounty_min/max, is_multi_day, total_days, is_pinned,
-- satellite_target_id were live with no repo migration). Verified against
-- information_schema on 2026-08-22 before writing.
--
-- tables.all_in_or_fold ALREADY EXISTS in prod (010_table_configuration.sql
-- line 86 and confirmed live); the IF NOT EXISTS below is a no-op there and a
-- safety net for a rebuilt schema.
--
-- Also creates tournament_registration_approvals: the allow-list consulted by
-- fn_register_for_tournament when tournaments.authorized_to_register is true.
--
-- Idempotent: re-runnable end to end.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. tournaments: parity columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS short_description        text;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS is_vip_only              boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS ban_chat                 boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS all_in_or_fold           boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS label_as_new             boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS hide_club_name           boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS action_time_seconds      integer NOT NULL DEFAULT 15;
-- Seats per table INSIDE the MTT (tables are broken as the field shrinks).
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS table_size               integer NOT NULL DEFAULT 9;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS accelerated_mtt          boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS addon_break_minutes      integer NOT NULL DEFAULT 1;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS big_blind_ante           boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS authorized_to_register   boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS early_bird_enabled       boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS early_bird_chips         integer NOT NULL DEFAULT 0;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS bubble_protection        boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS final_table_deal_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS restart_every_minutes    integer;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS synchronized_breaks      boolean NOT NULL DEFAULT true;
-- Already live in prod (default 0) - IF NOT EXISTS makes this a formal record.
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS max_rebuys               integer;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS max_reentries            integer;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS satellite_seats          integer;
-- Set by the schedule spawner (migration 20260822100100) on tournaments it creates.
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS schedule_id              uuid;

-- ---------------------------------------------------------------------------
-- 2. tables: all_in_or_fold (exists in prod since 010_table_configuration.sql)
-- ---------------------------------------------------------------------------
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS all_in_or_fold boolean DEFAULT false;

-- ---------------------------------------------------------------------------
-- 3. Registration approvals allow-list
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tournament_registration_approvals (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  approved_by   uuid,
  created_at    timestamptz DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);

ALTER TABLE public.tournament_registration_approvals ENABLE ROW LEVEL SECURITY;

-- A player can see their own approval; club owners/admins can see (and manage
-- via the ALL policy) every approval for their club's tournaments. Mirrors the
-- is_club_admin() pattern used across existing migrations.
DROP POLICY IF EXISTS trapp_select_own ON public.tournament_registration_approvals;
CREATE POLICY trapp_select_own ON public.tournament_registration_approvals
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.tournaments t
       WHERE t.id = tournament_id
         AND public.is_club_admin(t.club_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS trapp_admin_write ON public.tournament_registration_approvals;
CREATE POLICY trapp_admin_write ON public.tournament_registration_approvals
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tournaments t
       WHERE t.id = tournament_id
         AND public.is_club_admin(t.club_id, auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.tournaments t
       WHERE t.id = tournament_id
         AND public.is_club_admin(t.club_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS trapp_service_all ON public.tournament_registration_approvals;
CREATE POLICY trapp_service_all ON public.tournament_registration_approvals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Post-apply assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY[
      'short_description','is_vip_only','ban_chat','all_in_or_fold','label_as_new',
      'hide_club_name','action_time_seconds','table_size','accelerated_mtt',
      'addon_break_minutes','big_blind_ante','authorized_to_register',
      'early_bird_enabled','early_bird_chips','bubble_protection',
      'final_table_deal_enabled','restart_every_minutes','synchronized_breaks',
      'max_rebuys','max_reentries','satellite_seats','schedule_id'
    ]) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tournaments' AND column_name = c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'tournaments parity columns missing after apply: %', v_missing;
  END IF;

  IF to_regclass('public.tournament_registration_approvals') IS NULL THEN
    RAISE EXCEPTION 'tournament_registration_approvals was not created';
  END IF;
END $$;

COMMIT;
