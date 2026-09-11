-- 2026-09-11-c1f15c30-keeps-the-ladder-it-paid.sql
--
-- RULING (CLAUDE.md 10.9). Applied by the orchestrator as ONE transaction,
-- outside the :50-:03 UTC window, once. Any guard failure aborts with nothing
-- written. No money moves in this transaction.
--
-- WHAT HAPPENED. Breakfast Turbo c1f15c30 (40 entrants, pool 180.00 locked,
-- guarantee 150.00, no bubble protection) was dealt with its row still
-- REGISTERING. Places 6..2 were paid 2026-09-08 14:35-14:36 and place 1 at
-- 14:53:51, every one against the six-place ladder fitted at entry close:
--   32.53 / 23.42 / 16.86 / 12.14 / 8.74 / 6.31
--   = 58.55 / 42.16 / 30.35 / 21.85 / 15.73 / 11.36 = 180.00 (escrow prize
--   balance 0.00, six tournament_payouts rows, six settled place obligations).
-- The REGISTERING -> COMPLETING relabel at 14:53:50 fired
-- zz_ca_fund_overlay_on_lock, which wrote a four-place ladder
-- (43.12 / 24.76 / 17.90 / 14.22) over the paid one. fn_settle_tournament_places
-- derives its ladder from payout_structure, finds place obligations 5 and 6
-- outside it and has refused the event ever since:
--   [GameServer.recoverStuckCompleting_terminal_refused] TerminalSettlementRefusedError:
--   tournament c1f15c30-... has a place obligation outside its derived ladder
-- (121 refusals in the 10:55-11:56 engine hour). The trigger defect is fixed on
-- fix/late-status-flip-keeps-paid-ladder; this ruling is the one-off it leaves.
--
-- RULING. The ladder the event paid is its ladder. Restore payout_structure to
-- that six-place ladder and nothing else. The engine's recoverStuckCompleting
-- then completes the event through fn_complete_tournament_terminal: every place
-- obligation sits inside the derived ladder at exactly its paid amount, so the
-- terminal authority owes and pays nothing new. Nobody is underpaid (the four-
-- place amounts were never the contract), nothing is clawed back.
--   1 mhalloran  5a0cd7e0 58.55 | 2 wokafor 42.16 | 3 Rebuy23 30.35
--   4 GusI 21.85 | 5 SadGoat 15.73 | 6 rhale 11.36
--
-- REHEARSED on a local PostgreSQL 17 with the production body of
-- fn_ca_tournament_place_amounts and this event's tournament, roster and
-- obligation rows: before 77.62/44.57/32.22/25.59 (what production derives
-- today); after 58.55/42.16/30.35/21.85/15.73/11.36, equal to all six paid
-- obligations, sum 180.00. This whole script also ran end to end there against
-- copies of the event's tournament, roster, obligation, payout and escrow rows
-- (guards pass, one row updated, post-check passes, a second run refuses); the
-- managed-game guard trigger was not present locally. The terminal completion itself (engine path) was
-- NOT rehearsed; if it refuses for another reason it writes nothing and the
-- engine logs the new reason under the same tag.

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $pre$
DECLARE
  c_id constant uuid := 'c1f15c30-33c4-4a64-85ac-44037519ca5b';
  v_t record;
  v_n integer;
  v_sum numeric;
