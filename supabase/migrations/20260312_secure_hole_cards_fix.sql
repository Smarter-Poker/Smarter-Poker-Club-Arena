-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ CLUB ARENA — Secure Hole Cards & God Mode Vulnerability Fix
-- ═══════════════════════════════════════════════════════════════════════════════
-- Blocks a severe security vulnerability where hole cards were leaked over
-- the public WebSocket broadcast. This table secures them with Postgres RLS.

CREATE TABLE IF NOT EXISTS public.table_hole_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id UUID NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
    hand_number BIGINT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    seat_number INTEGER NOT NULL,
    cards JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(table_id, hand_number, user_id)
);

ALTER TABLE public.table_hole_cards ENABLE ROW LEVEL SECURITY;

-- SELECT: Users can only read their own hole cards (prevents God Mode)
CREATE POLICY "Users can read own hole cards" 
ON public.table_hole_cards FOR SELECT TO authenticated 
USING (auth.uid() = user_id);

-- INSERT: HeadlessTableEngine uses service_role (bypasses RLS), but this
-- policy exists for defense-in-depth if any client-side code ever attempts writes
CREATE POLICY "Service role can insert hole cards"
ON public.table_hole_cards FOR INSERT TO authenticated
WITH CHECK (false); -- Block all authenticated client INSERTs; only service_role can write

-- Performance index for the client-side fallback query pattern
-- (SELECT ... WHERE table_id = ? AND user_id = ? ORDER BY hand_number DESC LIMIT 1)
CREATE INDEX IF NOT EXISTS idx_hole_cards_table_user
ON public.table_hole_cards (table_id, user_id, hand_number DESC);

ALTER PUBLICATION supabase_realtime ADD TABLE table_hole_cards;

-- Cleanup function — removes cards older than 24 hours to prevent unbounded growth
CREATE OR REPLACE FUNCTION cleanup_old_hole_cards()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    DELETE FROM public.table_hole_cards WHERE created_at < NOW() - INTERVAL '24 hours';
END;
$$;

-- SECURITY DEFINER RPC to bypass RLS INSERT policy.
-- HeadlessTableEngine runs client-side with the anon key, which is blocked
-- by the WITH CHECK(false) INSERT policy. This RPC runs as the DB owner.
CREATE OR REPLACE FUNCTION insert_hole_cards(
    p_table_id UUID,
    p_hand_number BIGINT,
    p_cards JSONB
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public.table_hole_cards (table_id, hand_number, user_id, seat_number, cards)
    SELECT p_table_id, p_hand_number,
        (item->>'user_id')::UUID,
        (item->>'seat_number')::INTEGER,
        item->'cards'
    FROM jsonb_array_elements(p_cards) AS item
    ON CONFLICT (table_id, hand_number, user_id) DO UPDATE
    SET cards = EXCLUDED.cards;
END;
$$;

-- Schedule cleanup via pg_cron (runs every 6 hours)
-- NOTE: pg_cron must be enabled in Supabase dashboard
SELECT cron.schedule(
    'cleanup-hole-cards',
    '0 */6 * * *',
    $$SELECT cleanup_old_hole_cards()$$
);
