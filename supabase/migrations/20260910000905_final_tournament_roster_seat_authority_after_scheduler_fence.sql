-- 20260910000905_final_tournament_roster_seat_authority_after_scheduler_fence.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- M6 installed one-use seat-exit capabilities around every tournament
-- lifecycle owner. Later migrations replaced the public satellite and
-- exact-unregistration functions. The satellite implementation remains the
-- final core and is captured from either replay history. Exact unregistration
-- is instead re-emitted from its complete ticket-only actual-start definition:
-- a later cash patch contradicted the binding rule that satellite-funded entry
-- value can return only as a tournament ticket. Both public functions then get
-- identical capability wrappers on clean replay and live-after-M6 histories.
--
-- The reciprocal invariant is installed at the same boundary. In a RUNNING
-- event, a positive playing roster and its one live chair are one deferred
-- commit fact: user, tournament, table, seat number and stack must all agree.
-- A live chair cannot outlive that exact roster, registered cannot survive the
-- RUNNING transition, and zero-chip playing rows cannot retain a chair. The two
-- periodic mutation sweeps existed only to repair violations of that fact, so
-- their functions, state table and detector registration retire.

-- Phase B runs only after the scheduler fence is durable.
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL transaction_timeout = '180s';

SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:job:eliminate-absent-tournament-players:v1',0));
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:job:release-broke-seats:v1',0));

DO $preflight$
DECLARE
  v_pristine boolean;
BEGIN
  IF to_regclass('public.tournament_seat_exit_authority_cutover') IS NULL
     OR to_regclass(
          'public.tournament_mutator_scheduler_retirement_receipts') IS NULL
     OR to_regprocedure(
          'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'final tournament seat authority requires M6 first'
      USING ERRCODE='55000';
  END IF;

  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
  ) INTO v_pristine;

  IF NOT v_pristine
     AND (to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL
          OR public.fn_entry_purchases_frozen() IS NOT TRUE) THEN
    RAISE EXCEPTION
      'final tournament roster-seat cutover requires the maintenance entry freeze'
      USING ERRCODE='55006';
  END IF;

  IF to_regclass('public.tournament_place_settlement_batches') IS NULL
     OR to_regclass('public.tournament_satellite_settlement_batches') IS NULL
     OR to_regclass('public.tournament_terminal_settlements') IS NULL
     OR to_regclass('public.tournament_cancellation_receipts') IS NULL THEN
    RAISE EXCEPTION 'final tournament authority is missing terminal evidence tables'
      USING ERRCODE='55000';
  END IF;
END;
$preflight$;

-- Phase A committed the tombstones and job disabling in an earlier migration,
-- but CREATE OR REPLACE cannot change a PL/pgSQL invocation that had already
-- entered its old body. Use the durably captured pg_cron IDs plus live command
-- text to refuse the cutover if one survived. Phase A retained each disabled
-- cron row, so the run-history join cannot lose its identity before this proof.
DO $drain_pre_tombstone_tournament_mutator_invocations$
DECLARE
  v_job_ids bigint[];
BEGIN
  SELECT r.job_ids INTO STRICT v_job_ids
    FROM public.tournament_mutator_scheduler_retirement_receipts r
   WHERE r.migration_version='20260910000850';

  PERFORM pg_stat_clear_snapshot();
  IF EXISTS (
    SELECT 1 FROM cron.job_run_details d
     WHERE d.jobid=ANY(v_job_ids)
       AND d.end_time IS NULL)
     OR EXISTS (
    SELECT 1
      FROM pg_stat_activity a
      LEFT JOIN cron.job_run_details d
        ON d.job_pid=a.pid
       AND d.jobid=ANY(v_job_ids)
       AND d.end_time IS NULL
       AND (d.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
         OR d.command ILIKE '%fn_ca_release_broke_seats%')
     WHERE a.pid<>pg_backend_pid()
       AND a.datname=current_database()
       AND a.state<>'idle'
       AND (
         a.query ILIKE '%fn_ca_eliminate_absent_tournament_players%'
         OR a.query ILIKE '%fn_ca_release_broke_seats%'
         OR d.job_pid IS NOT NULL)) THEN
    RAISE EXCEPTION
      'a pre-tombstone tournament mutator invocation is still active'
      USING ERRCODE='55006';
  END IF;
END;
$drain_pre_tombstone_tournament_mutator_invocations$;

DO $unschedule_disabled_tournament_mutator_jobs$
DECLARE
  v_job_ids bigint[];
  r record;
BEGIN
  SELECT x.job_ids INTO STRICT v_job_ids
    FROM public.tournament_mutator_scheduler_retirement_receipts x
   WHERE x.migration_version='20260910000850';

  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids) AND j.active) THEN
    RAISE EXCEPTION 'a tournament mutator job was reactivated after Phase A'
      USING ERRCODE='55006';
  END IF;

  FOR r IN
    SELECT j.jobid FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids)
     ORDER BY j.jobid
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids)
        OR j.jobname IN (
             'ca-eliminate-absent-players','ca-release-broke-seats')
        OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
        OR j.command ILIKE '%fn_ca_release_broke_seats%') THEN
    RAISE EXCEPTION 'a retired tournament mutator schedule survived unscheduling';
  END IF;
END;
$unschedule_disabled_tournament_mutator_jobs$;

-- Match the established lifecycle lock order and drain any older child writer
-- before function capture, healer retirement or invariant installation.
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournament_players IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.table_seats IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournament_knockout_candidates
  IN SHARE ROW EXCLUSIVE MODE;

