-- TIER 2. Drops one strictly-subsumed RLS policy. No semantic change.
-- Applied to production 2026-08-26.
--
-- public.message_reactions carried TWO permissive SELECT policies for
-- authenticated, so the planner evaluated both on every row:
--
--   message_reactions_select  (broad)
--     m.sender_id = uid OR m.recipient_id = uid OR m.receiver_id = uid
--     OR EXISTS (m2 in the same conversation with any of those three)
--
--   msg_reactions_select      (narrow)
--     m.sender_id = uid OR m.recipient_id = uid OR m.receiver_id = uid
--
-- The narrow policy's condition is exactly the first three disjuncts of the
-- broad one, so `broad OR narrow` === `broad`. Dropping the narrow one cannot
-- grant or revoke access to any row; it only stops the second evaluation.
--
-- Deliberately NOT touching the other duplicate-policy tables from the same
-- advisor sweep. Nine pair a specific policy with union_overseer_read on money
-- tables, where the two conditions genuinely differ and must be OR'd.
-- survival_progress and trivia_pvp_matches pair a narrow owner policy with one
-- whose qual is literally `true`, which makes those tables world-readable --
-- collapsing those is a SECURITY decision, not a performance one. See
-- .agent/audits/2026-08-26-anon-readable-tables.md.
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
  SELECT count(*) INTO v_broad FROM pg_policies
   WHERE schemaname='public' AND tablename='message_reactions'
     AND policyname='message_reactions_select';
  IF v_broad <> 1 THEN
    RAISE EXCEPTION 'assertion failed: broad policy message_reactions_select missing -- access would be lost';
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
