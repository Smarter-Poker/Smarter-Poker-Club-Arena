-- 20260926131948_the_two_retired_mixed_custody_events_are_voided_and_every_do.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE TWO RETIRED MIXED-CUSTODY EVENTS ARE VOIDED, AND EVERY DOLLAR GOES HOME
-- ===========================================================================
--
-- The events (read from rows 2026-09-26 08:58-09:40 UTC, every pinned fact
-- re-read unchanged 13:15-13:20 UTC)
-- ---------------------------------------------------------------------------
--   5a387a75 "$100 Freeroll 12:00 PM": started 09-17 17:00, 351 entrants,
--     every one a horse (profiles.is_horse). Last hand 09-18 22:10:25.
--     13 alive on 13 live chairs holding 1,755,000 chips, plus RexSr
--     (registration b6b06b61): his chair on table fcbbd2ea left at
--     22:09:40.746 with 0 chips and his registration still says 'playing'
--     at 0 - his elimination was never recorded.
--     Money: one guarantee overlay leg, 100.00 from the main bank
--     (union_bank fade0000-...0001, chip_ledger 8937b2a5, 09-17 17:08:39).
--     No buy-in (free buy). 0 paid. 29.70 recorded on 22 eliminated
--     registrations (places 15-36) and never paid: no payout, obligation,
--     prize ledger leg or wallet credit exists.
--   615783bf "Afternoon Free Buy (NLH)": started 09-17 21:00, 195 entrants,
--     every one a horse. Last hand 09-18 22:12:26. 11 alive on 11 chairs
--     holding 975,000 chips.
--     Money: one guarantee overlay leg, 250.00 from club 2a1132b9's treasury
--     (chip_ledger c4d1051b, 09-17 22:07:08), and 39 add-ons of 1.00 from 39
--     horse wallets, each with its immutable wallet_charge refund entitlement.
--     0 paid. 52.82 recorded on places 13-20 and never paid; 12th place
--     (pokernora) was recorded 0.00 where the ladder said 8.41.
--   Both: escrow enforced and equal to the caches (100.00 / 289.00 prize,
--     0 bounty, 0 fee), no rake, no reserved hand permit.
--
-- Why they cannot resume
-- ----------------------
-- Their mixed-custody admissions (transfers 4733a062 / dc3ed248, retired
-- origins 66291622 / b3d06bad) are pinned to dead engine 778075b4 on
-- instance 1-1bcee94e, and a00_f06_retired_origin_claim refuses every lease
-- claim with F06_RETIRED_PARTIAL_PROCESS_CHANGED. Resuming needs a custody
-- design that does not exist, and 5a387a75's roster is damaged. Open break
-- operations on both hold f06_source_guard, which refuses every roster and
-- seat write on those tables. atomic_cancel_tournament refuses started events
-- (its law stands and is not touched), and fn_tournament_finish_readiness
-- needs a single winner.
--
-- The ruling (Dan, delegated 2026-09-26)
-- --------------------------------------
-- Close both out as VOIDED and money-neutral: every dollar goes back to
-- exactly where it came from, nothing is created or destroyed.
--
-- What this migration does, in one transaction
-- --------------------------------------------
--   1. smarter_private.f06_retired_event_voids: one claim/receipt row per
--      event, CHECKed to exactly these two ids.
--   2. smarter_private.f06_source_guard gains one clause: a roster or seat
--      write on a table with open break custody is let through ONLY for these
--      two events and ONLY inside the transaction holding the void's
--      uncompleted claim. At the end of this migration the guard is restored
--      byte for byte to its pre-image (md5 be484837), so no bypass outlives
--      it.
--   3. smarter_private.f06_void_retired_mixed_custody_event(p_tournament_id,
--      p_reason), a reviewed door for exactly these two ids. It re-reads and
--      pins every fact above, refuses on any drift or any human entrant, and:
--        a. records RexSr's elimination: 14th, at 22:09:40.746 (5a387a75);
--        b. voids the recorded-but-unpaid prizes (listed on the receipt);
--        c. releases 615783bf's stale lease (1-1bcee94e / 778075b4, last
--           heartbeat 09-26 01:58) through release_tournament_leases_v2;
--        d. returns each guarantee overlay to its exact source, the mirror
--           of fn_ca_fund_overlay_on_lock: the bank balance plus one explicit
--           'reversal' journal leg (prize_liability to the original bank,
--           key tourney:<id>:void:overlay-return), then the escrow overlay;
--        e. refunds the 39 add-ons through fn_settle_tournament_refund_exact
--           and their immutable entitlements: the same payer, source name
--           and tranche receipts atomic cancellation uses;
--        f. closes the escrow at exact zero, eliminates the roster, releases
--           every chair, marks the event CANCELLED and closes its tables, and
--           writes the tournament_cancellation_receipts row that
--           fn_ca_tournament_cancellation_receipt verifies, carrying
--           'reviewed_void' (reason, basis, elimination, voided prizes,
--           overlay return, lease); then records the accounting
--           cancellation.
--   4. Calls it for both events, restores the guard, and proves the result.
--
-- Transfers, admissions, retired origins and break operations are immutable
-- history and stay as they are. Nothing admits or claims a CANCELLED event,
-- so nothing reads them again. The running engine drops its in-memory custody
-- of both at its next restart, when they are no longer discovered.
--
-- Conservation (asserted below, per event)
--   * prize_liability: every chip in equals every chip out
--     (5a387a75: 100.00 in, 100.00 out; 615783bf: 289.00 in, 289.00 out);
--   * the overlay goes back to the same store and entity, same amount, once;
--   * each of the 39 wallets gets back exactly what it paid (1.00 each);
--   * the escrow closes at 0 / 0 / 0 and the receipt verifies.
--
-- Re-based 2026-09-26 13:20 UTC. The guard's pre-image is now be484837:
-- 20260926091645 ("a receipted chip is movement evidence", applied after this
-- void was first proved) moved it from 97d26bf7 by one line of the
-- elimination clause (a recorded f06_movement_admissions row now counts as
-- movement). This migration makes the same one-clause edit to the LIVE body
-- and restores the LIVE body byte for byte. The void door's body is the one
-- proved below, byte for byte (md5 f133744c).
--
-- Production safety (the 2026-09-26 09:33 collapse). The void takes the
-- settlement lane (G then the hand-settlement barrier, exclusive), as every
-- terminal authority does, so while it runs no hand settles anywhere. It must
-- never WAIT long for it or hold it long: the transaction and the door carry
-- lock_timeout 5s and statement_timeout 10s (a third of the 30 s lease-stale
-- window), so a busy lane or a slow void refuses cleanly (the whole
-- transaction rolls back, nothing written) instead of stalling the fleet.
-- The first apply (13:44 UTC, lock_timeout 2s) was refused exactly that way
-- after 2.6 s waiting for the lane behind in-flight hand settlements, with
-- nothing written; a finish waits for the same lane with no timeout at all.
--
-- Proved rolled back (2026-09-26 09:32 UTC, this exact function and guard in
-- one transaction, SET CONSTRAINTS ALL IMMEDIATE, ROLLBACK): both CANCELLED
-- with verified receipts; union bank 7,553.07 to 7,653.07 (+100.00); club
-- 2a1132b9 treasury 964,320.08 to 964,570.08 (+250.00); the 39 wallets
-- +39.00; journal: overlay 100.00 in and reversal 100.00 out; addon 39.00 +
-- overlay 250.00 in and refund 39.00 + reversal 250.00 out; escrows closed at
-- zero; no financial_alerts row.
--
-- Every entrant is a horse and the door refuses otherwise; the same ruling
-- would apply to a human field (CLAUDE.md 10.5).
--
-- @live-proof: (SELECT count(*) FROM public.tournaments WHERE id IN ('5a387a75-754a-416e-8fee-b85b15fc2702','615783bf-15e3-40b7-9368-75f21b6ac53b') AND status = 'CANCELLED') = 2
-- @live-proof: (SELECT count(*) FROM smarter_private.f06_retired_event_voids WHERE completed_at IS NOT NULL) = 2

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_source_guard()'::regprocedure
       AND md5(p.prosrc) = 'be484837a5103b3c0ac78a1d6d5d0bf2'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: smarter_private.f06_source_guard is not the definition read 2026-09-26';
  END IF;
  IF to_regclass('smarter_private.f06_retired_event_voids') IS NOT NULL
     OR to_regprocedure('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: the retired-event void already exists';
  END IF;
  IF (SELECT count(*) FROM public.tournaments
       WHERE id IN ('5a387a75-754a-416e-8fee-b85b15fc2702', '615783bf-15e3-40b7-9368-75f21b6ac53b') AND status = 'RUNNING') <> 2 THEN
    RAISE EXCEPTION 'PREIMAGE: both retired events must still be RUNNING';
  END IF;
END
$pre$;

CREATE TABLE smarter_private.f06_retired_event_voids (
  tournament_id uuid PRIMARY KEY,
  xid bigint NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 40),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT f06_retired_event_voids_reviewed_events CHECK (tournament_id IN (
    '5a387a75-754a-416e-8fee-b85b15fc2702'::uuid, '615783bf-15e3-40b7-9368-75f21b6ac53b'::uuid)),
  CONSTRAINT f06_retired_event_voids_receipt_on_completion CHECK ((completed_at IS NULL) = (receipt IS NULL))
);
ALTER TABLE smarter_private.f06_retired_event_voids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.f06_retired_event_voids FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 -- A REVIEWED VOID (2026-09-26). Exactly the two retired mixed-custody
 -- events, and only inside the one transaction that holds the void's claim
 -- (smarter_private.f06_retired_event_voids, completed before it ends). Every
 -- other table, event and transaction is refused exactly as before.
 IF NOT moving AND t IN ('5a387a75-754a-416e-8fee-b85b15fc2702'::uuid,'615783bf-15e3-40b7-9368-75f21b6ac53b'::uuid)
 AND EXISTS(SELECT 1 FROM smarter_private.f06_retired_event_voids v WHERE v.tournament_id=t AND v.xid=txid_current() AND v.completed_at IS NULL) THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION smarter_private.f06_void_retired_mixed_custody_event(p_tournament_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET statement_timeout TO '10s'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  -- THE TWO REVIEWED EVENTS. Nothing else can ever take this door.
  c_noon constant uuid := '5a387a75-754a-416e-8fee-b85b15fc2702';
  c_afternoon constant uuid := '615783bf-15e3-40b7-9368-75f21b6ac53b';
  c_rex_registration constant uuid := 'b6b06b61-418c-49e9-a72c-a9ef88d418fc';
  c_rex_user constant uuid := '6fa1c8e2-c2bb-4168-b121-6281a549b94f';
  c_rex_table constant uuid := 'fcbbd2ea-6fc2-47df-8b61-b9997fcd7b16';
  c_rex_busted_at constant timestamptz := '2026-09-18 22:09:40.74617+00';
  c_system_actor constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_close_note constant text := 'atomic cancellation receipt: exact zero';
  v_t public.tournaments%ROWTYPE;
  v_e public.tournament_escrow%ROWTYPE;
  v_overlay public.chip_ledger%ROWTYPE;
  v_lease public.engine_tournament_leases%ROWTYPE;
  v_entitlement public.tournament_refund_entitlements%ROWTYPE;
  v_player record;
  v_settle jsonb;
  v_now timestamptz := transaction_timestamp();
  v_pin jsonb;
  v_rows integer;
  v_n integer;
  v_sum numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_return_ledger_id uuid;
  v_rex jsonb := 'null'::jsonb;
  v_prizes jsonb;
  v_lease_released jsonb := 'null'::jsonb;
  v_refunds jsonb := '[]'::jsonb;
  v_refund_line_count integer := 0;
  v_total_refunded numeric := 0;
  v_refunded_registration_ids uuid[] := ARRAY[]::uuid[];
  v_zero_refund_registration_ids uuid[];
  v_source_player_ids uuid[];
  v_closed_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_released_seat_ids uuid[];
  v_registration_id uuid;
  v_total_owed numeric;
  v_receipt jsonb;
  v_void jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'F06_VOID_SERVICE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_tournament_id IS NULL OR p_tournament_id NOT IN (c_noon, c_afternoon) THEN
    RAISE EXCEPTION 'F06_VOID_NOT_A_REVIEWED_EVENT' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 40 THEN
    RAISE EXCEPTION 'F06_VOID_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: retired-event void refused' USING ERRCODE = '55000';
  END IF;

  -- Every terminal authority takes this lock before any row lock.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  -- A replay returns the stored, re-verified receipt; it never voids twice.
  IF EXISTS (SELECT 1 FROM smarter_private.f06_retired_event_voids v
              WHERE v.tournament_id = p_tournament_id AND v.completed_at IS NOT NULL) THEN
    RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id, c_system_actor);
  END IF;

  -- THE PINNED FACTS (read 2026-09-26). Any drift refuses the whole void.
  v_pin := CASE p_tournament_id
    WHEN c_noon THEN jsonb_build_object(
      'entrants', 351, 'playing', 14, 'live_seats', 13, 'live_chips', 1755000,
      'prize_pool', 100.00, 'overlay', 100.00, 'overlay_from', 'union_bank',
      'overlay_entity', 'fade0000-0000-0000-0000-000000000001',
      'overlay_ledger', '8937b2a5-e78b-459a-958d-b59b353101ec', 'gross_in', 0.00,
      'entitlements', 0, 'prized', 22, 'prize_total', 29.70,
      'origin_generation', NULL)
    ELSE jsonb_build_object(
      'entrants', 195, 'playing', 11, 'live_seats', 11, 'live_chips', 975000,
      'prize_pool', 289.00, 'overlay', 250.00, 'overlay_from', 'club_treasury',
      'overlay_entity', '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
      'overlay_ledger', 'c4d1051b-dc8b-4587-8f19-96de18e2f31e', 'gross_in', 39.00,
      'entitlements', 39, 'prized', 8, 'prize_total', 52.82,
      'origin_generation', NULL)
  END;

  IF upper(COALESCE(v_t.status, '')) IS DISTINCT FROM 'RUNNING'
     OR v_t.started_at IS NULL
     OR v_t.prize_pool IS DISTINCT FROM (v_pin->>'prize_pool')::numeric
     OR COALESCE(v_t.bounty_pool, 0) <> 0 OR COALESCE(v_t.total_rake, 0) <> 0
     OR COALESCE(v_t.spin_multiplier, 0) <> 0
     OR COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
     OR COALESCE(v_t.is_mystery_bounty, false)
     OR public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'F06_VOID_EVENT_CHANGED' USING ERRCODE = '55000';
  END IF;
  -- Every entrant is a platform-operated horse. A human anywhere refuses.
  IF (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = p_tournament_id)
       IS DISTINCT FROM (v_pin->>'entrants')::bigint
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                  LEFT JOIN public.profiles p ON p.id = tp.user_id
                 WHERE tp.tournament_id = p_tournament_id AND p.is_horse IS NOT TRUE) THEN
    RAISE EXCEPTION 'F06_VOID_A_HUMAN_IS_ENTERED' USING ERRCODE = '55000';
  END IF;
  -- It is the retired mixed-custody event: its original manager is retired
  -- and its custody transfer never completed.
  IF NOT EXISTS (SELECT 1 FROM smarter_private.f06_retired_manager_origins o
                  WHERE o.tournament_id = p_tournament_id)
     OR NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_transfers c
                     WHERE c.tournament_id = p_tournament_id
                       AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions d
                                        WHERE d.transfer_id = c.transfer_id)) THEN
    RAISE EXCEPTION 'F06_VOID_NOT_RETIRED_CUSTODY' USING ERRCODE = '55000';
  END IF;
  -- Nothing was ever paid out of it.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts x WHERE x.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x WHERE x.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements x WHERE x.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts x WHERE x.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_refund_tranches x WHERE x.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.rake_records x WHERE x.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.tournament_id = p_tournament_id
                  AND (l.from_type = 'prize_liability' OR l.category NOT IN ('overlay', 'addon')))
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w
                 WHERE w.related_entity_id = p_tournament_id AND w.type = 'credit') THEN
    RAISE EXCEPTION 'F06_VOID_MONEY_ALREADY_MOVED' USING ERRCODE = '55000';
  END IF;
  -- The only money in it: one guarantee overlay leg and the add-on charges.
  SELECT * INTO v_overlay FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id AND l.category = 'overlay';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 OR v_overlay.id IS DISTINCT FROM (v_pin->>'overlay_ledger')::uuid
     OR v_overlay.amount IS DISTINCT FROM (v_pin->>'overlay')::numeric
     OR v_overlay.from_type IS DISTINCT FROM v_pin->>'overlay_from'
     OR v_overlay.from_entity_id IS DISTINCT FROM (v_pin->>'overlay_entity')::uuid
     OR v_overlay.to_type IS DISTINCT FROM 'prize_liability'
     OR v_overlay.to_entity_id IS DISTINCT FROM p_tournament_id
     OR v_overlay.status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'F06_VOID_OVERLAY_CHANGED' USING ERRCODE = '55000';
  END IF;
  SELECT count(*), COALESCE(sum(l.amount), 0) INTO v_n, v_sum FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id AND l.category = 'addon';
  IF v_sum IS DISTINCT FROM (v_pin->>'gross_in')::numeric
     OR v_n IS DISTINCT FROM (v_pin->>'entitlements')::integer
     OR (SELECT count(*) FROM public.tournament_refund_entitlements e
          WHERE e.tournament_id = p_tournament_id) IS DISTINCT FROM (v_pin->>'entitlements')::bigint
     OR EXISTS (SELECT 1 FROM public.tournament_refund_entitlements e
                 WHERE e.tournament_id = p_tournament_id
                   AND (e.entitlement_kind <> 'wallet_charge' OR e.charge_category <> 'addon'
                     OR e.gross <> 1.00 OR e.refund_prize <> 1.00 OR e.refund_fee <> 0
                     OR e.refund_bounty <> 0)) THEN
    RAISE EXCEPTION 'F06_VOID_ADDONS_CHANGED' USING ERRCODE = '55000';
  END IF;
  PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'reviewed void prelock');
  SELECT * INTO v_e FROM public.tournament_escrow e WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.enforced IS DISTINCT FROM true
     OR v_e.overlay_in IS DISTINCT FROM (v_pin->>'overlay')::numeric
     OR v_e.gross_in IS DISTINCT FROM (v_pin->>'gross_in')::numeric
     OR v_e.prize_balance IS DISTINCT FROM (v_pin->>'prize_pool')::numeric
     OR v_e.prize_balance IS DISTINCT FROM v_t.prize_pool
     OR v_e.bounty_balance <> 0 OR v_e.fee_balance <> 0
     OR v_e.prize_out <> 0 OR v_e.bounty_out <> 0 OR v_e.fee_out <> 0
     OR v_e.refund_prize <> 0 OR v_e.satellite_in <> 0 OR v_e.reserve_out <> 0
     OR v_e.reserve_in <> 0 OR v_e.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'F06_VOID_ESCROW_CHANGED' USING ERRCODE = '55000';
  END IF;
  -- The table chips are exactly the live players' registrations.
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.status = 'playing')
       IS DISTINCT FROM (v_pin->>'playing')::bigint
     OR (SELECT count(*) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL)
       IS DISTINCT FROM (v_pin->>'live_seats')::bigint
     OR (SELECT COALESCE(sum(s.stack), 0) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL)
       IS DISTINCT FROM (v_pin->>'live_chips')::numeric
     OR (SELECT count(*) FILTER (WHERE tp.prize <> 0) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) IS DISTINCT FROM (v_pin->>'prized')::bigint
     OR (SELECT COALESCE(sum(tp.prize), 0) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) IS DISTINCT FROM (v_pin->>'prize_total')::numeric
     OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h
                 WHERE h.tournament_id = p_tournament_id AND h.state = 'reserved') THEN
    RAISE EXCEPTION 'F06_VOID_ROSTER_CHANGED' USING ERRCODE = '55000';
  END IF;

  -- THE CLAIM. f06_source_guard lets this event's roster and seats move
  -- while its retired break custody is open ONLY inside the transaction that
  -- holds this row; completed_at closes it before the transaction ends.
  INSERT INTO smarter_private.f06_retired_event_voids (tournament_id, xid, reason)
  VALUES (p_tournament_id, txid_current(), p_reason);

  PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id, v_now);
  PERFORM 1 FROM public.tournament_players tp WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.user_id, tp.id FOR UPDATE;
  PERFORM 1 FROM public.tables tb WHERE tb.tournament_id = p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id ORDER BY s.table_id, s.id FOR UPDATE OF s;

  -- 1. THE MISSING ELIMINATION (5a387a75 only). RexSr busted at 22:09:40 on
  --    09-18: his chair on fcbbd2ea left with 0 chips, his registration kept
  --    'playing' at 0. With 13 players still alive he finished 14th.
  IF p_tournament_id = c_noon THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                    WHERE tp.id = c_rex_registration AND tp.tournament_id = c_noon
                      AND tp.user_id = c_rex_user AND tp.status = 'playing'
                      AND tp.chips = 0 AND tp.position IS NULL AND tp.eliminated_at IS NULL
                      AND tp.table_id = c_rex_table)
       OR EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
                   WHERE tb.tournament_id = c_noon AND s.user_id = c_rex_user
                     AND (s.left_at IS NULL OR s.stack <> 0))
       OR NOT EXISTS (SELECT 1 FROM public.table_seats s
                       WHERE s.table_id = c_rex_table AND s.user_id = c_rex_user
                         AND s.left_at = c_rex_busted_at AND s.stack = 0)
       OR EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = c_noon AND tp.position = 14) THEN
      RAISE EXCEPTION 'F06_VOID_BUST_CHANGED' USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournament_players
       SET status = 'eliminated', eliminated_at = c_rex_busted_at, position = 14
     WHERE id = c_rex_registration AND status = 'playing' AND chips = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'F06_VOID_BUST_NOT_RECORDED' USING ERRCODE = '40001'; END IF;
    v_rex := jsonb_build_object('registration_id', c_rex_registration, 'user_id', c_rex_user,
      'table_id', c_rex_table, 'eliminated_at', c_rex_busted_at, 'position', 14, 'chips', 0);
  END IF;

  -- 2. THE RECORDED-BUT-UNPAID PRIZES ARE VOID. Nothing was ever paid.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('registration_id', tp.id, 'user_id', tp.user_id,
           'position', tp.position, 'prize', tp.prize) ORDER BY tp.position, tp.id), '[]'::jsonb)
    INTO v_prizes FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.prize <> 0;
  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id AND prize <> 0;

  -- 3. THE DEAD ENGINE'S LEASE. Only a stale lease is released.
  SELECT * INTO v_lease FROM public.engine_tournament_leases
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF FOUND THEN
    IF v_lease.heartbeat_at >= clock_timestamp() - make_interval(secs => public.fn_engine_lease_stale_seconds()) THEN
      RAISE EXCEPTION 'F06_VOID_LEASE_IS_LIVE' USING ERRCODE = '55000';
    END IF;
    PERFORM public.release_tournament_leases_v2(v_lease.instance_id, jsonb_build_array(
      jsonb_build_object('tournament_id', p_tournament_id, 'lease_generation', v_lease.lease_generation)));
    IF EXISTS (SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'F06_VOID_LEASE_NOT_RELEASED' USING ERRCODE = '40001';
    END IF;
    v_lease_released := jsonb_build_object('instance_id', v_lease.instance_id,
      'lease_generation', v_lease.lease_generation, 'engine_version', v_lease.engine_version,
      'heartbeat_at', v_lease.heartbeat_at);
  END IF;

  -- 4. THE GUARANTEE OVERLAY GOES BACK TO EXACTLY WHERE IT CAME FROM, the
  --    mirror of fn_ca_fund_overlay_on_lock: the bank balance and its one
  --    explicit journal leg, in one transaction, then the escrow.
  IF v_overlay.from_type = 'union_bank' THEN
    SELECT chip_balance INTO v_balance_before FROM public.union_wallets
     WHERE union_id = v_overlay.from_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'F06_VOID_OVERLAY_SOURCE_MISSING' USING ERRCODE = '55000'; END IF;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    UPDATE public.union_wallets SET chip_balance = chip_balance + v_overlay.amount, updated_at = now()
     WHERE union_id = v_overlay.from_entity_id RETURNING chip_balance INTO v_balance_after;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
  ELSE
    SELECT chip_treasury INTO v_balance_before FROM public.clubs
     WHERE id = v_overlay.from_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'F06_VOID_OVERLAY_SOURCE_MISSING' USING ERRCODE = '55000'; END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + v_overlay.amount, updated_at = now()
     WHERE id = v_overlay.from_entity_id RETURNING chip_treasury INTO v_balance_after;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;
  IF v_balance_after IS DISTINCT FROM round(v_balance_before + v_overlay.amount, 2) THEN
    RAISE EXCEPTION 'F06_VOID_OVERLAY_SOURCE_CHANGED' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.chip_ledger (
    performed_by, from_type, from_entity_id, to_type, to_entity_id,
    amount, category, club_id, tournament_id, description, idempotency_key, metadata)
  VALUES (
    c_system_actor, 'prize_liability', p_tournament_id, v_overlay.from_type, v_overlay.from_entity_id,
    v_overlay.amount, 'reversal', v_overlay.club_id, p_tournament_id,
    format('Guarantee overlay returned to its source: %s (%s) was voided before any prize was paid',
           COALESCE(v_t.name, 'tournament'), p_tournament_id),
    'tourney:' || p_tournament_id::text || ':void:overlay-return',
    jsonb_build_object('kind', 'reviewed_void_overlay_return',
      'original_overlay_ledger_id', v_overlay.id, 'source_balance_before', v_balance_before,
      'source_balance_after', v_balance_after))
  RETURNING id INTO v_return_ledger_id;
  PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'reviewed void overlay return',
                                    p_overlay_in => -v_overlay.amount);

  -- 5. EVERY ADD-ON GOES BACK TO ITS WALLET through the exact refund payer and
  --    its immutable entitlement, the same authority atomic cancellation uses.
  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id), ARRAY[]::uuid[]) INTO v_source_player_ids
    FROM public.tournament_players tp WHERE tp.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[]) INTO v_closed_table_ids
    FROM public.tables tb WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id, s.id), ARRAY[]::uuid[]) INTO v_source_seat_ids
    FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  FOR v_player IN
    SELECT DISTINCT ON (tp.user_id) tp.id, tp.user_id FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.tournament_refund_entitlements e
                    WHERE e.tournament_id = p_tournament_id AND e.user_id = tp.user_id)
     ORDER BY tp.user_id, tp.id
  LOOP
    PERFORM 1 FROM public.fn_ca_tournament_refund_plan(p_tournament_id, v_player.user_id);
    LOOP
      SELECT e.* INTO v_entitlement FROM public.tournament_refund_entitlements e
       WHERE e.tournament_id = p_tournament_id AND e.user_id = v_player.user_id
         AND NOT EXISTS (SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM public.tournament_tickets tk WHERE tk.source_refund_entitlement_id = e.id)
       ORDER BY e.entitlement_kind, e.id LIMIT 1 FOR UPDATE OF e;
      EXIT WHEN NOT FOUND;
      v_registration_id := COALESCE(v_entitlement.registration_id, v_player.id);
      SELECT COALESCE(o.amount_paid, 0) + v_entitlement.gross INTO v_total_owed
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id AND o.kind = 'refund' AND o.place IS NULL
         AND o.user_id = v_player.user_id FOR UPDATE;
      IF NOT FOUND THEN v_total_owed := v_entitlement.gross; END IF;
      v_settle := public.fn_settle_tournament_refund_exact(
        p_tournament_id, v_player.user_id, v_entitlement.refund_wallet_club_id, v_total_owed,
        v_entitlement.refund_prize, v_entitlement.refund_bounty, v_entitlement.refund_fee,
        'atomic_cancel_tournament', 'Tournament void refund: ' || COALESCE(v_t.name, 'Unknown'));
      IF COALESCE((v_settle->>'ok')::boolean, false) IS NOT TRUE
         OR COALESCE((v_settle->>'fully_settled')::boolean, false) IS NOT TRUE
         OR (v_settle->>'entitlement_id')::uuid IS DISTINCT FROM v_entitlement.id
         OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_entitlement.gross THEN
        RAISE EXCEPTION 'F06_VOID_REFUND_REFUSED % %', v_entitlement.id, v_settle USING ERRCODE = '55000';
      END IF;
      v_refunds := v_refunds || jsonb_build_array(jsonb_build_object(
        'registration_id', v_registration_id, 'user_id', v_player.user_id,
        'entitlement_id', v_entitlement.id, 'entitlement_kind', v_entitlement.entitlement_kind,
        'source_wallet_club_id', v_entitlement.refund_wallet_club_id,
        'gross_paid', v_entitlement.gross,
        'amount_paid_before', (v_settle->>'already_paid')::numeric,
        'amount_paid_now', (v_settle->>'paid')::numeric,
        'refund_prize', (v_settle->>'refund_prize')::numeric,
        'refund_bounty', (v_settle->>'refund_bounty')::numeric,
        'refund_fee', (v_settle->>'refund_fee')::numeric,
        'obligation_id', (v_settle->>'obligation_id')::uuid,
        'idempotency_key', v_settle->>'idempotency_key',
        'credit_ledger_id', (v_settle->>'credit_ledger_id')::uuid,
        'wallet_transaction_id', (v_settle->>'wallet_transaction_id')::uuid));
      v_refund_line_count := v_refund_line_count + 1;
      v_total_refunded := round(v_total_refunded + (v_settle->>'paid')::numeric, 2);
      IF NOT v_registration_id = ANY (v_refunded_registration_ids) THEN
        v_refunded_registration_ids := array_append(v_refunded_registration_ids, v_registration_id);
      END IF;
    END LOOP;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_refunded_registration_ids
    FROM unnest(v_refunded_registration_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_zero_refund_registration_ids
    FROM unnest(v_source_player_ids) ids(id) WHERE NOT id = ANY (v_refunded_registration_ids);
  IF v_refund_line_count IS DISTINCT FROM (v_pin->>'entitlements')::integer
     OR v_total_refunded IS DISTINCT FROM (v_pin->>'gross_in')::numeric
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
                   AND EXISTS (SELECT 1 FROM public.fn_ca_tournament_refund_plan(p_tournament_id, tp.user_id))) THEN
    RAISE EXCEPTION 'F06_VOID_REFUNDS_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  -- 6. THE ESCROW CLOSES AT EXACT ZERO.
  SELECT * INTO v_e FROM public.tournament_escrow e WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.prize_balance IS DISTINCT FROM 0::numeric OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric OR v_e.overlay_in IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'F06_VOID_ESCROW_NOT_ZERO prize % bounty % fee % overlay %',
      v_e.prize_balance, v_e.bounty_balance, v_e.fee_balance, v_e.overlay_in USING ERRCODE = 'P0404';
  END IF;
  UPDATE public.tournament_escrow SET closed_at = v_now, close_note = c_close_note, updated_at = now()
   WHERE tournament_id = p_tournament_id AND closed_at IS NULL
     AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'F06_VOID_ESCROW_CLOSE_LOST' USING ERRCODE = '40001'; END IF;

  -- 7. TERMINAL: the same roster, seat, event and table close as atomic
  --    cancellation, and the same verified receipt.
  UPDATE public.tournament_players SET status = 'eliminated', eliminated_at = v_now, chips = 0, current_bounty = 0
   WHERE tournament_id = p_tournament_id;
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at = v_now, status = 'left', leave_pending = false, is_sitting_out = false,
           is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
      FROM public.tables tb
     WHERE tb.id = s.table_id AND tb.tournament_id = p_tournament_id AND s.left_at IS NULL
    RETURNING s.id)
  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_released_seat_ids FROM released;
  UPDATE public.table_seats s
     SET status = 'left', leave_pending = false, is_sitting_out = false, is_away = false,
         sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE s.id = ANY (v_source_seat_ids) AND s.left_at IS NOT NULL;
  UPDATE public.tournaments
     SET status = 'CANCELLED', ended_at = v_now, updated_at = now(), prize_pool = 0, bounty_pool = 0,
         total_rake = 0, current_players = 0, on_break = false, break_started_at = NULL, break_ends_at = NULL
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'RUNNING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'F06_VOID_LIFECYCLE_CLAIM_LOST' USING ERRCODE = '40001'; END IF;
  UPDATE public.tables
     SET status = 'closed', lifecycle = 'closed', current_players = 0, terminal_closed_at = v_now, updated_at = now()
   WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> cardinality(v_closed_table_ids) THEN
    RAISE EXCEPTION 'F06_VOID_TABLES_NOT_CLOSED' USING ERRCODE = '40001';
  END IF;

  v_void := jsonb_build_object(
    'ruling', 'voided_money_neutral', 'reason', p_reason,
    'basis', 'retired mixed-custody event: admissions pinned to dead engine 778075b4 / instance 1-1bcee94e, refused at every lease claim with F06_RETIRED_PARTIAL_PROCESS_CHANGED; no new custody design can resume it; every entrant a horse; nothing ever paid',
    'recorded_elimination', v_rex, 'voided_unpaid_prizes', v_prizes,
    'overlay_returned', jsonb_build_object('amount', v_overlay.amount, 'to_type', v_overlay.from_type,
      'to_entity_id', v_overlay.from_entity_id, 'original_ledger_id', v_overlay.id,
      'return_ledger_id', v_return_ledger_id, 'source_balance_before', v_balance_before,
      'source_balance_after', v_balance_after),
    'lease_released', v_lease_released);
  v_receipt := jsonb_build_object(
    'ok', true, 'success', true, 'fully_settled', true, 'receipt_version', 2,
    'tournament_id', p_tournament_id, 'actor_id', c_system_actor, 'status', 'CANCELLED',
    'source_player_count', cardinality(v_source_player_ids),
    'refunded_count', cardinality(v_refunded_registration_ids), 'refund_line_count', v_refund_line_count,
    'ticket_return_count', 0, 'total_ticket_returned', 0,
    'total_refunded', v_total_refunded, 'fees_reversed', 0,
    'closed_table_count', cardinality(v_closed_table_ids),
    'source_seat_count', cardinality(v_source_seat_ids),
    'released_seat_count', cardinality(v_released_seat_ids),
    'refunds', v_refunds, 'ticket_returns', '[]'::jsonb, 'settled_at', v_now,
    'reviewed_void', v_void);
  INSERT INTO public.tournament_cancellation_receipts(
    tournament_id, actor_id, receipt_version, source_player_count, source_player_ids,
    refunded_count, refunded_registration_ids, refund_line_count,
    ticket_return_count, ticket_return_ids, total_ticket_returned,
    zero_refund_count, zero_refund_registration_ids,
    total_refunded, fees_reversed, total_rake_before, total_rake_after,
    closed_table_count, closed_table_ids, source_seat_count, source_seat_ids,
    released_seat_count, released_seat_ids, fee_reversal_ids,
    escrow_closed_at, escrow_close_note, spin_unwind_tournament_id, receipt, settled_at)
  VALUES (
    p_tournament_id, c_system_actor, 2, cardinality(v_source_player_ids), v_source_player_ids,
    cardinality(v_refunded_registration_ids), v_refunded_registration_ids, v_refund_line_count,
    0, ARRAY[]::uuid[], 0,
    cardinality(v_zero_refund_registration_ids), v_zero_refund_registration_ids,
    v_total_refunded, 0, 0, 0,
    cardinality(v_closed_table_ids), v_closed_table_ids, cardinality(v_source_seat_ids), v_source_seat_ids,
    cardinality(v_released_seat_ids), v_released_seat_ids, ARRAY[]::uuid[],
    v_now, c_close_note, NULL, v_receipt, v_now);

  PERFORM public.fn_record_accounting_tournament_cancellation(p_tournament_id);
  UPDATE smarter_private.f06_retired_event_voids
     SET receipt = v_void, completed_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id AND xid = txid_current() AND completed_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'F06_VOID_CLAIM_LOST' USING ERRCODE = '40001'; END IF;
  RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id, c_system_actor);