-- The binding product rule is explicit: a target entry funded by a satellite
-- win can unregister only into a tournament-entry ticket, never wallet chips.
-- This is the complete ticket-only actual-start implementation, emitted
-- statically under the final private name. The later cash patch is intentionally
-- not captured on either replay history.
CREATE FUNCTION public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_table_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $ticket_only_unregister_seat_exit_core_v2$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_reg public.tournament_players%ROWTYPE;
  v_ent record;
  v_fee_group record;
  v_settle jsonb;
  v_ticket jsonb;
  v_receipt jsonb;
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
  v_players_before integer;
  v_rows integer;
  v_seat_number integer;
  v_seats_taken integer;
  v_non_cash_count integer;
  v_wallet_debits numeric:=0;
  v_wallet_refunds_before numeric:=0;
  v_wallet_refunds_after numeric:=0;
  v_entitled_wallet_total numeric:=0;
  v_tranche_total numeric:=0;
  v_refund_prize numeric:=0;
  v_refund_bounty numeric:=0;
  v_refund_fee numeric:=0;
  v_refund_total numeric:=0;
  v_wallet_amount numeric:=0;
  v_ticket_amount numeric:=0;
  v_running_owed numeric:=0;
  v_rake_before numeric:=0;
  v_rake_after numeric:=0;
  v_fees_reversed numeric:=0;
  v_entitlement_ids uuid[]:='{}'::uuid[];
  v_ticket_ids uuid[]:='{}'::uuid[];
  v_credit_ledger_ids uuid[]:='{}'::uuid[];
  v_wallet_transaction_ids uuid[]:='{}'::uuid[];
  v_source_wallet_club_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_ids uuid[]:='{}'::uuid[];
  v_fee_source_rake_record_ids uuid[]:='{}'::uuid[];
  v_fee_entitlement_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_id uuid;
  v_fee_source_count integer:=0;
  v_fee_source_entitlement_count integer:=0;
  v_fee_source_amount numeric:=0;
  v_request_id uuid:=COALESCE(p_request_id,gen_random_uuid());
  v_start_authority text:='scheduled_clock';
  v_launch_completed_at timestamptz;
  v_persisted_hand_exists boolean:=false;
  v_actual_status text;
  v_actual_started_at timestamptz;
  v_unregistered_at timestamptz;
  v_description text:=COALESCE(
    NULLIF(btrim(p_description),''),'Tournament unregistration refund');
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player ids are required'
      USING ERRCODE='22004';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- Spins and Heads-Up Sit & Gos are separate products, but both are
  -- seat-first: start_time is only their human fill-window deadline. Neither
  -- product has a scheduled start. Satellite feeders remain outside this
  -- change and retain the existing scheduled-clock contract.
  IF v_t.satellite_target_id IS NULL
     AND upper(COALESCE(v_t.tournament_type::text,''))<>'SATELLITE'
     AND (lower(COALESCE(v_t.variant::text,''))='spin'
       OR upper(COALESCE(v_t.tournament_type::text,''))='SPIN') THEN
    v_start_authority:='spin_actual_start';
  ELSIF v_t.satellite_target_id IS NULL
     AND upper(COALESCE(v_t.tournament_type::text,''))='SNG'
     AND lower(COALESCE(v_t.variant::text,''))<>'spin'
     AND COALESCE(v_t.max_players,0)=2 THEN
    v_start_authority:='heads_up_sng_actual_start';
  END IF;

  -- A caller-supplied request id is a durable operation identity. It may only
  -- name this exact player/event/endpoint scope. If its pre-start outcome is
  -- already committed, replay that immutable outcome even when the wall clock
  -- is now past the start; this branch performs no new unregistration writes.
  IF p_request_id IS NOT NULL THEN
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id
         AND (r.tournament_id IS DISTINCT FROM p_tournament_id
           OR r.user_id IS DISTINCT FROM p_user_id
           OR r.source_table_id IS DISTINCT FROM p_expected_table_id)) THEN
      RAISE EXCEPTION 'unregistration request id belongs to another intent'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id) THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,p_request_id);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
      RAISE EXCEPTION
        'unregistration request id belongs to a prior registration lifecycle'
        USING ERRCODE='P0404';
    END IF;
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     AND tp.status::text IN ('registered','playing')
   ORDER BY tp.id LIMIT 1 FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;

  -- A persisted hand is stronger actual-start evidence than either a mutable
  -- parent status or a launch receipt that an interrupted launcher failed to
  -- complete. Canonical accepted-hand commits carry tournament_id; the
  -- table-linked branch also fails closed for older rows that omitted it. The
  -- exclusive lifecycle advisory lock above serializes this read against the
  -- shared lock held by every canonical accepted-hand commit.
  SELECT EXISTS (
           SELECT 1
             FROM public.hand_history hh
            WHERE hh.tournament_id=p_tournament_id
         ) OR EXISTS (
           SELECT 1
             FROM public.tables hand_table
             JOIN public.hand_history hh ON hh.table_id=hand_table.id
            WHERE hand_table.tournament_id=p_tournament_id
         )
    INTO v_persisted_hand_exists;
  IF v_persisted_hand_exists THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_start_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE
    SELECT r.completed_at INTO v_launch_completed_at
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id=p_tournament_id;
    IF v_t.started_at IS NOT NULL OR v_launch_completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  END IF;
  IF v_reg.id IS NULL THEN
    -- Rolling clients without a request id may recover a just-lost response
    -- only while registration remains open. They can never turn an old receipt
    -- into a successful post-start response.
    IF p_request_id IS NULL THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,NULL);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT s.seat_number INTO v_seat_number
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id
       AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
     ORDER BY s.id LIMIT 1 FOR UPDATE OF s;
    IF v_seat_number IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_seated');
    END IF;
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok',false,'reason','spin_entry_already_booked');
  END IF;

  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
   ORDER BY e.entitlement_kind,e.id FOR UPDATE;
  SELECT count(*) INTO v_non_cash_count
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.registration_id=v_reg.id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id);
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>1 THEN
    RAISE EXCEPTION
      'satellite-funded registration % requires one unspent ticket entitlement',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  IF NOT COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>0 THEN
    RAISE EXCEPTION
      'cash registration % cannot own a satellite ticket entitlement',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(e.refund_prize),0),2),
         round(COALESCE(sum(e.refund_bounty),0),2),
         round(COALESCE(sum(e.refund_fee),0),2),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind='wallet_charge'),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind IN ('satellite_seat','tournament_ticket')),0),2)
    INTO v_refund_prize,v_refund_bounty,v_refund_fee,v_refund_total,
         v_wallet_amount,v_ticket_amount
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  IF v_refund_total IS DISTINCT FROM
       round(v_refund_prize+v_refund_bounty+v_refund_fee,2)
     OR v_refund_total IS DISTINCT FROM
       round(v_wallet_amount+v_ticket_amount,2) THEN
    RAISE EXCEPTION 'registration % has invalid entitlement totals',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  -- A satellite seat, including a returned ticket that was used for a later
  -- target entry, is a noncash entry for its entire registration lifecycle.
  -- Any wallet-charge entitlement attached to that registration is corrupt;
  -- refuse the whole transaction instead of ever returning chips.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND (v_wallet_amount<>0 OR v_ticket_amount<=0
       OR v_refund_total IS DISTINCT FROM v_ticket_amount) THEN
    RAISE EXCEPTION
      'satellite-funded registration % can return only a tournament ticket',
      v_reg.id USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_debits
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(e.gross),0),2) INTO v_entitled_wallet_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge';
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT round(COALESCE(sum(tr.amount_paid_now),0),2) INTO v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_wallet_debits IS DISTINCT FROM v_entitled_wallet_total
     OR v_wallet_refunds_before IS DISTINCT FROM v_tranche_total
     OR v_wallet_refunds_before>v_wallet_debits THEN
    RAISE EXCEPTION 'registration % wallet and entitlement journals disagree',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  v_running_owed:=v_tranche_total;

  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_before
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[])
    INTO v_fee_entitlement_ids
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND e.refund_fee>0
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);

  -- Bind every fee-bearing entitlement to its actual same-transaction rake
  -- journal. The refund wallet club is deliberately absent from this match:
  -- it identifies the payer, while rake_records.club_id identifies the fee
  -- recipient and can be a different club.
  WITH fee_sources AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id,
           r.club_id,r.rake_amount
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_fee_entitlement_ids)
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         round(COALESCE(sum(rake_amount),0),2),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_source_count,v_fee_source_entitlement_count,
         v_fee_source_amount,v_fee_source_rake_record_ids
    FROM fee_sources;
  IF v_fee_source_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_entitlement_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_count<>(
       SELECT count(DISTINCT id)
         FROM unnest(v_fee_source_rake_record_ids) source(id))
     OR v_fee_source_amount IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % fee entitlements do not map one-to-one to exact rake evidence',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  PERFORM 1 FROM public.rake_records r
   WHERE r.id=ANY(v_fee_source_rake_record_ids)
   ORDER BY r.club_id,r.id FOR UPDATE;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'unregister entitlement escrow prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_players_before<=0
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance
     OR v_t.total_rake IS DISTINCT FROM v_rake_before
     OR v_t.prize_pool<v_refund_prize
     OR v_t.bounty_pool<v_refund_bounty
     OR v_t.total_rake<v_refund_fee THEN
    RAISE EXCEPTION 'registration % cannot leave divergent tournament state',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.entitlement_kind='wallet_charge'
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_running_owed:=round(v_running_owed+v_ent.gross,2);
    v_settle:=public.fn_settle_tournament_refund_exact(
      p_tournament_id,p_user_id,v_ent.refund_wallet_club_id,v_running_owed,
      v_ent.refund_prize,v_ent.refund_bounty,v_ent.refund_fee,
      'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
       OR (v_settle->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_settle->>'amount_paid')::numeric IS DISTINCT FROM v_running_owed
       OR (v_settle->>'source_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id THEN
      RAISE EXCEPTION 'registration % exact wallet refund failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_credit_ledger_ids:=array_append(
      v_credit_ledger_ids,(v_settle->>'credit_ledger_id')::uuid);
    v_wallet_transaction_ids:=array_append(
      v_wallet_transaction_ids,(v_settle->>'wallet_transaction_id')::uuid);
  END LOOP;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.registration_id=v_reg.id
       AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
      v_ent.id,'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
       OR (v_ticket->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_ticket->>'refund_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id
       OR (v_ticket->>'ticket_id') IS NULL THEN
      RAISE EXCEPTION 'registration % tournament-ticket return failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_ticket_ids:=array_append(v_ticket_ids,(v_ticket->>'ticket_id')::uuid);
  END LOOP;

  FOR v_fee_group IN
    SELECT r.club_id,round(sum(r.rake_amount),2) AS fee,
           array_agg(r.id ORDER BY r.id) AS source_rake_record_ids,
           array_agg(e.id ORDER BY e.id) AS entitlement_ids
      FROM public.rake_records r
      JOIN public.tournament_refund_entitlements e
        ON e.id=ANY(v_fee_entitlement_ids)
       AND e.refund_fee=r.rake_amount
       AND e.tournament_id=r.tournament_id
       AND e.user_id=p_user_id
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
      JOIN public.chip_ledger l
        ON l.id=e.source_ledger_id AND l.created_at=r.created_at
     WHERE r.id=ANY(v_fee_source_rake_record_ids)
     GROUP BY r.club_id ORDER BY r.club_id
  LOOP
    IF v_fee_group.fee>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,metadata)
      VALUES(
        NULL,NULL,v_fee_group.club_id,-v_fee_group.fee,v_fee_group.fee,1,
        0,true,p_tournament_id,'fn_unregister_from_tournament',
        jsonb_build_object(
          'kind','tournament_fee_refund','user_id',p_user_id,
          'registration_id',v_reg.id,
          'fee_recipient_club_id',v_fee_group.club_id,
          'entitlement_ids',to_jsonb(v_fee_group.entitlement_ids),
          'original_rake_record_ids',
            to_jsonb(v_fee_group.source_rake_record_ids)))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(
        v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee_group.fee,2);
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids
    FROM unnest(v_fee_reversal_ids) reversal(id);
  IF v_fees_reversed IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % reversed % in exact fee rows but owes %',
      v_reg.id,v_fees_reversed,v_refund_fee USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(v_t.prize_pool-v_refund_prize,2),
         bounty_pool=round(v_t.bounty_pool-v_refund_bounty,2),
         total_rake=round(v_t.total_rake-v_refund_fee,2),updated_at=now()
   WHERE id=p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_players_before
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % tournament cache changed',v_reg.id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,
         scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb
                 WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s
                           WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % was not deleted after settlement',v_reg.id
      USING ERRCODE='40001';
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_after
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.status::text IN ('registered','playing'))<>v_players_before-1
     OR v_wallet_refunds_after IS DISTINCT FROM
          round(v_wallet_refunds_before+v_wallet_amount,2)
     OR v_escrow_after.prize_balance IS DISTINCT FROM
          round(v_escrow_before.prize_balance-v_refund_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
          round(v_escrow_before.bounty_balance-v_refund_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
          round(v_escrow_before.fee_balance-v_refund_fee,2)
     OR v_rake_after IS DISTINCT FROM round(v_rake_before-v_refund_fee,2)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=p_tournament_id
          AND t.current_players=v_players_before-1
          AND t.prize_pool=v_escrow_after.prize_balance
          AND t.bounty_pool=v_escrow_after.bounty_balance
          AND t.total_rake=v_rake_after) THEN
    RAISE EXCEPTION 'registration % did not leave exact final state',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT count(*) INTO v_seats_taken FROM public.table_seats s
     WHERE s.table_id=p_expected_table_id AND s.left_at IS NULL;
  END IF;

  -- Re-prove the chosen start authority after all money and seat work. Timed
  -- events still use the locked schedule cutoff; every product also treats a
  -- persisted hand as irreversible start truth; seat-first products further
  -- use status, started_at and completed launch truth. Any loss of the race
  -- rolls every preceding write back atomically.
  v_unregistered_at:=clock_timestamp();
  SELECT EXISTS (
           SELECT 1
             FROM public.hand_history hh
            WHERE hh.tournament_id=p_tournament_id
         ) OR EXISTS (
           SELECT 1
             FROM public.tables hand_table
             JOIN public.hand_history hh ON hh.table_id=hand_table.id
            WHERE hand_table.tournament_id=p_tournament_id
         )
    INTO v_persisted_hand_exists;
  IF v_persisted_hand_exists THEN
    RAISE EXCEPTION
      'tournament hand persisted before unregistration could commit'
      USING ERRCODE='55000';
  END IF;
  IF v_start_authority='scheduled_clock' THEN
    IF v_unregistered_at>=v_t.start_time THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE
    SELECT t.status::text,t.started_at,launch.completed_at
      INTO v_actual_status,v_actual_started_at,v_launch_completed_at
      FROM public.tournaments t
      LEFT JOIN public.tournament_launch_receipts launch
        ON launch.tournament_id=t.id
     WHERE t.id=p_tournament_id;
    IF upper(COALESCE(v_actual_status,'')) NOT IN ('ANNOUNCED','REGISTERING')
       OR v_actual_started_at IS NOT NULL
       OR v_launch_completed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'seat-first tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  END IF;

  INSERT INTO public.tournament_unregistration_receipts(
    registration_id,request_id,tournament_id,user_id,source_table_id,
    refunded_chips,returned_ticket_value,entitlement_ids,ticket_ids,
    source_wallet_club_ids,credit_ledger_ids,wallet_transaction_ids,
    fees_reversed,fee_reversal_ids,fee_source_rake_record_ids,
    seat_number,seats_taken,scheduled_start_at,start_authority,settled_at)
  VALUES(
    v_reg.id,v_request_id,p_tournament_id,p_user_id,p_expected_table_id,
    v_wallet_amount,v_ticket_amount,v_entitlement_ids,v_ticket_ids,
    v_source_wallet_club_ids,v_credit_ledger_ids,v_wallet_transaction_ids,
    v_fees_reversed,v_fee_reversal_ids,v_fee_source_rake_record_ids,
    v_seat_number,v_seats_taken,v_t.start_time,v_start_authority,v_unregistered_at);
  v_receipt:=public.fn_ca_tournament_unregistration_receipt(
    p_tournament_id,p_user_id,p_expected_table_id,v_request_id);
  IF v_receipt IS NULL
     OR (v_receipt->>'registration_id')::uuid IS DISTINCT FROM v_reg.id THEN
    RAISE EXCEPTION 'registration % has no exact unregistration receipt',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  RETURN v_receipt||jsonb_build_object('replayed',false);
END;
$ticket_only_unregister_seat_exit_core_v2$;

-- The later satellite body is still canonical: a wrapper source names the M6
-- private core, otherwise the public body is the newest core. Exact
-- unregistration is deliberately not captured here because the later cash
-- patch contradicted the binding ticket-only satellite-exit contract.
DO $capture_final_late_cores$
DECLARE
  v_source text;
BEGIN
  IF to_regprocedure(
       'public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'a reserved final seat-exit core name already exists'
      USING ERRCODE='42710';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure;
  IF position('fn_settle_satellite_tournament_pre_seat_guard'
              IN v_source)>0
     AND position('fn_ca_open_tournament_seat_exit_authority'
                  IN v_source)>0 THEN
    IF to_regprocedure(
         'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)') IS NULL THEN
      RAISE EXCEPTION 'satellite wrapper lost its private core';
    END IF;
    ALTER FUNCTION
      public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)
      RENAME TO fn_settle_satellite_tournament_seat_exit_core_v2;
  ELSE
    ALTER FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
      RENAME TO fn_settle_satellite_tournament_seat_exit_core_v2;
  END IF;
END;
$capture_final_late_cores$;

REVOKE ALL ON FUNCTION
  public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(
    uuid,uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_table_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $unregister_with_final_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_live_seats integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT count(*) INTO v_live_seats
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_seats>1 THEN
    RAISE EXCEPTION
      'tournament player % has % live seats; exact unregistration refuses ambiguous chips',
      p_user_id,v_live_seats USING ERRCODE='P0404';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'unregister',p_user_id);
  BEGIN
    v_result:=
      public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(
        p_tournament_id,p_user_id,p_expected_table_id,p_description,p_request_id);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$unregister_with_final_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_unregister_tournament_player_exact(
  uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(
  p_tournament_id uuid,p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $satellite_with_final_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
  v_target_id uuid;
  v_target_status text;
  v_user_id uuid;
  v_award record;
  v_assignment jsonb;
  v_seat_award_count integer;
  v_assigned_count integer:=0;
  v_exact_count integer;
  v_was_already_settled boolean:=false;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'satellite settlement requires service authority'
      USING ERRCODE='28000';
  END IF;

  -- A RUNNING target award changes the beneficiary from registered to seated
  -- in this same transaction. Take the canonical acquisition prefix before
  -- the source exit opener or the settlement core can lock any roster/chair.
  -- Every source player is bounded by the locked field and is acquired in UUID
  -- order; the exact award subset is not known until the core atomically fixes
  -- the target admission plan.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  SELECT true INTO v_was_already_settled
    FROM public.tournament_satellite_settlements settlement
   WHERE settlement.tournament_id=p_tournament_id;
  v_was_already_settled:=FOUND;
  IF NOT v_was_already_settled THEN
    FOR v_user_id IN
      SELECT DISTINCT tp.user_id
        FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
       ORDER BY tp.user_id
    LOOP
      PERFORM public.fn_lock_daily_mission_user(v_user_id);
    END LOOP;
  END IF;

  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'satellite_finish',NULL);
  BEGIN
    v_result:=public.fn_settle_satellite_tournament_seat_exit_core_v2(
      p_tournament_id,p_observed_winner_id);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite core returned no successful exact receipt: %',
        v_result USING ERRCODE='P0404';
    END IF;

    SELECT settlement.target_id,upper(COALESCE(target.status::text,''))
      INTO STRICT v_target_id,v_target_status
      FROM public.tournament_satellite_settlements settlement
      JOIN public.tournaments target ON target.id=settlement.target_id
     WHERE settlement.tournament_id=p_tournament_id
     FOR UPDATE OF target;
    IF (v_result->>'target_id')::uuid IS DISTINCT FROM v_target_id THEN
      RAISE EXCEPTION
        'satellite core target disagrees with its immutable settlement header'
        USING ERRCODE='P0404';
    END IF;

    SELECT count(*)::integer INTO v_seat_award_count
      FROM public.tournament_satellite_awards award
     WHERE award.tournament_id=p_tournament_id
       AND award.delivery_kind='seat';
    IF (v_result->>'seat_count')::integer IS DISTINCT FROM v_seat_award_count THEN
      RAISE EXCEPTION
        'satellite core seat count disagrees with its immutable award rows'
        USING ERRCODE='P0404';
    END IF;

    -- REGISTERING targets deliberately retain zero-chip registrations until
    -- launch. A RUNNING target has no such intermediate state: choose/create
    -- one legal chair and promote every funded qualifier before the deferred
    -- reciprocal roster-seat invariant is allowed to run at commit.
    IF NOT v_was_already_settled AND v_target_status='RUNNING' THEN
      FOR v_award IN
        SELECT award.user_id,award.registration_id,award.place
          FROM public.tournament_satellite_awards award
         WHERE award.tournament_id=p_tournament_id
           AND award.delivery_kind='seat'
         ORDER BY award.user_id,award.place
      LOOP
        v_assignment:=public.fn_assign_tournament_player_seat_atomic(
          v_target_id,v_award.user_id,NULL,NULL);
        IF COALESCE((v_assignment->>'ok')::boolean,false) IS NOT TRUE
           OR (v_assignment->>'tournament_id')::uuid IS DISTINCT FROM v_target_id
           OR (v_assignment->>'user_id')::uuid IS DISTINCT FROM v_award.user_id
           OR v_assignment->>'table_id' IS NULL
           OR v_assignment->>'seat_id' IS NULL
           OR v_assignment->>'seat_number' IS NULL
           OR v_assignment->>'stack' IS NULL
           OR (v_assignment->>'stack')::numeric<=0 THEN
          RAISE EXCEPTION
            'RUNNING satellite target award % has no exact atomic chair receipt: %',
            v_award.place,v_assignment USING ERRCODE='P0404';
        END IF;

        SELECT count(*)::integer INTO v_exact_count
          FROM public.tournament_players tp
          JOIN public.table_seats seat
            ON seat.table_id=tp.table_id
           AND seat.seat_number=tp.seat_number
           AND seat.user_id=tp.user_id
           AND seat.left_at IS NULL
          JOIN public.tables target_table
            ON target_table.id=seat.table_id
           AND target_table.tournament_id=v_target_id
         WHERE tp.id=v_award.registration_id
           AND tp.tournament_id=v_target_id
           AND tp.user_id=v_award.user_id
           AND tp.status::text='playing'
           AND COALESCE(tp.chips,0)>0
           AND COALESCE(tp.is_satellite_qualifier,false)
           AND tp.source_satellite_id=p_tournament_id
           AND seat.id=(v_assignment->>'seat_id')::uuid
           AND seat.table_id=(v_assignment->>'table_id')::uuid
           AND seat.seat_number=(v_assignment->>'seat_number')::integer
           AND seat.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric
           AND tp.chips::numeric IS NOT DISTINCT FROM
                 (v_assignment->>'stack')::numeric
           AND (SELECT count(*)
                  FROM public.table_seats exact_seat
                  JOIN public.tables exact_table
                    ON exact_table.id=exact_seat.table_id
                   AND exact_table.tournament_id=v_target_id
                 WHERE exact_seat.user_id=v_award.user_id
                   AND exact_seat.left_at IS NULL)=1;
        IF v_exact_count<>1 THEN
          RAISE EXCEPTION
            'RUNNING satellite target award % did not become one exact funded roster-seat generation',
            v_award.place USING ERRCODE='P0404';
        END IF;
        v_assigned_count:=v_assigned_count+1;
      END LOOP;
      IF v_assigned_count<>v_seat_award_count THEN
        RAISE EXCEPTION
          'RUNNING satellite target assigned % of % immutable seat awards',
          v_assigned_count,v_seat_award_count USING ERRCODE='P0404';
      END IF;
    END IF;

    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$satellite_with_final_seat_authority$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  TO service_role;

-- The new wrappers are the only callers of these v2 cores. The older M6 names
-- are stale on replay and were renamed away on live-after-M6 history.
DROP FUNCTION IF EXISTS
  public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(
    uuid,uuid,uuid,text,uuid) RESTRICT;
DROP FUNCTION IF EXISTS
 public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid) RESTRICT;

-- Re-emit the final ticket-admission authority statically. The post-M6 source
-- regressed to a capacity helper that had already been retired and treated an
-- ambiguous seat response as success without proving what was on the felt.
-- The canonical bounded capacity owner and the exact reciprocal postcondition
-- keep funding, roster and chair in the same transaction.
CREATE OR REPLACE FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(
  p_tournament_id uuid,
  p_ticket_id uuid,
  p_beneficiary_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $ticket_admission_for$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_split record;
  v_username text;
  v_registration_id uuid;
  v_ledger_id uuid;
  v_tx_id uuid;
  v_entitlement_id uuid;
  v_resolved_club uuid;
  v_is_bounty boolean;
  v_late_open boolean:=false;
  v_start_chips integer:=0;
  v_seat jsonb;
  v_seat_reason text;
  v_players_before integer;
  v_wallet_rows_before bigint;
  v_wallet_rows_after bigint;
  v_rows integer;
  v_key text;
  v_ticket_use_token uuid:=gen_random_uuid();
  v_previous_ticket_use_token text:=
    current_setting('app.ca_satellite_ticket_use_token',true);
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_ticket_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament, ticket and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.id=p_ticket_id FOR UPDATE;
  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found');
  END IF;
  IF v_ticket.holder_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_owned');
  END IF;
  IF v_ticket.redemption_mode IS DISTINCT FROM 'tournament_entry_only' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_is_wallet_only');
  END IF;

  IF v_ticket.source_refund_entitlement_id IS NOT NULL THEN
    SELECT count(*) INTO v_rows
      FROM public.tournament_refund_entitlements source_e
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key='tourney:'
             ||source_e.tournament_id::text
             ||':satellite-ticket-return:'||source_e.id::text
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_e.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
     WHERE source_e.id=v_ticket.source_refund_entitlement_id
       AND v_ticket.source_satellite_award_place IS NULL
       AND source_e.user_id=v_uid
       AND source_e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND source_e.gross=v_ticket.value
       AND source_e.refund_prize=v_ticket.entry_prize
       AND source_e.refund_bounty=v_ticket.entry_bounty
       AND source_e.refund_fee=v_ticket.entry_fee
       AND source_e.source_satellite_id=v_ticket.source_satellite_id
       AND source_e.tournament_id=v_ticket.source_tournament_id
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=source_e.id)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1;
  ELSE
    -- A cap-blocked satellite winner never held a target registration, so its
    -- noncash ticket is sourced directly by the immutable satellite award.
    SELECT count(*) INTO v_rows
      FROM public.tournament_satellite_awards source_a
      JOIN public.tournament_satellite_settlements source_h
        ON source_h.tournament_id=source_a.tournament_id
      JOIN public.tournament_payouts source_p ON source_p.id=source_a.payout_id
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key=source_a.idempotency_key||':ticket_escrow'
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_a.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
       AND issue_l.tournament_id=source_a.tournament_id
       AND issue_l.metadata->>'kind'='direct_satellite_entry_ticket'
       AND issue_l.metadata->>'ticket_id'=v_ticket.id::text
       AND issue_l.metadata->>'payout_id'=source_a.payout_id::text
       AND issue_l.metadata->>'satellite_target_id'=
             v_ticket.source_tournament_id::text
       AND issue_l.metadata->>'user_id'=source_a.user_id::text
       AND issue_l.metadata->>'position'=source_a.place::text
     WHERE source_a.tournament_id=v_ticket.source_satellite_id
       AND source_a.place=v_ticket.source_satellite_award_place
       AND source_a.user_id=v_uid
       AND source_a.delivery_kind='ticket'
       AND source_a.ticket_id=v_ticket.id
       AND source_a.amount=v_ticket.value
       AND source_a.payout_source='satellite_ticket'
       AND source_p.tournament_id=source_a.tournament_id
       AND source_p.user_id=source_a.user_id
       AND source_p."position"=source_a.place
       AND source_p.amount=source_a.amount
       AND source_p.source=source_a.payout_source
       AND source_p.idempotency_key=source_a.idempotency_key
       AND source_h.target_id=v_ticket.source_tournament_id
       AND source_h.ticket_cost=v_ticket.value
       AND source_h.target_buy_in=v_ticket.entry_prize
       AND source_h.target_fee=v_ticket.entry_fee
       AND p_tournament_id=v_ticket.source_tournament_id
       AND v_ticket.entry_bounty=0
       AND NOT EXISTS(
         SELECT 1 FROM public.wallet_credit_idempotency wallet_key
          WHERE wallet_key.key=source_a.idempotency_key)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'source_tournament_id'=
                     p_tournament_id::text
               AND issue_tx.metadata->>'source_satellite_id'=source_a.tournament_id::text
               AND issue_tx.metadata->>'source_award_place'=source_a.place::text
               AND issue_tx.metadata->>'payout_id'=source_a.payout_id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text
               AND issue_tx.metadata->>'idempotency_key'=
                     source_a.idempotency_key)=1;
  END IF;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket has no exact noncash issue evidence'
      USING ERRCODE='P0404';
  END IF;

  IF v_ticket.status='redeemed' THEN
    SELECT count(*),min(e.id::text)::uuid,min(e.registration_id::text)::uuid
      INTO v_rows,v_entitlement_id,v_registration_id
      FROM public.tournament_refund_entitlements e
      JOIN public.tournament_players tp ON tp.id=e.registration_id
     WHERE e.source_ticket_id=v_ticket.id
       AND e.entitlement_kind='tournament_ticket'
       AND e.tournament_id=p_tournament_id
       AND e.user_id=v_uid
       AND tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id;
    IF v_rows=1 AND v_entitlement_id IS NOT NULL
       AND v_registration_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok',true,'replayed',true,'ticket_id',v_ticket.id,
        'registration_id',v_registration_id,
        'entitlement_id',v_entitlement_id,'wallet_chips_credited',0);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used');
  END IF;
  IF v_ticket.status<>'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_available');
  END IF;

  IF lower(COALESCE(v_t.variant,''))='spin'
     OR (v_t.max_players IS NOT NULL
       AND v_t.max_players>0 AND v_t.max_players<=2) THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_first_variant');
  END IF;
  IF v_t.status='RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id)
                 AND NOT COALESCE(v_t.prize_pool_finalized,false);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED','REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
  END IF;
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_full');
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_players tp
             WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','already_registered');
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.club_members m
     WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
       AND COALESCE(m.status,'active') IN ('active','approved')) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_membership_inactive');
  END IF;
  IF v_t.club_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_mismatch');
  END IF;
  IF v_t.union_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.union_clubs uc
     WHERE uc.union_id=v_t.union_id AND uc.club_id=v_ticket.club_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_union_mismatch');
  END IF;
  v_resolved_club:=public.fn_tournament_club_for_user(
    v_uid,p_tournament_id,v_ticket.club_id);
  IF v_resolved_club IS DISTINCT FROM v_ticket.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_source_club_unavailable');
  END IF;

  IF COALESCE(v_t.authorized_to_register,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_registration_approvals a
        WHERE a.tournament_id=p_tournament_id AND a.user_id=v_uid)
     AND NOT public.is_club_admin(v_ticket.club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized_to_register');
  END IF;
  IF COALESCE(v_t.is_vip_only,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.profiles pr
        WHERE pr.id=v_uid AND COALESCE(pr.is_vip,false)
          AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at>now()))
     AND NOT EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
          AND m.role IN ('owner','co_owner','admin','agent')) THEN
    RETURN jsonb_build_object('ok',false,'reason','vip_only');
  END IF;

  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<=0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2)
     OR v_ticket.value IS DISTINCT FROM v_split.charge
     OR v_ticket.entry_prize IS DISTINCT FROM v_split.prize
     OR v_ticket.entry_bounty IS DISTINCT FROM v_split.bounty
     OR v_ticket.entry_fee IS DISTINCT FROM v_split.rake THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
  END IF;

  IF COALESCE(v_t.early_bird_enabled,false)
     AND now()<v_t.start_time AND COALESCE(v_t.early_bird_chips,0)>0 THEN
    v_start_chips:=v_t.early_bird_chips;
  END IF;
  SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(p.username,''),'Player')
    INTO v_username FROM public.profiles p WHERE p.id=v_uid;
  v_username:=COALESCE(v_username,'Player');

  PERFORM public.fn_ca_escrow_apply(p_tournament_id,'ticket admission prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  SELECT count(*) INTO v_wallet_rows_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance THEN
    RAISE EXCEPTION 'ticket admission found divergent tournament escrow'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_players(
    tournament_id,user_id,username,chips,status,current_bounty,
    mystery_bounty_value,bounties_collected,bounty_winnings,
    club_id,is_satellite_qualifier,source_satellite_id)
  VALUES(
    p_tournament_id,v_uid,v_username,v_start_chips,'registered',
    v_split.bounty,0,0,0,v_ticket.club_id,true,v_ticket.source_satellite_id)
  RETURNING id INTO v_registration_id;

  v_key:='ticket:'||v_ticket.id::text||':tournament:'
         ||p_tournament_id::text||':entry';
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    v_uid,'escrow',v_ticket.id,'tournament entry ticket',
    'prize_liability',p_tournament_id,'tournaments escrow',
    v_ticket.value,'ticket_redeem',v_ticket.club_id,p_tournament_id,
    v_key,'ticket-entry:'||v_ticket.id::text,
    'fn_register_for_tournament_with_ticket',
    'Tournament-entry ticket committed to tournament admission',
    jsonb_build_object(
      'kind','tournament_entry_ticket_admission','ticket_id',v_ticket.id,
      'user_id',v_uid,'registration_id',v_registration_id,
      'source_tournament_id',v_ticket.source_tournament_id,
      'source_satellite_id',v_ticket.source_satellite_id,
      'entry_prize',v_ticket.entry_prize,
      'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee),
    v_ticket.value,0,
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance,2),
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance+v_ticket.value,2))
  RETURNING id INTO v_ledger_id;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'tournament-entry ticket admission',
    p_gross_in=>v_ticket.value,p_bounty_in=>v_ticket.entry_bounty);
  IF v_ticket.entry_fee>0 THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_ticket.club_id,v_ticket.entry_fee,v_ticket.value,1,
      0,true,p_tournament_id,'fn_register_for_tournament_with_ticket',
      jsonb_build_object(
        'kind','tournament_ticket_entry_fee','user_id',v_uid,
        'registration_id',v_registration_id,'ticket_id',v_ticket.id));
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before+1,
         prize_pool=round(v_t.prize_pool+v_ticket.entry_prize,2),
         bounty_pool=round(v_t.bounty_pool+v_ticket.entry_bounty,2),
         total_rake=round(v_t.total_rake+v_ticket.entry_fee,2),
         updated_at=now()
   WHERE id=p_tournament_id
     -- The canonical roster trigger has already counted the row inserted
     -- above. Require that exact post-insert count instead of expecting the
     -- stale pre-insert cache and then reporting a false registration race.
     AND current_players IS NOT DISTINCT FROM v_players_before+1
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'ticket admission tournament cache changed'
      USING ERRCODE='40001';
  END IF;

  INSERT INTO public.tournament_ticket_admission_authorizations(
    token,ticket_id,tournament_id,user_id,registration_id)
  VALUES(
    v_ticket_use_token,v_ticket.id,p_tournament_id,v_uid,v_registration_id);

  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',v_ticket_use_token::text,true);
  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=transaction_timestamp()
   WHERE id=v_ticket.id AND status='issued';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',
    COALESCE(v_previous_ticket_use_token,''),true);
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket changed during admission'
      USING ERRCODE='40001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.tournament_ticket_admission_authorizations a
     WHERE a.token=v_ticket_use_token) THEN
    RAISE EXCEPTION
      'tournament-entry ticket authorization was not consumed by admission'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    source_ticket_id,escrow_bucket,evidence_kind,created_at)
  VALUES(
    p_tournament_id,v_uid,'tournament_ticket','tournament_ticket',
    v_ticket.club_id,v_ticket.value,v_ticket.entry_prize,
    v_ticket.entry_bounty,v_ticket.entry_fee,v_ledger_id,
    v_registration_id,v_ticket.source_satellite_id,NULL,v_ticket.id,
    'ticket_gross','atomic_tournament_ticket',transaction_timestamp())
  RETURNING id INTO v_entitlement_id;

  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_ticket.club_id,v_uid,NULL,v_ticket.value,
    'tournament_ticket_entry','Tournament-Entry Ticket Used',NULL,
    jsonb_build_object(
      'ticket_id',v_ticket.id,'holder_id',v_uid,
      'target_tournament_id',p_tournament_id,
      'registration_id',v_registration_id,
      'entitlement_id',v_entitlement_id,'ledger_id',v_ledger_id,
      'idempotency_key',v_key,'wallet_chips_credited',0))
  RETURNING id INTO v_tx_id;

  IF v_late_open THEN
    BEGIN
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    EXCEPTION WHEN SQLSTATE '55000' THEN
      PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,1);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    END;
    v_seat_reason:=v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean,false)
       AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
      PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,1);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
      v_seat_reason:=v_seat->>'reason';
      IF NOT COALESCE((v_seat->>'ok')::boolean,false)
         AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
        RAISE EXCEPTION
          'Late ticket admission could not seat the player (%)',
          COALESCE(v_seat_reason,'unknown') USING ERRCODE='55000';
      END IF;
    END IF;
    -- Even the legacy ambiguous response is success only when the committed
    -- roster and chair already prove the exact same positive generation.
    IF (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid
           AND lower(COALESCE(tp.status::text,''))='playing'
           AND COALESCE(tp.chips,0)>0)<>1
       OR (SELECT count(*) FROM public.table_seats s
           JOIN public.tables tb ON tb.id=s.table_id
          WHERE tb.tournament_id=p_tournament_id
            AND s.user_id=v_uid AND s.left_at IS NULL)<>1
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
         JOIN public.table_seats s
           ON s.table_id=tp.table_id
          AND s.seat_number=tp.seat_number
          AND s.user_id=tp.user_id
          AND s.left_at IS NULL
          AND s.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric
         JOIN public.tables tb
           ON tb.id=s.table_id AND tb.tournament_id=tp.tournament_id
        WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid
          AND lower(COALESCE(tp.status::text,''))='playing'
          AND COALESCE(tp.chips,0)>0) THEN
      RAISE EXCEPTION
        'Late ticket admission has no exact positive roster-seat generation'
        USING ERRCODE='P0404';
    END IF;
    PERFORM public.fn_emit_tournament_manager_wake(
      p_tournament_id,'late_ticket_registration');
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT count(*) INTO v_wallet_rows_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_after.prize_balance IS DISTINCT FROM
       round(v_escrow_before.prize_balance+v_ticket.entry_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
       round(v_escrow_before.bounty_balance+v_ticket.entry_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
       round(v_escrow_before.fee_balance+v_ticket.entry_fee,2)
     OR v_wallet_rows_after IS DISTINCT FROM v_wallet_rows_before THEN
    RAISE EXCEPTION 'ticket admission did not preserve exact noncash rails'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_ticket.id,
    'registration_id',v_registration_id,'entitlement_id',v_entitlement_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id,
    'ticket_value',v_ticket.value,'wallet_chips_credited',0,
    'prize_contribution',v_ticket.entry_prize,
    'bounty_contribution',v_ticket.entry_bounty,
    'fee_contribution',v_ticket.entry_fee,'late_registration',v_late_open,
    'seat',v_seat);
END;
$ticket_admission_for$;

REVOKE ALL ON FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(
  uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- M6 owns the one-time, evidence-bound repair for an accepted zero-stack hand.
-- This later migration must never reverse that cutover or infer chips from a
-- stale chair. Fail closed if any latest unresolved zero-stack candidate still
-- has a live chair; enabling the reciprocal invariant is not allowed to hide
-- that historical generation by mirroring the chair stack into the roster.
DO $prove_no_pending_zero_live_seat_survived$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
    JOIN public.tournaments t ON t.id=c.tournament_id
   WHERE upper(COALESCE(t.status::text,''))='RUNNING'
     AND c.state='pending' AND c.resolved_at IS NULL AND c.stack_after=0
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=c.tournament_id
          AND s.user_id=c.eliminated_user_id AND s.left_at IS NULL)) THEN
    RAISE EXCEPTION 'a pending accepted zero-stack candidate still has a live seat'
      USING ERRCODE='P0404';
  END IF;
