-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420050920 "phase40_lock_conversation_list_to_caller"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4dbb342ea111c18695a567e41b37e063 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug #54: conversation-list functions leak arbitrary users' inboxes.
--
--   fn_get_user_conversations(p_user_id) — SECURITY DEFINER, no auth check.
--     Any authenticated user could call it with another user's UUID and see:
--       - every conversation that user is in
--       - the other party's display name and avatar
--       - unread counts per conversation
--       - last_message_at timestamps
--
--   fn_get_conversations(p_user_id) — a broken stub returning '[]'::json
--     regardless of who's asking. The frontend inbox screen is non-functional
--     at the DB layer if it uses this RPC.
--
-- Fix:
--   1. fn_get_user_conversations: require auth.uid() = p_user_id (or service_role)
--   2. fn_get_conversations: drop stub implementation and delegate to
--      fn_get_user_conversations, aggregating rows into json with the same
--      auth gate.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_user_conversations(p_user_id uuid)
RETURNS TABLE(
    conversation_id uuid,
    title text,
    is_group boolean,
    last_message_at timestamp with time zone,
    unread_count bigint,
    other_user_id uuid,
    other_user_username text,
    other_user_avatar text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.role() <> 'service_role' THEN
      IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
        RAISE EXCEPTION 'AUTH_MISMATCH'
              USING HINT = 'can only fetch your own conversations';
      END IF;
    END IF;

    RETURN QUERY
    SELECT
        c.id AS conversation_id,
        COALESCE(c.group_name, NULL) AS title,
        c.is_group,
        c.last_message_at,
        (
            SELECT COUNT(*)
              FROM social_messages m
             WHERE m.conversation_id = c.id
               AND m.sender_id <> p_user_id
               AND COALESCE(m.is_deleted, false) = false
               AND NOT EXISTS (
                   SELECT 1 FROM social_message_reads r
                    WHERE r.message_id = m.id
                      AND r.user_id = p_user_id
               )
        ) AS unread_count,
        ou.id AS other_user_id,
        COALESCE(ou.display_name, ou.username, ou.full_name) AS other_user_username,
        ou.avatar_url AS other_user_avatar
    FROM social_conversations c
    JOIN social_conversation_participants p
      ON p.conversation_id = c.id AND p.user_id = p_user_id
    LEFT JOIN social_conversation_participants op
      ON op.conversation_id = c.id AND op.user_id <> p_user_id
    LEFT JOIN profiles ou ON ou.id = op.user_id
    ORDER BY c.last_message_at DESC NULLS LAST;
END;
$fn$;

-- Replace the stub with a real implementation that wraps the hardened function
CREATE OR REPLACE FUNCTION public.fn_get_conversations(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'public', 'extensions'
AS $fn$
BEGIN
    IF auth.role() <> 'service_role' THEN
      IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
        RAISE EXCEPTION 'AUTH_MISMATCH'
              USING HINT = 'can only fetch your own conversations';
      END IF;
    END IF;

    RETURN COALESCE(
      (SELECT json_agg(row_to_json(row))
         FROM (
           SELECT conversation_id, title, is_group, last_message_at,
                  unread_count, other_user_id,
                  other_user_username, other_user_avatar
             FROM public.fn_get_user_conversations(p_user_id)
         ) row),
      '[]'::json
    );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.fn_get_conversations(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_user_conversations(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_get_conversations IS
  'Phase 40 Bug 54: was a broken stub returning []. Now delegates to '
  'fn_get_user_conversations with auth check. Returns caller''s own inbox.';
COMMENT ON FUNCTION public.fn_get_user_conversations IS
  'Phase 40 Bug 54: hardened against impersonation. Caller must match '
  'p_user_id (or be service_role). Returns the user''s conversation list with '
  'unread counts and other-party info.';
