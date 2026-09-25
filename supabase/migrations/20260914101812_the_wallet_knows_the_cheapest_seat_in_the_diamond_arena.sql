-- 20260914101812_the_wallet_knows_the_cheapest_seat_in_the_diamond_arena.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (phase 3 of the diamond wallet programme):
--
-- THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER. (Dan, 2026-09-13.)
--
-- Phase 2 gave the wallet an arena door that opens when the arena is open.
-- Open is not the same as affordable: the cheapest seat in the arena is the
-- NLH 1/2 table at 80 diamonds (read 2026-09-14), and a player holding 30
-- pressed through to a lobby that could only refuse them. The door should say
-- "Buy Diamonds To Sit Down, You Need 50 More" instead, and the number has
-- to come from the same rows fn_poker_diamond_buyin admits on - so the
-- summary now reports the cheapest ELIGIBLE cash seat, using that function's
-- own table predicate (nlh, not a tournament, not a cluster, not a template,
-- a live status, none of the feature flags it refuses).
--
-- Same function, three more keys inside `arena`:
--   min_cash_buy_in   the smallest min_buy_in among eligible arena cash tables
--   cheapest_table    { id, name, small_blind, big_blind } of that table
--   open_cash_tables  how many eligible cash tables the arena has right now
-- Everything phase 1 returned is unchanged.
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
    v_cheapest   record;
    v_open       integer := 0;
    v_lifetime   record;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'wallet_summary_is_own_only' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(diamonds, 0)::bigint INTO v_on_hand
      FROM public.profiles WHERE id = v_user;
    v_on_hand := COALESCE(v_on_hand, 0);

    SELECT COALESCE(SUM(GREATEST(issued - consumed - refunded - arena_reserved, 0)), 0)::bigint
      INTO v_collateral
      FROM public.diamond_purchase_lots WHERE user_id = v_user;

    SELECT COALESCE(SUM(balance), 0)::bigint,
           COUNT(*) FILTER (WHERE purpose = 'cash_seat')::integer,
           COUNT(*) FILTER (WHERE purpose = 'tournament_entry')::integer
      INTO v_in_arena, v_seats, v_entries
      FROM public.poker_diamond_custody
     WHERE user_id = v_user AND state <> 'released';

    SELECT c.id, c.name, c.slug, a.cash_games_enabled, a.tournaments_enabled
      INTO v_arena
      FROM public.ca_arena_settings a
      JOIN public.clubs c ON c.id = a.club_id
     WHERE a.id = 1 AND c.asset = 'diamonds' AND c.is_platform IS TRUE;

    IF v_arena.id IS NOT NULL THEN
        -- The cheapest seat a player could actually take: the same predicate
        -- fn_poker_diamond_buyin admits on, so this number is never a seat
        -- that function would refuse.
        SELECT t.id, t.name, t.small_blind, t.big_blind, t.min_buy_in,
               COUNT(*) OVER ()::integer AS open_count
          INTO v_cheapest
          FROM public.tables t
         WHERE t.club_id = v_arena.id
           AND t.game_variant = 'nlh'
           AND t.tournament_id IS NULL
           AND t.cluster_id IS NULL
           AND NOT COALESCE(t.is_template, false)
           AND t.status IN ('waiting', 'running', 'playing', 'active')
           AND COALESCE(t.rake_percent, 0) = 0 AND COALESCE(t.bbj_percent, 0) = 0
           AND NOT COALESCE(t.insurance_enabled, false) AND NOT COALESCE(t.bomb_pot_enabled, false)
           AND NOT COALESCE(t.run_it_twice_enabled, false) AND NOT COALESCE(t.run_it_twice, false)
           AND NOT COALESCE(t.allow_run_it_twice, false) AND NOT COALESCE(t.straddle_enabled, false)
           AND NOT COALESCE(t.seven_deuce_enabled, false) AND NOT COALESCE(t.nit_game, false)
           AND NOT COALESCE(t.all_in_or_fold, false) AND NOT COALESCE(t.pineapple_holdem, false)
           AND NOT COALESCE(t.cap_enabled, false) AND NOT COALESCE(t.auto_utg_straddle, false)
           AND NOT COALESCE(t.voluntary_straddle, false)
           AND t.min_buy_in IS NOT NULL AND t.min_buy_in > 0
         ORDER BY t.min_buy_in ASC, t.big_blind ASC, t.name ASC
         LIMIT 1;
        v_open := COALESCE(v_cheapest.open_count, 0);
    END IF;

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
            'tournaments_enabled', COALESCE(v_arena.tournaments_enabled, false),
            'open_cash_tables',    v_open,
            'min_cash_buy_in',     CASE WHEN v_cheapest.id IS NULL THEN NULL
                                        ELSE v_cheapest.min_buy_in::bigint END,
            'cheapest_table',      CASE WHEN v_cheapest.id IS NULL THEN NULL ELSE jsonb_build_object(
                'id',          v_cheapest.id,
                'name',        v_cheapest.name,
                'small_blind', v_cheapest.small_blind,
                'big_blind',   v_cheapest.big_blind
            ) END
        ) END,
        'lifetime_earned', COALESCE(v_lifetime.lifetime_earned, 0),
        'lifetime_spent',  COALESCE(v_lifetime.lifetime_spent, 0),
        'read_at',         now()
    );
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_wallet_summary(uuid) IS
  'The diamond wallet in one read: on_hand, collateral (the transfer RPC''s own refusal expression), sendable, in_arena (open poker_diamond_custody) with seat/entry counts, the Diamond Arena club with its open flags, its cheapest eligible cash seat (fn_poker_diamond_buyin''s own table predicate) and open table count, and lifetime totals. DIAMONDS ONLY: the Diamond Arena has no chips, ever. Own-user only unless service_role.';

COMMIT;
