-- Diamond-only custody. Available money stays in profiles.diamonds.
-- Prepared for isolated verification; gameplay remains disabled by Phase 2.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Refuse a cutover that could strand legacy value. The prior inventory was
-- zero; any change requires an explicit, journaled forward migration.
DO $preflight$
BEGIN
 IF (SELECT count(*) FROM public.ca_arena_settings WHERE id=1)<>1 OR
    NOT EXISTS(SELECT 1 FROM public.ca_arena_settings a JOIN public.clubs c ON c.id=a.club_id
      WHERE a.id=1 AND c.asset='diamonds' AND c.is_platform AND c.union_id IS NULL) THEN
   RAISE EXCEPTION 'diamond_custody_cutover_identity_invalid';
 END IF;
 IF EXISTS(SELECT 1 FROM public.club_members m JOIN public.ca_arena_settings a ON a.club_id=m.club_id
           WHERE COALESCE(m.chip_balance,0)<>0) THEN
   RAISE EXCEPTION 'diamond_legacy_value_requires_forward_migration';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tables t JOIN public.ca_arena_settings a ON a.club_id=t.club_id)
 OR EXISTS(SELECT 1 FROM public.tournaments t JOIN public.ca_arena_settings a ON a.club_id=t.club_id) THEN
   RAISE EXCEPTION 'diamond_existing_games_require_custody_inventory';
 END IF;
END $preflight$;

ALTER TABLE public.ca_diamond_snapshots ADD COLUMN arena_fixture_diamonds numeric;

CREATE TABLE public.poker_diamond_custody (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  arena_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('cash_seat', 'tournament_entry')),
  target_id uuid NOT NULL,
  entry_key text NOT NULL CHECK (length(entry_key) BETWEEN 1 AND 160),
  balance bigint NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 2147483647),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (user_id, purpose, target_id, entry_key),
  CHECK ((state = 'released') = (released_at IS NOT NULL)),
  CHECK (state <> 'released' OR balance = 0)
);
CREATE UNIQUE INDEX poker_diamond_one_open_entry ON public.poker_diamond_custody(user_id,purpose,target_id) WHERE state <> 'released';
CREATE INDEX poker_diamond_custody_arena ON public.poker_diamond_custody(arena_id);
CREATE INDEX poker_diamond_custody_user_state ON public.poker_diamond_custody(user_id, state);

CREATE TABLE public.poker_diamond_movements (
  request_id uuid PRIMARY KEY,
  custody_id uuid NOT NULL REFERENCES public.poker_diamond_custody(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('reserve', 'release')),
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 2147483647),
  source_account text NOT NULL,
  destination_account text NOT NULL,
  wallet_journal_id uuid NOT NULL,
  request jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_account <> destination_account)
);
CREATE INDEX poker_diamond_movements_user ON public.poker_diamond_movements(user_id);
CREATE INDEX poker_diamond_movements_custody ON public.poker_diamond_movements(custody_id);

-- A reservation is not consumption. Refunds may reduce outstanding liability
-- below reserved value; the provider reversal then remains traceable as debt.
ALTER TABLE public.diamond_purchase_lots ADD COLUMN arena_reserved bigint NOT NULL DEFAULT 0
  CHECK (arena_reserved >= 0 AND arena_reserved <= issued);