END;
$prove_no_pending_zero_live_seat_survived$;

-- The later expiry migration regressed to a candidate-snapshot estimate. The
-- final definition locks the terminal root and tournament, re-reads the whole
-- board, skips a filled/funded/launched race, and totals only the immutable
-- receipt returned by atomic cancellation.
CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(
  p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $expire_unfilled_from_exact_cancellation_receipt$
DECLARE
  v_minutes integer;
  g record;
  v_current record;
  v_skipped integer:=0;
  v_result jsonb;
  v_expired integer:=0;
  v_failed integer:=0;
  v_refunded numeric:=0;
  v_ids jsonb:='[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_spin_expire_unfilled requires service authority'
      USING ERRCODE='28000';
  END IF;
  SELECT unfilled_timeout_minutes INTO v_minutes
    FROM public.spin_fill_policy LIMIT 1;
  v_minutes:=COALESCE(v_minutes,30);
  IF v_minutes<=0 THEN
    RETURN jsonb_build_object('ok',true,'disabled',true,'expired',0);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));

  FOR g IN
    SELECT t.id
      FROM public.tournaments t
     WHERE t.variant='spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND t.started_at IS NULL
       AND EXISTS (
         SELECT 1 FROM public.table_seats s
         JOIN public.tables tb ON tb.id=s.table_id
          WHERE tb.tournament_id=t.id AND s.left_at IS NULL
            AND s.joined_at<now()-make_interval(mins=>v_minutes))
       AND (SELECT count(*) FROM public.table_seats s
             JOIN public.tables tb ON tb.id=s.table_id
            WHERE tb.tournament_id=t.id AND s.left_at IS NULL)
           <COALESCE(t.max_players,3)
     ORDER BY t.created_at
     LIMIT GREATEST(COALESCE(p_limit,50),1)
  LOOP
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=g.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_skipped:=v_skipped+1;
      CONTINUE;
    END IF;

    SELECT t.status,t.variant,t.started_at,t.spin_multiplier,
           COALESCE(t.max_players,3) AS max_players,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL) AS live_seats,
           EXISTS(SELECT 1 FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL
               AND s.joined_at<now()-make_interval(mins=>v_minutes))
             AS has_expired_waiter,
           EXISTS(SELECT 1 FROM public.spin_reserve_ledger l
             WHERE l.tournament_id=t.id AND l.kind='jackpot_draw')
             OR EXISTS(SELECT 1 FROM public.spin_draw_receipts r
               WHERE r.tournament_id=t.id) AS has_booked_draw
      INTO v_current FROM public.tournaments t WHERE t.id=g.id;

    IF v_current.variant IS DISTINCT FROM 'spin'
       OR v_current.status NOT IN ('REGISTERING','ANNOUNCED')
       OR v_current.status IS NULL
       OR v_current.started_at IS NOT NULL
       OR v_current.live_seats>=v_current.max_players
       OR NOT v_current.has_expired_waiter
       OR v_current.spin_multiplier IS NOT NULL
       OR v_current.has_booked_draw THEN
      v_skipped:=v_skipped+1;
      CONTINUE;
    END IF;

    BEGIN
      v_result:=public.atomic_cancel_tournament(g.id,NULL);
      IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'atomic cancellation returned no success receipt';
      END IF;
      v_expired:=v_expired+1;
      v_refunded:=v_refunded+
        COALESCE((v_result->>'total_refunded')::numeric,0);
      v_ids:=v_ids||to_jsonb(g.id::text);
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      RAISE WARNING 'fn_spin_expire_unfilled: could not cancel %: %',g.id,SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object(
    'ok',v_failed=0,'expired',v_expired,'failed',v_failed,
    'skipped_raced',v_skipped,
    'chips_refunded',round(v_refunded,2),'timeout_minutes',v_minutes,
    'tournament_ids',v_ids);
