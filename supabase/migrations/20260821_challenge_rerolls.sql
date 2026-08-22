-- Migration: Add Challenge Reroll support
CREATE OR REPLACE FUNCTION public.fn_reroll_challenge(
    p_user_challenge_id uuid,
    p_new_challenge_id text,
    p_diamond_cost integer DEFAULT 10
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_uid uuid;
    v_wallet_id uuid;
    v_current_diamonds integer;
    v_old_challenge_id text;
    v_completed boolean;
    v_claimed boolean;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
    END IF;

    -- Get the challenge
    SELECT challenge_id, completed, claimed 
      INTO v_old_challenge_id, v_completed, v_claimed
      FROM public.user_daily_challenges
     WHERE id = p_user_challenge_id AND user_id = v_uid;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Challenge not found or not owned by user';
    END IF;

    IF v_claimed THEN
        RAISE EXCEPTION 'Cannot reroll an already claimed challenge';
    END IF;

    -- Find wallet and check diamond balance
    SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_uid;
    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'Wallet not found';
    END IF;

    -- We use standard ledger mechanism if possible, or just update profiles diamond_balance
    -- Wait! Diamonds are in profiles or wallets?
    -- Let's check diamond_balances_read_only_to_players.sql or similar.
    -- I will just leave this part out until I verify where diamonds are stored.
END;
$$;
