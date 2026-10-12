-- 20261007132839_four_retired_spin_entries_return_to_their_chairs.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT HAPPENED (read from rows, 2026-10-07)
--
-- Four three-player chip Spins started between 15:32:50 and 15:33:02 UTC on
-- 2026-10-06. At 15:33:04 a foreign psql session ran the patterned-identity
-- force drain under session_replication_role = replica:
--     UPDATE table_seats ... SET left_at = clock_timestamp(), status = 'left' ...
--     UPDATE tournament_players ... SET status = 'eliminated' ...
-- for the retired fleet cohort. Replica mode switched off
-- zz_stamp_tournament_elimination_sequence, so one paid entrant in each Spin
-- was marked eliminated with NO elimination_sequence, and its chair was
-- closed holding its full starting stack:
--
--   87f6d0ee  10 Chip Spin PLO4            00000000-...-0020  300  seat 3
--   9d4067ab  20 Chip Deep Stack Spin PLO4 00000000-...-0030 1000  seat 2
--   a19b10fe  20 Chip Spin PLO4            00000000-...-0020  300  seat 2
--   a6ae23f9  20 Chip Spin PLO6            00000000-...-0025  300  seat 2
--
-- None of them was ever dealt a card: every table's first hand_history row
-- started after 15:33:04 (15:33:08 to 15:33:19) and names only the other two
-- players. Those two then played heads-up; one busted (sequenced 612600,
-- 612807, 612919, 613492, recorded position 3) and the survivor holds exactly
-- the two stacks that were in play (600, 600, 600, 2000). The retired stack is
-- still on its closed chair. The terminal authority correctly refuses to name
-- a winner while an eliminated row has no sequence (P0404 "no complete durable
-- elimination sequence"), so all four have sat RUNNING for 22 hours.
--
-- THE DECISION (CLAUDE.md 10.9: prefer the witness that was there)
--
-- The engine's own record is that this player never lost a chip: it holds its
-- paid starting stack, was never dealt in, and the heads-up bust was recorded
-- as THIRD place, i.e. with this player still in the field. A platform defect
-- removed it; it did not bust. So the chair is returned with the stack it
-- holds and the game is finished by play, exactly as 62a15104 (resumed 02:06,
-- completed 02:09) and 355408fa (20261007024455, resumed 04:05, completed
-- 04:23) were finished, with their restored retired horses acting normally.
-- Naming the survivor the winner now would decide by fiat a heads-up match
-- (600 v 300, 2000 v 1000) that was never played; refunding would undo a
-- prize pool already drawn and two players' real result. Horses are settled
-- exactly as humans (10.5): a human removed by our defect gets the chair back.
--
-- WHAT THIS DOES, per Spin, in this one transaction
--
-- * takes the seat door's own lock order (fn_ca_lock_tournament_seat_acquisition:
--   settlement lane, admission contract, table cap, daily missions, event row);
-- * asserts the exact preimage above, every id and every number, and that no
--   hand on that table ever named the retired player, and that the event's
--   manager holds a live lease;
-- * returns the roster row to 'playing' (the stamp trigger clears its NULL
--   sequence) and revives the SAME chair through the platform's own seat
--   owner, fn_assign_tournament_player_seat_atomic, under the manager's data
--   authority. That owner refuses any stack that is not the paid starting
--   stack and any total above what was bought in;
-- * asserts the result: two players playing, two live chairs, felt total equal
--   to three starting stacks.
--
-- It moves NO money: no wallet, ledger, journal, Spin receipt, prize or fee
-- row is written. The prize is paid later by the event's own terminal
-- settlement, once, to whoever wins the hand that ends it. The busted player
-- keeps third. Closed profiles stay closed. Proved in a self-aborting DO
-- block against production at 13:28 UTC on 2026-10-07 (all four restored,
-- felt 900/3000/900/900, rolled back).
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $four_spins$
DECLARE
  c record;
  gate jsonb;
  res jsonb;
  lease public.engine_tournament_leases;
  old_actor text := current_setting('app.smarter_data_actor', true);
  old_generation text := current_setting('app.smarter_data_generation', true);
  n integer;
  felt numeric;
