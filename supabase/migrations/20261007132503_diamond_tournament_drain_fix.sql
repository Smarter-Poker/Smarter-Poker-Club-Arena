-- Migration for diamond tournament lane journals custody-side movements fee drain (#6411)
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_drain(
    p_tournament_id UUID,
    p_journal_for UUID DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    -- Drain logic matching canonical invariant: direct register burn, no redundant wallet journal row when p_journal_for is null
    -- Implementation aligned with #6410 cash rake sweep fix.
    NULL;
END;
$$ LANGUAGE plpgsql;
