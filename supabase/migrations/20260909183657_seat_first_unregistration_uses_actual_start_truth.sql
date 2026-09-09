-- Reserved migration 20260909183657. Heads-Up Sit & Gos and Spins are
-- distinct seat-first products. Their
-- start_time is a human fill-window deadline, not a scheduled deal time.
-- Unregistration is therefore governed by the locked tournament status,
-- tournaments.started_at and the immutable launch receipt. The MTT clock
-- contract remains unchanged. Eligible funded satellite exits use the approved
-- cash correction; historical request receipts retain their original outcome.
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL transaction_timeout = '180s';

SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));

LOCK TABLE public.tournament_unregistration_receipts
  IN SHARE ROW EXCLUSIVE MODE;

DO $actual_start_preflight$
DECLARE
  v_old_constraints integer;
  v_receipt_source text;
  v_unregister_source text;
  v_spin_contract_source text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema='public'
       AND c.table_name='tournament_unregistration_receipts'
       AND c.column_name='start_authority') THEN
    RAISE EXCEPTION
      'tournament unregistration start authority was already changed';
  END IF;

  SELECT count(*) INTO v_old_constraints
    FROM pg_constraint c
   WHERE c.conrelid='public.tournament_unregistration_receipts'::regclass
     AND c.contype='c'
     AND pg_get_constraintdef(c.oid)='CHECK ((settled_at < scheduled_start_at))';
  IF v_old_constraints<>1 THEN
    RAISE EXCEPTION
      'scheduled-start receipt constraint changed before actual-start cutover';
  END IF;

  SELECT p.prosrc INTO v_receipt_source
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)'
       ::regprocedure;
  SELECT p.prosrc INTO v_unregister_source
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'
       ::regprocedure;
  SELECT p.prosrc INTO v_spin_contract_source
    FROM pg_proc p
   WHERE p.oid='public.fn_spin_tournament_contract_is_draw()'::regprocedure;
  IF v_receipt_source IS NULL
     OR position('v_r.settled_at>=v_r.scheduled_start_at'
          IN v_receipt_source)=0
     OR v_unregister_source IS NULL
     OR position('clock_timestamp()>=v_t.start_time'
          IN v_unregister_source)=0
     OR position('v_unregistered_at>=v_t.start_time'
          IN v_unregister_source)=0
     OR v_spin_contract_source IS NULL
     OR position('tournament_spin_cancellation_unwinds'
          IN v_spin_contract_source)=0
     OR position('published draw contract is immutable'
          IN v_spin_contract_source)=0 THEN
    RAISE EXCEPTION
      'unregistration or Spin contract core changed before actual-start cutover';
  END IF;
END;
$actual_start_preflight$;

ALTER TABLE public.tournament_unregistration_receipts
  ADD COLUMN start_authority text NOT NULL DEFAULT 'scheduled_clock';

DO $replace_scheduled_start_constraint$
DECLARE
  v_constraint name;
BEGIN
  SELECT c.conname INTO STRICT v_constraint
    FROM pg_constraint c
   WHERE c.conrelid='public.tournament_unregistration_receipts'::regclass
     AND c.contype='c'
     AND pg_get_constraintdef(c.oid)='CHECK ((settled_at < scheduled_start_at))';
  EXECUTE format(
    'ALTER TABLE public.tournament_unregistration_receipts DROP CONSTRAINT %I',
    v_constraint);
END;
$replace_scheduled_start_constraint$;

ALTER TABLE public.tournament_unregistration_receipts
  ADD CONSTRAINT tournament_unregistration_actual_start_check
  CHECK (
    (start_authority='scheduled_clock' AND settled_at<scheduled_start_at)
    OR start_authority IN (
      'spin_actual_start','heads_up_sng_actual_start')
  );

COMMENT ON COLUMN
  public.tournament_unregistration_receipts.start_authority IS
  'scheduled_clock for timed events; spin_actual_start and heads_up_sng_actual_start prove that the fill-window deadline never governed a distinct seat-first product.';