END;
$expire_unfilled_from_exact_cancellation_receipt$;

REVOKE ALL ON FUNCTION public.fn_spin_expire_unfilled(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_expire_unfilled(integer)
  TO service_role;

-- This verifier is read-only. It is invoked by deferred constraint triggers on
-- both halves of the relationship and by the RUNNING parent transition.
CREATE OR REPLACE FUNCTION
  public.fn_ca_assert_running_tournament_roster_seat(
    p_tournament_id uuid,p_user_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $running_roster_seat_invariant$
DECLARE
  v_status text;
  v_bad_user uuid;
  v_reason text;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN;
  END IF;
  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN;
  END IF;

  SELECT tp.user_id,
         CASE
           WHEN lower(COALESCE(tp.status::text,''))='registered'
             THEN 'registered roster survived RUNNING'
           WHEN COALESCE(tp.chips,0)<=0
             THEN 'zero-chip playing roster retained a live seat'
           ELSE 'positive playing roster has no exact live seat mirror'
         END
    INTO v_bad_user,v_reason
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND (p_user_id IS NULL OR tp.user_id=p_user_id)
     AND (
       lower(COALESCE(tp.status::text,''))='registered'
       OR (
         lower(COALESCE(tp.status::text,''))='playing'
         AND COALESCE(tp.chips,0)<=0
         AND EXISTS (
           SELECT 1 FROM public.table_seats s
           JOIN public.tables tb ON tb.id=s.table_id
            WHERE tb.tournament_id=tp.tournament_id
              AND s.user_id=tp.user_id AND s.left_at IS NULL))
       OR (
         lower(COALESCE(tp.status::text,''))='playing'
         AND COALESCE(tp.chips,0)>0
         AND (
           tp.table_id IS NULL OR tp.seat_number IS NULL
           OR (SELECT count(*) FROM public.table_seats s
               JOIN public.tables tb ON tb.id=s.table_id
              WHERE tb.tournament_id=tp.tournament_id
                AND s.user_id=tp.user_id AND s.left_at IS NULL)<>1
           OR NOT EXISTS (
             SELECT 1 FROM public.table_seats s
             JOIN public.tables tb ON tb.id=s.table_id
              WHERE tb.tournament_id=tp.tournament_id
                AND s.user_id=tp.user_id AND s.left_at IS NULL
                AND s.table_id=tp.table_id
                AND s.seat_number=tp.seat_number
                AND s.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric))))
   ORDER BY tp.user_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'RUNNING_TOURNAMENT_ROSTER_SEAT_MISMATCH: tournament %, user %, %',
      p_tournament_id,v_bad_user,v_reason USING ERRCODE='23514';
  END IF;

  SELECT s.user_id,'live seat has no exact positive playing roster mirror'
    INTO v_bad_user,v_reason
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL AND s.user_id IS NOT NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
     AND (
       (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id=p_tournament_id
           AND tp.user_id=s.user_id
           AND lower(COALESCE(tp.status::text,''))='playing'
           AND COALESCE(tp.chips,0)>0)<>1
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id=p_tournament_id
            AND tp.user_id=s.user_id
            AND lower(COALESCE(tp.status::text,''))='playing'
            AND COALESCE(tp.chips,0)>0
            AND tp.table_id=s.table_id
            AND tp.seat_number=s.seat_number
            AND tp.chips::numeric IS NOT DISTINCT FROM s.stack::numeric))
   ORDER BY s.user_id,s.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'RUNNING_TOURNAMENT_ROSTER_SEAT_MISMATCH: tournament %, user %, %',
      p_tournament_id,v_bad_user,v_reason USING ERRCODE='23514';
  END IF;
END;
$running_roster_seat_invariant$;

REVOKE ALL ON FUNCTION
  public.fn_ca_assert_running_tournament_roster_seat(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION
  public.trg_ca_assert_running_tournament_roster_seat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $running_roster_seat_constraint_trigger$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
BEGIN
  IF TG_TABLE_NAME='tournament_players' THEN
    IF TG_OP<>'INSERT' THEN
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        OLD.tournament_id,OLD.user_id);
    END IF;
    IF TG_OP='INSERT' THEN
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        NEW.tournament_id,NEW.user_id);
    ELSIF TG_OP='UPDATE'
          AND (NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
               OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        NEW.tournament_id,NEW.user_id);
    END IF;
  ELSIF TG_TABLE_NAME='table_seats' THEN
    IF TG_OP<>'INSERT' THEN
      SELECT tb.tournament_id INTO v_old_tournament_id
        FROM public.tables tb WHERE tb.id=OLD.table_id;
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        v_old_tournament_id,OLD.user_id);
    END IF;
    IF TG_OP='INSERT' THEN
      SELECT tb.tournament_id INTO v_new_tournament_id
        FROM public.tables tb WHERE tb.id=NEW.table_id;
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(
        v_new_tournament_id,NEW.user_id);
    ELSIF TG_OP='UPDATE' THEN
      SELECT tb.tournament_id INTO v_new_tournament_id
        FROM public.tables tb WHERE tb.id=NEW.table_id;
      IF v_new_tournament_id IS DISTINCT FROM v_old_tournament_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        PERFORM public.fn_ca_assert_running_tournament_roster_seat(
          v_new_tournament_id,NEW.user_id);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='tournaments' THEN
    IF TG_OP<>'DELETE' THEN
      PERFORM public.fn_ca_assert_running_tournament_roster_seat(NEW.id,NULL);
    END IF;
  ELSE
    RAISE EXCEPTION 'running roster-seat trigger attached to unexpected table %',
      TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$running_roster_seat_constraint_trigger$;

