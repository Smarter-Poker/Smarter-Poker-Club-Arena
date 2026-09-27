-- 20260927225423_the_pending_busts_of_three_frozen_freerolls_are_recorded_thr.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE PENDING BUSTS OF THREE FROZEN FREEROLLS ARE RECORDED THROUGH THE DOOR
-- ===========================================================================
--
-- Read from production 2026-09-27 22:20 to 22:55 UTC. Three RUNNING MTTs held
-- by the live engine (lease 1-95542fcc, heartbeat fresh) stopped dealing hours
-- ago with every open table holding exactly one player and all the chips:
--
--   618741a5 "$100 Freeroll 12:00 PM"   38 tables / 38 seats / 38 lone,
--     roster status='playing' 250, of which 212 hold NO seat and 0 chips;
--     last hand 20:12 UTC; 2,265,000 chips on the felt = 341 x 5,000 + 56
--     add-ons x 10,000, conserved to the chip.
--   ac10f59a "$100 Freeroll 6:00 AM"    37 / 37 / 37 lone, playing 133,
--     96 seatless at 0 chips, last hand 20:27 UTC, 1,735,000 chips.
--   c775d008 "Morning Free Buy (NLH)"   35 / 38 seats (34 lone + one table
--     of 4), playing 137, 99 seatless at 0 chips, last hand 16:27 UTC,
--     977,000 chips.
--
-- Every seatless 'playing' row is a bust the engine already settled: the
-- player's seat row reads stack 0 with left_at stamped at the bust, and a
-- tournament_knockout_candidates row of theirs is 'pending' (213 / 96 / 100
-- when read; the manager records about one per admission). The manager's
-- elimination sweep is the only thing that turns that row into
-- status='eliminated', and it is starved: the one process-wide elimination
-- scheduler has 317 managers registered, 275 queued, all 4 slots busy and an
-- oldest wait of 333 s (Prometheus 22:44 UTC), so a large MTT is admitted
-- about every six minutes, and inside that admission the reads that prepare
-- the batch spend the 5 s budget and the 5 s grace buys one commit
-- (`Tournament.bust_mutation_grace_granted` five times for 618741a5 in 80
-- minutes, one `Eliminated:` line each). Recording stopped keeping up at
-- 18:41, 13:43 and 14:29 UTC respectively while the tables kept dealing.
--
-- Why that froze the felt: the balancer's planner treats a roster chair whose
-- tournament_players row is still 'playing' as reserved (loadBalancerTables,
-- mirroring fn_move_tournament_player's "destination roster is occupied"),
-- so with 212 unrecorded busts every empty chair at every table reads as
-- taken, breakTable can place nobody, no table is ever consolidated, each
-- table drains to its last player, and a table of one cannot deal. The five
-- parks the balancer did request while a chair was briefly free
-- (f06_operations park_requested, revision 0, no custody) cannot readmit their
-- source either: fn_f06_admit_parked_movement -> f06_movement_prior refuses
-- F06_MOVEMENT_ELIMINATION_UNPROVEN for the same unrecorded busts (probed
-- 22:38 UTC, rolled back); the engine reports it only as
-- f06_movement_admission_unproven.
--
-- WHAT THIS DOES. For each of the three events it records every pending bust
-- through the platform's own door, public.fn_eliminate_tournament_player_atomic,
-- exactly as the sweep does: latest knockout generation per player, hand order
-- (hand_number, then hand-start stack, then user id), places handed out from
-- the sweep's own ladder seed max(unplaced, playing, n + 1) walking down over
-- the places already taken, prize 0 - and it REFUSES to price a place inside
-- the paid structure (35 / 35 / 31 places), so no money can be decided here.
-- The door proves each bust from its candidate, atomic commit and settlement
-- receipt, stamps eliminated_at with the bust hand's commit time, releases
-- only that player's own (already left) seat, and writes no wallet or ledger
-- row; positions are provisional and fn_settle_tournament_places re-ranks by
-- hand commit time at the finish. Nobody is paid, nobody is clawed back.
--
-- PROVEN FIRST, ROLLED BACK (CLAUDE.md 11.5, psql, one DO block ending in
-- RAISE EXCEPTION, 22:51 to 22:54 UTC):
--   618741a5 paid_places=35 unplaced=250 playing=250 pending=212 accepted=212
--     places=248..37 refused=0 chips 2,265,000 -> 2,265,000 ledger rows 57 -> 57
--     zero-chip seatless playing left 0, 11.8 s
--   ac10f59a paid_places=35 unplaced=133 playing=133 pending=96 accepted=96
--     places=133..38 refused=0 chips 1,735,000 -> 1,735,000 ledger 1 -> 1, 4.8 s
--   c775d008 paid_places=31 unplaced=137 playing=137 pending=99 accepted=99
--     places=137..39 refused=0 chips 977,000 -> 977,000 ledger 6 -> 6, 5.0 s
--
-- The migration asserts the same things at apply time and aborts whole if any
-- of them fails: the door is the definition that was probed (md5 of both
-- bodies), every recorded place is outside the paid structure, the door
-- accepted every pending bust it was shown (a refusal names the player and
-- the reason), the live chip total and chip_ledger row count of the event are
-- unchanged, and no zero-chip seatless 'playing' row remains. An event that
-- is no longer RUNNING, or has nothing pending because the sweep got there
-- first, is skipped with a notice: the migration is idempotent. No DDL, so
-- no PostgREST reload; the door's own settlement lane serializes it against
-- the live manager, whose next sweep finds these players already recorded.
--
-- The engine half of this fix (the sweep commits the batch it prepared; the
-- movement admission names the door's refusal) is in the same pull request.
-- Changelog: docs/changelog/2026-09-27-a-prepared-bust-batch-is-recorded.md
--
-- Live proof: no registration of the three events is left playing at 0 chips
-- with no seat of that event (205 / 88 / 91 such rows when this was written).
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id IN ('618741a5-2c39-4eee-9281-3de641780b8c','ac10f59a-522b-49b2-ada6-ccd42759fb91','c775d008-a0cf-4405-bb47-799006fcc7cc') AND tp.status = 'playing' AND COALESCE(tp.chips, 0) <= 0 AND NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id WHERE t.tournament_id = tp.tournament_id AND s.user_id = tp.user_id AND s.left_at IS NULL))

