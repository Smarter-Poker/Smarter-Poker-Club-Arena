-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825195416; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- BAN CHAT, ENFORCED WHERE IT CANNOT BE ROUTED AROUND
-- ───────────────────────────────────────────────────────────────────────────
-- Dan 2026-08-25, table-creation parity. `tables.ban_chat` has existed since
-- February and is read only by the TOURNAMENT surfaces. For a cash table it
-- did nothing: a host could switch chat off and every player kept talking.
--
-- There is no server hop to gate. `useTableChat.handleSendChatMessage` calls
-- `supabase.from('table_chat').insert(...)` straight from the browser with the
-- player's own JWT, so the RLS policy IS the enforcement — anything done in
-- the client is a courtesy that a modified client ignores.
--
-- The existing policy is kept intact and extended: same identity rule, same
-- message_type rule, plus the table's own switch. NOT EXISTS rather than a
-- join so a chat row whose table_id no longer resolves still inserts exactly
-- as it does today (table_chat has no FK on table_id).
--
-- Reactions and gift throws ride this same table encoded as [REACTION:...] and
-- [THROW:...] messages, so they fall silent too. That is the correct reading
-- of "Ban Chat" at a table: an emoji spammed at a player is the behaviour the
-- switch exists to stop.
-- ═══════════════════════════════════════════════════════════════════════════

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'table_chat' AND policyname = 'table_chat_insert'
  ) THEN
    RAISE EXCEPTION 'table_chat_insert policy is missing - refusing to guess at the chat rule';
  END IF;
END
$migration$;

DROP POLICY IF EXISTS "table_chat_insert" ON public.table_chat;

CREATE POLICY "table_chat_insert" ON public.table_chat
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND message_type = 'player'
  AND NOT EXISTS (
    SELECT 1 FROM public.tables t
     WHERE t.id = table_chat.table_id
       AND t.ban_chat IS TRUE
  )
);

DO $verify$
DECLARE v_check text;
BEGIN
  SELECT with_check INTO v_check
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'table_chat' AND policyname = 'table_chat_insert';

  IF v_check IS NULL THEN
    RAISE EXCEPTION 'the replacement policy did not land';
  END IF;
  -- The two original rules must survive alongside the new one.
  IF position('auth.uid()' IN v_check) = 0 THEN
    RAISE EXCEPTION 'the identity rule was lost';
  END IF;
  IF position('message_type' IN v_check) = 0 THEN
    RAISE EXCEPTION 'the message_type rule was lost';
  END IF;
  IF position('ban_chat' IN v_check) = 0 THEN
    RAISE EXCEPTION 'ban_chat is not being checked';
  END IF;
END
$verify$;

-- ROLLBACK
--   DROP POLICY IF EXISTS "table_chat_insert" ON public.table_chat;
--   CREATE POLICY "table_chat_insert" ON public.table_chat FOR INSERT
--     WITH CHECK (user_id = auth.uid() AND message_type = 'player');