REVOKE ALL ON FUNCTION
  public.trg_ca_assert_running_tournament_roster_seat()
  FROM PUBLIC,anon,authenticated,service_role;

-- Existing production rows must already satisfy the invariant. M6 performs
-- the only evidence-bound cutover repair; this migration repairs no roster or
-- chair state and aborts on every remaining mismatch.
DO $assert_existing_running_roster_seat_state$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT t.id FROM public.tournaments t
            WHERE upper(COALESCE(t.status::text,''))='RUNNING'
            ORDER BY t.id
  LOOP
    PERFORM public.fn_ca_assert_running_tournament_roster_seat(r.id,NULL);
  END LOOP;
END;
$assert_existing_running_roster_seat_state$;

DROP TRIGGER IF EXISTS tournament_live_seat_has_active_roster
  ON public.table_seats;
DROP TRIGGER IF EXISTS tournament_live_seat_update_has_active_roster
  ON public.table_seats;
DROP TRIGGER IF EXISTS tournament_roster_cannot_orphan_live_seat
  ON public.tournament_players;
DROP TRIGGER IF EXISTS tournament_roster_update_cannot_orphan_live_seat
  ON public.tournament_players;
DROP FUNCTION IF EXISTS
  public.trg_assert_live_tournament_seat_has_roster() RESTRICT;

