-- 20260914015457_the_wallet_learns_the_diamond_arena.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER. (Dan, 2026-09-13, twice.)
-- The database already refuses a chip balance on the diamonds club
-- (poker_arena_membership_guard: "Diamond Membership Is Automatic And Has No
-- Chip Wallet Or Hierarchy"). This function reports diamonds and nothing else.
--
-- The player wallet (Club Arena /wallet, World Hub DiamondWalletModal) prints
-- ONE diamond figure, profiles.diamonds, and does not know the Diamond Arena
-- exists: no reference to it in the page, the ledger hook or DiamondService.
-- Yet the platform already holds three more figures a player is judged by:
--
--   * COLLATERAL: recently purchased diamonds inside the refund window cannot
--     be sent (send_wallet_diamond_transfer refuses with
--     insufficient_transferable_diamonds). Computed there, shown nowhere.
--   * IN THE ARENA: diamonds moved into poker_diamond_custody for a cash seat
--     or a tournament entry (fn_poker_diamond_buyin). Already deducted from
--     profiles.diamonds, so a seated player's wallet simply looks smaller.
--   * WHETHER THE ARENA IS OPEN: ca_arena_settings.cash_games_enabled and
--     tournaments_enabled. Both false on 2026-09-13 (release gated on
--     accounting certification), and the wallet must say so rather than offer
--     a door that refuses.
--
-- One read, one RPC, so the two wallets cannot disagree about any of them.
-- SECURITY DEFINER because ca_arena_settings and diamond_purchase_lots are not
-- readable by `authenticated`; the caller is pinned to auth.uid() unless the
-- caller is service_role (the World Hub API), and a mismatch raises 42501 -
-- there is no way to read another player's figures through this function.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_diamond_wallet_summary(
    p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_user       uuid := COALESCE(p_user_id, auth.uid());
    v_role       text := COALESCE(auth.jwt() ->> 'role', current_user);
    v_on_hand    bigint;
    v_collateral bigint;
    v_in_arena   bigint;
    v_seats      integer;
    v_entries    integer;
    v_arena      record;
    v_lifetime   record;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    -- A player reads only their own figures. service_role (the World Hub API,
    -- which has already authenticated the player) may name one.
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'wallet_summary_is_own_only' USING ERRCODE = '42501';
    END IF;

    -- On hand: the one figure the wallet always showed. Custody is already
    -- outside it (fn_poker_diamond_buyin debits profiles.diamonds).
    SELECT COALESCE(diamonds, 0)::bigint INTO v_on_hand
      FROM public.profiles WHERE id = v_user;
    v_on_hand := COALESCE(v_on_hand, 0);

    -- Collateral: EXACTLY the expression send_wallet_diamond_transfer uses to
    -- refuse a send, so "Sendable" here is what that RPC will actually allow.
    SELECT COALESCE(SUM(GREATEST(issued - consumed - refunded - arena_reserved, 0)), 0)::bigint
      INTO v_collateral
      FROM public.diamond_purchase_lots WHERE user_id = v_user;

    -- In the arena: every open custody row (reserved or active), by purpose.
    SELECT COALESCE(SUM(balance), 0)::bigint,
           COUNT(*) FILTER (WHERE purpose = 'cash_seat')::integer,
           COUNT(*) FILTER (WHERE purpose = 'tournament_entry')::integer
      INTO v_in_arena, v_seats, v_entries
      FROM public.poker_diamond_custody
     WHERE user_id = v_user AND state <> 'released';

    -- The arena itself: the one platform club whose asset is diamonds.
    SELECT c.id, c.name, c.slug, a.cash_games_enabled, a.tournaments_enabled
      INTO v_arena
      FROM public.ca_arena_settings a
      JOIN public.clubs c ON c.id = a.club_id
     WHERE a.id = 1 AND c.asset = 'diamonds' AND c.is_platform IS TRUE;

    SELECT * INTO v_lifetime FROM public.fn_diamond_lifetime_totals(v_user);

    RETURN jsonb_build_object(
        'user_id',        v_user,
        'on_hand',        v_on_hand,
        'collateral',     v_collateral,
        'sendable',       GREATEST(v_on_hand - v_collateral, 0),
        'in_arena',       v_in_arena,
        'arena_seats',    v_seats,
        'arena_entries',  v_entries,
        'arena', CASE WHEN v_arena.id IS NULL THEN NULL ELSE jsonb_build_object(
            'club_id',             v_arena.id,
            'name',                v_arena.name,
            'slug',                v_arena.slug,
            'cash_games_enabled',  COALESCE(v_arena.cash_games_enabled, false),
            'tournaments_enabled', COALESCE(v_arena.tournaments_enabled, false)
        ) END,
        'lifetime_earned', COALESCE(v_lifetime.lifetime_earned, 0),
        'lifetime_spent',  COALESCE(v_lifetime.lifetime_spent, 0),
        'read_at',         now()
    );
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_wallet_summary(uuid) IS
  'The diamond wallet in one read: on_hand (profiles.diamonds), collateral (purchase lots inside the refund window, the same expression send_wallet_diamond_transfer refuses on), sendable, in_arena (open poker_diamond_custody balance) with seat/entry counts, the Diamond Arena club and its open flags, and lifetime totals. DIAMONDS ONLY: the Diamond Arena has no chips, ever. Own-user only unless service_role.';

REVOKE ALL ON FUNCTION public.fn_diamond_wallet_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_wallet_summary(uuid) TO authenticated, service_role;

COMMIT;
