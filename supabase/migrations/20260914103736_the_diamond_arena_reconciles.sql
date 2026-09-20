-- 20260914103736_the_diamond_arena_reconciles.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (phase 4 of the diamond wallet programme):
--
-- THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER. (Dan, 2026-09-13.)
--
-- Conservation across a Diamond Arena session is already enforced where the
-- money moves, in one transaction each:
--   fn_poker_diamond_buyin   journal (arena_deposit, -amount) + custody +
--                            movement(reserve) + lot reservation, together;
--   the top-up path          the same shape, action reserve;
--   fn_poker_diamond_release refuses an active cash seat until the seat has
--                            left with stack = custody.balance, then credits
--                            (arena_withdraw, +balance) + movement(release) +
--                            custody released, together; replay returns the
--                            immutable receipt. The old recovery function is
--                            gone (recover_fns = 0 on 2026-09-14).
--
-- What did not exist is the STATEMENT: a player could not see that every one
-- of their sessions reconciles, and nothing per player asserted it. This is
-- that read - and only a read. It reports; it repairs nothing (CLAUDE.md
-- 10.12: a live path that is already atomic gets a statement, never a sweep).
--
-- One row per player, own-user only unless service_role:
--   sessions, open_sessions, buy_ins, cash_outs, in_play,
--   net_result_settled (cash-outs minus buy-ins over RELEASED sessions only:
--     an open session is still being played, so its result is not a result),
--   unmatched: every movement whose journal row is missing or carries the
--     wrong amount, every released session with no release movement, every
--     open cash seat whose live stack disagrees with its custody balance,
--   balanced: unmatched is empty.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_diamond_arena_reconciliation(
    p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_user      uuid := COALESCE(p_user_id, auth.uid());
    v_role      text := COALESCE(auth.jwt() ->> 'role', current_user);
    v_sessions  integer := 0;
    v_open      integer := 0;
    v_buy_ins   bigint  := 0;
    v_cash_outs bigint  := 0;
    v_in_play   bigint  := 0;
    v_settled   bigint  := 0;
    v_unmatched jsonb   := '[]'::jsonb;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'arena_reconciliation_is_own_only' USING ERRCODE = '42501';
    END IF;

    SELECT COUNT(*)::integer,
           COUNT(*) FILTER (WHERE state <> 'released')::integer,
           COALESCE(SUM(balance) FILTER (WHERE state <> 'released'), 0)::bigint
      INTO v_sessions, v_open, v_in_play
      FROM public.poker_diamond_custody
     WHERE user_id = v_user;

    SELECT COALESCE(SUM(amount) FILTER (WHERE action = 'reserve'), 0)::bigint,
           COALESCE(SUM(amount) FILTER (WHERE action = 'release'), 0)::bigint
      INTO v_buy_ins, v_cash_outs
      FROM public.poker_diamond_movements
     WHERE user_id = v_user;

    -- Settled result: over released sessions only. An open session is still
    -- being played and has no result yet.
    SELECT COALESCE(SUM(CASE WHEN m.action = 'release' THEN m.amount ELSE -m.amount END), 0)::bigint
      INTO v_settled
      FROM public.poker_diamond_movements m
      JOIN public.poker_diamond_custody c ON c.id = m.custody_id
     WHERE m.user_id = v_user AND c.state = 'released';

    -- 1. Every movement's wallet journal row exists and carries the right
    --    amount: reserve debits the wallet, release credits it.
    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', m.custody_id,
               'request_id', m.request_id,
               'reason', CASE
                   WHEN j.id IS NULL THEN 'journal_missing'
                   WHEN m.action = 'reserve' AND j.amount <> -m.amount THEN 'reserve_amount_mismatch'
                   WHEN m.action = 'release' AND j.amount <> m.amount THEN 'release_amount_mismatch'
               END)), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_movements m
      LEFT JOIN public.diamond_transactions j ON j.id = m.wallet_journal_id
     WHERE m.user_id = v_user
       AND m.wallet_journal_id IS NOT NULL
       AND (j.id IS NULL
            OR (m.action = 'reserve' AND j.amount <> -m.amount)
            OR (m.action = 'release' AND j.amount <> m.amount));

    -- 2. Every released session has its release movement.
    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', c.id, 'request_id', NULL, 'reason', 'release_movement_missing')), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_custody c
     WHERE c.user_id = v_user AND c.state = 'released'
       AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_movements m
                        WHERE m.custody_id = c.id AND m.action = 'release');

    -- 3. Every open cash seat's live stack is its custody balance.
    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', c.id, 'request_id', NULL, 'reason', 'seat_stack_drift')), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_custody c
      JOIN public.table_seats s ON s.id = c.seat_id
     WHERE c.user_id = v_user AND c.state = 'active' AND c.purpose = 'cash_seat'
       AND s.left_at IS NULL AND s.stack IS DISTINCT FROM c.balance;

    RETURN jsonb_build_object(
        'user_id',            v_user,
        'sessions',           v_sessions,
        'open_sessions',      v_open,
        'buy_ins',            v_buy_ins,
        'cash_outs',          v_cash_outs,
        'in_play',            v_in_play,
        'net_result_settled', v_settled,
        'unmatched',          v_unmatched,
        'balanced',           jsonb_array_length(v_unmatched) = 0,
        'read_at',            now()
    );
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) IS
  'A player''s Diamond Arena statement: sessions, buy-ins, cash-outs, diamonds in play, the settled net result, and every movement, released session or open seat that does not reconcile. READ ONLY - reports, repairs nothing (10.12); the live paths (fn_poker_diamond_buyin, the top-up, fn_poker_diamond_release) are atomic and settlement-gated. DIAMONDS ONLY. Own-user only unless service_role.';

REVOKE ALL ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) TO authenticated, service_role;

COMMIT;
