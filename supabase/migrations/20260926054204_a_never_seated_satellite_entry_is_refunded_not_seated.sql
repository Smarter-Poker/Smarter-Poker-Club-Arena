-- 20260926054204_a_never_seated_satellite_entry_is_refunded_not_seated.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A NEVER-SEATED SATELLITE ENTRY IS REFUNDED, NOT SEATED
--  (owner decision, Dan, 2026-09-26: "Refund the 50.00 ticket". Do not seat.)
-- ===========================================================================
--
-- WHAT HAPPENED, READ FROM ROWS (2026-09-26 05:30-05:41 UTC).
--
-- JulesSA (5330edb2) won place 1 of satellite 95b5fd70 and, at 2026-09-22
-- 14:08:23, fn_settle_satellite_tournament delivered her into the RUNNING
-- target c7f21a83 "Sunday Funday Six-Card Closer" (PLO6 freezeout, 30,000
-- starting stacks). The delivery funded the entry: chip_ledger 8e974480 moved
-- 50.00 from the satellite's prize liability into the target (45.00 prize,
-- 5.00 fee, rake_records 1ad31e6e), recorded as refund entitlement ea0ff181
-- (satellite_seat, refund wallet Club JAQK). It inserted registration
-- d5f1a621 with status 'registered' and chips 0 and never took a chair: a
-- RUNNING target has no launch left to seat it (fixed at the root by #5253,
-- "a satellite seat into a running target is dealt in"). She has never held a
-- table_seats row in this event and has no wallet row for it.
--
-- Four entrants are seated with exactly 120,000 chips (4 x 30,000).
-- fn_ca_tournament_chip_supply counts every tournament_players row, so the
-- event expected 150,000 and every sample read -30,000. No chip is missing:
-- her 30,000 were never issued. #5275 stopped the checker calling that
-- missing chips; this settles the entry itself.
--
-- WHY THIS IS A MIGRATION AND NOT A CALL TO THE UNREGISTER DOOR.
--
-- fn_ca_unregister_tournament_player_exact is the platform's unregistration
-- core. It refuses once a tournament is RUNNING or has dealt a hand
-- ('registration_closed' / 'tournament_started'), which is right for a
-- player choosing to leave. It is also pinned by definition md5 in the MTT
-- admission contract fixtures, so widening it for one registration is not
-- minimal. This migration performs the SAME steps, in the core's order, for
-- exactly this one registration, and asserts every number first:
--
--   1. money through fn_settle_tournament_refund_exact, the platform's exact
--      idempotent refund payer (source fn_unregister_from_tournament, one-use
--      refund authorization, wallet_credit_idempotency key
--      tourney:<t>:refund-entitlement:<ent>, one chip_ledger leg, one
--      wallet_transactions 'refund' row, one tranche, the refund obligation);
--   2. the 5.00 entry fee reversed by one negative rake_records row in the
--      exact shape fn_accounting_tournament_fee_net_plan proves;
--   3. tournaments.current_players / prize_pool / total_rake compare-and-set
--      5 / 1245 / 25 -> 4 / 1200 / 20 (escrow follows: prize 1200, fee 20);
--   4. the registration row removed under the 'unregister' seat-exit
--      authority (it holds no live seat, so the authority covers none);
--   5. an immutable tournament_unregistration_receipts row. Its start
--      authority is the new value 'owner_never_seated_release' - not one of
--      the existing values, because none of them is true here. The check
--      constraint is widened by exactly that one value; nothing else in it
--      changes.
--
-- INSTRUMENT. What she held was a funded satellite seat worth 50.00, not a
-- tournament_tickets row (her award has ticket_id NULL, delivery_kind 'seat',
-- entitlement award_kind 'seat_or_cash'). The approved rule for a funded
-- satellite entry that leaves (20260909222303, "satellite unregister returns
-- its funded cash") returns it as 50.00 cash to the entitlement's recorded
-- wallet, Club JAQK, through the exact door above. That is what the owner's
-- "refund the 50.00 ticket" means on this platform. She receives 50.00, once.
--
-- WHAT THIS DOES NOT TOUCH. No live seat, no table, no stack, no hand, no
-- engine state. No other member wallet, club treasury/pool, club wallet or
-- union wallet: all are fingerprinted before and after and must be equal.
-- The tournament stays RUNNING with its four players; its guarantee overlay
-- (1,020.00) is untouched, so the prize pool falls from 1,245.00 to 1,200.00.
--
-- PROVED FIRST (CLAUDE.md 11.5): the exact DO block below, with a stand-in
-- start authority because a probe carries no DDL, ran on production at
-- 2026-09-26 05:41 UTC as one execute_sql call ending in RAISE EXCEPTION
-- after SET CONSTRAINTS ALL IMMEDIATE. It returned PROBE_OK: wallet
-- 82,551.96 -> 82,601.96, fee net plan proven (gross 25, refunded 5, net 20),
-- felt 120,000 = supply 120,000, conservation delta 1,200 = prize pool, no
-- other balance or seat moved. A read-back afterwards showed nothing
-- committed.
--
-- REPLAY. On a database without this event, or one where this registration
-- already has its receipt, the block does nothing. It is a one-off
-- settlement, not a job: nothing here recurs or is scheduled.
--
-- Changelog: docs/changelog/2026-09-26-a-never-seated-satellite-entry-is-refunded-not-seated.md
--
-- @live-proof: (SELECT pg_get_constraintdef(c.oid) ~ 'owner_never_seated_release' FROM pg_constraint c WHERE c.conrelid = 'public.tournament_unregistration_receipts'::regclass AND c.conname = 'tournament_unregistration_actual_start_check')
-- @live-proof: EXISTS (SELECT 1 FROM public.tournament_unregistration_receipts r WHERE r.registration_id = 'd5f1a621-5421-4854-ba65-b930d9a1ad1f' AND r.start_authority = 'owner_never_seated_release' AND r.refunded_chips = 50 AND r.fees_reversed = 5)
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- The receipt must name what authorised a release after the start. Widen the
-- start-authority check by exactly one value.
ALTER TABLE public.tournament_unregistration_receipts
  DROP CONSTRAINT tournament_unregistration_actual_start_check;
ALTER TABLE public.tournament_unregistration_receipts
  ADD CONSTRAINT tournament_unregistration_actual_start_check CHECK (
    ((start_authority = 'scheduled_clock'::text) AND (settled_at < scheduled_start_at))
    OR (start_authority = ANY (ARRAY['spin_actual_start'::text,
                                     'heads_up_sng_actual_start'::text,
                                     'launch_release'::text,
                                     'owner_never_seated_release'::text])));

DO $release$
DECLARE
  c_t        constant uuid := 'c7f21a83-367c-459e-9639-067fa92516f5';
  c_u        constant uuid := '5330edb2-9f93-492a-aef3-c7e077c0de68';
  c_reg      constant uuid := 'd5f1a621-5421-4854-ba65-b930d9a1ad1f';
  c_sat      constant uuid := '95b5fd70-e361-4ec4-bae4-78e4d7937db7';
  c_ent      constant uuid := 'ea0ff181-47e3-40b7-86c6-1ccade36ec8c';
  c_src_led  constant uuid := '8e974480-bd63-43d5-a9a0-ed8e138e728e';
  c_fee_src  constant uuid := '1ad31e6e-d57f-4964-a13f-cdd28665cea3';
  c_club     constant uuid := 'a0000000-0000-0000-0000-000000000001';
  c_request  constant uuid := md5('owner-release-never-seated:d5f1a621-5421-4854-ba65-b930d9a1ad1f')::uuid;
  c_desc     constant text := 'Refund: satellite seat (50.00) into Sunday Funday Six-Card Closer was never dealt in; registration released by owner decision 2026-09-26';
  v_t        public.tournaments%ROWTYPE;
  v_reg      public.tournament_players%ROWTYPE;
  v_e        public.tournament_refund_entitlements%ROWTYPE;
  v_fee      public.rake_records%ROWTYPE;
  v_eb       public.tournament_escrow%ROWTYPE;
  v_ea       public.tournament_escrow%ROWTYPE;
  v_settle   jsonb;
  v_plan     jsonb;
  v_rows     integer;
  v_n        integer;
  v_bal_before numeric;
  v_bal_after  numeric;
  v_seats_before text;
  v_seats_after  text;
  v_others_before text;
  v_others_after  text;
  v_pools_before text;
  v_pools_after  text;
  v_fee_reversal_id uuid;
  v_token uuid;
  v_start_authority text := 'owner_never_seated_release';
BEGIN
  PERFORM set_config('lock_timeout','3s',true);

  -- A database that never held this event (a fresh replay) has nothing to
  -- release. A database that already released it has nothing left to do.
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id=c_t) THEN
    RAISE NOTICE 'owner release: tournament % absent; nothing to do', c_t;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_unregistration_receipts r
              WHERE r.registration_id=c_reg) THEN
    RAISE NOTICE 'owner release: registration % already released', c_reg;
    RETURN;
  END IF;

  -- The canonical order: admission contract, this tournament's lane, then rows.
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(c_t);
  SELECT * INTO v_t FROM public.tournaments WHERE id=c_t FOR UPDATE;
  IF v_t.status::text<>'RUNNING' OR v_t.current_players<>5
     OR v_t.prize_pool<>1245 OR v_t.bounty_pool<>0 OR v_t.total_rake<>25
     OR v_t.starting_chips<>30000 THEN
    RAISE EXCEPTION 'ABORT: tournament state moved: status % players % pool % bounty % rake % start %',
      v_t.status,v_t.current_players,v_t.prize_pool,v_t.bounty_pool,v_t.total_rake,v_t.starting_chips;
  END IF;

  -- The registration: paid, never dealt in, never seated anywhere in this event.
  SELECT * INTO v_reg FROM public.tournament_players WHERE id=c_reg FOR UPDATE;
  IF v_reg.id IS NULL OR v_reg.tournament_id<>c_t OR v_reg.user_id<>c_u
     OR v_reg.status::text<>'registered' OR COALESCE(v_reg.chips,0)<>0
     OR COALESCE(v_reg.chip_count,0)<>0
     OR v_reg.table_id IS NOT NULL OR v_reg.seat_number IS NOT NULL
     OR v_reg.position IS NOT NULL OR COALESCE(v_reg.rebuys,0)<>0
     OR COALESCE(v_reg.add_on,false) OR NOT COALESCE(v_reg.is_satellite_qualifier,false)
     OR v_reg.source_satellite_id IS DISTINCT FROM c_sat THEN
    RAISE EXCEPTION 'ABORT: registration % is not the never-seated satellite entry', c_reg;
  END IF;
  IF (SELECT count(*) FROM public.tournament_players
       WHERE tournament_id=c_t AND user_id=c_u)<>1 THEN
    RAISE EXCEPTION 'ABORT: player holds more than one row in this event';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
              WHERE tb.tournament_id=c_t AND s.user_id=c_u) THEN
    RAISE EXCEPTION 'ABORT: player has held a seat in this event; this release is for a never-seated entry only';
  END IF;

  -- Exactly one open funded entitlement, the satellite seat, 45 + 5.
  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=c_t AND e.user_id=c_u ORDER BY e.entitlement_kind,e.id FOR UPDATE;
  SELECT count(*) INTO v_n FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=c_t AND e.user_id=c_u;
  SELECT * INTO v_e FROM public.tournament_refund_entitlements WHERE id=c_ent;
  IF v_n<>1 OR v_e.tournament_id<>c_t OR v_e.user_id<>c_u
     OR v_e.entitlement_kind<>'satellite_seat' OR v_e.registration_id<>c_reg
     OR v_e.gross<>50 OR v_e.refund_prize<>45 OR v_e.refund_bounty<>0 OR v_e.refund_fee<>5
     OR v_e.refund_wallet_club_id<>c_club OR v_e.source_ledger_id<>c_src_led
     OR v_e.source_satellite_id<>c_sat
     OR EXISTS (SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=c_ent)
     OR EXISTS (SELECT 1 FROM public.tournament_tickets tk WHERE tk.source_refund_entitlement_id=c_ent) THEN
    RAISE EXCEPTION 'ABORT: entitlement % is not the single open 50.00 satellite seat', c_ent;
  END IF;
  IF EXISTS (SELECT 1 FROM public.wallet_transactions w
              WHERE w.related_entity_id=c_t AND w.user_id=c_u) THEN
    RAISE EXCEPTION 'ABORT: player already has wallet rows for this event';
  END IF;

  -- The fee that entry paid: one exact rake row, the one to reverse.
  SELECT * INTO v_fee FROM public.rake_records WHERE id=c_fee_src FOR UPDATE;
  IF v_fee.id IS NULL OR v_fee.tournament_id<>c_t OR NOT v_fee.is_tournament
     OR v_fee.rake_amount<>5 OR v_fee.source<>'fn_award_satellite_seat'
     OR v_fee.metadata->>'kind'<>'satellite_seat_entry_fee'
     OR v_fee.metadata->>'user_id'<>c_u::text
     OR v_fee.metadata->>'registration_id'<>c_reg::text
     OR v_fee.created_at<>(SELECT l.created_at FROM public.chip_ledger l WHERE l.id=c_src_led)
     OR v_fee.club_id IS NULL
     OR (SELECT sum(r.rake_amount) FROM public.rake_records r
          WHERE r.tournament_id=c_t AND r.is_tournament)<>25 THEN
    RAISE EXCEPTION 'ABORT: fee source % does not match the entry', c_fee_src;
  END IF;

  PERFORM public.fn_ca_escrow_apply(c_t,'owner never-seated release escrow prelock');
  SELECT * INTO v_eb FROM public.tournament_escrow WHERE tournament_id=c_t FOR UPDATE;
  IF v_eb.tournament_id IS NULL OR NOT v_eb.enforced OR v_eb.prize_balance<>1245
     OR v_eb.fee_balance<>25 OR v_eb.bounty_balance<>0 THEN
    RAISE EXCEPTION 'ABORT: escrow moved: prize % fee % bounty %',
      v_eb.prize_balance,v_eb.fee_balance,v_eb.bounty_balance;
  END IF;

  -- Fingerprints that must not move: every live seat of this event, every
  -- other member wallet, and every club/union pool.
  SELECT string_agg(s.id::text||':'||s.user_id::text||':'||s.stack::text||':'||s.seat_number::text,
                    ',' ORDER BY s.id) INTO v_seats_before
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=c_t AND s.left_at IS NULL;
  IF public.fn_ca_tournament_felt_total(c_t)<>120000
     OR public.fn_ca_tournament_chip_supply(c_t)<>150000 THEN
    RAISE EXCEPTION 'ABORT: felt/supply moved';
  END IF;
  SELECT md5(string_agg(m.user_id::text||m.club_id::text||m.chip_balance::text, ',' ORDER BY m.user_id,m.club_id))
    INTO v_others_before FROM public.club_members m
   WHERE NOT (m.user_id=c_u AND m.club_id=c_club);
  SELECT md5(COALESCE((SELECT string_agg(c.id::text||c.chip_treasury::text||c.chip_pool::text,',' ORDER BY c.id) FROM public.clubs c),'')
          ||COALESCE((SELECT string_agg(w.club_id::text||w.chip_balance::text,',' ORDER BY w.club_id) FROM public.club_wallets w),'')
          ||COALESCE((SELECT string_agg(u.union_id::text||u.rake_wallet::text,',' ORDER BY u.union_id) FROM public.union_wallets u),''))
    INTO v_pools_before;
  SELECT m.chip_balance INTO v_bal_before FROM public.club_members m
   WHERE m.user_id=c_u AND m.club_id=c_club;

  -- 1. Money, through the platform's exact idempotent refund door.
  v_settle := public.fn_settle_tournament_refund_exact(
    c_t,c_u,c_club,50,45,0,5,'fn_unregister_from_tournament',c_desc);
  IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
     OR (v_settle->>'entitlement_id')::uuid IS DISTINCT FROM c_ent
     OR (v_settle->>'paid')::numeric<>50 OR (v_settle->>'amount_paid')::numeric<>50
     OR (v_settle->>'source_wallet_club_id')::uuid IS DISTINCT FROM c_club THEN
    RAISE EXCEPTION 'ABORT: exact refund door answered %', v_settle;
  END IF;

  -- 2. The fee comes back off the event, in the shape the fee net plan proves.
  INSERT INTO public.rake_records(
    hand_id,table_id,club_id,rake_amount,pot_size,num_players,
    bbj_contribution,is_tournament,tournament_id,source,metadata)
  VALUES(
    NULL,NULL,v_fee.club_id,-5,5,1,0,true,c_t,'fn_unregister_from_tournament',
    jsonb_build_object(
      'kind','tournament_fee_refund','user_id',c_u,'registration_id',c_reg,
      'fee_recipient_club_id',v_fee.club_id,
      'entitlement_ids',jsonb_build_array(c_ent),
      'original_rake_record_ids',jsonb_build_array(c_fee_src),
      'start_authority',v_start_authority,
      'owner_decision','Dan 2026-09-26: refund the 50.00 ticket; do not seat'))
  RETURNING id INTO v_fee_reversal_id;

  -- 3. The event's cached books, compare-and-set.
  UPDATE public.tournaments
     SET current_players=4, prize_pool=1200, bounty_pool=0, total_rake=20, updated_at=now()
   WHERE id=c_t AND current_players=5 AND prize_pool=1245 AND bounty_pool=0 AND total_rake=25;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'ABORT: tournament cache changed'; END IF;

  -- 4. The registration leaves under the unregistration seat-exit authority
  --    (it holds no live seat, so the authority covers zero seats).
  v_token := public.fn_ca_open_tournament_seat_exit_authority(c_t,'unregister',c_u);
  DELETE FROM public.tournament_players WHERE id=c_reg;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'ABORT: registration row not removed'; END IF;
  IF public.fn_ca_close_tournament_seat_exit_authority(v_token,true)<>0 THEN
    RAISE EXCEPTION 'ABORT: seat-exit authority covered a live seat';
  END IF;

  -- 5. The immutable unregistration receipt the fee net plan requires.
  INSERT INTO public.tournament_unregistration_receipts(
    registration_id,request_id,tournament_id,user_id,source_table_id,
    refunded_chips,returned_ticket_value,entitlement_ids,ticket_ids,
    source_wallet_club_ids,credit_ledger_ids,wallet_transaction_ids,
    fees_reversed,fee_reversal_ids,fee_source_rake_record_ids,
    seat_number,seats_taken,scheduled_start_at,start_authority,settled_at)
  VALUES(
    c_reg,c_request,c_t,c_u,NULL,
    50,0,ARRAY[c_ent],ARRAY[]::uuid[],
    ARRAY[c_club],ARRAY[(v_settle->>'credit_ledger_id')::uuid],
    ARRAY[(v_settle->>'wallet_transaction_id')::uuid],
    5,ARRAY[v_fee_reversal_id],ARRAY[c_fee_src],
    NULL,NULL,v_t.start_time,v_start_authority,clock_timestamp());

  -- 6. Read back. Anything off aborts the whole transaction.
  SELECT m.chip_balance INTO v_bal_after FROM public.club_members m
   WHERE m.user_id=c_u AND m.club_id=c_club;
  IF v_bal_after IS DISTINCT FROM round(v_bal_before+50,2) THEN
    RAISE EXCEPTION 'ABORT: wallet % -> % is not +50', v_bal_before, v_bal_after;
  END IF;
  IF (SELECT count(*) FROM public.wallet_transactions w WHERE w.related_entity_id=c_t
       AND w.user_id=c_u AND w.type='credit' AND w.category='refund' AND w.amount=50)<>1
     OR (SELECT count(*) FROM public.wallet_transactions w WHERE w.related_entity_id=c_t AND w.user_id=c_u)<>1
     OR (SELECT count(*) FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=c_ent)<>1
     OR (SELECT count(*) FROM public.chip_ledger l WHERE l.idempotency_key='tourney:'||c_t::text||':refund-entitlement:'||c_ent::text)<>1 THEN
    RAISE EXCEPTION 'ABORT: refund journal is not exactly one leg';
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=c_t;
  SELECT * INTO v_ea FROM public.tournament_escrow WHERE tournament_id=c_t;
  IF v_t.current_players<>4 OR v_t.prize_pool<>1200 OR v_t.total_rake<>20 OR v_t.bounty_pool<>0
     OR v_t.status::text<>'RUNNING'
     OR v_ea.prize_balance<>1200 OR v_ea.fee_balance<>20 OR v_ea.bounty_balance<>0
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=c_t)<>4
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=c_t AND status::text IN ('registered','playing'))<>4
     OR (SELECT sum(r.rake_amount) FROM public.rake_records r WHERE r.tournament_id=c_t AND r.is_tournament)<>20 THEN
    RAISE EXCEPTION 'ABORT: event books after: players % pool % rake % escrow prize % fee %',
      v_t.current_players,v_t.prize_pool,v_t.total_rake,v_ea.prize_balance,v_ea.fee_balance;
  END IF;
  SELECT string_agg(s.id::text||':'||s.user_id::text||':'||s.stack::text||':'||s.seat_number::text,
                    ',' ORDER BY s.id) INTO v_seats_after
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=c_t AND s.left_at IS NULL;
  SELECT md5(string_agg(m.user_id::text||m.club_id::text||m.chip_balance::text, ',' ORDER BY m.user_id,m.club_id))
    INTO v_others_after FROM public.club_members m
   WHERE NOT (m.user_id=c_u AND m.club_id=c_club);
  SELECT md5(COALESCE((SELECT string_agg(c.id::text||c.chip_treasury::text||c.chip_pool::text,',' ORDER BY c.id) FROM public.clubs c),'')
          ||COALESCE((SELECT string_agg(w.club_id::text||w.chip_balance::text,',' ORDER BY w.club_id) FROM public.club_wallets w),'')
          ||COALESCE((SELECT string_agg(u.union_id::text||u.rake_wallet::text,',' ORDER BY u.union_id) FROM public.union_wallets u),''))
    INTO v_pools_after;
  IF v_seats_after IS DISTINCT FROM v_seats_before THEN
    RAISE EXCEPTION 'ABORT: a live seat moved';
  END IF;
  IF v_others_after IS DISTINCT FROM v_others_before OR v_pools_after IS DISTINCT FROM v_pools_before THEN
    RAISE EXCEPTION 'ABORT: a balance other than the refunded wallet moved';
  END IF;
  IF public.fn_ca_tournament_felt_total(c_t)<>120000
     OR public.fn_ca_tournament_chip_supply(c_t)<>120000
     OR EXISTS (SELECT 1 FROM public.fn_tournament_chip_conservation_check(0) x WHERE x.tournament_id=c_t)
     OR public.fn_tournament_conservation_delta(c_t)<>1200 THEN
    RAISE EXCEPTION 'ABORT: conservation after: felt % supply % delta %',
      public.fn_ca_tournament_felt_total(c_t),public.fn_ca_tournament_chip_supply(c_t),
      public.fn_tournament_conservation_delta(c_t);
  END IF;
  v_plan := public.fn_accounting_tournament_fee_net_plan(c_t);
  IF v_plan->>'status'<>'proven' OR (v_plan->>'net_fee')::numeric<>20
     OR (v_plan->>'refunded_fee')::numeric<>5 THEN
    RAISE EXCEPTION 'ABORT: fee net plan %', v_plan;
  END IF;
  PERFORM * FROM public.fn_ca_tournament_refund_plan(c_t,c_u);
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'owner release: registration % refunded 50.00 to wallet (% -> %), fee reversal %, receipt request %',
    c_reg, v_bal_before, v_bal_after, v_fee_reversal_id, c_request;
END
$release$;

COMMIT;