CREATE CONSTRAINT TRIGGER tournament_players_match_live_seat_at_commit
  AFTER INSERT OR UPDATE OR DELETE ON public.tournament_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    public.trg_ca_assert_running_tournament_roster_seat();

CREATE CONSTRAINT TRIGGER tournament_live_seats_match_roster_at_commit
  AFTER INSERT OR UPDATE OR DELETE ON public.table_seats
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    public.trg_ca_assert_running_tournament_roster_seat();

CREATE CONSTRAINT TRIGGER running_tournament_roster_seat_match_at_commit
  AFTER INSERT OR UPDATE ON public.tournaments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    public.trg_ca_assert_running_tournament_roster_seat();

-- Re-emit the complete current conservation sweep as static source without the
-- absent-player entry. The sweep remains an operator detector; it no longer
-- calls or advertises a mutation job through an executable SQL string.
CREATE OR REPLACE FUNCTION public.fn_ca_conservation_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $conservation_sweep_without_absent_mutation$
DECLARE
  c record;
  v_n bigint;
  v_rows jsonb;
  v_verdict jsonb;
  v_found integer:=0;
  v_failed integer:=0;
  v_ran integer:=0;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('fn_chip_integrity_report',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_chip_integrity_report() where severity <> ''ok'' limit 20) t',
       'warning'),
      ('fn_settlement_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_settlement_conservation_check() limit 20) t',
       'critical'),
      ('fn_union_chip_integrity_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_chip_integrity_check() limit 20) t',
       'critical'),
      ('fn_union_money_path_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_money_path_check() limit 20) t',
       'warning'),
      ('fn_club_arena_global_wallet_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_club_arena_global_wallet_check() limit 20) t',
       'warning'),
      ('fn_tournament_chip_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_chip_conservation_check(0.01) limit 20) t',
       'warning'),
      ('fn_satellite_conservation_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_satellite_conservation_audit(24) limit 20) t',
       'warning'),
      ('fn_tournament_prize_disbursement_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_prize_disbursement_audit(24) limit 20) t',
       'warning'),
      ('fn_union_credit_risk_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_credit_risk_check() limit 20) t',
       'warning'),
      ('fn_union_governance_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_governance_check() limit 20) t',
       'warning'),
      ('fn_union_house_club_stamp_check',
       'select v.n, case when v.n > 0 then jsonb_build_object(''unstamped_union_tables'', v.n) end from (select public.fn_union_house_club_stamp_check() as n) v',
       'warning'),
      ('fn_union_law_integrity_breaches',
       'select coalesce(jsonb_array_length(v.j),0), case when coalesce(jsonb_array_length(v.j),0) > 0 then v.j end from (select public.fn_union_law_integrity_breaches() as j) v',
       'critical'),
      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning'),
      ('fn_rake_spec_self_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_rake_spec_self_check() limit 20) t',
       'warning'),
      ('fn_spin_ladder_drift_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_spin_ladder_drift_check(7) limit 20) t',
       'warning'),
      ('fn_ca_payout_rows_without_money',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_payout_rows_without_money(3) limit 20) t',
       'warning'),
      ('fn_ca_undeclared_leg_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_undeclared_leg_check(24) limit 20) t',
       'warning'),
      ('fn_ca_stranded_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_tournament_players() limit 20) t',
       'warning'),
      ('fn_ca_hand_commit_refusals',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_hand_commit_refusals(24) limit 20) t',
       'warning')
    ) v(check_name,q,sev)
  LOOP
    BEGIN
      v_ran:=v_ran+1;
      EXECUTE c.q INTO v_n,v_rows;
      IF COALESCE(v_n,0)>0 THEN
        v_found:=v_found+1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:'||c.check_name,
          'ledger_imbalance',c.sev,
          'sweep:'||c.check_name||':'||CURRENT_DATE::text,
          0,NULL,v_n::numeric,'ledger',c.check_name,
          NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
          c.check_name||' returned '||v_n||
            ' finding(s) - an invariant does not hold',
          false,jsonb_build_object('rows',v_rows,'row_count',v_n));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:'||c.check_name,'unknown','warning',
        'sweepfail:'||c.check_name||':'||CURRENT_DATE::text,
        0,NULL,NULL,'ledger',c.check_name,
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        'check could not run: '||SQLERRM||
          ' - a check that errors is as silent as one that never runs',
        false,jsonb_build_object('sqlstate',SQLSTATE));
    END;
  END LOOP;

  FOR c IN
    SELECT * FROM (VALUES
      ('fn_bbj_conservation_check',
       'select public.fn_bbj_conservation_check()','healthy'),
      ('fn_bbj_promo_bank_check',
       'select public.fn_bbj_promo_bank_check()','reconciles'),
      ('fn_settler_lag_check',
       'select public.fn_settler_lag_check()','healthy'),
      ('fn_tournament_guarantee_check',
       'select public.fn_tournament_guarantee_check(24)','__guarantee')
    ) v(check_name,q,health_key)
  LOOP
    BEGIN
      v_ran:=v_ran+1;
      EXECUTE c.q INTO v_verdict;
      IF (c.health_key='__guarantee'
            AND (COALESCE((v_verdict->>'short_of_guarantee')::numeric,0)>0
              OR COALESCE((v_verdict->>'paid_nothing')::numeric,0)>0))
         OR (c.health_key<>'__guarantee'
            AND COALESCE((v_verdict->>c.health_key)::boolean,true) IS NOT TRUE)
      THEN
        v_found:=v_found+1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:'||c.check_name,
          'ledger_imbalance','warning',
          'sweep:'||c.check_name||':'||CURRENT_DATE::text,
          COALESCE((v_verdict->>'drift_from_baseline')::numeric,
                   (v_verdict->>'over_swept')::numeric,
                   (v_verdict->>'chips_short')::numeric,0),
          NULL,NULL,'ledger',c.check_name,
          NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
          c.check_name||' reports a conservation failure',false,v_verdict);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:'||c.check_name,'unknown','warning',
        'sweepfail:'||c.check_name||':'||CURRENT_DATE::text,
        0,NULL,NULL,'ledger',c.check_name,
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        'check could not run: '||SQLERRM,
        false,jsonb_build_object('sqlstate',SQLSTATE));
    END;
  END LOOP;

  INSERT INTO public.ca_detector_runs(detector,detail)
  VALUES('fn_ca_conservation_sweep',jsonb_build_object(
    'checks_run',v_ran,'with_findings',v_found,'errored',v_failed));

  RETURN jsonb_build_object(
    'ok',true,'checks_run',v_ran,
    'with_findings',v_found,'errored',v_failed);