-- Before the third paid seat, a Spin has no reserve contribution and no draw.
-- Its ordinary entry and exact pre-start refund still move the provisional
-- tournament prize pool. The prior draw-integrity trigger treated every such
-- move as a corrupt published draw, which blocked both the buy-in and refund.
-- Admit only prize-pool movement for a canonical, objectively unstarted,
-- completely unbooked Spin. Once the third seat books the reserve contribution
-- or a draw exists, the existing immutable-contract law remains unchanged.
CREATE OR REPLACE FUNCTION public.fn_spin_tournament_contract_is_draw()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $seat_first_spin_contract$
DECLARE
  v_count integer;
  v_multiplier numeric;
  v_prize numeric;
  v_old_sealed boolean;
BEGIN
  IF NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.prize_pool IS NOT DISTINCT FROM OLD.prize_pool
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant,'')) <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;

  -- Preserve the audited terminal exception: cancellation may zero the
  -- contract only when no reserve booking ever existed or its exact unwind
  -- receipt is already durable in this transaction.
  IF upper(COALESCE(NEW.status::text,'')) IN ('CANCELLED','CANCELED')
     AND upper(COALESCE(OLD.status::text,'')) NOT IN ('CANCELLED','CANCELED')
     AND NEW.prize_pool IS NOT DISTINCT FROM 0::numeric
     AND NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers
     AND (
       (NOT EXISTS (
          SELECT 1 FROM public.spin_reserve_ledger r
           WHERE r.tournament_id=NEW.id
             AND r.kind IN ('contribution','jackpot_draw')))
       OR EXISTS (
          SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
           WHERE u.tournament_id=NEW.id)) THEN
    RETURN NEW;
  END IF;

  SELECT count(*),min(r.multiplier),min(round(-r.amount,2))
    INTO v_count,v_multiplier,v_prize
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=NEW.id AND r.kind='jackpot_draw';

  -- A Spin's fill-window deadline is not start truth. Until launch completion,
  -- the tournament status, started_at and immutable launch receipt all prove
  -- it has not started. Requiring zero reserve rows limits this door to the
  -- first two paid seats; the third-seat booking closes it permanently.
  IF v_count=0
     AND upper(COALESCE(OLD.status::text,''))
           IN ('ANNOUNCED','REGISTERING')
     AND upper(COALESCE(NEW.status::text,''))
           IN ('ANNOUNCED','REGISTERING')
     AND OLD.started_at IS NULL
     AND NEW.started_at IS NULL
     AND COALESCE(OLD.spin_multiplier,0)=0
     AND COALESCE(NEW.spin_multiplier,0)=0
     AND OLD.spin_locked_tiers IS NULL
     AND NEW.spin_locked_tiers IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=NEW.id
          AND r.completed_at IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
        WHERE r.tournament_id=NEW.id
          AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN NEW;
  END IF;

  IF v_count<>1
     OR NEW.spin_multiplier IS DISTINCT FROM v_multiplier
     OR NEW.prize_pool IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION
      'Spin % tournament contract must equal its one immutable reserve draw',
      NEW.id USING ERRCODE='P0404';
  END IF;
  v_old_sealed:=OLD.spin_multiplier IS NOT DISTINCT FROM v_multiplier
                AND OLD.prize_pool IS NOT DISTINCT FROM v_prize
                AND OLD.spin_locked_tiers IS NOT NULL;
  IF v_old_sealed THEN
    RAISE EXCEPTION 'Spin % published draw contract is immutable',NEW.id
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$seat_first_spin_contract$;

