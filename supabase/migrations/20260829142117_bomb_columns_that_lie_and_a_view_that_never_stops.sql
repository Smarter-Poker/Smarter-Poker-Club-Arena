-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829142117; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $blk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'bomb_pots'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.tables WHERE bomb_pots IS TRUE) THEN
      RAISE EXCEPTION
        'refusing to drop tables.bomb_pots: % row(s) are true, so somebody started writing it',
        (SELECT count(*) FROM public.tables WHERE bomb_pots IS TRUE);
    END IF;
    ALTER TABLE public.tables DROP COLUMN bomb_pots;
  END IF;
END $blk$;

DO $blk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'double_board'
  ) THEN
    COMMENT ON COLUMN public.tables.double_board IS
      'RETIRED 2026-08-29. Write-only: no reader has ever existed in either repo, and TableConfigPage stopped writing it in the same change. The engine reads bomb_pot_double_board; the lobby reads the settings blob. Droppable once a release has passed. Do not start writing it again.';
  END IF;
END $blk$;

CREATE OR REPLACE VIEW public.v_bomb_pot_outcomes
WITH (security_invoker = true) AS
SELECT
  day,
  count(*) AS multi_board_hands,
  count(*) FILTER (WHERE distinct_winners = 1) AS full_scoops,
  count(*) FILTER (WHERE distinct_winners > 1) AS split_hands,
  round(avg(award_units), 2) AS avg_award_units
FROM (
  SELECT
    hand_history_id,
    date_trunc('day', min(created_at)) AS day,
    count(DISTINCT user_id) AS distinct_winners,
    count(*) AS award_units
  FROM public.bomb_pot_award_units
  WHERE created_at > now() - interval '90 days'
  GROUP BY hand_history_id
) per_hand
GROUP BY day;

REVOKE ALL ON public.v_bomb_pot_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_bomb_pot_outcomes TO service_role;

DO $chk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'bomb_pots'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pots still exists';
  END IF;

  IF (SELECT pg_get_viewdef('public.v_bomb_pot_outcomes'::regclass))
     NOT LIKE '%90 days%' THEN
    RAISE EXCEPTION 'assertion failed: v_bomb_pot_outcomes is still unbounded';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'v_bomb_pot_outcomes'
      AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'assertion failed: v_bomb_pot_outcomes is readable by anon/authenticated again';
  END IF;
END $chk$;