END;
$conservation_sweep_without_absent_mutation$;

REVOKE ALL ON FUNCTION public.fn_ca_conservation_sweep()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_conservation_sweep()
  TO service_role;

DELETE FROM public.ca_detector_registry
 WHERE source='fn_ca_conservation_sweep:fn_ca_absent_tournament_players';

DROP FUNCTION public.fn_ca_eliminate_absent_tournament_players(
  integer,integer,boolean) RESTRICT;
DROP FUNCTION public.fn_ca_absent_tournament_players(integer) RESTRICT;
DROP FUNCTION public.fn_ca_release_broke_seats(
  integer,integer,boolean) RESTRICT;
DROP TABLE public.ca_broke_seat_sightings RESTRICT;

-- Prize recalculation keeps one narrow database door. It is allowed only while
-- the event is RUNNING, before a place/satellite batch, terminal/cancellation
-- receipt, or any prepared or paid place evidence exists. Compare-and-set makes
-- a retry or stale engine snapshot explicit instead of silently overwriting a
-- new value.
CREATE OR REPLACE FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_prize numeric,
  p_new_prize numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $reprice_unpaid_tournament_place$
DECLARE
  v_tournament_status text;
  v_roster_id uuid;
  v_current_prize numeric;
  v_updated_prize numeric;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'tournament prize repricing requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_expected_prize IS NULL OR p_new_prize IS NULL
     OR p_expected_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_new_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_expected_prize<0 OR p_new_prize<0
     OR p_expected_prize<>round(p_expected_prize,2)
     OR p_new_prize<>round(p_new_prize,2) THEN
    RAISE EXCEPTION 'tournament prize repricing requires finite nonnegative exact cents'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT upper(COALESCE(t.status::text,'')) INTO v_tournament_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;
  IF v_tournament_status<>'RUNNING' THEN
    RAISE EXCEPTION 'tournament prize repricing requires RUNNING status'
      USING ERRCODE='55000';
  END IF;

  SELECT tp.id,tp.prize::numeric INTO v_roster_id,v_current_prize
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament player does not exist'
      USING ERRCODE='P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
              WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements h
                 WHERE h.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts c
                 WHERE c.tournament_id=p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id=p_tournament_id
          AND o.kind IN (
            'place','bubble_protection','final_table_deal',
            'late_reg_adjustment'))
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id=p_tournament_id
          AND (p.source IN (
            'structure','reconcile','hu_shortfall','late_reg_adjustment',
            'clawback','spin_backpay','overlay_backpay','final_table_deal')
            OR public.fn_tournament_payout_key_is_place_evidence(
                 p.tournament_id,p.idempotency_key))) THEN
    RAISE EXCEPTION
      'tournament prize repricing is closed after prepared or paid terminal evidence'
      USING ERRCODE='55000';
  END IF;

  IF v_current_prize IS DISTINCT FROM p_expected_prize THEN
    RAISE EXCEPTION 'tournament prize changed from expected % to %',
      p_expected_prize,v_current_prize USING ERRCODE='40001';
  END IF;

  UPDATE public.tournament_players tp
     SET prize=p_new_prize
   WHERE tp.id=v_roster_id
     AND tp.tournament_id=p_tournament_id
     AND tp.user_id=p_user_id
     AND tp.prize IS NOT DISTINCT FROM p_expected_prize
  RETURNING tp.prize::numeric INTO v_updated_prize;
  IF NOT FOUND OR v_updated_prize IS DISTINCT FROM p_new_prize THEN
    RAISE EXCEPTION 'tournament prize compare-and-set lost its locked row'
      USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',p_tournament_id,'user_id',p_user_id,
    'prize',v_updated_prize);
