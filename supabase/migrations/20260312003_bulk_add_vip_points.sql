-- =======================================================================================
-- MIGRATION: 20260312003_bulk_add_vip_points.sql
-- DESCRIPTION: High-performance backend ledger processor that bulk-inserts VIP points
--              awarded during a hand, bypassing N+1 queries.
-- =======================================================================================

CREATE OR REPLACE FUNCTION public.bulk_add_vip_points(
    payload JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    item JSONB;
BEGIN
    FOR item IN SELECT * FROM jsonb_array_elements(payload)
    LOOP
        -- 1. Insert ledger entry for each player
        INSERT INTO public.vip_points_ledger (user_id, amount, transaction_type, description)
        VALUES (
            (item->>'user_id')::UUID, 
            (item->>'amount')::INTEGER, 
            item->>'transaction_type', 
            item->>'description'
        );

        -- 2. Update cached total on user profiles
        UPDATE public.profiles
        SET vip_points = COALESCE(vip_points, 0) + (item->>'amount')::INTEGER
        WHERE id = (item->>'user_id')::UUID;
    END LOOP;
END;
$$;
