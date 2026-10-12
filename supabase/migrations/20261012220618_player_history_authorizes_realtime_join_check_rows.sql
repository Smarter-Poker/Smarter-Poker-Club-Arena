-- 20261012220618_player_history_authorizes_realtime_join_check_rows.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Live private-channel joins were denied because Realtime's authorization
-- probe omits private (default false). Authorize the exact authenticated topic
-- and staff identity instead. Producer and client still use private channels.
-- No INSERT policy/grant or raw journal access is added.
-- @live-proof: EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='realtime.messages'::regclass AND polname='authorized staff receive player history signals' AND position('private' in pg_get_expr(polqual,polrelid))=0)
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy
    WHERE polrelid='realtime.messages'::regclass
      AND polname='authorized staff receive player history signals'
      AND polcmd='r' AND position('private IS TRUE' in pg_get_expr(polqual,polrelid))>0) THEN
    RAISE EXCEPTION 'Expected original history receive policy absent; refusing replay';
  END IF;
END $guard$;
ALTER POLICY "authorized staff receive player history signals"
ON realtime.messages TO authenticated
USING (extension='broadcast' AND topic=realtime.topic() AND EXISTS (
  SELECT 1 FROM (SELECT CASE
    WHEN realtime.topic() ~ '^player-history:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(realtime.topic(),':',2)::uuid ELSE NULL END AS club_id) topic
  WHERE public.ca_player_history_can_read(topic.club_id)
));
COMMIT;
