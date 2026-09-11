-- The atomic Spin authority and its broad trigger DDL are installed during the
-- serialized maintenance freeze. This small closeout runs after thaw and
-- appends the one known already-paid draw journal without replaying its escrow
-- side effect. It carries no relation DDL on chip_ledger and no balance-row
-- writes.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';
SET LOCAL transaction_timeout = '90s';

-- Match every tournament terminal writer before deciding whether the platform
-- is thawed. The shared maintenance root prevents the next freeze transition
-- until this exact adoption either commits in full or rolls back in full.
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);

DO $require_spin_adoption_thaw$
BEGIN
  IF to_regclass('public.tournament_spin_settlement_cutover') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM public.tournament_spin_settlement_cutover c
        WHERE c.authority = 'fn_spin_draw_and_settle:v1'
          AND c.migration_version = '20260909014433'
     ) THEN
    RAISE EXCEPTION
      'Spin journal closeout requires the committed atomic Spin cutover first';
  END IF;
  IF to_regclass('public.chip_ledger_idem') IS NULL
     OR to_regclass('public.ca_manual_adjustments') IS NULL
     OR to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL
     OR to_regprocedure('public.fn_platform_frozen()') IS NULL
     OR to_regprocedure('public.fn_ca_escrow_on_reserve_leg()') IS NULL THEN
    RAISE EXCEPTION 'Spin journal closeout dependencies are missing';
  END IF;
  -- This closeout is deliberately ordered immediately after 14433 is thawed
  -- and before cancellation/terminal evidence immutability is installed. It
  -- must not grow temporary exceptions to those future global guards.
  IF to_regprocedure(
       'public.fn_cancelled_tournament_evidence_is_immutable()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_satellite_transfer_ledger_is_immutable()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_terminal_tournament_evidence_is_immutable()') IS NOT NULL THEN
    RAISE EXCEPTION
      'Spin journal closeout must run before terminal evidence immutability cutovers'
      USING ERRCODE = '55000';
  END IF;
  IF public.fn_platform_frozen()
     OR public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'Spin journal adoption closeout must run after the maintenance freeze'
      USING ERRCODE = '55006';
  END IF;
END;
$require_spin_adoption_thaw$;

