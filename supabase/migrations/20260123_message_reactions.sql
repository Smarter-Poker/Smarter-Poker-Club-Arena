-- ═══════════════════════════════════════════════════════════════════════════════
-- 💬 MESSAGE REACTIONS TABLE — Club Messaging Emoji Reactions
-- ═══════════════════════════════════════════════════════════════════════════════
-- Stores emoji reactions on messages for the club-internal messaging system

-- Create message_reactions table
CREATE TABLE IF NOT EXISTS public.message_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reaction VARCHAR(32) NOT NULL, -- emoji or reaction code (e.g., '👍', '❤️', 'laugh')
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure user can only add one of each reaction type per message
    UNIQUE(message_id, user_id, reaction)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON public.message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user_id ON public.message_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_reaction ON public.message_reactions(reaction);

-- Enable RLS
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Policy: Users can view reactions on messages they can see
-- (requires the messages table to have appropriate RLS policies)
CREATE POLICY "Users can view reactions on messages they can see"
ON public.message_reactions
FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM public.messages m
        WHERE m.id = message_reactions.message_id
        -- Add your messages visibility check here based on your messages RLS
    )
);

-- Policy: Users can add reactions to messages they can see
CREATE POLICY "Users can add reactions to messages they can see"
ON public.message_reactions
FOR INSERT
WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
        SELECT 1 FROM public.messages m
        WHERE m.id = message_reactions.message_id
        -- Add your messages visibility check here based on your messages RLS
    )
);

-- Policy: Users can delete their own reactions
CREATE POLICY "Users can delete their own reactions"
ON public.message_reactions
FOR DELETE
USING (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Function to toggle a reaction (add if not exists, remove if exists)
CREATE OR REPLACE FUNCTION toggle_message_reaction(
    p_message_id UUID,
    p_reaction VARCHAR(32)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing_id UUID;
BEGIN
    -- Check if reaction already exists
    SELECT id INTO v_existing_id
    FROM public.message_reactions
    WHERE message_id = p_message_id
      AND user_id = auth.uid()
      AND reaction = p_reaction;
    
    IF v_existing_id IS NOT NULL THEN
        -- Remove existing reaction
        DELETE FROM public.message_reactions WHERE id = v_existing_id;
        RETURN FALSE; -- Reaction removed
    ELSE
        -- Add new reaction
        INSERT INTO public.message_reactions (message_id, user_id, reaction)
        VALUES (p_message_id, auth.uid(), p_reaction);
        RETURN TRUE; -- Reaction added
    END IF;
END;
$$;

-- Function to get reaction counts and user's reactions for a message
CREATE OR REPLACE FUNCTION get_message_reactions(p_message_id UUID)
RETURNS TABLE (
    reaction VARCHAR(32),
    count BIGINT,
    user_reacted BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT 
        r.reaction,
        COUNT(*) as count,
        BOOL_OR(r.user_id = auth.uid()) as user_reacted
    FROM public.message_reactions r
    WHERE r.message_id = p_message_id
    GROUP BY r.reaction
    ORDER BY count DESC;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- REALTIME SUBSCRIPTION
-- ═══════════════════════════════════════════════════════════════════════════════

-- Enable realtime for reactions
ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reactions;
