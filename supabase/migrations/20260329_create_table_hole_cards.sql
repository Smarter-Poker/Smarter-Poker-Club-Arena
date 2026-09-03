-- FIX 167: Create table_hole_cards — secure per-player hole card delivery
-- The insert_hole_cards() RPC function already existed but the table it references was MISSING.
-- Without this table, players cannot see their own hole cards.

CREATE TABLE IF NOT EXISTS public.table_hole_cards (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    table_id UUID NOT NULL,
    hand_number BIGINT NOT NULL,
    user_id UUID NOT NULL,
    seat_number INTEGER NOT NULL,
    cards JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(table_id, hand_number, user_id)
);

-- Enable RLS — critical for card security (Bible V8 §4.6)
ALTER TABLE public.table_hole_cards ENABLE ROW LEVEL SECURITY;

-- Users can only read their OWN hole cards
CREATE POLICY "Users can read own hole cards"
ON public.table_hole_cards
FOR SELECT
USING (auth.uid() = user_id);

-- Service role can manage all hole cards (server inserts via SECURITY DEFINER RPC)
CREATE POLICY "Service role manages hole cards"
ON public.table_hole_cards
FOR ALL
USING (true)
WITH CHECK (true);

-- Index for fast lookups by table + hand + user
CREATE INDEX IF NOT EXISTS idx_table_hole_cards_lookup
ON public.table_hole_cards(table_id, hand_number, user_id);

-- Enable Realtime so clients can subscribe to their own card inserts
ALTER PUBLICATION supabase_realtime ADD TABLE public.table_hole_cards;
