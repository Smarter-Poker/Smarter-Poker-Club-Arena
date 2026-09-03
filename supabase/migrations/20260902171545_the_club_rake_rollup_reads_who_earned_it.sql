-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902171545; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- The second half of the same bug fixed by
-- rake_is_earned_by_the_players_club_not_the_table_owner.
--
-- fn_club_rake_rollup_day builds the per-club, per-player daily rake basis -
-- the figure the weekly 90% payback is 90% OF. It selected
--
--     FROM rake_records r ... WHERE r.club_id = p_club_id
--
-- and rake_records.club_id is the HOST club, which for every Midway table is
-- the Midway Union club row. So a rollup run for Club JAQK or Shark Club
-- matched no rows at all and wrote a per-club basis of zero, no matter how
-- much their members actually played. Correcting the attribution stamp alone
-- would not have surfaced here, because this function never read the
-- attribution table.
--
-- It now reads rake_attributions, which as of the companion migration carries
-- the club of the SEAT the player occupied. That table already stores the
-- per-player credit (rake_amount, allocated by fn_allocate_rake_credits at
-- settlement), so the CROSS JOIN LATERAL that re-derived each player's share
-- from player_contributions is gone: the split is no longer recomputed from
-- the pot, it is read from the row that recorded it. One source of truth for
-- "what did this player generate", instead of two that can disagree.
--
-- BEHAVIOUR DELIBERATELY PRESERVED:
--   - Still cents-rounded per row then summed, so totals match the old
--     arithmetic exactly rather than drifting by fractions of a chip.
--   - Still no is_tournament filter. The old query had none, and adding one
--     here would silently change what the rollup counts.
--   - The completed-day guard, the advisory lock, the DELETE-then-insert
--     idempotency and the club_rake_rollup_complete bookkeeping are all
--     untouched.
--
-- HISTORICAL DAYS: attribution rows written before 2026-09-02 17:13 UTC carry
-- the old host-club stamp, so re-running this for an earlier day still yields
-- zero for the member clubs. That is not fixed here on purpose - whether the
-- unsettled weeks of 08-17, 08-24 and 08-31 are back-attributed, settled as
-- they stand, or written off is a real-money decision that belongs to Dan and
-- is recorded as decision 2 in the build-out plan.
--
-- PATCHED, NOT RETYPED, and dry-run inside a rolled-back transaction first to
-- prove it compiles.
--
-- ROLLBACK (paste and run):
--
--   DO $rb$
--   DECLARE v_def text; v_new text;
--   BEGIN
--     SELECT pg_get_functiondef(p.oid) INTO v_def
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public' AND p.proname = 'fn_club_rake_rollup_day';
--     v_new := regexp_replace(v_def, 'WITH split AS \(.*?\), ins AS \(',
--       'WITH split AS (' || chr(10) ||
--       '    SELECT s.user_id, round(s.credit * 100)::bigint AS cents' || chr(10) ||
--       '      FROM rake_records r' || chr(10) ||
--       '      CROSS JOIN LATERAL public.fn_rake_shares_for_record(' || chr(10) ||
--       '        r.hand_id, r.rake_amount, r.player_contributions, COALESCE(r.rake_method, ''DEALT_EQUAL'')' || chr(10) ||
--       '      ) s' || chr(10) ||
--       '     WHERE r.club_id = p_club_id' || chr(10) ||
--       '       AND r.created_at >= v_start AND r.created_at < v_end' || chr(10) ||
--       '       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL' || chr(10) ||
--       '  ), ins AS (', 'ns');
--     IF v_new = v_def THEN RAISE EXCEPTION 'rollback anchor not found'; END IF;
--     EXECUTE v_new;
--   END $rb$;
--
DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_ok  int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_rake_rollup_day';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_club_rake_rollup_day not found - refusing to guess';
  END IF;

  IF v_def NOT LIKE '%FROM rake_records r%' THEN
    RAISE EXCEPTION 'source is not the expected rake_records form - refusing to patch';
  END IF;

  v_new := regexp_replace(v_def,
    'WITH split AS \(.*?\), ins AS \(',
    'WITH split AS (' || chr(10) ||
    '    SELECT a.player_id AS user_id, round(a.rake_amount * 100)::bigint AS cents' || chr(10) ||
    '      FROM rake_attributions a' || chr(10) ||
    '     WHERE a.club_id = p_club_id' || chr(10) ||
    '       AND a.created_at >= v_start AND a.created_at < v_end' || chr(10) ||
    '       AND a.rake_amount > 0' || chr(10) ||
    '  ), ins AS (',
    'ns');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'replacement was a no-op - refusing to claim success';
  END IF;

  EXECUTE v_new;

  SELECT count(*) INTO v_ok
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_rake_rollup_day'
     AND p.prosrc LIKE '%FROM rake_attributions a%'
     AND p.prosrc NOT LIKE '%FROM rake_records r%';
  IF v_ok <> 1 THEN
    RAISE EXCEPTION 'post-apply check failed: rollup still reads rake_records';
  END IF;

  RAISE NOTICE 'fn_club_rake_rollup_day now reads rake_attributions';
END $mig$;
