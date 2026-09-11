-- three_money_doors_are_audited_and_registered
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- fn_ca_money_rpc_drift raises one incident per function that writes a balance
-- column and is not in ca_money_rpc_registry. Three have been open since 05:25
-- (four occurrences each). The detector is right that they are unregistered;
-- registering them is not a formality, it is the audit written down, so here is
-- the audit.
--
-- 1. fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)
--    The seat-move door the engine calls to consolidate tables. SECURITY
--    DEFINER and refuses anything but service authority (28000). It CANNOT
--    mint or destroy a chip: the destination seat is written with
--    `stack = v_source.stack` - the source row's own value, carried verbatim -
--    and the source seat is closed in the same transaction. Before it writes it
--    proves the event is RUNNING, both tables belong to it, the roster row is
--    exact, there is EXACTLY ONE live source seat whose chips and coordinates
--    match what the caller claimed (P0404 otherwise), and the destination seat
--    and roster slot are free (23505). Every move leaves an idempotent receipt
--    in tournament_seat_move_receipts keyed by request_id, and a request id
--    already used by another operation is refused. Registered: approved.
--
-- 2. fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)
--    The diamond cash-hand settlement. Engine-only, asserts the roster is
--    exact, refuses a hand whose amounts do not balance
--    (`diamond_hand_does_not_conserve`, 23514), refuses a stale seat generation
--    and a custody total that disagrees with the felt, and writes one
--    poker_diamond_hand_receipts row per hand. Diamonds are their own currency
--    with their own custody ledger; this door is what moves them between seats.
--    Registered: approved.
--
-- 3. fn_poker_diamond_cashout(uuid,uuid,integer)
--    The diamond seat cash-out. Engine-only (42501), requires a diamond cash
--    table, requires custody to match before it releases, requires the seat to
--    be vacated, and verifies the release before it returns
--    (`diamond_cashout_release_not_verified`). Writes seat_cashout_receipts.
--    Registered: approved.
--
-- None of the three is new behaviour and none of them was found doing anything
-- wrong; they are doors that were built and never entered in the register the
-- detector reads. The incidents close with that as their cause.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_missing text;
  v_rows integer;
BEGIN
  -- every function named here must exist, or the register would be describing
  -- something that is not there
  SELECT string_agg(want.proname, ', ') INTO v_missing
    FROM (VALUES ('fn_move_tournament_player'),
                 ('fn_poker_diamond_settle_cash_hand'),
                 ('fn_poker_diamond_cashout')) AS want(proname)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = want.proname);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'cannot register a door that does not exist: %', v_missing;
  END IF;

  INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
    ('fn_move_tournament_player', 'approved',
     'Tournament seat move. Service authority only. Carries the source seat''s own stack to the destination verbatim and closes the source in the same transaction, so it cannot mint or destroy; proves exactly one live source seat with exact chips and coordinates first, refuses an occupied destination, and writes an idempotent tournament_seat_move_receipts row keyed by request_id. Audited 2026-09-10 (incident 3058a1a5).'),
    ('fn_poker_diamond_settle_cash_hand', 'approved',
     'Diamond cash-hand settlement. Engine only. Refuses a hand that does not conserve (diamond_hand_does_not_conserve), a stale seat generation, an inexact roster or a custody total that disagrees with the felt; writes one poker_diamond_hand_receipts row per hand. Audited 2026-09-10 (incident 4d46ff46).'),
    ('fn_poker_diamond_cashout', 'approved',
     'Diamond seat cash-out. Engine only. Requires a diamond cash table, matching custody and a vacated seat, verifies the release before returning (diamond_cashout_release_not_verified), and writes seat_cashout_receipts. Audited 2026-09-10 (incident 353b5ddb).')
  ON CONFLICT (proname) DO UPDATE
    SET status = EXCLUDED.status, notes = EXCLUDED.notes;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 3 THEN
    RAISE EXCEPTION 'expected to register 3 doors, registered %', v_rows;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'Three functions that write a balance column had never been entered in ca_money_rpc_registry, which is the list fn_ca_money_rpc_drift compares against: fn_move_tournament_player (the seat-move door applied as 20260910051447), fn_poker_diamond_settle_cash_hand and fn_poker_diamond_cashout (the diamond currency''s hand and cash-out doors). The detector was correct and the doors were not defective.',
         correction_ref = 'migration three_money_doors_are_audited_and_registered',
         resolution = 'All three audited and registered as approved, with the audit written into the registry notes and the migration header: the seat move carries the source stack verbatim and closes the source in the same transaction, and both diamond doors are engine-only, assert conservation and custody, and write their own receipts.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_money_rpc_drift';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 3 THEN
    RAISE EXCEPTION 'expected to resolve 3 money-rpc-drift incidents, resolved %', v_rows;
  END IF;
END
$body$;

COMMIT;
