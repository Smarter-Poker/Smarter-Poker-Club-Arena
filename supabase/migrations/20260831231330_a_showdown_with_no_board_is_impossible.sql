-- ═══════════════════════════════════════════════════════════════════════════
-- A SHOWDOWN WITH NO BOARD IS IMPOSSIBLE (2026-08-31)
-- Applied to production 2026-08-31 23:13 UTC via MCP (version 20260831231330);
-- committed here for the record, per the applied-ahead-of-the-client pattern.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The stale-runout corruption (engine fixes #2318/#2342) produced hands whose
-- controller was parked at 'showdown' with a phantom board dealt into the
-- void: the hand PLAYED, reached a "showdown" evaluated against cards no
-- player ever saw, and persisted with hh.showdown populated and
-- community_cards EMPTY. Twenty such hands exist since 08-26 (all horse-only,
-- every one with has_human = false; ~5,054 chips in pots, 80.41 rake).
--
-- The rake-law alarm caught the RAKED ones (board_not_recorded), because its
-- base scan filters rake_amount > 0. That filter is now a blind spot: the
-- engine guards shipped in #2318 REFUSE the rake on a corrupted hand, so if
-- the corruption ever returns past those guards, its hands would pay zero
-- rake and be invisible to this alarm - the only independent, engine-build-
-- proof measure there is. This adds the rakeless case: a hand that recorded a
-- showdown on fewer than three board cards is impossible poker, whatever it
-- paid, and files as 'impossible_showdown'. fn_rake_law_check's severity
-- mapping sends every kind but board_not_recorded to 'critical', so an
-- impossible_showdown pages - if one appears on a hand played after
-- 2026-08-31 19:57 UTC, a guard has been bypassed and that is page-worthy.
--
-- Cheap on purpose: the new branch is three column checks over the window,
-- no jsonb scan. rake = 0 only, so a raked impossible hand keeps filing as
-- board_not_recorded and never double-files.

BEGIN;

SET LOCAL lock_timeout = '4s';

CREATE OR REPLACE FUNCTION public.fn_rake_law_violations(p_window interval DEFAULT '1 hour')
RETURNS TABLE (
  kind          text,
  hand_id       uuid,
  table_id      uuid,
  occurred_at   timestamptz,
  small_blind   numeric,
  big_blind     numeric,
  pot           numeric,
  rake          numeric,
  allowed       numeric
)
LANGUAGE sql
STABLE
AS $function$
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at, hh.rake_amount AS rake,
           hh.pot_size AS pot, t.small_blind AS sb, t.big_blind AS bb,
           COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) AS board_n,
           hh.showdown IS NOT NULL AS has_showdown,
           (SELECT count(*) FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
             WHERE a->>'action' IN ('call','raise','bet','allin','all-in')) AS agg
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.created_at > now() - p_window
       AND t.tournament_id IS NULL
       AND COALESCE(hh.rake_amount, 0) > 0
  ), r AS (
    SELECT h.*, public.fn_effective_rake_cap(h.sb, h.bb) AS cap FROM h
  ), h0 AS (
    -- The RAKELESS impossible hands the rake>0 base scan cannot see.
    SELECT hh.id, hh.table_id, hh.created_at, hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.created_at > now() - p_window
       AND t.tournament_id IS NULL
       AND COALESCE(hh.rake_amount, 0) = 0
       AND hh.showdown IS NOT NULL
       AND COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) < 3
  )
  SELECT 'over_cap', id, table_id, created_at, sb, bb, pot, rake, cap
    FROM r WHERE cap IS NOT NULL AND rake > cap + 0.005
  UNION ALL
  SELECT 'over_percent', id, table_id, created_at, sb, bb, pot, rake,
         round(pot * 0.10, 2)
    FROM r WHERE rake > pot * 0.10 + 0.005
  UNION ALL
  SELECT 'no_flop_no_drop', id, table_id, created_at, sb, bb, pot, rake, 0
    FROM r WHERE board_n < 3 AND NOT has_showdown AND agg <= 3
  UNION ALL
  SELECT 'board_not_recorded', id, table_id, created_at, sb, bb, pot, rake, rake
    FROM r WHERE board_n < 3 AND (has_showdown OR agg > 3)
  UNION ALL
  SELECT 'impossible_showdown', id, table_id, created_at, sb, bb, pot, 0, 0
    FROM h0;
$function$;

REVOKE ALL ON FUNCTION public.fn_rake_law_violations(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_law_violations(interval) TO service_role;

COMMIT;

-- ─── ROLLBACK (paste to revert) ─────────────────────────────────────────────
-- Re-apply the previous definition: identical to the above with the h0 CTE
-- and the final 'impossible_showdown' UNION branch removed.
