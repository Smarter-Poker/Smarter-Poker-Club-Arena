-- 20261026133101_the_hand_history_prune_resumes_where_it_left_off.sql
-- @live-proof: (SELECT position('hand_history_prune_cursor' IN pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) > 0 AND to_regclass('smarter_private.hand_history_prune_cursor') IS NOT NULL)
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-10-26, lease follow-ups phase 4: back-office
-- work during play):
--
-- sp_prune_hand_history runs every 30 seconds (cron job sp_prune_hand_history_10m)
-- with a 20 second work budget and a 30 second statement timeout. Measured on
-- production over the 24 hours to 2026-10-26 13:00 UTC: 2,693 runs, median
-- 30.1 s, running 90.4% of the day; pg_stat_statements since 2026-10-04 puts it
-- at 221 hours of database time, 7.0% of everything the database did, the
-- fourth largest consumer behind only the engine's own hand RPCs. The table is
-- 10.4 million rows (52 GB with indexes) at 1.1 to 1.5 million hands a day,
-- and the pass was six hours behind its eight-day boundary.
--
-- THE CAUSE, read from the plan of its own candidate query (EXPLAIN ANALYZE,
-- 2026-10-26 13:27 UTC): "Index Scan Backward using idx_hand_history_created
-- ... Rows Removed by Filter: 219000 ... Execution Time: 7218.996 ms" to find
-- 250 rows. The candidate set is ORDER BY created_at LIMIT 250, so every round
-- starts at the OLDEST row and walks forward, and about 219,000 rows older than
-- the boundary are retained on purpose and will be for a long time: ~210,000
-- Diamond Arena cash hands from 2026-10-04 onwards that have no
-- cash_hand_provenance_receipts row (horse_cash_retention_accounting_ready
-- keeps a cash hand with no receipt as original evidence), and tournament hands
-- whose event is not yet settled. Every round re-evaluates every one of them
-- before reaching the first prunable row: 7 seconds of the ~10 a round takes,
-- 120 rounds an hour, for rows whose answer cannot change between rounds.
--
-- THE FIX, at that line: the scan resumes where the previous round left off.
-- A one-row cursor (smarter_private.hand_history_prune_cursor) remembers the
-- newest created_at the pass has examined; the candidate query starts after
-- it, so a retained row is evaluated once per pass instead of once per round.
-- When a round finds nothing between the cursor and the retention boundary,
-- the cursor moves to the boundary. A pass lasts at most 60 minutes; the next
-- run after that starts again from the oldest row, so a hand whose guard has
-- since released (its tournament settled, its accounting accepted) is pruned
-- within the hour. Nothing about WHICH hands prune changes: every guard, the
-- eight-day window read from hand_history_retention_policy.horse_retention_days
-- (CLAUDE.md 10.5, the owner's config row), the batch cap, FOR UPDATE SKIP
-- LOCKED, the four disposals and the two DELETEs are byte for byte the
-- installed ones. The cursor is written in the same transaction as the
-- deletes; a cancelled run rolls both back together, exactly as before.
--
-- Not changed here, recorded for the owner: the ~210,000 (and ~30,000 more a
-- day) Diamond Arena hands are never prunable under the current cash-receipt
-- rule. That is a retention decision, not a performance one.
--
-- Installed the way the three previous pruner changes were (20261013151435,
-- 20261014231901, 20261012180419 pins): the live definition is read, its md5
-- pinned, each anchor proved unique, the additions spliced in, and the result
-- checked before COMMIT. No money table is written; no job is added or moved.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

CREATE TABLE smarter_private.hand_history_prune_cursor(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 -- Newest hand_history.created_at the current pass has examined; NULL starts
 -- a pass from the oldest row.
 resume_after timestamptz,
 pass_started_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE smarter_private.hand_history_prune_cursor IS
 'sp_prune_hand_history resumes its candidate scan after resume_after within one pass (at most 60 minutes), so rows retained by a guard are evaluated once per pass instead of once per 30-second round. Migration 20261026133101.';
ALTER TABLE smarter_private.hand_history_prune_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_history_prune_cursor FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO smarter_private.hand_history_prune_cursor(singleton) VALUES(true);

DO $install$
DECLARE
 src text;
 a_declare constant text := E'  v_round integer;\n';
 a_window constant text := E'  v_window := make_interval(days=>v_days);\n';
 a_select constant text := E'      SELECT hh.id,hh.players,\n';
 a_boundary constant text := E'         AND hh.created_at<now()-v_window\n';
 a_classified constant text := E'      SELECT c.id,\n';
 a_into constant text := E'           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false)\n      INTO v_doomed,v_keepers FROM classified;\n';
 a_exit constant text := E'    EXIT WHEN v_doomed IS NULL AND v_keepers IS NULL;\n';
 a_return constant text := E'  RETURN v_deleted;\n';
 anchors constant text[] := ARRAY[a_declare,a_window,a_select,a_boundary,a_classified,a_into,a_exit,a_return];
 a text;
BEGIN
 IF md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))
    IS DISTINCT FROM '3f42f51cbc26e7af58fe54ed1fa11a44' THEN
  RAISE EXCEPTION 'PRUNER_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8 THEN
  RAISE EXCEPTION 'PRUNER_RETENTION_POLICY_CHANGED' USING ERRCODE='55000';
 END IF;
 src:=pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
 FOREACH a IN ARRAY anchors LOOP
  IF (length(src)-length(replace(src,a,'')))/length(a) IS DISTINCT FROM 1 THEN
   RAISE EXCEPTION 'PRUNER_ANCHOR_NOT_UNIQUE: %',a USING ERRCODE='55000';
  END IF;
 END LOOP;

 -- 1. The cursor variables and the pass length.
 src:=replace(src,a_declare,a_declare ||
  E'  -- THE SCAN RESUMES WHERE IT LEFT OFF (2026-10-26, migration 20261026133101).\n' ||
  E'  -- v_resume_after is the newest created_at this pass has examined; the\n' ||
  E'  -- candidate scan starts after it, so a row a guard retains is evaluated\n' ||
  E'  -- once per pass rather than once per round. Measured before: 219,000\n' ||
  E'  -- retained rows re-read every round, 7.2 s of each round, 90% of the day.\n' ||
  E'  v_pass_length constant interval := interval ''60 minutes'';\n' ||
  E'  v_resume_after timestamptz;\n' ||
  E'  v_pass_started timestamptz;\n' ||
  E'  v_reached timestamptz;\n');

 -- 2. Load the cursor; a pass older than v_pass_length starts over from the
 --    oldest row so a hand whose guard has released is pruned within the hour.
 src:=replace(src,a_window,a_window ||
  E'  INSERT INTO smarter_private.hand_history_prune_cursor(singleton) VALUES(true) ON CONFLICT DO NOTHING;\n' ||
  E'  SELECT c.resume_after,c.pass_started_at INTO v_resume_after,v_pass_started\n' ||
  E'    FROM smarter_private.hand_history_prune_cursor c WHERE c.singleton FOR UPDATE;\n' ||
  E'  IF v_pass_started IS NULL OR v_pass_started<clock_timestamp()-v_pass_length THEN\n' ||
  E'    v_resume_after := NULL;\n' ||
  E'    v_pass_started := clock_timestamp();\n' ||
  E'  END IF;\n');

 -- 3. Carry created_at through the candidate set so the round knows how far
 --    it reached.
 src:=replace(src,a_select,E'      SELECT hh.id,hh.players,hh.created_at,\n');
 src:=replace(src,a_classified,E'      SELECT c.id,c.created_at,\n');
 src:=replace(src,a_into,
  E'           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false),\n' ||
  E'           max(created_at)\n' ||
  E'      INTO v_doomed,v_keepers,v_reached FROM classified;\n');

 -- 4. The scan starts after the cursor. Both bounds sit on idx_hand_history_created.
 src:=replace(src,a_boundary,a_boundary ||
  E'         -- Resume after the newest row this pass has already examined\n' ||
  E'         -- (migration 20261026133101). NULL is a fresh pass from the oldest row.\n' ||
  E'         AND hh.created_at>COALESCE(v_resume_after,''-infinity''::timestamptz)\n');

 -- 5. Advance the cursor. An empty round means nothing between the cursor and
 --    the retention boundary is prunable now: the next run resumes at the
 --    boundary, and the next pass revisits everything behind it.
 src:=replace(src,a_exit,
  E'    IF v_doomed IS NULL AND v_keepers IS NULL THEN\n' ||
  E'      v_resume_after := now()-v_window;\n' ||
  E'      EXIT;\n' ||
  E'    END IF;\n' ||
  E'    v_resume_after := GREATEST(COALESCE(v_resume_after,''-infinity''::timestamptz),v_reached);\n');

 -- 6. Persist the cursor in the same transaction as the deletes.
 src:=replace(src,a_return,
  E'  UPDATE smarter_private.hand_history_prune_cursor\n' ||
  E'     SET resume_after=v_resume_after,pass_started_at=v_pass_started,updated_at=clock_timestamp()\n' ||
  E'   WHERE singleton;\n' ||
  a_return);

 EXECUTE src;

 src:=pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
 IF src NOT LIKE '%hh.created_at>COALESCE(v_resume_after,''-infinity''::timestamptz)%'
    OR src NOT LIKE '%INTO v_doomed,v_keepers,v_reached FROM classified;%'
    OR src NOT LIKE '%UPDATE smarter_private.hand_history_prune_cursor%'
    OR src NOT LIKE '%horse_retention_days%'
    OR src NOT LIKE '%FOR UPDATE SKIP LOCKED%'
    OR src NOT LIKE '%f06_hand_cards_unresolved%'
    OR src NOT LIKE '%original_inventory_restoration_cases%' THEN
  RAISE EXCEPTION 'PRUNER_CURSOR_NOT_INSTALLED' USING ERRCODE='55000';
 END IF;
END $install$;

COMMIT;
