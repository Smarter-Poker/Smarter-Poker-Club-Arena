-- 20260930060822_the_arena_plate_reads_scalars_not_an_unassigned_record.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260930054954 gated the cheapest-seat scan on cash_games_enabled so the
-- wallet summary would stop reporting 17 open tables and an 80-Diamond seat for
-- a closed arena. It held those figures in a plpgsql `record`, v_cheapest, and a
-- record has NO TUPLE STRUCTURE until something assigns it - so on the closed
-- arena, where the gated SELECT INTO no longer runs, the answer's own NULL test
-- on that record raised
--
--   55000: record "v_cheapest" is not assigned yet
--   DETAIL: The tuple structure of a not-yet-assigned record is indeterminate.
--
-- for EVERY caller, not only a closed one. The wallet plate would have read
-- Unavailable. It was caught by the own-read probe minutes after application
-- (CLAUDE.md 11.5: what you want from a probe is the answer it gives), and this
-- is that repair, applied at 06:08 UTC the same morning.
--
-- The five seat figures are now plain scalars, which are NULL from the start -
-- exactly the state a closed arena has to report. The gated scan is otherwise
-- byte-identical to the one that has been live since 20260914101812, and its
-- open branch was re-proved against production in a rolled-back DO block: 17
-- tables, NLH 1/2, small blind 1.00, big blind 2.00, min buy-in 80.
--
-- Nothing else changes. The answer keys, the guard, the grants and the arena
-- switches are untouched; cash_games_enabled and tournaments_enabled stay false.
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
    v_open       integer := 0;
    v_lifetime   record;
    -- SCALARS, NOT A RECORD (2026-09-30). v_cheapest was a plpgsql `record`,
    -- and a record only acquires a tuple structure when something assigns it.
    -- Gating the scan on cash_games_enabled meant the SELECT INTO no longer ran
    -- on a closed arena, so `v_cheapest.id IS NULL` in the answer raised
    -- 55000 "record v_cheapest is not assigned yet" for every caller. Scalars
    -- are NULL from the start, which is the state the closed arena has to
    -- report anyway.
    v_seat_id    uuid;
    v_seat_name  text;
    v_seat_sb    numeric;
    v_seat_bb    numeric;
    v_seat_min   numeric;
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

    -- THE PLATE MAY NOT CONTRADICT THE SWITCH (2026-09-30). These three fields
    -- used to be computed whatever cash_games_enabled said, so a closed arena
    -- still reported 17 open tables and a named 80-Diamond seat. The switch is
    -- the authority: it is what fn_poker_diamond_buyin and fn_poker_diamond_top_up
    -- enforce, and while it is false every one of those tables refuses a buy-in.
    -- Closed therefore means open_cash_tables 0, min_cash_buy_in NULL and
    -- cheapest_table NULL, and the scan does not run at all.
    IF v_arena.id IS NOT NULL AND COALESCE(v_arena.cash_games_enabled, false) THEN
        -- The cheapest seat a player could actually take: the same predicate
        -- fn_poker_diamond_buyin admits on, so this number is never a seat
        -- that function would refuse.
        SELECT t.id, t.name, t.small_blind, t.big_blind, t.min_buy_in,
               COUNT(*) OVER ()::integer
          INTO v_seat_id, v_seat_name, v_seat_sb, v_seat_bb, v_seat_min, v_open
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
        -- No eligible table leaves v_open NULL, and a NULL count would be a
        -- figure nobody can read. Zero is the answer, and it is true.
        v_open := COALESCE(v_open, 0);
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
            'min_cash_buy_in',     CASE WHEN v_seat_id IS NULL THEN NULL
                                        ELSE v_seat_min::bigint END,
            'cheapest_table',      CASE WHEN v_seat_id IS NULL THEN NULL ELSE jsonb_build_object(
                'id',          v_seat_id,
                'name',        v_seat_name,
                'small_blind', v_seat_sb,
                'big_blind',   v_seat_bb
            ) END
        ) END,
        'lifetime_earned', COALESCE(v_lifetime.lifetime_earned, 0),
        'lifetime_spent',  COALESCE(v_lifetime.lifetime_spent, 0),
        'read_at',         now()
    );
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_wallet_summary(uuid) IS
  'The diamond wallet in one read: on_hand, collateral (the transfer RPC''s own refusal expression), sendable, in_arena (open poker_diamond_custody) with seat/entry counts, the Diamond Arena club with its open flags, its cheapest eligible cash seat (fn_poker_diamond_buyin''s own table predicate) and open table count, and lifetime totals. The seat figures obey cash_games_enabled: a closed arena reports 0 open tables and no cheapest seat, because the buy-in doors refuse every one of them, and they are held in scalars so the skipped scan leaves no unassigned record. DIAMONDS ONLY: the Diamond Arena has no chips, ever. Own-user only unless service_role.';

REVOKE ALL ON FUNCTION public.fn_diamond_wallet_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_wallet_summary(uuid) TO authenticated, service_role;

COMMIT;