BEGIN;
SET LOCAL lock_timeout = '5s';
-- 407 door calls measured at 11.8 + 4.8 + 5.0 s in the rolled-back probes;
-- a role default of 8 s would cut the first event short.
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure)
     IS DISTINCT FROM '494f2625596282df019df77cf94649fc' THEN
    RAISE EXCEPTION 'PREIMAGE: fn_eliminate_tournament_player_atomic is not the door probed 2026-09-27 22:51 UTC';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure)
     IS DISTINCT FROM 'a4d2d589200bc41bab9a015ea0e7bdfb' THEN
    RAISE EXCEPTION 'PREIMAGE: fn_eliminate_player_legacy_candidate_20260907 is not the definition probed 2026-09-27 22:51 UTC';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: apply this outside the maintenance freeze' USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $settle$
DECLARE
  v_events uuid[] := ARRAY[
    '618741a5-2c39-4eee-9281-3de641780b8c'::uuid,  -- $100 Freeroll 12:00 PM (2026-09-27 17:00 UTC)
    'ac10f59a-522b-49b2-ada6-ccd42759fb91'::uuid,  -- $100 Freeroll 6:00 AM  (2026-09-27 11:00 UTC)
    'c775d008-a0cf-4405-bb47-799006fcc7cc'::uuid   -- Morning Free Buy (NLH) (2026-09-27 13:00 UTC)
  ];
  v_tid uuid;
  v_status text;
  v_paid integer;
  v_unplaced integer;
  v_playing integer;
  v_n integer;
  v_next integer;
  v_place integer;
  v_taken integer[];
  v_accepted integer;
  v_first_place integer;
  v_last_place integer;
  v_chips_before numeric;
  v_chips_after numeric;
  v_ledger_before bigint;
  v_ledger_after bigint;
  v_left integer;
  v_r jsonb;
  r record;
