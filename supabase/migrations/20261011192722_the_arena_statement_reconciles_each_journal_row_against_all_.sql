-- 20261011192722_the_arena_statement_reconciles_each_journal_row_against_all_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The Diamond Arena statement on the player's wallet told 379 of the 418
-- players who have ever used the arena that lines of their statement "Do Not
-- Reconcile" (3,791 lines, read 2026-10-11 19:30 UTC). Not one diamond was
-- wrong: every wallet balance equals its journal (0 drift), and every journal
-- row equals the sum of the custody legs that point at it (7,209 journal rows,
-- 0 mismatches). The statement was comparing the wrong things.
--
-- fn_diamond_arena_reconciliation matched EACH custody leg to its journal row
-- one-to-one. Since 20261007132503 a journal row records only what moved the
-- wallet, and two lanes legitimately write one journal row for several legs:
--
--   1. A tournament prize. The winner is paid from every entrant's custody, so
--      one arena_withdraw row of 204 is backed by fifteen legs of 14 (each from
--      a different entrant's custody, each owned by that entrant). Every one
--      of those entrants was shown a "release_amount_mismatch" for a payout
--      that was correct, and that was not even theirs. 3,446 of the lines.
--   2. A satellite seat. A prize-bank -> custody reserve and a custody ->
--      custody release net to zero and share a zero-amount journal row. 345
--      of the lines.
--
-- THE FIX AT THE ROOT: a journal row is reconciled against ALL of its legs.
-- For each journal row any of this player's legs point at, the signed sum of
-- every non-house leg that points at it (whoever owns the custody) must equal
-- the row's amount. A leg with no journal row is still journal_missing; a real
-- shortfall or surplus on any row is still reported, with the same reasons the
-- client already words (src/components/wallet/arenaStatementCopy.ts). House
-- legs stay excluded exactly as 20261007132503 decided.
--
-- The index makes "every leg of this journal row" a lookup rather than a scan
-- (19,158 rows, 14 MB when written; it builds in milliseconds). lock_timeout
-- keeps the build from queueing behind a writer.
--
-- The function stays STABLE, SECURITY DEFINER and own-user only (the
-- service_role / auth.uid() gate is unchanged), and it never writes.
--
-- Proven before it was written: the per-journal-row comparison below, run over
-- every arena user on production, reports 0 unmatched lines.
--
-- One transaction (production DDL policy rule 1). Never inside :50-:03 UTC.
--
-- @live-proof: (SELECT position('legs.moved' IN pg_get_functiondef('public.fn_diamond_arena_reconciliation(uuid)'::regprocedure)) > 0)

BEGIN;

SET LOCAL lock_timeout = '5s';

-- The pre-image this file was written against (installed by 20261007132503).
DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_diamond_arena_reconciliation(uuid)'::regprocedure))
       IS DISTINCT FROM '487494d205097fd7dce97a3fc5c96ea0' THEN
    RAISE EXCEPTION 'fn_diamond_arena_reconciliation is not the definition this migration was written against (md5 %). Re-read it and rebase the change.',
      md5(pg_get_functiondef('public.fn_diamond_arena_reconciliation(uuid)'::regprocedure));
  END IF;
END
$pre$;

CREATE INDEX IF NOT EXISTS poker_diamond_movements_wallet_journal
    ON public.poker_diamond_movements (wallet_journal_id)
    WHERE wallet_journal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_diamond_arena_reconciliation(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
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

    SELECT COALESCE(SUM(CASE WHEN m.action = 'release' THEN m.amount ELSE -m.amount END), 0)::bigint
      INTO v_settled
      FROM public.poker_diamond_movements m
      JOIN public.poker_diamond_custody c ON c.id = m.custody_id
     WHERE m.user_id = v_user AND c.state = 'released';

    -- A JOURNAL ROW IS RECONCILED AGAINST ALL OF ITS LEGS (20261011192722).
    -- A house leg has no journal row (20261007132503) and is excluded. Every
    -- other leg points at the journal row that recorded the wallet movement,
    -- and several legs can share one row: a tournament prize is paid from
    -- every entrant's custody in one arena_withdraw row, and a satellite
    -- seat's reserve and release net to one zero row. So the row is compared
    -- with the signed sum of every leg that points at it, whoever owns the
    -- custody; comparing one leg with the whole row reported correct payouts
    -- as mismatches to every entrant who funded them.
    WITH mine AS (
        SELECT m.wallet_journal_id AS journal_id,
               (array_agg(m.custody_id ORDER BY m.created_at, m.request_id))[1] AS custody_id,
               (array_agg(m.request_id ORDER BY m.created_at, m.request_id))[1] AS request_id,
               bool_and(m.action = 'reserve') AS all_reserve
          FROM public.poker_diamond_movements m
         WHERE m.user_id = v_user
           AND m.wallet_journal_id IS NOT NULL
           AND m.destination_account <> 'house'
           AND m.source_account NOT LIKE 'house:%'
         GROUP BY m.wallet_journal_id
    ), legs AS (
        SELECT mine.journal_id,
               SUM(CASE WHEN m.action = 'reserve' THEN -m.amount ELSE m.amount END)::bigint AS moved
          FROM mine
          JOIN public.poker_diamond_movements m ON m.wallet_journal_id = mine.journal_id
         WHERE m.destination_account <> 'house'
           AND m.source_account NOT LIKE 'house:%'
         GROUP BY mine.journal_id
    )
    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', mine.custody_id,
               'request_id', mine.request_id,
               'reason', CASE
                   WHEN j.id IS NULL THEN 'journal_missing'
                   WHEN mine.all_reserve THEN 'reserve_amount_mismatch'
                   ELSE 'release_amount_mismatch'
               END)), v_unmatched)
      INTO v_unmatched
      FROM mine
      JOIN legs ON legs.journal_id = mine.journal_id
      LEFT JOIN public.diamond_transactions j ON j.id = mine.journal_id
     WHERE j.id IS NULL OR j.amount <> legs.moved;

    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', c.id, 'request_id', NULL, 'reason', 'release_movement_missing')), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_custody c
     WHERE c.user_id = v_user AND c.state = 'released'
       AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_movements m
                        WHERE m.custody_id = c.id AND m.action = 'release');

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
$function$;

REVOKE ALL ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) TO authenticated, service_role;

COMMIT;