-- Exact historical adoption: migration 20260908132643 already completed this
-- transfer from the debited Spin reserve to the winner. The immutable reserve
-- row, escrow, obligation, payout, wallet receipt and payout journal all agree,
-- but the deterministic draw journal itself never landed. Appending the
-- missing spin_prize row normally fires zz_ca_escrow_reserve_leg and would
-- falsely add the same 3.00 to reserve_in a second time.
--
-- Do not disable a trigger on the 2M+ row journal and do not leave a bypass in
-- the runtime function. First pin the exact live trigger/function definition.
-- Then, only inside this still-open migration transaction, replace its body
-- with a gate that suppresses the escrow side effect for one exact row carrying
-- one transaction-local nonce. Every other reserve leg keeps the normal body.
-- The original function is restored and re-hashed before COMMIT; any exception
-- rolls the whole transaction back to the original catalog definition.
DO $assert_781cc0ee_escrow_trigger$
BEGIN
  IF md5(pg_get_functiondef(
       'public.fn_ca_escrow_on_reserve_leg()'::regprocedure))
       IS DISTINCT FROM '0d7f735d58aadeb6fe03e9daf5e21a92' THEN
    RAISE EXCEPTION
      'Spin 781cc0ee adoption requires the audited reserve-leg escrow trigger function';
  END IF;
  IF (SELECT count(*) FROM pg_trigger tr
       WHERE tr.tgrelid = 'public.chip_ledger'::regclass
         AND tr.tgname = 'zz_ca_escrow_reserve_leg'
         AND NOT tr.tgisinternal
         AND tr.tgfoid =
             'public.fn_ca_escrow_on_reserve_leg()'::regprocedure
         AND tr.tgenabled = 'O'
         AND tr.tgtype = 5
         AND md5(pg_get_triggerdef(tr.oid)) =
             '37abfea4594c96da841bacdefab30c51') <> 1
     OR (SELECT count(*) FROM pg_trigger tr
          WHERE NOT tr.tgisinternal
            AND tr.tgfoid =
                'public.fn_ca_escrow_on_reserve_leg()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION
      'Spin 781cc0ee adoption requires one exact enabled reserve-leg escrow trigger';
  END IF;
END;
$assert_781cc0ee_escrow_trigger$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_reserve_leg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $adopt_781cc0ee_gate$
BEGIN
  IF current_setting('app.spin_paid_journal_adoption',true) =
       '20260909014433:781cc0ee-6a1d-4e31-acaf-4e737661bba1'
     AND NEW.performed_by =
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
     AND NEW.category = 'spin_prize'
     AND NEW.from_type = 'spin_reserve'
     AND NEW.from_entity_id =
         '2d968239-acdd-4a2c-99f2-a369ff37ae31'::uuid
     AND NEW.from_label = 'spin_bonus_pools.balance'
     AND NEW.to_type = 'prize_liability'
     AND NEW.to_entity_id =
         '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid
     AND NEW.to_label = 'tournaments.prize_pool'
     AND NEW.tournament_id =
         '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid
     AND NEW.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
     AND NEW.amount = 3.00
     AND NEW.pre_from_balance = 52594.76
     AND NEW.post_from_balance = 52591.76
     AND NEW.idempotency_key =
         'spin:781cc0ee-6a1d-4e31-acaf-4e737661bba1:draw'
     AND NEW.metadata->>'migration' = '20260909014433'
     AND NEW.metadata->>'reserve_draw_id' =
         'd6eba15c-04b2-47f2-a168-731d4f433696'
     AND NEW.metadata->>'prior_settlement_migration' = '20260908132643'
     AND NEW.metadata->>'historical_adoption' = 'true'
     AND NEW.metadata->>'escrow_already_applied' = 'true' THEN
    RETURN NULL;
  END IF;

  IF COALESCE(
       current_setting('app.spin_paid_journal_adoption',true),'') <> '' THEN
    RAISE EXCEPTION
      'Spin 781cc0ee escrow-side-effect suppression refused a non-exact row'
      USING ERRCODE = 'P0404';
  END IF;

  IF NEW.category = 'spin_entry' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.from_entity_id,'spin pool to reserve',
      p_reserve_out => round(NEW.amount,2));
  ELSIF NEW.category = 'spin_prize' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.to_entity_id,'spin prize from reserve',
      p_reserve_in => round(NEW.amount,2));
  END IF;
  RETURN NULL;
END;
$adopt_781cc0ee_gate$;