END
$function$;

REVOKE ALL ON FUNCTION smarter_private.f06_void_retired_mixed_custody_event(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION smarter_private.f06_void_retired_mixed_custody_event(uuid, text)
  TO service_role;

DO $void$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'smarter_private.f06_source_guard()'::regprocedure
                  AND md5(p.prosrc) = '77a6d6505ecb318845d280176881e0f0') THEN
    RAISE EXCEPTION 'the void clause is not installed';
  END IF;
  r := smarter_private.f06_void_retired_mixed_custody_event('5a387a75-754a-416e-8fee-b85b15fc2702',
    'Reviewed void (Dan, 2026-09-26): retired mixed-custody event pinned to dead engine 778075b4 that no custody design can resume; every entrant a horse; every dollar returned to its source');
  RAISE NOTICE '5a387a75 voided: %', r->'reviewed_void';
  r := smarter_private.f06_void_retired_mixed_custody_event('615783bf-15e3-40b7-9368-75f21b6ac53b',
    'Reviewed void (Dan, 2026-09-26): retired mixed-custody event pinned to dead engine 778075b4 that no custody design can resume; every entrant a horse; every dollar returned to its source');
  RAISE NOTICE '615783bf voided: %', r->'reviewed_void';
END
$void$;

-- The guard goes back exactly as it was: no bypass outlives this migration.
CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $post$
DECLARE t uuid; v_in numeric; v_out numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_source_guard()'::regprocedure
       AND md5(p.prosrc) = 'be484837a5103b3c0ac78a1d6d5d0bf2'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: f06_source_guard was not restored to its pre-image';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_void_retired_mixed_custody_event(uuid,text)'::regprocedure
       AND md5(p.prosrc) = 'f133744cc580d6092828e09b87fb6617'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private","statement_timeout=10s","lock_timeout=5s"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: the void door is not the reviewed definition with its owner, grants and settings';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'smarter_private.f06_retired_event_voids'::regclass)
     OR has_table_privilege('anon', 'smarter_private.f06_retired_event_voids', 'SELECT')
     OR has_table_privilege('authenticated', 'smarter_private.f06_retired_event_voids', 'SELECT')
     OR has_table_privilege('service_role', 'smarter_private.f06_retired_event_voids', 'SELECT') THEN
    RAISE EXCEPTION 'POSTIMAGE: the void receipts are not private';
  END IF;
  FOREACH t IN ARRAY ARRAY['5a387a75-754a-416e-8fee-b85b15fc2702'::uuid, '615783bf-15e3-40b7-9368-75f21b6ac53b'::uuid] LOOP
    PERFORM public.fn_ca_tournament_cancellation_receipt(t, NULL);
    IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = t AND status = 'CANCELLED' AND prize_pool = 0)
       OR NOT EXISTS (SELECT 1 FROM smarter_private.f06_retired_event_voids v
                       WHERE v.tournament_id = t AND v.completed_at IS NOT NULL)
       OR NOT EXISTS (SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id = t
                       AND e.closed_at IS NOT NULL AND e.prize_balance = 0 AND e.bounty_balance = 0
                       AND e.fee_balance = 0 AND e.overlay_in = 0)
       OR EXISTS (SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id = t)
       OR EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = t
                   AND (status <> 'eliminated' OR chips <> 0 OR prize <> 0))
       OR EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
                   WHERE tb.tournament_id = t AND s.left_at IS NULL) THEN
      RAISE EXCEPTION 'POSTIMAGE: % is not cleanly terminal', t;
    END IF;
    -- CONSERVATION: every chip into the event's prize liability came out.
    SELECT COALESCE(sum(amount) FILTER (WHERE to_type = 'prize_liability' AND to_entity_id = t), 0),
           COALESCE(sum(amount) FILTER (WHERE from_type = 'prize_liability' AND from_entity_id = t), 0)
      INTO v_in, v_out FROM public.chip_ledger WHERE tournament_id = t;
    IF v_in <> v_out OR v_in = 0 THEN
      RAISE EXCEPTION 'POSTIMAGE: % prize liability does not balance: in % out %', t, v_in, v_out;
    END IF;
    -- The overlay went back to the same store and entity, same amount, once.
    IF (SELECT count(*) FROM public.chip_ledger o JOIN public.chip_ledger r
          ON r.tournament_id = t AND r.category = 'reversal'
         AND r.idempotency_key = 'tourney:' || t::text || ':void:overlay-return'
         AND r.from_type = 'prize_liability' AND r.from_entity_id = t
         AND r.to_type = o.from_type AND r.to_entity_id = o.from_entity_id AND r.amount = o.amount
         WHERE o.tournament_id = t AND o.category = 'overlay') <> 1 THEN
      RAISE EXCEPTION 'POSTIMAGE: % overlay did not return to its source exactly once', t;
    END IF;
    -- Every wallet got back exactly what it paid.
    IF EXISTS (
      SELECT 1 FROM (
        SELECT from_entity_id AS u, sum(amount) AS paid FROM public.chip_ledger
         WHERE tournament_id = t AND category = 'addon' AND from_type = 'player_wallet' GROUP BY 1) c
      FULL JOIN (
        SELECT to_entity_id AS u, sum(amount) AS back FROM public.chip_ledger
         WHERE tournament_id = t AND category = 'refund' AND to_type = 'player_wallet' GROUP BY 1) r
        USING (u)
       WHERE c.paid IS DISTINCT FROM r.back) THEN
      RAISE EXCEPTION 'POSTIMAGE: % add-ons and refunds do not match wallet by wallet', t;
    END IF;
  END LOOP;
END
$post$;

COMMIT;