END;
$reprice_unpaid_tournament_place$;

REVOKE ALL ON FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  uuid,uuid,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  uuid,uuid,numeric,numeric) TO service_role;

-- Raw service-role roster writes are no longer a runtime API. Registration,
-- seating, hands, rebuys, elimination, terminal settlement and this one prize
-- compare-and-set all execute through their scoped SECURITY DEFINER owners.
REVOKE INSERT,UPDATE,DELETE ON TABLE public.tournament_players
  FROM service_role;

DO $postcondition$
DECLARE
  v_source text;
  v_trigger_count integer;
  r record;
BEGIN
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(uuid,uuid,uuid,text,uuid)'::regprocedure;
  IF position(
       'satellite-funded registration % can return only a tournament ticket'
       IN v_source)=0
     OR position('fn_ca_return_satellite_entitlement_as_ticket' IN v_source)=0
     OR position('v_ticket_amount<=0' IN v_source)=0
     OR position('returns the same escrow value in cash' IN v_source)>0
     OR position('wallet_chips_from_satellite_entitlements' IN v_source)>0 THEN
    RAISE EXCEPTION 'final exact-unregistration core is not ticket-only';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'::regprocedure;
  IF position(
       'fn_ca_unregister_tournament_player_exact_seat_exit_core_v2'
       IN v_source)=0
     OR position('fn_ca_open_tournament_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_source)=0 THEN
    RAISE EXCEPTION 'final exact-unregistration seat wrapper is incomplete';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure;
  IF position('fn_settle_satellite_tournament_seat_exit_core_v2'
              IN v_source)=0
     OR position('fn_ca_open_tournament_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_source)=0 THEN
    RAISE EXCEPTION 'final satellite seat wrapper is incomplete';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'a superseded M6 late core survived final capture';
  END IF;

  IF has_function_privilege(
       'service_role',
       'public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(uuid,uuid,uuid,text,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2(uuid,uuid,uuid,text,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'a final seat-exit core is directly executable';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid='public.fn_spin_expire_unfilled(integer)'::regprocedure;
  IF position('FOR UPDATE SKIP LOCKED' IN v_source)=0
     OR position('has_booked_draw' IN v_source)=0
     OR position('skipped_raced' IN v_source)=0
     OR position($needle$v_result->>'total_refunded'$needle$ IN v_source)=0
     OR position('buy_in_amount' IN v_source)>0 THEN
    RAISE EXCEPTION 'Spin expiry is not the locked exact-receipt definition';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_absent_tournament_players(integer)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_release_broke_seats(integer,integer,boolean)') IS NOT NULL
     OR to_regclass('public.ca_broke_seat_sightings') IS NOT NULL THEN
    RAISE EXCEPTION 'a retired tournament mutation sweep survived';
  END IF;
  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobname IN (
       'ca-eliminate-absent-players','ca-release-broke-seats')
        OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
        OR j.command ILIKE '%fn_ca_release_broke_seats%') THEN
    RAISE EXCEPTION 'a retired tournament mutation cron survived';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ca_detector_registry d
     WHERE d.source=
       'fn_ca_conservation_sweep:fn_ca_absent_tournament_players') THEN
    RAISE EXCEPTION 'retired absent-player detector registration survived';
  END IF;
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p
   WHERE p.oid='public.fn_ca_conservation_sweep()'::regprocedure;
  IF position('fn_ca_absent_tournament_players' IN v_source)>0
     OR position('fn_ca_stranded_tournament_players' IN v_source)=0
     OR position('0,NULL,v_n::numeric,''ledger'',c.check_name' IN v_source)=0
     OR position('INSERT INTO public.ca_detector_runs' IN v_source)=0 THEN
    RAISE EXCEPTION 'final conservation sweep source is not canonical';
  END IF;

  SELECT count(*) INTO v_trigger_count
    FROM pg_trigger tg
   WHERE (tg.tgrelid,tg.tgname) IN (
     ('public.tournament_players'::regclass,
      'tournament_players_match_live_seat_at_commit'),
     ('public.table_seats'::regclass,
      'tournament_live_seats_match_roster_at_commit'),
     ('public.tournaments'::regclass,
      'running_tournament_roster_seat_match_at_commit'))
     AND tg.tgfoid=
       'public.trg_ca_assert_running_tournament_roster_seat()'::regprocedure
     AND tg.tgconstraint<>0 AND tg.tgdeferrable AND tg.tginitdeferred
     AND NOT tg.tgisinternal AND tg.tgenabled='O';
  IF v_trigger_count<>3 THEN
    RAISE EXCEPTION 'running tournament roster-seat invariant is not deferred on all roots';
  END IF;

  FOR r IN SELECT t.id FROM public.tournaments t
            WHERE upper(COALESCE(t.status::text,''))='RUNNING'
            ORDER BY t.id
  LOOP
    PERFORM public.fn_ca_assert_running_tournament_roster_seat(r.id,NULL);
  END LOOP;

  IF has_table_privilege(
       'service_role','public.tournament_players','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_players','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_players','DELETE') THEN
    RAISE EXCEPTION 'service_role retains a raw tournament roster write';
  END IF;
  IF NOT has_function_privilege(
       'service_role',
       'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)',
       'EXECUTE')
     OR NOT (SELECT p.prosecdef FROM pg_proc p
              WHERE p.oid=
                'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)'::regprocedure) THEN
    RAISE EXCEPTION 'prize repricing RPC ACL or definer contract is incomplete';
  END IF;

END;
$postcondition$;

DO $phase_b_freeze_still_held$
DECLARE
  v_pristine boolean;
BEGIN
  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
  ) INTO v_pristine;
  IF NOT v_pristine
     AND public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION
      'final tournament roster-seat maintenance entry freeze expired before commit'
      USING ERRCODE='55006';
  END IF;
END;
$phase_b_freeze_still_held$;

COMMIT;