DO $adopt_paid_781cc0ee_journal$
DECLARE
  v_tid constant uuid := '781cc0ee-6a1d-4e31-acaf-4e737661bba1';
  v_winner constant uuid := 'c402b38e-7ba6-40bf-a2d3-d65376d28ccf';
  v_entry_id constant uuid := 'f5e018ab-d15d-4d6c-bda0-270e97daf8eb';
  v_draw_id constant uuid := 'd6eba15c-04b2-47f2-a168-731d4f433696';
  v_obligation_id constant uuid := 'd367f526-d950-4b4a-af4d-07793000d7c6';
  v_adjustment_id constant uuid := 'be079c12-17e8-4b72-8534-e3b663f11df4';
  v_payout_id constant uuid := 'fe731d49-4920-461d-8ad3-572190b42ff5';
  v_wallet_tx_id constant uuid := 'da684ac8-e416-47fe-9e77-73d89381ce0a';
  v_payout_leg_id constant uuid := 'beb41a03-839f-4c61-897b-e7df50a9218e';
  v_entry_leg_id constant uuid := '768dfffe-b11f-47df-9dbe-123db4a34abc';
  v_pool_id constant uuid := '2d968239-acdd-4a2c-99f2-a369ff37ae31';
  v_owner constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_key constant text :=
    'spin:781cc0ee-6a1d-4e31-acaf-4e737661bba1:draw';
  v_description constant text :=
    'Historical adoption of Spin 781cc0ee draw d6eba15c: the reserve movement, escrow credit, payout and winner credit were already committed by 20260908132643; append the missing draw journal without replaying reserve_in.';
  v_journal_id uuid;
  v_escrow_before jsonb;
  v_obligation_before jsonb;
  v_payout_before jsonb;
  v_wallet_tx_before jsonb;
  v_adjustment_before jsonb;
  v_payout_leg_before jsonb;
  v_pool_balance_before numeric;
  v_winner_wallets_before numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_tid) THEN
    RETURN; -- a clean schema replay has no production incident row
  END IF;

  -- 14433 recorded which known incidents actually existed while the frozen
  -- production boundary was owned. Never adopt a same-UUID row that appeared
  -- after that boundary.
  PERFORM 1
    FROM public.tournament_spin_settlement_cutover c
   WHERE c.authority = 'fn_spin_draw_and_settle:v1'
     AND c.migration_version = '20260909014433'
     AND v_tid = ANY(c.audited_tournament_ids)
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Spin % was not in the stage-one audited production cohort',v_tid
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournaments WHERE id = v_tid FOR UPDATE;
  PERFORM 1 FROM public.spin_bonus_pools WHERE id = v_pool_id FOR UPDATE;
  PERFORM 1 FROM public.tournament_escrow
   WHERE tournament_id = v_tid FOR UPDATE;
  PERFORM 1 FROM public.tournament_obligations
   WHERE id = v_obligation_id FOR UPDATE;
  PERFORM 1 FROM public.tournament_payouts
   WHERE id = v_payout_id FOR UPDATE;
  PERFORM 1 FROM public.wallet_transactions
   WHERE id = v_wallet_tx_id FOR UPDATE;
  PERFORM 1 FROM public.ca_manual_adjustments
   WHERE id = v_adjustment_id FOR UPDATE;
  PERFORM 1 FROM public.chip_ledger
   WHERE id IN (v_entry_leg_id,v_payout_leg_id)
   ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.club_members
   WHERE user_id = v_winner ORDER BY club_id FOR UPDATE;

  IF (SELECT count(*) FROM public.tournaments t
       WHERE t.id = v_tid
         AND t.club_id = v_owner
         AND lower(COALESCE(t.variant,'')) = 'spin'
         AND upper(COALESCE(t.status::text,'')) = 'COMPLETED'
         AND t.buy_in_amount = 1
         AND t.max_players = 3
         AND t.spin_multiplier = 3
         AND t.prize_pool = 3) <> 1
     OR (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id = v_tid) <> 3
     OR (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id = v_tid AND tp.user_id = v_winner
            AND tp.position = 1 AND tp.status = 'winner'
            AND tp.prize = 3) <> 1
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'debit'
            AND w.category = 'tournament_buyin') <> 3
     OR (SELECT round(COALESCE(sum(w.amount),0),2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'debit'
            AND w.category = 'tournament_buyin') <> 3 THEN
    RAISE EXCEPTION
      'Spin % no longer has the exact completed three-seat 3x contract',v_tid;
  END IF;

  IF (SELECT count(*) FROM public.spin_reserve_ledger r
       WHERE r.id = v_entry_id AND r.tournament_id = v_tid
         AND r.kind = 'contribution' AND r.club_id = v_owner
         AND r.amount = 2.76 AND r.balance_after = 52594.76
         AND r.buy_in = 1 AND r.seats = 3 AND r.house_rake = 0.24) <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.id = v_draw_id AND r.tournament_id = v_tid
            AND r.kind = 'jackpot_draw' AND r.club_id = v_owner
            AND r.amount = -3 AND r.balance_after = 52591.76
            AND r.multiplier = 3 AND r.buy_in = 1 AND r.seats = 3
            AND r.house_rake = 0.24) <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.tournament_id = v_tid
            AND r.kind IN ('contribution','jackpot_draw')) <> 2
     OR (SELECT count(*) FROM public.spin_bonus_pools p
          WHERE p.id = v_pool_id AND p.club_id = v_owner) <> 1 THEN
    RAISE EXCEPTION
      'Spin % reserve evidence moved since the paid-state audit',v_tid;
  END IF;

  IF (SELECT count(*) FROM public.chip_ledger l
          WHERE l.category = 'adjustment'
            AND l.from_type = 'spin_reserve'
            AND l.from_entity_id = v_pool_id
            AND l.to_type = 'settlement_suspense'
            AND l.amount = 3
            AND l.post_from_balance = 52591.76) <> 0 THEN
    RAISE EXCEPTION
      'Spin % has a forbidden settlement-suspense leg',v_tid;
  END IF;

  SELECT l.id INTO v_journal_id
    FROM public.chip_ledger l
   WHERE l.idempotency_key = v_key;
  IF v_journal_id IS NULL THEN
    IF EXISTS (
         SELECT 1 FROM public.chip_ledger_idem k
          WHERE k.idempotency_key = v_key)
       OR (SELECT count(*) FROM public.chip_ledger l
            WHERE l.category = 'spin_prize'
              AND (
                l.tournament_id = v_tid
                OR (l.to_type = 'prize_liability'
                    AND l.to_entity_id = v_tid)
                OR l.idempotency_key LIKE 'spin:' || v_tid::text || ':draw%'
              )) <> 0 THEN
      RAISE EXCEPTION
        'Spin % has partial or mismatched draw-journal evidence',v_tid
        USING ERRCODE = 'P0404';
    END IF;
  ELSIF (SELECT count(*) FROM public.chip_ledger l
          WHERE l.id = v_journal_id
            AND l.performed_by =
                '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
            AND l.idempotency_key = v_key
            AND l.category = 'spin_prize'
            AND l.from_type = 'spin_reserve'
            AND l.from_entity_id = v_pool_id
            AND l.from_label = 'spin_bonus_pools.balance'
            AND l.to_type = 'prize_liability'
            AND l.to_entity_id = v_tid
            AND l.to_label = 'tournaments.prize_pool'
            AND l.tournament_id = v_tid
            AND l.club_id = v_owner
            AND l.amount = 3
            AND l.description = v_description
            AND l.notes IS NULL
            AND l.union_id IS NULL
            AND l.table_id IS NULL
            AND l.hand_id IS NULL
            AND l.correlation_id IS NULL
            AND l.causation_id IS NULL
            AND l.settlement_id IS NULL
            AND l.pre_from_balance = 52594.76
            AND l.post_from_balance = 52591.76
            AND l.pre_to_balance IS NULL
            AND l.post_to_balance IS NULL
            AND l.status = 'posted'
            AND l.chain_seq IS NOT NULL
            AND l.row_hash IS NOT NULL
            AND l.metadata = jsonb_build_object(
              'migration','20260909014433',
              'reserve_draw_id',v_draw_id,
              'prior_settlement_migration','20260908132643',
              'historical_adoption',true,
              'escrow_already_applied',true)) <> 1
       OR (SELECT count(*) FROM public.chip_ledger l
            WHERE l.category = 'spin_prize'
              AND (
                l.tournament_id = v_tid
                OR (l.to_type = 'prize_liability'
                    AND l.to_entity_id = v_tid)
                OR l.idempotency_key LIKE 'spin:' || v_tid::text || ':draw%'
              )) <> 1
       OR (SELECT count(*) FROM public.chip_ledger_idem k
            WHERE k.idempotency_key = v_key
              AND k.leg_id = v_journal_id) <> 1 THEN
    RAISE EXCEPTION
      'Spin % existing draw journal does not exactly match the adopted receipt',v_tid
      USING ERRCODE = 'P0404';
  END IF;

  IF (SELECT count(*) FROM public.tournament_escrow e
       WHERE e.tournament_id = v_tid AND e.enforced
         AND e.gross_in = 3 AND e.fee_entries_in = 0.24
         AND e.reserve_out = 2.76 AND e.reserve_in = 3
         AND e.prize_out = 3 AND e.prize_balance = 0
         AND e.fee_out = 0.24 AND e.fee_balance = 0) <> 1
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.id = v_obligation_id AND o.tournament_id = v_tid
            AND o.user_id = v_winner AND o.kind = 'place' AND o.place = 1
            AND o.amount_owed = 3 AND o.amount_paid = 3
            AND o.source = 'agent.settle_10_9'
            AND o.adjustment_id = v_adjustment_id
            AND o.settled_at IS NOT NULL) <> 1
     OR (SELECT count(*) FROM public.tournament_payouts p
          WHERE p.id = v_payout_id AND p.tournament_id = v_tid
            AND p.user_id = v_winner AND p."position" = 1
            AND p.amount = 3 AND p.source = 'structure'
            AND p.idempotency_key =
              'tourney:781cc0ee-6a1d-4e31-acaf-4e737661bba1:obl:d367f526-d950-4b4a-af4d-07793000d7c6:0') <> 1
     OR (SELECT count(*) FROM public.tournament_payouts p
          WHERE p.tournament_id = v_tid) <> 1
     OR (SELECT round(COALESCE(sum(p.amount),0),2)
           FROM public.tournament_payouts p
          WHERE p.tournament_id = v_tid) <> 3
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.id = v_wallet_tx_id AND w.related_entity_id = v_tid
            AND w.user_id = v_winner AND w.type = 'credit'
            AND w.category = 'prize' AND w.amount = 3) <> 1
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'credit'
            AND w.category = 'prize') <> 1
     OR (SELECT round(COALESCE(sum(w.amount),0),2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'credit'
            AND w.category = 'prize') <> 3
     OR (SELECT count(*) FROM public.ca_manual_adjustments a
          WHERE a.id = v_adjustment_id AND a.tournament_id = v_tid
            AND a.target_id = v_winner AND a.target_kind = 'player_wallet'
            AND a.asset = 'chips' AND a.amount = 3
            AND a.status = 'settled') <> 1
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.id = v_payout_leg_id AND l.tournament_id = v_tid
            AND l.category = 'tournament_prize'
            AND l.from_type = 'prize_liability'
            AND l.from_entity_id = v_tid
            AND l.to_type = 'player_wallet'
            AND l.to_entity_id = v_winner AND l.amount = 3) <> 1
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.id = v_entry_leg_id AND l.tournament_id = v_tid
            AND l.category = 'spin_entry'
            AND l.from_type = 'prize_liability'
            AND l.from_entity_id = v_tid
            AND l.to_type = 'spin_reserve'
            AND l.to_entity_id = v_pool_id AND l.amount = 2.76
            AND l.post_to_balance = 52594.76) <> 1 THEN
    RAISE EXCEPTION
      'Spin % paid evidence changed; historical journal adoption refused',v_tid;
  END IF;

  SELECT to_jsonb(e) INTO STRICT v_escrow_before
    FROM public.tournament_escrow e WHERE e.tournament_id = v_tid;
  SELECT to_jsonb(o) INTO STRICT v_obligation_before
    FROM public.tournament_obligations o WHERE o.id = v_obligation_id;
  SELECT to_jsonb(p) INTO STRICT v_payout_before
    FROM public.tournament_payouts p WHERE p.id = v_payout_id;
  SELECT to_jsonb(w) INTO STRICT v_wallet_tx_before
    FROM public.wallet_transactions w WHERE w.id = v_wallet_tx_id;
  SELECT to_jsonb(a) INTO STRICT v_adjustment_before
    FROM public.ca_manual_adjustments a WHERE a.id = v_adjustment_id;
  SELECT to_jsonb(l) INTO STRICT v_payout_leg_before
    FROM public.chip_ledger l WHERE l.id = v_payout_leg_id;
  SELECT p.balance INTO STRICT v_pool_balance_before
    FROM public.spin_bonus_pools p WHERE p.id = v_pool_id;
  SELECT round(COALESCE(sum(cm.chip_balance),0),2)
    INTO v_winner_wallets_before
    FROM public.club_members cm WHERE cm.user_id = v_winner;

  IF v_journal_id IS NULL THEN
    PERFORM set_config(
      'app.spin_paid_journal_adoption',
      '20260909014433:781cc0ee-6a1d-4e31-acaf-4e737661bba1',true);
    INSERT INTO public.chip_ledger
      (performed_by,from_type,from_entity_id,from_label,
       to_type,to_entity_id,to_label,amount,category,club_id,
       description,pre_from_balance,post_from_balance,tournament_id,
       idempotency_key,metadata)
    VALUES
      ('2d1cd6c3-5700-4af9-a271-d4863fdab20d',
       'spin_reserve',v_pool_id,'spin_bonus_pools.balance',
       'prize_liability',v_tid,'tournaments.prize_pool',3,'spin_prize',v_owner,
       v_description,52594.76,52591.76,v_tid,v_key,
       jsonb_build_object(
         'migration','20260909014433',
         'reserve_draw_id',v_draw_id,
         'prior_settlement_migration','20260908132643',
         'historical_adoption',true,
         'escrow_already_applied',true))
    RETURNING id INTO v_journal_id;
    PERFORM set_config('app.spin_paid_journal_adoption','',true);
  END IF;

  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.id = v_journal_id
         AND l.idempotency_key = v_key
         AND l.category = 'spin_prize'
         AND l.from_type = 'spin_reserve'
         AND l.from_entity_id = v_pool_id
         AND l.from_label = 'spin_bonus_pools.balance'
         AND l.to_type = 'prize_liability'
         AND l.to_entity_id = v_tid
         AND l.to_label = 'tournaments.prize_pool'
         AND l.tournament_id = v_tid
         AND l.club_id = v_owner
         AND l.amount = 3
         AND l.description = v_description
         AND l.notes IS NULL
         AND l.union_id IS NULL
         AND l.table_id IS NULL
         AND l.hand_id IS NULL
         AND l.correlation_id IS NULL
         AND l.causation_id IS NULL
         AND l.settlement_id IS NULL
         AND l.pre_from_balance = 52594.76
         AND l.post_from_balance = 52591.76
         AND l.pre_to_balance IS NULL
         AND l.post_to_balance IS NULL
         AND l.status = 'posted'
         AND l.chain_seq IS NOT NULL
         AND l.row_hash IS NOT NULL
         AND l.metadata = jsonb_build_object(
           'migration','20260909014433',
           'reserve_draw_id',v_draw_id,
           'prior_settlement_migration','20260908132643',
           'historical_adoption',true,
           'escrow_already_applied',true)) <> 1
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.category = 'spin_prize'
            AND (
              l.tournament_id = v_tid
              OR (l.to_type = 'prize_liability'
                  AND l.to_entity_id = v_tid)
              OR l.idempotency_key LIKE 'spin:' || v_tid::text || ':draw%'
            )) <> 1
     OR (SELECT count(*) FROM public.chip_ledger_idem k
          WHERE k.idempotency_key = v_key
            AND k.leg_id = v_journal_id) <> 1 THEN
    RAISE EXCEPTION
      'Spin % missing draw journal was not adopted exactly once',v_tid;
  END IF;

  IF (SELECT to_jsonb(e) FROM public.tournament_escrow e
       WHERE e.tournament_id = v_tid) IS DISTINCT FROM v_escrow_before
     OR (SELECT to_jsonb(o) FROM public.tournament_obligations o
          WHERE o.id = v_obligation_id) IS DISTINCT FROM v_obligation_before
     OR (SELECT to_jsonb(p) FROM public.tournament_payouts p
          WHERE p.id = v_payout_id) IS DISTINCT FROM v_payout_before
     OR (SELECT to_jsonb(w) FROM public.wallet_transactions w
          WHERE w.id = v_wallet_tx_id) IS DISTINCT FROM v_wallet_tx_before
     OR (SELECT to_jsonb(a) FROM public.ca_manual_adjustments a
          WHERE a.id = v_adjustment_id) IS DISTINCT FROM v_adjustment_before
     OR (SELECT to_jsonb(l) FROM public.chip_ledger l
          WHERE l.id = v_payout_leg_id) IS DISTINCT FROM v_payout_leg_before
     OR (SELECT p.balance FROM public.spin_bonus_pools p
          WHERE p.id = v_pool_id) IS DISTINCT FROM v_pool_balance_before
     OR (SELECT round(COALESCE(sum(cm.chip_balance),0),2)
           FROM public.club_members cm
          WHERE cm.user_id = v_winner) IS DISTINCT FROM v_winner_wallets_before
     OR COALESCE(
          current_setting('app.spin_paid_journal_adoption',true),'') <> '' THEN
    RAISE EXCEPTION
      'Spin % journal adoption changed paid money evidence or left its nonce armed',v_tid;
  END IF;