CREATE TABLE public.poker_diamond_lot_reservations (
  custody_id uuid NOT NULL REFERENCES public.poker_diamond_custody(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES public.diamond_purchase_lots(id) ON DELETE RESTRICT,
  amount bigint NOT NULL CHECK (amount > 0),
  released_at timestamptz,
  PRIMARY KEY (custody_id, lot_id)
);

CREATE INDEX poker_diamond_lot_reservations_lot ON public.poker_diamond_lot_reservations(lot_id);

CREATE TABLE public.poker_diamond_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custody_id uuid NOT NULL REFERENCES public.poker_diamond_custody(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE,
  operation text NOT NULL CHECK (operation = 'release'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX poker_diamond_one_release_request ON public.poker_diamond_obligations(custody_id);
CREATE INDEX poker_diamond_obligations_pending ON public.poker_diamond_obligations(created_at)
 WHERE state = 'pending';

ALTER TABLE public.poker_diamond_custody ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_diamond_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_diamond_lot_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_diamond_obligations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.poker_diamond_custody, public.poker_diamond_movements,
 public.poker_diamond_lot_reservations, public.poker_diamond_obligations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.poker_diamond_custody, public.poker_diamond_movements TO authenticated;
CREATE POLICY own_custody ON public.poker_diamond_custody FOR SELECT TO authenticated
 USING (user_id = (SELECT auth.uid()));
CREATE POLICY own_movements ON public.poker_diamond_movements FOR SELECT TO authenticated
 USING (user_id = (SELECT auth.uid()));
GRANT SELECT ON public.poker_diamond_custody, public.poker_diamond_movements,
 public.poker_diamond_lot_reservations, public.poker_diamond_obligations TO service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'Diamond custody movements are append-only'; END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_append_only() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER poker_diamond_movements_append_only BEFORE UPDATE OR DELETE
 ON public.poker_diamond_movements FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_append_only();

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_reserve(
 p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text,
 p_amount numeric, p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_request jsonb; v_previous public.poker_diamond_movements%ROWTYPE;
 v_wallet bigint; v_arena uuid; v_asset text; v_platform boolean; v_union uuid;
 v_min numeric; v_max numeric; v_status text; v_custody uuid; v_journal uuid;
 v_locked bigint; v_days integer; v_left bigint; v_take bigint; v_lot record; v_receipt jsonb;
BEGIN
 IF p_user_id IS NULL OR p_target_id IS NULL OR p_request_id IS NULL
    OR p_purpose IS NULL OR p_purpose NOT IN ('cash_seat','tournament_entry')
    OR p_entry_key IS NULL OR length(p_entry_key) NOT BETWEEN 1 AND 160
    OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 2147483647 OR p_amount <> trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_reservation' USING ERRCODE = '22023';
 END IF;
 v_request := jsonb_build_object('user_id',p_user_id,'purpose',p_purpose,'target_id',p_target_id,
   'entry_key',p_entry_key,'amount',p_amount,'action','reserve');
 -- All operations for one wallet serialize on that profile, including shop spend/refunds.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_previous FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
   IF v_previous.request <> v_request THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
   RETURN v_previous.receipt;
 END IF;
 IF p_purpose='cash_seat' THEN
   SELECT t.club_id,t.min_buy_in,t.max_buy_in,t.status INTO v_arena,v_min,v_max,v_status
   FROM public.tables t WHERE t.id=p_target_id FOR SHARE;
   IF NOT FOUND OR v_min IS NULL OR v_max IS NULL OR p_amount<v_min OR p_amount>v_max THEN
     RAISE EXCEPTION 'invalid_diamond_table_buy_in';
   END IF;
 ELSE
   SELECT t.club_id,t.buy_in_amount+COALESCE(t.buy_in_fee,0),t.status
   INTO v_arena,v_min,v_status FROM public.tournaments t WHERE t.id=p_target_id FOR SHARE;
   IF NOT FOUND OR v_min IS NULL OR p_amount<>v_min THEN RAISE EXCEPTION 'invalid_diamond_entry_price'; END IF;
 END IF;
 SELECT asset,is_platform,union_id INTO v_asset,v_platform,v_union FROM public.clubs WHERE id=v_arena FOR SHARE;
 IF v_asset IS DISTINCT FROM 'diamonds' OR v_platform IS DISTINCT FROM true OR v_union IS NOT NULL THEN
   RAISE EXCEPTION 'diamond_asset_required';
 END IF;
 IF v_status IS NULL OR v_status IN ('completed','cancelled','closed','archived') THEN
   RAISE EXCEPTION 'diamond_target_closed';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings WHERE id=1 AND club_id=v_arena;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts WHERE user_id=p_user_id AND settled_at IS NULL AND amount>0) THEN
   RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 -- Lock lots before evaluating age/freeze, so a concurrent dispute cannot slip through.
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=p_user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id
 AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN RAISE EXCEPTION 'insufficient_settled_diamonds'; END IF;
 INSERT INTO public.poker_diamond_custody(user_id,arena_id,purpose,target_id,entry_key,balance)
 VALUES(p_user_id,v_arena,p_purpose,p_target_id,p_entry_key,p_amount) RETURNING id INTO v_custody;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id AND frozen_at IS NULL
 AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
   EXIT WHEN v_left=0;
   v_take:=LEAST(v_left,v_lot.available);
   IF v_take>0 THEN
     UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount) VALUES(v_custody,v_lot.id,v_take);
     v_left:=v_left-v_take;
   END IF;
 END LOOP;
 -- Journal the transfer before the balance update so the existing DR6 audit
 -- sees its evidence inside this same atomic transaction.
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,reference_id,
 description,source,issuance_class,counterparty,metadata)
 VALUES(p_user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
 'poker-reserve:'||p_request_id,'Reserved diamonds for Poker Arena','poker_arena','arena',
 'arena_custody:'||v_custody,jsonb_build_object('custody_id',v_custody,'request_id',p_request_id,
 'purpose',p_purpose,'target_id',p_target_id,'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=p_user_id;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_custody,'request_id',p_request_id,
 'amount',p_amount,'available_balance',v_wallet-p_amount,'custody_balance',p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,
 destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_custody,p_user_id,'reserve',p_amount,'player:'||p_user_id,
 'arena_custody:'||v_custody,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_release(p_custody_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 v_owner uuid; v_c public.poker_diamond_custody%ROWTYPE;
 v_prev public.poker_diamond_movements%ROWTYPE; v_ob public.poker_diamond_obligations%ROWTYPE;
 v_request jsonb; v_credit jsonb; v_receipt jsonb; v_lot record; v_err text; v_debt_journal uuid;
BEGIN
 IF p_custody_id IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'invalid_diamond_release'; END IF;
 SELECT user_id INTO v_owner FROM public.poker_diamond_custody WHERE id=p_custody_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_custody_not_found'; END IF;
 PERFORM id FROM public.profiles WHERE id=v_owner FOR UPDATE;
 SELECT * INTO v_c FROM public.poker_diamond_custody WHERE id=p_custody_id FOR UPDATE;
 v_request:=jsonb_build_object('action','release','custody_id',p_custody_id,'user_id',v_owner);
 SELECT * INTO v_prev FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
   IF v_prev.request<>v_request THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
   RETURN v_prev.receipt;
 END IF;
 IF v_c.state='released' THEN RAISE EXCEPTION 'diamond_custody_already_released'; END IF;
 -- Active gameplay must use its settlement contract, never return an in-flight stack.
 IF v_c.state<>'reserved' THEN RAISE EXCEPTION 'diamond_custody_requires_settlement'; END IF;
 -- The custody lock serializes this binding. A different retry identity must not
 -- leave a second obligation that can never complete after the first pays.
 IF EXISTS (SELECT 1 FROM public.poker_diamond_obligations
            WHERE custody_id=p_custody_id AND request_id<>p_request_id) THEN
   RAISE EXCEPTION 'diamond_release_request_already_bound';
 END IF;
 INSERT INTO public.poker_diamond_obligations(custody_id,request_id,operation)
 VALUES(p_custody_id,p_request_id,'release') ON CONFLICT(request_id) DO NOTHING;
 SELECT * INTO v_ob FROM public.poker_diamond_obligations WHERE request_id=p_request_id FOR UPDATE;
 IF v_ob.custody_id<>p_custody_id THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
 UPDATE public.poker_diamond_obligations SET attempts=attempts+1 WHERE id=v_ob.id;
 BEGIN
   FOR v_lot IN SELECT l.id,r.amount FROM public.poker_diamond_lot_reservations r
   JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
   WHERE r.custody_id=p_custody_id AND r.released_at IS NULL ORDER BY l.created_at,l.id FOR UPDATE OF l LOOP
     UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved-v_lot.amount WHERE id=v_lot.id;
   END LOOP;
   UPDATE public.poker_diamond_lot_reservations SET released_at=now() WHERE custody_id=p_custody_id AND released_at IS NULL;
   v_credit:=public.add_diamonds_to_balance(v_owner,v_c.balance::integer,'arena_withdraw',
     'Released Poker Arena reservation','poker-release:'||p_custody_id||':'||p_request_id);
   IF (v_credit->>'success')::boolean IS DISTINCT FROM true THEN
     RAISE EXCEPTION 'diamond_release_credit_failed:%',v_credit->>'error';
   END IF;
   IF COALESCE((v_credit->>'debt_settled')::bigint,0)>0 THEN
     SELECT id INTO v_debt_journal FROM public.diamond_transactions
       WHERE user_id=v_owner AND reference_id='debt-settlement:'||(v_credit->>'transaction_id')
       AND type='debt_settlement' AND amount=-(v_credit->>'debt_settled')::bigint;
     IF v_debt_journal IS NULL THEN RAISE EXCEPTION 'diamond_debt_journal_missing'; END IF;
     -- The shared journal trigger catches errors. This custody transaction must
     -- verify retirement explicitly before releasing its liability.
     PERFORM public.fn_ca_register_diamond_journal_row(v_debt_journal);
     IF NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger
       WHERE diamond_tx_id=v_debt_journal AND action='burn' AND asset='diamonds'
       AND holder_type='player' AND holder_id=v_owner
       AND amount=(v_credit->>'debt_settled')::bigint) THEN
       RAISE EXCEPTION 'diamond_debt_retirement_missing';
     END IF;
   END IF;
   UPDATE public.poker_diamond_custody SET balance=0,state='released',released_at=now() WHERE id=p_custody_id;
   v_receipt:=jsonb_build_object('success',true,'custody_id',p_custody_id,'request_id',p_request_id,
     'amount',v_c.balance,'available_balance',(v_credit->>'new_balance')::bigint,'custody_balance',0,
     'debt_settled',(v_credit->>'debt_settled')::bigint,'journal_id',v_credit->>'transaction_id');
   INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,
     destination_account,wallet_journal_id,request,receipt)
   VALUES(p_request_id,p_custody_id,v_owner,'release',v_c.balance,'arena_custody:'||p_custody_id,
     'player:'||v_owner,(v_credit->>'transaction_id')::uuid,v_request,v_receipt);
   UPDATE public.poker_diamond_obligations SET state='completed',completed_at=now(),last_error=NULL WHERE id=v_ob.id;
   RETURN v_receipt;
 EXCEPTION WHEN OTHERS THEN
   v_err:=SQLSTATE||':'||SQLERRM;
   UPDATE public.poker_diamond_obligations SET last_error=v_err WHERE id=v_ob.id;
   BEGIN
     PERFORM public.fn_ca_diamond_incident('ARENA:release_pending','critical',v_owner,v_c.balance,
       'fn_poker_diamond_release',jsonb_build_object('custody_id',p_custody_id,'request_id',p_request_id,'error',v_err));
   EXCEPTION WHEN OTHERS THEN
     -- Reporting must not erase the durable repayment obligation.
     UPDATE public.poker_diamond_obligations
       SET last_error=v_err||'; incident_delivery_failed:'||SQLSTATE||':'||SQLERRM
       WHERE id=v_ob.id;
     RAISE WARNING 'Diamond release incident delivery failed for custody %: %',p_custody_id,SQLERRM;
   END;
   RETURN jsonb_build_object('success',false,'pending',true,'custody_id',p_custody_id,'request_id',p_request_id,
     'error','diamond_release_pending');
 END;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_release(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_release(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_custody_balance()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT jsonb_build_object('available',p.diamonds,'in_play',
 (SELECT COALESCE(sum(c.balance),0) FROM public.poker_diamond_custody c WHERE c.user_id=p.id))
 FROM public.profiles p WHERE p.id=auth.uid();
$fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_custody_balance() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_custody_balance() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text DEFAULT 'bonus'::text, p_description text DEFAULT NULL::text, p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_old_balance bigint;
  v_new_balance bigint;
  v_txn_id uuid;
  v_multiplier numeric(4,2) := 1.00;
  v_raw_amount integer := COALESCE(p_amount, 0);
  v_actual_amount bigint;
  v_exact_type boolean;
  v_type_key text := COALESCE(p_type, 'unknown');
  v_issuance_class text;
  v_counterparty text;
  v_settled bigint := 0;
  v_settled_ids uuid[] := '{}';
  v_debt record;
  v_take bigint;
  v_settle_ref text;
BEGIN
  v_exact_type := p_type IN (
    'trivia_entry', 'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
    'pvp_stake', 'pvp_win', 'pvp_refund', 'pvp_tie_refund',
    'tournament_entry', 'tournament_entry_refund',
    'tournament_cancel_refund', 'tournament_prize',
    'daily_mission_milestone', 'arena_withdraw'
  );

  IF p_reference_id IS NULL AND v_exact_type THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required', 'reference_required', true);
  END IF;

  IF p_reference_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.diamond_transactions WHERE user_id = p_user_id AND reference_id = p_reference_id
  ) THEN
    SELECT balance_after INTO v_new_balance FROM public.diamond_transactions
     WHERE user_id = p_user_id AND reference_id = p_reference_id LIMIT 1;
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_reference', 'duplicate', true, 'new_balance', v_new_balance);
  END IF;

  -- DR4 (DIAMOND-RULINGS 17): a positive credit without a reference is refused once the rule
  -- is flipped in ca_diamond_rule_modes. Until then it is journaled and filed below.
  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL
     AND public.fn_ca_diamond_rule_mode('DR4:credit_without_reference') = 'refuse' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required',
                              'reference_required', true, 'refused_by', 'DR4:credit_without_reference');
  END IF;

  SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
    INTO v_old_balance, v_multiplier
    FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  IF v_raw_amount > 0 AND NOT v_exact_type
     AND p_type NOT IN ('purchase', 'deduction', 'adjustment', 'refund', 'transfer',
                        'diamond_gift_received', 'diamond_gift_sent', 'diamond_gift_refund',
                        'diamond_received', 'live_gift_received', 'live_gift_sent',
                        'vip_daily', 'vip_stipend')
     AND v_multiplier > 1.00 THEN
    v_actual_amount := round(v_raw_amount * v_multiplier);
  ELSE
    v_actual_amount := v_raw_amount;
    v_multiplier := 1.00;
  END IF;

  IF v_actual_amount < -2147483648 OR v_actual_amount > 2147483647 THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_amount_out_of_range', 'new_balance', v_old_balance);
  END IF;

  v_new_balance := v_old_balance + v_actual_amount;
  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_diamonds', 'new_balance', v_old_balance);
  END IF;
  IF v_new_balance > 2147483647 THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_balance_limit', 'new_balance', v_old_balance);
  END IF;

  IF v_type_key = 'arena_withdraw' THEN
    v_issuance_class := 'arena'; v_counterparty := 'arena_custody:' || p_reference_id;
  ELSIF v_type_key = 'purchase' THEN
    v_issuance_class := 'purchased'; v_counterparty := 'purchase_clearing';
  ELSIF v_type_key = 'refund' OR right(v_type_key, 7) = '_refund' THEN
    v_issuance_class := 'refund'; v_counterparty := 'revenue:' || v_type_key;
  ELSIF v_type_key IN ('transfer', 'diamond_gift_received', 'live_gift_received', 'diamond_received') THEN
    v_issuance_class := 'transferred'; v_counterparty := 'player:unknown';
  ELSIF v_type_key = 'adjustment' THEN
    v_issuance_class := 'admin'; v_counterparty := 'adjustment';
  ELSIF v_type_key IN ('union_grant', 'signup_bonus') THEN
    v_issuance_class := 'promotional'; v_counterparty := 'promo_budget:' || v_type_key;
  ELSIF v_actual_amount < 0 THEN
    v_issuance_class := 'spend'; v_counterparty := 'revenue:' || v_type_key;
  ELSE
    v_issuance_class := 'earned'; v_counterparty := 'promo_budget:' || v_type_key;
  END IF;

  -- Kill switch (standard 3.4 layer 6, review D11): a human-opened diamond_issuance freeze refuses
  -- promotional and earned credits. Purchases, refunds, transfers and adjustments are not issuance.
  IF v_actual_amount > 0 AND v_issuance_class IN ('earned', 'promotional')
     AND EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_issuance_frozen', 'new_balance', v_old_balance);
  END IF;

  -- DIAMOND-RULINGS 2: a chargeback the balance could not cover is a receivable, never a
  -- negative balance, and the next positive credit of any class settles open receivables
  -- oldest first before the player sees the rest. A debt larger than the credit is split:
  -- the paid part becomes its own settled row, the residual stays open.
  IF v_actual_amount > 0 THEN
    FOR v_debt IN
      SELECT d.id, d.amount FROM public.diamond_debts d
       WHERE d.user_id = p_user_id AND d.settled_at IS NULL
       ORDER BY d.created_at, d.id
       FOR UPDATE
    LOOP
      EXIT WHEN v_settled >= v_actual_amount;
      v_take := LEAST(v_debt.amount, v_actual_amount - v_settled);
      IF v_take >= v_debt.amount THEN
        UPDATE public.diamond_debts SET settled_at = now(), settled_by = 'add_diamonds_to_balance'
         WHERE id = v_debt.id;
      ELSE
        UPDATE public.diamond_debts SET amount = amount - v_take WHERE id = v_debt.id;
        INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason, created_at, settled_at, settled_by)
        SELECT d.user_id, d.purchase_id, v_take,
               d.reason || ' (partial settlement of ' || d.id::text || ')',
               d.created_at, now(), 'add_diamonds_to_balance'
          FROM public.diamond_debts d WHERE d.id = v_debt.id;
      END IF;
      v_settled := v_settled + v_take;
      v_settled_ids := v_settled_ids || v_debt.id;
    END LOOP;
  END IF;

  UPDATE public.profiles
     SET diamonds = v_new_balance - v_settled, diamond_balance = v_new_balance - v_settled, updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.diamond_transactions (
    user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata,
    counterparty, issuance_class
  ) VALUES (
    p_user_id, v_actual_amount, p_type, p_type,
    CASE WHEN v_actual_amount <> v_raw_amount
         THEN COALESCE(p_description, '') || format(' [%sx boost]', v_multiplier)
         ELSE p_description END,
    v_new_balance, p_reference_id,
    jsonb_build_object('reference_id', p_reference_id, 'raw_amount', v_raw_amount,
                       'multiplier', v_multiplier, 'exact_value', v_exact_type),
    v_counterparty, v_issuance_class
  ) RETURNING id INTO v_txn_id;

  IF v_settled > 0 THEN
    -- The settlement is its own journal row (class spend, counterparty the receivable), so the
    -- register retires what the reversed purchase had issued and the player's statement shows
    -- both the credit and what it paid off.
    v_settle_ref := 'debt-settlement:' || v_txn_id::text;
    INSERT INTO public.diamond_transactions (
      user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata,
      counterparty, issuance_class
    ) VALUES (
      p_user_id, -v_settled, 'debt_settlement', 'debt_settlement',
      'Settled ' || v_settled::text || ' diamonds owed after a reversed purchase',
      v_new_balance - v_settled, v_settle_ref,
      jsonb_build_object('reference_id', v_settle_ref, 'credit_transaction_id', v_txn_id,
                         'settled_debt_ids', to_jsonb(v_settled_ids), 'raw_amount', -v_settled,
                         'multiplier', 1.00, 'exact_value', true),
      'receivable:diamond_debts', 'spend'
    );
  END IF;

  -- DIAMOND-RULINGS 1: a debit through this door consumes purchased lots first (FIFO).
  IF v_actual_amount < 0 THEN
    PERFORM public.fn_ca_consume_purchase_lots(p_user_id, -v_actual_amount);
  END IF;

  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR4:credit_without_reference', 'warning', p_user_id, p_amount,
        'add_diamonds_to_balance', jsonb_build_object('type', p_type, 'description', p_description));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance,
                            'new_balance', v_new_balance - v_settled,
                            'amount', v_actual_amount, 'multiplier', v_multiplier, 'transaction_id', v_txn_id,
                            'debt_settled', v_settled);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_left bigint := COALESCE(p_amount, 0); v_lot record; v_take bigint; v_consumed bigint := 0;
