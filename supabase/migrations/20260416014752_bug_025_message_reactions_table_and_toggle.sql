-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416014752 "bug_025_message_reactions_table_and_toggle"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5235289a2febc3c6a894f4d7b10f887f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 D: fn_toggle_message_reaction was a silent-success stub and no storage
-- table exists for reactions. Creating the table + real toggle logic.

CREATE TABLE IF NOT EXISTS public.message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id, reaction)
);

CREATE INDEX IF NOT EXISTS message_reactions_message_id_idx ON public.message_reactions (message_id);
CREATE INDEX IF NOT EXISTS message_reactions_user_id_idx ON public.message_reactions (user_id);

ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "msg_reactions_select" ON public.message_reactions;
CREATE POLICY "msg_reactions_select"
  ON public.message_reactions FOR SELECT
  TO authenticated
  USING (
    -- Can read reactions on messages the user can read: sender, recipient, or same conversation participant
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_reactions.message_id
        AND (
          m.sender_id = auth.uid()
          OR m.recipient_id = auth.uid()
          OR m.receiver_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "msg_reactions_insert_self" ON public.message_reactions;
CREATE POLICY "msg_reactions_insert_self"
  ON public.message_reactions FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "msg_reactions_delete_self" ON public.message_reactions;
CREATE POLICY "msg_reactions_delete_self"
  ON public.message_reactions FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Real toggle function: insert if missing, delete if present. Returns true if added, false if removed.
DROP FUNCTION IF EXISTS public.fn_toggle_message_reaction(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.fn_toggle_message_reaction(
  p_message_id uuid,
  p_user_id uuid,
  p_reaction text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_existing_id uuid;
  v_added boolean;
BEGIN
  IF p_message_id IS NULL OR p_user_id IS NULL OR p_reaction IS NULL OR p_reaction = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing parameters');
  END IF;

  SELECT id INTO v_existing_id
  FROM public.message_reactions
  WHERE message_id = p_message_id AND user_id = p_user_id AND reaction = p_reaction;

  IF v_existing_id IS NOT NULL THEN
    DELETE FROM public.message_reactions WHERE id = v_existing_id;
    v_added := false;
  ELSE
    INSERT INTO public.message_reactions (message_id, user_id, reaction)
    VALUES (p_message_id, p_user_id, p_reaction);
    v_added := true;
  END IF;

  RETURN jsonb_build_object('success', true, 'added', v_added);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_toggle_message_reaction(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_toggle_message_reaction IS
'BUG 025: real implementation replacing silent-success stub. Toggles a single (message, user, reaction) tuple in the new message_reactions table.';

