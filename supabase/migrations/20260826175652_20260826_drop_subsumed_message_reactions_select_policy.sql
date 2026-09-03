-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826175652; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- TIER 2. Drops one strictly-subsumed RLS policy. No semantic change.
--
-- public.message_reactions carried TWO permissive SELECT policies for
-- authenticated, so the planner evaluated both on every row:
--
--   message_reactions_select  (the broad one)
--     m.sender_id = uid OR m.recipient_id = uid OR m.receiver_id = uid
--     OR EXISTS (m2 in the same conversation with any of those three)
--
--   msg_reactions_select      (the narrow one)
--     m.sender_id = uid OR m.recipient_id = uid OR m.receiver_id = uid
--
-- The narrow policy's condition is exactly the first three disjuncts of the
-- broad one, so `broad OR narrow` === `broad`. Dropping the narrow one cannot
-- grant or revoke access to any row; it only stops the second evaluation.
--
-- Deliberately NOT touching the other two duplicate-policy tables found in the
-- same advisor sweep. survival_progress and trivia_pvp_matches each pair a
-- narrow owner policy with one whose qual is literally `true`, which means those
-- tables are world-readable. Collapsing those is a SECURITY decision (is
-- survival progress meant to be public?), not a performance one, and it is not
-- an agent's call to make silently. Raised for a human instead.
--
-- ROLLBACK:
--   CREATE POLICY msg_reactions_select ON public.message_reactions
--     FOR SELECT TO authenticated USING (EXISTS (
--       SELECT 1 FROM messages m
--        WHERE m.id = message_reactions.message_id
--          AND (m.sender_id = (SELECT auth.uid())
--            OR m.recipient_id = (SELECT auth.uid())
--            OR m.receiver_id = (SELECT auth.uid()))));

DROP POLICY IF EXISTS msg_reactions_select ON public.message_reactions;

DO $$
DECLARE v_dupes int; v_broad int;
BEGIN
  SELECT count(*) INTO v_broad
    FROM pg_policies
   WHERE schemaname='public' AND tablename='message_reactions'
     AND policyname='message_reactions_select';
  IF v_broad <> 1 THEN
    RAISE EXCEPTION 'assertion failed: the broad policy message_reactions_select is missing -- access would be lost';
  END IF;

  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='message_reactions' AND permissive='PERMISSIVE'
     GROUP BY cmd, roles HAVING count(*) > 1
  ) s;
  IF v_dupes <> 0 THEN
    RAISE EXCEPTION 'assertion failed: message_reactions still has % duplicate permissive group(s)', v_dupes;
  END IF;

  RAISE NOTICE 'message_reactions: duplicate permissive SELECT removed, broad policy intact';
END $$;