BEGIN
  IF v_left <= 0 THEN RETURN 0; END IF;
  BEGIN
    FOR v_lot IN
      SELECT l.id, (l.issued - l.consumed - l.refunded - l.arena_reserved) AS avail
        FROM public.diamond_purchase_lots l
       WHERE l.user_id = p_user_id AND l.frozen_at IS NULL
         AND (l.issued - l.consumed - l.refunded - l.arena_reserved) > 0
       ORDER BY l.created_at, l.id
       FOR UPDATE
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_lot.avail, v_left);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_left := v_left - v_take;
      v_consumed := v_consumed + v_take;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR9:purchase_lot_write_failed', 'critical', p_user_id, p_amount,
        'fn_ca_consume_purchase_lots', jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN v_consumed;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody;
$fn$;
-- Retain the old signatures only as explicit retired-door errors. They must
-- never silently route a manual deposit into a new spendable arena wallet.
CREATE OR REPLACE FUNCTION public.fn_arena_deposit(p_amount integer,p_op_id text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'Manual arena deposits are retired; use game reservation.'; END $fn$;
CREATE OR REPLACE FUNCTION public.fn_arena_withdraw(p_amount integer,p_op_id text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'Manual arena withdrawals are retired; use game release.'; END $fn$;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_reconcile()
RETURNS TABLE(custody_id uuid,kind text,difference numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 WITH posted AS (
 SELECT m.custody_id,sum(CASE WHEN action='reserve' THEN amount ELSE -amount END) amount
 FROM public.poker_diamond_movements m GROUP BY m.custody_id
 )
 SELECT c.id,'custody_vs_movements'::text,(c.balance-COALESCE(p.amount,0))::numeric
 FROM public.poker_diamond_custody c LEFT JOIN posted p ON p.custody_id=c.id
 WHERE c.balance<>COALESCE(p.amount,0)
 UNION ALL
 SELECT m.custody_id,'wallet_journal'::text,m.amount::numeric
 FROM public.poker_diamond_movements m LEFT JOIN (SELECT id,user_id,amount FROM public.diamond_transactions UNION ALL SELECT id,user_id,amount FROM public.ca_diamond_journal_archive) t ON t.id=m.wallet_journal_id
 WHERE t.id IS NULL OR t.user_id IS DISTINCT FROM m.user_id OR
 t.amount IS DISTINCT FROM (CASE WHEN m.action='reserve' THEN -m.amount ELSE m.amount END)
 UNION ALL
 SELECT NULL::uuid,'purchase_reservations'::text,
 (l.arena_reserved-COALESCE(r.amount,0))::numeric
 FROM public.diamond_purchase_lots l LEFT JOIN (
 SELECT lot_id,sum(amount) amount FROM public.poker_diamond_lot_reservations WHERE released_at IS NULL GROUP BY lot_id
 ) r ON r.lot_id=l.id WHERE l.arena_reserved<>COALESCE(r.amount,0);
$fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_reconcile() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_reconcile() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_recover_releases()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE r record; v_result jsonb; v_completed integer:=0;
BEGIN
 -- Multiple workers may request a batch, but only one owns this short sweep.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('poker_diamond_release_recovery',0)) THEN RETURN 0; END IF;
 FOR r IN SELECT o.id,o.custody_id,o.request_id,c.user_id FROM public.poker_diamond_obligations o
 JOIN public.poker_diamond_custody c ON c.id=o.custody_id
 WHERE o.state='pending' ORDER BY o.attempts,o.created_at,o.id LIMIT 16 LOOP
   BEGIN
     -- Preserve profile-before-custody lock order and skip a busy player's wallet.
     PERFORM id FROM public.profiles WHERE id=r.user_id FOR UPDATE SKIP LOCKED;
     IF NOT FOUND THEN CONTINUE; END IF;
     v_result:=public.fn_poker_diamond_release(r.custody_id,r.request_id);
     IF (v_result->>'success')::boolean THEN v_completed:=v_completed+1; END IF;
   EXCEPTION WHEN OTHERS THEN
     -- One invalid obligation must not roll back another player's completed release.
     UPDATE public.poker_diamond_obligations SET attempts=attempts+1,
       last_error=SQLSTATE||':'||SQLERRM WHERE id=r.id;
   END;
 END LOOP;
 -- Diagnostics run in a separate subtransaction from recovered money.
 -- A reporting outage must never roll back the completed releases above.
 BEGIN
   FOR r IN SELECT * FROM public.fn_poker_diamond_reconcile() LOOP
     PERFORM public.fn_ca_diamond_incident('ARENA:reconciliation','critical',NULL,r.difference,
       'fn_poker_diamond_recover_releases',jsonb_build_object('custody_id',r.custody_id,'kind',r.kind));
   END LOOP;
 EXCEPTION WHEN OTHERS THEN
   RAISE WARNING 'Diamond custody reconciliation reporting failed: %:%',SQLSTATE,SQLERRM;
 END;
 RETURN v_completed;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_recover_releases() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_recover_releases() TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_vs_supply()
 RETURNS TABLE(register_net numeric, meter_total numeric, player_diamonds numeric, house_diamonds numeric, difference numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net
               FROM public.ca_mint_ledger WHERE asset = 'diamonds'),
       p AS (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0)::numeric AS held FROM public.profiles),
       h AS (SELECT COALESCE(SUM(COALESCE(balance, 0)), 0)::numeric AS held FROM public.ca_diamond_house)
  SELECT round(r.net, 2), round(p.held + h.held + public.fn_ca_arena_diamonds(), 2), round(p.held, 2), round(h.held, 2),
         round(p.held + h.held + public.fn_ca_arena_diamonds() - r.net, 2)
    FROM r, p, h;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_health()
 RETURNS TABLE(area text, status text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n bigint; v_h bigint; v_m numeric; v_t text; v_e text;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  -- EVERY AREA IS WRAPPED. The previous version called eight external functions with no handler,
  -- so one raise anywhere returned ZERO ROWS rather than twelve answers and one unknown - a report
  -- that vanishes rather than admitting what it could not read (CLAUDE.md 10.86 rule 1).

  -- A JOB IS NOT ALIVE BECAUSE IT IS SCHEDULED. This read cron.job.active alone, so a job failing
  -- on every run for a week reported ok. Same shape as 10.84's "a rule is not live because it
  -- merged". It reads job_run_details now.
  BEGIN
    SELECT count(*) FILTER (WHERE d.status = 'succeeded' AND d.end_time >= now() - interval '25 hours')
      INTO v_n
      FROM cron.job j LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.jobname = 'ca-diamond-rule-flip-daily' AND j.active;
    RETURN QUERY SELECT 'rule arming'::text,
      CASE WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-rule-flip-daily' AND active)
             THEN 'critical'
           WHEN v_n > 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-rule-flip-daily' AND active)
             THEN 'NOTHING ARMS THE RULES. Every flip_after date will pass unremarked.'
           WHEN v_n > 0 THEN 'ca-diamond-rule-flip-daily is scheduled and has succeeded in the last 25 hours.'
           ELSE 'ca-diamond-rule-flip-daily is scheduled but has not succeeded in 25 hours. '
                || 'Scheduled is not running.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'rule arming'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) FILTER (WHERE d.status = 'succeeded' AND d.end_time >= now() - interval '10 minutes')
      INTO v_n
      FROM cron.job j LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.jobname = 'ca-horse-claim-due-minute' AND j.active;
    RETURN QUERY SELECT 'horse claim button'::text,
      CASE WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute' AND active)
             THEN 'critical'
           WHEN v_n > 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute' AND active)
             THEN 'NOTHING PRESSES A HORSE''S CLAIM BUTTON. Every horse reward will expire unclaimed.'
           WHEN v_n > 0 THEN 'ca-horse-claim-due-minute has succeeded ' || v_n || ' time(s) in ten minutes.'
           ELSE 'ca-horse-claim-due-minute is scheduled but has not succeeded in ten minutes, and it '
                || 'runs every minute. Horse rewards are accumulating toward expiry.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'horse claim button'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  -- THE NUMBER THAT MUST NEVER BE NON-ZERO, and nothing was watching it. A reward that expires
  -- unclaimed leaves the `horse claims` count, so that area would have gone GREEN at the exact
  -- moment the diamonds were lost.
  --
  -- IT EXCLUDES RULING 3's BACKLOG BY REFERENCE, NOT BY A DATE. 4,703 rows (4,674 horse + 29 human,
  -- 159,275 diamonds) expired at 2026-09-08 03:11 under Dan's ruling - "no retroactive mint into
  -- idle wallets, humans and horses treated alike" - and they are NOT owed. A plain 36-hour window
  -- flagged them as a critical defect the moment this area was written, which is how a new alarm
  -- teaches people to ignore it on day one. The bound reads the recorded write-off's own timestamp,
  -- so it needs no magic date and retires itself once the window moves past it.
  BEGIN
    SELECT count(*) FILTER (WHERE p.is_horse), COALESCE(sum(u.diamond_reward_snapshot) FILTER (WHERE p.is_horse), 0)
      INTO v_h, v_m
      FROM public.user_daily_challenges u JOIN public.profiles p ON p.id = u.user_id
     WHERE u.expired_at IS NOT NULL AND NOT u.claimed
       AND u.expired_at >= now() - interval '36 hours'
       AND u.expired_at > COALESCE((SELECT max(i.occurred_at) FROM public.ca_diamond_incidents i
                                     WHERE i.rule = 'DR0:ruling_3_backlog_expired'), '-infinity'::timestamptz);
    RETURN QUERY SELECT 'rewards lost to expiry'::text,
      CASE WHEN v_h = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_h = 0 THEN 'No horse reward expired unclaimed in the last 36 hours.'
           ELSE v_h || ' horse reward(s) worth ' || v_m || ' diamonds expired UNCLAIMED in the last '
                || '36 hours. Something was owed and nothing paid it before the clock ran out.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'rewards lost to expiry'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) FILTER (WHERE p.is_horse), count(*) FILTER (WHERE NOT COALESCE(p.is_horse, false))
      INTO v_h, v_n
      FROM public.user_daily_challenges u JOIN public.profiles p ON p.id = u.user_id
     WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
       AND u.completed_at >= now() - interval '7 days'
       AND u.completed_at < now() - interval '5 minutes';
    RETURN QUERY SELECT 'horse claims'::text,
      CASE WHEN v_h = 0 THEN 'ok' WHEN v_h < 50 THEN 'attention' ELSE 'critical' END,
      CASE WHEN v_h = 0
           THEN 'No horse is owed a reward it cannot claim. ' || v_n || ' human reward(s) are '
                || 'unclaimed, which is a person choosing not to press a button, not a defect.'
           ELSE v_h || ' horse reward(s) are owed past the sweep interval; nothing but '
                || 'fn_ca_horse_claim_due presses a horse''s button.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'horse claims'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.fn_ca_diamond_rule_flip_due(true) x
      JOIN public.ca_diamond_rule_modes m ON m.rule = x.rule
     WHERE x.action IN ('blocked', 'unknown') AND m.flip_after IS NOT NULL AND m.flip_after <= now();
    RETURN QUERY SELECT 'rules overdue'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'No rule is past its arming date and still stuck.'
           ELSE v_n || ' rule(s) are past their arming date and cannot arm; read '
                || 'fn_ca_diamond_rule_flip_due(true) for each reason.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'rules overdue'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    v_m := (SELECT public.fn_ca_mint_supply('diamonds'))
           - ((SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float()
             + (SELECT COALESCE(sum(balance),0) FROM public.ca_diamond_house));
    RETURN QUERY SELECT 'money identity'::text,
      CASE WHEN v_m = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_m = 0 THEN 'players + house + custody = register, exactly.'
           ELSE 'players + house + custody differs from the register by ' || v_m || '.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'money identity'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  -- READS THE STORED SNAPSHOT; NEVER TAKES ONE. fn_ca_diamond_snapshot() is VOLATILE and INSERTs,
  -- so the previous version advanced the baseline it was reporting against - 25 snapshots in eight
  -- hours where 8 belonged to the hourly cron, one timestamp repeated seven times. The instrument
  -- destroyed the series it existed to read, and STABLE was a lie.
  BEGIN
    SELECT s.unexplained, s.taken_at::text INTO v_m, v_t
      FROM public.ca_diamond_snapshots s ORDER BY s.taken_at DESC LIMIT 1;
    RETURN QUERY SELECT 'deploy gate'::text,
      CASE WHEN v_t IS NULL THEN 'unknown'
           WHEN v_t::timestamptz < now() - interval '3 hours' THEN 'attention'
           WHEN COALESCE(v_m, -1) = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_t IS NULL THEN 'no snapshot has ever been taken; ca-diamond-snapshot-hourly may not be running'
           WHEN v_t::timestamptz < now() - interval '3 hours'
             THEN 'the newest snapshot is from ' || v_t || ', over three hours old - the hourly job is not running'
           WHEN COALESCE(v_m, -1) = 0 THEN 'The snapshot at ' || v_t || ' explains every movement.'
           ELSE COALESCE(v_m::text, 'NULL') || ' unexplained at the snapshot taken ' || v_t || '.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'deploy gate'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.fn_ca_diamond_trial_balance() x
     WHERE x.difference IS NOT NULL AND x.difference <> 0;
    RETURN QUERY SELECT 'trial balance'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_n = 0 THEN 'Every reconciling account balances against the journal.'
           ELSE v_n || ' account(s) do not reconcile.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'trial balance'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT COALESCE(sum(x.would_refuse), 0) INTO v_n FROM public.fn_ca_diamond_cap_headroom(14) x;
    RETURN QUERY SELECT 'per-user caps'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'No real user-day in fourteen days exceeds the cap that applies to it.'
           ELSE v_n || ' user-day(s) exceed the cap that applies to them.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'per-user caps'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.diamond_engine_daily_caps
     WHERE max_per_user_per_day_vip IS NOT NULL AND max_per_user_per_day IS NOT NULL
       AND max_per_user_per_day_vip < max_per_user_per_day;
    RETURN QUERY SELECT 'VIP caps'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'No cap gives a VIP less than a standard player receives.'
           ELSE v_n || ' cap(s) make VIP a downgrade.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'VIP caps'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.profiles p
     WHERE p.is_horse AND (public.fn_ca_is_cert_account(p.id) OR public.fn_ca_is_fixture_account(p.id));
    RETURN QUERY SELECT 'horses are players'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_n = 0 THEN 'No horse is classified as test equipment.'
           ELSE v_n || ' horse(s) read as harness equipment.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'horses are players'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.fn_ca_diamond_budget_reality() x
     WHERE x.verdict LIKE 'ALREADY OVER%' OR x.verdict LIKE 'FUTURE PLAN BELOW%' OR x.verdict LIKE 'BUDGETED ZERO%';
    RETURN QUERY SELECT 'budget plans'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'Every reward budget is plausible against actual issuance.'
           ELSE v_n || ' budget line(s) are fiction. They refuse nobody (ruling 21); setting them is Dan''s.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'budget plans'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.fn_ca_diamond_unreachable_money();
    RETURN QUERY SELECT 'unreachable money'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'No diamonds are stranded where nothing can reach them.'
           ELSE v_n || ' finding(s); read fn_ca_diamond_unreachable_money().' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'unreachable money'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*), max(i.occurred_at)::text INTO v_n, v_t
      FROM public.ca_diamond_incidents i
     WHERE i.rule = 'DR7:ledger_write_failed' AND i.occurred_at >= now() - interval '24 hours';
    RETURN QUERY SELECT 'evaluation coverage'::text,
      CASE WHEN COALESCE(v_n, 0) = 0 THEN 'ok'
           WHEN v_t::timestamptz >= now() - interval '1 hour' THEN 'critical'
           ELSE 'attention' END,
      CASE WHEN COALESCE(v_n, 0) = 0
           THEN 'Every award in the last 24 hours was evaluated by the rules.'
           WHEN v_t::timestamptz >= now() - interval '1 hour'
           THEN v_n || ' award(s) could not be evaluated and it is STILL HAPPENING (most recent '
                || to_char(now() - v_t::timestamptz, 'HH24:MI') || ' ago).'
           ELSE v_n || ' award(s) could not be evaluated in 24 hours, but none for '
                || to_char(now() - v_t::timestamptz, 'HH24:MI') || '; the cause appears fixed.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'evaluation coverage'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric; v_house numeric; v_arena_now numeric; v_arena_fix numeric;
  v_reg numeric; v_fix numeric; v_reg_fix numeric;
  prev RECORD; v_journal numeric; v_journal_noncert numeric; v_unexplained numeric; v_fix_unexplained numeric;
  v_basis_changed boolean := false;
  v_prev_basis numeric;
  v_mirror_bad bigint := 0;
BEGIN
  -- ONE statement, ONE snapshot (2026-09-07 review fix 4): the meter, the mirror, the fixture share,
  -- the house and the register are read together, so a signup committing between two reads cannot
  -- show as a 500 drift for one run.
  SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles),
         (SELECT COALESCE(sum(balance),0) FROM public.diamond_wallets),
         (SELECT COALESCE(sum(p.diamonds),0) FROM public.profiles p WHERE public.fn_ca_is_cert_account(p.id)),
         (SELECT COALESCE(sum(p.diamonds),0) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
         (SELECT COALESCE(balance, 0) FROM public.ca_diamond_house WHERE id = 1),
         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player'),
         (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
            FROM public.ca_mint_ledger m
           WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id))
    , public.fn_ca_arena_diamonds(),
         (SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id))
    INTO v_prof, v_wal, v_cert, v_fix, v_house, v_reg, v_reg_fix, v_arena_now, v_arena_fix;
  v_house := COALESCE(v_house, 0);

  -- The basis is what players hold PLUS what they have parked on the arena felt. Both sides of
  -- the comparison below use the same basis, so a deposit nets to zero and the deploy gate keeps
  -- meaning "diamonds appeared or vanished" rather than "diamonds moved" (2026-09-08).
  -- Custody was read in the same SQL snapshot as player balances.
  v_total := v_prof + v_arena_now;

  SELECT count(*) INTO v_mirror_bad
    FROM profiles p
    LEFT JOIN user_diamonds        ud  ON ud.user_id  = p.id
    LEFT JOIN user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN diamond_wallets      dw  ON dw.user_id  = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;

  SELECT * INTO prev FROM public.ca_diamond_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount),0) INTO v_journal FROM diamond_transactions WHERE created_at > prev.taken_at;
    SELECT COALESCE(sum(amount),0) INTO v_journal_noncert
      FROM diamond_transactions t WHERE t.created_at > prev.taken_at AND NOT public.fn_ca_is_cert_account(t.user_id);
    SELECT EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.tagged_at > prev.taken_at) INTO v_basis_changed;
    v_prev_basis := prev.profile_diamonds + COALESCE(prev.arena_diamonds, 0);
  END IF;

  -- The player identity, on stored figures, fixtures apart (2026-09-07 review fix 2):
  --   unexplained = (players - fixtures) moved - (player register - fixture register) moved.
  -- The fixture share is measured the same way and reported as its own drift class, because the
  -- certification harness writes fixture balances directly (a harness defect, DR6 at info), and a
  -- harness defect must never arm the deploy gate that protects players.
  IF prev.id IS NOT NULL AND prev.register_supply IS NOT NULL AND prev.fixture_diamonds IS NOT NULL THEN
    v_unexplained     := ((v_total - v_fix - v_arena_fix) - (v_prev_basis - prev.fixture_diamonds - COALESCE(prev.arena_fixture_diamonds,0)))
                       - ((v_reg - v_reg_fix) - (prev.register_supply - COALESCE(prev.register_fixture, 0)));
    v_fix_unexplained := (v_fix + v_arena_fix - prev.fixture_diamonds - COALESCE(prev.arena_fixture_diamonds,0)) - (v_reg_fix - COALESCE(prev.register_fixture, 0));
  ELSIF prev.id IS NOT NULL AND prev.register_supply IS NOT NULL THEN
    -- One transitional row: the previous snapshot stored the register but not the fixture split.
    v_unexplained := NULL; v_fix_unexplained := NULL;
  ELSIF prev.id IS NOT NULL AND NOT v_basis_changed THEN
    v_unexplained := (v_total - v_cert) - (v_prev_basis - COALESCE(prev.cert_diamonds, 0)) - COALESCE(v_journal_noncert, 0);
    v_fix_unexplained := NULL;
  ELSE
    v_unexplained := NULL; v_fix_unexplained := NULL;
  END IF;

  INSERT INTO public.ca_diamond_snapshots
    (arena_diamonds, profile_diamonds, wallet_diamonds, cert_diamonds, total, journaled_delta, delta_vs_prev, unexplained,
     register_supply, house_balance, fixture_diamonds, register_fixture, arena_fixture_diamonds)
  VALUES
    (v_arena_now, v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - v_prev_basis END,
     v_unexplained, v_reg, v_house, v_fix, v_reg_fix, v_arena_fix);

  IF v_mirror_bad > 0 THEN
    PERFORM public.fn_ca_diamond_incident('DR10:mirror_mismatch', 'warning', NULL, v_mirror_bad::numeric,
      'fn_ca_diamond_snapshot',
      jsonb_build_object('profiles_disagreeing', v_mirror_bad, 'profile_diamonds', v_prof, 'wallet_diamonds', v_wal,
        'note', 'the three mirrors are upserted on INSERT and UPDATE since 2026-09-07; a disagreeing or missing row means a writer bypassed the mirror trigger'));
  END IF;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 50 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_diamond_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_unexplained) > 5000 THEN 'critical' ELSE 'warning' END,
      'diamond-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained, v_prev_basis + COALESCE(v_journal,0), v_total,
      'ledger', 'ca_diamond_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'player diamond supply (fixtures excluded) moved by ' || round(v_unexplained,2)
        || ' more than the Mint register explains - a diamond writer is bypassing the register',
      false, jsonb_build_object('profile_diamonds', v_prof, 'fixture_diamonds', v_fix, 'register_supply', v_reg,
                                 'register_fixture', v_reg_fix, 'house_balance', v_house));
  END IF;

  IF v_fix_unexplained IS NOT NULL AND v_fix_unexplained <> 0 THEN
    PERFORM public.fn_ca_diamond_incident('DR6:fixture_harness_unregistered_movement', 'info', NULL, v_fix_unexplained,
      'fn_ca_diamond_snapshot',
      jsonb_build_object('fixture_diamonds', v_fix, 'prev_fixture_diamonds', prev.fixture_diamonds,
        'register_fixture', v_reg_fix, 'prev_register_fixture', prev.register_fixture,
        'note', 'certification fixture balances moved outside the journal and the register (the harness writes profiles.diamonds directly). Not a player movement. The root fix is the harness funding through fn_ca_mint and spending through deduct_diamonds.'));
  END IF;

  RETURN v_unexplained;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance(p_since timestamp with time zone DEFAULT (now() - '01:15:00'::interval))
 RETURNS TABLE(account text, balance_now numeric, balance_delta numeric, journal_net numeric, mint_net numeric, difference numeric, note text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_foundation constant timestamptz := timestamptz '2026-09-03 00:07:00+00';
  v_since   timestamptz := COALESCE(p_since, now() - interval '75 minutes');
  s0        public.ca_diamond_snapshots%ROWTYPE;
  w0        timestamptz;
  v_players numeric; v_house numeric; v_reg numeric; v_reg_players numeric; v_reg_house numeric;
  v_fix numeric; v_reg_fix numeric; v_fix_n bigint;
  v_delta   numeric; v_jrn numeric; v_jrn_live numeric; v_jrn_archive numeric; v_mint numeric;
  v_diff    numeric; v_note text; v_n bigint; v_sub numeric; v_tmp numeric;
  v_house_ledger numeric;
  v_arena numeric; v_arena_fix numeric;
  v_tot_now numeric := 0; v_tot_delta numeric := 0; v_tot_jrn numeric := 0; v_tot_mint numeric := 0;
  r record;
BEGIN
  SELECT * INTO s0 FROM public.ca_diamond_snapshots WHERE taken_at >= v_since ORDER BY taken_at ASC LIMIT 1;
  w0 := COALESCE(s0.taken_at, v_since);

  -- ONE statement, ONE snapshot (2026-09-07 review fix 4), so a signup committing between two reads
  -- cannot show as a 500 break for one run.
  SELECT (SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric FROM public.profiles p),
         (SELECT COALESCE(SUM(p.diamonds), 0) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
         (SELECT count(*) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
         (SELECT COALESCE(balance, 0) FROM public.ca_diamond_house WHERE id = 1),
         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player'),
         (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
            FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id)),
         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'house'),
         public.fn_ca_mint_supply('diamonds'), public.fn_ca_arena_diamonds(),
         (SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id))
    INTO v_players, v_fix, v_fix_n, v_house, v_reg_players, v_reg_fix, v_reg_house, v_reg, v_arena, v_arena_fix;
  v_house := COALESCE(v_house, 0);

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_jrn_live FROM public.diamond_transactions dt WHERE dt.created_at >= w0 AND dt.created_at < now();
  SELECT COALESCE(SUM(a.amount), 0) INTO v_jrn_archive FROM public.ca_diamond_journal_archive a WHERE a.created_at >= w0 AND a.created_at < now();
  v_jrn := v_jrn_live + v_jrn_archive;

  -- player_diamonds: players without the fixture harness, on stored figures.
  IF s0.id IS NULL THEN
    v_delta := NULL; v_mint := NULL; v_diff := NULL;
    v_note := 'no diamond snapshot at or after the window start, so the delta is unknown';
  ELSIF s0.register_supply IS NOT NULL AND s0.fixture_diamonds IS NOT NULL THEN
    v_delta := (v_players - v_fix) - (s0.profile_diamonds - s0.fixture_diamonds);
    v_mint  := (v_reg_players - v_reg_fix) - (s0.register_supply - COALESCE(s0.register_fixture, 0));
    v_diff  := v_delta - v_mint + (v_arena - v_arena_fix - COALESCE(s0.arena_diamonds,0) + COALESCE(s0.arena_fixture_diamonds,0));
    v_note  := 'player balances (fixtures excluded) moved ' || v_delta || ' since the ' || to_char(s0.taken_at AT TIME ZONE 'UTC', 'HH24:MI')
            || ' UTC snapshot; the player register moved ' || v_mint || ' on the same stored figures (no window skew).'
            || ' journal_net over the window is ' || v_jrn || ' (live ' || v_jrn_live || ' + archived ' || v_jrn_archive
            || '), informative: the seed trigger and the Mint house branch write no journal row.';
  ELSIF s0.register_supply IS NOT NULL THEN
    v_delta := v_players - s0.profile_diamonds;
    v_mint  := v_reg_players - s0.register_supply;
    v_diff  := v_delta - v_mint + (v_arena - COALESCE(s0.arena_diamonds,0));
    v_note  := 'transitional: the window snapshot stored the register but not the fixture split, so this row includes the certification harness. journal_net ' || v_jrn || ' informative.';
  ELSE
    v_delta := v_players - s0.profile_diamonds;
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
      FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'player' AND ml.created_at >= w0 AND ml.created_at < now();
    v_diff := v_delta - v_mint + (v_arena - COALESCE(s0.arena_diamonds,0));
    v_note := 'the window snapshot predates register_supply, so the register is windowed by created_at (boundary skew possible). journal_net ' || v_jrn || ' informative.';
  END IF;
  -- balance_now must be the SAME population balance_delta is measured on, or adding this row
  -- to fixture_accounts double counts the harness (found by the verification pass, 2026-09-08).
  DECLARE v_players_shown numeric := CASE
    WHEN s0.id IS NOT NULL AND s0.register_supply IS NOT NULL AND s0.fixture_diamonds IS NOT NULL
    THEN v_players - v_fix ELSE v_players END;
  BEGIN
    v_tot_now := v_tot_now + v_players_shown; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
    v_tot_jrn := v_tot_jrn + v_jrn; v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
    RETURN QUERY SELECT 'player_diamonds'::text, v_players_shown, v_delta, v_jrn, v_mint, v_diff,
      (v_note || CASE WHEN v_players_shown <> v_players
                      THEN ' balance_now is players WITHOUT the harness (' || v_fix || ' shown on the fixture_accounts row), so the two rows add up.'
                      ELSE '' END)::text;
  END;

  -- fixture_accounts: the certification harness, measured the same way, reported apart.
  IF s0.id IS NOT NULL AND s0.fixture_diamonds IS NOT NULL THEN
    v_delta := v_fix - s0.fixture_diamonds;
    v_mint  := v_reg_fix - COALESCE(s0.register_fixture, 0);
    v_diff  := v_delta - v_mint + (v_arena_fix - COALESCE(s0.arena_fixture_diamonds,0));
    v_note  := format('%s fixture profiles hold %s. Their balances moved %s and their register moved %s; a non-zero difference is the harness writing profiles.diamonds directly (DR6 at info). Never a player, never a horse.', v_fix_n, v_fix, v_delta, v_mint);
  ELSE
    v_delta := NULL; v_mint := NULL; v_diff := NULL;
    v_note := format('%s fixture profiles hold %s diamonds (inside player_diamonds). No stored fixture figure at the window start yet.', v_fix_n, v_fix);
  END IF;
  RETURN QUERY SELECT 'fixture_accounts'::text, v_fix, v_delta, NULL::numeric, v_mint, v_diff, v_note;

  -- diamond_house
  SELECT COALESCE(SUM(delta), 0) INTO v_house_ledger FROM public.ca_diamond_house_ledger WHERE at >= w0 AND at < now();
  SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
    FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'house' AND ml.created_at >= w0 AND ml.created_at < now();
  IF s0.id IS NOT NULL AND s0.house_balance IS NOT NULL THEN
    v_delta := v_house - s0.house_balance; v_diff := v_delta - v_house_ledger - v_mint;
    v_note := 'house moved ' || v_delta || '; the house ledger (rake, cuts, forfeits) explains ' || v_house_ledger || ' and the Mint explains ' || v_mint || '. DR14: what leaves a player and reaches no player lands here.';
  ELSE
    v_delta := NULL; v_diff := NULL;
    v_note := 'no stored house balance at the window start; ledger ' || v_house_ledger || ', mint ' || v_mint || ' shown.';
  END IF;
  v_tot_now := v_tot_now + v_house; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0); v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
  RETURN QUERY SELECT 'diamond_house'::text, v_house, v_delta, v_house_ledger, v_mint, v_diff, v_note;

  -- arena_wallets: diamonds a player has deposited onto the platform club's felt. Still theirs,
  -- still in the supply, and in neither profiles nor the house - so the identity below has to
  -- count them or a deposit reads as a break (2026-09-08).
  -- Custody was read with balances and register above.
  IF s0.id IS NOT NULL AND s0.arena_diamonds IS NOT NULL THEN
    v_delta := v_arena - s0.arena_diamonds;
  ELSE
    v_delta := NULL;
  END IF;
  v_tot_now := v_tot_now + v_arena; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
  RETURN QUERY SELECT 'arena_wallets'::text, v_arena, v_delta, NULL::numeric, NULL::numeric, NULL::numeric,
    ('diamonds on the Diamond Arena felt (dedicated diamond custody). A deposit moves them out of '
     || 'profiles.diamonds without changing the supply, so they are counted here and in the register '
     || 'identity below. The Mint issues nothing for a deposit and retires nothing for a withdrawal.')::text;

  -- register: the identity over every holder (D9), read in the same snapshot as the balances.
  RETURN QUERY SELECT 'register'::text, v_reg, NULL::numeric, NULL::numeric, NULL::numeric, (v_players + v_house + v_arena) - v_reg,
    ('fn_ca_mint_supply(diamonds) over every holder is ' || v_reg || '; players + house + arena is ' || (v_players + v_house + v_arena)
     || '. Player holders net ' || v_reg_players || ' (fixtures ' || v_reg_fix || '), house holders net ' || v_reg_house
     || ', the rest is the acknowledged pre-standard baseline and its corrections (holder circulation). difference must be 0.')::text;

  -- diamond_debts
  EXECUTE 'SELECT COALESCE(SUM(amount), 0)::numeric FROM public.diamond_debts WHERE settled_at IS NULL' INTO v_sub;
  v_tot_now := v_tot_now + v_sub;
  RETURN QUERY SELECT 'diamond_debts'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'unsettled chargeback receivable (DR1). A balance is never negative; the remainder lands here.'::text;

  -- promo_budgets_spent
  SELECT COALESCE(SUM(public.fn_ca_diamond_engine_spent(b.period, b.engine)), 0)::numeric, COALESCE(SUM(b.budget_diamonds), 0)::numeric, count(*) INTO v_sub, v_tmp, v_n
    FROM public.diamond_reward_budgets b;
  RETURN QUERY SELECT 'promo_budgets_spent'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    format('%s budget lines, %s budgeted, %s spent by players (fixture issuance excluded since 2026-09-07). A counter, not a balance.', v_n, v_tmp, v_sub);

  -- mirror_mismatch
  SELECT count(*) INTO v_n FROM public.profiles p
    LEFT JOIN public.user_diamonds ud ON ud.user_id = p.id
    LEFT JOIN public.user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN public.diamond_wallets dw ON dw.user_id = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;
  RETURN QUERY SELECT 'mirror_mismatch'::text, v_n::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'COUNT of profiles whose three mirrors disagree or are missing. The mirror trigger upserts all three legs on INSERT and UPDATE (2026-09-07); non-zero means a writer bypassed it.'::text;

  -- dead_stores
  v_sub := 0; v_note := '';
  FOR r IN SELECT * FROM (VALUES ('user_progress', 'diamonds'), ('bot_profiles', 'diamonds'), ('club_members', 'diamonds'),
                                 ('club_memberships', 'diamonds'), ('club_diamond_wallets', 'balance')) AS m(rel, col) LOOP
    BEGIN
      IF to_regclass('public.' || r.rel) IS NULL THEN v_note := v_note || r.rel || ': absent. ';
      ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                         WHERE c.table_schema = 'public' AND c.table_name = r.rel AND c.column_name = r.col) THEN
        -- Dropped on purpose (20260908033824), which is not the same thing as a query that
        -- broke. This line exists to tell those two apart, so it has to say which one it is.
        v_note := v_note || format('%s.%s: dropped. ', r.rel, r.col);
      ELSE
        EXECUTE format('SELECT COALESCE(SUM(COALESCE(%I, 0)), 0)::numeric FROM public.%I', r.col, r.rel) INTO v_tmp;
        v_sub := v_sub + v_tmp; v_note := v_note || format('%s.%s = %s. ', r.rel, r.col, v_tmp);
      END IF;
    EXCEPTION WHEN OTHERS THEN v_note := v_note || r.rel || ': unreadable. ';
    END;
  END LOOP;
  RETURN QUERY SELECT 'dead_stores'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    (v_note || 'Outside the supply; the delete list, gated on seven days of zero writes (ca_diamond_dead_store_writes).')::text;

  -- suspense (DR12)
  SELECT COALESCE(SUM(dt.amount), 0), count(*) INTO v_sub, v_n FROM public.diamond_transactions dt
   WHERE dt.created_at >= GREATEST(w0, c_foundation) AND (dt.counterparty IS NULL OR dt.counterparty = 'unknown' OR dt.issuance_class IS NULL);
  RETURN QUERY SELECT 'suspense'::text, v_sub, NULL::numeric, v_sub, NULL::numeric, NULL::numeric,
    format('%s journal rows in the window name no counterparty or class. The journal classifier fills both on INSERT since 2026-09-07 and files DR12 naming the writer, so this must read zero.', v_n);

  -- total
  RETURN QUERY SELECT 'total'::text, v_tot_now, CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta END, v_tot_jrn, v_tot_mint,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta - v_tot_mint END,
    'players + custody + house + unsettled debts. difference is player-and-house movement minus register movement (fixtures apart).'::text;
END $function$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_poker_diamond_reserve','approved','Diamond Phase 3: service-role-only, profile-locked wallet to dedicated custody; immutable request-bound movement and journal.'),
 ('fn_poker_diamond_release','approved','Diamond Phase 3: exact custody release, durable obligation, verified debt retirement and payload-bound retry.'),
 ('fn_poker_diamond_recover_releases','system','Diamond Phase 3: bounded replay of existing obligations; OpenClaw worker owns scheduling.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
UPDATE public.ca_money_rpc_registry SET status='retired',
 notes='Diamond Phase 3 retires chip-backed manual Arena deposits and withdrawals; history is preserved.'
 WHERE proname IN ('fn_arena_deposit','fn_arena_withdraw');

COMMIT;
