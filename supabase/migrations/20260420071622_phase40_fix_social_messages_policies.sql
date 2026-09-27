-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420071622 "phase40_fix_social_messages_policies"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 be1f824eabddf6f5a3897cd3f7b1598b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- phase40_fix_social_messages_policies
--
-- Closes two long-standing RLS gaps on social_messages:
--
-- Bug #56 — Duplicate INSERT policies: a STRICT policy that requires
--           sender_id=auth.uid() AND participant was AND'd with a LAX policy
--           that only required participant. Postgres OR-combines INSERT
--           policies → the lax one won → sender_id could be forged.
--
-- Bug #57 — UPDATE policy had USING (sender_id = auth.uid()) but WITH CHECK
--           was NULL (default = no post-update check). A sender could UPDATE
--           their own row and change conversation_id to move the message
--           into a different conversation they also participate in.
--
-- Fixes:
--   1. DROP the lax INSERT policy. Keep only the strict one.
--   2. RECREATE the UPDATE policy with WITH CHECK matching USING.
--   3. Add a BEFORE UPDATE trigger that blocks changes to sender_id,
--      conversation_id, and created_at (service_role bypass preserved for
--      data-fix operations).
-- ═══════════════════════════════════════════════════════════════════════════

-- Bug #56 fix
DROP POLICY IF EXISTS "Users can send messages to their conversations" ON public.social_messages;

-- Bug #57 fix — part 1: policy with WITH CHECK
DROP POLICY IF EXISTS "Users can update their messages" ON public.social_messages;
CREATE POLICY "Users can update their messages"
  ON public.social_messages
  FOR UPDATE
  USING (sender_id = (SELECT auth.uid()))
  WITH CHECK (sender_id = (SELECT auth.uid()));

-- Bug #57 fix — part 2: field-level lock (mirrors the pattern of
-- trg_block_direct_home_seat_update from phase40_protect_home_seats_direct_update).
CREATE OR REPLACE FUNCTION public.fn_block_message_field_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Service role is the maintenance path and bypasses field locks.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id THEN
    RAISE EXCEPTION 'sender_id cannot be changed on an existing message'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    RAISE EXCEPTION 'conversation_id cannot be changed on an existing message'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at cannot be changed on an existing message'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_block_message_field_reassignment ON public.social_messages;
CREATE TRIGGER trg_block_message_field_reassignment
  BEFORE UPDATE ON public.social_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_block_message_field_reassignment();
