-- ═══════════════════════════════════════════════════════════════════════════
-- THE BOMB-POT ANALYTICS WERE READABLE BY ANYBODY, AND USELESS TO THE
-- CLUB OWNER THEY WERE BUILT FOR (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two separate problems in one place, found by auditing spec section 22.3's
-- analytics surface line by line.
--
-- ── 1. THEY ARE OPEN ────────────────────────────────────────────────────────
--
-- The three views shipped with no `security_invoker`, so they run as their
-- owner (`postgres`) and BYPASS the row-level security on their base tables.
-- Supabase then grants SELECT on a new view to `anon` and `authenticated` by
-- default, and nothing revoked it. Verified against the live catalog:
--
--   v_bomb_pot_daily      anon:SELECT  authenticated:SELECT  reloptions: NULL
--   v_bomb_pot_vs_normal  anon:SELECT  authenticated:SELECT  reloptions: NULL
--   v_bomb_pot_outcomes   anon:SELECT  authenticated:SELECT  reloptions: NULL
--
-- `v_bomb_pot_vs_normal` is the sharp one: its FROM is `public.hand_history`
-- with no bomb filter at all, seven days wide. An UNAUTHENTICATED caller could
-- read aggregate hand data for the entire platform out of a definer view.
--
-- This repo has been bitten by this exact default twice already and wrote both
-- down: `20260828085231_a_new_view_must_not_inherit_write_grants.sql`, and
-- `20260828_clone_never_inherits_bomb_scheduler_state.sql` lines 99-107, which
-- records that `REVOKE ALL ... FROM public` does NOT remove Supabase's own
-- explicit `anon` grant — the roles must be named.
--
-- `bomb_pot_award_units` had a narrower version of the same fault. Its read
-- policy is `FOR SELECT TO authenticated USING (true)`, justified as "the same
-- public information the table broadcast at showdown". A showdown is public to
-- the PLAYERS AT THAT TABLE. It is not public to every account on the
-- platform, and this table carries user_id, amount and hand_name for tables in
-- private clubs, VIP-only clubs and anonymous games. Any signed-in user could
-- reconstruct who won how much in a club they have never belonged to.
--
-- ── 2. THEY CANNOT ANSWER A CLUB OWNER'S QUESTION ───────────────────────────
--
-- None of the three carries `club_id` or `table_id`. `v_bomb_pot_daily` groups
-- by day/trigger/boards/variant across the WHOLE PLATFORM; `v_bomb_pot_outcomes`
-- groups by day alone and has no time filter, so it scans the entire ledger
-- forever and will only get slower. They are platform-operator views wearing a
-- club-analytics label, and no UI reads any of them.
--
-- So the fix is not only to close them. `fn_club_bomb_pot_report` below is the
-- report a club owner actually needs — scoped to one club they are authorized
-- for, broken down per table and per trigger mode, and carrying the three
-- numbers the views omit entirely: how many players a bomb pot pulls in, how
-- much forced money it moves, and how often somebody scoops.
--
-- Tier 3 (view redefinition + policy replacement + grant changes). ROLLBACK at
-- the foot of the file.

-- ── 1a. The views run as the CALLER and are not readable by anon ────────────
ALTER VIEW public.v_bomb_pot_daily SET (security_invoker = true);
ALTER VIEW public.v_bomb_pot_vs_normal SET (security_invoker = true);
ALTER VIEW public.v_bomb_pot_outcomes SET (security_invoker = true);

REVOKE ALL ON public.v_bomb_pot_daily FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_bomb_pot_vs_normal FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_bomb_pot_outcomes FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.v_bomb_pot_daily TO service_role;
GRANT SELECT ON public.v_bomb_pot_vs_normal TO service_role;
GRANT SELECT ON public.v_bomb_pot_outcomes TO service_role;

-- ── 1b. Award units are visible to the club they happened in ───────────────
-- Nothing in the client or the World Hub reads this table directly (verified
-- by grep across both repos), so narrowing it breaks no surface today and
-- stops the leak before something starts reading it tomorrow.
DROP POLICY IF EXISTS bomb_pot_award_units_read ON public.bomb_pot_award_units;
CREATE POLICY bomb_pot_award_units_read ON public.bomb_pot_award_units
  FOR SELECT TO authenticated
  USING (
    -- You won it, or you are a member of the club whose table dealt it.
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.tables t
      JOIN public.club_members cm ON cm.club_id = t.club_id
      WHERE t.id = bomb_pot_award_units.table_id
        AND cm.user_id = auth.uid()
    )
  );

-- Writes belong to the engine (service_role bypasses RLS). RLS was already
-- refusing these for want of a policy; removing the grants means the refusal
-- does not depend on a policy continuing not to exist.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bomb_pot_award_units
  FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON public.bomb_pot_award_units FROM anon;
REVOKE ALL ON public.bomb_pot_manual_requests FROM PUBLIC, anon, authenticated;