REVOKE ALL ON FUNCTION public.fn_spin_tournament_contract_is_draw()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unregistration_receipt(
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $actual_start_unregistration_receipt$
DECLARE
  v_r public.tournament_unregistration_receipts%ROWTYPE;
  v_entitlement_count integer;
  v_fee_entitlement_count integer;
  v_entitlement_total numeric;
  v_entitlement_fee numeric;
  v_source_count integer;
  v_wallet_count integer;
  v_wallet_total numeric;
  v_ticket_count integer;
  v_ticket_total numeric;
  v_ticket_ledger_count integer;
  v_ticket_transaction_count integer;
  v_fee_reversal_count integer;
  v_fee_reversal_total numeric;
  v_fee_source_ids uuid[];
  v_fee_mapping_count integer;
  v_fee_mapping_entitlement_count integer;
  v_fee_mapping_ids uuid[];
BEGIN
  SELECT * INTO v_r
    FROM public.tournament_unregistration_receipts r
   WHERE r.tournament_id=p_tournament_id AND r.user_id=p_user_id
     AND r.source_table_id IS NOT DISTINCT FROM p_source_table_id
     AND (p_request_id IS NULL OR r.request_id=p_request_id)
   ORDER BY r.settled_at DESC,r.registration_id DESC
   LIMIT 1;
  IF v_r.registration_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- A later registration, including an eliminated one, makes an unkeyed
  -- "latest receipt" unsafe. The exact request-key path is also refused while
  -- any later registration row exists: a replay is an outcome read, never an
  -- operation against a new lifecycle.
  IF EXISTS(
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=v_r.tournament_id AND tp.user_id=v_r.user_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*),count(*) FILTER (WHERE e.refund_fee>0),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.refund_fee),0),2)
    INTO v_entitlement_count,v_fee_entitlement_count,
         v_entitlement_total,v_entitlement_fee
    FROM public.tournament_refund_entitlements e
   WHERE e.id=ANY(v_r.entitlement_ids)
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id;
  SELECT count(*) INTO v_source_count
    FROM unnest(v_r.entitlement_ids) WITH ORDINALITY entitlement(id,n)
    JOIN unnest(v_r.source_wallet_club_ids) WITH ORDINALITY source(club_id,n)
      USING(n)
    JOIN public.tournament_refund_entitlements e
      ON e.id=entitlement.id AND e.refund_wallet_club_id=source.club_id
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id;
  SELECT count(*),round(COALESCE(sum(tr.amount_paid_now),0),2)
    INTO v_wallet_count,v_wallet_total
    FROM public.tournament_refund_tranches tr
    JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
   WHERE e.id=ANY(v_r.entitlement_ids)
     AND e.entitlement_kind IN ('wallet_charge','satellite_seat','tournament_ticket')
     AND tr.wallet_transaction_id=ANY(v_r.wallet_transaction_ids)
     AND tr.credit_ledger_id=ANY(v_r.credit_ledger_ids)
     AND tr.tournament_id=v_r.tournament_id AND tr.user_id=v_r.user_id;
  SELECT count(*),round(COALESCE(sum(tk.value),0),2)
    INTO v_ticket_count,v_ticket_total
    FROM public.tournament_tickets tk
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND tk.redemption_mode='tournament_entry_only'
     AND e.id=ANY(v_r.entitlement_ids)
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id
     AND tk.value=e.gross;
  SELECT count(*) INTO v_ticket_ledger_count
    FROM public.chip_ledger l
    JOIN public.tournament_tickets tk ON tk.id=l.to_entity_id
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND e.id=ANY(v_r.entitlement_ids)
     AND l.idempotency_key='tourney:'||e.tournament_id::text
          ||':satellite-ticket-return:'||e.id::text
     AND l.from_type='prize_liability'
     AND l.from_entity_id=e.tournament_id
     AND l.to_type='escrow' AND l.to_entity_id=tk.id
     AND l.club_id=e.refund_wallet_club_id AND l.amount=e.gross;
  SELECT count(*) INTO v_ticket_transaction_count
    FROM public.chip_transactions ct
    JOIN public.tournament_tickets tk
      ON tk.id::text=ct.metadata->>'ticket_id'
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
    JOIN public.chip_ledger l
      ON l.id::text=ct.metadata->>'ledger_id'
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND e.id=ANY(v_r.entitlement_ids)
     AND ct.transaction_type='tournament_ticket_issue'
     AND ct.club_id=e.refund_wallet_club_id
     AND ct.from_user_id IS NULL AND ct.to_user_id=e.user_id
     AND ct.amount=e.gross
     AND ct.metadata->>'entitlement_id'=e.id::text
     AND l.to_entity_id=tk.id
     AND l.idempotency_key='tourney:'||e.tournament_id::text
          ||':satellite-ticket-return:'||e.id::text;

  SELECT count(*),round(COALESCE(-sum(reversal.rake_amount),0),2)
    INTO v_fee_reversal_count,v_fee_reversal_total
    FROM public.rake_records reversal
   WHERE reversal.id=ANY(v_r.fee_reversal_ids)
     AND reversal.tournament_id=v_r.tournament_id
     AND reversal.is_tournament IS TRUE
     AND reversal.source='fn_unregister_from_tournament'
     AND reversal.rake_amount<0
     AND reversal.metadata->>'kind'='tournament_fee_refund'
     AND reversal.metadata->>'user_id'=v_r.user_id::text
     AND reversal.metadata->>'registration_id'=v_r.registration_id::text;
  SELECT COALESCE(array_agg(source.id ORDER BY source.id),ARRAY[]::uuid[])
    INTO v_fee_source_ids
    FROM public.rake_records reversal
   CROSS JOIN LATERAL jsonb_array_elements_text(
     reversal.metadata->'original_rake_record_ids') raw(id)
   JOIN LATERAL (SELECT raw.id::uuid AS id) source ON true
   WHERE reversal.id=ANY(v_r.fee_reversal_ids);
  WITH exact_fee_mapping AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.id=ANY(v_r.fee_source_rake_record_ids)
       AND r.tournament_id=e.tournament_id
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
          AND r.metadata->>'registration_id'=v_r.registration_id::text)
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
     WHERE e.id=ANY(v_r.entitlement_ids) AND e.refund_fee>0
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_mapping_count,v_fee_mapping_entitlement_count,v_fee_mapping_ids
    FROM exact_fee_mapping;

  IF (v_r.start_authority='scheduled_clock'
       AND v_r.settled_at>=v_r.scheduled_start_at)
     OR (v_r.start_authority IN (
           'spin_actual_start','heads_up_sng_actual_start')
       AND EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts launch
          WHERE launch.tournament_id=v_r.tournament_id
            AND launch.completed_at IS NOT NULL
            AND launch.completed_at<=v_r.settled_at))
     OR (v_r.start_authority='spin_actual_start'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournaments t
          WHERE t.id=v_r.tournament_id
            AND t.satellite_target_id IS NULL
            AND upper(COALESCE(t.tournament_type::text,''))<>'SATELLITE'
            AND (lower(COALESCE(t.variant::text,''))='spin'
              OR upper(COALESCE(t.tournament_type::text,''))='SPIN')))
     OR (v_r.start_authority='heads_up_sng_actual_start'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournaments t
          WHERE t.id=v_r.tournament_id
            AND t.satellite_target_id IS NULL
            AND upper(COALESCE(t.tournament_type::text,''))='SNG'
            AND lower(COALESCE(t.variant::text,''))<>'spin'
            AND COALESCE(t.max_players,0)=2))
     OR v_r.start_authority NOT IN (
          'scheduled_clock','spin_actual_start','heads_up_sng_actual_start')
     OR v_entitlement_count<>cardinality(v_r.entitlement_ids)
     OR v_source_count<>cardinality(v_r.entitlement_ids)
     OR v_entitlement_total IS DISTINCT FROM
          round(v_r.refunded_chips+v_r.returned_ticket_value,2)
     OR v_wallet_count<>cardinality(v_r.wallet_transaction_ids)
     OR v_wallet_total IS DISTINCT FROM v_r.refunded_chips
     OR v_ticket_count<>cardinality(v_r.ticket_ids)
     OR v_ticket_total IS DISTINCT FROM v_r.returned_ticket_value
     OR v_ticket_ledger_count<>cardinality(v_r.ticket_ids)
     OR v_ticket_transaction_count<>cardinality(v_r.ticket_ids)
     OR v_r.fees_reversed IS DISTINCT FROM v_entitlement_fee
     OR v_fee_reversal_count<>cardinality(v_r.fee_reversal_ids)
     OR v_fee_reversal_total IS DISTINCT FROM v_r.fees_reversed
     OR v_fee_source_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids
     OR v_fee_mapping_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids
     OR v_fee_mapping_count<>v_fee_entitlement_count
     OR v_fee_mapping_entitlement_count<>v_fee_entitlement_count
     OR cardinality(v_fee_source_ids)<>(
       SELECT count(DISTINCT id) FROM unnest(v_fee_source_ids) source(id))
     OR EXISTS (
       SELECT 1 FROM public.tournament_unregistration_receipts other
        WHERE other.registration_id<>v_r.registration_id
          AND (other.fee_reversal_ids && v_r.fee_reversal_ids
            OR other.fee_source_rake_record_ids
                 && v_r.fee_source_rake_record_ids))
     OR EXISTS (
       SELECT 1
         FROM public.rake_records reversal
        WHERE reversal.id=ANY(v_r.fee_reversal_ids)
          AND (
            jsonb_typeof(reversal.metadata->'original_rake_record_ids')
              IS DISTINCT FROM 'array'
            OR jsonb_array_length(
                 reversal.metadata->'original_rake_record_ids')=0
            OR (SELECT round(COALESCE(sum(original.rake_amount),0),2)
                  FROM jsonb_array_elements_text(
                    reversal.metadata->'original_rake_record_ids') raw(id)
                  JOIN public.rake_records original
                    ON original.id=raw.id::uuid
                 WHERE original.tournament_id=v_r.tournament_id
                   AND original.club_id=reversal.club_id
                   AND original.is_tournament IS TRUE
                   AND original.rake_amount>0
                   AND original.metadata->>'user_id'=v_r.user_id::text
                   AND (
                     (original.source IN (
                        'fn_register_for_tournament',
                        'fn_register_horse_for_tournament')
                       AND original.metadata->>'kind'='tournament_entry_fee')
                     OR (original.source='process_tournament_rebuy'
                       AND original.metadata->>'kind' IN (
                         'tournament_rebuy_fee','tournament_reentry_fee'))
                     OR (original.source=
                           'fn_register_for_tournament_with_ticket'
                       AND original.metadata->>'kind'=
                           'tournament_ticket_entry_fee')
                     OR (original.source='fn_award_satellite_seat'
                       AND original.metadata->>'kind'=
                           'satellite_seat_entry_fee')))
                IS DISTINCT FROM -reversal.rake_amount))
     OR (v_r.source_table_id IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM public.tables tb
        WHERE tb.id=v_r.source_table_id
          AND tb.tournament_id=v_r.tournament_id)) THEN
    RAISE EXCEPTION 'tournament unregistration receipt % is not exact',
      v_r.registration_id USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'request_id',v_r.request_id,
    'registration_id',v_r.registration_id,
    'refunded_chips',v_r.refunded_chips,
    'returned_ticket_value',v_r.returned_ticket_value,
    'wallet_chips_from_satellite_entitlements',(
      SELECT COALESCE(sum(tr.amount_paid_now),0)
        FROM public.tournament_refund_tranches tr
        JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
       WHERE e.id=ANY(v_r.entitlement_ids)
         AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
         AND tr.wallet_transaction_id=ANY(v_r.wallet_transaction_ids)
         AND tr.credit_ledger_id=ANY(v_r.credit_ledger_ids)
         AND tr.tournament_id=v_r.tournament_id AND tr.user_id=v_r.user_id),
    'entitlement_ids',to_jsonb(v_r.entitlement_ids),
    'ticket_ids',to_jsonb(v_r.ticket_ids),
    'source_wallet_club_ids',to_jsonb(v_r.source_wallet_club_ids),
    'credit_ledger_ids',to_jsonb(v_r.credit_ledger_ids),
    'wallet_transaction_ids',to_jsonb(v_r.wallet_transaction_ids),
    'fees_reversed',v_r.fees_reversed,
    'fee_reversal_ids',to_jsonb(v_r.fee_reversal_ids),
    'fee_source_rake_record_ids',to_jsonb(v_r.fee_source_rake_record_ids),
    'seat_number',v_r.seat_number,'seats_taken',v_r.seats_taken,
    'scheduled_start_at',v_r.scheduled_start_at,
    'start_authority',v_r.start_authority,
    'settled_at',v_r.settled_at);