BEGIN
  CREATE TEMP TABLE pg_temp.mttf_pending_busts (
    user_id uuid NOT NULL,
    hand_number bigint NOT NULL,
    stack_before numeric
  ) ON COMMIT DROP;

  FOREACH v_tid IN ARRAY v_events LOOP
    SELECT status, jsonb_array_length(payout_structure::jsonb)
      INTO v_status, v_paid
      FROM public.tournaments WHERE id = v_tid FOR UPDATE;
    IF v_status IS DISTINCT FROM 'RUNNING' THEN
      RAISE NOTICE 'mtt-freeze % skipped: status is %, nothing to record', left(v_tid::text, 8), COALESCE(v_status, 'missing');
      CONTINUE;
    END IF;
    IF v_paid IS NULL OR v_paid < 1 THEN
      RAISE EXCEPTION 'mtt-freeze %: payout structure unreadable, refusing to decide any place', left(v_tid::text, 8);
    END IF;

    SELECT COALESCE(sum(s.stack), 0) INTO v_chips_before
      FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
     WHERE t.tournament_id = v_tid AND s.left_at IS NULL;
    SELECT count(*) INTO v_ledger_before FROM public.chip_ledger WHERE tournament_id = v_tid;
    SELECT count(*) FILTER (WHERE position IS NULL), count(*) FILTER (WHERE status = 'playing')
      INTO v_unplaced, v_playing
      FROM public.tournament_players WHERE tournament_id = v_tid;
    SELECT COALESCE(array_agg(position), '{}') INTO v_taken
      FROM public.tournament_players WHERE tournament_id = v_tid AND position IS NOT NULL;

    -- The busts the sweep has not recorded: playing at 0 chips, holding no
    -- live seat of this event, ranked by the latest knockout generation.
    -- Every row of the scratch table belongs to the previous event of this
    -- loop; the predicate is written out for the unqualified-write check.
    DELETE FROM pg_temp.mttf_pending_busts WHERE user_id IS NOT NULL;
    INSERT INTO pg_temp.mttf_pending_busts (user_id, hand_number, stack_before)
    SELECT tp.user_id, k.hand_number, k.stack_before
      FROM public.tournament_players tp
      JOIN LATERAL (
        SELECT c.hand_number, c.stack_before
          FROM public.tournament_knockout_candidates c
         WHERE c.tournament_id = tp.tournament_id AND c.eliminated_user_id = tp.user_id
         ORDER BY c.hand_number DESC, c.id DESC LIMIT 1) k ON true
     WHERE tp.tournament_id = v_tid AND tp.status = 'playing' AND COALESCE(tp.chips, 0) <= 0
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                        WHERE t.tournament_id = v_tid AND s.user_id = tp.user_id AND s.left_at IS NULL);
    SELECT count(*) INTO v_n FROM pg_temp.mttf_pending_busts;
    IF v_n = 0 THEN
      RAISE NOTICE 'mtt-freeze % skipped: no pending bust left to record', left(v_tid::text, 8);
      CONTINUE;
    END IF;

    v_accepted := 0; v_first_place := NULL; v_last_place := NULL;
    -- The sweep's ladder seed; place 1 is never handed out here.
    v_next := GREATEST(v_unplaced, v_playing, v_n + 1);
    FOR r IN SELECT * FROM pg_temp.mttf_pending_busts ORDER BY hand_number, stack_before, user_id LOOP
      v_place := v_next;
      WHILE v_place >= 2 AND v_place = ANY(v_taken) LOOP v_place := v_place - 1; END LOOP;
      IF v_place < 2 THEN
        RAISE EXCEPTION 'mtt-freeze %: finishing ladder exhausted at seed % after % accepted', left(v_tid::text, 8), v_next, v_accepted;
      END IF;
      IF v_place <= v_paid THEN
        RAISE EXCEPTION 'mtt-freeze %: place % is inside the paid structure (% places); this migration prices no money', left(v_tid::text, 8), v_place, v_paid;
      END IF;
      v_r := public.fn_eliminate_tournament_player_atomic(v_tid, r.user_id, v_place, 0, 0);
      IF NOT (COALESCE((v_r->>'ok')::boolean, false) AND COALESCE((v_r->>'claimed')::boolean, false)) THEN
        RAISE EXCEPTION 'mtt-freeze %: the door refused % at place %: %', left(v_tid::text, 8), left(r.user_id::text, 8), v_place, v_r::text;
      END IF;
      v_accepted := v_accepted + 1;
      v_taken := v_taken || v_place;
      v_first_place := COALESCE(v_first_place, v_place);
      v_last_place := v_place;
      v_next := LEAST(v_next, v_place) - 1;
    END LOOP;

    SELECT COALESCE(sum(s.stack), 0) INTO v_chips_after
      FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
     WHERE t.tournament_id = v_tid AND s.left_at IS NULL;
    SELECT count(*) INTO v_ledger_after FROM public.chip_ledger WHERE tournament_id = v_tid;
    SELECT count(*) INTO v_left
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_tid AND tp.status = 'playing' AND COALESCE(tp.chips, 0) <= 0
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                        WHERE t.tournament_id = v_tid AND s.user_id = tp.user_id AND s.left_at IS NULL);
    IF v_accepted <> v_n OR v_chips_after IS DISTINCT FROM v_chips_before
       OR v_ledger_after <> v_ledger_before OR v_left <> 0 THEN
      RAISE EXCEPTION 'mtt-freeze %: post-image changed (accepted % of %, chips % -> %, ledger % -> %, left %)',
        left(v_tid::text, 8), v_accepted, v_n, v_chips_before, v_chips_after, v_ledger_before, v_ledger_after, v_left;
    END IF;
    IF EXISTS (SELECT 1 FROM public.tournament_players
                WHERE tournament_id = v_tid AND status = 'eliminated' AND position > v_paid AND COALESCE(prize, 0) <> 0) THEN
      RAISE EXCEPTION 'mtt-freeze %: an unpaid place carries a prize', left(v_tid::text, 8);
    END IF;
    RAISE NOTICE 'mtt-freeze % recorded % pending bust(s) at places %..% (paid structure %); chips % unchanged; ledger rows % unchanged',
      left(v_tid::text, 8), v_accepted, v_first_place, v_last_place, v_paid, v_chips_after, v_ledger_after;
  END LOOP;
END
$settle$;

COMMIT;