END;
$adopt_paid_781cc0ee_journal$;

-- Restore the exact pre-adoption runtime body in the same transaction. No
-- deployed function understands the historical nonce, so the exception can
-- never become a general-purpose escrow bypass.
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_reserve_leg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.category = 'spin_entry' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.from_entity_id, 'spin pool to reserve', p_reserve_out => round(NEW.amount, 2));
  ELSIF NEW.category = 'spin_prize' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'spin prize from reserve', p_reserve_in => round(NEW.amount, 2));
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_reserve_leg()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_on_reserve_leg()
  TO service_role;

DO $verify_781cc0ee_adoption_closed$
BEGIN
  IF md5(pg_get_functiondef(
       'public.fn_ca_escrow_on_reserve_leg()'::regprocedure))
       IS DISTINCT FROM '0d7f735d58aadeb6fe03e9daf5e21a92'
     OR (SELECT count(*) FROM pg_trigger tr
          WHERE tr.tgrelid = 'public.chip_ledger'::regclass
            AND tr.tgname = 'zz_ca_escrow_reserve_leg'
            AND NOT tr.tgisinternal
            AND tr.tgfoid =
                'public.fn_ca_escrow_on_reserve_leg()'::regprocedure
            AND tr.tgenabled = 'O'
            AND tr.tgtype = 5
            AND md5(pg_get_triggerdef(tr.oid)) =
                '37abfea4594c96da841bacdefab30c51') <> 1
     OR has_function_privilege(
          'anon','public.fn_ca_escrow_on_reserve_leg()','EXECUTE')
     OR has_function_privilege(
          'authenticated','public.fn_ca_escrow_on_reserve_leg()','EXECUTE')
     OR NOT has_function_privilege(
          'service_role','public.fn_ca_escrow_on_reserve_leg()','EXECUTE')
     OR COALESCE(
          current_setting('app.spin_paid_journal_adoption',true),'') <> '' THEN
    RAISE EXCEPTION
      'Spin 781cc0ee adoption left an escrow bypass, changed trigger binding or unsafe ACL';
  END IF;
END;
$verify_781cc0ee_adoption_closed$;


COMMIT;