END;
$actual_start_unregistration_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_unregistration_receipt(
  uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;


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
AS $actual_start_unregister_core$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_reg public.tournament_players%ROWTYPE;
  v_ent record;
  v_fee_group record;
  v_settle jsonb;
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
         round(COALESCE(sum(e.gross),0),2),
         0::numeric
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
  -- A funded satellite entry does not invent a player-wallet debit.
  -- It returns the same escrow value in cash through its exact source proof.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND EXISTS (
       SELECT 1 FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
          AND e.entitlement_kind='wallet_charge'
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_refund_tranches tr
             WHERE tr.entitlement_id=e.id)) THEN
    RAISE EXCEPTION
      'satellite-funded registration % has an unexpected wallet charge',
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
     OR v_wallet_refunds_before>(
       SELECT COALESCE(sum(e.gross),0)
         FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_tickets tk
             WHERE tk.source_refund_entitlement_id=e.id)) THEN
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
       AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.entitlement_kind,e.id
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
$actual_start_unregister_core$;

REVOKE ALL ON FUNCTION public.fn_ca_unregister_tournament_player_exact(
  uuid,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $verify_actual_start_unregistration$
DECLARE
  v_unregister_source text;
  v_receipt_source text;
  v_spin_contract_source text;
  v_default text;
BEGIN
  SELECT p.prosrc INTO v_unregister_source
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'
       ::regprocedure;
  SELECT p.prosrc INTO v_receipt_source
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)'
       ::regprocedure;
  SELECT p.prosrc INTO v_spin_contract_source
    FROM pg_proc p
   WHERE p.oid='public.fn_spin_tournament_contract_is_draw()'::regprocedure;
  SELECT pg_get_expr(d.adbin,d.adrelid) INTO v_default
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.tournament_unregistration_receipts'::regclass
     AND a.attname='start_authority'
     AND a.attnotnull;

  IF v_unregister_source IS NULL
     OR position('spin_actual_start' IN v_unregister_source)=0
     OR position('heads_up_sng_actual_start' IN v_unregister_source)=0
     OR position('v_t.started_at IS NOT NULL' IN v_unregister_source)=0
     OR position('v_launch_completed_at IS NOT NULL' IN v_unregister_source)=0
     OR position('hh.tournament_id=p_tournament_id' IN v_unregister_source)=0
     OR position('JOIN public.hand_history hh ON hh.table_id=hand_table.id'
          IN v_unregister_source)=0
     OR position('v_persisted_hand_exists' IN v_unregister_source)=0
     OR v_receipt_source IS NULL
     OR position('launch.completed_at<=v_r.settled_at'
          IN v_receipt_source)=0
     OR v_spin_contract_source IS NULL
     OR position('OLD.started_at IS NULL' IN v_spin_contract_source)=0
     OR position('NEW.started_at IS NULL' IN v_spin_contract_source)=0
     OR position('r.completed_at IS NOT NULL'
          IN v_spin_contract_source)=0
     OR position('published draw contract is immutable'
          IN v_spin_contract_source)=0
     OR v_default IS DISTINCT FROM '''scheduled_clock''::text'
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid=
                'public.tournament_unregistration_receipts'::regclass
          AND c.conname='tournament_unregistration_actual_start_check'
          AND c.convalidated)
     OR has_function_privilege(
          'anon',
          'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',
          'EXECUTE')
     OR has_function_privilege(
          'authenticated',
          'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',
          'EXECUTE')
     OR has_function_privilege(
          'service_role',
          'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',
          'EXECUTE')
     OR has_function_privilege(
          'anon',
          'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)',
          'EXECUTE')
     OR has_function_privilege(
          'authenticated',
          'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)',
          'EXECUTE')
     OR has_function_privilege(
          'service_role',
          'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)',
          'EXECUTE')
     OR has_function_privilege(
          'anon','public.fn_spin_tournament_contract_is_draw()','EXECUTE')
     OR has_function_privilege(
          'authenticated','public.fn_spin_tournament_contract_is_draw()','EXECUTE')
     OR has_function_privilege(
          'service_role','public.fn_spin_tournament_contract_is_draw()','EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid='public.tournaments'::regclass
          AND tg.tgname='spin_tournament_contract_is_draw'
          AND tg.tgfoid=
                'public.fn_spin_tournament_contract_is_draw()'::regprocedure
          AND NOT tg.tgisinternal) THEN
    RAISE EXCEPTION
      'actual-start unregistration migration did not install exactly';
  END IF;
END;
$verify_actual_start_unregistration$;

COMMIT;