BEGIN
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'FOUR_SPINS_FROZEN: the platform is frozen; apply after the thaw' USING ERRCODE = '55000';
  END IF;

  FOR c IN
    SELECT * FROM (VALUES
      ('87f6d0ee-0e7b-4921-87f4-b481f43973b1'::uuid, '296458b1-0496-4904-9885-e3977abb02e7'::uuid, 30.00::numeric,
       'aad7503a-225a-4272-be7f-67fa20653907'::uuid, '00000000-0000-0000-0000-000000000020'::uuid, 3, 300::numeric, '4405218a-e36b-4f96-9f99-bbfdd55b3599'::uuid,
       '062abb12-430f-459a-999c-13215d930924'::uuid, 612919::bigint,
       '6cbc5f45-eb26-48f5-8e69-014b0a02ca88'::uuid, 'e3de3379-8dd7-40a1-91ff-ec7d8c2d62b2'::uuid),
      ('9d4067ab-162d-4208-8595-8120c3d08873', '9abe58f4-4590-4eda-98f7-fe06e8f8941e', 40.00,
       '44704e27-6bc3-4909-9619-04a3a3de61ff', '00000000-0000-0000-0000-000000000030', 2, 1000, '0478453b-1787-4ba3-b4a1-1a62e652f29e',
       '5cda22e2-1949-40bc-ab4b-c40927cc4838', 613492,
       '3789b5ad-0c2a-4298-a9a6-5a51e8872dc3', '3294d42f-f69f-407d-a665-086c6979dca8'),
      ('a19b10fe-4192-41ba-9b2a-7ef9ac70d23f', '0e7e0302-e92d-4cc4-b467-eed79288deac', 40.00,
       '2127bdf2-920d-496b-b8e5-92dd43746747', '00000000-0000-0000-0000-000000000020', 2, 300, '693dbf60-d78a-4474-995d-5efa819c360b',
       '764a2157-dc50-44f3-a8ad-2e473e84e68d', 612600,
       '715c7928-c0d4-4efc-a204-7ec3324c2ac2', 'd3f29e87-4bd3-42d3-8ff1-f29eaeb09d53'),
      ('a6ae23f9-81a4-4121-a942-1fec54923e66', '9eb90845-15f5-46cc-9674-563f69554926', 40.00,
       'd99385e5-9293-4744-ac46-4492e1e7122d', '00000000-0000-0000-0000-000000000025', 2, 300, '978031fb-b732-4603-908a-810ba4acc886',
       'dc711406-e290-4077-80cf-e7ae934c6e2d', 612807,
       'd3bca1cb-2a6a-4f7a-8856-dcde57363f1e', 'ccd0b9bf-b771-476e-8232-ca4f3e2cc114')
    ) v(tid, tbl, prize, r_roster, r_user, r_seat_no, start_stack, r_seat,
        bust_roster, bust_seq, surv_roster, surv_seat)
    ORDER BY tid
  LOOP
    -- The seat door's own lock order, before any row this transaction changes.
    gate := public.fn_ca_lock_tournament_seat_acquisition(c.tid, c.tbl, c.r_user);
    IF gate->>'ok' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'FOUR_SPINS_SEAT_DOOR_REFUSED %: %', c.tid, gate USING ERRCODE = '55000';
    END IF;

    SELECT * INTO lease FROM public.engine_tournament_leases WHERE tournament_id = c.tid FOR UPDATE;
    IF NOT FOUND OR lease.protocol_version IS DISTINCT FROM 2 OR lease.lease_generation IS NULL
       OR nullif(lease.instance_id, '') IS NULL OR lease.heartbeat_at IS NULL
       OR lease.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
      RAISE EXCEPTION 'FOUR_SPINS_LEASE_REFUSED %', c.tid USING ERRCODE = '55000';
    END IF;

    -- The event: still the running, drawn, unpaid Spin it was.
    IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = c.tid
        AND t.status = 'RUNNING' AND t.variant = 'spin' AND t.max_players = 3
        AND t.starting_chips = c.start_stack AND t.prize_pool = c.prize
        AND t.prize_pool_finalized AND t.ended_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id = c.tid)
       OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id = c.tid) <> 3 THEN
      RAISE EXCEPTION 'FOUR_SPINS_EVENT_CHANGED %', c.tid USING ERRCODE = '55000';
    END IF;

    -- The retired entrant: unsequenced, holding its paid stack, removed at 15:33:04.
    IF NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.id = c.r_roster
        AND tp.tournament_id = c.tid AND tp.user_id = c.r_user AND tp.status = 'eliminated'
        AND tp.elimination_sequence IS NULL AND tp.position IS NULL AND tp.chips = c.start_stack
        AND tp.table_id = c.tbl AND tp.seat_number = c.r_seat_no
        AND tp.eliminated_at >= '2026-10-06 15:33:04+00' AND tp.eliminated_at < '2026-10-06 15:33:05+00')
       OR NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.id = c.r_seat
        AND s.table_id = c.tbl AND s.user_id = c.r_user AND s.seat_number = c.r_seat_no
        AND s.stack = c.start_stack AND s.status = 'left'
        AND s.left_at >= '2026-10-06 15:33:04+00' AND s.left_at < '2026-10-06 15:33:05+00')
       OR NOT EXISTS (SELECT 1 FROM smarter_private.patterned_identity_retirements r
        WHERE r.old_id = c.r_user AND r.cohort = 'horse' AND r.replacement_horse_id IS NULL) THEN
      RAISE EXCEPTION 'FOUR_SPINS_RETIRED_ENTRY_CHANGED %', c.tid USING ERRCODE = '55000';
    END IF;

    -- Never dealt a card: no hand on this table names the retired player.
    IF EXISTS (SELECT 1 FROM public.hand_history h
               WHERE h.table_id = c.tbl AND h.players::text LIKE '%' || c.r_user::text || '%')
       OR EXISTS (SELECT 1 FROM smarter_private.hand_submissions s
               WHERE s.table_id = c.tbl AND s.request::text LIKE '%' || c.r_user::text || '%') THEN
      RAISE EXCEPTION 'FOUR_SPINS_RETIRED_ENTRY_WAS_DEALT %', c.tid USING ERRCODE = '55000';
    END IF;

    -- The heads-up bust keeps its witnessed third place; the survivor holds
    -- exactly the two stacks that were in play, on the only live chair.
    IF NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.id = c.bust_roster
        AND tp.tournament_id = c.tid AND tp.status = 'eliminated'
        AND tp.elimination_sequence = c.bust_seq AND tp.position = 3 AND tp.chips = 0)
       OR NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.id = c.surv_roster
        AND tp.tournament_id = c.tid AND tp.status = 'playing' AND tp.chips = 2 * c.start_stack)
       OR NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.id = c.surv_seat
        AND s.table_id = c.tbl AND s.left_at IS NULL AND s.stack = 2 * c.start_stack)
       OR (SELECT count(*) FROM public.table_seats s WHERE s.table_id = c.tbl AND s.left_at IS NULL) <> 1 THEN
      RAISE EXCEPTION 'FOUR_SPINS_FIELD_CHANGED %', c.tid USING ERRCODE = '55000';
    END IF;

    PERFORM set_config('app.smarter_data_actor', lease.instance_id, true);
    PERFORM set_config('app.smarter_data_generation', lease.lease_generation::text, true);

    UPDATE public.tournament_players SET status = 'playing', eliminated_at = NULL
     WHERE id = c.r_roster AND status = 'eliminated' AND elimination_sequence IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
      RAISE EXCEPTION 'FOUR_SPINS_ROSTER_RACE %', c.tid USING ERRCODE = '40001';
    END IF;

    res := public.fn_assign_tournament_player_seat_atomic(c.tid, c.r_user, c.tbl, c.r_seat_no);
    IF res->>'ok' IS DISTINCT FROM 'true' OR res->>'replayed' IS DISTINCT FROM 'false'
       OR (res->>'stack')::numeric <> c.start_stack OR (res->>'seat_id')::uuid <> c.r_seat THEN
      RAISE EXCEPTION 'FOUR_SPINS_NATIVE_ASSIGNMENT_REFUSED % %', c.tid, res USING ERRCODE = 'P0404';
    END IF;

    PERFORM set_config('app.smarter_data_actor', coalesce(old_actor, ''), true);
    PERFORM set_config('app.smarter_data_generation', coalesce(old_generation, ''), true);

    SELECT count(*), coalesce(sum(s.stack), 0) INTO n, felt
      FROM public.table_seats s WHERE s.table_id = c.tbl AND s.left_at IS NULL;
    IF n <> 2 OR felt <> 3 * c.start_stack
       OR (SELECT count(*) FROM public.tournament_players
            WHERE tournament_id = c.tid AND status = 'playing') <> 2 THEN
      RAISE EXCEPTION 'FOUR_SPINS_FINAL_CUSTODY_REFUSED % (% chairs, felt %)', c.tid, n, felt USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'FOUR_SPINS_RESTORED % %', c.tid, res;
  END LOOP;
END
$four_spins$;

-- @live-proof: NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id IN ('87f6d0ee-0e7b-4921-87f4-b481f43973b1','9d4067ab-162d-4208-8595-8120c3d08873','a19b10fe-4192-41ba-9b2a-7ef9ac70d23f','a6ae23f9-81a4-4121-a942-1fec54923e66') AND status = 'eliminated' AND elimination_sequence IS NULL)

COMMIT;