-- ── 2. The report a club owner can actually use ────────────────────────────
--
-- One row per (table, trigger mode, board count). SECURITY DEFINER because it
-- must join hand_history, which the caller cannot read directly — and it
-- re-checks authorization itself, the same owner / co_owner / admin test
-- fn_request_manual_bomb_pot uses, before it returns a single row.
CREATE OR REPLACE FUNCTION public.fn_club_bomb_pot_report(
  p_club_id uuid,
  p_days integer DEFAULT 30
)
RETURNS TABLE (
  table_id            uuid,
  table_name          text,
  trigger_reason      text,
  board_count         integer,
  variant             text,
  hands               bigint,
  avg_players         numeric,
  avg_pot             numeric,
  total_pot           numeric,
  total_rake          numeric,
  total_antes         numeric,
  scoops              bigint,
  splits              bigint,
  unrecorded_hands    bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_authorized boolean := false;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = v_uid)
    OR EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
        AND lower(cm.role) IN ('owner', 'co_owner', 'admin')
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bomb_hands AS (
    SELECT
      h.id,
      h.table_id,
      t.name AS table_name,
      h.bomb_pot ->> 'trigger_reason'          AS trigger_reason,
      (h.bomb_pot ->> 'board_count')::int      AS board_count,
      h.bomb_pot ->> 'variant'                 AS variant,
      COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0) AS ante_amount,
      COALESCE(h.pot_size, 0)                  AS pot_size,
      COALESCE(h.rake_amount, 0)               AS rake_amount,
      -- Seats dealt in. `players` is the per-hand roster the engine persists;
      -- horses are in it and are counted, because a horse pays the same ante
      -- out of the same treasury and sits in the same seat (CLAUDE.md 10.5).
      COALESCE(jsonb_array_length(h.players), 0) AS seats
    FROM public.hand_history h
    JOIN public.tables t ON t.id = h.table_id
    WHERE t.club_id = p_club_id
      AND h.bomb_pot IS NOT NULL
      AND h.created_at > now() - make_interval(days => v_days)
  ),
  per_hand_units AS (
    SELECT a.hand_history_id,
           count(DISTINCT a.user_id) AS distinct_winners,
           count(*)                  AS units
    FROM public.bomb_pot_award_units a
    JOIN bomb_hands b ON b.id = a.hand_history_id
    GROUP BY a.hand_history_id
  )
  SELECT
    b.table_id,
    b.table_name,
    b.trigger_reason,
    b.board_count,
    b.variant,
    count(*)::bigint                                        AS hands,
    round(avg(b.seats), 2)                                  AS avg_players,
    round(avg(b.pot_size), 2)                               AS avg_pot,
    round(sum(b.pot_size), 2)                               AS total_pot,
    round(sum(b.rake_amount), 2)                            AS total_rake,
    -- What the forced ante actually moved: everyone dealt in pays it.
    round(sum(b.ante_amount * b.seats), 2)                  AS total_antes,
    count(*) FILTER (WHERE u.distinct_winners = 1)::bigint   AS scoops,
    count(*) FILTER (WHERE u.distinct_winners > 1)::bigint   AS splits,
    -- Hands with no award-unit rows. Non-zero means the ledger has a hole,
    -- which fn_bomb_pot_ledger_gaps names hand by hand.
    count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint AS unrecorded_hands
  FROM bomb_hands b
  LEFT JOIN per_hand_units u ON u.hand_history_id = b.id
  GROUP BY b.table_id, b.table_name, b.trigger_reason, b.board_count, b.variant
  ORDER BY hands DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) IS
  'Bomb-pot performance for ONE club the caller owns or administers: per table, '
  'per trigger mode, per board count. Carries the three numbers the v_bomb_pot_* '
  'views omit — players per bomb, forced money moved, and scoop rate.';

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
DECLARE
  v_open int;
BEGIN
  SELECT count(*) INTO v_open
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('v_bomb_pot_daily', 'v_bomb_pot_vs_normal', 'v_bomb_pot_outcomes',
                       'bomb_pot_manual_requests')
    AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_open > 0 THEN
    RAISE EXCEPTION 'assertion failed: % anon/authenticated grant(s) still on the bomb analytics', v_open;
  END IF;

  SELECT count(*) INTO v_open
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'bomb_pot_award_units'
    AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF v_open > 0 THEN
    RAISE EXCEPTION 'assertion failed: % write grant(s) still on bomb_pot_award_units', v_open;
  END IF;

  FOR v_open IN
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('v_bomb_pot_daily', 'v_bomb_pot_vs_normal', 'v_bomb_pot_outcomes')
      AND NOT COALESCE(array_to_string(c.reloptions, ',') LIKE '%security_invoker=true%', false)
  LOOP
    RAISE EXCEPTION 'assertion failed: a v_bomb_pot_* view is still SECURITY DEFINER';
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_club_bomb_pot_report'
  ) THEN
    RAISE EXCEPTION 'assertion failed: fn_club_bomb_pot_report missing';
  END IF;
END $$;

-- ROLLBACK:
--   ALTER VIEW public.v_bomb_pot_daily      RESET (security_invoker);
--   ALTER VIEW public.v_bomb_pot_vs_normal  RESET (security_invoker);
--   ALTER VIEW public.v_bomb_pot_outcomes   RESET (security_invoker);
--   GRANT SELECT ON public.v_bomb_pot_daily, public.v_bomb_pot_vs_normal,
--                   public.v_bomb_pot_outcomes TO anon, authenticated;
--   DROP POLICY bomb_pot_award_units_read ON public.bomb_pot_award_units;
--   CREATE POLICY bomb_pot_award_units_read ON public.bomb_pot_award_units
--     FOR SELECT TO authenticated USING (true);
--   DROP FUNCTION IF EXISTS public.fn_club_bomb_pot_report(uuid, integer);
--   (Restoring the anon grants re-opens the leak this migration closed. Do not
--    run the rollback to "fix" a caller — grant that caller service_role or
--    give it fn_club_bomb_pot_report instead.)