BEGIN
  SELECT t.status, t.prize_pool, t.prize_pool_finalized, t.bubble_protection,
         t.payout_structure
    INTO v_t FROM public.tournaments t WHERE t.id = c_id FOR UPDATE;
  IF NOT FOUND
     OR v_t.status <> 'COMPLETING'
     OR v_t.prize_pool IS DISTINCT FROM 180.00
     OR v_t.prize_pool_finalized IS NOT TRUE
     OR COALESCE(v_t.bubble_protection, false)
     OR v_t.payout_structure IS DISTINCT FROM
        '[{"place": 1, "percentage": 43.1200000000000000}, {"place": 2, "percentage": 24.7600000000000000}, {"place": 3, "percentage": 17.9000000000000000}, {"place": 4, "percentage": 14.2200000000000000}]'
  THEN
    RAISE EXCEPTION 'c1f15c30 is not in the expected state: %', row_to_json(v_t);
  END IF;

  SELECT count(*) INTO v_n FROM public.tournament_obligations o WHERE o.tournament_id = c_id;
  IF v_n <> 6 THEN RAISE EXCEPTION 'expected 6 obligations, found %', v_n; END IF;
  SELECT count(*) INTO v_n
    FROM public.tournament_obligations o
    JOIN (VALUES
      (1, '5a0cd7e0-174a-466f-ba1d-6d2c80d9252a'::uuid, 58.55),
      (2, 'face0000-0000-0000-0000-000000000001'::uuid, 42.16),
      (3, '57d5af45-0b1c-417c-bc41-64ca9fd1b4b9'::uuid, 30.35),
      (4, '1e6efb0b-61f4-4303-9ee8-1569fbf50cbd'::uuid, 21.85),
      (5, '00000000-0000-0000-0000-000000000006'::uuid, 15.73),
      (6, 'e7925474-ad31-4cfb-826b-010039bcff3d'::uuid, 11.36)) e(place, user_id, amount)
      ON e.place = o.place AND e.user_id = o.user_id
     AND o.amount_owed = e.amount AND o.amount_paid = e.amount
   WHERE o.tournament_id = c_id AND o.kind = 'place' AND o.settled_at IS NOT NULL;
  IF v_n <> 6 THEN RAISE EXCEPTION 'place obligations moved: % of 6 match', v_n; END IF;

  SELECT count(*), sum(p.amount) INTO v_n, v_sum
    FROM public.tournament_payouts p WHERE p.tournament_id = c_id;
  IF v_n <> 6 OR v_sum IS DISTINCT FROM 180.00 THEN
    RAISE EXCEPTION 'payouts moved: % rows, %', v_n, v_sum;
  END IF;

  SELECT count(*) INTO v_n FROM public.tournament_players tp
   WHERE tp.tournament_id = c_id AND tp.status = 'winner' AND tp.position = 1
     AND tp.user_id = '5a0cd7e0-174a-466f-ba1d-6d2c80d9252a';
  IF v_n <> 1 THEN RAISE EXCEPTION 'winner row moved'; END IF;
  SELECT count(*) INTO v_n FROM public.tournament_players tp
   WHERE tp.tournament_id = c_id AND tp.status = 'eliminated'
     AND tp.elimination_sequence IS NOT NULL AND tp.position = 41 - tp.elimination_sequence;
  IF v_n <> 39 THEN RAISE EXCEPTION 'roster moved: % of 39 eliminated rows as recorded', v_n; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tournament_escrow e
                  WHERE e.tournament_id = c_id AND e.prize_balance = 0.00
                    AND e.closed_at IS NULL) THEN
    RAISE EXCEPTION 'escrow moved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s WHERE s.tournament_id = c_id) THEN
    RAISE EXCEPTION 'a terminal settlement already exists';
  END IF;
END
$pre$;

-- fn_guard_managed_game_lifecycle protects payout_structure from non-engine
-- writers once a player has registered; this ruling writes as the engine role.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

DO $write$
DECLARE v_n integer;
BEGIN
  UPDATE public.tournaments
     SET payout_structure =
       '[{"place":1,"percentage":32.53},{"place":2,"percentage":23.42},{"place":3,"percentage":16.86},{"place":4,"percentage":12.14},{"place":5,"percentage":8.74},{"place":6,"percentage":6.31}]'
   WHERE id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b'
     AND status = 'COMPLETING'
     AND payout_structure =
       '[{"place": 1, "percentage": 43.1200000000000000}, {"place": 2, "percentage": 24.7600000000000000}, {"place": 3, "percentage": 17.9000000000000000}, {"place": 4, "percentage": 14.2200000000000000}]';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 row, updated %', v_n; END IF;
END
$write$;

DO $post$
DECLARE v_n integer;
BEGIN
  -- the derived ladder is now exactly the paid obligations (this reader takes
  -- FOR UPDATE on the row this transaction already holds; it writes nothing)
  SELECT count(*) INTO v_n
    FROM public.fn_ca_tournament_place_amounts('c1f15c30-33c4-4a64-85ac-44037519ca5b') a
    JOIN public.tournament_obligations o
      ON o.tournament_id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b'
     AND o.kind = 'place' AND o.place = a.place AND o.amount_paid = a.amount;
  IF v_n <> 6 OR (SELECT count(*) FROM public.fn_ca_tournament_place_amounts(
                    'c1f15c30-33c4-4a64-85ac-44037519ca5b')) <> 6 THEN
    RAISE EXCEPTION 'derived ladder does not equal the paid obligations (% of 6)', v_n;
  END IF;
END
$post$;

COMMIT;

-- AFTER (read-only, give the engine one or two minutes):
--   select status, ended_at from tournaments where id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b';  -- COMPLETED
--   select count(*) from tournament_terminal_settlements where tournament_id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b';  -- 1
--   select count(*), sum(amount) from chip_ledger where tournament_id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b'
--    and category = 'tournament_prize';  -- still 6 / 180.00: nothing new paid
--   engine: no further recoverStuckCompleting_terminal_refused for c1f15c30
