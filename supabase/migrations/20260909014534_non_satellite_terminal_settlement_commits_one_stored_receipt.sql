-- 20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql
--
-- A tournament used to cross five independently retryable finish doors:
-- cash places or a deal, mystery chests, bounty residual, rake and finally the
-- lifecycle update. A process crash between them left a COMPLETING event and a
-- later repair timer tried to infer which money was still owed. This migration
-- installs one service-only terminal transaction. It calls exactly one cash
-- authority, proves every other durable money row, closes the event and stores
-- an immutable receipt. A replay reads and verifies that receipt; it calls no
-- payer and moves no money.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL transaction_timeout = '180s';

DO $terminal_prerequisites$
BEGIN
  IF to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_settle_tournament_final_table_deal(uuid)') IS NULL
     OR to_regprocedure('public.fn_mystery_bounty_settle(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_finalize_bounty_pool(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_settle_tournament_rake(uuid,text)') IS NULL
     OR to_regprocedure(
          'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure(
          'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)') IS NULL
     OR to_regprocedure(
          'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)') IS NULL
     OR to_regprocedure('public.fn_mystery_bounty_pay(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)') IS NULL
     OR to_regprocedure(
          'public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_ca_tournament_rebuy_window(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)') IS NULL THEN
    RAISE EXCEPTION
      'terminal settlement requires every audited cash, bounty, mystery, satellite and rake authority';
  END IF;
  IF to_regclass('public.tournament_payouts') IS NULL
     OR to_regclass('public.tournament_obligations') IS NULL
     OR to_regclass('public.tournament_escrow') IS NULL
     OR to_regclass('public.tournament_rake_settlements') IS NULL
     OR to_regclass('public.tournament_bounty_chests') IS NULL
     OR to_regclass('public.tournament_bounty_awards') IS NULL
     OR to_regclass('public.tournament_bounty_award_recipients') IS NULL THEN
    RAISE EXCEPTION 'terminal settlement is missing required durable evidence tables';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.tournament_payouts'::regclass
       AND c.conname = 'tournament_payouts_source_check'
       AND c.convalidated
  ) THEN
    RAISE EXCEPTION
      'terminal settlement requires the closed tournament payout source vocabulary';
  END IF;
END;
$terminal_prerequisites$;

-- Drain every older tournament writer before taking any relation lock on a
-- tournament child. The live terminal path takes tournaments first and then
-- knockout, bounty, felt and ledger evidence. Taking this parent barrier before
-- either index build and every later child ALTER/trigger DDL preserves that
-- same order and prevents a cutover transaction holding a child relation from
-- waiting behind a terminal transaction that already holds tournaments.
--
-- ACCESS EXCLUSIVE is required on the parent, not merely SHARE ROW EXCLUSIVE.
-- The live terminal path first enters tournaments with SELECT ... FOR UPDATE
-- (ROW SHARE) and only later upgrades when it writes the lifecycle row. SHARE
-- ROW EXCLUSIVE is compatible with that first mode, so admitting such a path
-- here could leave this migration waiting on a child relation while the live
-- path waits to upgrade tournaments. This barrier refuses that entrant before
-- any child lock is taken. It remains held through the later cutover inventory,
-- so no timestamp inference or second lock upgrade is used.
LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE;

-- New hands receive one monotonically increasing number from
-- global_hand_number_seq. Preserve that global identity while every lookup
-- also proves table_id and history hand_id; the extra scope makes malformed
-- or legacy evidence fail closed rather than trusting the number alone.
CREATE INDEX IF NOT EXISTS idx_tournament_knockout_candidates_user_hand
  ON public.tournament_knockout_candidates
    (tournament_id,eliminated_user_id,hand_number DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_tournament_bounty_obligations_user_hand
  ON public.tournament_bounty_obligations
    (tournament_id,eliminated_user_id,hand_number DESC);

DO $knockout_generation_key_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_knockout_candidates'::regclass
          AND c.conname=
            'tournament_knockout_candidate_tournament_id_eliminated_user_key'
          AND pg_get_constraintdef(c.oid)=
            'UNIQUE (tournament_id, eliminated_user_id, seat_joined_at)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_bounty_obligations'::regclass
          AND c.conname=
            'tournament_bounty_obligations_tournament_id_eliminated_user_key'
          AND pg_get_constraintdef(c.oid)=
            'UNIQUE (tournament_id, eliminated_user_id, seat_joined_at)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.hand_atomic_commits'::regclass
          AND c.conname='hand_atomic_commits_hand_number_key'
          AND pg_get_constraintdef(c.oid)='UNIQUE (hand_number)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.hand_projection_outbox'::regclass
          AND c.conname='hand_projection_outbox_hand_number_key'
          AND pg_get_constraintdef(c.oid)='UNIQUE (hand_number)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.hand_atomic_commits'::regclass
          AND c.contype='p'
          AND pg_get_constraintdef(c.oid)=
            'PRIMARY KEY (table_id, hand_number)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_knockout_candidates'::regclass
          AND c.conname=
            'tournament_knockout_candidate_tournament_id_hand_number_eli_key'
          AND pg_get_constraintdef(c.oid)=
            'UNIQUE (tournament_id, hand_number, eliminated_user_id)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_bounty_obligations'::regclass
          AND c.conname=
            'tournament_bounty_obligations_tournament_id_hand_number_eli_key'
          AND pg_get_constraintdef(c.oid)=
            'UNIQUE (tournament_id, hand_number, eliminated_user_id)') THEN
    RAISE EXCEPTION
      'accepted hands or knockout generations lost global-hand and entry-generation identity';
  END IF;
END;
$knockout_generation_key_proof$;

-- A live split-pot bounty can credit several claimant wallets. The historical
-- function locks its event first but then pays claimants in weight order, not
-- the canonical wallet order used by terminal cash. Runtime also marks the
-- loser eliminated before invoking it, so a database deadlock victim is not a
-- harmless retry. Serialize this audited live authority on the same global
-- settlement lock before any row lock. This removes the cycle at its root and
-- makes a bounty already in flight finish before terminal closure can inspect
-- its pool or obligations.
CREATE OR REPLACE FUNCTION public.fn_collect_bounty(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_collector_user_id uuid,
  p_claimants jsonb DEFAULT NULL::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_result jsonb;
  v_shares jsonb;
  v_paid_cash numeric;
  v_added_to_head numeric;
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_prior_context text;
  v_obligation_count integer;
  v_pko_watermark bigint;
  v_t record;
  v_elim record;
  v_head numeric;
  v_available numeric;
  v_payable numeric;
  v_cash numeric;
  v_to_head numeric;
  v_cents integer;
  v_cash_cents integer;
  v_mode text;
  v_funded boolean;
  v_claimants jsonb;
  v_n integer;
  v_total_weight numeric;
  v_paid_total numeric := 0;
  v_head_total numeric := 0;
  c record;
  v_share_cents integer;
  v_assigned_cents integer := 0;
  v_i integer := 0;
  v_prior numeric;
  v_settle jsonb;
  v_desc text;
  v_core_collector_user_id uuid;
  v_core_claimants jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;

  IF COALESCE(v_context,'')
       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.id=v_context::uuid AND bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest'
     FOR UPDATE;
  ELSE
    SELECT count(*) INTO v_obligation_count
      FROM public.tournament_bounty_obligations bo
     WHERE bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest';
    IF v_obligation_count>1 THEN
      RETURN jsonb_build_object('ok',false,'reason','bounty_generation_identity_required');
    END IF;
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest'
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_ready');
  END IF;
  IF o.mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=o.tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark THEN
      RETURN jsonb_build_object('ok',false,'reason','pko_order_already_advanced',
                                'last_settled_hand_number',v_pko_watermark);
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations prior
       WHERE prior.tournament_id=o.tournament_id AND prior.mode='pko'
         AND prior.state='pending' AND prior.hand_number<o.hand_number
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','pending_pko_predecessor');
    END IF;
  END IF;
  IF o.state='settled' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id',b.collector_player_id,
             'cash',GREATEST(0,b.bounty_amount-COALESCE(b.added_to_collector_bounty,0)),
             'to_head',COALESCE(b.added_to_collector_bounty,0))
             ORDER BY b.collector_player_id),'[]'::jsonb),
           COALESCE(sum(GREATEST(0,b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))),0),
           COALESCE(sum(b.added_to_collector_bounty),0)
      INTO v_shares,v_paid_cash,v_added_to_head
      FROM public.tournament_bounties b
     WHERE b.bounty_obligation_id=o.id;
    IF NOT public.fn_bounty_obligation_has_complete_marker(o.id) THEN
      RETURN jsonb_build_object('ok',false,'reason','settled_marker_incomplete',
                                'obligation_id',o.id);
    END IF;
    IF o.mode='pko' THEN
      INSERT INTO public.tournament_pko_settlement_watermarks
        (tournament_id,last_settled_hand_number,last_obligation_id)
      VALUES (o.tournament_id,o.hand_number,o.id)
      ON CONFLICT (tournament_id) DO UPDATE
        SET last_settled_hand_number=GREATEST(
              public.tournament_pko_settlement_watermarks.last_settled_hand_number,
              EXCLUDED.last_settled_hand_number),
            last_obligation_id=CASE
              WHEN EXCLUDED.last_settled_hand_number>=
                   public.tournament_pko_settlement_watermarks.last_settled_hand_number
              THEN EXCLUDED.last_obligation_id
              ELSE public.tournament_pko_settlement_watermarks.last_obligation_id END,
            updated_at=now();
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'obligation_id',o.id,
      'marker_verified',true,'mode',o.mode,'head',o.head_amount,
      'paid_cash',v_paid_cash,'added_to_head',v_added_to_head,
      'split',jsonb_array_length(v_shares)>1,'shares',v_shares);
  END IF;

  -- Ignore caller ordering/weights. The exact pot-derived, roster-validated
  -- snapshot stored by the atomic claim is the only payout authority. The
  -- audited payer is inlined here so this root survives retirement of the
  -- temporary rolling-deployment body.
  v_core_collector_user_id := o.knocker_user_id;
  v_core_claimants := o.claimants;
  v_prior_context := current_setting('app.bounty_obligation_id',true);
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);

  <<collect_core>>
  BEGIN
    IF v_core_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'missing_party');
      EXIT collect_core;
    END IF;

    SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
           bounty_pool, bounty_pool_paid, mystery_bounty_stage
      INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
      EXIT collect_core;
    END IF;
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false)) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'not_a_bounty_tournament');
      EXIT collect_core;
    END IF;

    IF COALESCE(v_t.is_pko, false) AND COALESCE(v_t.is_mystery_bounty, false) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'undefined_pko_mystery_hybrid',
        'detail', 'PKO heads claim against bounty_pool; mystery chests are a sealed '
               || 'inventory. No split satisfies both. This event should not exist.');
      EXIT collect_core;
    END IF;

    IF COALESCE(v_t.is_mystery_bounty, false)
       AND v_t.mystery_bounty_stage = 'active' THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'mystery_phase_active');
      EXIT collect_core;
    END IF;

    IF EXISTS (
      SELECT 1 FROM tournament_bounties b
       WHERE b.tournament_id = p_tournament_id
         AND b.eliminated_player_id = p_eliminated_user_id
         AND (
           b.bounty_obligation_id = (SELECT pending.id
             FROM tournament_bounty_obligations pending
            WHERE pending.tournament_id=p_tournament_id
              AND pending.eliminated_user_id=p_eliminated_user_id
              AND pending.mode <> 'mystery_chest' AND pending.state='pending'
            ORDER BY pending.hand_number, pending.created_at LIMIT 1)
           OR (b.bounty_obligation_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM tournament_bounty_obligations pending
              WHERE pending.tournament_id=p_tournament_id
                AND pending.eliminated_user_id=p_eliminated_user_id
                AND pending.mode <> 'mystery_chest' AND pending.state='pending'))
         )
    ) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'already_collected');
      EXIT collect_core;
    END IF;

    SELECT current_bounty INTO v_elim
      FROM tournament_players
     WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'eliminated_player_not_in_tournament');
      EXIT collect_core;
    END IF;

    v_mode := CASE WHEN COALESCE(v_t.is_pko,false) THEN 'pko'
                   WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
                   ELSE 'regular' END;

    v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
    IF v_head <= 0 THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'no_head_value');
      EXIT collect_core;
    END IF;
    IF EXISTS (
      SELECT 1 FROM tournament_bounty_obligations pending
       WHERE pending.tournament_id=p_tournament_id
         AND pending.eliminated_user_id=p_eliminated_user_id
         AND pending.mode <> 'mystery_chest' AND pending.state='pending'
         AND pending.head_amount IS DISTINCT FROM round(v_head,2)
    ) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'head_snapshot_changed');
      EXIT collect_core;
    END IF;

    v_funded := COALESCE(v_t.bounty_pool, 0) > 0;
    SELECT round(COALESCE(v_t.bounty_pool,0) - COALESCE(SUM(
             CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                  ELSE wt.amount END), 0), 2)
      INTO v_available
      FROM wallet_transactions wt
     WHERE wt.related_entity_id = p_tournament_id
       AND wt.category = 'bounty';

    IF v_funded THEN
      IF v_available <= 0 THEN
        v_result := jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                                      'head', v_head, 'available', v_available);
        EXIT collect_core;
      END IF;
      IF v_available < v_head THEN
        v_result := jsonb_build_object('ok', false, 'reason', 'bounty_pool_underfunded',
                                      'head', v_head, 'available', v_available);
        EXIT collect_core;
      END IF;
      v_payable := v_head;
    ELSE
      v_payable := v_head;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id', x.uid, 'weight', x.w)), '[]'::jsonb)
      INTO v_claimants
      FROM (
        SELECT (e->>'user_id')::uuid AS uid, (e->>'weight')::numeric AS w
          FROM jsonb_array_elements(COALESCE(v_core_claimants, '[]'::jsonb)) e
         WHERE (e->>'user_id') IS NOT NULL
           AND COALESCE((e->>'weight')::numeric, 0) > 0
           AND EXISTS (
             SELECT 1 FROM tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = (e->>'user_id')::uuid)
      ) x;
    v_n := jsonb_array_length(v_claimants);
    IF v_n <= 1 THEN
      v_claimants := jsonb_build_array(jsonb_build_object(
        'user_id', v_core_collector_user_id, 'weight', 1));
      v_n := 1;
    END IF;
    SELECT sum((e->>'weight')::numeric) INTO v_total_weight
      FROM jsonb_array_elements(v_claimants) e;

    v_cents := round(v_payable * 100)::integer;
    v_desc := CASE v_mode
      WHEN 'pko' THEN 'PKO bounty (cash half) from eliminated player'
      WHEN 'mystery_pre' THEN 'Bounty collected before the mystery phase opened'
      ELSE 'Bounty collected from eliminated player' END
      || CASE WHEN v_n > 1 THEN ' (split pot, ' || v_n || ' winners)' ELSE '' END;
    v_shares := '[]'::jsonb;

    FOR c IN
      SELECT (e->>'user_id')::uuid AS uid, (e->>'weight')::numeric AS w
        FROM jsonb_array_elements(v_claimants) e
       ORDER BY (e->>'weight')::numeric ASC, (e->>'user_id')
    LOOP
      v_i := v_i + 1;
      IF v_i < v_n THEN
        v_share_cents := floor(v_cents * c.w / v_total_weight)::integer;
      ELSE
        v_share_cents := v_cents - v_assigned_cents;
      END IF;
      v_assigned_cents := v_assigned_cents + v_share_cents;
      CONTINUE WHEN v_share_cents <= 0;

      IF v_mode = 'pko' THEN
        v_cash_cents := (v_share_cents / 2)::integer;
        v_cash := v_cash_cents / 100.0;
        v_to_head := (v_share_cents - v_cash_cents) / 100.0;
      ELSE
        v_cash := v_share_cents / 100.0;
        v_to_head := 0;
      END IF;

      IF v_cash > 0 THEN
        v_prior := COALESCE((
          SELECT debt.amount_paid FROM public.tournament_obligations debt
           WHERE debt.tournament_id = p_tournament_id
             AND debt.kind = 'bounty'
             AND debt.place IS NULL
             AND debt.user_id = c.uid), 0);
        v_settle := public.fn_settle_tournament_obligation(
          p_tournament_id, 'bounty', NULL, c.uid, round(v_prior + v_cash, 2),
          'fn_collect_bounty', v_desc);
        IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
          RAISE EXCEPTION
            'fn_collect_bounty: bounty of % to % in tournament % refused (%); nothing recorded',
            v_cash, c.uid, p_tournament_id,
            COALESCE(v_settle->>'refused_reason', 'unknown');
        END IF;
        IF round(COALESCE((v_settle->>'paid')::numeric, 0), 2)
             <> round(v_cash, 2) THEN
          RAISE EXCEPTION
            'fn_collect_bounty: obligation paid % but the share is % for % in tournament %; nothing recorded',
            v_settle->>'paid', v_cash, c.uid, p_tournament_id;
        END IF;
      END IF;

      UPDATE tournament_players
         SET bounties_collected = COALESCE(bounties_collected,0) + 1,
             bounty_winnings = round(COALESCE(bounty_winnings,0) + v_cash, 2),
             current_bounty = round(COALESCE(current_bounty,0) + v_to_head, 2)
       WHERE tournament_id = p_tournament_id AND user_id = c.uid;

      INSERT INTO tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
         added_to_collector_bounty, is_mystery_revealed)
      VALUES
        (p_tournament_id, p_eliminated_user_id, c.uid,
         round(v_share_cents / 100.0, 2),
         CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END, false);

      v_paid_total := v_paid_total + v_cash;
      v_head_total := v_head_total + v_to_head;
      v_shares := v_shares || jsonb_build_object(
        'user_id', c.uid, 'cash', v_cash, 'to_head', v_to_head);
    END LOOP;

    UPDATE tournament_players SET current_bounty = 0
     WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

    IF v_funded THEN
      UPDATE tournaments
         SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_paid_total, 2)
       WHERE id = p_tournament_id;
    END IF;

    v_result := jsonb_build_object(
      'ok', true, 'mode', v_mode, 'funded', v_funded,
      'head', v_head, 'paid_cash', round(v_paid_total, 2),
      'added_to_head', round(v_head_total, 2),
      'split', v_n > 1, 'shares', v_shares,
      'capped', v_funded AND v_payable < v_head,
      'pool_remaining', CASE WHEN v_funded
                             THEN round(v_available - v_paid_total, 2) END);
  END collect_core;

  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);

  IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN
    -- A semantic pre-write refusal is safe to commit and stays pending. Any
    -- accepted payer result below must satisfy the exact marker postcondition
    -- or raise so its wallet/head/counter mutations roll back atomically.
    RETURN v_result || jsonb_build_object('obligation_id',o.id);
  END IF;

  UPDATE public.tournament_bounty_obligations bo
     SET state='settled',settled_at=COALESCE(settled_at,now()),last_error=NULL
   WHERE bo.id=o.id AND bo.state='pending'
     AND public.fn_bounty_obligation_has_complete_marker(bo.id);
  IF NOT public.fn_bounty_obligation_has_complete_marker(o.id)
     OR NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations bo
                     WHERE bo.id=o.id AND bo.state='settled') THEN
    RAISE EXCEPTION 'accepted bounty payout did not produce the exact settled marker for %',o.id
      USING ERRCODE='check_violation';
  END IF;
  IF o.mode='pko' THEN
    INSERT INTO public.tournament_pko_settlement_watermarks
      (tournament_id,last_settled_hand_number,last_obligation_id)
    VALUES (o.tournament_id,o.hand_number,o.id)
    ON CONFLICT (tournament_id) DO UPDATE
      SET last_settled_hand_number=GREATEST(
            public.tournament_pko_settlement_watermarks.last_settled_hand_number,
            EXCLUDED.last_settled_hand_number),
          last_obligation_id=CASE
            WHEN EXCLUDED.last_settled_hand_number>=
                 public.tournament_pko_settlement_watermarks.last_settled_hand_number
            THEN EXCLUDED.last_obligation_id
            ELSE public.tournament_pko_settlement_watermarks.last_obligation_id END,
          updated_at=now();
  END IF;
  RETURN v_result || jsonb_build_object('obligation_id',o.id,'marker_verified',true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  TO service_role;

-- During the rolling window the five component finish RPCs and the legacy
-- satellite-seat RPC must remain
-- service-callable for the old server, while the new terminal wrapper calls
-- those same bodies internally. Their historical bank orders differ: rake
-- reaches its union/club destination before club_wallets, while the wrapper
-- pre-owns all shared banks. Put every terminal money component behind the
-- same cross-format transaction lock used by the wrapper and satellite
-- authority before it can own any row. Reacquiring the same advisory lock
-- from inside a wrapper is transaction-local and immediate. A direct rolling
-- caller and a wrapped finish therefore cannot interleave their bank or
-- recipient locks at all.
-- The place and deal definitions are statically locked in 20260909042455;
-- restate every remaining rolling component here from its canonical source.
CREATE OR REPLACE FUNCTION public.fn_finalize_bounty_pool(p_tournament_id uuid, p_winner_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_t public.tournaments%ROWTYPE;
  v_canonical_winner uuid;
  v_winner_count integer;
  v_receipt public.tournament_bounty_completion_receipts%ROWTYPE;
  v_core_t record;
  v_residual numeric;
  v_own numeric;
  v_paid numeric;
  v_prior numeric;
  v_settle jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND pool_finalized_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.pool_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.pool_result;
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND pool_finalized_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.pool_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.pool_result;
  END IF;
  SELECT count(DISTINCT tp.user_id),(array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count,v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status='winner' AND tp.position=1;
  IF v_winner_count<>1 OR p_winner_user_id IS DISTINCT FROM v_canonical_winner THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_tournament_winner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
              WHERE r.tournament_id=p_tournament_id
                AND r.winner_user_id IS DISTINCT FROM p_winner_user_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','completion_winner_conflict');
  END IF;
  IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_bounty_obligations');
  END IF;
  IF COALESCE(v_t.is_mystery_bounty,false)
     AND v_t.mystery_bounty_stage IS DISTINCT FROM 'pending'
     AND NOT EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
                      WHERE r.tournament_id=p_tournament_id
                        AND r.mystery_settled_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','mystery_bounty_not_settled');
  END IF;
  -- Keep the complete audited payer in this public root. The temporary
  -- rolling-deployment body can therefore be dropped after engine cutover
  -- without taking tournament completion with it.
  <<finalize_bounty_core>>
  BEGIN
    SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_pool,
           bounty_pool_paid
      INTO v_core_t
      FROM tournaments
     WHERE id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'not_found');
      EXIT finalize_bounty_core;
    END IF;
    IF NOT (COALESCE(v_core_t.is_bounty,false)
            OR COALESCE(v_core_t.is_pko,false)
            OR COALESCE(v_core_t.is_mystery_bounty,false)) THEN
      v_result := jsonb_build_object(
        'ok', true, 'residual', 0, 'reason', 'not_a_bounty_tournament');
      EXIT finalize_bounty_core;
    END IF;

    IF COALESCE(v_core_t.bounty_pool, 0) <= 0 THEN
      SELECT COALESCE(NULLIF(current_bounty,0),
                      NULLIF(mystery_bounty_value,0), 0)
        INTO v_own
        FROM tournament_players
       WHERE tournament_id = p_tournament_id
         AND user_id = p_winner_user_id;
      IF COALESCE(v_own,0) <= 0 OR p_winner_user_id IS NULL THEN
        v_result := jsonb_build_object(
          'ok', true, 'residual', 0, 'funded', false);
        EXIT finalize_bounty_core;
      END IF;
      v_prior := COALESCE((
        SELECT debt.amount_paid FROM public.tournament_obligations debt
         WHERE debt.tournament_id = p_tournament_id
           AND debt.kind = 'bounty_residual'
           AND debt.place IS NULL
           AND debt.user_id = p_winner_user_id), 0);
      v_settle := public.fn_settle_tournament_obligation(
        p_tournament_id, 'bounty_residual', NULL, p_winner_user_id,
        round(v_prior + v_own, 2), 'fn_finalize_bounty_pool',
        'Tournament champion: own bounty head collected');
      IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
        RAISE EXCEPTION
          'fn_finalize_bounty_pool: own bounty head of % to % in tournament % refused (%)',
          v_own, p_winner_user_id, p_tournament_id,
          COALESCE(v_settle->>'refused_reason', 'unknown');
      END IF;
      UPDATE tournament_players
         SET bounty_winnings = round(COALESCE(bounty_winnings,0) + v_own, 2),
             current_bounty = 0
       WHERE tournament_id = p_tournament_id
         AND user_id = p_winner_user_id;
      v_result := jsonb_build_object(
        'ok', true, 'residual', v_own, 'funded', false,
        'paid_to', p_winner_user_id);
      EXIT finalize_bounty_core;
    END IF;

    SELECT round(COALESCE(SUM(
             CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                  ELSE wt.amount END), 0), 2)
      INTO v_paid
      FROM wallet_transactions wt
     WHERE wt.related_entity_id = p_tournament_id
       AND wt.category = 'bounty';

    v_residual := round(
      COALESCE(v_core_t.bounty_pool,0) - COALESCE(v_paid,0), 2);

    IF COALESCE(v_core_t.bounty_pool_paid,0)
         IS DISTINCT FROM COALESCE(v_paid,0) THEN
      UPDATE tournaments
         SET bounty_pool_paid = COALESCE(v_paid,0)
       WHERE id = p_tournament_id;
    END IF;

    IF v_residual <= 0 OR p_winner_user_id IS NULL THEN
      v_result := jsonb_build_object(
        'ok', true, 'residual', GREATEST(v_residual,0),
        'funded', true, 'ledger_paid', v_paid);
      EXIT finalize_bounty_core;
    END IF;

    v_prior := COALESCE((
      SELECT debt.amount_paid FROM public.tournament_obligations debt
       WHERE debt.tournament_id = p_tournament_id
         AND debt.kind = 'bounty_residual'
         AND debt.place IS NULL
         AND debt.user_id = p_winner_user_id), 0);
    v_settle := public.fn_settle_tournament_obligation(
      p_tournament_id, 'bounty_residual', NULL, p_winner_user_id,
      round(v_prior + v_residual, 2), 'fn_finalize_bounty_pool',
      'Unclaimed bounty pool awarded to champion');
    IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
      RAISE EXCEPTION
        'fn_finalize_bounty_pool: residual of % to % in tournament % refused (%)',
        v_residual, p_winner_user_id, p_tournament_id,
        COALESCE(v_settle->>'refused_reason', 'unknown');
    END IF;

    UPDATE tournaments
       SET bounty_pool_paid = round(COALESCE(v_paid,0) + v_residual, 2)
     WHERE id = p_tournament_id;
    UPDATE tournament_players
       SET bounty_winnings = round(
             COALESCE(bounty_winnings,0) + v_residual, 2),
           current_bounty = 0
     WHERE tournament_id = p_tournament_id
       AND user_id = p_winner_user_id;

    v_result := jsonb_build_object(
      'ok', true, 'residual', v_residual, 'funded', true,
      'ledger_paid', v_paid, 'paid_to', p_winner_user_id);
  END finalize_bounty_core;

  IF COALESCE((v_result->>'ok')::boolean,false) THEN
    INSERT INTO public.tournament_bounty_completion_receipts
      (tournament_id,winner_user_id,pool_finalized_at,pool_result,updated_at)
    VALUES (p_tournament_id,p_winner_user_id,now(),v_result,now())
    ON CONFLICT (tournament_id) DO UPDATE
      SET pool_finalized_at=COALESCE(public.tournament_bounty_completion_receipts.pool_finalized_at,EXCLUDED.pool_finalized_at),
          pool_result=COALESCE(public.tournament_bounty_completion_receipts.pool_result,EXCLUDED.pool_result),
          winner_user_id=COALESCE(public.tournament_bounty_completion_receipts.winner_user_id,EXCLUDED.winner_user_id),
          updated_at=now();
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(p_tournament_id uuid, p_winner_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_step jsonb;
  v_canonical_winner uuid;
  v_winner_count integer;
  v_receipt public.tournament_bounty_completion_receipts%ROWTYPE;
  v_award record;
  v_pool bigint;
  v_paid bigint;
  v_unclaimed bigint;
  v_stage text;
  v_core_award record;
  v_funded numeric;
  v_ledger numeric;
  v_room bigint;
  v_residual bigint;
  v_prior numeric;
  v_settle jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  -- A completed terminal receipt is the answer even after awards were voided,
  -- the stage changed, or standings were archived.  Those mutable rows cannot
  -- be used to reconstruct a prior result.
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND mystery_settled_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.mystery_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.mystery_result;
  END IF;
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND mystery_settled_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.mystery_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.mystery_result;
  END IF;
  SELECT count(DISTINCT tp.user_id),(array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count,v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status='winner' AND tp.position=1;
  IF v_winner_count<>1 OR p_winner_user_id IS DISTINCT FROM v_canonical_winner THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_tournament_winner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
              WHERE r.tournament_id=p_tournament_id
                AND r.winner_user_id IS DISTINCT FROM p_winner_user_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','completion_winner_conflict');
  END IF;
  -- Reserved/revealed awards are earned debts, not inventory the champion may
  -- absorb.  Resolve each exact award under the tournament lock before the
  -- historical terminal body calculates the genuinely unclaimed inventory.
  FOR v_award IN
    SELECT a.id,a.status FROM public.tournament_bounty_awards a
     WHERE a.tournament_id=p_tournament_id
       AND a.status IN ('reserved','revealed','paid')
     ORDER BY a.id FOR UPDATE
  LOOP
    IF v_award.status='reserved' THEN
      v_step := public.fn_mystery_bounty_reveal(v_award.id,NULL,true);
      IF NOT COALESCE((v_step->>'ok')::boolean,false) THEN
        RAISE EXCEPTION 'terminal mystery reveal refused for award %: %',
          v_award.id,COALESCE(v_step::text,'null') USING ERRCODE='check_violation';
      END IF;
    END IF;
    v_step := public.fn_mystery_bounty_pay(v_award.id);
    IF NOT COALESCE((v_step->>'ok')::boolean,false)
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.id=v_award.id AND a.status='completed'
            AND NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_award_recipients r
               WHERE r.award_id=a.id AND r.paid_at IS NULL
            )
       ) THEN
      RAISE EXCEPTION 'terminal mystery payment incomplete for award %: %',
        v_award.id,COALESCE(v_step::text,'null') USING ERRCODE='check_violation';
    END IF;
  END LOOP;
  IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_bounty_obligations');
  END IF;
  -- Inline the complete audited closeout. Stage two removes the temporary
  -- unguarded body, so the live terminal root must retain no hidden delegate.
  <<mystery_settle_core>>
  BEGIN
    SELECT mystery_bounty_stage,
           COALESCE(mystery_bounty_pool_cents, 0),
           COALESCE(bounty_pool, 0)
      INTO v_stage, v_pool, v_funded
      FROM public.tournaments
     WHERE id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'tournament_not_found');
      EXIT mystery_settle_core;
    END IF;
    IF v_stage = 'pending' THEN
      v_result := jsonb_build_object(
        'ok', true, 'reason', 'never_activated', 'unclaimed_cents', 0,
        'pool_cents', 0, 'settled_cents', 0, 'balanced', true,
        'variance_cents', 0);
      EXIT mystery_settle_core;
    END IF;

    FOR v_core_award IN
      SELECT id FROM public.tournament_bounty_awards
       WHERE tournament_id = p_tournament_id
         AND status = 'revealed'
       ORDER BY id
       FOR UPDATE
    LOOP
      PERFORM public.fn_mystery_bounty_pay(v_core_award.id);
    END LOOP;

    SELECT COALESCE(sum(r.amount_cents), 0)
      INTO v_paid
      FROM public.tournament_bounty_award_recipients r
      JOIN public.tournament_bounty_awards a ON a.id = r.award_id
     WHERE a.tournament_id = p_tournament_id
       AND r.paid_at IS NOT NULL;

    SELECT COALESCE(sum(amount_cents), 0)
      INTO v_unclaimed
      FROM public.tournament_bounty_chests
     WHERE tournament_id = p_tournament_id
       AND status IN ('available','reserved','revealed');

    v_residual := v_unclaimed;
    IF v_residual > 0 AND v_funded > 0 THEN
      SELECT round(COALESCE(SUM(
               CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                    ELSE wt.amount END), 0), 2)
        INTO v_ledger
        FROM wallet_transactions wt
       WHERE wt.related_entity_id = p_tournament_id
         AND wt.category = 'bounty';

      v_room := GREATEST(
        0, floor((v_funded - COALESCE(v_ledger, 0)) * 100))::bigint;
      IF v_residual > v_room THEN
        INSERT INTO financial_alerts (severity, source, message, context)
        VALUES (
          'critical', 'fn_mystery_bounty_settle',
          'Champion residual clamped: the unclaimed chests are worth more than the bounty pool still holds',
          jsonb_build_object(
            'tournament_id', p_tournament_id,
            'unclaimed_cents', v_unclaimed,
            'room_cents', v_room,
            'ledger_paid', v_ledger,
            'bounty_pool', v_funded,
            'detail', 'the clamp is not the bug, it is the seatbelt -- find the payer that already spent the pool'));
        v_residual := v_room;
      END IF;
    END IF;

    IF p_winner_user_id IS NOT NULL THEN
      IF v_residual > 0 THEN
        v_prior := COALESCE((
          SELECT debt.amount_paid FROM public.tournament_obligations debt
           WHERE debt.tournament_id = p_tournament_id
             AND debt.kind = 'mystery_bounty'
             AND debt.place IS NULL
             AND debt.user_id = p_winner_user_id), 0);
        v_settle := public.fn_settle_tournament_obligation(
          p_tournament_id, 'mystery_bounty', NULL, p_winner_user_id,
          round(v_prior + (v_residual / 100.0), 2),
          'fn_mystery_bounty_settle',
          'Unclaimed mystery bounty chests awarded to champion');
        IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
          RAISE EXCEPTION
            'fn_mystery_bounty_settle: residual of % cents to % in tournament % refused (%)',
            v_residual, p_winner_user_id, p_tournament_id,
            COALESCE(v_settle->>'refused_reason', 'unknown');
        END IF;
        UPDATE public.tournament_players
           SET bounty_winnings = round(
                 COALESCE(bounty_winnings, 0) + (v_residual / 100.0), 2)
         WHERE tournament_id = p_tournament_id
           AND user_id = p_winner_user_id;
        UPDATE public.tournaments
           SET bounty_pool_paid = round(
                 COALESCE(bounty_pool_paid, 0) + (v_residual / 100.0), 2)
         WHERE id = p_tournament_id;
        v_paid := v_paid + v_residual;
      END IF;

      UPDATE public.tournament_bounty_awards a
         SET status = 'void'
       WHERE a.tournament_id = p_tournament_id
         AND a.status <> 'completed'
         AND EXISTS (
           SELECT 1 FROM public.tournament_bounty_chests c
            WHERE c.id = a.chest_id
              AND c.status IN ('available','reserved','revealed'));

      UPDATE public.tournament_bounty_chests
         SET status = 'void'
       WHERE tournament_id = p_tournament_id
         AND status IN ('available','reserved','revealed');
    END IF;

    UPDATE public.tournaments
       SET mystery_bounty_stage = 'complete'
     WHERE id = p_tournament_id;

    v_result := jsonb_build_object(
      'ok', true, 'pool_cents', v_pool, 'settled_cents', v_paid,
      'unclaimed_cents', v_unclaimed, 'residual_paid_cents', v_residual,
      'balanced', v_paid = v_pool, 'variance_cents', v_paid - v_pool);
  END mystery_settle_core;

  IF NOT COALESCE((v_result->>'ok')::boolean,false)
     OR NOT COALESCE((v_result->>'balanced')::boolean,false) THEN
    -- The historical body can already have paid a clamp/residual or voided a
    -- chest before reporting imbalance. A normal RETURN would commit that
    -- partial terminal state. The guarded contract is all-or-nothing.
    RAISE EXCEPTION 'mystery bounty settlement refused or unbalanced: %',v_result
      USING ERRCODE='check_violation';
  END IF;
  INSERT INTO public.tournament_bounty_completion_receipts
    (tournament_id,winner_user_id,mystery_settled_at,mystery_result,updated_at)
  VALUES (p_tournament_id,p_winner_user_id,now(),v_result,now())
  ON CONFLICT (tournament_id) DO UPDATE
    SET mystery_settled_at=COALESCE(public.tournament_bounty_completion_receipts.mystery_settled_at,EXCLUDED.mystery_settled_at),
        mystery_result=COALESCE(public.tournament_bounty_completion_receipts.mystery_result,EXCLUDED.mystery_result),
        winner_user_id=COALESCE(public.tournament_bounty_completion_receipts.winner_user_id,EXCLUDED.winner_user_id),
        updated_at=now();
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record; v_union uuid; v_net numeric; v_dest text; v_res jsonb;
  v_claimed integer; v_prior record; v_att jsonb; v_att_ok boolean := false;
  v_att_err text; v_users integer; v_members integer; v_done boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT t.id, t.status, t.club_id, t.name, t.current_players
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR NO KEY UPDATE;
  /* NO KEY UPDATE, not UPDATE (20260906): a cash hand's rake_records row
     references this tournament and takes KEY SHARE on it, which FOR UPDATE
     refused and NO KEY UPDATE admits. Settlement is still serialised against
     itself. */
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF upper(COALESCE(v_t.status, '')) NOT IN ('COMPLETING', 'COMPLETED', 'CANCELLED', 'CANCELED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_terminal', 'status', v_t.status);
  END IF;

  INSERT INTO public.tournament_rake_settlements (tournament_id, club_id, amount, destination, source)
  VALUES (p_tournament_id, v_t.club_id, 0, 'pending', COALESCE(p_source, 'engine'))
  ON CONFLICT (tournament_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT amount, destination, settled_at INTO v_prior
      FROM public.tournament_rake_settlements WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_settled', true,
      'amount', v_prior.amount, 'destination', v_prior.destination,
      'settled_at', v_prior.settled_at);
  END IF;

  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_net
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;

  IF v_net <= 0 OR v_t.club_id IS NULL THEN
    UPDATE public.tournament_rake_settlements
       SET amount = GREATEST(v_net, 0),
           destination = CASE WHEN v_t.club_id IS NULL THEN 'no_club' ELSE 'none' END,
           settled_at = now(),
           attributed_at = now(),
           attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'amount', GREATEST(v_net, 0), 'destination', 'none');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_t.club_id;

  /* ONE LOCK ORDER WITH atomic_distribute_rake (20260906). The cash path
     locks club_wallets FIRST and then union_wallets or clubs. This function
     credited the union wallet (or the club treasury) first and touched
     club_wallets last - the mirror image - and the two met in the middle 249
     times a day. Taking the club_wallets row here, before either credit, puts
     both writers in the same order: club_wallets -> union_wallets | clubs. */
  PERFORM 1 FROM public.club_wallets WHERE club_id = v_t.club_id FOR NO KEY UPDATE;

  -- ZERO-DRIFT phase 2: banked tournament rake = 'rake' vs the tournament.
  PERFORM set_config('app.ledger_category', 'rake', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  IF v_union IS NOT NULL THEN
    v_res := public.increment_union_wallet(
      v_union, v_net, v_t.club_id,
      'Tournament rake: ' || COALESCE(v_t.name, 'tournament')
        || ' (' || COALESCE(v_t.current_players, 0) || ' entries)'
        || ' [tournament ' || p_tournament_id || ']');
    IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'fn_settle_tournament_rake: union wallet credit failed for %: %',
        p_tournament_id, v_res;
    END IF;
    v_dest := 'union:' || v_union;
  ELSE
    PERFORM public.credit_club_rake_to_treasury(v_t.club_id, v_net);
    v_dest := 'club_treasury:' || v_t.club_id;
  END IF;

  UPDATE public.club_wallets
     SET period_rake_collected   = COALESCE(period_rake_collected, 0) + v_net,
         lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + v_net,
         updated_at = now()
   WHERE club_id = v_t.club_id;

  BEGIN
    v_att := public.fn_attribute_tournament_rake(p_tournament_id);
    v_att_ok := COALESCE((v_att->>'ok')::boolean, false);
    IF NOT v_att_ok THEN
      v_att_err := COALESCE(v_att->>'reason', 'attribution returned ok=false');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_att_err := SQLERRM;
    v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_settle_tournament_rake',
            'Rake settled but attribution failed: ' || v_att_err,
            jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net));
  END;

  v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
  v_members := COALESCE((v_att->>'members')::int, 0);

  /* ZERO IS NOT SUCCESS. Banked rake that credited nobody, while there were
     players to credit, is a FAILURE: it stays in the repair queue
     (attributed_at IS NULL) instead of being stamped as done. A settlement
     with no members is terminal - retrying it forever would pin the head of
     that queue, which is the failure mode the Heads-Up back-pay hit. */
  v_done := v_att_ok AND (v_users > 0 OR v_members = 0);
  IF v_att_ok AND v_users = 0 AND v_members > 0 THEN
    v_att_err := 'attributed_nobody';
  END IF;

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now(),
         attributed_at = CASE WHEN v_done THEN now() ELSE NULL END,
         attributed_users = v_users,
         attribution_error = v_att_err
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed', v_done,
                            'attributed_users', v_users, 'members', v_members);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text DEFAULT NULL::text, p_position integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
  v_cap      integer;
  v_existing uuid;
  v_existing_q boolean;
  v_seated   boolean;
  v_sat      record;
  v_field    integer;
  v_value    numeric;
  v_split record;
  -- Lane G (2026-09-02): the seat is paid from the satellite's own pool.
  v_sat_pool numeric;
  v_moved    numeric := 0;
  v_short    numeric := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
         bounty_amount, is_bounty, is_pko, is_mystery_bounty,
         max_players, current_players, current_level,
         late_reg_levels, rebuy_levels, prize_pool_finalized
    INTO v_t
    FROM public.tournaments
   WHERE id = p_target_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_not_found');
  END IF;

  -- A previously committed award is a replay even if admission later closed.
    SELECT source_satellite_id, COALESCE(is_satellite_qualifier, false)
      INTO v_existing, v_existing_q
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

  IF FOUND THEN

    /* CHIP STANDARD (2026-09-05): A CASH ENTRANT IS NOT AN UNKNOWN. A seat
       with is_satellite_qualifier false was bought with the player's own
       chips (its wallet debit is on the ledger); no satellite seated them, so
       this one certainly did not, and the ticket value is theirs in cash.
       NULL origin is unknown only on a seat a satellite awarded before
       2026-08-30. Sunday Deep Stack Satellite $25 (956383d2), 19:22 UTC: the
       second place had bought the target seat for 200.00 at 10:08 and was
       paid nothing while first and third were paid 200.00 each. */
    v_seated := CASE WHEN NOT v_existing_q THEN false
                     WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing_q AND v_existing IS NULL));
  END IF;

  -- One database predicate owns level-based and minutes-only late entry.
  -- ANNOUNCED/REGISTERING targets are open until their pool is finalized;
  -- RUNNING targets must pass the same locked gate as a paid registrant.
  IF v_t.status IN ('ANNOUNCED','REGISTERING') THEN
    IF COALESCE(v_t.prize_pool_finalized,false) THEN
      RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
    END IF;
  ELSIF v_t.status='RUNNING' THEN
    IF NOT public.fn_tournament_late_registration_open(p_target_id) THEN
      RETURN jsonb_build_object('ok',false,'reason','target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok',false,'reason','target_closed');
  END IF;

  SELECT count(*) INTO v_field
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_target_id;
  IF v_t.max_players IS NOT NULL AND v_field>=v_t.max_players THEN
    RETURN jsonb_build_object('ok',false,'reason','target_full');
  END IF;

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount,
    COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false) OR COALESCE(v_t.is_mystery_bounty,false));
  IF v_split.prize < 0 OR v_split.bounty < 0 OR v_split.rake < 0
     OR v_split.charge <> v_split.prize + v_split.bounty + v_split.rake THEN
    RAISE EXCEPTION 'Invalid satellite target entry split' USING ERRCODE='23514';
  END IF;
  -- Open both escrows before journal triggers observe this award's writes.
  PERFORM public.fn_ca_escrow_apply(p_target_id, 'before satellite seat');
  PERFORM public.fn_ca_escrow_apply(p_satellite_id, 'before satellite seat');

  SELECT COALESCE(NULLIF(p_username, ''),
                  NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_name
    FROM public.profiles WHERE id = p_user_id;
  v_name := COALESCE(v_name, COALESCE(NULLIF(p_username, ''), 'Player'));

  BEGIN
    INSERT INTO public.tournament_players
      (tournament_id, user_id, username, chips, status,
       is_satellite_qualifier, source_satellite_id, current_bounty)
    VALUES (p_target_id, p_user_id, v_name, 0, 'registered', true, p_satellite_id, v_split.bounty)
    RETURNING id INTO v_seat_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already seated. Move nothing - the pool was credited when the seat was
    -- first taken. But SAY WHO SEATED THEM: a re-drive of THIS satellite must
    -- stay silent, while a win in a DIFFERENT satellite deserves the ticket
    -- value in cash, and only the caller can pay it.
    --
    -- AND SAY WHEN YOU DO NOT KNOW. source_satellite_id has only been written
    -- since 2026-08-30; every seat awarded before that has it NULL. Collapsing
    -- NULL to FALSE answers "a different satellite seated them" and sends the
    -- caller down the branch that pays cash, on top of a seat this satellite
    -- may well have awarded. NULL means unknown, and the caller pays nothing.
    SELECT source_satellite_id, COALESCE(is_satellite_qualifier, false)
      INTO v_existing, v_existing_q
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

    /* CHIP STANDARD (2026-09-05): A CASH ENTRANT IS NOT AN UNKNOWN. A seat
       with is_satellite_qualifier false was bought with the player's own
       chips (its wallet debit is on the ledger); no satellite seated them, so
       this one certainly did not, and the ticket value is theirs in cash.
       NULL origin is unknown only on a seat a satellite awarded before
       2026-08-30. Sunday Deep Stack Satellite $25 (956383d2), 19:22 UTC: the
       second place had bought the target seat for 200.00 at 10:08 and was
       paid nothing while first and third were paid 200.00 each. */
    v_seated := CASE WHEN NOT v_existing_q THEN false
                     WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing_q AND v_existing IS NULL));
  END;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool      = COALESCE(prize_pool, 0) + v_split.prize,
         bounty_pool     = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake      = COALESCE(total_rake, 0) + COALESCE(v_t.buy_in_fee, 0)
   WHERE id = p_target_id;

  IF COALESCE(v_t.buy_in_fee, 0) > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_t.buy_in_fee,
            COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 1, 0,
            true, p_target_id, 'fn_award_satellite_seat',
            jsonb_build_object('kind', 'satellite_seat_entry_fee', 'entry_split_version', 2,
                               'user_id', p_user_id,
                               'satellite_id', p_satellite_id,
                               'registration_id', v_seat_id));
  END IF;

  v_value := round(COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 2);

  /* THE SEAT IS PAID FROM THE SATELLITE'S OWN POOL (Lane G, 2026-09-02).
     The target was just credited buy_in + fee. Until now nobody was debited,
     so the target owed prize money it never received and the satellite kept
     a pool it had already spent. Move the seat value out of the satellite's
     prize_pool, and write the one ledger row that says where it went.

     Every newly awarded seat must have a fully funded transfer and payout
     receipt in this transaction. Existing awards still replay above. */
  BEGIN
    SELECT prize_pool INTO v_sat_pool
      FROM public.tournaments
     WHERE id = p_satellite_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Satellite source tournament does not exist' USING ERRCODE = '23503';
    END IF;
    v_sat_pool := round(COALESCE(v_sat_pool, 0), 2);
    v_moved := LEAST(GREATEST(v_sat_pool, 0), v_value);
    v_short := round(v_value - v_moved, 2);

    IF v_moved > 0 THEN
      UPDATE public.tournaments
         SET prize_pool = round(COALESCE(prize_pool, 0) - v_moved, 2)
       WHERE id = p_satellite_id;

      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_satellite_id, 'tournaments.prize_pool',
         'prize_liability', p_target_id, 'tournaments.prize_pool+total_rake',
         v_moved, 'tournament_buyin', v_t.club_id, p_satellite_id,
         'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text || ':pool_transfer',
         format('Satellite seat: %s paid from the satellite pool into %s (buy-in %s + fee %s) for the seat of %s',
                v_moved, COALESCE(v_t.name, p_target_id::text),
                COALESCE(v_t.buy_in_amount, 0), COALESCE(v_t.buy_in_fee, 0), p_user_id),
         jsonb_build_object('kind', 'satellite_seat_pool_transfer',
                            'entry_split_version', 2, 'entry_prize', v_split.prize,
                            'entry_bounty', v_split.bounty, 'entry_fee', v_split.rake,
                            'satellite_id', p_satellite_id,
                            'satellite_target_id', p_target_id,
                            'user_id', p_user_id,
                            'registration_id', v_seat_id,
                            'seat_value', v_value,
                            'moved', v_moved,
                            'unbacked', v_short),
         v_sat_pool, round(v_sat_pool - v_moved, 2))
      ;
    END IF;

    IF v_short > 0 THEN
      RAISE EXCEPTION 'Satellite pool cannot fund the entire seat: required %, available %',
        v_value, v_sat_pool USING ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The seat, target counters, source debit and journal are indivisible.
    RAISE;
  END;

  /* The payout receipt commits with the new seat and its funded transfer. */
  BEGIN
    SELECT tournament_type, prize_pool INTO v_sat
      FROM public.tournaments WHERE id = p_satellite_id;
    SELECT count(*) INTO v_field
      FROM public.tournament_players WHERE tournament_id = p_satellite_id;
    v_value := COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0);

    INSERT INTO public.tournament_payouts
      (tournament_id, user_id, "position", amount, source, idempotency_key,
       paid_at, tournament_type, field_size, prize_pool, recorded_by, metadata)
    VALUES
      (p_satellite_id, p_user_id, p_position, v_value, 'satellite_seat',
       'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text,
       now(), v_sat.tournament_type, v_field,
       -- The COLLECTED pool, as every earlier row recorded it: read before
       -- this seat's transfer reduced it.
       COALESCE(v_sat_pool, v_sat.prize_pool),
       'award_satellite_seat',
       jsonb_build_object('satellite_target_id', p_target_id,
                          'target_name', v_t.name,
                          'registration_id', v_seat_id,
                          'target_buy_in', COALESCE(v_t.buy_in_amount, 0),
                          'target_fee', COALESCE(v_t.buy_in_fee, 0),
                          'entry_split_version', 2, 'entry_prize', v_split.prize,
                          'entry_bounty', v_split.bounty,
                          'pool_transfer', v_moved,
                          'unbacked', v_short))
    ;
  EXCEPTION WHEN OTHERS THEN
    -- An award without its payout receipt must roll back in full.
    RAISE;
  END;

  RETURN jsonb_build_object(
    'ok', true, 'awarded', true, 'registration_id', v_seat_id,
    'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty,
    'rake', COALESCE(v_t.buy_in_fee, 0),
    'pool_transfer', v_moved,
    'unbacked', v_short);
END;
$function$;

-- A leaf-level transaction lock is safe only if every enclosing writer owns
-- it before its first row lock. Restate the still-live rolling roots here so
-- no sweep, ticket delivery, or maintenance wrapper can invert row -> global.
CREATE OR REPLACE FUNCTION public.fn_sweep_pending_tournament_bounties(
  p_tournament_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  candidate record;
  v_result jsonb;
  v_reserved jsonb;
  v_award_id uuid;
  v_processed integer := 0;
  v_settled integer := 0;
  v_failed integer := 0;
  v_settled_tournament_ids uuid[] := ARRAY[]::uuid[];
  v_recipients jsonb;
  v_op_hex text;
  v_op_id uuid;
  v_limit integer := GREATEST(1,LEAST(COALESCE(p_limit,20),100));
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  FOR candidate IN
    SELECT bo.id, bo.tournament_id FROM public.tournament_bounty_obligations bo
     WHERE bo.state = 'pending'
       AND bo.next_attempt_at <= now()
       AND (p_tournament_id IS NULL OR bo.tournament_id = p_tournament_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations prior
          WHERE prior.tournament_id=bo.tournament_id AND prior.state='pending'
            AND prior.mode='pko'
            AND (prior.hand_number < bo.hand_number
                 OR (prior.hand_number=bo.hand_number
                     AND prior.eliminated_user_id::text < bo.eliminated_user_id::text))
       )
     ORDER BY bo.next_attempt_at, bo.tournament_id, bo.hand_number,
              bo.eliminated_user_id
     LIMIT v_limit
  LOOP
    BEGIN
      -- One lock order everywhere: tournament then obligation. Direct manager
      -- collection also locks tournament before its ledger trigger touches the
      -- outbox, so the global lane cannot deadlock it outbox->tournament.
      PERFORM 1 FROM public.tournaments t WHERE t.id=candidate.tournament_id FOR UPDATE;
      SELECT * INTO o FROM public.tournament_bounty_obligations bo
       WHERE bo.id=candidate.id AND bo.state='pending' AND bo.next_attempt_at<=now()
       FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
      -- The candidate query ran before these locks. Re-prove ordering after the
      -- tournament and exact obligation are locked so a predecessor committed
      -- in that window cannot be skipped.
      IF o.mode='pko' AND EXISTS (
        SELECT 1 FROM public.tournament_bounty_obligations prior
         WHERE prior.tournament_id=o.tournament_id AND prior.mode='pko'
           AND prior.state='pending'
           AND (prior.hand_number<o.hand_number
                OR (prior.hand_number=o.hand_number
                    AND prior.eliminated_user_id::text<o.eliminated_user_id::text))
      ) THEN
        CONTINUE;
      END IF;
      v_processed := v_processed + 1;

      -- Response-loss reconciliation before another call.
      IF o.mode <> 'mystery_chest'
         AND public.fn_bounty_obligation_has_complete_marker(o.id) THEN
        UPDATE public.tournament_bounty_obligations SET state='settled', settled_at=now(), last_error=NULL
         WHERE id=o.id;
        v_settled := v_settled + 1;
        IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
          v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
        END IF;
        CONTINUE;
      ELSIF o.mode = 'mystery_chest'
         AND public.fn_bounty_obligation_has_complete_marker(o.id) THEN
        UPDATE public.tournament_bounty_obligations SET state='settled', settled_at=now(), last_error=NULL
         WHERE id=o.id;
        v_settled := v_settled + 1;
        IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
          v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
        END IF;
        CONTINUE;
      END IF;

      IF o.mode = 'mystery_chest' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'user_id', x.user_id, 'weight', x.weight,
          'is_designated_revealer', x.user_id = o.knocker_user_id
        )), '[]'::jsonb)
        INTO v_recipients
        FROM (
          SELECT (e->>'user_id')::uuid AS user_id,
                 GREATEST(COALESCE((e->>'weight')::numeric, 0), 0) AS weight
            FROM jsonb_array_elements(o.claimants) e
           WHERE NULLIF(e->>'user_id','') IS NOT NULL
        ) x;
        v_op_hex := md5('mb:' || o.id::text);
        v_op_id := (substr(v_op_hex,1,8)||'-'||substr(v_op_hex,9,4)||'-4'||substr(v_op_hex,14,3)
          ||'-8'||substr(v_op_hex,18,3)||'-'||substr(v_op_hex,21,12))::uuid;
        v_reserved := public.fn_mystery_bounty_reserve(
          o.tournament_id, o.eliminated_user_id, v_recipients, o.table_id,
          o.hand_id::text, v_op_id, 1);
        IF NOT COALESCE((v_reserved->>'ok')::boolean, false) THEN
          RAISE EXCEPTION 'reserve refused: %', COALESCE(v_reserved->>'reason','unknown');
        END IF;
        v_award_id := (v_reserved->>'award_id')::uuid;
        IF COALESCE(v_reserved->>'status','') <> 'completed' THEN
          v_result := public.fn_mystery_bounty_reveal(v_award_id, NULL, true);
          IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
            RAISE EXCEPTION 'reveal refused';
          END IF;
          v_result := public.fn_mystery_bounty_pay(v_award_id);
          IF NOT COALESCE((v_result->>'ok')::boolean, false)
             OR COALESCE((v_result->>'refused_recipients')::integer,0) > 0 THEN
            RAISE EXCEPTION 'pay refused or incomplete';
          END IF;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                        WHERE a.bounty_obligation_id=o.id AND a.status='completed') THEN
          RAISE EXCEPTION 'mystery payout has no completed award marker';
        END IF;
      ELSE
        v_result := public.fn_collect_bounty_obligation(o.id);
        IF NOT COALESCE((v_result->>'ok')::boolean, false)
           AND COALESCE(v_result->>'reason','') <> 'already_collected' THEN
          RAISE EXCEPTION 'collect refused: %', COALESCE(v_result->>'reason','unknown');
        END IF;
        IF NOT public.fn_bounty_obligation_has_complete_marker(o.id) THEN
          RAISE EXCEPTION 'fixed/PKO payout markers do not conserve the full generation head';
        END IF;
      END IF;

      -- Triggers settle only after every canonical claimant (or the completed
      -- award) is durable. Never infer success from an RPC transport response.
      IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations x
                      WHERE x.id=o.id AND x.state='settled') THEN
        RAISE EXCEPTION 'payout marker did not acknowledge obligation';
      END IF;
      UPDATE public.tournament_bounty_obligations
         SET last_error=NULL, attempt_count=attempt_count+1
       WHERE id=o.id;
      v_settled := v_settled + 1;
      IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
        v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.tournament_bounty_obligations
       SET attempt_count=attempt_count+1, last_error=left(SQLERRM,1000),
             next_attempt_at=clock_timestamp()
               + make_interval(secs => LEAST(60, 5 * (attempt_count + 1)))
       WHERE id=candidate.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'processed', v_processed,
    'settled', v_settled, 'failed', v_failed,
    'settled_tournament_ids',to_jsonb(v_settled_tournament_ids),
    'pending', (SELECT count(*) FROM public.tournament_bounty_obligations
      WHERE state='pending' AND (p_tournament_id IS NULL OR tournament_id=p_tournament_id)),
    -- Return a DATABASE-CLOCK RELATIVE delay for the first order-eligible
    -- head. A later PKO row can have due=now while an earlier generation is
    -- backed off; using the raw minimum would spin the engine until the head
    -- became due. A host timestamp would repeat that bug under clock skew.
    'retry_after_ms',(
      SELECT CASE WHEN due_at IS NULL THEN NULL ELSE
        GREATEST(0,ceil(extract(epoch FROM (due_at-clock_timestamp()))*1000)::bigint)
      END
      FROM (
        SELECT min(bo.next_attempt_at) AS due_at
          FROM public.tournament_bounty_obligations bo
         WHERE bo.state='pending'
           AND (p_tournament_id IS NULL OR bo.tournament_id=p_tournament_id)
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_obligations prior
              WHERE prior.tournament_id=bo.tournament_id AND prior.state='pending'
                AND prior.mode='pko'
                AND (prior.hand_number<bo.hand_number
                     OR (prior.hand_number=bo.hand_number
                         AND prior.eliminated_user_id::text<bo.eliminated_user_id::text))
           )
      ) eligible_head
    ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_backpay_unfinalised_bounty_pools(p_apply boolean DEFAULT false, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_events integer := 0; v_paid numeric := 0;
  v_orphan integer := 0; v_orphan_chips numeric := 0; v_alerts integer := 0;
  v_refused integer := 0; v_refused_chips numeric := 0;
  v_state text; v_msg text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  FOR r IN
    WITH scanned AS (
      SELECT t.id, t.name, t.club_id, t.ended_at,
             round(COALESCE(t.bounty_pool, 0), 2) AS pool,
             COALESCE((SELECT round(sum(w.amount), 2)
                         FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id
                          AND w.type = 'credit'
                          AND w.category = 'bounty'), 0) AS wallet_bounty,
             (SELECT tp.user_id FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id AND tp.status = 'winner'
               LIMIT 1) AS champion
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND COALESCE(t.bounty_pool, 0) > 0
    )
    SELECT * FROM scanned
     -- the unpaid test is part of the SCAN now, so the limit below caps how
     -- much work one run does instead of how far back it can look
     WHERE wallet_bounty + 0.01 < pool
     -- oldest debt first: a pool that has been owed longest is settled first,
     -- and can never be pushed out of reach by newer events completing
     ORDER BY ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    IF r.champion IS NULL THEN
      v_orphan := v_orphan + 1;
      v_orphan_chips := v_orphan_chips + (r.pool - r.wallet_bounty);
      PERFORM public.fn_raise_server_financial_alert(
        'warning', 'fn_backpay_unfinalised_bounty_pools',
        format('%s holds %s chips of unpaid bounty pool and has no champion recorded, so there is nobody to settle it to',
               COALESCE(r.name, r.id::text), round(r.pool - r.wallet_bounty, 2)),
        jsonb_build_object('kind','no_champion','tournament_id',r.id,
          'club_id',r.club_id,'bounty_pool',r.pool,'paid',r.wallet_bounty,
          'retained',round(r.pool - r.wallet_bounty, 2),
          'detail','no money was moved; a residual with no recipient is a question, not a payment'),
        r.id::text);
      v_alerts := v_alerts + 1;
      CONTINUE;
    END IF;

    IF p_apply THEN
      -- ONE POOL AT A TIME (2026-09-07). fn_finalize_bounty_pool RAISES when
      -- the one payer refuses (escrow_short and friends). That refusal is
      -- right and the payer has already raised its own critical alert; what
      -- must not happen is the refusal aborting THIS run and leaving every
      -- pool behind it unpaid. The block below is a savepoint: the refused
      -- pool's partial work rolls back, the rest of the run continues.
      BEGIN
        v_res := public.fn_finalize_bounty_pool(r.id, r.champion);
        IF COALESCE((v_res->>'ok')::boolean, false) THEN
          v_paid := v_paid + COALESCE((v_res->>'residual')::numeric, 0);
        END IF;
        v_events := v_events + 1;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_refused := v_refused + 1;
        v_refused_chips := v_refused_chips + (r.pool - r.wallet_bounty);
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_backpay_unfinalised_bounty_pools',
          format('%s: bounty residual of %s chips could not be settled to the champion (%s); the sweep moved on to the next pool',
                 COALESCE(r.name, r.id::text), round(r.pool - r.wallet_bounty, 2), left(v_msg, 300)),
          jsonb_build_object('kind','refused','tournament_id',r.id,'club_id',r.club_id,
            'bounty_pool',r.pool,'paid',r.wallet_bounty,
            'residual',round(r.pool - r.wallet_bounty, 2),
            'sqlstate',v_state,'error',left(v_msg, 500),
            'detail','no money was moved for this pool; every pool behind it was still attempted'),
          'refused:' || r.id::text);
        v_alerts := v_alerts + 1;
      END;
    ELSE
      v_paid := v_paid + (r.pool - r.wallet_bounty);
      v_events := v_events + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_settled', v_events, 'chips_settled', round(v_paid, 2),
    'events_refused', v_refused, 'chips_refused', round(v_refused_chips, 2),
    'events_without_a_champion', v_orphan,
    'chips_without_a_champion', round(v_orphan_chips, 2),
    'alerts_raised', v_alerts);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sweep_unsettled_tournament_rake(
  p_since_days integer DEFAULT 45,
  p_limit integer DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record; v_res jsonb;
  v_settled integer := 0; v_chips numeric := 0; v_scanned integer := 0; v_failed integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  FOR v_row IN
    SELECT t.id
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED')
       AND t.ended_at IS NOT NULL
       AND t.ended_at > now() - make_interval(days => GREATEST(p_since_days, 1))
       AND t.ended_at < now() - interval '10 minutes'   -- never race a live finish
       AND EXISTS (SELECT 1 FROM public.rake_records r
                    WHERE r.tournament_id = t.id AND r.is_tournament)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_rake_settlements s
                        WHERE s.tournament_id = t.id)
     ORDER BY t.ended_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_scanned := v_scanned + 1;
    BEGIN
      v_res := public.fn_settle_tournament_rake(v_row.id, 'sweep');
      IF COALESCE((v_res->>'ok')::boolean, false)
         AND NOT COALESCE((v_res->>'already_settled')::boolean, false) THEN
        v_settled := v_settled + 1;
        v_chips := v_chips + COALESCE((v_res->>'amount')::numeric, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_sweep_unsettled_tournament_rake',
              'Sweep could not settle tournament rake: ' || SQLERRM,
              jsonb_build_object('tournament_id', v_row.id));
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned,
    'settled', v_settled, 'chips', round(v_chips, 2), 'failed', v_failed);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_deliver_satellite_ticket_exact(p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text, p_position integer, p_ticket_value numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target public.tournaments%ROWTYPE;
  v_existing public.tournament_players%ROWTYPE;
  v_before_target_pool numeric;
  v_before_target_bounty numeric;
  v_split record;
  v_before_target_rake numeric;
  v_before_source_pool numeric;
  v_open boolean:=false;
  v_count integer;
  v_result jsonb;
  v_registration uuid;
  v_payout uuid;
  v_payout_meta jsonb;
  v_ledger_count integer;
  v_rake_count integer;
  v_target_buyin numeric;
  v_target_fee numeric;
  v_cash_reason text:='target_not_open';
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO v_target FROM public.tournaments
   WHERE id=p_target_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('delivery','cash','reason','target_missing'); END IF;
  SELECT count(*)::integer INTO v_count FROM public.tournament_players
   WHERE tournament_id=p_target_id;
  v_open:=CASE
    WHEN v_target.status IN ('ANNOUNCED','REGISTERING')
      THEN NOT COALESCE(v_target.prize_pool_finalized,false)
    WHEN v_target.status='RUNNING'
      THEN public.fn_tournament_late_registration_open(p_target_id)
    ELSE false END;
  v_open:=v_open AND (v_target.max_players IS NULL OR v_count<v_target.max_players);
  IF round(GREATEST(COALESCE(v_target.buy_in_amount,0),0)
           +GREATEST(COALESCE(v_target.buy_in_fee,0),0),2)
       <>round(p_ticket_value,2) THEN
    -- The winner owns the frozen advertised value. Never call the historical
    -- seat RPC at a later, different target price: it would debit the source by
    -- today's price. Cash the frozen value instead.
    v_open:=false;
    v_cash_reason:='target_economics_changed';
  END IF;

  SELECT * INTO v_existing FROM public.tournament_players
   WHERE tournament_id=p_target_id AND user_id=p_user_id FOR UPDATE;
  IF FOUND THEN
    IF COALESCE(v_existing.is_satellite_qualifier,false)
       AND v_existing.source_satellite_id=p_satellite_id THEN
      SELECT count(*)::integer,(array_agg(po.id ORDER BY po.id))[1],
             (array_agg(po.metadata ORDER BY po.id))[1]
        INTO v_count,v_payout,v_payout_meta
        FROM public.tournament_payouts po
       WHERE po.tournament_id=p_satellite_id AND po.user_id=p_user_id
         AND po.position=p_position AND po.source='satellite_seat'
         AND round(po.amount,2)=round(p_ticket_value,2)
         AND po.metadata->>'registration_id'=v_existing.id::text;
      v_target_buyin:=CASE
        WHEN COALESCE(v_payout_meta->>'target_buy_in','')~'^[0-9]+([.][0-9]+)?$'
          THEN (v_payout_meta->>'target_buy_in')::numeric ELSE -1 END;
      v_target_fee:=CASE
        WHEN COALESCE(v_payout_meta->>'target_fee','')~'^[0-9]+([.][0-9]+)?$'
          THEN (v_payout_meta->>'target_fee')::numeric ELSE -1 END;
      SELECT count(*)::integer INTO v_ledger_count
        FROM public.chip_ledger l
       WHERE l.idempotency_key='tourney:'||p_satellite_id::text||':seat:'
                               ||p_user_id::text||':pool_transfer'
         AND l.from_type='prize_liability' AND l.from_entity_id=p_satellite_id
         AND l.to_type='prize_liability' AND l.to_entity_id=p_target_id
         AND round(l.amount,2)=round(p_ticket_value,2)
         AND l.metadata->>'registration_id'=v_existing.id::text
         AND CASE WHEN COALESCE(l.metadata->>'moved','')~'^[0-9]+([.][0-9]+)?$'
                  THEN round((l.metadata->>'moved')::numeric,2) ELSE -1 END
             =round(p_ticket_value,2)
         AND CASE WHEN COALESCE(l.metadata->>'unbacked','')~'^[0-9]+([.][0-9]+)?$'
                  THEN round((l.metadata->>'unbacked')::numeric,2) ELSE -1 END=0;
      SELECT count(*)::integer INTO v_rake_count
        FROM public.rake_records rr
       WHERE rr.tournament_id=p_target_id AND rr.source='fn_award_satellite_seat'
         AND rr.metadata->>'satellite_id'=p_satellite_id::text
         AND rr.metadata->>'user_id'=p_user_id::text
         AND rr.metadata->>'registration_id'=v_existing.id::text
         AND round(rr.rake_amount,2)=round(v_target_fee,2)
         AND round(COALESCE(rr.pot_size,0),2)=round(p_ticket_value,2);
      IF v_count<>1
         OR (CASE WHEN COALESCE(v_payout_meta->>'pool_transfer','')~'^[0-9]+([.][0-9]+)?$'
                 THEN round((v_payout_meta->>'pool_transfer')::numeric,2) ELSE -1 END)
            <>round(p_ticket_value,2)
         OR (CASE WHEN COALESCE(v_payout_meta->>'unbacked','')~'^[0-9]+([.][0-9]+)?$'
                 THEN round((v_payout_meta->>'unbacked')::numeric,2) ELSE -1 END)<>0
         OR round(v_target_buyin+v_target_fee,2)<>round(p_ticket_value,2)
         OR v_ledger_count<>1
         OR (v_target_fee>0 AND v_rake_count<>1)
         OR (v_target_fee=0 AND v_rake_count<>0) THEN
        RAISE EXCEPTION 'existing target seat has no exact fully-backed payout event'
          USING ERRCODE='check_violation';
      END IF;
      RETURN jsonb_build_object('delivery','seat','already',true,
        'registration_id',v_existing.id,'payout_id',v_payout);
    ELSIF COALESCE(v_existing.is_satellite_qualifier,false)
          AND v_existing.source_satellite_id IS NULL THEN
      RAISE EXCEPTION 'existing target satellite seat has ambiguous origin'
        USING ERRCODE='check_violation';
    ELSE
      RETURN jsonb_build_object('delivery','cash','reason','seat_already_held_elsewhere');
    END IF;
  END IF;
  IF NOT v_open THEN
    RETURN jsonb_build_object('delivery','cash','reason',v_cash_reason);
  END IF;

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_target.buy_in_amount,v_target.buy_in_fee,v_target.bounty_amount,
    COALESCE(v_target.is_bounty,false) OR COALESCE(v_target.is_pko,false) OR COALESCE(v_target.is_mystery_bounty,false));
  v_before_target_bounty:=round(COALESCE(v_target.bounty_pool,0),2);
  v_before_target_pool:=round(COALESCE(v_target.prize_pool,0),2);
  v_before_target_rake:=round(COALESCE(v_target.total_rake,0),2);
  SELECT round(COALESCE(t.prize_pool,0),2) INTO v_before_source_pool
    FROM public.tournaments t WHERE t.id=p_satellite_id FOR UPDATE;
  IF v_before_source_pool+0.005<round(p_ticket_value,2) THEN
    RAISE EXCEPTION 'satellite guarantee is not funded for its frozen ticket'
      USING ERRCODE='check_violation';
  END IF;

  v_result:=public.fn_award_satellite_seat(
    p_satellite_id,p_target_id,p_user_id,p_username,p_position);
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'awarded')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'pool_transfer')::numeric,-1)
          <>round(p_ticket_value,2)
     OR COALESCE((v_result->>'unbacked')::numeric,-1)<>0 THEN
    RAISE EXCEPTION 'exact target-seat award refused or wrote incomplete money: %',
      COALESCE(v_result::text,'null') USING ERRCODE='check_violation';
  END IF;
  v_registration:=(v_result->>'registration_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.id=v_registration AND tp.tournament_id=p_target_id
       AND tp.user_id=p_user_id AND tp.source_satellite_id=p_satellite_id
       AND COALESCE(tp.is_satellite_qualifier,false)
  ) THEN
    RAISE EXCEPTION 'seat helper returned without the exact target registration'
      USING ERRCODE='check_violation';
  END IF;
  SELECT count(*)::integer,(array_agg(po.id ORDER BY po.id))[1] INTO v_count,v_payout
    FROM public.tournament_payouts po
   WHERE po.tournament_id=p_satellite_id AND po.user_id=p_user_id
     AND po.position=p_position AND po.source='satellite_seat'
     AND round(po.amount,2)=round(p_ticket_value,2)
     AND po.metadata->>'registration_id'=v_registration::text
     AND round(COALESCE((po.metadata->>'pool_transfer')::numeric,-1),2)
          =round(p_ticket_value,2)
     AND round(COALESCE((po.metadata->>'unbacked')::numeric,-1),2)=0;
  IF v_count<>1
     OR (SELECT round(COALESCE(t.prize_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id)
          <>v_before_target_pool+v_split.prize
     OR (SELECT round(COALESCE(t.bounty_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id) <>v_before_target_bounty+v_split.bounty
     OR (SELECT round(COALESCE(t.total_rake,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id)
          <>v_before_target_rake+round(COALESCE(v_target.buy_in_fee,0),2)
     OR (SELECT round(COALESCE(t.prize_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_satellite_id)
          <>v_before_source_pool-round(p_ticket_value,2) THEN
    RAISE EXCEPTION 'target seat, payout and pool transfer are not one exact event'
      USING ERRCODE='check_violation';
  END IF;
  RETURN jsonb_build_object('delivery','seat','already',false,
    'registration_id',v_registration,'payout_id',v_payout);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_finish_atomic(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine.satellite_finish'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  RETURN public.fn_settle_satellite_finish_atomic_before_maintenance_gate(
    p_tournament_id, p_source
  );
END;
$function$;


-- The retired-on-stage-two final-table authority is still callable by an
-- older engine during rollout. It must enter the shared lane before its own
-- tournament lock because it invokes the same bounty and rake leaves.
CREATE OR REPLACE FUNCTION public.fn_settle_final_table_deal_atomic(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_t                       record;
  v_batch                   public.tournament_final_table_deal_batches%ROWTYPE;
  v_check                   jsonb;
  v_struct                  jsonb := '[]'::jsonb;
  v_trimmed                 jsonb := '[]'::jsonb;
  v_place_plan              jsonb := '[]'::jsonb;
  v_deal_shares             jsonb := '[]'::jsonb;
  v_deal_plan               jsonb := '[]'::jsonb;
  v_plan                    jsonb := '[]'::jsonb;
  v_payouts                 jsonb := '[]'::jsonb;
  v_plan_fingerprint        text;
  v_prior_standings_fingerprint text;
  v_live_input_snapshot     jsonb := '[]'::jsonb;
  v_live_input_fingerprint  text;
  v_field_count             integer := 0;
  v_live_count              integer := 0;
  v_deal_table_id           uuid;
  v_seated_active_tables    integer := 0;
  v_all_live_seats          integer := 0;
  v_active_live_seats       integer := 0;
  v_distinct_seat_users     integer := 0;
  v_matching_live_users     integer := 0;
  v_seat_stack_mismatches   integer := 0;
  v_live_missing_registration integer := 0;
  v_other_count             integer := 0;
  v_live_positioned         integer := 0;
  v_eliminated_count        integer := 0;
  v_eliminated_ranked       integer := 0;
  v_eliminated_distinct     integer := 0;
  v_eliminated_min          integer := 0;
  v_eliminated_max          integer := 0;
  v_eliminated_missing_time integer := 0;
  v_eliminated_canonical_mismatches integer := 0;
  v_structure_places        integer := 0;
  v_structure_distinct      integer := 0;
  v_structure_min           integer := 0;
  v_structure_max           integer := 0;
  v_total_bp                bigint := 0;
  v_pool_cents              bigint := 0;
  v_remaining_cents         bigint := 0;
  v_expected_cents          bigint := 0;
  v_place_total_cents       bigint := 0;
  v_prior_place_paid_cents  bigint := 0;
  v_deal_total_cents        bigint := 0;
  v_available_cents         bigint := 0;
  v_unpaid_cents            bigint := 0;
  v_total_unpaid_cents      bigint := 0;
  v_floor_paid_cents        bigint := 0;
  v_remainder_cents         bigint := 0;
  v_total_chips             numeric := 0;
  v_rank                    integer := 0;
  v_share_cents             bigint := 0;
  v_leader                  uuid;
  v_holder                  uuid;
  v_holders                 integer := 0;
  v_seeded_paid             numeric := 0;
  v_wrong_recipients        integer := 0;
  v_conflicts               integer := 0;
  v_existing                public.tournament_obligations%ROWTYPE;
  v_result                  jsonb;
  v_after_paid              numeric := 0;
  v_paid_this_call          numeric := 0;
  v_place_paid_this_call    numeric := 0;
  v_deal_paid_this_call     numeric := 0;
  v_bubble_paid_this_call   numeric := 0;
  v_bubble_user             uuid;
  v_bubble_holders          integer := 0;
  v_bubble_obligations      integer := 0;
  v_bubble_matching         integer := 0;
  v_bubble_owed             numeric := 0;
  v_bubble_paid             numeric := 0;
  v_bubble_evidence         numeric := 0;
  v_bubble_conflicts        integer := 0;
  v_bubble_obligation_id    uuid;
  v_bubble_source           text;
  v_bubble_settled_at       timestamptz;
  v_bubble_row_found        boolean := false;
  v_bubble_needs_insert     boolean := false;
  v_bubble_unpaid_cents     bigint := 0;
  v_after_bubble_paid       numeric := 0;
  v_bubble_obligation_present boolean := false;
  v_bubble_payout_present   boolean := false;
  v_bubble_required         boolean := false;
  v_bubble_shape_valid      boolean := false;
  v_escrow                  public.tournament_escrow%ROWTYPE;
  v_escrow_after            numeric := 0;
  v_failure                 text;
  v_failure_state           text;
  r                         record;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  SELECT t.id, t.name, t.status, round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guaranteed_prize,
         COALESCE(t.prize_pool_finalized, false) AS prize_pool_finalized,
         COALESCE(t.final_table_deal_enabled, false) AS final_table_deal_enabled,
         COALESCE(t.table_size, 9) AS table_size, t.payout_structure,
         t.variant, t.tournament_type, t.satellite_target_id, t.spin_multiplier,
         COALESCE(t.is_bounty, false) AS is_bounty,
         COALESCE(t.is_pko, false) AS is_pko,
         COALESCE(t.is_mystery_bounty, false) AS is_mystery_bounty,
         COALESCE(t.mystery_bounty_stage, 'pending') AS mystery_bounty_stage,
         COALESCE(t.bubble_protection, false) AS bubble_protection,
         round(COALESCE(t.buy_in_amount, 0), 2) AS buy_in_amount
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  SELECT * INTO v_batch
    FROM public.tournament_final_table_deal_batches b
   WHERE b.tournament_id = p_tournament_id
   FOR UPDATE;

  IF v_t.status = 'COMPLETED' THEN
    v_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
    IF COALESCE((v_check->>'ok')::boolean, false) THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'user_id', x.user_id, 'amount', x.cents / 100.0, 'rank', x.rank)
               ORDER BY x.rank), '[]'::jsonb)
        INTO v_payouts
        FROM jsonb_to_recordset(v_batch.plan)
          AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
       WHERE x.kind = 'final_table_deal';
      RETURN jsonb_build_object(
        'ok', true, 'paid', 0, 'place_paid', 0, 'deal_paid', 0, 'bubble_paid', 0,
        'completed', true, 'already_completed', true,
        'players', v_batch.live_count, 'chip_leader', v_batch.chip_leader,
        'deal_table_id', v_batch.deal_table_id,
        'bubble_contract_required', v_batch.bubble_contract_required,
        'bubble_obligation_id', v_batch.bubble_obligation_id,
        'payouts', v_payouts, 'retryable', false);
    END IF;
    RETURN v_check || jsonb_build_object('paid', 0, 'completed', false,
                                         'retryable', false);
  END IF;

  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_running',
                              'status', v_t.status, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;
  IF NOT v_t.final_table_deal_enabled THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_not_enabled',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'satellite_has_its_own_settlement',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF NOT v_t.prize_pool_finalized
     OR v_t.prize_pool + 0.005 < v_t.guaranteed_prize THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'prize_pool_is_not_funded_and_finalized',
                              'prize_pool', v_t.prize_pool,
                              'guaranteed_prize', v_t.guaranteed_prize,
                              'prize_pool_finalized', v_t.prize_pool_finalized,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF v_batch.tournament_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id = p_tournament_id
                   AND p.source = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'legacy_or_incomplete_deal_has_no_atomic_replay',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  /* Parent-to-child locks make the physical-table predicate stable through
     COMMIT. A new tournament table needs a foreign-key key-share lock on the
     tournament row; a new seat needs one on its table row. Both parents are
     already FOR UPDATE, while every existing live seat is locked directly. */
  PERFORM 1
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id
   FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NULL
   ORDER BY ts.id
   FOR UPDATE OF ts;
  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;
  PERFORM 1
    FROM public.tournament_deal_votes v
   WHERE v.tournament_id = p_tournament_id
   ORDER BY v.user_id
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE tp.status = 'playing' AND tp.eliminated_at IS NULL),
         count(*) FILTER (WHERE tp.status NOT IN ('playing', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'playing' AND tp.position IS NOT NULL),
         count(*) FILTER (WHERE tp.status = 'eliminated'),
         count(tp.position) FILTER (WHERE tp.status = 'eliminated'),
         count(DISTINCT tp.position) FILTER (WHERE tp.status = 'eliminated'),
         COALESCE(min(tp.position) FILTER (WHERE tp.status = 'eliminated'), 0),
         COALESCE(max(tp.position) FILTER (WHERE tp.status = 'eliminated'), 0),
         count(*) FILTER (
           WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL),
         COALESCE(sum(tp.chips) FILTER (
           WHERE tp.status = 'playing' AND tp.eliminated_at IS NULL), 0)
    INTO v_field_count, v_live_count, v_other_count, v_live_positioned,
         v_eliminated_count, v_eliminated_ranked, v_eliminated_distinct,
         v_eliminated_min, v_eliminated_max, v_eliminated_missing_time,
         v_total_chips
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  WITH prior AS (
    SELECT tp.id, tp.user_id, tp.position, tp.eliminated_at,
           v_field_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated'
  )
  SELECT count(*) FILTER (
           WHERE p.position IS DISTINCT FROM p.canonical_position),
         md5(COALESCE(jsonb_agg(jsonb_build_object(
           'id', p.id, 'user_id', p.user_id, 'position', p.position,
           'eliminated_at_utc', to_char(
             p.eliminated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'))
           ORDER BY p.position, p.id), '[]'::jsonb)::text)
    INTO v_eliminated_canonical_mismatches,
         v_prior_standings_fingerprint
    FROM prior p;

  IF v_live_count < 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_enough_players',
                              'players', v_live_count, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;
  IF v_live_count > v_t.table_size THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_at_final_table',
                              'players', v_live_count, 'table_size', v_t.table_size,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF v_other_count > 0 OR v_live_positioned > 0
     OR v_live_count + v_eliminated_count <> v_field_count
     OR v_eliminated_ranked <> v_eliminated_count
     OR v_eliminated_distinct <> v_eliminated_count
     OR (v_eliminated_count > 0
         AND (v_eliminated_min <> v_live_count + 1
              OR v_eliminated_max <> v_field_count
              OR v_eliminated_max - v_eliminated_min + 1
                 <> v_eliminated_count)) THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'standings_before_deal_are_not_contiguous',
                              'field', v_field_count, 'live', v_live_count,
                              'other_statuses', v_other_count,
                              'live_with_position', v_live_positioned,
                              'classified_players',
                                v_live_count + v_eliminated_count,
                              'eliminated', v_eliminated_count,
                              'eliminated_ranked', v_eliminated_ranked,
                              'eliminated_distinct', v_eliminated_distinct,
                              'eliminated_range', jsonb_build_array(v_eliminated_min,
                                                                    v_eliminated_max),
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF v_eliminated_missing_time > 0
     OR v_eliminated_canonical_mismatches > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'prior_eliminated_standings_are_not_canonical',
      'eliminated_without_time', v_eliminated_missing_time,
      'canonical_mismatches', v_eliminated_canonical_mismatches,
      'rule', 'earliest eliminated_at then id receives the largest position',
      'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF v_total_chips <= 0 OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'playing' AND tp.eliminated_at IS NULL
       AND COALESCE(tp.chips, 0) <= 0
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'live_chip_totals_are_invalid',
                              'total_chips', v_total_chips, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  /* "Final table" means one physical occupied table and an exact seat set,
     not merely a live headcount below table_size. Include live-seat residue
     on paused/closed tables in the all-seat count so stale merge residue also
     fails closed. Null-user seats, duplicate seats, eliminated seats, missing
     live players and split tables each make at least one equality fail. */
  SELECT count(DISTINCT tb.id) FILTER (
           WHERE tb.status::text IN ('running', 'waiting') AND ts.id IS NOT NULL),
         count(ts.id),
         count(ts.id) FILTER (
           WHERE tb.status::text IN ('running', 'waiting')),
         count(DISTINCT ts.user_id),
         count(DISTINCT ts.user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players live
              WHERE live.tournament_id = p_tournament_id
                AND live.user_id = ts.user_id
                AND live.status = 'playing'
                AND live.eliminated_at IS NULL
           ))
    INTO v_seated_active_tables, v_all_live_seats, v_active_live_seats,
         v_distinct_seat_users, v_matching_live_users
    FROM public.tables tb
    LEFT JOIN public.table_seats ts
      ON ts.table_id = tb.id AND ts.left_at IS NULL
   WHERE tb.tournament_id = p_tournament_id;

  SELECT tb.id INTO v_deal_table_id
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND tb.status::text IN ('running', 'waiting')
     AND EXISTS (
       SELECT 1 FROM public.table_seats ts
        WHERE ts.table_id = tb.id AND ts.left_at IS NULL
     )
   ORDER BY tb.id
   LIMIT 1;

  IF v_seated_active_tables <> 1 OR v_deal_table_id IS NULL
     OR v_all_live_seats <> v_live_count
     OR v_active_live_seats <> v_live_count
     OR v_distinct_seat_users <> v_live_count
     OR v_matching_live_users <> v_live_count THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'physical_final_table_seat_set_is_not_exact',
      'players', v_live_count, 'deal_table_id', v_deal_table_id,
      'seated_active_tables', v_seated_active_tables,
      'all_live_seats', v_all_live_seats,
      'active_live_seats', v_active_live_seats,
      'distinct_seat_users', v_distinct_seat_users,
      'matching_live_users', v_matching_live_users,
      'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  SELECT count(*) FILTER (WHERE tp.registered_at IS NULL),
         count(*) FILTER (WHERE ts.stack IS DISTINCT FROM tp.chips),
         COALESCE(jsonb_agg(jsonb_build_object(
           'player_id', tp.id,
           'user_id', tp.user_id,
           'chips', tp.chips,
           'registered_at_utc', to_char(
             tp.registered_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'),
           'rebuys', COALESCE(tp.rebuys, 0),
           'add_on', COALESCE(tp.add_on, false),
           'seat_id', ts.id,
           'table_id', tb.id,
           'seat_stack', ts.stack)
           ORDER BY tp.chips DESC, tp.registered_at ASC, tp.user_id ASC),
           '[]'::jsonb)
    INTO v_live_missing_registration, v_seat_stack_mismatches,
         v_live_input_snapshot
    FROM public.tournament_players tp
    JOIN public.table_seats ts
      ON ts.user_id = tp.user_id AND ts.left_at IS NULL
    JOIN public.tables tb
      ON tb.id = ts.table_id AND tb.id = v_deal_table_id
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'playing' AND tp.eliminated_at IS NULL;

  IF jsonb_array_length(v_live_input_snapshot) <> v_live_count
     OR v_live_missing_registration > 0
     OR v_seat_stack_mismatches > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'live_deal_inputs_do_not_match_seat_stacks',
      'players', v_live_count,
      'snapshot_rows', jsonb_array_length(v_live_input_snapshot),
      'missing_registered_at', v_live_missing_registration,
      'seat_stack_mismatches', v_seat_stack_mismatches,
      'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  v_live_input_fingerprint := md5(v_live_input_snapshot::text);

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'playing' AND tp.eliminated_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_deal_votes v
          WHERE v.tournament_id = p_tournament_id AND v.user_id = tp.user_id
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_vote_is_not_unanimous',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  v_pool_cents := round(v_t.prize_pool * 100)::bigint;
  IF v_pool_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_prize_pool_to_deal',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  BEGIN
    IF lower(COALESCE(v_t.variant, '')) = 'spin'
       OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN' THEN
      IF v_t.spin_multiplier IS NULL OR v_t.spin_multiplier <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'spin_multiplier_is_not_persisted',
                                  'paid', 0, 'completed', false, 'retryable', false);
      END IF;
      SELECT l.structure INTO v_struct
        FROM public.spin_payout_ladder l
       WHERE l.multiplier = v_t.spin_multiplier;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false,
                                  'reason', 'spin_multiplier_has_no_canonical_ladder',
                                  'spin_multiplier', v_t.spin_multiplier,
                                  'paid', 0, 'completed', false, 'retryable', false);
      END IF;
    ELSE
      v_struct := public.fn_safe_jsonb_array(v_t.payout_structure);
    END IF;

    IF jsonb_array_length(v_struct) = 0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_struct) e
       WHERE jsonb_typeof(e) <> 'object'
          OR COALESCE(e->>'place', '') !~ '^[1-9][0-9]*$'
          OR COALESCE(e->>'percentage', '') !~ '^[0-9]+([.][0-9]+)?$'
          OR (e->>'percentage')::numeric < 0
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'payout_structure_is_invalid',
                                'paid', 0, 'completed', false, 'retryable', false);
    END IF;

    SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(v_struct) e
     WHERE (e->>'place')::integer <= v_field_count;

    SELECT count(*), count(DISTINCT (e->>'place')::integer),
           COALESCE(min((e->>'place')::integer), 0),
           COALESCE(max((e->>'place')::integer), 0),
           COALESCE(sum(round((e->>'percentage')::numeric * 100)::bigint), 0)
      INTO v_structure_places, v_structure_distinct,
           v_structure_min, v_structure_max, v_total_bp
      FROM jsonb_array_elements(v_trimmed) e;

    IF v_structure_places = 0 OR v_structure_distinct <> v_structure_places
       OR v_structure_min <> 1 OR v_structure_max <> v_structure_places
       OR v_total_bp <= 0 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'payout_places_are_not_contiguous',
                                'places', v_structure_places,
                                'last_place', v_structure_max,
                                'paid', 0, 'completed', false, 'retryable', false);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payout_structure_is_invalid',
                              'detail', SQLERRM, 'paid', 0,
                              'completed', false, 'retryable', false);
  END;

  v_remaining_cents := v_pool_cents;
  FOR r IN
    SELECT (e->>'place')::integer AS place,
           round((e->>'percentage')::numeric * 100)::bigint AS bp
      FROM jsonb_array_elements(v_trimmed) e
     ORDER BY (e->>'place')::integer
  LOOP
    IF r.place = v_structure_max THEN
      v_expected_cents := GREATEST(v_remaining_cents, 0);
    ELSE
      v_expected_cents := GREATEST(
        LEAST(v_remaining_cents,
              round(v_pool_cents * r.bp::numeric / v_total_bp)::bigint), 0);
    END IF;
    v_remaining_cents := v_remaining_cents - v_expected_cents;

    IF r.place > v_live_count THEN
      SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
        INTO v_holders, v_holder
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;
      IF v_holders <> 1 OR v_holder IS NULL THEN
        RETURN jsonb_build_object('ok', false,
                                  'reason', 'earned_place_has_no_unique_holder',
                                  'place', r.place, 'holders', v_holders,
                                  'paid', 0, 'completed', false, 'retryable', false);
      END IF;
      v_place_plan := v_place_plan || jsonb_build_array(jsonb_build_object(
        'kind', 'place', 'place', r.place, 'user_id', v_holder,
        'cents', v_expected_cents, 'rank', NULL));
      v_place_total_cents := v_place_total_cents + v_expected_cents;
    END IF;
  END LOOP;

  IF v_remaining_cents <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'structure_does_not_allocate_pool',
                              'unallocated_cents', v_remaining_cents,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  /* A positive result cache is an entitlement signal, never evidence that it
     was paid. A stale lower cache is safely promoted to the finalized
     structure below; a cache above or outside that structure would require a
     pricing decision or clawback, so the deal must leave it untouched and
     refuse for review. Live players cannot already hold a place prize. */
  SELECT count(*) INTO v_conflicts
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND round(COALESCE(tp.prize, 0) * 100)::bigint > 0
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_place_plan)
           AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
        WHERE x.place = tp.position AND x.user_id = tp.user_id
          AND round(COALESCE(tp.prize, 0) * 100)::bigint <= x.cents
     );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'recorded_positive_prize_conflicts_with_deal_plan',
                              'rows', v_conflicts, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  SELECT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND o.kind = 'bubble_protection'
         ), EXISTS (
           SELECT 1 FROM public.tournament_payouts p
            WHERE p.tournament_id = p_tournament_id
              AND p.source = 'bubble_protection'
         )
    INTO v_bubble_obligation_present, v_bubble_payout_present;
  v_bubble_shape_valid := v_t.buy_in_amount > 0
    AND v_structure_places > 0 AND v_field_count > v_structure_places;
  v_bubble_required := (v_t.bubble_protection AND v_bubble_shape_valid)
    OR v_bubble_obligation_present OR v_bubble_payout_present;

  IF v_bubble_required AND NOT v_bubble_shape_valid THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'bubble_protection_contract_shape_is_invalid',
      'buy_in_amount', v_t.buy_in_amount,
      'structure_places', v_structure_places, 'field_count', v_field_count,
      'bubble_obligation_present', v_bubble_obligation_present,
      'bubble_payout_present', v_bubble_payout_present,
      'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  IF v_bubble_required THEN
    /* A deal may be accepted before the natural bubble. In that case the final
       stone-bubble rank belongs to a still-live player and no persisted
       position exists yet. Derive that holder from the exact locked snapshot
       using the same ordering that builds and stamps the deal plan below. If
       the natural bubble already occurred, its durable eliminated position is
       the source of truth. */
    IF v_structure_places + 1 <= v_live_count THEN
      SELECT count(*), (array_agg(ranked.user_id ORDER BY ranked.rank))[1]
        INTO v_bubble_holders, v_bubble_user
        FROM (
          SELECT s.user_id,
                 row_number() OVER (
                   ORDER BY s.chips DESC, s.registered_at_utc ASC, s.user_id ASC
                 )::integer AS rank
            FROM jsonb_to_recordset(v_live_input_snapshot)
              AS s(player_id uuid, user_id uuid, chips numeric,
                   registered_at_utc text, rebuys integer, add_on boolean,
                   seat_id uuid, table_id uuid, seat_stack numeric)
        ) ranked
       WHERE ranked.rank = v_structure_places + 1;
    ELSE
      SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
        INTO v_bubble_holders, v_bubble_user
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.position = v_structure_places + 1;
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE o.user_id = v_bubble_user AND o.place IS NULL),
           COALESCE(max(o.amount_owed) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0),
           COALESCE(max(o.amount_paid) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0)
      INTO v_bubble_obligations, v_bubble_matching, v_bubble_owed, v_bubble_paid
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'bubble_protection';

    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_bubble_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user AND p.position IS NULL
       AND p.source = 'bubble_protection';

    SELECT count(*) INTO v_bubble_conflicts
      FROM (
        SELECT p.position, p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p.source = 'bubble_protection'
           AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user)
         GROUP BY p.position, p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) unexpected_bubble;

    IF v_bubble_obligations = 0 AND NOT v_bubble_payout_present THEN
      v_bubble_obligation_id := gen_random_uuid();
      v_bubble_source := 'engine.atomicFinalTableDeal';
      v_bubble_owed := v_t.buy_in_amount;
      v_bubble_paid := 0;
      v_bubble_settled_at := NULL;
      v_bubble_needs_insert := true;
    ELSIF v_bubble_obligations = 1 AND v_bubble_matching = 1 THEN
      SELECT o.id, o.source, o.amount_owed, o.amount_paid, o.settled_at
        INTO v_bubble_obligation_id, v_bubble_source, v_bubble_owed,
             v_bubble_paid, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user
       FOR UPDATE;
    END IF;

    IF v_bubble_holders <> 1 OR v_bubble_user IS NULL
       OR (NOT v_bubble_needs_insert
           AND (v_bubble_obligations <> 1 OR v_bubble_matching <> 1))
       OR (v_bubble_needs_insert
           AND (v_bubble_obligations <> 0 OR v_bubble_payout_present))
       OR v_bubble_obligation_id IS NULL
       OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicFinalTableDeal')
       OR abs(v_bubble_owed - v_t.buy_in_amount) > 0.005
       OR v_bubble_paid < -0.005 OR v_bubble_paid > v_bubble_owed + 0.005
       OR abs(v_bubble_paid - v_bubble_evidence) > 0.005
       OR (v_bubble_paid + 0.005 >= v_bubble_owed
           AND v_bubble_settled_at IS NULL)
       OR (v_bubble_paid + 0.005 < v_bubble_owed
           AND v_bubble_settled_at IS NOT NULL)
       OR v_bubble_conflicts > 0 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_obligation_is_not_exact',
                                'bubble_place', v_structure_places + 1,
                                'user_id', v_bubble_user,
                                'expected', v_t.buy_in_amount,
                                'amount_owed', v_bubble_owed,
                                'amount_paid', v_bubble_paid,
                                'payout_evidence', v_bubble_evidence,
                                'conflicts', v_bubble_conflicts,
                                'paid', 0, 'completed', false, 'retryable', false);
    END IF;
    v_bubble_unpaid_cents := round(
      GREATEST(v_bubble_owed - v_bubble_paid, 0) * 100)::bigint;
  END IF;

  FOR r IN
    SELECT (p->>'place')::integer AS place,
           (p->>'user_id')::uuid AS user_id,
           (p->>'cents')::bigint AS cents
      FROM jsonb_array_elements(v_place_plan) p
     ORDER BY (p->>'place')::integer
  LOOP
    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_seeded_paid
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.position = r.place AND p.user_id = r.user_id
       AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                         'late_reg_adjustment', 'clawback', 'spin_backpay',
                         'overlay_backpay')
            OR EXISTS (
              SELECT 1 FROM public.tournament_obligations eo
               WHERE eo.tournament_id = p_tournament_id
                 AND eo.kind = 'place' AND eo.place = r.place
                 AND eo.user_id = r.user_id
                 AND p.idempotency_key LIKE
                   'tourney:' || p_tournament_id::text || ':obl:' ||
                   eo.id::text || ':%'
            ));

    SELECT count(*) INTO v_wrong_recipients
      FROM (
        SELECT p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id AND p.position = r.place
           AND p.user_id IS DISTINCT FROM r.user_id
           AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                             'late_reg_adjustment', 'clawback', 'spin_backpay',
                             'overlay_backpay')
                OR EXISTS (
                  SELECT 1 FROM public.tournament_obligations eo
                   WHERE eo.tournament_id = p_tournament_id
                     AND eo.kind = 'place' AND eo.place = p.position
                     AND eo.user_id = p.user_id
                     AND p.idempotency_key LIKE
                       'tourney:' || p_tournament_id::text || ':obl:' ||
                       eo.id::text || ':%'
                ))
         GROUP BY p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) wrong;

    SELECT * INTO v_existing
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = r.place
     FOR UPDATE;

    IF v_wrong_recipients > 0 OR v_seeded_paid < -0.005
       OR v_seeded_paid > r.cents / 100.0 + 0.005
       OR (FOUND AND abs(round(v_existing.amount_paid, 2) - v_seeded_paid) > 0.005)
       OR (FOUND AND v_existing.amount_owed > r.cents / 100.0 + 0.005)
       OR (FOUND AND v_existing.amount_paid > 0
                    AND v_existing.user_id IS DISTINCT FROM r.user_id) THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'earned_place_evidence_conflicts_with_plan',
                                'place', r.place, 'user_id', r.user_id,
                                'expected', r.cents / 100.0,
                                'payout_evidence', v_seeded_paid,
                                'wrong_recipients', v_wrong_recipients,
                                'paid', 0, 'completed', false, 'retryable', false);
    END IF;
    v_prior_place_paid_cents := v_prior_place_paid_cents
      + round(v_seeded_paid * 100)::bigint;
  END LOOP;

  SELECT count(*) INTO v_conflicts
    FROM (
      SELECT p.position, p.user_id
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.position IS NOT NULL
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR EXISTS (
                SELECT 1 FROM public.tournament_obligations eo
                 WHERE eo.tournament_id = p_tournament_id
                   AND eo.kind = 'place' AND eo.place = p.position
                   AND eo.user_id = p.user_id
                   AND p.idempotency_key LIKE
                     'tourney:' || p_tournament_id::text || ':obl:' ||
                     eo.id::text || ':%'
              ))
       GROUP BY p.position, p.user_id
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) evidence
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_to_recordset(v_place_plan)
       AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
      WHERE x.place = evidence.position AND x.user_id = evidence.user_id
   );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'paid_place_evidence_is_outside_deal_plan',
                              'rows', v_conflicts, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  SELECT count(*) INTO v_conflicts
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_to_recordset(v_place_plan)
         AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
        WHERE x.place = o.place AND x.user_id = o.user_id
     );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'place_obligation_is_outside_deal_plan',
                              'rows', v_conflicts, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  v_available_cents := v_pool_cents - v_place_total_cents;
  IF v_available_cents < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'earned_places_exceed_prize_pool',
                              'earned_place_cents', v_place_total_cents,
                              'pool_cents', v_pool_cents, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  SELECT sum(s.chips) INTO v_total_chips
    FROM jsonb_to_recordset(v_live_input_snapshot)
      AS s(player_id uuid, user_id uuid, chips numeric,
           registered_at_utc text, rebuys integer, add_on boolean,
           seat_id uuid, table_id uuid, seat_stack numeric);

  SELECT s.user_id INTO v_leader
    FROM jsonb_to_recordset(v_live_input_snapshot)
      AS s(player_id uuid, user_id uuid, chips numeric,
           registered_at_utc text, rebuys integer, add_on boolean,
           seat_id uuid, table_id uuid, seat_stack numeric)
   ORDER BY s.chips DESC, s.registered_at_utc ASC, s.user_id ASC
   LIMIT 1;

  FOR r IN
    SELECT s.user_id, s.chips
      FROM jsonb_to_recordset(v_live_input_snapshot)
        AS s(player_id uuid, user_id uuid, chips numeric,
             registered_at_utc text, rebuys integer, add_on boolean,
             seat_id uuid, table_id uuid, seat_stack numeric)
     ORDER BY s.chips DESC, s.registered_at_utc ASC, s.user_id ASC
  LOOP
    v_rank := v_rank + 1;
    v_share_cents := floor(r.chips / v_total_chips * v_available_cents)::bigint;
    v_floor_paid_cents := v_floor_paid_cents + v_share_cents;
    v_deal_shares := v_deal_shares || jsonb_build_array(jsonb_build_object(
      'user_id', r.user_id, 'cents', v_share_cents, 'rank', v_rank));
  END LOOP;
  v_remainder_cents := v_available_cents - v_floor_paid_cents;

  FOR r IN
    SELECT (p->>'user_id')::uuid AS user_id,
           (p->>'cents')::bigint AS cents,
           (p->>'rank')::integer AS rank
      FROM jsonb_array_elements(v_deal_shares) p
     ORDER BY (p->>'rank')::integer
  LOOP
    v_share_cents := r.cents
      + CASE WHEN r.user_id = v_leader THEN v_remainder_cents ELSE 0 END;
    v_deal_plan := v_deal_plan || jsonb_build_array(jsonb_build_object(
      'kind', 'final_table_deal', 'place', NULL, 'user_id', r.user_id,
      'cents', v_share_cents, 'rank', r.rank));
    v_deal_total_cents := v_deal_total_cents + v_share_cents;
    v_payouts := v_payouts || jsonb_build_array(jsonb_build_object(
      'user_id', r.user_id, 'amount', v_share_cents / 100.0, 'rank', r.rank));
  END LOOP;

  IF v_place_total_cents + v_deal_total_cents <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_plan_does_not_allocate_pool',
                              'places', v_place_total_cents / 100.0,
                              'deal', v_deal_total_cents / 100.0,
                              'pool', v_pool_cents / 100.0, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  /* A finalized number is not money. Lock the enforced escrow row and prove
     it holds every cent this transaction still needs to move. A manually
     inflated prize_pool/prize_pool_finalized pair therefore cannot authorize
     a deal. Prior place payments backed by exact payout evidence are the only
  subtraction from the required cash. */
  v_unpaid_cents := v_pool_cents - v_prior_place_paid_cents;
  v_total_unpaid_cents := v_unpaid_cents + v_bubble_unpaid_cents;
  SELECT * INTO v_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR NOT v_escrow.enforced THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'enforced_escrow_is_required',
                              'required', v_total_unpaid_cents / 100.0,
                              'place_and_deal_required', v_unpaid_cents / 100.0,
                              'bubble_required', v_bubble_unpaid_cents / 100.0,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF round(v_escrow.prize_balance * 100)::bigint < v_total_unpaid_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'escrow_cannot_fund_atomic_deal',
                              'required', v_total_unpaid_cents / 100.0,
                              'place_and_deal_required', v_unpaid_cents / 100.0,
                              'bubble_required', v_bubble_unpaid_cents / 100.0,
                              'escrow_prize_balance', v_escrow.prize_balance,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  v_plan := v_place_plan || v_deal_plan;
  v_plan_fingerprint := md5(jsonb_build_object(
    'bubble_contract_required', v_bubble_required,
    'bubble_obligation_id', v_bubble_obligation_id,
    'bubble_user_id', v_bubble_user,
    'bubble_source', v_bubble_source,
    'bubble_amount_owed', round(COALESCE(v_bubble_owed, 0) * 100)::bigint,
    'bubble_amount_paid_before', round(COALESCE(v_bubble_paid, 0) * 100)::bigint,
    'deal_table_id', v_deal_table_id,
    'live_input_fingerprint', v_live_input_fingerprint,
    'prior_standings_fingerprint', v_prior_standings_fingerprint,
    'plan', v_plan)::text);

  BEGIN
    /* The format-owned transaction claims its terminal work before moving
       any money. This is intentionally inside the exception subtransaction:
       any failed prize, bounty or rake leg restores RUNNING together with
       every balance. It also gives the rake contract the terminal-in-progress
       status it requires without an application-side status writer. */
    PERFORM set_config('app.atomic_final_table_deal_batch', p_tournament_id::text, true);
    UPDATE public.tournaments
       SET status = 'COMPLETING', updated_at = now()
     WHERE id = p_tournament_id AND status = 'RUNNING';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'RUNNING claim was lost before deal settlement',
                            ERRCODE = '40001';
    END IF;

    IF v_bubble_needs_insert THEN
      INSERT INTO public.tournament_obligations
        (id, tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (v_bubble_obligation_id, p_tournament_id, 'bubble_protection', NULL,
         v_bubble_user, v_bubble_owed, 0, v_bubble_source, NULL);
    END IF;

    FOR r IN
      SELECT (p->>'place')::integer AS place,
             (p->>'user_id')::uuid AS user_id,
             (p->>'cents')::bigint AS cents
        FROM jsonb_array_elements(v_place_plan) p
       ORDER BY (p->>'place')::integer
    LOOP
      SELECT round(COALESCE(sum(p.amount), 0), 2)
        INTO v_seeded_paid
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.position = r.place AND p.user_id = r.user_id
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR EXISTS (
                SELECT 1 FROM public.tournament_obligations eo
                 WHERE eo.tournament_id = p_tournament_id
                   AND eo.kind = 'place' AND eo.place = r.place
                   AND eo.user_id = r.user_id
                   AND p.idempotency_key LIKE
                     'tourney:' || p_tournament_id::text || ':obl:' ||
                     eo.id::text || ':%'
              ));

      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'place', r.place, r.user_id, r.cents / 100.0,
         v_seeded_paid, 'engine.atomicFinalTableDeal',
         CASE WHEN v_seeded_paid + 0.005 >= r.cents / 100.0 THEN now() ELSE NULL END)
      ON CONFLICT (tournament_id, kind, place) WHERE place IS NOT NULL
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        amount_owed = EXCLUDED.amount_owed,
        amount_paid = EXCLUDED.amount_paid,
        source = EXCLUDED.source,
        updated_at = now(),
        settled_at = EXCLUDED.settled_at;
    END LOOP;

    FOR r IN
      SELECT (p->>'user_id')::uuid AS user_id,
             (p->>'cents')::bigint AS cents,
             (p->>'rank')::integer AS rank
        FROM jsonb_array_elements(v_deal_plan) p
       ORDER BY (p->>'rank')::integer
    LOOP
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'final_table_deal', NULL, r.user_id,
         r.cents / 100.0, 0, 'engine.atomicFinalTableDeal',
         CASE WHEN r.cents = 0 THEN now() ELSE NULL END);
    END LOOP;

    UPDATE public.tournament_players tp
       SET prize = COALESCE((
             SELECT sum(x.cents) / 100.0
               FROM jsonb_to_recordset(v_plan)
                 AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
              WHERE x.user_id = tp.user_id
           ), 0)
     WHERE tp.tournament_id = p_tournament_id;

    FOR r IN
      SELECT (p->>'user_id')::uuid AS user_id,
             (p->>'rank')::integer AS rank
        FROM jsonb_array_elements(v_deal_plan) p
       ORDER BY (p->>'rank')::integer
    LOOP
      UPDATE public.tournament_players
         SET position = r.rank,
             status = CASE WHEN r.rank = 1 THEN 'winner' ELSE 'eliminated' END,
             eliminated_at = CASE
               WHEN r.rank = 1 THEN NULL
               ELSE COALESCE(eliminated_at, clock_timestamp())
             END
       WHERE tournament_id = p_tournament_id AND user_id = r.user_id
         AND status = 'playing' AND eliminated_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'live deal player %s changed before standings were stamped', r.user_id),
          ERRCODE = '40001';
      END IF;
    END LOOP;

    /* Stamping precedes the immutable batch inside this same subtransaction.
       The result-freeze trigger recognizes the batch immediately after this
       insert, without blocking the settler's own legitimate stamps above. */
    INSERT INTO public.tournament_final_table_deal_batches
      (tournament_id, plan_fingerprint, plan, prior_standings_fingerprint,
       live_input_snapshot, live_input_fingerprint,
       field_count, live_count, structure_place_count, place_line_count,
       deal_line_count, place_amount, deal_amount, amount_owed, amount_moved,
       escrow_prize_before, escrow_prize_after, deal_table_id,
       bubble_contract_required, bubble_obligation_id, bubble_user_id,
       bubble_source, bubble_amount_owed, bubble_amount_paid_before,
       chip_leader, source)
    VALUES
      (p_tournament_id, v_plan_fingerprint, v_plan,
       v_prior_standings_fingerprint, v_live_input_snapshot,
       v_live_input_fingerprint, v_field_count, v_live_count,
       v_structure_places, jsonb_array_length(v_place_plan),
       jsonb_array_length(v_deal_plan), v_place_total_cents / 100.0,
       v_deal_total_cents / 100.0, v_pool_cents / 100.0,
       v_total_unpaid_cents / 100.0, v_escrow.prize_balance, NULL, v_deal_table_id,
       v_bubble_required, v_bubble_obligation_id, v_bubble_user,
       v_bubble_source, v_bubble_owed, v_bubble_paid,
       v_leader, 'engine.atomicFinalTableDeal');

    IF v_bubble_required AND v_bubble_unpaid_cents > 0 THEN
      v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate(
        p_tournament_id, 'bubble_protection', NULL, v_bubble_user,
        v_bubble_owed, v_bubble_source,
        'Bubble protection: buy-in returned to the stone bubble', NULL);
      IF NOT COALESCE((v_result->>'ok')::boolean, false)
         OR NULLIF(v_result->>'obligation_id', '')::uuid
            IS DISTINCT FROM v_bubble_obligation_id THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal Bubble leg refused: %s',
          COALESCE(v_result->>'refused_reason', 'wrong obligation')),
          ERRCODE = '23514';
      END IF;

      SELECT o.amount_paid, o.source, o.amount_owed, o.settled_at
        INTO v_after_bubble_paid, v_bubble_source, v_bubble_owed,
             v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.id = v_bubble_obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user;
      IF NOT FOUND
         OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicFinalTableDeal')
         OR v_after_bubble_paid + 0.005 < v_bubble_owed
         OR v_bubble_settled_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal Bubble leg only reached %s of %s',
          COALESCE(v_after_bubble_paid, 0), v_bubble_owed),
          ERRCODE = '23514';
      END IF;
      v_bubble_paid_this_call := round(
        COALESCE((v_result->>'paid')::numeric, 0), 2);
      v_paid_this_call := v_paid_this_call + v_bubble_paid_this_call;
    END IF;

    FOR r IN
      SELECT x.kind, x.place, x.user_id, x.cents, x.rank
        FROM jsonb_to_recordset(v_plan)
          AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
       ORDER BY CASE WHEN x.kind = 'place' THEN 0 ELSE 1 END,
                x.place NULLS LAST, x.rank NULLS LAST
    LOOP
      v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate(
        p_tournament_id, r.kind, r.place, r.user_id, r.cents / 100.0,
        'engine.atomicFinalTableDeal',
        CASE WHEN r.kind = 'place'
             THEN format('Tournament prize: position %s', r.place)
             ELSE 'Final table deal (chip-proportional chop)' END);
      IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal leg refused for %s/%s/%s: %s',
          r.kind, COALESCE(r.place::text, '-'), r.user_id,
          COALESCE(v_result->>'refused_reason', 'unknown')),
          ERRCODE = '23514';
      END IF;

      SELECT o.amount_paid INTO v_after_paid
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id AND o.kind = r.kind
         AND o.user_id = r.user_id
         AND ((r.kind = 'place' AND o.place = r.place)
              OR (r.kind = 'final_table_deal' AND o.place IS NULL));
      IF NOT FOUND OR abs(round(v_after_paid, 2) - r.cents / 100.0) > 0.005 THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal leg partially settled for %s/%s/%s: expected %s, stored %s',
          r.kind, COALESCE(r.place::text, '-'), r.user_id,
          r.cents / 100.0, COALESCE(v_after_paid, 0)),
          ERRCODE = '23514';
      END IF;

      v_paid_this_call := v_paid_this_call
        + round(COALESCE((v_result->>'paid')::numeric, 0), 2);
      IF r.kind = 'place' THEN
        v_place_paid_this_call := v_place_paid_this_call
          + round(COALESCE((v_result->>'paid')::numeric, 0), 2);
      ELSE
        v_deal_paid_this_call := v_deal_paid_this_call
          + round(COALESCE((v_result->>'paid')::numeric, 0), 2);
      END IF;
    END LOOP;

    IF v_bubble_required THEN
      SELECT o.amount_paid, o.source, o.amount_owed, o.settled_at
        INTO v_after_bubble_paid, v_bubble_source, v_bubble_owed,
             v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.id = v_bubble_obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user;
      v_bubble_row_found := FOUND;
      SELECT round(COALESCE(sum(p.amount), 0), 2)
        INTO v_bubble_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.user_id = v_bubble_user
         AND p.position IS NULL AND p.source = 'bubble_protection';
      IF NOT v_bubble_row_found
         OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicFinalTableDeal')
         OR v_after_bubble_paid + 0.005 < v_bubble_owed
         OR v_bubble_settled_at IS NULL
         OR abs(v_after_bubble_paid - v_bubble_evidence) > 0.005 THEN
        RAISE EXCEPTION USING MESSAGE =
          'Bubble Protection is not fully settled with exact payout evidence',
          ERRCODE = '23514';
      END IF;
    END IF;

    IF abs(v_paid_this_call - v_total_unpaid_cents / 100.0) > 0.005 THEN
      RAISE EXCEPTION USING MESSAGE = format(
        'atomic final-table-deal payment total was incomplete: expected %s, moved %s',
        v_total_unpaid_cents / 100.0, v_paid_this_call),
        ERRCODE = '23514';
    END IF;

    SELECT round(e.prize_balance, 2) INTO v_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND
       OR abs(v_escrow.prize_balance - v_paid_this_call - v_escrow_after) > 0.005 THEN
      RAISE EXCEPTION USING MESSAGE = format(
        'escrow did not debit with the atomic deal: before %s, moved %s, after %s',
        v_escrow.prize_balance, v_paid_this_call, COALESCE(v_escrow_after, 0)),
        ERRCODE = '23514';
    END IF;

    UPDATE public.tournament_final_table_deal_batches
       SET settled_at = COALESCE(settled_at, now()),
           escrow_prize_after = v_escrow_after
     WHERE tournament_id = p_tournament_id
       AND plan_fingerprint = v_plan_fingerprint;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'the final-table-deal batch changed before completion',
                            ERRCODE = '40001';
    END IF;

    v_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
    IF NOT COALESCE((v_check->>'ok')::boolean, false) THEN
      RAISE EXCEPTION USING MESSAGE = format(
        'atomic final-table-deal verification refused completion: %s', v_check::text),
        ERRCODE = '23514';
    END IF;

    /* Completion certification requires every financial domain, so the deal
       transaction owns those terminal legs too. Calling the existing guarded
       functions here keeps their immutable receipts and rolls their wallet
       effects back if any later readiness proof fails. */
    IF v_t.is_bounty OR v_t.is_pko OR v_t.is_mystery_bounty THEN
      IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
        RAISE EXCEPTION USING MESSAGE = 'pending bounty obligations block final-table deal completion',
                              ERRCODE = '23514';
      END IF;
      IF v_t.is_mystery_bounty AND v_t.mystery_bounty_stage <> 'pending' THEN
        v_result := public.fn_mystery_bounty_settle(p_tournament_id, v_leader);
        IF NOT COALESCE((v_result->>'ok')::boolean, false)
           OR NOT COALESCE((v_result->>'balanced')::boolean, false) THEN
          RAISE EXCEPTION USING MESSAGE = format(
            'atomic final-table-deal mystery bounty leg refused: %s', v_result::text),
                                ERRCODE = '23514';
        END IF;
      END IF;
      v_result := public.fn_finalize_bounty_pool(p_tournament_id, v_leader);
      IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal bounty pool leg refused: %s', v_result::text),
                              ERRCODE = '23514';
      END IF;
    END IF;

    v_result := public.fn_settle_tournament_rake(
      p_tournament_id, 'engine.atomicFinalTableDeal');
    IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
      RAISE EXCEPTION USING MESSAGE = format(
        'atomic final-table-deal rake leg refused: %s', v_result::text),
                            ERRCODE = '23514';
    END IF;

    UPDATE public.tournaments
       SET status = 'COMPLETED', ended_at = COALESCE(ended_at, clock_timestamp()),
           on_break = false, break_ends_at = NULL, updated_at = now()
     WHERE id = p_tournament_id AND status = 'COMPLETING';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'RUNNING claim was lost before deal completion',
                            ERRCODE = '40001';
    END IF;

    /* A committed deal includes its physical table shutdown. The status
       transition releases seats through the database triggers; any failure to
       close or prove the terminal table state aborts every deal payment too. */
    UPDATE public.tables
       SET status = 'closed', current_players = 0
     WHERE tournament_id = p_tournament_id
       AND (status IS DISTINCT FROM 'closed' OR current_players IS DISTINCT FROM 0);
    IF EXISTS (
         SELECT 1 FROM public.tables
          WHERE tournament_id = p_tournament_id
            AND (status IS DISTINCT FROM 'closed' OR current_players IS DISTINCT FROM 0)
       ) OR EXISTS (
         SELECT 1
           FROM public.table_seats s
           JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL
       ) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'completed final-table deal retained a nonterminal table or live seat',
        ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  PERFORM set_config('app.atomic_final_table_deal_batch', '', true);

  IF v_failure IS NOT NULL THEN
    BEGIN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_settle_final_table_deal_atomic',
        format('Atomic final-table deal aborted for %s: %s',
               COALESCE(v_t.name, p_tournament_id::text), v_failure),
        jsonb_build_object('tournament_id', p_tournament_id,
                           'sqlstate', v_failure_state,
                           'reason', v_failure,
                           'field_count', v_field_count,
                           'live_count', v_live_count,
                           'place_amount', v_place_total_cents / 100.0,
                           'deal_amount', v_deal_total_cents / 100.0),
        'atomic-final-table-deal:' || p_tournament_id::text
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'atomic_deal_aborted', 'detail', v_failure,
      'sqlstate', v_failure_state, 'paid', 0, 'completed', false,
      'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'paid', round(v_paid_this_call, 2),
    'place_paid', round(v_place_paid_this_call, 2),
    'deal_paid', round(v_deal_paid_this_call, 2),
    'bubble_paid', round(v_bubble_paid_this_call, 2),
    'completed', true, 'already_completed', false,
    'players', v_live_count, 'chip_leader', v_leader,
    'deal_table_id', v_deal_table_id,
    'bubble_contract_required', v_bubble_required,
    'bubble_obligation_id', v_bubble_obligation_id,
    'place_amount', v_place_total_cents / 100.0,
    'deal_amount', v_deal_total_cents / 100.0,
    'payouts', v_payouts, 'retryable', false,
    'record', 'tournament_final_table_deal_batches');
END;
$function$;


-- CREATE OR REPLACE preserves an existing ACL, but this migration is also the
-- source-controlled installation boundary. Restate the audited live grants so
-- a missing/recreated overload can never inherit PostgreSQL's PUBLIC EXECUTE
-- default. Exact ticket delivery remains owner-only; scheduler and rolling
-- runtime roots remain service-only until their stage-two retirement.
REVOKE ALL ON FUNCTION public.fn_sweep_pending_tournament_bounties(uuid,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_pending_tournament_bounties(uuid,integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean,integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_sweep_unsettled_tournament_rake(integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_unsettled_tournament_rake(integer,integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_deliver_satellite_ticket_exact(
  uuid,uuid,uuid,text,integer,numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(
  uuid,uuid,uuid,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(
  uuid,uuid,uuid,text,integer)
  TO service_role;

-- Phase 6.1 made the obligation payer reject every non-engine provenance that
-- was not explicitly named in ca_settle_sources. These three existing bounty
-- authorities call it under their own fixed function names. Without these
-- declarations a funded bounty finish returns adjustment_required and the
-- terminal transaction correctly rolls back forever. They are platform-owned
-- settlement sources, not operator adjustments.
INSERT INTO public.ca_settle_sources(source,note) VALUES
  ('final_table_deal',
   'Derived live chop share, paid only inside the atomic final-table-deal authority.'),
  ('fn_finalize_bounty_pool',
   'Platform bounty residual authority, invoked inside fn_complete_tournament_terminal.'),
  ('fn_mystery_bounty_settle',
   'Platform mystery residual authority, invoked inside fn_complete_tournament_terminal.'),
  ('fn_mystery_bounty_pay',
   'Platform revealed mystery chest authority, invoked by fn_mystery_bounty_settle.')
ON CONFLICT (source) DO UPDATE SET note=EXCLUDED.note;

-- The satellite authority introduced terminal_closed_at and stamps it in the
-- same transaction as its money receipt. Enforce the shared table shape before
-- installing the irreversible guard for every terminal tournament path.
ALTER TABLE public.tables
  ADD CONSTRAINT tables_terminal_closed_shape
  CHECK (terminal_closed_at IS NULL OR (
    lower(COALESCE(status::text,'')) = 'closed'
    AND lower(COALESCE(lifecycle,'')) = 'closed'
    AND current_players IS NOT DISTINCT FROM 0
  )) NOT VALID;
ALTER TABLE public.tables VALIDATE CONSTRAINT tables_terminal_closed_shape;

CREATE OR REPLACE FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_table_guard$
DECLARE
  v_new_status text;
  v_ended_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Tournament tables are durable event evidence. They close; they are never
    -- deleted. This unconditional rule needs no parent lock after PostgreSQL
    -- has already acquired the child row, so it cannot reverse terminal's
    -- tournament -> table order.
    IF OLD.tournament_id IS NOT NULL THEN
      RAISE EXCEPTION 'tournament table % is durable and cannot be deleted',OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.terminal_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'new table % cannot supply a terminal marker',NEW.id
        USING ERRCODE = '55000';
    END IF;
    IF NEW.tournament_id IS NOT NULL THEN
      -- INSERT has no child row to lock yet, so taking the parent first is
      -- deadlock-safe. If terminal owns it, this waits and then sees COMPLETED;
      -- if expansion owns it first, terminal waits and includes the new table.
      SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
        FROM public.tournaments t
       WHERE t.id = NEW.tournament_id
       FOR SHARE;
      IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'cannot add table % to terminal tournament %',
          NEW.id,NEW.tournament_id USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'table identity % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;

  -- Reassociation would be a child-row-first parent transition and would also
  -- change the immutable event table set. Tournament membership never moves.
  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     AND (NEW.tournament_id IS NOT NULL OR OLD.tournament_id IS NOT NULL) THEN
    RAISE EXCEPTION 'table % tournament association is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF OLD.terminal_closed_at IS NOT NULL THEN
    IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.terminal_closed_at IS DISTINCT FROM OLD.terminal_closed_at
       OR lower(COALESCE(NEW.status::text,'')) <> 'closed'
       OR lower(COALESCE(NEW.lifecycle,'')) <> 'closed'
       OR NEW.current_players IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'terminal tournament table % cannot reopen or move',OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')),t.ended_at
      INTO v_new_status,v_ended_at
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      IF NEW.current_players IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'table % cannot reopen terminal tournament %',
          NEW.id,NEW.tournament_id USING ERRCODE = '55000';
      END IF;
      -- The existing game-end hook first clears current_players while leaving
      -- status unchanged. Coerce that one-way zero-player write directly to
      -- the terminal shape; delayed waiting/running writes can never reopen it.
      NEW.status := 'closed';
      NEW.lifecycle := 'closed';
      NEW.terminal_closed_at := COALESCE(v_ended_at,transaction_timestamp());
    ELSIF NEW.terminal_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'live tournament table % cannot supply a terminal marker',NEW.id
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.terminal_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'unscoped table % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$terminal_table_guard$;

REVOKE ALL ON FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_table_terminal_close_is_irreversible
  BEFORE INSERT OR DELETE OR UPDATE OF id,tournament_id,status,current_players,
    lifecycle,terminal_closed_at ON public.tables
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_table_terminal_close_is_irreversible();

-- Hand stack settlement used to lock seats in caller-supplied JSON order.
-- Terminal close locks the whole table, so two different JSON orders could
-- meet it on different seat rows and cycle. This complete source-controlled
-- definition carries the 20260908042156 canonical-request authority and the
-- 20260908045608 zero-delta departed-seat refinement forward, then adds one
-- canonical bulk prelock, the tournament-player mirror and the zero-seat
-- release at the same durable hand boundary. No catalog-body rewrite or
-- best-effort textual patch participates in installation.
CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute(p_table_id uuid, p_hand_number bigint, p_stacks jsonb DEFAULT '[]'::jsonb, p_rake numeric DEFAULT NULL::numeric, p_bbj numeric DEFAULT NULL::numeric, p_ref text DEFAULT NULL::text, p_inflow numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_request jsonb;
  v_canonical jsonb;
  v_hand uuid; v_claimed integer; v_prior record; v_ca_id uuid;
  e jsonb; v_uid uuid; v_new numeric; v_old numeric; v_before numeric; v_target numeric;
  v_delta_sum numeric := 0; v_expected numeric;
  v_n integer := 0; v_updated integer; v_err text; v_result jsonb;
  v_delta_mode boolean;
  v_targets jsonb := '{}'::jsonb;      -- user_id -> stack to write
  v_rebased jsonb := '{}'::jsonb;      -- user_id -> db_before - engine_before (delta mode only)
  v_rebase_rows jsonb := '[]'::jsonb;  -- rows for ca_seat_stack_rebases
  v_rebase_count integer := 0;
  -- 2026-09-04 (verification sweep): a seat that LEFT during the hand
  v_departed jsonb := '[]'::jsonb;   -- [{user_id, delta, club_id}]
  v_dep record; v_dep_club uuid; v_dep_after numeric; v_dep_key text; v_dep_claimed integer;
  -- chip-std Lane F (2026-09-02): tournament conservation (absolute mode)
  v_tournament_id uuid;
  -- The hand result is also the durable final-stack boundary for a tournament.
  v_tournament_status text;
  v_payload_stack_count integer := 0;
  v_target_user_count integer := 0;
  v_tournament_player_count integer := 0;
  v_tournament_player_user_ids uuid[] := ARRAY[]::uuid[];
  v_tournament_player_chips jsonb := '[]'::jsonb;
  v_zero_stack_seat_count integer := 0;
  v_zero_stack_seat_ids uuid[] := ARRAY[]::uuid[];
  v_zero_stack_user_ids uuid[] := ARRAY[]::uuid[];
  v_zero_stack_seat_generations jsonb := '[]'::jsonb;
  v_zero_stack_vacated_at timestamptz;
  v_table_live_seat_count integer := 0;
BEGIN
  -- This implementation primitive is owner-only by ACL below. Do not inspect
  -- current_user inside a SECURITY DEFINER core: CREATE OR REPLACE preserves
  -- the production owner, so a valid call through the sole service wrapper
  -- may execute here as that owner rather than as postgres/service_role.
  IF p_table_id IS NULL OR p_hand_number IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_ids');
  END IF;
  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_stacks) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_stacks');
  END IF;


  -- One participant, one delta. Duplicates previously passed the sum check
  -- twice but wrote a single target, allowing a non-conserving final balance.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
              WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
                 OR jsonb_typeof(x->'user_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(x->'stack') IS DISTINCT FROM 'number'
                 OR (x ? 'stack_before' AND jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number')) THEN
    RAISE EXCEPTION 'Invalid hand settlement participant' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid) FROM jsonb_array_elements(p_stacks) x) THEN
    RAISE EXCEPTION 'Duplicate hand settlement participant' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'stack_before')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'stack_before')) THEN
    RAISE EXCEPTION 'Mixed absolute and delta hand settlement' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('user_id', (x->>'user_id')::uuid,
      'stack', (x->>'stack')::numeric)
      || CASE WHEN x ? 'stack_before' THEN jsonb_build_object('stack_before', (x->>'stack_before')::numeric)
              ELSE '{}'::jsonb END
      ORDER BY (x->>'user_id')::uuid) INTO v_canonical
    FROM jsonb_array_elements(p_stacks) x;
  v_request := jsonb_build_object('stacks', v_canonical, 'rake', p_rake,
    'bbj', p_bbj, 'inflow', p_inflow);

  /* DELTA MODE (chip standard 2026-09-04): the engine says what each stack
     WAS when it dealt and what it IS now; the database applies the difference
     to whatever the row holds. Every element must carry stack_before, or the
     whole call is absolute - a mixed payload would silently erase on the
     seats that lacked it. */
  SELECT bool_and(x ? 'stack_before' AND jsonb_typeof(x -> 'stack_before') = 'number')
    INTO v_delta_mode
    FROM jsonb_array_elements(p_stacks) x;
  v_delta_mode := COALESCE(v_delta_mode, false);

  -- stable hand id from (table, hand number[, ref])
  v_hand := md5('ca-hand:' || p_table_id::text || ':' || p_hand_number::text
                || CASE WHEN p_ref IS NULL OR p_ref = '' THEN '' ELSE ':' || p_ref END)::uuid;

  INSERT INTO public.settlement_idempotency_keys
    (table_id, hand_id, status, attempt_count, first_attempt_at, last_attempt_at)
  VALUES (p_table_id, v_hand, 'in_flight', 1, now(), now())
  ON CONFLICT (table_id, hand_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT status, result, last_attempt_at INTO v_prior
      FROM public.settlement_idempotency_keys
     WHERE table_id = p_table_id AND hand_id = v_hand FOR UPDATE;
    IF v_prior.status = 'succeeded' THEN
      -- Old receipts predate payload storage. New receipts bind the full request.
      IF v_prior.result ? 'request' AND v_prior.result->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'Hand settlement identity belongs to a different payload' USING ERRCODE = '22023';
      END IF;
      RETURN COALESCE(v_prior.result, '{}'::jsonb) || jsonb_build_object('replay', true);
    ELSIF v_prior.status = 'in_flight' AND v_prior.last_attempt_at > now() - interval '5 minutes' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'in_flight');
    ELSE
      UPDATE public.settlement_idempotency_keys
         SET status = 'in_flight', attempt_count = attempt_count + 1, last_attempt_at = now(), error = NULL
       WHERE table_id = p_table_id AND hand_id = v_hand;
    END IF;
  END IF;

  INSERT INTO public.ca_settlements (settlement_type, external_ref, state, table_id, hand_id, idempotency_key)
  VALUES ('hand_stacks', p_table_id::text || ':' || v_hand::text, 'open', p_table_id, v_hand,
          'hand:' || p_table_id::text || ':' || v_hand::text)
  ON CONFLICT (settlement_type, external_ref) DO UPDATE
    SET state = CASE WHEN public.ca_settlements.state = 'failed' THEN 'open'
                     ELSE public.ca_settlements.state END,
        error_detail = NULL
  RETURNING id INTO v_ca_id;

  BEGIN
    UPDATE public.ca_settlements SET state='locked_for_calculation' WHERE id = v_ca_id AND state='open';

    -- ONE LOCK ORDER WITH TERMINAL CLOSE (20260908): tournament,
    -- target tournament players by user_id/id, then target seats by id. The
    -- terminal authority takes the same order. A hand that waited behind a
    -- terminal commit sees COMPLETED and is refused before touching a seat.
    SELECT tb.tournament_id INTO v_tournament_id
      FROM public.tables tb WHERE tb.id = p_table_id;
    IF v_tournament_id IS NOT NULL THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_tournament_status
        FROM public.tournaments t
       WHERE t.id = v_tournament_id
       FOR SHARE;
      IF NOT FOUND OR v_tournament_status <> 'RUNNING' THEN
        RAISE EXCEPTION
          'tournament % is not RUNNING at the durable hand boundary',
          v_tournament_id USING ERRCODE = '55000';
      END IF;
      SELECT count(*),count(DISTINCT (x.value->>'user_id')::uuid)
        INTO v_payload_stack_count,v_target_user_count
        FROM jsonb_array_elements(v_canonical) AS x(value);
      IF v_target_user_count <> v_payload_stack_count THEN
        RAISE EXCEPTION 'tournament hand % contains duplicate player stacks',
          p_hand_number USING ERRCODE = '22023';
      END IF;
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing'
         AND tp.user_id IN (
           SELECT (x.value->>'user_id')::uuid
             FROM jsonb_array_elements(v_canonical) AS x(value))
       ORDER BY tp.user_id,tp.id
       FOR UPDATE;
      SELECT count(*) INTO v_tournament_player_count
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing'
         AND tp.user_id IN (
           SELECT (x.value->>'user_id')::uuid
             FROM jsonb_array_elements(v_canonical) AS x(value));
      IF v_tournament_player_count <> v_target_user_count THEN
        RAISE EXCEPTION
          'tournament % hand % does not map every stack to one playing player',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;
      -- A zero-seat vacate fires the seat-first table count trigger. Own the
      -- table before the seats, matching terminal close, so that trigger only
      -- reacquires a row this transaction already holds.
      PERFORM 1 FROM public.tables tb
       WHERE tb.id = p_table_id AND tb.tournament_id = v_tournament_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament table % changed while hand % was locking',
          p_table_id,p_hand_number USING ERRCODE = '40001';
      END IF;
    END IF;

    -- Acquire every live target seat once in durable row-id order before the
    -- original loop. The loop's individual SELECT FOR UPDATE calls then
    -- reacquire locks that this transaction already owns. v_canonical is also
    -- the immutable replay identity, so lock, write and receipt use one roster.
    PERFORM 1
      FROM public.table_seats ts
      JOIN (
        SELECT DISTINCT (x.value->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(v_canonical) AS x(value)
      ) target ON target.user_id = ts.user_id
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
     ORDER BY ts.id
     FOR UPDATE OF ts;

    -- lock seats, compute deltas / targets
    FOR e IN SELECT * FROM jsonb_array_elements(v_canonical) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_new := round((e->>'stack')::numeric, 2);
      IF v_new IS NULL OR v_new < 0 THEN
        RAISE EXCEPTION 'invalid stack for %: %', e->>'user_id', e->>'stack';
      END IF;
      SELECT ts.stack INTO v_old FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN
        /* A SEAT THAT LEFT DURING THE HAND (2026-09-04, verification sweep).
           In delta mode the player's own delta is settled against the club
           wallet the seat cashed out to, keyed on hand + user, and the players
           still seated get their deltas as usual. Refusing the whole hand here
           left the winner unpaid in the database and the leaver refunded the
           bet they had put in the pot (the exit cashes out the seat's stack
           as it stood BEFORE the hand). Measured before this: 3 cash hands in
           the first 40 minutes of delta mode, each a mid-hand leave_pending
           cash-out raced by a stale settlement step. Absolute mode still
           refuses: with no stack_before there is no delta to settle. */
        /* CASH TABLES ONLY. Tournament chips are play chips: a seat that a
           table balance moved or an elimination removed mid-hand has no
           wallet to settle against, and settling it debited 230 real chips
           from a player on 2026-09-04 13:04 (reversed in 20260904131500).
           The tournament conservation gate in the engine and the tournament
           branch below own that case; here it is refused whole, as before. */
        IF v_delta_mode AND NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = p_table_id AND tb.tournament_id IS NOT NULL) THEN
          v_before := round((e->>'stack_before')::numeric, 2);
          IF v_before IS NULL OR v_before < 0 THEN
            RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
          END IF;
          SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
           ORDER BY ts.left_at DESC LIMIT 1;
          IF v_dep_club IS NULL THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;
          /* SETTLING NOTHING NEEDS NO WALLET (2026-09-08). A seat that left
             having moved no chips has nothing to settle against a wallet, and
             the departed loop below already skips a zero delta. Demanding the
             wallet first refused whole hands over seats that owed nothing -
             hand 7903456, which nets to zero between two seated players, was
             refused because a third seat with a delta of 0.00 had gone. */
          IF round(v_new - v_before, 2) = 0 THEN
            v_n := v_n + 1;
            CONTINUE;
          END IF;
          IF v_dep_club IS NULL OR NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = v_uid AND m.club_id = v_dep_club) THEN
            RAISE EXCEPTION 'seat missing or left for % and no club wallet resolves for it - hand write rejected whole', v_uid;
          END IF;
          v_delta_sum := v_delta_sum + (v_new - v_before);
          v_departed := v_departed || jsonb_build_array(jsonb_build_object(
            'user_id', v_uid, 'delta', round(v_new - v_before, 2), 'club_id', v_dep_club));
          v_n := v_n + 1;
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;
      END IF;
      v_old := COALESCE(v_old, 0);

      IF v_delta_mode THEN
        v_before := round((e->>'stack_before')::numeric, 2);
        IF v_before IS NULL OR v_before < 0 THEN
          RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
        END IF;
        v_target := round(v_old + (v_new - v_before), 2);
        IF v_target < 0 THEN
          RAISE EXCEPTION 'negative stack for % after applying delta % to the seat''s % (engine dealt from %) - hand write rejected whole',
            v_uid, round(v_new - v_before, 2), v_old, v_before;
        END IF;
        v_delta_sum := v_delta_sum + (v_new - v_before);
        IF round(v_old - v_before, 2) <> 0 THEN
          v_rebased := v_rebased || jsonb_build_object(v_uid::text, round(v_old - v_before, 2));
          v_rebase_rows := v_rebase_rows || jsonb_build_array(jsonb_build_object(
            'user_id', v_uid, 'engine_before', v_before, 'db_before', v_old,
            'engine_after', v_new, 'written', v_target));
          v_rebase_count := v_rebase_count + 1;
        END IF;
      ELSE
        v_target := v_new;
        v_delta_sum := v_delta_sum + (v_new - v_old);
      END IF;
      v_targets := v_targets || jsonb_build_object(v_uid::text, v_target);
      v_n := v_n + 1;
    END LOOP;

    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', round(v_delta_sum,2),
                                  'rake', p_rake, 'bbj', p_bbj, 'inflow', p_inflow,
                                  'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END,
                                  'rebased', v_rebased, 'ref', p_ref, 'departed', v_departed)
      WHERE id = v_ca_id AND state='locked_for_calculation';

    SELECT tb.tournament_id INTO v_tournament_id FROM public.tables tb WHERE tb.id = p_table_id;

    IF v_delta_mode THEN
      /* THE IDENTITY, ON THE ENGINE'S OWN ARITHMETIC: what the seats gained
         is what arrived from a declared pool, less what left as rake and
         jackpot drop. Checked on every table, cash or tournament, on every
         write. A credit that landed on the row is outside the identity by
         construction - it is in v_old, not in the delta - so it is preserved
         rather than "explained". */
      v_expected := COALESCE(p_inflow, 0) - COALESCE(p_rake, 0) - COALESCE(p_bbj, 0);
      IF round(v_delta_sum - v_expected, 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation: stack deltas % != inflow % - rake % - bbj % (table % hand %) - write refused whole',
          round(v_delta_sum, 2), COALESCE(p_inflow, 0), COALESCE(p_rake, 0), COALESCE(p_bbj, 0),
          p_table_id, p_hand_number::text || COALESCE(':' || p_ref, '');
      END IF;
    ELSE
      -- ═══ TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02) ═══
      -- Absolute mode only. A tournament table has no rake and no BBJ drop,
      -- so the named seats must sum, after this write, to exactly what they
      -- summed to before it. A paid rebuy/re-entry/add-on commits its seat and
      -- roster under the accepted-hand table lock. The dealing loop reloads
      -- those authoritative rows before admitting the next hand. Therefore a
      -- non-zero delta is stale hand input, never permission to scan payment
      -- history and reconstruct chips. Refuse the whole hand at the boundary.
      IF v_tournament_id IS NOT NULL AND round(v_delta_sum, 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation (tournament %): stale accepted-hand stacks changed the table total by % across % seat(s) of table % hand % - paid seat/roster generations must be reloaded before dealing; write refused whole',
          v_tournament_id,round(v_delta_sum,2),v_n,p_table_id,p_hand_number;
      END IF;

      -- strict conservation only when rake is declared
      IF p_rake IS NOT NULL
         AND round(v_delta_sum + p_rake + COALESCE(p_bbj, 0), 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation: stack deltas %.2f + rake %.2f + bbj %.2f != 0',
          v_delta_sum, p_rake, COALESCE(p_bbj, 0);
      END IF;
    END IF;
    UPDATE public.ca_settlements SET state='validated' WHERE id = v_ca_id AND state='calculated';

    FOR e IN SELECT * FROM jsonb_array_elements(v_canonical) LOOP
      v_uid := (e->>'user_id')::uuid;
      IF NOT (v_targets ? v_uid::text) THEN
        CONTINUE;  -- a departed seat: settled against the wallet below
      END IF;
      v_target := (v_targets->>(v_uid::text))::numeric;
      UPDATE public.table_seats ts SET stack = v_target
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN
        /* aaa_skip_noop_update returns NULL for a row that would not change,
           and ROW_COUNT then reads 0. The seat was locked and found above, so
           a zero-row update whose seat already holds the target is the trigger
           doing its job, not a failed write. Before 2026-09-04 this rejected
           8,645 hands an hour - every hand in which one player's stack did not
           move - and each of those was persisted by the engine's unchecked
           per-seat fallback instead. */
        IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                        WHERE ts.table_id = p_table_id AND ts.user_id = v_uid
                          AND ts.left_at IS NULL AND ts.stack = v_target) THEN
          RAISE EXCEPTION 'seat write failed for % - hand write rejected whole', v_uid;
        END IF;
      END IF;
    END LOOP;

    -- A successful tournament hand has one durable stack source. Mirror the
    -- exact resulting/rebased live seat targets into the matching playing
    -- tournament_players rows while both sets are still locked. Any missing,
    -- duplicate or divergent row rejects the whole hand subtransaction.
    IF v_tournament_id IS NOT NULL THEN
      UPDATE public.tournament_players tp
         SET chips = target.stack
        FROM (
          SELECT x.key::uuid AS user_id,x.value::numeric AS stack
            FROM jsonb_each_text(v_targets) AS x(key,value)
        ) target
       WHERE tp.tournament_id = v_tournament_id
         AND tp.user_id = target.user_id
         AND tp.status::text = 'playing';

      SELECT count(*),
             COALESCE(array_agg(tp.user_id ORDER BY tp.user_id),ARRAY[]::uuid[]),
             COALESCE(jsonb_agg(jsonb_build_object(
               'user_id',tp.user_id,'chips',tp.chips)
               ORDER BY tp.user_id),'[]'::jsonb)
        INTO v_tournament_player_count,v_tournament_player_user_ids,
             v_tournament_player_chips
        FROM public.tournament_players tp
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = tp.user_id
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing';
      IF v_tournament_player_count <>
           (SELECT count(*) FROM jsonb_each(v_targets))
         OR EXISTS (
           SELECT 1
             FROM jsonb_each_text(v_targets) target
            WHERE NOT EXISTS (
              SELECT 1
                FROM public.tournament_players tp
                JOIN public.table_seats ts
                  ON ts.table_id = p_table_id
                 AND ts.user_id = tp.user_id
                 AND ts.left_at IS NULL
               WHERE tp.tournament_id = v_tournament_id
                 AND tp.status::text = 'playing'
                 AND tp.user_id = target.key::uuid
                 AND tp.chips IS NOT DISTINCT FROM target.value::numeric
                 AND ts.stack IS NOT DISTINCT FROM target.value::numeric)) THEN
        RAISE EXCEPTION
          'tournament % hand % did not durably sync every final seat stack',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;

      -- A named zero-stack tournament seat is finished on the felt at this
      -- same durable hand boundary. Keep tournament_players playing with
      -- chips=0 so the rebuy/elimination state machine can decide its life,
      -- but release the physical seat now. This replaces the former
      -- PostgREST vacate followed by a compensating chips-zero write.
      SELECT count(*),
             COALESCE(array_agg(ts.id ORDER BY ts.id),ARRAY[]::uuid[]),
             COALESCE(array_agg(ts.user_id ORDER BY ts.user_id),ARRAY[]::uuid[]),
             COALESCE(jsonb_agg(jsonb_build_object(
               'seat_id',ts.id,
               'user_id',ts.user_id,
               'seat_number',ts.seat_number,
               'joined_at',ts.joined_at)
               ORDER BY ts.id),'[]'::jsonb)
        INTO v_zero_stack_seat_count,v_zero_stack_seat_ids,
             v_zero_stack_user_ids,v_zero_stack_seat_generations
        FROM public.table_seats ts
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = ts.user_id
       WHERE ts.table_id = p_table_id
         AND ts.left_at IS NULL
         AND ts.stack = 0
         AND ts.user_id IS NOT NULL
         AND ts.joined_at IS NOT NULL
         AND target.value::numeric = 0;
      IF v_zero_stack_seat_count <>
           (SELECT count(*) FROM jsonb_each_text(v_targets) target
             WHERE target.value::numeric = 0) THEN
        RAISE EXCEPTION
          'tournament % hand % cannot identify every named zero-stack seat',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;

      IF v_zero_stack_seat_count > 0 THEN
        v_zero_stack_vacated_at := clock_timestamp();
        UPDATE public.table_seats ts
           SET left_at = v_zero_stack_vacated_at,
               status = 'left',
               leave_pending = false,
               is_sitting_out = false,
               is_away = false,
               sit_out_at = NULL,
               scheduled_leave_hands = NULL
         WHERE ts.id = ANY(v_zero_stack_seat_ids)
           AND ts.table_id = p_table_id
           AND ts.left_at IS NULL
           AND ts.stack = 0;
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated <> v_zero_stack_seat_count
           OR EXISTS (
             SELECT 1
               FROM unnest(v_zero_stack_seat_ids) expected(id)
              WHERE NOT EXISTS (
                SELECT 1 FROM public.table_seats ts
                 WHERE ts.id = expected.id
                   AND ts.table_id = p_table_id
                   AND ts.stack = 0
                   AND ts.left_at = v_zero_stack_vacated_at
                   AND ts.status = 'left'
                   AND COALESCE(ts.leave_pending,false) IS FALSE
                   AND COALESCE(ts.is_sitting_out,false) IS FALSE
                   AND COALESCE(ts.is_away,false) IS FALSE
                   AND ts.sit_out_at IS NULL
                   AND ts.scheduled_leave_hands IS NULL))
           OR EXISTS (
             SELECT 1
               FROM public.table_seats ts
               JOIN jsonb_each_text(v_targets) target
                 ON target.key::uuid = ts.user_id
              WHERE ts.table_id = p_table_id
                AND ts.left_at IS NULL
                AND target.value::numeric = 0) THEN
          RAISE EXCEPTION
            'tournament % hand % did not atomically vacate every zero-stack seat',
            v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
        END IF;
      END IF;

      SELECT count(*) INTO v_table_live_seat_count
        FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.left_at IS NULL;
      UPDATE public.tables tb
         SET current_players = v_table_live_seat_count,
             updated_at = now()
       WHERE tb.id = p_table_id
         AND tb.current_players IS DISTINCT FROM v_table_live_seat_count;
      IF NOT EXISTS (
        SELECT 1 FROM public.tables tb
         WHERE tb.id = p_table_id
           AND tb.tournament_id = v_tournament_id
           AND tb.current_players = v_table_live_seat_count) THEN
        RAISE EXCEPTION
          'tournament % hand % did not persist its exact live-seat count',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;
    END IF;

    /* THE LEAVER STILL OWES WHAT THEY BET, AND IS STILL OWED WHAT THEY WON.
       The exit credited the seat's pre-hand stack to the club wallet, so a
       negative delta is chips the wallet holds that the pot (and now the
       winner's seat) also holds: debit the wallet, counterparty the felt.
       A positive delta is a pot they won after leaving: credit it. Keyed on
       hand + user in wallet_credit_idempotency, so a retry of this hand
       settles nothing twice. A wallet that cannot cover the debit refuses
       the whole hand, with the numbers, rather than going negative. */
    FOR v_dep IN SELECT (d->>'user_id')::uuid AS user_id, (d->>'delta')::numeric AS delta, (d->>'club_id')::uuid AS club_id
                   FROM jsonb_array_elements(v_departed) d LOOP
      IF v_dep.delta = 0 THEN CONTINUE; END IF;
      v_dep_key := 'late_seat_settle:' || v_hand::text || ':' || v_dep.user_id::text;
      INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
      VALUES (v_dep_key, v_dep.user_id, v_dep.delta)
      ON CONFLICT (key) DO NOTHING;
      GET DIAGNOSTICS v_dep_claimed = ROW_COUNT;
      IF v_dep_claimed = 0 THEN CONTINUE; END IF;  -- already settled by an earlier attempt
      PERFORM public.fn_ca_declare_ledger('settlement', 'table_stack', p_table_id, v_ca_id, v_dep_key, NULL);
      UPDATE public.club_members m
         SET chip_balance = COALESCE(m.chip_balance, 0) + v_dep.delta, updated_at = now()
       WHERE m.user_id = v_dep.user_id AND m.club_id = v_dep.club_id
         AND COALESCE(m.chip_balance, 0) + v_dep.delta >= 0
       RETURNING m.chip_balance INTO v_dep_after;
      PERFORM set_config('app.ledger_category', '', true);
      PERFORM set_config('app.ledger_counterparty', '', true);
      PERFORM set_config('app.ledger_counterparty_entity', '', true);
      PERFORM set_config('app.ledger_idempotency_key', '', true);
      IF v_dep_after IS NULL THEN
        RAISE EXCEPTION 'seat missing or left for % and its club wallet cannot cover its delta of % - hand write rejected whole', v_dep.user_id, v_dep.delta;
      END IF;
      INSERT INTO public.chip_transactions (club_id, to_user_id, amount, transaction_type, notes, table_id, balance_after, metadata)
      VALUES (v_dep.club_id, v_dep.user_id, abs(v_dep.delta),
              CASE WHEN v_dep.delta < 0 THEN 'late_seat_debit' ELSE 'late_seat_credit' END,
              CASE WHEN v_dep.delta < 0
                   THEN format('Hand #%s settled after you left the table: %s chips you had bet are taken from the club wallet the seat cashed out to', p_hand_number, abs(v_dep.delta))
                   ELSE format('Hand #%s settled after you left the table: %s chips you won are credited to your club wallet', p_hand_number, v_dep.delta) END,
              p_table_id, v_dep_after, jsonb_build_object('hand_id', v_hand, 'key', v_dep_key, 'delta', v_dep.delta));
    END LOOP;
    UPDATE public.ca_settlements SET state='ledger_posted' WHERE id = v_ca_id AND state='validated';

    IF v_rebase_count > 0 THEN
      INSERT INTO public.ca_seat_stack_rebases
        (settlement_id, table_id, hand_id, hand_number, user_id, engine_before, db_before, engine_after, written)
      SELECT v_ca_id, p_table_id, v_hand, p_hand_number,
             (r->>'user_id')::uuid, (r->>'engine_before')::numeric, (r->>'db_before')::numeric,
             (r->>'engine_after')::numeric, (r->>'written')::numeric
        FROM jsonb_array_elements(v_rebase_rows) r;
    END IF;
    UPDATE public.ca_settlements SET state='post_commit_verified' WHERE id = v_ca_id AND state='ledger_posted';

    v_result := jsonb_build_object('success', true, 'players', v_n,
      'table_id', p_table_id, 'hand_id', v_hand, 'hand_number', p_hand_number,
      'net_deltas', round(v_delta_sum, 2), 'rake', p_rake, 'bbj', p_bbj, 'inflow', p_inflow,
      'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END,
      'rebased', v_rebased, 'written', v_targets, 'departed', v_departed,
      'conservation_checked', v_delta_mode OR p_rake IS NOT NULL,
      'tournament_id', v_tournament_id,
      'tournament_players_synced', v_tournament_id IS NOT NULL,
      'tournament_player_count', v_tournament_player_count,
      'tournament_player_user_ids', to_jsonb(v_tournament_player_user_ids),
      'tournament_player_chips', v_tournament_player_chips,
      'tournament_zero_stack_seats_vacated', v_tournament_id IS NOT NULL,
      'tournament_zero_stack_seat_count', v_zero_stack_seat_count,
      'tournament_zero_stack_seat_ids', to_jsonb(v_zero_stack_seat_ids),
      'tournament_zero_stack_user_ids', to_jsonb(v_zero_stack_user_ids),
      'tournament_zero_stack_seat_generations', v_zero_stack_seat_generations,
      'tournament_zero_stack_vacated_at', v_zero_stack_vacated_at,
      'tournament_table_live_seat_count', v_table_live_seat_count,
      'request', v_request);

    UPDATE public.settlement_idempotency_keys
       SET status='succeeded', result=v_result, completed_at=now(), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = v_hand;
    UPDATE public.ca_settlements SET state='final' WHERE id = v_ca_id AND state='post_commit_verified';
    RETURN v_result;

  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    UPDATE public.settlement_idempotency_keys
       SET status='failed', error=left(v_err, 500), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = v_hand;
    UPDATE public.ca_settlements SET state='failed', error_detail=left(v_err, 2000) WHERE id = v_ca_id;
    IF v_err LIKE 'conservation violation%' OR v_err LIKE 'negative stack%' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settle_hand_stacks_absolute', 'ledger_imbalance', 'warning',
        'hand-conservation:' || p_table_id::text,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0) - COALESCE(p_inflow,0), 2), 0,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0) - COALESCE(p_inflow,0), 2),
        'settlement', 'table_seats', v_hand, NULL, NULL, p_table_id, NULL, v_hand,
        v_ca_id::text, NULL, NULL,
        'engine submitted a hand whose stack deltas do not conserve: ' || left(v_err, 200),
        false, jsonb_build_object('hand_number', p_hand_number, 'ref', p_ref,
                                  'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END));
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_number', p_hand_number, 'ref', p_ref);
  END;
END $function$
;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric) IS
  'Owner-only accepted-hand stack core. The sole service door is the 12-argument lease-fenced fn_ca_commit_hand_settlement transaction; direct stack-only commits are forbidden.';

-- The lease-fenced accepted-hand core historically captured an active seat
-- generation after fn_ca_settle_hand_stacks_absolute returned. The complete
-- stack authority above now closes a named zero-stack seat before returning,
-- so retaining that old lookup would make every genuine tournament bust roll
-- the accepted hand back. Carry the exact pre-vacate generation in the nested
-- immutable result and consume that evidence here. Positive stacks still have
-- to own one active seat; zero stacks have to own the exact row that this same
-- transaction just closed. History, candidate, stack, roster, seat, table
-- count and hand receipt therefore remain one commit without weakening the
-- knockout-generation proof.
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $accepted_hand_with_zero_seat_generation$
DECLARE
  v_tournament_id uuid;
  v_stack_result jsonb;
  v_hand_id uuid;
  v_existing public.hand_history%ROWTYPE;
  v_prior public.hand_atomic_commits%ROWTYPE;
  v_commit_hash text;
  v_normalized_stacks jsonb;
  v_normalized_units jsonb;
  v_stack jsonb;
  v_uid uuid;
  v_written numeric;
  v_before numeric;
  v_seat record;
  v_zero_generation jsonb;
  v_zero_generation_count integer;
  v_prompt_until timestamptz;
  v_rebuy_window jsonb;
  v_rebuy_offer_available boolean;
  v_n integer;
  v_distinct integer;
  v_changed integer;
  v_candidate_id uuid;
BEGIN
  -- External authority is the EXECUTE ACL on the lease-fenced public wrapper.
  -- This nested SECURITY DEFINER core is owner-only and must remain callable
  -- when its preserved production owner is neither postgres nor service_role.
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
     OR jsonb_typeof(p_stacks)<>'array' OR jsonb_array_length(p_stacks)=0
     OR jsonb_typeof(p_hand_row)<>'object'
     OR jsonb_typeof(coalesce(p_units,'[]'::jsonb))<>'array'
     OR coalesce(p_hand_row->>'table_id','')<>p_table_id::text
     OR coalesce(p_hand_row->>'hand_number','')<>p_hand_number::text THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_atomic_hand_payload');
  END IF;

  SELECT count(*), count(DISTINCT x->>'user_id')
    INTO v_n, v_distinct
    FROM jsonb_array_elements(p_stacks) x
   WHERE jsonb_typeof(x)='object'
     AND coalesce(x->>'user_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND jsonb_typeof(x->'stack')='number'
     AND jsonb_typeof(x->'stack_before')='number'
     AND (x->>'stack')::numeric>=0
     AND (x->>'stack_before')::numeric>=0;
  IF v_n<>jsonb_array_length(p_stacks) OR v_distinct<>v_n THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_or_duplicate_stack_rows');
  END IF;

  SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO v_normalized_stacks
    FROM jsonb_array_elements(p_stacks) x;
  SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO v_normalized_units
    FROM jsonb_array_elements(coalesce(p_units,'[]'::jsonb)) x;
  v_commit_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'table_id',p_table_id,'hand_number',p_hand_number,
    'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,
    'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,
    'units',v_normalized_units)::text,'UTF8'),'sha256'),'hex');

  -- Lock order is global tournament lifecycle -> table -> exact table hand.
  -- Paid admissions take the global root exclusively before the same table
  -- lock; unrelated hands share the lifecycle root and remain concurrent.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-table:'||p_table_id::text,0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-hand:'||p_hand_number::text,0));

  SELECT * INTO v_prior
    FROM public.hand_atomic_commits c
   WHERE c.table_id=p_table_id
     AND c.hand_number=p_hand_number
   FOR UPDATE;
  IF FOUND THEN
    IF v_prior.payload_hash IS DISTINCT FROM v_commit_hash THEN
      RETURN jsonb_build_object(
        'success',false,'reason','atomic_hand_payload_conflict',
        'hand_number',p_hand_number,'existing_table_id',v_prior.table_id);
    END IF;
    RETURN v_prior.stack_result || jsonb_build_object(
      'success',true,'atomic_hand_commit',true,'replay',true,
      'history_id',v_prior.hand_id,'commit_hash',v_prior.payload_hash);
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t WHERE t.id=p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'reason','table_not_found');
  END IF;

  IF (p_hand_row->>'tournament_id') IS DISTINCT FROM v_tournament_id::text THEN
    RETURN jsonb_build_object(
      'success',false,'reason','hand_tournament_mismatch',
      'table_tournament_id',v_tournament_id,
      'row_tournament_id',p_hand_row->>'tournament_id');
  END IF;

  BEGIN
    IF v_tournament_id IS NOT NULL THEN
      PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR SHARE;
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id=v_tournament_id
         AND tp.user_id IN (
           SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(p_stacks) x)
       ORDER BY tp.user_id
       FOR UPDATE;
    END IF;

    v_stack_result := public.fn_ca_settle_hand_stacks_absolute(
      p_table_id,p_hand_number,v_normalized_stacks,p_rake,p_bbj,p_ref,p_inflow);
    IF coalesce((v_stack_result->>'success')::boolean,false) IS NOT TRUE THEN
      RETURN v_stack_result || jsonb_build_object('atomic_hand_commit',false);
    END IF;
    IF coalesce((v_stack_result->>'replay')::boolean,false) IS TRUE THEN
      RAISE EXCEPTION 'legacy stack settlement exists for hand % without an atomic receipt',
        p_hand_number USING ERRCODE='integrity_constraint_violation';
    END IF;

    SELECT * INTO v_existing
      FROM public.hand_history h
     WHERE h.table_id=p_table_id AND h.hand_number=p_hand_number;
    IF FOUND THEN
      RAISE EXCEPTION 'hand % already exists without an atomic commit receipt',p_hand_number
        USING ERRCODE='integrity_constraint_violation';
    ELSE
      PERFORM set_config('app.atomic_hand_commit','on',true);
      v_hand_id := public.fn_ca_insert_hand_with_awards(p_hand_row,p_units);
    END IF;

    IF v_tournament_id IS NOT NULL THEN
      IF jsonb_typeof(
           v_stack_result->'tournament_zero_stack_seat_generations')
             IS DISTINCT FROM 'array'
         OR jsonb_array_length(
              v_stack_result->'tournament_zero_stack_seat_generations')
              IS DISTINCT FROM
              COALESCE(
                (v_stack_result->>'tournament_zero_stack_seat_count')::integer,-1)
         OR (
              COALESCE(
                (v_stack_result->>'tournament_zero_stack_seat_count')::integer,-1) > 0
              AND (v_stack_result->>'tournament_zero_stack_vacated_at') IS NULL
            ) THEN
        RAISE EXCEPTION
          'accepted tournament hand omitted exact zero-seat generation evidence';
      END IF;

      FOR v_stack IN SELECT value FROM jsonb_array_elements(p_stacks)
      LOOP
        v_uid := (v_stack->>'user_id')::uuid;
        v_before := round((v_stack->>'stack_before')::numeric,2);
        v_written := round((v_stack_result->'written'->>v_uid::text)::numeric,2);
        IF v_written IS NULL THEN
          RAISE EXCEPTION 'accepted tournament hand omitted written stack for %',v_uid;
        END IF;
        IF v_written<>trunc(v_written) THEN
          RAISE EXCEPTION 'accepted tournament hand produced fractional stack % for %',v_written,v_uid;
        END IF;

        IF v_written=0 THEN
          SELECT count(*) INTO v_zero_generation_count
            FROM jsonb_array_elements(
                   v_stack_result->'tournament_zero_stack_seat_generations') g(value)
           WHERE g.value->>'user_id'=v_uid::text;
          IF v_zero_generation_count<>1 THEN
            RAISE EXCEPTION
              'accepted tournament hand has % zero-seat generations for %',
              v_zero_generation_count,v_uid USING ERRCODE='P0404';
          END IF;
          SELECT g.value INTO v_zero_generation
            FROM jsonb_array_elements(
                   v_stack_result->'tournament_zero_stack_seat_generations') g(value)
           WHERE g.value->>'user_id'=v_uid::text;
          SELECT s.id,s.joined_at,s.seat_number
            INTO v_seat
            FROM public.table_seats s
           WHERE s.id=(v_zero_generation->>'seat_id')::uuid
             AND s.table_id=p_table_id
             AND s.user_id=v_uid
             AND s.seat_number=(v_zero_generation->>'seat_number')::integer
             AND s.joined_at=(v_zero_generation->>'joined_at')::timestamptz
             AND s.stack=0
             AND s.left_at=
                   (v_stack_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND lower(COALESCE(s.status,''))='left'
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'accepted tournament hand lost exact closed seat generation for %',v_uid
              USING ERRCODE='P0404';
          END IF;
        ELSE
          SELECT s.id,s.joined_at,s.seat_number
            INTO v_seat
            FROM public.table_seats s
           WHERE s.table_id=p_table_id AND s.user_id=v_uid AND s.left_at IS NULL
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'accepted tournament hand lost active seat for % before generation capture',v_uid;
          END IF;
        END IF;

        UPDATE public.tournament_players tp
           SET chips=greatest(v_written,0)::integer,
               table_id=p_table_id,
               seat_number=v_seat.seat_number
         WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
           AND tp.status='playing';
        GET DIAGNOSTICS v_changed=ROW_COUNT;
        IF v_changed<>1 AND NOT EXISTS (
          SELECT 1 FROM public.tournament_players tp
           WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
             AND tp.status='playing'
             AND tp.chips=greatest(v_written,0)::integer
             AND tp.table_id=p_table_id
             AND tp.seat_number=v_seat.seat_number) THEN
          RAISE EXCEPTION
            'accepted tournament hand could not mirror playing roster row for %',v_uid;
        END IF;

        IF v_before>0 AND v_written=0 THEN
          SELECT
            (coalesce(t.is_rebuy,false)
               AND (t.max_rebuys IS NULL OR coalesce(tp.rebuys,0)<t.max_rebuys))
            OR
            (coalesce(t.is_reentry,false)
               AND (t.max_reentries IS NULL OR coalesce(tp.rebuys,0)<t.max_reentries)),
            public.fn_ca_tournament_rebuy_window(v_tournament_id)
            INTO v_rebuy_offer_available,v_rebuy_window
            FROM public.tournaments t
            JOIN public.tournament_players tp
              ON tp.tournament_id=t.id AND tp.user_id=v_uid
           WHERE t.id=v_tournament_id;
          v_prompt_until:=CASE
            WHEN v_rebuy_offer_available
             AND coalesce((v_rebuy_window->>'open')::boolean,false)
            THEN (v_rebuy_window->>'prompt_until')::timestamptz
            ELSE NULL END;
          IF v_prompt_until IS NOT NULL
             AND v_prompt_until<=clock_timestamp() THEN
            RAISE EXCEPTION
              'authoritative rebuy window returned an expired prompt for tournament %',
              v_tournament_id USING ERRCODE='P0404';
          END IF;

          v_candidate_id := NULL;
          INSERT INTO public.tournament_knockout_candidates(
            tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
            hand_id,hand_number,stack_before,stack_after,rebuy_prompt_until)
          VALUES (
            v_tournament_id,v_uid,p_table_id,v_seat.id,v_seat.joined_at,
            v_hand_id,p_hand_number,v_before,0,v_prompt_until)
          -- One accepted hand is one immutable knockout generation. A rebuy can
          -- bust again in the same physical chair, so chair identity must never
          -- absorb that later hand.
          ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING
          RETURNING id INTO v_candidate_id;
          IF v_candidate_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM public.tournament_knockout_candidates c
             WHERE c.tournament_id=v_tournament_id
               AND c.hand_number=p_hand_number
               AND c.eliminated_user_id=v_uid
               AND c.table_id=p_table_id
               AND c.seat_id=v_seat.id
               AND c.seat_joined_at=v_seat.joined_at
               AND c.hand_id=v_hand_id
               AND c.stack_before=v_before
               AND c.stack_after=0) THEN
            RAISE EXCEPTION
              'knockout candidate identity conflict for tournament %, hand %, user %',
              v_tournament_id,p_hand_number,v_uid;
          END IF;

          UPDATE public.tournament_players tp
             SET rebuy_prompt_until=v_prompt_until
           WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
             AND tp.status='playing';
        END IF;
      END LOOP;
    END IF;

    INSERT INTO public.hand_projection_outbox(hand_id,table_id,hand_number)
    VALUES (v_hand_id,p_table_id,p_hand_number);

    INSERT INTO public.hand_atomic_commits(
      table_id,hand_number,hand_id,payload_hash,stack_result)
    VALUES (p_table_id,p_hand_number,v_hand_id,v_commit_hash,v_stack_result);

    RETURN v_stack_result || jsonb_build_object(
      'success',true,
      'atomic_hand_commit',true,
      'history_id',v_hand_id,
      'tournament_id',v_tournament_id,
      'commit_hash',v_commit_hash);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',false,'atomic_hand_commit',false,'reason','atomic_hand_rolled_back',
      'error',SQLERRM,'sqlstate',SQLSTATE,'table_id',p_table_id,
      'hand_number',p_hand_number,'commit_hash',v_commit_hash);
  END;
END;
$accepted_hand_with_zero_seat_generation$;

REVOKE ALL ON FUNCTION
  public.fn_ca_commit_hand_settlement_before_lease_generation(
    uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

-- Resolve a non-bounty knockout only from the latest accepted hand involving
-- this player. `table_seats` is mutable operational state: it can veto a stale
-- claim, but it can never select or authorize a generation.
CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_bubble_refund numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_evidence_stack numeric;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_live_count integer;
  v_changed integer;
  v_result jsonb;
BEGIN
  IF p_position<2 OR p_prize IS NULL OR p_prize<0
     OR p_bubble_refund IS NULL OR p_bubble_refund<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  IF p_bubble_refund<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_running');
  END IF;
  IF coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false)
     OR coalesce(v_t.is_mystery_bounty,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_requires_outbox_claim');
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;
  IF v_player.status='winner' THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_winner');
  END IF;
  IF v_player.status NOT IN ('playing','eliminated')
     OR (v_player.status='playing' AND coalesce(v_player.chips,0)>0) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_busted');
  END IF;

  PERFORM 1
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
   ORDER BY c.hand_number,c.id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_candidate_required');
  END IF;

  -- The owner-only resolver selects this player's latest immutable entry
  -- generation and already proves both durable halves of its accepted hand.
  -- Re-read every identity here so this transaction is independently bound to
  -- candidate(history hand) -> atomic(internal settlement hand) -> receipt.
  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
     p_tournament_id,p_user_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','committed_knockout_candidate_not_found');
  END IF;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=v_candidate.table_id
     AND a.hand_number=v_candidate.hand_number
     AND a.hand_id=v_candidate.hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_missing');
  END IF;
  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  -- The settlement owner uses md5(... )::uuid for its stable internal key;
  -- validate PostgreSQL's canonical UUID shape without inventing RFC nibbles.
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>v_candidate.table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>
          v_candidate.hand_number
     OR coalesce(v_atomic.stack_result->'written'->>p_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'->>p_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT (k.result->'written'->>p_user_id::text)::numeric
    INTO v_evidence_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_candidate.table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_candidate.table_id::text
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_candidate.hand_number
     AND coalesce(k.result->'written'->>p_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$';
  IF NOT FOUND OR v_evidence_stack<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_settlement_receipt_missing');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.hand_number>v_candidate.hand_number
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','latest_knockout_evidence_chain_conflict');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.hand_number<v_candidate.hand_number
       AND c.state<>'rebought'
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','unresolved_knockout_generation_chain');
  END IF;

  IF (v_player.status='playing' AND v_candidate.state<>'pending')
     OR (v_player.status='eliminated' AND v_candidate.state<>'eliminated') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_state_mismatch',
      'player_state',v_player.status,'candidate_state',v_candidate.state);
  END IF;
  IF v_candidate.state='pending'
     AND v_candidate.rebuy_prompt_until IS NOT NULL
     AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','rebuy_decision_open',
      'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
  END IF;

  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_has_multiple_live_seats');
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM 0
       OR v_live.table_id IS DISTINCT FROM v_candidate.table_id
       OR v_live.id IS DISTINCT FROM v_candidate.seat_id
       OR v_live.joined_at IS DISTINCT FROM v_candidate.seat_joined_at THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','knockout_generation_has_new_live_seat');
    END IF;
  END IF;

  v_result:=public.fn_eliminate_player_legacy_candidate_20260907(
    p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  IF coalesce((v_result->>'ok')::boolean,false)
     AND v_player.status='playing' THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',
           resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>1 THEN
      RAISE EXCEPTION 'knockout generation changed while elimination committed'
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid,uuid,integer,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid,uuid,integer,numeric,numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the bounty payout state machine, but bind both replay and mutation
-- to the exact hand identity. Only the immutable commit/candidate pair can
-- authorize a new status or money obligation; no historical scan can invent
-- a missing knockout generation.
CREATE OR REPLACE FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_table_id uuid,
  p_hand_id uuid,
  p_hand_number bigint,
  p_seat_joined_at timestamptz,
  p_knocker_user_id uuid,
  p_claimants jsonb,
  p_bubble_refund numeric DEFAULT 0,
  p_allow_existing_eliminated boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_settlement_at timestamptz;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_mode text;
  v_claimants jsonb;
  v_input_claimants jsonb;
  v_knocker uuid;
  v_head numeric;
  v_hand_created_at timestamptz;
  v_position integer;
  v_prize numeric;
  v_claimed boolean := false;
  v_existing public.tournament_bounty_obligations%ROWTYPE;
  v_obligation_id uuid;
  v_activation_generation bigint := 0;
  v_pko_watermark bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_table_id IS NULL OR p_hand_id IS NULL OR p_hand_number IS NULL
     OR p_hand_number<1000000 OR p_seat_joined_at IS NULL
     OR p_bubble_refund IS NULL OR p_bubble_refund<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','missing_identity');
  END IF;
  IF p_bubble_refund<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;

  IF p_claimants IS NOT NULL THEN
    IF jsonb_typeof(p_claimants)<>'array' OR jsonb_array_length(p_claimants)=0
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_claimants) e
          WHERE coalesce(e->>'user_id','')
                  !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             OR coalesce(e->>'weight','') !~ '^[0-9]+([.][0-9]+)?$'
             OR (e->>'weight')::numeric<=0
       ) THEN
      RETURN jsonb_build_object('ok',false,'reason','invalid_claimants');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'weight',1)
                     ORDER BY user_id::text)
      INTO v_input_claimants
      FROM (
        SELECT DISTINCT (e->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(p_claimants) e
      ) q;
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- A hand triple is the immutable replay key. Two legitimate bounties may
  -- have the same player and seat_joined_at after a same-chair rebuy.
  SELECT * INTO v_existing
    FROM public.tournament_bounty_obligations o
   WHERE o.tournament_id=p_tournament_id
     AND o.table_id=p_table_id
     AND o.hand_id=p_hand_id
     AND o.hand_number=p_hand_number
     AND o.eliminated_user_id=p_eliminated_user_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.table_id IS DISTINCT FROM p_table_id
       OR v_existing.hand_id IS DISTINCT FROM p_hand_id
       OR v_existing.seat_joined_at IS DISTINCT FROM p_seat_joined_at
       OR v_existing.bubble_refund IS DISTINCT FROM round(p_bubble_refund,2)
       OR v_existing.position IS DISTINCT FROM p_position
       OR v_existing.prize IS DISTINCT FROM round(p_prize,2)
       OR (p_knocker_user_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(v_existing.claimants) c
              WHERE c->>'user_id'=p_knocker_user_id::text))
       OR (v_input_claimants IS NOT NULL
           AND v_existing.claimants IS DISTINCT FROM v_input_claimants) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','obligation_identity_conflict');
    END IF;
    IF v_existing.state='settled'
       AND NOT public.fn_bounty_obligation_has_complete_marker(v_existing.id) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','settled_marker_incomplete',
        'obligation_id',v_existing.id);
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'already',true,'claimed',false,
      'mode',v_existing.mode,'state',v_existing.state,
      'activation_generation',v_existing.activation_generation,
      'obligation_id',v_existing.id);
  END IF;

  IF NOT (coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false)
          OR coalesce(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_bounty_tournament');
  END IF;
  IF upper(coalesce(v_t.status,''))<>'RUNNING'
     AND NOT (p_allow_existing_eliminated
              AND upper(coalesce(v_t.status,''))='COMPLETING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_lifecycle_not_claimable',
      'status',v_t.status);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;
  IF coalesce(v_player.chips,0)>0 THEN
    RETURN jsonb_build_object('ok',false,'reason','player_has_chips');
  END IF;
  IF v_player.status<>'playing' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','status_not_claimable','status',v_player.status);
  END IF;
  IF p_position IS NULL OR p_position<2 OR p_prize IS NULL OR p_prize<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  v_position:=p_position;
  v_prize:=p_prize;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=p_table_id
     AND a.hand_number=p_hand_number
     AND a.hand_id=p_hand_id;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.hand_atomic_commits a
       WHERE a.table_id=p_table_id AND a.hand_number=p_hand_number
    ) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','atomic_knockout_history_identity_conflict');
    END IF;
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_evidence_required');
  END IF;

  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>p_table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>p_hand_number
     OR coalesce(v_atomic.stack_result->'written'
                   ->>p_eliminated_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'
           ->>p_eliminated_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.table_id=p_table_id
     AND c.hand_number=p_hand_number
     AND c.hand_id=p_hand_id
     AND c.eliminated_user_id=p_eliminated_user_id;
  IF NOT FOUND
     OR v_candidate.seat_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;

  SELECT k.completed_at INTO v_settlement_at
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=p_table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.completed_at>=p_seat_joined_at
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=p_hand_number
     AND k.result->>'table_id'=p_table_id::text
     AND k.result->'written' ? p_eliminated_user_id::text
     AND coalesce(k.result->'written'->>p_eliminated_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$'
     AND (k.result->'written'->>p_eliminated_user_id::text)::numeric=0;
  IF v_settlement_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','accepted_zero_settlement_not_found');
  END IF;

  SELECT h.created_at INTO v_hand_created_at
    FROM public.hand_history h
   WHERE h.id=p_hand_id
     AND h.table_id=p_table_id
     AND h.hand_number=p_hand_number
     AND h.hand_number>=1000000
     AND h.created_at>=v_settlement_at
     AND h.created_at>=p_seat_joined_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(h.players,'[]'::jsonb)) player
        WHERE coalesce(player->>'userId',player->>'user_id')=
                p_eliminated_user_id::text
          AND coalesce(player->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
          AND (player->>'stack')::numeric=0
     );
  IF v_hand_created_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_history_not_found');
  END IF;

  v_claimants:=public.fn_exact_tournament_knockout_claimants(
    p_tournament_id,p_hand_id,p_eliminated_user_id);
  IF v_claimants IS NULL OR jsonb_array_length(v_claimants)=0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_pot_claimants_not_found');
  END IF;
  SELECT (e->>'user_id')::uuid INTO v_knocker
    FROM jsonb_array_elements(v_claimants) e
   ORDER BY e->>'user_id' LIMIT 1;
  IF p_knocker_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_claimants) e
        WHERE e->>'user_id'=p_knocker_user_id::text
     ) THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_knocker');
  END IF;
  IF v_input_claimants IS NOT NULL
     AND v_input_claimants IS DISTINCT FROM v_claimants THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','claimants_do_not_match_exact_pot');
  END IF;

  v_mode:=CASE
    WHEN coalesce(v_t.is_mystery_bounty,false)
         AND v_t.mystery_bounty_stage='active' THEN 'mystery_chest'
    WHEN coalesce(v_t.is_pko,false) THEN 'pko'
    WHEN coalesce(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
    ELSE 'regular'
  END;
  v_activation_generation:=CASE WHEN v_mode='mystery_chest'
    THEN v_t.mystery_bounty_activation_generation ELSE 0 END;
  IF v_mode='mystery_chest' AND (
       v_activation_generation<=0 OR NOT EXISTS (
         SELECT 1 FROM public.tournament_mystery_activation_receipts ar
          WHERE ar.tournament_id=p_tournament_id
            AND ar.activation_generation=v_activation_generation
       )) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','mystery_activation_evidence_missing');
  END IF;

  IF v_mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=p_tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','pko_order_already_advanced',
        'last_settled_hand_number',v_pko_watermark);
    END IF;
  END IF;

  IF v_mode='pko' AND EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations prior
     WHERE prior.tournament_id=p_tournament_id
       AND prior.mode='pko' AND prior.state='pending'
       AND (prior.hand_number<p_hand_number
            OR (prior.hand_number=p_hand_number
                AND prior.eliminated_user_id::text<
                    p_eliminated_user_id::text))
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(prior.claimants) c
          WHERE c->>'user_id'=p_eliminated_user_id::text
       )
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_pko_predecessor');
  END IF;

  IF v_mode='pko' AND EXISTS (
    SELECT 1
      FROM public.hand_history h
      CROSS JOIN LATERAL
        jsonb_array_elements(coalesce(h.players,'[]'::jsonb)) hp
     WHERE h.id=p_hand_id
       AND coalesce(hp->>'userId',hp->>'user_id','')
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND coalesce(hp->>'userId',hp->>'user_id')<>
             p_eliminated_user_id::text
       AND coalesce(hp->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
       AND (hp->>'stack')::numeric<=0
       AND public.fn_exact_tournament_knockout_claimants(
             p_tournament_id,h.id,
             coalesce(hp->>'userId',hp->>'user_id')::uuid)
             @> jsonb_build_array(jsonb_build_object(
                  'user_id',p_eliminated_user_id,'weight',1))
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations predecessor
          WHERE predecessor.tournament_id=p_tournament_id
            AND predecessor.hand_number=p_hand_number
            AND predecessor.eliminated_user_id=
                coalesce(hp->>'userId',hp->>'user_id')::uuid
            AND predecessor.state='settled'
       )
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','same_hand_pko_predecessor');
  END IF;

  v_head:=coalesce(nullif(v_player.current_bounty,0),
                   nullif(v_t.bounty_amount,0));
  IF coalesce(v_head,0)<=0 THEN
    RETURN jsonb_build_object('ok',false,'reason','exact_head_value_not_found');
  END IF;

  UPDATE public.tournament_players tp
     SET status='eliminated',position=p_position,prize=p_prize,
         eliminated_at=now()
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
     AND tp.status='playing' AND tp.chips<=0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bounty elimination CAS missed after locked claim'
      USING ERRCODE='serialization_failure';
  END IF;
  v_claimed:=true;

  INSERT INTO public.tournament_bounty_obligations(
    tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
    settlement_completed_at,seat_joined_at,position,prize,bubble_refund,
    mode,activation_generation,head_amount,knocker_user_id,claimants,
    next_attempt_at)
  VALUES (
    p_tournament_id,p_eliminated_user_id,p_table_id,p_hand_id,p_hand_number,
    v_settlement_at,p_seat_joined_at,v_position,round(v_prize,2),0,
    v_mode,v_activation_generation,round(v_head,2),v_knocker,v_claimants,
    CASE WHEN v_mode='mystery_chest' THEN now()+interval '30 seconds'
         ELSE now() END)
  RETURNING id INTO v_obligation_id;

  UPDATE public.table_seats s
     SET left_at=coalesce(s.left_at,now())
   WHERE s.table_id=p_table_id AND s.user_id=p_eliminated_user_id
     AND s.joined_at=p_seat_joined_at AND s.left_at IS NULL;
  UPDATE public.tables tb
     SET current_players=(
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id=p_table_id AND s.left_at IS NULL)
   WHERE tb.id=p_table_id;
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  UPDATE public.tournament_bounty_obligations o
     SET state='settled',settled_at=now()
   WHERE o.id=v_obligation_id
     AND public.fn_bounty_obligation_has_complete_marker(o.id);

  RETURN jsonb_build_object(
    'ok',true,'already',false,'claimed',v_claimed,'mode',v_mode,
    'state',(SELECT o.state FROM public.tournament_bounty_obligations o
              WHERE o.id=v_obligation_id),
    'activation_generation',v_activation_generation,'bubble_refund',0,
    'obligation_id',v_obligation_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,
  numeric,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_claim_tournament_bounty_elimination(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_table_id uuid,
  p_hand_id uuid,
  p_hand_number bigint,
  p_seat_joined_at timestamptz,
  p_knocker_user_id uuid,
  p_claimants jsonb,
  p_bubble_refund numeric DEFAULT 0,
  p_allow_existing_eliminated boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_evidence_stack numeric;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_live_count integer;
  v_changed integer;
  v_result jsonb;
BEGIN
  -- Exact replay is permitted after the player, seat and tournament have moved
  -- on. The immutable obligation itself is the receipt, and the private core
  -- verifies every caller-supplied field against it.
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_hand_number IS NULL THEN
    RETURN public.fn_claim_bounty_legacy_candidate_20260907(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.tournament_id=p_tournament_id
       AND o.table_id=p_table_id
       AND o.hand_id=p_hand_id
       AND o.hand_number=p_hand_number
       AND o.eliminated_user_id=p_eliminated_user_id
  ) THEN
    RETURN public.fn_claim_bounty_legacy_candidate_20260907(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;

  PERFORM 1
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_eliminated_user_id
   ORDER BY c.hand_number,c.id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_candidate_required');
  END IF;

  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
     p_tournament_id,p_eliminated_user_id);
  IF NOT FOUND
     OR v_candidate.table_id IS DISTINCT FROM p_table_id
     OR v_candidate.hand_id IS DISTINCT FROM p_hand_id
     OR v_candidate.hand_number IS DISTINCT FROM p_hand_number
     OR v_candidate.seat_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bounty_claim_is_not_latest_knockout_hand');
  END IF;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=v_candidate.table_id
     AND a.hand_number=v_candidate.hand_number
     AND a.hand_id=v_candidate.hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_missing');
  END IF;
  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>v_candidate.table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>
          v_candidate.hand_number
     OR coalesce(v_atomic.stack_result->'written'
                   ->>p_eliminated_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'
           ->>p_eliminated_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT (k.result->'written'
            ->>p_eliminated_user_id::text)::numeric
    INTO v_evidence_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_candidate.table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_candidate.table_id::text
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_candidate.hand_number
     AND coalesce(k.result->'written'
                   ->>p_eliminated_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$';
  IF NOT FOUND OR v_evidence_stack<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_settlement_receipt_missing');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.hand_number>v_candidate.hand_number
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','latest_knockout_evidence_chain_conflict');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.hand_number<v_candidate.hand_number
       AND c.state<>'rebought'
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','unresolved_knockout_generation_chain');
  END IF;
  IF v_candidate.state<>'pending' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_state_mismatch',
      'player_state',v_player.status,'candidate_state',v_candidate.state);
  END IF;
  IF v_candidate.rebuy_prompt_until IS NOT NULL
     AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','rebuy_decision_open',
      'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
  END IF;

  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_has_multiple_live_seats');
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM 0
       OR v_live.table_id IS DISTINCT FROM v_candidate.table_id
       OR v_live.id IS DISTINCT FROM v_candidate.seat_id
       OR v_live.joined_at IS DISTINCT FROM v_candidate.seat_joined_at THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','knockout_generation_has_new_live_seat');
    END IF;
  END IF;

  v_result:=public.fn_claim_bounty_legacy_candidate_20260907(
    p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
    p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
    p_bubble_refund,p_allow_existing_eliminated);
  IF coalesce((v_result->>'ok')::boolean,false)
     AND coalesce((v_result->>'claimed')::boolean,false)
  THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',
           resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>1 THEN
      RAISE EXCEPTION
        'bounty knockout generation changed while claim committed'
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,
  numeric,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_tournament_bounty_elimination(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,
  numeric,boolean) TO service_role;

-- The current protocol-2 hand door persists an exhaustive time-bank snapshot
-- after the exact-generation core returns. A zero-stack tournament seat is
-- deliberately closed inside that core, so the historical active-seat-only
-- predicate would update N-1 of N participants and roll every genuine bust
-- back as time_bank_seat_mismatch. Preserve the complete obligations authority
-- and admit only the one closed row whose full id/user/number/joined/vacated
-- generation was returned by this same accepted-hand transaction.
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb,
  p_instance_id text,
  p_lease_generation uuid,
  p_post_commit_obligations jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_result jsonb;
  v_hand_id uuid;
  v_request_hash text;
  v_hash text;
  v_existing_request_hash text;
  v_existing_hash text;
  v_payload jsonb;
  v_club_id uuid;
  v_tournament_id uuid;
  v_item jsonb;
  v_expected integer;
  v_updated integer;
  v_row_count integer;
BEGIN
  -- This public 12-argument door is the outermost accepted-hand authority.
  -- Take the lifecycle root before its preserved exact-generation core can
  -- lock a lease, tournament or table. The owner-only nine-argument core
  -- re-enters this shared transaction lock defensively; that acquisition is
  -- harmless and keeps the private core safe from future owner-only callers.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));

  IF jsonb_typeof(p_post_commit_obligations) IS DISTINCT FROM 'object'
     OR p_post_commit_obligations->>'version' <> '1'
     OR jsonb_typeof(p_post_commit_obligations->'time_banks') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'promo_playthrough') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'insurance') IS DISTINCT FROM 'array'
     OR NOT (p_post_commit_obligations ? 'pending_addons')
     OR NOT (p_post_commit_obligations ? 'rake')
     OR NOT (p_post_commit_obligations ? 'bbj_contribution')
     OR p_post_commit_obligations ? 'accepted_hand_facts'
     OR jsonb_typeof(p_post_commit_obligations->'rake') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'pending_addons') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'pot_size') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_hand_row->'big_blind') IS DISTINCT FROM 'number'
     OR COALESCE(p_rake, 0) < 0
     OR COALESCE(p_bbj, 0) < 0
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'contributions')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'insurance')
          IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_accepted_post_commit_facts)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'uses_remaining') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'seconds_remaining') IS DISTINCT FROM 'number'
        OR (x->>'uses_remaining') !~ '^[0-9]+$'
        OR (x->>'seconds_remaining') !~ '^[0-9]+$'
        OR CASE WHEN (x->>'uses_remaining') ~ '^[0-9]+$'
                THEN (x->>'uses_remaining')::numeric > 2147483647 ELSE false END
        OR CASE WHEN (x->>'seconds_remaining') ~ '^[0-9]+$'
                THEN (x->>'seconds_remaining')::numeric > 2147483647 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'wagered') IS DISTINCT FROM 'number'
        OR CASE WHEN jsonb_typeof(x->'wagered') = 'number'
                THEN (x->>'wagered')::numeric <= 0 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'player_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'equity_percent') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'premium') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'insured_amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'payout') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'player_won') IS DISTINCT FROM 'boolean'
        OR COALESCE(x->>'kind', '') NOT IN ('insurance', 'ev_cashout')
        OR CASE WHEN jsonb_typeof(x->'equity_percent') = 'number'
                THEN (x->>'equity_percent')::numeric NOT BETWEEN 0 AND 100 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'premium') = 'number'
                THEN (x->>'premium')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'insured_amount') = 'number'
                THEN (x->>'insured_amount')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'payout') = 'number'
                THEN (x->>'payout')::numeric < 0 ELSE false END
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_item)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake'->'amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'bbj') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'pot') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'num_players') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'contributions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'returned_uncalled') IS DISTINCT FROM 'object'
       OR (p_post_commit_obligations->'rake'->>'num_players') !~ '^[0-9]+$'
       OR COALESCE((p_post_commit_obligations->'rake'->>'amount')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'bbj')::numeric, 0) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'pot')::numeric, -1) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0)
            > 2147483647
       OR (p_post_commit_obligations->'rake'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_rake)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'amount')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'big_blind')
         IS DISTINCT FROM 'number'
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric, 0)
            <= 0
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric, 0)
            <= 0
       OR (p_post_commit_obligations->'bbj_contribution'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_bbj)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled')
         IS DISTINCT FROM 'boolean'
       OR CASE
            WHEN jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled') = 'boolean'
            THEN COALESCE(
              (p_post_commit_obligations->'pending_addons'->>'enabled')::boolean,
              false
            ) IS NOT TRUE
            ELSE false
          END
       OR jsonb_typeof(p_post_commit_obligations->'pending_addons'->'max_buy_in')
            IS DISTINCT FROM 'number'
       OR COALESCE(
            (p_post_commit_obligations->'pending_addons'->>'max_buy_in')::numeric,
            0
          ) <= 0
       OR p_post_commit_obligations->'pending_addons' ? 'ids'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_addons)';
  END IF;

  IF p_hand_number > 2147483647
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
       OR jsonb_array_length(p_post_commit_obligations->'insurance') > 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_hand_number_out_of_range)';
  END IF;

  v_request_hash := encode(
    extensions.digest(convert_to(p_post_commit_obligations::text, 'UTF8'), 'sha256'),
    'hex'
  );

  /* The owner-only exact-generation core locks and proves the cash-table or
     tournament generation, then runs the unchanged accepted-hand core. Its
     lease/table locks remain held until this outer transaction commits. */
  v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units,
    p_instance_id,
    p_lease_generation
  );

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_hand_id := (v_result->>'history_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_history_receipt)';
  END;
  IF v_hand_id IS NULL THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_history_receipt)';
  END IF;

  SELECT t.club_id, t.tournament_id
    INTO v_club_id, v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND OR v_club_id IS NULL THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_table_scope_missing)';
  END IF;

  /* The envelope cannot contradict the accepted hand. Amounts bind to the
     settlement arguments; every per-player item binds to its authoritative
     stack roster; every money item binds to the table's club. */
  IF (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
             IS DISTINCT FROM p_rake
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'bbj')::numeric
             IS DISTINCT FROM COALESCE(p_bbj, 0)
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'pot')::numeric
             IS DISTINCT FROM (p_hand_row->>'pot_size')::numeric
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'num_players')::integer
             IS DISTINCT FROM (
               SELECT count(*)::integer
                 FROM jsonb_object_keys(
                   p_hand_row->'_accepted_post_commit_facts'->'contributions'
                 )
             )
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'contributions'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'contributions'
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'returned_uncalled'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )
     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object')
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric
             IS DISTINCT FROM p_bbj
     )
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric
             IS DISTINCT FROM (p_hand_row->>'big_blind')::numeric
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_fee_mismatch)';
  END IF;

  IF p_post_commit_obligations->'insurance' IS DISTINCT FROM
       p_hand_row->'_accepted_post_commit_facts'->'insurance' THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_insurance_fact_mismatch)';
  END IF;

  IF (
       v_tournament_id IS NULL
       AND (
         jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
           IS DISTINCT FROM (
             SELECT count(*)::integer
               FROM jsonb_each(
                 p_hand_row->'_accepted_post_commit_facts'->'contributions'
               ) e
              WHERE (e.value::text)::numeric > 0
           )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
            WHERE (x->>'wagered')::numeric IS DISTINCT FROM
                  (
                    p_hand_row->'_accepted_post_commit_facts'->'contributions'->>
                    (x->>'user_id')
                  )::numeric
         )
       )
     ) OR (
       v_tournament_id IS NOT NULL
       AND jsonb_array_length(p_post_commit_obligations->'promo_playthrough') <> 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_promo_fact_mismatch)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'contributions'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'user_id'
        )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'player_id'
        )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_player_or_club_mismatch)';
  END IF;

  /* Repeated recipients would turn one accepted-hand fact into two additive
     mutations. Time-bank rows are exhaustive because omitting one would make
     the accepted seat state depend on whichever process ran before this one. */
  IF jsonb_array_length(p_post_commit_obligations->'time_banks')
       IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     ) IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
     OR (
       /* The durable insurance writer is unique per table/hand/player. Two
          different kinds for one player would look like two obligations here
          but collapse to one receipt downstream. Refuse that ambiguity. */
       SELECT count(DISTINCT x->>'player_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'insurance') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_duplicate_or_missing_recipient)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'contributions', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'returned_uncalled', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_rake_recipient_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND p_post_commit_obligations->'rake'->>'club_id' IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND p_post_commit_obligations->'bbj_contribution'->>'club_id'
           IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_bbj_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       COALESCE(p_post_commit_obligations->'rake'->>'tournament_id', '')
         IS DISTINCT FROM COALESCE(v_tournament_id::text, '')
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_scope_mismatch)';
  END IF;
  IF (v_tournament_id IS NULL) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object') THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_addon_scope_mismatch)';
  END IF;

  SELECT c.post_commit_request_hash, c.post_commit_payload_hash
    INTO v_existing_request_hash, v_existing_hash
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number
     AND c.hand_id = v_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_atomic_receipt)';
  END IF;
  IF v_existing_request_hash IS NOT NULL
     AND v_existing_request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_payload_conflict)';
  END IF;

  IF v_existing_request_hash IS NULL THEN
    /* A rolling 11-argument engine may already have committed this hand and
       run its legacy post-commit steps. Never attach a new additive envelope
       to that receipt. A response-loss replay from this 12-argument door
       always finds the request hash written by its first transaction. */
    IF COALESCE((v_result->>'replay')::boolean, false) IS TRUE THEN
      RAISE EXCEPTION
        'atomic hand commit refused (legacy_receipt_has_no_post_commit_envelope)';
    END IF;

    /* Copy the independently accepted facts into the immutable stored envelope.
       The caller is forbidden from supplying this key itself. Besides the core
       hand hash, the durable processor/audit row can therefore show exactly
       which first-narrative facts every derived obligation was checked against. */
    v_payload := jsonb_set(
      p_post_commit_obligations,
      '{accepted_hand_facts}',
      p_hand_row->'_accepted_post_commit_facts',
      true
    );
    IF jsonb_typeof(v_payload->'pending_addons') = 'object' THEN
      /* Own the exact eligible rows through commit. A legacy/manual resolver
         cannot consume one after it was frozen but before the obligation
         transaction gets its causal wake. */
      PERFORM 1
        FROM public.table_pending_addons a
       WHERE a.table_id = p_table_id
         AND a.resolved_at IS NULL
         AND a.created_at <= transaction_timestamp()
       ORDER BY a.created_at, a.id
       FOR UPDATE;
      v_payload := jsonb_set(
        v_payload,
        '{pending_addons,ids}',
        COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM public.table_pending_addons a
           WHERE a.table_id = p_table_id
             AND a.resolved_at IS NULL
             AND a.created_at <= transaction_timestamp()
        ), '[]'::jsonb),
        true
      );
    END IF;
    v_hash := encode(
      extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );

    /* Time-bank state belongs to the accepted-hand boundary itself. Apply it
       while the exact lease/table/seat locks inherited from the owner-only
       exact-generation core are still held, never later from a stale envelope. */
    v_expected := jsonb_array_length(v_payload->'time_banks');
    v_updated := 0;
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(v_payload->'time_banks')
       ORDER BY value->>'user_id'
    LOOP
      IF (v_item->>'user_id') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (v_item->>'uses_remaining') !~ '^[0-9]+$'
         OR (v_item->>'seconds_remaining') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'atomic hand commit refused (invalid_time_bank_obligation)';
      END IF;
      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_updated := v_updated + v_row_count;
    END LOOP;
    IF v_updated IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_mismatch)';
    END IF;

    UPDATE public.hand_atomic_commits c
       SET post_commit_payload = v_payload,
           post_commit_request_hash = v_request_hash,
           post_commit_payload_hash = v_hash
     WHERE c.table_id = p_table_id
       AND c.hand_number = p_hand_number
       AND c.hand_id = v_hand_id
       AND c.post_commit_request_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;
  ELSE
    v_hash := v_existing_hash;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash
  );
END;
$function$;


REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)
  TO service_role;

-- Live mystery draw and pay formerly acquired a chest/award before the event
-- row. Terminal close owns the event first and then inventory, so an in-flight
-- reveal could form award -> tournament against tournament -> award. Preserve
-- both audited bodies exactly except for a tournament-first serialization
-- lock (and, for pay, the same obligation/chest/award/recipient order).
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_a record;
  v_r record;
  v_paid bigint := 0;
  v_credited boolean;
  v_refused integer := 0;
  v_chest_status text;
  v_prior numeric;
  v_settle jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT a.tournament_id INTO v_tournament_id
    FROM public.tournament_bounty_awards a WHERE a.id=p_award_id;
  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','award_not_found');
  END IF;
  PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  -- The unguarded payer owns the exact award before it writes obligation and
  -- wallet evidence. Own every terminal-visible set in the same canonical
  -- tournament -> obligations -> chests -> awards -> recipients order first;
  -- its later row locks are then transaction-local reacquisitions.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.user_id,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = v_tournament_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = v_tournament_id ORDER BY a.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_award_recipients r
   JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = v_tournament_id
   ORDER BY r.user_id,r.id FOR UPDATE OF r;
  -- The payer itself is static in this root. Stage two can remove the
  -- temporary unguarded copy without leaving an undefined runtime call.
  SELECT * INTO v_a
    FROM public.tournament_bounty_awards
   WHERE id = p_award_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found');
  END IF;

  IF v_a.status = 'completed' THEN
    IF v_a.bounty_obligation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.id=v_a.bounty_obligation_id AND o.state='settled'
         AND public.fn_bounty_obligation_has_complete_marker(o.id)
    ) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','completed_award_marker_incomplete',
        'award_id',p_award_id);
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'award_id', p_award_id,
      'amount_cents', v_a.amount_cents);
  END IF;
  IF v_a.status = 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet_revealed');
  END IF;
  IF v_a.status = 'void' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'award_voided_by_settlement',
      'award_id', p_award_id);
  END IF;

  SELECT status INTO v_chest_status
    FROM public.tournament_bounty_chests
   WHERE id = v_a.chest_id;
  IF v_chest_status = 'void' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'chest_settled_to_champion',
      'award_id', p_award_id);
  END IF;

  FOR v_r IN
    SELECT * FROM public.tournament_bounty_award_recipients
     WHERE award_id = p_award_id
       AND paid_at IS NULL
       AND amount_cents > 0
     ORDER BY user_id
     FOR UPDATE
  LOOP
    v_prior := COALESCE((
      SELECT o.amount_paid FROM public.tournament_obligations o
       WHERE o.tournament_id = v_a.tournament_id
         AND o.kind = 'mystery_bounty'
         AND o.place IS NULL
         AND o.user_id = v_r.user_id), 0);
    v_settle := public.fn_settle_tournament_obligation(
      v_a.tournament_id, 'mystery_bounty', NULL, v_r.user_id,
      round(v_prior + (v_r.amount_cents / 100.0), 2),
      'fn_mystery_bounty_pay',
      'Mystery bounty revealed from eliminated player');
    v_credited := COALESCE((v_settle->>'ok')::boolean, false);

    IF COALESCE(v_credited, false)
       AND round(COALESCE((v_settle->>'paid')::numeric,0),2)
             = round((v_r.amount_cents / 100.0)::numeric,2) THEN
      UPDATE public.tournament_bounty_award_recipients
         SET paid_at = now()
       WHERE id = v_r.id;

      v_paid := v_paid + v_r.amount_cents;
      UPDATE public.tournament_players
         SET bounties_collected = COALESCE(bounties_collected, 0) + 1,
             bounty_winnings = round(
               COALESCE(bounty_winnings, 0)
                 + (v_r.amount_cents / 100.0), 2)
       WHERE tournament_id = v_a.tournament_id
         AND user_id = v_r.user_id;

      INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id,
         bounty_amount, is_mystery_revealed, bounty_obligation_id)
      VALUES
        (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
         (v_r.amount_cents / 100.0)::numeric, true,
         v_a.bounty_obligation_id)
      ON CONFLICT DO NOTHING;
    ELSE
      RAISE EXCEPTION
        'fn_mystery_bounty_pay: recipient % refused for award % (%)',
        v_r.user_id, p_award_id,
        COALESCE(v_settle->>'refused_reason','unknown')
        USING ERRCODE='check_violation';
    END IF;
  END LOOP;

  IF v_paid > 0 THEN
    UPDATE public.tournaments
       SET bounty_pool_paid = round(
             COALESCE(bounty_pool_paid, 0) + (v_paid / 100.0), 2)
     WHERE id = v_a.tournament_id;
  END IF;

  UPDATE public.tournament_bounty_award_recipients
     SET paid_at=COALESCE(paid_at,now())
   WHERE award_id=p_award_id AND amount_cents=0;

  IF v_refused = 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_award_recipients
     WHERE award_id=p_award_id AND paid_at IS NULL
  ) THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'completed', paid_at = now()
     WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests
       SET status = 'paid'
     WHERE id = v_a.chest_id;
  ELSE
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES (
      'critical', 'fn_mystery_bounty_pay',
      'Mystery bounty award left incomplete: a recipient credit was refused',
      jsonb_build_object(
        'award_id', p_award_id,
        'tournament_id', v_a.tournament_id,
        'refused_recipients', v_refused,
        'paid_cents', v_paid,
        'award_cents', v_a.amount_cents,
        'refused_reason', v_settle->>'refused_reason',
        'detail', 'the award is NOT marked completed and the chest is NOT marked paid, so it stays retryable'));
  END IF;

  IF v_a.bounty_obligation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.id=v_a.bounty_obligation_id AND o.state='settled'
       AND public.fn_bounty_obligation_has_complete_marker(o.id)
  ) THEN
    RAISE EXCEPTION
      'mystery award % completed without its exact settled marker',p_award_id
      USING ERRCODE='check_violation';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'already', false, 'award_id', p_award_id,
    'amount_cents', v_a.amount_cents, 'paid_cents', v_paid,
    'refused_recipients', v_refused,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', user_id, 'amount_cents', amount_cents))
        FROM public.tournament_bounty_award_recipients
       WHERE award_id = p_award_id), '[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reserve(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_recipients jsonb,
  p_table_id uuid,
  p_hand_id text,
  p_op_id uuid,
  p_reveal_ms integer DEFAULT 20000
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_recipients jsonb;
  v_result jsonb;
  v_op_hex text;
  v_op_id uuid;
  v_prior_context text;
  v_stage text;
  v_existing record;
  v_chest record;
  v_award_id uuid;
  v_revealer uuid;
  v_idx integer;
  v_total integer;
  v_n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  SELECT * INTO o FROM public.tournament_bounty_obligations bo
   WHERE bo.tournament_id=p_tournament_id
     AND bo.eliminated_user_id=p_eliminated_user_id
     AND bo.mode='mystery_chest'
     AND bo.table_id=p_table_id AND bo.hand_id::text=p_hand_id
   ORDER BY bo.hand_number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_ready');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'user_id',e->>'user_id','weight',1,
           'is_designated_revealer',(e->>'user_id')::uuid=o.knocker_user_id)
           ORDER BY e->>'user_id')
    INTO v_recipients FROM jsonb_array_elements(o.claimants) e;
  v_op_hex := md5('mb:'||o.id::text);
  v_op_id := (substr(v_op_hex,1,8)||'-'||substr(v_op_hex,9,4)||'-4'||substr(v_op_hex,14,3)
    ||'-8'||substr(v_op_hex,18,3)||'-'||substr(v_op_hex,21,12))::uuid;
  v_prior_context := current_setting('app.bounty_obligation_id',true);
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);

  -- Inline the CSPRNG inventory reservation and exact-cent split. The
  -- generation-bound obligation remains the only source of recipient truth,
  -- while the rolling helper can be retired without breaking this root.
  <<mystery_reserve_core>>
  BEGIN
    IF p_eliminated_user_id IS NULL OR v_op_id IS NULL THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'missing_party');
      EXIT mystery_reserve_core;
    END IF;

    SELECT id, status, table_id
      INTO v_existing
      FROM public.tournament_bounty_awards
     WHERE op_id = v_op_id
        OR (
          tournament_id = p_tournament_id
          AND eliminated_user_id = p_eliminated_user_id
          AND (
            bounty_obligation_id = (
              SELECT pending.id
                FROM tournament_bounty_obligations pending
               WHERE pending.tournament_id=p_tournament_id
                 AND pending.eliminated_user_id=p_eliminated_user_id
                 AND pending.mode='mystery_chest'
                 AND pending.hand_id::text=p_hand_id
               ORDER BY pending.created_at DESC
               LIMIT 1)
            OR (bounty_obligation_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM tournament_bounty_obligations pending
               WHERE pending.tournament_id=p_tournament_id
                 AND pending.eliminated_user_id=p_eliminated_user_id
                 AND pending.mode='mystery_chest'
                 AND pending.hand_id::text=p_hand_id))))
     LIMIT 1;

    IF FOUND THEN
      SELECT count(*) INTO v_total
        FROM public.tournament_bounty_awards a
       WHERE a.tournament_id = p_tournament_id
         AND a.table_id IS NOT DISTINCT FROM v_existing.table_id
         AND a.status IN ('reserved','revealed');
      SELECT count(*) INTO v_idx
        FROM public.tournament_bounty_awards a
       WHERE a.tournament_id = p_tournament_id
         AND a.table_id IS NOT DISTINCT FROM v_existing.table_id
         AND a.status IN ('reserved','revealed')
         AND a.reserved_at <= (
           SELECT reserved_at FROM public.tournament_bounty_awards
            WHERE id = v_existing.id);
      SELECT user_id INTO v_revealer
        FROM public.tournament_bounty_award_recipients
       WHERE award_id = v_existing.id
         AND is_designated_revealer
       LIMIT 1;
      v_result := jsonb_build_object(
        'ok', true, 'already', true, 'award_id', v_existing.id,
        'status', v_existing.status,
        'queue_index', GREATEST(v_idx, 1),
        'queue_total', GREATEST(v_total, 1),
        'designated_revealer', v_revealer,
        'recipient_user_ids', COALESCE((
          SELECT jsonb_agg(user_id)
            FROM public.tournament_bounty_award_recipients
           WHERE award_id = v_existing.id), '[]'::jsonb));
      EXIT mystery_reserve_core;
    END IF;

    SELECT mystery_bounty_stage INTO v_stage
      FROM public.tournaments
     WHERE id = p_tournament_id;
    IF v_stage IS DISTINCT FROM 'active' THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'mystery_phase_not_active', 'stage', v_stage);
      EXIT mystery_reserve_core;
    END IF;

    IF v_recipients IS NULL OR jsonb_typeof(v_recipients) <> 'array'
       OR jsonb_array_length(v_recipients) = 0 THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'no_recipients');
      EXIT mystery_reserve_core;
    END IF;

    UPDATE public.tournament_bounty_chests
       SET status = 'reserved'
     WHERE id = (
       SELECT id FROM public.tournament_bounty_chests
        WHERE tournament_id = p_tournament_id
          AND status = 'available'
        ORDER BY seq
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
    RETURNING id, tier, amount_cents INTO v_chest;

    IF NOT FOUND THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'inventory_exhausted');
      EXIT mystery_reserve_core;
    END IF;

    INSERT INTO public.tournament_bounty_awards
      (tournament_id, chest_id, table_id, hand_id, eliminated_user_id,
       amount_cents, tier, status, op_id, reveal_deadline_at)
    VALUES
      (p_tournament_id, v_chest.id, p_table_id, p_hand_id,
       p_eliminated_user_id, v_chest.amount_cents, v_chest.tier,
       'reserved', v_op_id,
       now() + make_interval(
         secs => GREATEST(1, COALESCE(p_reveal_ms, 20000)) / 1000.0))
    RETURNING id INTO v_award_id;

    UPDATE public.tournament_bounty_chests
       SET award_id = v_award_id
     WHERE id = v_chest.id;

    WITH raw AS (
      SELECT (r->>'user_id')::uuid AS user_id,
             GREATEST(0, COALESCE((r->>'weight')::numeric, 0)) AS weight,
             COALESCE(
               (r->>'is_designated_revealer')::boolean, false) AS flagged
        FROM jsonb_array_elements(v_recipients) r
       WHERE (r->>'user_id') IS NOT NULL
    ),
    dedup AS (
      SELECT user_id, sum(weight) AS weight, bool_or(flagged) AS flagged
        FROM raw
       GROUP BY user_id
    ),
    norm AS (
      SELECT user_id,
             CASE WHEN (SELECT sum(weight) FROM dedup) > 0
                  THEN weight ELSE 1 END AS weight,
             flagged
        FROM dedup
    ),
    alloc AS (
      SELECT n.user_id, n.weight,
             floor(v_chest.amount_cents * n.weight / t.w)::bigint AS fl,
             (v_chest.amount_cents * n.weight / t.w)
               - floor(v_chest.amount_cents * n.weight / t.w) AS frac
        FROM norm n
        CROSS JOIN (SELECT sum(weight) AS w FROM norm) t
    ),
    ranked AS (
      SELECT a.*,
             row_number() OVER (
               ORDER BY a.frac DESC, a.weight DESC, a.user_id) AS rn,
             (SELECT v_chest.amount_cents - COALESCE(sum(fl), 0)
                FROM alloc) AS leftover
        FROM alloc a
    )
    INSERT INTO public.tournament_bounty_award_recipients
      (award_id, user_id, amount_cents, is_designated_revealer)
    SELECT v_award_id, user_id,
           fl + CASE WHEN rn <= leftover THEN 1 ELSE 0 END,
           false
      FROM ranked
    ON CONFLICT (award_id, user_id) DO NOTHING;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'no_recipients');
      EXIT mystery_reserve_core;
    END IF;

    SELECT user_id INTO v_revealer
      FROM (
        SELECT (r->>'user_id')::uuid AS user_id,
               GREATEST(0, COALESCE((r->>'weight')::numeric, 0)) AS weight,
               COALESCE(
                 (r->>'is_designated_revealer')::boolean, false) AS flagged
          FROM jsonb_array_elements(v_recipients) r
         WHERE (r->>'user_id') IS NOT NULL
      ) q
     ORDER BY q.flagged DESC, q.weight DESC, q.user_id
     LIMIT 1;

    UPDATE public.tournament_bounty_award_recipients
       SET is_designated_revealer = (user_id = v_revealer)
     WHERE award_id = v_award_id;

    PERFORM 1 FROM public.tournament_bounty_award_recipients
     WHERE award_id = v_award_id
    HAVING sum(amount_cents) = v_chest.amount_cents;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'mystery bounty split lost money on award %', v_award_id;
    END IF;

    SELECT count(*) INTO v_total
      FROM public.tournament_bounty_awards a
     WHERE a.tournament_id = p_tournament_id
       AND a.table_id IS NOT DISTINCT FROM p_table_id
       AND a.status IN ('reserved','revealed');
    v_idx := v_total;

    v_result := jsonb_build_object(
      'ok', true, 'already', false, 'award_id', v_award_id,
      'queue_index', GREATEST(v_idx, 1),
      'queue_total', GREATEST(v_total, 1),
      'designated_revealer', v_revealer,
      'reveal_deadline_ms', GREATEST(1, COALESCE(p_reveal_ms, 20000)),
      'recipient_user_ids', COALESCE((
        SELECT jsonb_agg(user_id)
          FROM public.tournament_bounty_award_recipients
         WHERE award_id = v_award_id), '[]'::jsonb));
  END mystery_reserve_core;

  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);
  IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN RETURN v_result; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_awards a
     WHERE a.id=(v_result->>'award_id')::uuid AND a.bounty_obligation_id=o.id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(o.claimants) c
          WHERE NOT EXISTS (SELECT 1 FROM public.tournament_bounty_award_recipients r
                             WHERE r.award_id=a.id
                               AND r.user_id=(c->>'user_id')::uuid)
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_award_recipients r
          WHERE r.award_id=a.id
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(o.claimants) c
                             WHERE (c->>'user_id')::uuid=r.user_id)
       )
  ) THEN
    RAISE EXCEPTION 'mystery award recipients do not match obligation %',o.id;
  END IF;
  RETURN v_result || jsonb_build_object('obligation_id',o.id,'recipients_verified',true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer) TO service_role;

-- The parent write barrier acquired before the first tables DDL is still held.
-- A timestamp cannot classify a transaction that began before this migration
-- and committed while DDL waited. Identity captured behind that one barrier
-- makes every later COMPLETED row receipt-required without clock inference.

CREATE TABLE public.tournament_terminal_settlement_cutover (
  authority                         text PRIMARY KEY
    CHECK (authority = 'fn_complete_tournament_terminal:v1'),
  migration_version                 text NOT NULL
    CHECK (migration_version = '20260909014534'),
  installed_at                      timestamptz NOT NULL,
  preexisting_completed_ids         uuid[] NOT NULL,
  CHECK (array_position(preexisting_completed_ids, NULL) IS NULL)
);

ALTER TABLE public.tournament_terminal_settlement_cutover
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_terminal_settlement_cutover
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.tournament_terminal_settlement_cutover
  (authority, migration_version, installed_at,
   preexisting_completed_ids)
SELECT 'fn_complete_tournament_terminal:v1', '20260909014534',
       clock_timestamp(), ARRAY(
         SELECT t.id
           FROM public.tournaments t
          WHERE upper(COALESCE(t.status::text, '')) = 'COMPLETED'
            AND NOT (
                 lower(COALESCE(t.variant::text, '')) = 'satellite'
              OR upper(COALESCE(t.tournament_type::text, '')) = 'SATELLITE'
              OR t.satellite_target_id IS NOT NULL
              OR t.satellite_target IS NOT NULL)
          ORDER BY t.id
       );

COMMENT ON TABLE public.tournament_terminal_settlement_cutover IS
  'Owner-only terminal cutover watermark captured behind a tournament write barrier. Every completed non-satellite outside the immutable preexisting inventory must carry an exact terminal receipt.';

CREATE TABLE public.tournament_terminal_settlements (
  tournament_id          uuid PRIMARY KEY
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  winner_id              uuid NOT NULL,
  settlement_mode        text NOT NULL
    CHECK (settlement_mode IN ('places','final_table_deal')),
  started_status         text NOT NULL
    CHECK (started_status IN ('RUNNING','COMPLETING')),
  prize_pool             numeric(15,2) NOT NULL
    CHECK (prize_pool >= 0 AND prize_pool = round(prize_pool, 2)),
  bounty_pool            numeric(15,2) NOT NULL
    CHECK (bounty_pool >= 0 AND bounty_pool = round(bounty_pool, 2)),
  cash_payout_count      integer NOT NULL CHECK (cash_payout_count >= 0),
  cash_payout_total      numeric(15,2) NOT NULL
    CHECK (cash_payout_total >= 0 AND cash_payout_total = round(cash_payout_total, 2)),
  bounty_payout_total    numeric(15,2) NOT NULL
    CHECK (bounty_payout_total >= 0 AND bounty_payout_total = round(bounty_payout_total, 2)),
  mystery_was_active     boolean NOT NULL,
  mystery_pool_cents     bigint NOT NULL CHECK (mystery_pool_cents >= 0),
  cash_receipt           jsonb NOT NULL CHECK (jsonb_typeof(cash_receipt) = 'object'),
  mystery_receipt        jsonb NOT NULL CHECK (jsonb_typeof(mystery_receipt) = 'object'),
  bounty_receipt         jsonb NOT NULL CHECK (jsonb_typeof(bounty_receipt) = 'object'),
  closed_table_count     integer NOT NULL CHECK (closed_table_count >= 0),
  closed_table_ids       uuid[] NOT NULL,
  source_seat_count      integer NOT NULL CHECK (source_seat_count >= 0),
  source_seat_ids        uuid[] NOT NULL,
  released_seat_count    integer NOT NULL CHECK (released_seat_count >= 0),
  released_seat_ids      uuid[] NOT NULL,
  rake_amount            numeric(15,2) NOT NULL
    CHECK (rake_amount >= 0 AND rake_amount = round(rake_amount, 2)),
  rake_destination       text NOT NULL CHECK (length(btrim(rake_destination)) > 0),
  rake_settled_at        timestamptz NOT NULL,
  rake_attributed_at     timestamptz NOT NULL,
  rake_attributed_users  integer NOT NULL CHECK (rake_attributed_users >= 0),
  escrow_closed_at       timestamptz NOT NULL,
  escrow_close_note      text NOT NULL CHECK (length(btrim(escrow_close_note)) > 0),
  completed_at           timestamptz NOT NULL,
  settled_at             timestamptz NOT NULL DEFAULT transaction_timestamp(),
  receipt_version        integer NOT NULL DEFAULT 1 CHECK (receipt_version = 1),
  CHECK (cash_payout_total = prize_pool),
  CHECK (bounty_payout_total = bounty_pool),
  CHECK ((mystery_was_active AND mystery_pool_cents > 0)
      OR (NOT mystery_was_active AND mystery_pool_cents = 0)),
  CHECK (closed_table_count = cardinality(closed_table_ids)),
  CHECK (source_seat_count = cardinality(source_seat_ids)),
  CHECK (released_seat_count = cardinality(released_seat_ids)),
  CHECK (array_position(closed_table_ids, NULL) IS NULL),
  CHECK (array_position(source_seat_ids, NULL) IS NULL),
  CHECK (array_position(released_seat_ids, NULL) IS NULL),
  CHECK (released_seat_ids <@ source_seat_ids),
  CHECK (rake_settled_at <= settled_at AND rake_attributed_at <= settled_at),
  CHECK (escrow_closed_at <= settled_at),
  CHECK (completed_at <= settled_at)
);

ALTER TABLE public.tournament_terminal_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_terminal_settlements
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.tournament_terminal_settlements IS
  'Immutable all-or-nothing non-satellite completion receipt: exact cash authority result, bounty close, durable attributed rake, released seats, closed tables and completed lifecycle state.';

CREATE OR REPLACE FUNCTION public.fn_tournament_terminal_receipts_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $terminal_receipts_append_only$
BEGIN
  RAISE EXCEPTION
    'tournament terminal settlement evidence is immutable; % is refused for tournament %',
    TG_OP, OLD.tournament_id USING ERRCODE = 'restrict_violation';
END;
$terminal_receipts_append_only$;

REVOKE ALL ON FUNCTION public.fn_tournament_terminal_receipts_are_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_terminal_settlements_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_terminal_settlements
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_terminal_receipts_are_append_only();

-- A plain parent/receipt lookup in a row trigger is not enough after a writer
-- has waited for a child tuple: READ COMMITTED keeps the command snapshot that
-- existed before the wait. Give every mutable receipt-owned child its own
-- one-way marker instead. These nullable, no-default columns are an expand-only
-- catalog change; existing rows are neither rewritten nor guessed. A
-- synchronous parent-status trigger stamps every child in the same transaction
-- as COMPLETED/CANCELLED. A queued UPDATE/DELETE then resumes on the newest
-- tuple version and sees OLD.terminal_closed_at without consulting a stale
-- snapshot.
ALTER TABLE public.tournament_players
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_obligations
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_payouts
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_rake_settlements
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.rake_records
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_bounty_chests
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_bounty_awards
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_guarantee_overlays
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.table_seats
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.wallet_transactions
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_bounty_award_recipients
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.tournament_escrow
  ADD COLUMN terminal_closed_at timestamptz;
ALTER TABLE public.spin_reserve_ledger
  ADD COLUMN terminal_closed_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_ca_terminal_marker_transition_is_exact(
  p_old jsonb,
  p_new jsonb,
  p_tournament_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_marker_transition$
  SELECT COALESCE(
    p_old ? 'terminal_closed_at'
    AND p_new ? 'terminal_closed_at'
    AND NULLIF(p_old->>'terminal_closed_at','') IS NULL
    AND NULLIF(p_new->>'terminal_closed_at','') IS NOT NULL
    AND (p_new - 'terminal_closed_at') IS NOT DISTINCT FROM
        (p_old - 'terminal_closed_at')
    AND EXISTS (
      SELECT 1
        FROM public.tournaments t
       WHERE t.id = p_tournament_id
         AND upper(COALESCE(t.status::text,'')) IN
             ('COMPLETED','CANCELLED','CANCELED')
         AND t.ended_at IS NOT NULL
         AND isfinite(t.ended_at)
         AND NULLIF(p_new->>'terminal_closed_at','')::timestamptz
               IS NOT DISTINCT FROM t.ended_at
    ),false)
$terminal_marker_transition$;

REVOKE ALL ON FUNCTION public.fn_ca_terminal_marker_transition_is_exact(
  jsonb,jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Payout money is still append-only. The one permitted UPDATE is the
-- synchronous null -> canonical terminal marker transition performed by the
-- tournament status trigger while the terminal authority owns its global
-- transaction lock. Requiring nested trigger depth prevents a caller that
-- merely takes the advisory lock from updating payout evidence directly; the
-- jsonb comparison proves every payout identity and money field is unchanged.
CREATE OR REPLACE FUNCTION public.fn_tournament_payouts_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $tournament_payout_append_only$
DECLARE
  v_terminal_key bigint := hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_terminal_root boolean := false;
BEGIN
  IF session_user = 'postgres'
     AND COALESCE(current_setting('app.payout_record_correction', true), '') =
         'i_am_correcting_the_record' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 THEN
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid = pg_backend_pid()
         AND l.locktype = 'advisory'
         AND l.database = (
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname = current_database())
         AND l.classid = (((v_terminal_key >> 32) & 4294967295)::oid)
         AND l.objid = ((v_terminal_key & 4294967295)::oid)
         AND l.objsubid = 1
         AND l.mode = 'ExclusiveLock'
         AND l.granted)
      INTO v_owns_terminal_root;

    IF v_owns_terminal_root
       AND public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),OLD.tournament_id) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'tournament_payouts is an append-only payout record; % is refused (tournament %, user %, position %)',
    TG_OP, OLD.tournament_id, OLD.user_id, OLD."position"
    USING ERRCODE = 'restrict_violation',
          HINT = 'A DBA correcting a bad row must SET LOCAL app.payout_record_correction = ''i_am_correcting_the_record'' in the same transaction, from a migration that says why.';
END;
$tournament_payout_append_only$;

-- A terminal receipt is not immutable if a service caller can append a new
-- payout, obligation, roster row or other tournament-owned evidence after the
-- close. INSERT takes a parent share lock before creating a row. Unlike key
-- share, this conflicts with terminal's non-key status change. The insert either
-- commits before terminal owns the tournament, so the terminal verifier sees
-- it, or waits behind terminal and is refused. UPDATE and DELETE never take a
-- child-to-parent lock. Their row-owned marker is the race-free terminal fact;
-- the parent/receipt read remains only the compatibility fence for terminal
-- receipts committed before these marker columns existed.
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_evidence_guard$
DECLARE
  v_tournament_id uuid;
  v_status text;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_tournament_id := NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid IS DISTINCT FROM
       NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid THEN
      RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  ELSE
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;

  IF v_tournament_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND to_jsonb(OLD) ? 'terminal_closed_at' THEN
    v_old_marker := NULLIF(to_jsonb(OLD)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP <> 'DELETE' AND to_jsonb(NEW) ? 'terminal_closed_at' THEN
    v_new_marker := NULLIF(to_jsonb(NEW)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION '% rows cannot supply a terminal marker',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% terminal marker transition is not canonical',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  -- A journal row is durable testimony from the instant it names a
  -- tournament. Refuse its UPDATE/DELETE without taking a child-to-parent
  -- lock; a row trigger already owns the child tuple at this point. INSERT is
  -- the only operation that takes the root lock, which preserves the
  -- parent-to-child order used by both terminal authorities.
  IF TG_TABLE_NAME = 'chip_ledger' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = v_tournament_id)
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION
      'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_evidence_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DO $install_terminal_evidence_guards$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'tournament_players',
    'tournament_obligations',
    'tournament_payouts',
    'chip_ledger',
    'tournament_rake_settlements',
    'rake_records',
    'tournament_bounty_chests',
    'tournament_bounty_awards',
    'tournament_guarantee_overlays',
    'tournament_satellite_awards',
    'tournament_satellite_remainders',
    'tournament_refund_entitlements',
    'tournament_refund_tranches',
    'spin_reserve_ledger',
    'tournament_spin_cancellation_unwinds'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS terminal_tournament_evidence_is_immutable ON public.%I',
      v_table);
    EXECUTE format(
      'CREATE TRIGGER terminal_tournament_evidence_is_immutable '
      || 'BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW '
      || 'EXECUTE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()',
      v_table);
  END LOOP;
END;
$install_terminal_evidence_guards$;

-- A seat has no tournament_id of its own, so bind it through its table. New
-- membership locks the parent first and cannot cross a terminal boundary.
-- Existing rows are already frozen by terminal's source-seat prelock; after a
-- waiter resumes, any mutation or deletion of a terminal seat is refused.
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_seat_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_seat_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_status text;
  v_marker timestamptz;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id = OLD.table_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id = NEW.table_id;
  END IF;
  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament seat % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'seat % terminal marker transition is not canonical',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id
     FOR SHARE;
    SELECT tb.terminal_closed_at INTO v_marker
      FROM public.tables tb
     WHERE tb.id = NEW.table_id
       AND tb.tournament_id = v_new_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')),tb.terminal_closed_at
      INTO v_status,v_marker
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_seat_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_tournament_seat_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_tournament_seat_is_immutable ON public.table_seats;
CREATE TRIGGER terminal_tournament_seat_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_terminal_tournament_seat_is_immutable();

-- The parent tuple is its own race-free lifecycle fact. Once OLD is terminal,
-- reject before any receipt lookup: a writer queued before terminal commit
-- resumes with the newest OLD tuple even though its statement snapshot cannot
-- see the just-committed receipt. The initial live -> terminal transition is
-- allowed because OLD is not terminal; the deferred verifier still requires
-- one exact receipt before that transaction can commit.
CREATE OR REPLACE FUNCTION public.fn_receipted_tournament_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $receipted_tournament_guard$
BEGIN
  IF upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED') THEN
    RAISE EXCEPTION 'terminal tournament % is immutable after closure',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$receipted_tournament_guard$;

REVOKE ALL ON FUNCTION public.fn_receipted_tournament_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS receipted_tournament_is_immutable ON public.tournaments;
CREATE TRIGGER receipted_tournament_is_immutable
  BEFORE DELETE OR UPDATE OF status,variant,tournament_type,
    satellite_target_id,satellite_target,satellite_seats,
    prize_pool,prize_pool_finalized,bounty_pool,bounty_pool_paid,
    is_bounty,is_pko,is_mystery_bounty,mystery_bounty_stage,
    mystery_bounty_pool_cents,club_id,ended_at,current_players,on_break,
    break_started_at,break_ends_at
  ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_receipted_tournament_is_immutable();

CREATE OR REPLACE FUNCTION public.fn_ca_has_committed_tournament_receipt(
  p_tournament_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $has_terminal_receipt$
  SELECT COALESCE((
    SELECT (upper(COALESCE(t.status::text,'')) = 'COMPLETED'
       AND (EXISTS (
              SELECT 1 FROM public.tournament_terminal_settlements h
               WHERE h.tournament_id = t.id)
         OR EXISTS (
              SELECT 1 FROM public.tournament_satellite_settlements h
               WHERE h.tournament_id = t.id)))
       OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
       AND EXISTS (
              SELECT 1 FROM public.tournament_cancellation_receipts h
               WHERE h.tournament_id = t.id))
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
  ),false)
$has_terminal_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_has_committed_tournament_receipt(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Recipient rows do not carry tournament_id. Bind them through their award so
-- a completed mystery receipt cannot later gain, lose or rewrite a payee.
CREATE OR REPLACE FUNCTION public.fn_terminal_bounty_recipient_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_bounty_recipient_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.award_id IS DISTINCT FROM OLD.award_id THEN
    RAISE EXCEPTION 'bounty recipient award ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT a.tournament_id INTO v_old_tournament_id
      FROM public.tournament_bounty_awards a WHERE a.id = OLD.award_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.tournament_id INTO v_new_tournament_id
      FROM public.tournament_bounty_awards a WHERE a.id = NEW.award_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new bounty recipient cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal bounty recipient evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'bounty recipient terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal bounty recipient evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal bounty recipient evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_bounty_recipient_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_bounty_recipient_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_bounty_recipient_is_immutable
  ON public.tournament_bounty_award_recipients;
CREATE TRIGGER terminal_bounty_recipient_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.tournament_bounty_award_recipients
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_terminal_bounty_recipient_is_immutable();

-- Bounty receipt verification reads wallet_transactions by related_entity_id.
-- Evaluate OLD and NEW ownership so a privileged update cannot move a row
-- into or out of a completed receipt after the close.
CREATE OR REPLACE FUNCTION public.fn_terminal_wallet_transaction_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_wallet_transaction_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.related_entity_id IS DISTINCT FROM OLD.related_entity_id THEN
    RAISE EXCEPTION 'wallet transaction ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT t.id INTO v_old_tournament_id FROM public.tournaments t
     WHERE t.id = OLD.related_entity_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.id INTO v_new_tournament_id FROM public.tournaments t
     WHERE t.id = NEW.related_entity_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new wallet transaction cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'wallet transaction terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_wallet_transaction_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_wallet_transaction_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_wallet_transaction_is_immutable
  ON public.wallet_transactions;
CREATE TRIGGER terminal_wallet_transaction_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_terminal_wallet_transaction_is_immutable();

-- Credit keys are polymorphic text. Resolve only the three tournament receipt
-- namespaces and freeze both sides of an UPDATE. Unrelated wallet keys retain
-- their existing lifecycle.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_id_from_credit_key(p_key text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $tournament_from_credit_key$
DECLARE
  v_id_text text;
  v_id uuid;
BEGIN
  IF p_key LIKE 'tourney:%' OR p_key LIKE 'mb-residual:%' THEN
    v_id_text := split_part(p_key,':',2);
    IF v_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN v_id_text::uuid;
    END IF;
  ELSIF p_key LIKE 'mb:%' THEN
    v_id_text := split_part(p_key,':',2);
    IF v_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT a.tournament_id INTO v_id
        FROM public.tournament_bounty_awards a WHERE a.id = v_id_text::uuid;
      RETURN v_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$tournament_from_credit_key$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_id_from_credit_key(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_terminal_credit_key_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_credit_key_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_new_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'wallet credit idempotency keys are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_old_tournament_id := public.fn_ca_tournament_id_from_credit_key(OLD.key);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_tournament_id := public.fn_ca_tournament_id_from_credit_key(NEW.key);
  END IF;
  -- Recognized payout claims are append-only financial evidence. An existing
  -- row is already locked before this row trigger runs, so UPDATE/DELETE must
  -- refuse immediately instead of reversing the terminal root lock order.
  IF TG_OP <> 'INSERT'
     AND COALESCE(v_old_tournament_id,v_new_tournament_id) IS NOT NULL THEN
    RAISE EXCEPTION 'tournament wallet credit claims are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal wallet credit key evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_new_tournament_id IS NOT NULL
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal wallet credit key evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_credit_key_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_credit_key_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_credit_key_is_immutable
  ON public.wallet_credit_idempotency;
CREATE TRIGGER terminal_credit_key_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.wallet_credit_idempotency
  FOR EACH ROW EXECUTE FUNCTION public.fn_terminal_credit_key_is_immutable();

-- Both atomic completion authorities have already stamped exact-zero escrow
-- before lifecycle. The old after-status observer would rewrite that proof,
-- so detach it now and freeze the source bank once its receipt is committed.
DROP TRIGGER IF EXISTS zz_ca_escrow_close ON public.tournaments;

CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_escrow_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_escrow_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'tournament escrow ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament escrow cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tournament escrow terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$terminal_escrow_guard$;

REVOKE ALL ON FUNCTION public.fn_terminal_tournament_escrow_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS terminal_tournament_escrow_is_immutable
  ON public.tournament_escrow;
CREATE TRIGGER terminal_tournament_escrow_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_escrow
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_terminal_tournament_escrow_is_immutable();

-- This is a synchronous ownership transition, not a watcher or reconciler.
-- It runs inside the one status-changing transaction after the parent row is
-- terminal and stamps every mutable row that a terminal receipt will verify.
-- Tables use their pre-existing terminal_closed_at invariant and are closed by
-- each authority immediately after the parent transition. Append-only journal,
-- idempotency, refund, satellite and original Spin receipt rows need no marker
-- because their own guards already refuse every UPDATE/DELETE. Mutable Spin
-- cancellation reversal rows are stamped below; every INSERT guard still takes
-- the parent lock.
CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_terminal_evidence_markers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $stamp_terminal_evidence_markers$
DECLARE
  v_terminal_at timestamptz;
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) NOT IN
       ('COMPLETED','CANCELLED','CANCELED')
     OR (TG_OP = 'UPDATE' AND upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED')) THEN
    RETURN NEW;
  END IF;
  v_terminal_at := NEW.ended_at;
  IF v_terminal_at IS NULL OR NOT isfinite(v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % requires one finite close marker',NEW.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.tournament_players
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_obligations
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_payouts
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_rake_settlements
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.rake_records
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_chests
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_awards
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_guarantee_overlays
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.table_seats s
     SET terminal_closed_at = v_terminal_at
    FROM public.tables tb
   WHERE tb.id = s.table_id AND tb.tournament_id = NEW.id
     AND s.terminal_closed_at IS NULL;
  UPDATE public.wallet_transactions
     SET terminal_closed_at = v_terminal_at
   WHERE related_entity_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_award_recipients r
     SET terminal_closed_at = v_terminal_at
    FROM public.tournament_bounty_awards a
   WHERE a.id = r.award_id AND a.tournament_id = NEW.id
     AND r.terminal_closed_at IS NULL;
  UPDATE public.tournament_escrow
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  -- Contribution and jackpot-draw rows already have an unconditional
  -- append-only guard. Cancellation reversal/surplus rows intentionally do
  -- not, so give precisely those mutable Spin rows the terminal tuple marker.
  UPDATE public.spin_reserve_ledger
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id
     AND kind NOT IN ('contribution','jackpot_draw')
     AND terminal_closed_at IS NULL;

  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=NEW.id
                AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=NEW.id
          AND s.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=NEW.id
          AND r.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=NEW.id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % did not stamp every mutable evidence row',
      NEW.id USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$stamp_terminal_evidence_markers$;

REVOKE ALL ON FUNCTION public.fn_stamp_tournament_terminal_evidence_markers()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS stamp_tournament_terminal_evidence_markers
  ON public.tournaments;
CREATE TRIGGER stamp_tournament_terminal_evidence_markers
  AFTER INSERT OR UPDATE OF status ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_stamp_tournament_terminal_evidence_markers();

-- A delivered target registration remains live gameplay state, so chips and
-- status may continue changing. Its identity and satellite provenance cannot.
-- New provenance rows and target fee evidence tied to a completed source are
-- also refused, while writes during the source's COMPLETING transaction pass.
CREATE OR REPLACE FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_target_player_guard$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_status text;
  v_acquisition_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_acquisition_root boolean:=false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.is_satellite_qualifier IS DISTINCT FROM OLD.is_satellite_qualifier
       OR NEW.source_satellite_id IS DISTINCT FROM OLD.source_satellite_id) THEN
    RAISE EXCEPTION 'tournament player ownership and entry provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,OLD.source_satellite_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,NEW.source_satellite_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = OLD.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = NEW.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    -- The rolling satellite authority owns target before source. Take both
    -- roots in that same order so a direct provenance insert cannot invert
    -- the pair across its specialized and generic guards.
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite provenance'
        USING ERRCODE = '55000';
    END IF;
    -- A satellite winner may use a returned tournament-entry ticket only
    -- after its source satellite has completed. That is a legitimate NEW
    -- provenance row, but only inside the canonical registration root that
    -- acquired the terminal-global lock before touching any child row. A raw
    -- insert has no such lock and remains refused.
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid=pg_backend_pid()
         AND l.locktype='advisory'
         AND l.database=(
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname=current_database())
         AND l.classid=(((v_acquisition_key>>32)&4294967295)::oid)
         AND l.objid=((v_acquisition_key&4294967295)::oid)
         AND l.objsubid=1
         AND l.mode='ExclusiveLock'
         AND l.granted)
      INTO v_owns_acquisition_root;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOREACH v_source_id IN ARRAY v_source_ids LOOP
      IF v_source_id IS DISTINCT FROM NEW.tournament_id THEN
        SELECT upper(COALESCE(t.status::text,'')) INTO v_status
          FROM public.tournaments t
         WHERE t.id = v_source_id FOR SHARE;
        IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
           AND NOT COALESCE(v_owns_acquisition_root,false) THEN
          RAISE EXCEPTION 'completed satellite target provenance is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NOT (TG_OP='INSERT' AND COALESCE(v_owns_acquisition_root,false))
     AND EXISTS (
    SELECT 1 FROM unnest(v_source_ids) source(id)
     WHERE public.fn_ca_has_committed_tournament_receipt(source.id)
  ) THEN
    RAISE EXCEPTION 'completed satellite target provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$satellite_target_player_guard$;

REVOKE ALL ON FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS satellite_target_player_provenance_is_immutable
  ON public.tournament_players;
CREATE TRIGGER satellite_target_player_provenance_is_immutable
  BEFORE INSERT OR DELETE OR UPDATE OF id,tournament_id,user_id,
    is_satellite_qualifier,source_satellite_id
  ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_satellite_target_player_provenance_is_immutable();

CREATE OR REPLACE FUNCTION public.fn_satellite_target_rake_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_target_rake_guard$
DECLARE
  v_old_source_id uuid;
  v_new_source_id uuid;
  v_text text;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_text := OLD.metadata->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_old_source_id := v_text::uuid;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_text := NEW.metadata->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_new_source_id := v_text::uuid;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.metadata->>'satellite_id') IS DISTINCT FROM
         (OLD.metadata->>'satellite_id') THEN
    RAISE EXCEPTION 'satellite target rake ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker
     AND public.fn_ca_terminal_marker_transition_is_exact(
           to_jsonb(OLD),to_jsonb(NEW),OLD.tournament_id) THEN
    RETURN NEW;
  END IF;
  -- A recognized satellite fee row is append-only. Refusing an already-locked
  -- UPDATE/DELETE before any parent lookup removes the child-to-source lock
  -- edge. INSERT locks the target first, then the source, matching the
  -- canonical satellite authority.
  IF TG_OP <> 'INSERT'
     AND COALESCE(v_old_source_id,v_new_source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'satellite target rake rows are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite rake evidence'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_source_id IS NOT NULL
     AND v_new_source_id IS DISTINCT FROM NEW.tournament_id THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_source_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'completed satellite target rake evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_new_source_id IS NOT NULL
     AND v_new_source_id IS DISTINCT FROM v_old_source_id THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id = v_new_source_id FOR SHARE;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_source_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_source_id) THEN
    RAISE EXCEPTION 'completed satellite target rake evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$satellite_target_rake_guard$;

REVOKE ALL ON FUNCTION public.fn_satellite_target_rake_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS satellite_target_rake_is_immutable
  ON public.rake_records;
CREATE TRIGGER satellite_target_rake_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.rake_records
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_target_rake_is_immutable();

-- The seat transfer journal is queried by source liability and key, not only
-- by chip_ledger.tournament_id. Resolve every ownership witness and take the
-- source root lock on every operation. Terminal completion never waits on a
-- journal row, so a concurrent maintenance rewrite safely waits and is then
-- refused instead of slipping in after receipt verification.
CREATE OR REPLACE FUNCTION public.fn_satellite_transfer_ledger_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_transfer_ledger_guard$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_target_id uuid;
  v_text text;
  v_row jsonb;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.from_entity_id IS DISTINCT FROM OLD.from_entity_id
       OR NEW.to_entity_id IS DISTINCT FROM OLD.to_entity_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR (NEW.metadata->>'satellite_id') IS DISTINCT FROM
          (OLD.metadata->>'satellite_id')) THEN
    RAISE EXCEPTION 'satellite transfer journal ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_row IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  ] LOOP
    IF v_row IS NULL THEN CONTINUE; END IF;
    v_text := v_row->>'tournament_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    IF v_row->>'from_type' = 'prize_liability' THEN
      v_text := v_row->>'from_entity_id';
      IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_source_ids := array_append(v_source_ids,v_text::uuid);
      END IF;
    END IF;
    v_text := split_part(COALESCE(v_row->>'idempotency_key',''),':',2);
    IF COALESCE(v_row->>'idempotency_key','') LIKE 'tourney:%:seat:%:pool_transfer'
       AND v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    v_text := v_row->'metadata'->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
  END LOOP;
  IF TG_OP <> 'INSERT' AND cardinality(v_source_ids) > 0 THEN
    RAISE EXCEPTION 'satellite transfer journal is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.to_type = 'prize_liability' THEN
    SELECT t.id INTO v_target_id FROM public.tournaments t
     WHERE t.id = NEW.to_entity_id;
    IF v_target_id IS NOT NULL THEN
      -- The transfer's AFTER trigger writes target escrow, so own the target
      -- before any source root exactly as fn_settle_satellite_tournament does.
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_target_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'terminal target cannot accept a satellite transfer journal'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  FOR v_source_id IN
    SELECT DISTINCT source.id FROM unnest(v_source_ids) source(id)
     WHERE source.id IS NOT NULL ORDER BY source.id
  LOOP
    IF TG_OP = 'INSERT' AND v_source_id IS DISTINCT FROM v_target_id THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_source_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'completed satellite transfer journal is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF public.fn_ca_has_committed_tournament_receipt(v_source_id) THEN
      RAISE EXCEPTION 'completed satellite transfer journal is immutable'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$satellite_transfer_ledger_guard$;

REVOKE ALL ON FUNCTION public.fn_satellite_transfer_ledger_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS satellite_transfer_ledger_is_immutable
  ON public.chip_ledger;
CREATE TRIGGER satellite_transfer_ledger_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_satellite_transfer_ledger_is_immutable();

-- Mystery payouts crossed the obligation cutover while long-running events
-- were still live. Credits before 2026-09-02 are proved by their immutable
-- `mb:<award>:<recipient>` / `mb-residual:<event>` wallet keys; newer credits
-- are proved by the cumulative mystery obligation and every immutable key that
-- made up that obligation. This owner-only helper proves the two eras as one
-- exact partition. It never backfills or guesses. Both first completion and
-- receipt replay call this same body, so compatibility cannot be looser on the
-- first pass than it is forever after.
CREATE OR REPLACE FUNCTION public.fn_ca_mystery_bounty_completion_evidence(
  p_tournament_id uuid,
  p_winner_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $mystery_completion_evidence$
DECLARE
  v_t record;
  v_inventory_cents bigint;
  v_completed_award_cents bigint;
  v_void_chest_cents bigint;
  v_legacy_award_cents bigint;
  v_legacy_residual_cents bigint;
  v_legacy_residual_amount numeric;
  v_legacy_credit_cents bigint;
  v_obligation_cents bigint;
  v_evidence_mode text;
BEGIN
  IF p_tournament_id IS NULL OR p_winner_user_id IS NULL THEN
    RAISE EXCEPTION 'mystery completion evidence requires tournament and winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.id,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND
     OR COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
     OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
     OR COALESCE(v_t.mystery_bounty_pool_cents,0) <= 0 THEN
    RAISE EXCEPTION 'tournament % has no complete funded mystery inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_winner_user_id
  ) THEN
    RAISE EXCEPTION 'mystery completion winner % is not in tournament %',
      p_winner_user_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(sum(c.amount_cents),0),
         COALESCE(sum(c.amount_cents) FILTER (WHERE c.status = 'void'),0)
    INTO v_inventory_cents,v_void_chest_cents
    FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = p_tournament_id;
  SELECT COALESCE(sum(a.amount_cents) FILTER (
           WHERE a.status = 'completed'),0)
    INTO v_completed_award_cents
    FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id;

  IF v_inventory_cents IS DISTINCT FROM v_t.mystery_bounty_pool_cents
     OR v_completed_award_cents + v_void_chest_cents
          IS DISTINCT FROM v_t.mystery_bounty_pool_cents
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_chests c
        WHERE c.tournament_id = p_tournament_id
          AND (c.amount_cents <= 0 OR c.status NOT IN ('paid','void')
            OR (c.status = 'paid' AND (c.award_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_awards a
               WHERE a.id = c.award_id
                 AND a.tournament_id = p_tournament_id
                 AND a.chest_id = c.id
                 AND a.amount_cents = c.amount_cents
                 AND a.status = 'completed')))
            OR (c.status = 'void' AND c.award_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_awards a
               WHERE a.id = c.award_id
                 AND a.tournament_id = p_tournament_id
                 AND a.chest_id = c.id
                 AND a.amount_cents = c.amount_cents
                 AND a.status = 'void'))))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_awards a
        JOIN public.tournament_bounty_chests c ON c.id = a.chest_id
       WHERE a.tournament_id = p_tournament_id
         AND (c.tournament_id IS DISTINCT FROM p_tournament_id
           OR c.award_id IS DISTINCT FROM a.id
           OR c.amount_cents IS DISTINCT FROM a.amount_cents
           OR a.status NOT IN ('completed','void')
           OR (a.status = 'completed' AND (
             c.status <> 'paid' OR a.paid_at IS NULL
             OR (SELECT count(*)
                   FROM public.tournament_bounty_award_recipients r
                  WHERE r.award_id = a.id AND r.amount_cents > 0) < 1
             OR (SELECT COALESCE(sum(r.amount_cents),0)
                   FROM public.tournament_bounty_award_recipients r
                  WHERE r.award_id = a.id) <> a.amount_cents
             OR EXISTS (
               SELECT 1 FROM public.tournament_bounty_award_recipients r
                WHERE r.award_id = a.id
                  AND (r.amount_cents <= 0 OR r.paid_at IS NULL))))
           OR (a.status = 'void' AND (
             c.status <> 'void' OR a.paid_at IS NOT NULL OR EXISTS (
               SELECT 1 FROM public.tournament_bounty_award_recipients r
                WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_chests c
        WHERE c.tournament_id = p_tournament_id
          AND c.status = 'paid'
          AND (SELECT count(*) FROM public.tournament_bounty_awards a
                WHERE a.id = c.award_id AND a.chest_id = c.id
                  AND a.tournament_id = p_tournament_id
                  AND a.status = 'completed') <> 1)
  THEN
    RAISE EXCEPTION 'tournament % has malformed or open mystery inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every legacy award key must name one exact completed recipient. A key with
  -- an award prefix but the wrong user or amount is contradictory evidence,
  -- not a reason to classify the recipient as obligation-era.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_bounty_awards a
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'mb:' || a.id::text || ':%'
     WHERE a.tournament_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_award_recipients r
          WHERE r.award_id = a.id
            AND k.key = 'mb:' || a.id::text || ':' || r.user_id::text
            AND k.user_id = r.user_id
            AND k.amount IS NOT NULL
            AND k.amount::text NOT IN ('NaN','Infinity','-Infinity')
            AND k.amount = round(r.amount_cents / 100.0,2)))
     OR EXISTS (
       SELECT 1 FROM public.wallet_credit_idempotency k
        WHERE k.key LIKE 'mb-residual:' || p_tournament_id::text || '%'
          AND k.key <> 'mb-residual:' || p_tournament_id::text)
  THEN
    RAISE EXCEPTION 'tournament % has malformed legacy mystery credit keys',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(sum(r.amount_cents),0)
    INTO v_legacy_award_cents
    FROM public.tournament_bounty_awards a
    JOIN public.tournament_bounty_award_recipients r ON r.award_id = a.id
    JOIN public.wallet_credit_idempotency k
      ON k.key = 'mb:' || a.id::text || ':' || r.user_id::text
     AND k.user_id = r.user_id
     AND k.amount = round(r.amount_cents / 100.0,2)
   WHERE a.tournament_id = p_tournament_id
     AND a.status = 'completed' AND r.paid_at IS NOT NULL;

  SELECT k.amount
    INTO v_legacy_residual_amount
    FROM public.wallet_credit_idempotency k
   WHERE k.key = 'mb-residual:' || p_tournament_id::text;
  IF FOUND AND (
       v_legacy_residual_amount IS NULL
       OR v_legacy_residual_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_legacy_residual_amount <= 0
       OR v_legacy_residual_amount <> round(v_legacy_residual_amount,2)
  ) THEN
    RAISE EXCEPTION 'tournament % has a malformed legacy mystery residual',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_legacy_residual_cents := CASE
    WHEN v_legacy_residual_amount IS NULL THEN 0
    ELSE round(v_legacy_residual_amount * 100)::bigint END;
  IF v_legacy_residual_cents > 0 AND NOT EXISTS (
    SELECT 1 FROM public.wallet_credit_idempotency k
     WHERE k.key = 'mb-residual:' || p_tournament_id::text
       AND k.user_id = p_winner_user_id
       AND k.amount::text NOT IN ('NaN','Infinity','-Infinity')
       AND k.amount > 0 AND k.amount = round(k.amount,2)
       AND round(k.amount * 100)::bigint = v_void_chest_cents
  ) THEN
    RAISE EXCEPTION 'tournament % legacy mystery residual is not its exact void inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_legacy_credit_cents := v_legacy_award_cents + v_legacy_residual_cents;

  -- Obligation credits use one immutable key per cumulative increment. The
  -- suffix is the prior paid cents. Ordered intervals must cover [0,paid)
  -- exactly, which proves no missing, overlapping or invented increment.
  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'mystery_bounty'
       AND (o.place IS NOT NULL OR o.user_id IS NULL
         OR o.amount_owed IS NULL OR o.amount_paid IS NULL
         OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR o.amount_paid <= 0 OR o.amount_paid <> round(o.amount_paid,2)
         OR o.amount_owed IS DISTINCT FROM o.amount_paid
         OR o.settled_at IS NULL))
     OR EXISTS (
       SELECT 1
         FROM public.tournament_obligations o
         JOIN public.wallet_credit_idempotency k
           ON k.key LIKE 'tourney:' || p_tournament_id::text ||
                         ':obl:' || o.id::text || ':%'
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'mystery_bounty'
          AND (k.user_id IS DISTINCT FROM o.user_id
            OR k.amount IS NULL
            OR k.amount::text IN ('NaN','Infinity','-Infinity')
            OR k.amount <= 0 OR k.amount <> round(k.amount,2)
            OR split_part(k.key,':',5) !~ '^[0-9]+$'))
     OR EXISTS (
       WITH key_intervals AS (
         SELECT o.id,o.amount_paid,
                CASE WHEN split_part(k.key,':',5) ~ '^[0-9]+$'
                     THEN split_part(k.key,':',5)::bigint END
                  AS starts_at_cents,
                CASE WHEN k.amount IS NOT NULL
                           AND k.amount::text NOT IN
                               ('NaN','Infinity','-Infinity')
                           AND k.amount > 0 AND k.amount = round(k.amount,2)
                     THEN round(k.amount * 100)::bigint END
                  AS paid_cents
           FROM public.tournament_obligations o
           JOIN public.wallet_credit_idempotency k
             ON k.key LIKE 'tourney:' || p_tournament_id::text ||
                           ':obl:' || o.id::text || ':%'
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'mystery_bounty'
       ), exact_intervals AS (
         SELECT i.*,
                COALESCE(sum(i.paid_cents) OVER (
                  PARTITION BY i.id ORDER BY i.starts_at_cents
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)
                  AS expected_start_cents,
                sum(i.paid_cents) OVER (PARTITION BY i.id) AS total_key_cents
           FROM key_intervals i
       )
       SELECT 1
         FROM public.tournament_obligations o
         LEFT JOIN exact_intervals i ON i.id = o.id
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'mystery_bounty'
        GROUP BY o.id,o.amount_paid
       HAVING count(i.id) = 0
           OR bool_or(i.starts_at_cents <> i.expected_start_cents)
           OR max(i.total_key_cents) <>
                round(o.amount_paid * 100)::bigint)
  THEN
    RAISE EXCEPTION 'tournament % has incomplete mystery obligation credit keys',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0) * 100)::bigint
    INTO v_obligation_cents
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'mystery_bounty';

  -- Allocate every uncovered paid recipient to that recipient's obligation,
  -- and every uncovered void chest to the champion's obligation. This is an
  -- exact per-user partition, stronger than a pool-only total.
  IF EXISTS (
    WITH uncovered AS (
      SELECT r.user_id,sum(r.amount_cents)::bigint AS cents
        FROM public.tournament_bounty_awards a
        JOIN public.tournament_bounty_award_recipients r ON r.award_id = a.id
        LEFT JOIN public.wallet_credit_idempotency k
          ON k.key = 'mb:' || a.id::text || ':' || r.user_id::text
         AND k.user_id = r.user_id
         AND k.amount = round(r.amount_cents / 100.0,2)
       WHERE a.tournament_id = p_tournament_id
         AND a.status = 'completed' AND r.paid_at IS NOT NULL
         AND k.key IS NULL
       GROUP BY r.user_id
      UNION ALL
      SELECT p_winner_user_id,v_void_chest_cents
       WHERE v_void_chest_cents > 0
         AND v_legacy_residual_cents = 0
    ), expected AS (
      SELECT u.user_id,sum(u.cents)::bigint AS cents
        FROM uncovered u GROUP BY u.user_id
    ), obligated AS (
      SELECT o.user_id,round(sum(o.amount_paid) * 100)::bigint AS cents
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'mystery_bounty'
       GROUP BY o.user_id
    )
    SELECT 1 FROM expected e
    FULL JOIN obligated o USING (user_id)
     WHERE COALESCE(e.cents,0) IS DISTINCT FROM COALESCE(o.cents,0)
  ) OR v_legacy_credit_cents + v_obligation_cents
         IS DISTINCT FROM v_t.mystery_bounty_pool_cents THEN
    RAISE EXCEPTION
      'tournament % mystery credit eras do not exactly cover its pool (% legacy + % obligation <> %)',
      p_tournament_id,v_legacy_credit_cents,v_obligation_cents,
      v_t.mystery_bounty_pool_cents USING ERRCODE = 'P0404';
  END IF;

  v_evidence_mode := CASE
    WHEN v_legacy_credit_cents > 0 AND v_obligation_cents > 0 THEN 'mixed'
    WHEN v_legacy_credit_cents > 0 THEN 'legacy_wallet_keys'
    ELSE 'obligations'
  END;
  RETURN jsonb_build_object(
    'evidence_version',1,
    'evidence_mode',v_evidence_mode,
    'pool_cents',v_t.mystery_bounty_pool_cents,
    'inventory_cents',v_inventory_cents,
    'completed_award_cents',v_completed_award_cents,
    'void_chest_cents',v_void_chest_cents,
    'legacy_award_credit_cents',v_legacy_award_cents,
    'legacy_residual_credit_cents',v_legacy_residual_cents,
    'legacy_credit_cents',v_legacy_credit_cents,
    'obligation_cents',v_obligation_cents);
END;
$mystery_completion_evidence$;

REVOKE ALL ON FUNCTION public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid) IS
  'Owner-only STABLE proof that a complete mystery inventory is partitioned exactly between legacy mb wallet keys and cumulative obligation credit-key intervals. It never moves or repairs money.';

-- Owner-only and STABLE by design. Both first completion and replay pass
-- through this same proof. A STABLE function cannot hide a repair write.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_terminal_receipt(
  p_tournament_id uuid,
  p_observed_winner_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $terminal_receipt$
DECLARE
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_r record;
  v_cash_count integer;
  v_cash_total numeric(15,2);
  v_cash_obligation_total numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_roster_count integer;
  v_winner_count integer;
  v_raw_winner_id uuid;
  v_raw_winner_amount numeric(15,2);
  v_bubble jsonb;
  v_durable_payouts jsonb;
  v_durable_deal_shares jsonb;
  v_durable_bubble jsonb;
  v_durable_table_ids uuid[];
  v_durable_table_count integer;
  v_durable_seat_ids uuid[];
  v_durable_seat_count integer;
  v_durable_released_count integer;
  v_mystery_evidence jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF p_observed_winner_id IS NOT NULL
     AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'tournament % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;

  SELECT t.id,t.status,t.variant,t.tournament_type,t.satellite_target_id,
         t.satellite_target,t.prize_pool,t.bounty_pool,t.bounty_pool_paid,
         t.is_bounty,t.is_pko,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents,t.club_id,t.ended_at,t.on_break,
         t.break_started_at,t.break_ends_at
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt lost tournament %', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF lower(COALESCE(v_t.variant::text, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'terminal receipt % belongs to a satellite', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text, '')) <> 'COMPLETED'
     OR v_t.ended_at IS DISTINCT FROM v_h.completed_at
     OR COALESCE(v_t.on_break, false)
     OR v_t.break_started_at IS NOT NULL
     OR v_t.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is not durably closed by its receipt',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Every mutable child carries the same tuple-owned close fact. This makes a
  -- replay prove the synchronous marker transition itself, while queued
  -- writers can reject from OLD after a row-lock wait without relying on a
  -- pre-wait statement snapshot of the parent or receipt.
  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=p_tournament_id
                AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND s.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=p_tournament_id
          AND r.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at) THEN
    RAISE EXCEPTION 'tournament % mutable evidence lacks its exact terminal marker',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Table closure is money-adjacent terminal state, not an asynchronous UI
  -- cleanup. The immutable identities prove that no tournament table vanished,
  -- appeared or reopened after this receipt and that every seat released by
  -- the terminal transaction still has its exact terminal state.
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_table_ids,v_durable_table_count
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_seat_ids,v_durable_seat_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_durable_released_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.id = ANY(v_h.released_seat_ids)
     AND s.left_at IS NOT DISTINCT FROM v_h.completed_at
     AND COALESCE(s.status,'') = 'left'
     AND COALESCE(s.leave_pending,false) IS FALSE
     AND COALESCE(s.is_sitting_out,false) IS FALSE;
  IF v_durable_table_ids IS DISTINCT FROM v_h.closed_table_ids
     OR v_durable_table_count IS DISTINCT FROM v_h.closed_table_count
     OR v_durable_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR v_durable_seat_count IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.terminal_closed_at IS DISTINCT FROM v_h.completed_at
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % table or seat closure differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.prize_pool,2) IS DISTINCT FROM v_h.prize_pool
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.bounty_pool,2) IS DISTINCT FROM v_h.bounty_pool THEN
    RAISE EXCEPTION 'tournament % pools differ from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE tp.status::text = 'winner'
                            AND tp.position = 1)
    INTO v_roster_count,v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_roster_count < 1 OR v_winner_count <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.status::text = 'winner' AND tp.position = 1
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL)
     OR (SELECT count(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT count(DISTINCT tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT min(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> 1
     OR (SELECT max(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text NOT IN ('winner','eliminated')) THEN
    RAISE EXCEPTION 'tournament % has ambiguous or incomplete final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF jsonb_typeof(v_h.cash_receipt->'payouts') <> 'array'
     OR COALESCE((v_h.cash_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_h.cash_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_h.cash_receipt->>'status','')) <> 'COMPLETING'
     OR v_h.cash_receipt->>'winner_amount' IS NULL
     OR (v_h.cash_receipt->>'winner_amount')::numeric < 0
     OR (v_h.cash_receipt->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_h.cash_receipt->>'winner_amount')::numeric,2)
     OR (v_h.settlement_mode = 'final_table_deal'
         AND v_h.cash_receipt->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % stored a malformed cash authority receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric
    INTO v_raw_winner_id,v_raw_winner_amount
    FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
   WHERE (p->>'place')::integer = 1;
  IF v_raw_winner_id IS DISTINCT FROM v_h.winner_id
     OR v_raw_winner_amount IS DISTINCT FROM
          (v_h.cash_receipt->>'winner_amount')::numeric
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
        WHERE p->>'place' IS NULL OR p->>'user_id' IS NULL
           OR p->>'amount' IS NULL
           OR (p->>'place')::integer < 1
           OR (p->>'amount')::numeric < 0
           OR (p->>'amount')::numeric IS DISTINCT FROM
                round((p->>'amount')::numeric,2)
           OR NOT EXISTS (
             SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.position = (p->>'place')::integer
                AND tp.user_id = (p->>'user_id')::uuid))
     OR (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) < 1
     OR (SELECT count(DISTINCT (p->>'place')::integer)
           FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p)
          <> (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) THEN
    RAISE EXCEPTION 'tournament % cash receipt does not name exact finishers',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Satellite and bounty records never consume the ordinary prize pool.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source IN ('satellite_seat','satellite_ticket','satellite_remainder')
  ) THEN
    RAISE EXCEPTION 'non-satellite tournament % carries satellite payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_count IS DISTINCT FROM v_h.cash_payout_count
     OR v_cash_total IS DISTINCT FROM v_h.cash_payout_total
     OR v_cash_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash payout evidence is incomplete or malformed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_h.prize_pool = 0 AND v_durable_payouts = '[]'::jsonb THEN
    -- A zero-cash event has a real winner and no wallet/payout mutation. Keep
    -- that explicit standings line in the receipt without inventing durable
    -- payment evidence.
    v_durable_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_h.winner_id,'amount',0));
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_deal_shares
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
       GROUP BY tp.position,p.user_id
    ) q;
  IF (SELECT count(*) FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'bubble_protection') > 1 THEN
    RAISE EXCEPTION 'tournament % has multiple durable bubble payout lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',p.amount)
    INTO v_durable_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  v_durable_bubble := COALESCE(v_durable_bubble,'null'::jsonb);
  IF v_h.cash_receipt->'payouts' IS DISTINCT FROM v_durable_payouts
     OR jsonb_typeof(v_h.cash_receipt->'deal_shares') <> 'array'
     OR v_h.cash_receipt->'deal_shares' IS DISTINCT FROM
          (CASE WHEN v_h.settlement_mode = 'final_table_deal'
                THEN v_durable_deal_shares ELSE '[]'::jsonb END)
     OR COALESCE(v_h.cash_receipt->'bubble_protection','null'::jsonb)
          IS DISTINCT FROM v_durable_bubble
     OR ((SELECT round(COALESCE(sum((p->>'amount')::numeric),0),2)
            FROM jsonb_array_elements(v_durable_payouts) p)
         + (CASE WHEN v_durable_bubble = 'null'::jsonb THEN 0
                 ELSE (v_durable_bubble->>'amount')::numeric END))
          IS DISTINCT FROM v_h.cash_payout_total THEN
    RAISE EXCEPTION
      'tournament % stored cash lines differ from complete durable payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0),2)
    INTO v_cash_obligation_total
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('place','bubble_protection','final_table_deal');
  IF v_cash_obligation_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND (o.amount_owed IS NULL OR o.amount_paid IS NULL
            OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_owed < 0 OR o.amount_paid < 0
            OR o.amount_owed IS DISTINCT FROM round(o.amount_owed,2)
            OR o.amount_paid IS DISTINCT FROM round(o.amount_paid,2)
            OR o.amount_paid IS DISTINCT FROM o.amount_owed
            OR o.settled_at IS NULL)) THEN
    RAISE EXCEPTION 'tournament % has incomplete or malformed obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2)
    INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id AND lower(w.category) = 'bounty';
  IF v_bounty_total IS DISTINCT FROM v_h.bounty_payout_total
     OR v_bounty_total IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id = p_tournament_id
          AND lower(w.category) = 'bounty'
          AND (lower(w.type) <> 'credit' OR w.amount <= 0
            OR w.amount::text IN ('NaN','Infinity','-Infinity')
            OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % bounty pool is underfunded, overfunded or still open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.bounty_pool > 0 THEN
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false))
       OR COALESCE((v_h.bounty_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.bounty_receipt->>'funded')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament % bounty receipt is not a funded close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false)
        OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                    WHERE o.tournament_id = p_tournament_id
                      AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.tournament_id = p_tournament_id)
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                    WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.mystery_was_active THEN
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_h.winner_id);
    IF COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
       OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
       OR COALESCE(v_t.mystery_bounty_pool_cents,0)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR (SELECT COALESCE(sum(c.amount_cents),0)
             FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR v_h.mystery_receipt->'payment_evidence'
            IS DISTINCT FROM v_mystery_evidence
       OR COALESCE((v_h.mystery_receipt->>'residual_paid_cents')::bigint,-1)
            IS DISTINCT FROM
              COALESCE((v_mystery_evidence->>'void_chest_cents')::bigint,0)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id
                     AND c.status NOT IN ('paid','void'))
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id
                     AND a.status NOT IN ('completed','void'))
       OR EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.tournament_id = p_tournament_id
            AND ((a.status = 'completed' AND (
                  a.paid_at IS NULL OR
                  (SELECT COALESCE(sum(r.amount_cents),0)
                     FROM public.tournament_bounty_award_recipients r
                    WHERE r.award_id = a.id) <> a.amount_cents OR
                  EXISTS (SELECT 1
                            FROM public.tournament_bounty_award_recipients r
                           WHERE r.award_id = a.id
                             AND r.amount_cents > 0 AND r.paid_at IS NULL)))
              OR (a.status = 'void' AND EXISTS (
                  SELECT 1 FROM public.tournament_bounty_award_recipients r
                   WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))) THEN
      RAISE EXCEPTION 'tournament % has open or inconsistent mystery bounty evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_h.mystery_pool_cents <> 0
       OR COALESCE(v_h.mystery_receipt->>'reason','')
            NOT IN ('never_activated','not_a_mystery_tournament')
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'tournament % stored an invalid non-active mystery close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at
     OR v_e.close_note IS DISTINCT FROM v_h.escrow_close_note THEN
    RAISE EXCEPTION 'tournament % escrow is not an exact durable zero close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF v_r.tournament_id IS NULL
     OR v_r.amount IS DISTINCT FROM v_rake_total
     OR v_r.amount IS DISTINCT FROM v_h.rake_amount
     OR v_r.destination IS DISTINCT FROM v_h.rake_destination
     OR v_r.settled_at IS DISTINCT FROM v_h.rake_settled_at
     OR v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at
     OR v_r.attributed_users IS DISTINCT FROM v_h.rake_attributed_users
     OR v_r.attributed_users IS NULL OR v_r.attributed_users < 0
     OR v_r.attribution_error IS NOT NULL
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'club_treasury:%')) THEN
    RAISE EXCEPTION 'tournament % rake is not durably and successfully attributed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_bubble := CASE WHEN v_h.cash_receipt ? 'bubble_protection'
                    THEN v_h.cash_receipt->'bubble_protection'
                   ELSE 'null'::jsonb END;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status','COMPLETED',
    'tournament_id',v_h.tournament_id,
    'winner_id',v_h.winner_id,
    'mode',v_h.settlement_mode,
    'settlement_mode',v_h.settlement_mode,
    'payouts',v_h.cash_receipt->'payouts',
    'deal_shares',v_h.cash_receipt->'deal_shares',
    'winner_amount',(v_h.cash_receipt->>'winner_amount')::numeric,
    'bubble_protection',v_bubble,
    'cash',v_h.cash_receipt,
    'mystery_bounty',v_h.mystery_receipt,
    'bounty',v_h.bounty_receipt,
    'closed_table_count',v_h.closed_table_count,
    'source_seat_count',v_h.source_seat_count,
    'released_seat_count',v_h.released_seat_count,
    'table_closure',jsonb_build_object(
      'closed_table_count',v_h.closed_table_count,
      'closed_table_ids',to_jsonb(v_h.closed_table_ids),
      'source_seat_count',v_h.source_seat_count,
      'source_seat_ids',to_jsonb(v_h.source_seat_ids),
      'released_seat_count',v_h.released_seat_count,
      'released_seat_ids',to_jsonb(v_h.released_seat_ids)),
    'rake',jsonb_build_object(
      'amount',v_h.rake_amount,
      'destination',v_h.rake_destination,
      'attributed',true,
      'attributed_users',v_h.rake_attributed_users,
      'settled_at',v_h.rake_settled_at,
      'attributed_at',v_h.rake_attributed_at),
    'escrow',jsonb_build_object(
      'prize_balance',v_e.prize_balance,
      'bounty_balance',v_e.bounty_balance,
      'fee_balance',v_e.fee_balance,
      'closed_at',v_h.escrow_closed_at,
      'close_note',v_h.escrow_close_note),
    'cash_payout_total',v_h.cash_payout_total,
    'bounty_payout_total',v_h.bounty_payout_total,
    'receipt_version',v_h.receipt_version,
    'settled_at',v_h.settled_at);
END;
$terminal_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- A privileged client must not be able to publish COMPLETED without the
-- receipt written by the atomic authority. This is deferred because the
-- authority deliberately closes lifecycle first and inserts its receipt next,
-- in the same transaction. At commit, a receipt-backed event is re-verified;
-- a receiptless non-satellite transition is rejected and all writes roll back.
CREATE OR REPLACE FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_status_guard$
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant::text,'')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type::text,'')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL
     OR NEW.satellite_target IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'non-satellite tournament % cannot become COMPLETED without its atomic terminal receipt',
      NEW.id USING ERRCODE = '55000';
  END IF;
  PERFORM public.fn_ca_tournament_terminal_receipt(NEW.id,NULL);
  RETURN NEW;
END;
$terminal_status_guard$;

REVOKE ALL ON FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER non_satellite_completed_requires_terminal_receipt
  AFTER INSERT OR UPDATE OF status ON public.tournaments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_non_satellite_completed_requires_terminal_receipt();

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(
  p_tournament_id uuid,
  p_observed_winner_id uuid,
  p_settlement_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '45s'
AS $complete_terminal$
DECLARE
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_cash jsonb;
  v_mystery jsonb;
  v_mystery_evidence jsonb;
  v_bounty jsonb;
  v_rake_result jsonb;
  v_rake record;
  v_prior_rake record;
  v_winner_id uuid;
  v_winner_count integer;
  v_is_bounty boolean;
  v_mystery_active boolean := false;
  v_mystery_stage text := 'pending';
  v_mystery_pool_cents bigint := 0;
  v_inventory_cents bigint := 0;
  v_cash_count integer;
  v_bubble_line_count integer;
  v_cash_total numeric(15,2);
  v_cash_before numeric(15,2);
  v_bounty_before numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_expected_fee numeric(15,2);
  v_started_status text;
  v_completed_at timestamptz;
  v_rows integer;
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_event_union_id uuid;
  v_current_union_id uuid;
  v_locked_current_union_id uuid;
  v_deal_shares jsonb := '[]'::jsonb;
  v_full_payouts jsonb := '[]'::jsonb;
  v_cash_bubble jsonb := 'null'::jsonb;
  v_full_winner_amount numeric(15,2);
BEGIN
  -- All satellite and non-satellite terminal money commits use this exact
  -- first lock. It eliminates cross-event cycles on shared club, union and
  -- recipient wallets without weakening any event-local row proof.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));

  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal completion requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal settlement mode %', p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'places' AND p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'places completion requires an observed winner id'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Receipt first is the replay boundary. No money authority appears above it.
  IF EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = p_tournament_id
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_terminal_settlements h
       WHERE h.tournament_id = p_tournament_id
         AND h.settlement_mode = v_mode
         AND (p_observed_winner_id IS NULL
              OR h.winner_id = p_observed_winner_id)
    ) THEN
      RAISE EXCEPTION 'terminal replay parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    RETURN public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
  END IF;

  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite; use its whole-pool authority',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  v_started_status := upper(COALESCE(v_t.status::text,''));
  IF v_started_status NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % cannot complete from status % without a receipt',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2)
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.bounty_pool < 0
     OR v_t.bounty_pool IS DISTINCT FROM round(v_t.bounty_pool,2) THEN
    RAISE EXCEPTION 'tournament % has malformed cash or bounty pools',
      p_tournament_id USING ERRCODE = '22003';
  END IF;

  -- Cross-event bank order is tournament -> club_wallets -> union_wallets
  -- (sorted) -> clubs, before a cash authority can apply an overlay. Rake uses
  -- club_wallets before its union/club destination; guarantee funding uses the
  -- union/club destination. Pre-owning both paths prevents two same-scope
  -- finishes from taking those shared banks in opposite order.
  v_event_union_id := CASE WHEN COALESCE(v_t.is_private,false)
                           THEN NULL ELSE v_t.union_id END;
  IF v_t.club_id IS NOT NULL THEN
    SELECT c.union_id INTO v_current_union_id
      FROM public.clubs c WHERE c.id = v_t.club_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % refers to missing club %',
        p_tournament_id,v_t.club_id USING ERRCODE = 'P0404';
    END IF;
    PERFORM 1 FROM public.club_wallets cw
     WHERE cw.club_id = v_t.club_id
     ORDER BY cw.club_id FOR NO KEY UPDATE;
    PERFORM 1 FROM public.union_wallets uw
     WHERE uw.union_id IN (
       SELECT DISTINCT x.union_id
         FROM unnest(ARRAY[v_event_union_id,v_current_union_id]::uuid[]) x(union_id)
        WHERE x.union_id IS NOT NULL)
     ORDER BY uw.union_id FOR NO KEY UPDATE;
    SELECT c.union_id INTO v_locked_current_union_id
      FROM public.clubs c
     WHERE c.id = v_t.club_id
     FOR NO KEY UPDATE;
    IF v_locked_current_union_id IS DISTINCT FROM v_current_union_id THEN
      RAISE EXCEPTION 'club % changed union while tournament % claimed terminal banks',
        v_t.club_id,p_tournament_id USING ERRCODE = '40001';
    END IF;
  END IF;

  -- Freeze every tournament-owned evidence set before the first payer. The
  -- canonical payers reacquire only rows already owned by this transaction.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id ORDER BY p.id FOR SHARE;
  PERFORM 1 FROM public.tournament_guarantee_overlays g
   WHERE g.tournament_id = p_tournament_id
   ORDER BY g.tournament_id FOR UPDATE;
  -- The final-table deal authority uses this same order after its money sets.
  -- Holding these locks before any bounty or rake row prevents a reversed
  -- terminal lock chain while retaining the tournament row as the root lock.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  v_closed_table_count := cardinality(v_closed_table_ids);
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_seat_count := cardinality(v_source_seat_ids);
  PERFORM 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
   ORDER BY w.id FOR SHARE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = p_tournament_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id ORDER BY a.id FOR UPDATE;
  PERFORM 1
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM 1 FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament
   ORDER BY rr.id FOR SHARE;
  PERFORM 1 FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;

  v_is_bounty := COALESCE(v_t.is_bounty,false)
              OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND lower(w.category) = 'bounty'
       AND (lower(w.type) <> 'credit' OR w.amount <= 0
         OR w.amount::text IN ('NaN','Infinity','-Infinity')
         OR w.amount IS DISTINCT FROM round(w.amount,2))
  ) OR v_bounty_before < 0 OR v_bounty_before > v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_bounty_before THEN
    RAISE EXCEPTION 'tournament % has overpaid or contradictory bounty evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_is_bounty THEN
    IF v_t.bounty_pool <= 0 THEN
      RAISE EXCEPTION 'funded bounty tournament % has no positive bounty pool',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_t.bounty_pool <> 0 OR v_bounty_before <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery_stage := COALESCE(v_t.mystery_bounty_stage,'');
    IF v_mystery_stage NOT IN ('pending','active','complete') THEN
      RAISE EXCEPTION 'tournament % has ambiguous mystery stage % without a receipt',
        p_tournament_id,v_t.mystery_bounty_stage USING ERRCODE = '55000';
    END IF;
    -- A rolling cutover may meet an event whose old finish path already
    -- completed the mystery inventory but never completed cash, rake or the
    -- lifecycle. Treat both active and complete as a funded mystery branch.
    -- Active is settled below; complete must already prove the entire mystery
    -- obligation and every inventory row before the wrapper can continue.
    v_mystery_active := v_mystery_stage IN ('active','complete');
    IF v_mystery_active THEN
      v_mystery_pool_cents := COALESCE(v_t.mystery_bounty_pool_cents,0);
      SELECT COALESCE(sum(c.amount_cents),0) INTO v_inventory_cents
        FROM public.tournament_bounty_chests c
       WHERE c.tournament_id = p_tournament_id;
      IF v_mystery_pool_cents <= 0
         OR v_inventory_cents IS DISTINCT FROM v_mystery_pool_cents
         OR v_mystery_pool_cents > round(v_t.bounty_pool * 100)::bigint
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id
              AND (c.amount_cents <= 0 OR c.status NOT IN
                   ('available','reserved','revealed','paid','void')))
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_awards a
            WHERE a.tournament_id = p_tournament_id
              AND (a.amount_cents <= 0 OR a.status NOT IN
                   ('reserved','revealed','paid','completed','void'))) THEN
        RAISE EXCEPTION 'tournament % mystery bounty inventory is not exactly funded',
          p_tournament_id USING ERRCODE = 'P0404';
      END IF;
    ELSIF COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'pending mystery tournament % already carries inventory',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
     OR COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'non-mystery tournament % carries mystery bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_cash_before
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_before < 0 OR v_cash_before > v_t.prize_pool
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id = p_tournament_id
                   AND p.source IN
                     ('satellite_seat','satellite_ticket','satellite_remainder')) THEN
    RAISE EXCEPTION 'tournament % has invalid pre-terminal cash evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF v_rake_total < 0 OR v_rake_total::text IN ('NaN','Infinity','-Infinity')
     OR v_rake_total IS DISTINCT FROM round(v_rake_total,2) THEN
    RAISE EXCEPTION 'tournament % has malformed rake records',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT rs.* INTO v_prior_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_prior_rake.amount IS DISTINCT FROM v_rake_total
       OR v_prior_rake.settled_at IS NULL
       OR v_prior_rake.attributed_at IS NULL
       OR v_prior_rake.attributed_users IS NULL
       OR v_prior_rake.attributed_users < 0
       OR v_prior_rake.attribution_error IS NOT NULL
       OR lower(v_prior_rake.destination) IN ('pending','')
       OR (v_prior_rake.amount > 0 AND v_t.club_id IS NOT NULL
           AND (v_prior_rake.attributed_users < 1
             OR (v_prior_rake.destination NOT LIKE 'union:%'
                 AND v_prior_rake.destination NOT LIKE 'club_treasury:%'))) THEN
      RAISE EXCEPTION 'tournament % has a partial or unattributed prior rake row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_expected_fee := 0;
  ELSE
    v_expected_fee := v_rake_total;
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM round(v_t.prize_pool-v_cash_before,2)
     OR v_e.bounty_balance IS DISTINCT FROM round(v_t.bounty_pool-v_bounty_before,2)
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee
     OR v_e.prize_balance < 0 OR v_e.bounty_balance < 0
     OR v_e.fee_balance < 0
     OR v_e.closed_at IS NOT NULL
     OR v_e.close_note IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % escrow does not exactly fund its remaining obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Exactly one branch calls exactly one cash authority.
  IF v_mode = 'places' THEN
    v_cash := public.fn_settle_tournament_places(
      p_tournament_id,p_observed_winner_id);
  ELSE
    v_cash := public.fn_settle_tournament_final_table_deal(p_tournament_id);
  END IF;
  IF COALESCE((v_cash->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_cash->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_cash->>'status','')) <> 'COMPLETING'
     OR jsonb_typeof(v_cash->'payouts') <> 'array'
     OR jsonb_array_length(v_cash->'payouts') < 1
     OR v_cash->>'winner_amount' IS NULL
     OR (v_cash->>'winner_amount')::numeric < 0
     OR (v_cash->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_cash->>'winner_amount')::numeric,2)
     OR (v_mode = 'final_table_deal'
         AND v_cash->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % cash authority returned a partial result: %',
      p_tournament_id,v_cash USING ERRCODE = 'P0404';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) <> 'COMPLETING'
     OR COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2) THEN
    RAISE EXCEPTION 'tournament % cash authority did not claim one finalized pool',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  SELECT tp.user_id INTO v_winner_id
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  IF v_winner_count <> 1 OR v_winner_id IS NULL
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_winner_id
          AND (tp.eliminated_at IS NOT NULL
            OR tp.elimination_sequence IS NOT NULL))
     OR (p_observed_winner_id IS NOT NULL
         AND v_winner_id IS DISTINCT FROM p_observed_winner_id)
     OR (SELECT count(*) FROM jsonb_array_elements(v_cash->'payouts') p
          WHERE (p->>'place')::integer = 1
            AND (p->>'user_id')::uuid = v_winner_id
            AND (p->>'amount')::numeric =
                (v_cash->>'winner_amount')::numeric) <> 1 THEN
    RAISE EXCEPTION 'tournament % cash authority left an ambiguous winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_total IS DISTINCT FROM v_t.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash pool did not settle exactly',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  -- The deal authority returns only the still-live chop shares. That is the
  -- right presentation input for the table animation, but it is not the full
  -- prize-pool receipt when eliminated fixed places were already earned.
  -- Store both contracts explicitly: deal_shares is exactly the live chop;
  -- payouts is every non-bubble cash entitlement reconstructed from durable
  -- payout evidence and final standings. Bubble protection remains a distinct
  -- line, so sum(payouts.amount) + bubble_protection.amount is the full pool.
  IF v_mode = 'final_table_deal' THEN
    v_deal_shares := v_cash->'payouts';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_full_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_t.prize_pool = 0 AND v_full_payouts = '[]'::jsonb THEN
    -- The cash authority returns the derived zero-dollar winner line, but a
    -- zero payment correctly creates no tournament_payouts row.
    v_full_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_winner_id,'amount',0));
  END IF;
  SELECT count(*) INTO v_bubble_line_count
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  IF v_bubble_line_count > 1 THEN
    RAISE EXCEPTION 'tournament % has more than one durable bubble payout line',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',p.amount)
    INTO v_cash_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  v_cash_bubble := COALESCE(v_cash_bubble,'null'::jsonb);
  SELECT (p->>'amount')::numeric INTO v_full_winner_amount
    FROM jsonb_array_elements(v_full_payouts) p
   WHERE (p->>'place')::integer = 1;
  IF v_full_winner_amount IS NULL THEN
    RAISE EXCEPTION 'tournament % has no durable winner cash line',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_cash := v_cash || jsonb_build_object(
    'payouts',v_full_payouts,
    'deal_shares',v_deal_shares,
    'bubble_protection',v_cash_bubble,
    'winner_amount',v_full_winner_amount);

  IF v_mystery_stage = 'active' THEN
    v_mystery := public.fn_mystery_bounty_settle(
      p_tournament_id,v_winner_id);
    IF COALESCE((v_mystery->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'variance_cents')::bigint,1) <> 0 THEN
      RAISE EXCEPTION 'tournament % mystery bounty close was partial: %',
        p_tournament_id,v_mystery USING ERRCODE = 'P0404';
    END IF;
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := v_mystery || jsonb_build_object(
      'payment_evidence',v_mystery_evidence,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint);
  ELSIF v_mystery_stage = 'complete' THEN
    -- No payer is rerun for an already-complete inventory. The preflight
    -- proved exact terminal chests, awards and mystery obligations plus their
    -- immutable credit-key intervals while all rows were locked. Store that
    -- canonical replay result before the bounty-pool finalizer checks the
    -- mystery completion receipt; this is evidence capture, not a second pay.
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := jsonb_build_object(
      'ok',true,'reason','already_complete',
      'pool_cents',v_mystery_pool_cents,
      'settled_cents',v_mystery_pool_cents,
      'unclaimed_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'balanced',true,'variance_cents',0,
      'payment_evidence',v_mystery_evidence);
    INSERT INTO public.tournament_bounty_completion_receipts
      (tournament_id,winner_user_id,mystery_settled_at,mystery_result,updated_at)
    VALUES (p_tournament_id,v_winner_id,now(),v_mystery,now())
    ON CONFLICT (tournament_id) DO UPDATE
      SET mystery_settled_at=COALESCE(
            public.tournament_bounty_completion_receipts.mystery_settled_at,
            EXCLUDED.mystery_settled_at),
          mystery_result=COALESCE(
            public.tournament_bounty_completion_receipts.mystery_result,
            EXCLUDED.mystery_result),
          winner_user_id=COALESCE(
            public.tournament_bounty_completion_receipts.winner_user_id,
            EXCLUDED.winner_user_id),
          updated_at=now();
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_completion_receipts r
       WHERE r.tournament_id=p_tournament_id
         AND r.winner_user_id=v_winner_id
         AND r.mystery_settled_at IS NOT NULL
         AND r.mystery_result IS NOT DISTINCT FROM v_mystery
    ) THEN
      RAISE EXCEPTION
        'tournament % completed mystery evidence receipt conflicts with canonical proof',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
  ELSIF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery := jsonb_build_object(
      'ok',true,'reason','never_activated','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  ELSE
    v_mystery := jsonb_build_object(
      'ok',true,'reason','not_a_mystery_tournament','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  END IF;

  IF v_is_bounty THEN
    v_bounty := public.fn_finalize_bounty_pool(p_tournament_id,v_winner_id);
    IF COALESCE((v_bounty->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_bounty->>'funded')::boolean,false) IS NOT TRUE
       OR v_bounty->>'residual' IS NULL
       OR (v_bounty->>'residual')::numeric < 0 THEN
      RAISE EXCEPTION 'tournament % bounty pool close was partial: %',
        p_tournament_id,v_bounty USING ERRCODE = 'P0404';
    END IF;
  ELSE
    v_bounty := jsonb_build_object(
      'ok',true,'funded',true,'residual',0,
      'reason','not_a_bounty_tournament');
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  IF v_bounty_total IS DISTINCT FROM v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_t.bounty_pool
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w
                 WHERE w.related_entity_id = p_tournament_id
                   AND lower(w.category) = 'bounty'
                   AND (lower(w.type) <> 'credit' OR w.amount <= 0
                     OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND (o.amount_paid IS DISTINCT FROM o.amount_owed
                     OR o.settled_at IS NULL))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id
                   AND c.status NOT IN ('paid','void'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id
                   AND a.status NOT IN ('completed','void'))
     OR (v_mystery_active AND (
          v_mystery_evidence IS NULL
          OR COALESCE((v_mystery_evidence->>'pool_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents
          OR COALESCE((v_mystery_evidence->>'legacy_credit_cents')::bigint,-1)
             + COALESCE((v_mystery_evidence->>'obligation_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.status = 'completed'
          AND (a.paid_at IS NULL
            OR (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id = a.id) <> a.amount_cents
            OR EXISTS (SELECT 1
                         FROM public.tournament_bounty_award_recipients r
                        WHERE r.award_id = a.id
                          AND r.amount_cents > 0 AND r.paid_at IS NULL))) THEN
    RAISE EXCEPTION 'tournament % bounty obligations or chests remain open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- current_bounty is the live head/cache, not payment evidence. The older
  -- finalizer clears only the champion when it itself pays a positive ordinary
  -- residual; an already-exhausted pool or mystery residual can therefore
  -- leave a stale live head after every chip is durably paid. Once exact pool,
  -- obligation and inventory conservation is proved above, zero every head in
  -- this same terminal commit so no completed player advertises open value.
  IF v_is_bounty THEN
    UPDATE public.tournament_players
       SET current_bounty = 0
     WHERE tournament_id = p_tournament_id
       AND COALESCE(current_bounty,0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % still has a live bounty head after close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee THEN
    RAISE EXCEPTION 'tournament % cash/bounty close did not preserve fee escrow',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id,'engine.fn_complete_tournament_terminal');
  IF COALESCE((v_rake_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % rake authority refused: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;
  SELECT rs.* INTO v_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;
  IF v_rake.tournament_id IS NULL
     OR v_rake.amount IS DISTINCT FROM v_rake_total
     OR v_rake.settled_at IS NULL OR v_rake.attributed_at IS NULL
     OR v_rake.attributed_users IS NULL OR v_rake.attributed_users < 0
     OR v_rake.attribution_error IS NOT NULL
     OR lower(v_rake.destination) IN ('pending','')
     OR (v_rake.amount > 0 AND v_t.club_id IS NOT NULL
         AND (v_rake.attributed_users < 1
           OR (v_rake.destination NOT LIKE 'union:%'
               AND v_rake.destination NOT LIKE 'club_treasury:%'))) THEN
    RAISE EXCEPTION 'tournament % rake attribution did not complete: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % did not close all three escrow banks',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());
  -- Persist the exact-zero proof before lifecycle. The historical after-status
  -- observer was detached above; this authority is now the only owner of the
  -- terminal escrow marker.
  UPDATE public.tournament_escrow
     SET closed_at = v_completed_at,
         close_note = 'terminal receipt: exact zero',
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its exact zero escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Explicitly release every live seat and close every tournament table in
  -- this transaction. No timer, table manager or lifecycle watcher is part of
  -- the completion contract. IDs and counts are captured for immutable replay.
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at = v_completed_at,
           status = 'left',
           leave_pending = false,
           is_sitting_out = false,
           is_away = false,
           sit_out_at = NULL,
           scheduled_leave_hands = NULL
      FROM public.tables tb
     WHERE tb.id = s.table_id
       AND tb.tournament_id = p_tournament_id
       AND s.left_at IS NULL
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(r.id ORDER BY r.id),ARRAY[]::uuid[])
    INTO v_released_seat_ids
    FROM released r;
  v_released_seat_count := cardinality(v_released_seat_ids);

  -- Preserve an earlier departure time, but canonicalize every other mutable
  -- occupancy flag before the immutable source-seat snapshot is committed.
  UPDATE public.table_seats s
     SET status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE s.id = ANY(v_source_seat_ids)
     AND s.left_at IS NOT NULL
     AND (s.status IS DISTINCT FROM 'left'
       OR s.leave_pending IS DISTINCT FROM false
       OR s.is_sitting_out IS DISTINCT FROM false
       OR s.is_away IS DISTINCT FROM false
       OR s.sit_out_at IS NOT NULL
       OR s.scheduled_leave_hands IS NOT NULL);

  -- Publish terminal lifecycle after every seat is released but before table
  -- rows close. The managed table-status observer therefore sees a genuinely
  -- terminal parent and does not emit a false live-tournament incident. The
  -- deferred receipt constraint still requires the receipt later in this same
  -- transaction; any table or receipt failure rolls this update back too.
  UPDATE public.tournaments
     SET status = 'COMPLETED',
         ended_at = v_completed_at,
         on_break = false,
         break_started_at = NULL,
         break_ends_at = NULL,
         updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status::text,'')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its terminal lifecycle claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_completed_at,
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_closed_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % did not durably release every seat and close every table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.tournament_terminal_settlements
    (tournament_id,winner_id,settlement_mode,started_status,
     prize_pool,bounty_pool,cash_payout_count,cash_payout_total,
     bounty_payout_total,mystery_was_active,mystery_pool_cents,
     cash_receipt,mystery_receipt,bounty_receipt,
     closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
     released_seat_count,released_seat_ids,
     rake_amount,rake_destination,rake_settled_at,rake_attributed_at,
     rake_attributed_users,escrow_closed_at,escrow_close_note,
     completed_at,settled_at,receipt_version)
  VALUES
    (p_tournament_id,v_winner_id,v_mode,v_started_status,
     v_t.prize_pool,v_t.bounty_pool,v_cash_count,v_cash_total,
     v_bounty_total,v_mystery_active,v_mystery_pool_cents,
     v_cash,v_mystery,v_bounty,
     v_closed_table_count,v_closed_table_ids,
     v_source_seat_count,v_source_seat_ids,
     v_released_seat_count,v_released_seat_ids,
     v_rake.amount,v_rake.destination,v_rake.settled_at,v_rake.attributed_at,
     v_rake.attributed_users,v_completed_at,'terminal receipt: exact zero',
     v_completed_at,transaction_timestamp(),1);

  RETURN public.fn_ca_tournament_terminal_receipt(
    p_tournament_id,p_observed_winner_id);
END;
$complete_terminal$;

REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  TO service_role;

-- A network error is not evidence that PostgreSQL rolled back. This resolver
-- takes the identical global terminal lock first, then the event row, so it
-- cannot report RUNNING while an earlier completion transaction is still able
-- to commit. It moves no money. A committed outcome includes the same verified
-- immutable receipt returned by the terminal authority.
CREATE OR REPLACE FUNCTION public.fn_resolve_tournament_terminal_outcome(
  p_tournament_id uuid,
  p_observed_winner_id uuid,
  p_settlement_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '45s'
AS $terminal_outcome$
DECLARE
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_t record;
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_receipt jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal outcome requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal outcome mode %',p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite',p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_h FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_h.settlement_mode IS DISTINCT FROM v_mode
       OR (p_observed_winner_id IS NOT NULL
           AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id) THEN
      RAISE EXCEPTION 'terminal outcome parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    v_receipt := public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
    RETURN jsonb_build_object(
      'ok',true,
      'terminal_committed',true,
      'definitively_not_committed',false,
      'status','COMPLETED',
      'mode',v_mode,
      'tournament_id',p_tournament_id,
      'receipt',v_receipt);
  END IF;

  IF upper(COALESCE(v_t.status::text,'')) = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed tournament % has no atomic terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % has non-terminal-outcome status %',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,
    'terminal_committed',false,
    'definitively_not_committed',true,
    'status',upper(v_t.status::text),
    'mode',v_mode,
    'tournament_id',p_tournament_id,
    'receipt','null'::jsonb);
END;
$terminal_outcome$;

REVOKE ALL ON FUNCTION public.fn_resolve_tournament_terminal_outcome(
  uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_tournament_terminal_outcome(
  uuid,uuid,text) TO service_role;

COMMENT ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) IS
  'Service-only non-satellite terminal transaction. Exactly one cash authority, bounty closure, attributed rake, table and seat closure, lifecycle close and immutable receipt commit together; replay only verifies stored durable state.';
COMMENT ON FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid) IS
  'Owner-only STABLE verifier for an immutable terminal receipt. It reads exact cash, bounty, escrow, rake, table, seat and lifecycle evidence and moves no money.';
COMMENT ON FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text) IS
  'Service-only serialized transport-outcome resolver. It waits behind the global terminal transaction lock and returns either the verified committed receipt or definitive no-receipt RUNNING/COMPLETING state.';

-- The rolling protocol doors have finished their purpose. Keeping either old
-- overload executable lets a service caller commit a hand without the durable
-- post-commit envelope; keeping the insert or stack core executable lets it
-- commit only half a hand. Retire both overloads with RESTRICT and make every
-- implementation primitive owner-only. The 12-argument lease-fenced function
-- remains the sole service entry point and calls these cores as their owner.
DO $accepted_hand_bypass_preflight$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_insert_hand_with_awards(jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION
      'accepted-hand authority preflight found a missing rolling door or owner core';
  END IF;
END;
$accepted_hand_bypass_preflight$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_ca_commit_hand_settlement_before_lease_generation(
    uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_ca_commit_hand_settlement_exact_before_obligations(
    uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

DROP FUNCTION public.fn_ca_commit_hand_settlement(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) RESTRICT;
DROP FUNCTION public.fn_ca_commit_hand_settlement(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) RESTRICT;

DO $accepted_hand_bypass_verify$
DECLARE
  v_signature text;
  v_oid oid;
BEGIN
  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'rolling accepted-hand overload survived retirement';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
    'public.fn_ca_insert_hand_with_awards(jsonb,jsonb)',
    'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)',
    'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL
       OR has_function_privilege('service_role',v_oid,'EXECUTE')
       OR has_function_privilege('authenticated',v_oid,'EXECUTE')
       OR has_function_privilege('anon',v_oid,'EXECUTE') THEN
      RAISE EXCEPTION
        'accepted-hand implementation primitive % is missing or externally executable',
        v_signature;
    END IF;
  END LOOP;

  v_oid := to_regprocedure(
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)');
  IF v_oid IS NULL
     OR NOT has_function_privilege('service_role',v_oid,'EXECUTE')
     OR has_function_privilege('authenticated',v_oid,'EXECUTE')
     OR has_function_privilege('anon',v_oid,'EXECUTE')
     OR (SELECT count(*) FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public'
           AND p.proname='fn_ca_commit_hand_settlement'
           AND has_function_privilege('service_role',p.oid,'EXECUTE')) <> 1 THEN
    RAISE EXCEPTION
      '12-argument accepted-hand transaction is not the one service-executable door';
  END IF;
END;
$accepted_hand_bypass_verify$;

INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
  ('fn_ca_mystery_bounty_completion_evidence','approved',
   'Owner-only STABLE mixed-era mystery credit proof; reads immutable legacy and obligation keys and moves no money.'),
  ('fn_ca_tournament_terminal_receipt','approved',
   'Owner-only STABLE proof of the immutable non-satellite terminal receipt; it moves no money.'),
  ('fn_complete_tournament_terminal','approved',
   'Service-only all-or-nothing non-satellite finish: one cash authority, bounty pools, attributed rake, lifecycle and receipt.'),
  ('fn_resolve_tournament_terminal_outcome','approved',
   'Service-only serialized read after an ambiguous transport result; moves no money and returns a verified stored receipt when committed.')
ON CONFLICT (proname) DO UPDATE
   SET status = EXCLUDED.status,notes = EXCLUDED.notes;

DO $verify_terminal_authority$
DECLARE
  v_source text;
  v_receipt_source text;
  v_hand_source text;
  v_hand_core_source text;
  v_hand_commit_source text;
  v_mystery_pay_source text;
  v_mystery_reserve_source text;
  v_table_guard_source text;
  v_outcome_source text;
  v_component_signature text;
  v_component_source text;
  v_root_signature text;
  v_root_source text;
  v_root_first_work text;
  v_collect_bounty_source text;
  v_satellite_award_source text;
  v_mystery_evidence_source text;
  v_satellite_receipt_source text;
  v_terminal_marker_source text;
  v_terminal_stamp_source text;
  v_terminal_evidence_guard_source text;
  v_terminal_parent_guard_source text;
BEGIN
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_receipt_source FROM pg_proc
   WHERE oid = 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_hand_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
  SELECT prosrc INTO v_hand_core_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure;
  SELECT prosrc INTO v_hand_commit_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure;
  SELECT prosrc INTO v_mystery_pay_source FROM pg_proc
   WHERE oid = 'public.fn_mystery_bounty_pay(uuid)'::regprocedure;
  SELECT prosrc INTO v_mystery_reserve_source FROM pg_proc
   WHERE oid =
     'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)'::regprocedure;
  SELECT prosrc INTO v_table_guard_source FROM pg_proc
   WHERE oid =
     'public.fn_tournament_table_terminal_close_is_irreversible()'::regprocedure;
  SELECT prosrc INTO v_outcome_source FROM pg_proc
   WHERE oid =
     'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_collect_bounty_source FROM pg_proc
   WHERE oid =
     'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure;
  SELECT prosrc INTO v_mystery_evidence_source FROM pg_proc
   WHERE oid =
            'public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_satellite_receipt_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_terminal_marker_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'::regprocedure;
  SELECT prosrc INTO v_terminal_stamp_source FROM pg_proc
   WHERE oid =
     'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure;
  SELECT prosrc INTO v_terminal_evidence_guard_source FROM pg_proc
   WHERE oid =
     'public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure;
  SELECT prosrc INTO v_terminal_parent_guard_source FROM pg_proc
   WHERE oid =
     'public.fn_receipted_tournament_is_immutable()'::regprocedure;
  FOREACH v_root_signature IN ARRAY ARRAY[
    'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_mystery_bounty_pay(uuid)',
    'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)'
  ] LOOP
    SELECT prosrc INTO v_root_source
      FROM pg_proc
     WHERE oid=to_regprocedure(v_root_signature);
    IF v_root_source IS NULL
       OR v_root_source ~*
            '_unguarded_20260907[[:space:]]*[(]' THEN
      RAISE EXCEPTION
        'bounty root % is missing or still delegates to a rolling helper',
        v_root_signature;
    END IF;
  END LOOP;
  IF v_collect_bounty_source IS NULL
     OR position('ca:tournament-terminal-settlement:v1'
                   IN v_collect_bounty_source) = 0
     OR position('pg_advisory_xact_lock('
                   IN v_collect_bounty_source) = 0
     OR position('pg_advisory_xact_lock('
                   IN v_collect_bounty_source) >
        position('FOR UPDATE' IN v_collect_bounty_source) THEN
    RAISE EXCEPTION
      'live bounty authority lost its terminal-first serialization';
  END IF;
  FOREACH v_component_signature IN ARRAY ARRAY[
    'public.fn_settle_tournament_places(uuid,uuid)',
    'public.fn_settle_tournament_final_table_deal(uuid)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_settle_tournament_rake(uuid,text)',
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'
  ] LOOP
    SELECT prosrc INTO v_component_source FROM pg_proc
     WHERE oid = to_regprocedure(v_component_signature);
    IF v_component_source IS NULL
       OR position('ca:tournament-terminal-settlement:v1'
                     IN v_component_source) = 0
       OR position('pg_advisory_xact_lock('
                     IN v_component_source) = 0
       OR position('pg_advisory_xact_lock('
                     IN v_component_source) >
          position('FOR UPDATE' IN v_component_source) THEN
      RAISE EXCEPTION
        'rolling terminal component % lost the shared lock order',
        v_component_signature;
    END IF;
  END LOOP;
  FOREACH v_root_signature IN ARRAY ARRAY[
    'public.fn_sweep_pending_tournament_bounties(uuid,integer)',
    'public.fn_backpay_unfinalised_bounty_pools(boolean,integer)',
    'public.fn_sweep_unsettled_tournament_rake(integer,integer)',
    'public.fn_settle_satellite_finish_atomic(uuid,text)',
    'public.fn_settle_final_table_deal_atomic(uuid)'
  ] LOOP
    SELECT prosrc INTO v_root_source FROM pg_proc
     WHERE oid = to_regprocedure(v_root_signature);
    v_root_first_work := CASE v_root_signature
      WHEN 'public.fn_sweep_pending_tournament_bounties(uuid,integer)'
        THEN 'FOR candidate IN'
      WHEN 'public.fn_backpay_unfinalised_bounty_pools(boolean,integer)'
        THEN 'FOR r IN'
      WHEN 'public.fn_sweep_unsettled_tournament_rake(integer,integer)'
        THEN 'FOR v_row IN'
      WHEN 'public.fn_settle_satellite_finish_atomic(uuid,text)'
        THEN 'public.fn_settle_satellite_finish_atomic_before_maintenance_gate('
      WHEN 'public.fn_settle_final_table_deal_atomic(uuid)'
        THEN 'SELECT t.id, t.name, t.status'
    END;
    IF v_root_source IS NULL
       OR position('ca:tournament-terminal-settlement:v1'
                     IN v_root_source) = 0
       OR position('pg_advisory_xact_lock('
                     IN v_root_source) = 0
       OR position(v_root_first_work IN v_root_source) = 0
       OR position('pg_advisory_xact_lock(' IN v_root_source) >
            position(v_root_first_work IN v_root_source)
       OR has_function_privilege('anon',v_root_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_root_signature,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_root_signature,'EXECUTE') THEN
      RAISE EXCEPTION
        'rolling terminal root % lost global-first order or service-only ACL',
        v_root_signature;
    END IF;
  END LOOP;
  SELECT prosrc INTO v_root_source FROM pg_proc
   WHERE oid =
     'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)'::regprocedure;
  IF v_root_source IS NULL
     OR position('ca:tournament-terminal-settlement:v1' IN v_root_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_root_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_root_source) >
          position('SELECT * INTO v_target FROM public.tournaments'
                     IN v_root_source)
     OR has_function_privilege('anon',
          'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
          'EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
          'EXECUTE')
     OR has_function_privilege('service_role',
          'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
          'EXECUTE') THEN
    RAISE EXCEPTION
      'exact satellite ticket delivery lost global-first order or owner-only ACL';
  END IF;
  SELECT prosrc INTO v_satellite_award_source FROM pg_proc
   WHERE oid =
     'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure;
  IF v_satellite_award_source IS NULL
     OR position('WHERE id = p_target_id' IN v_satellite_award_source) = 0
     OR position('WHERE id = p_satellite_id' IN v_satellite_award_source) = 0
     OR position('WHERE id = p_target_id' IN v_satellite_award_source) >
          position('WHERE id = p_satellite_id' IN v_satellite_award_source) THEN
    RAISE EXCEPTION
      'rolling satellite award lost its target-before-source row-lock order';
  END IF;
  IF v_source IS NULL
     OR (length(v_source)-length(replace(v_source,
          'public.fn_settle_tournament_places(','')))
          / length('public.fn_settle_tournament_places(') <> 1
     OR (length(v_source)-length(replace(v_source,
          'public.fn_settle_tournament_final_table_deal(','')))
          / length('public.fn_settle_tournament_final_table_deal(') <> 1
     OR position('IF v_mode = ''places'' THEN' IN v_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_source) >
          position('SELECT t.* INTO v_t FROM public.tournaments' IN v_source)
     OR position('RETURN public.fn_ca_tournament_terminal_receipt' IN v_source) = 0
     OR position('public.fn_mystery_bounty_settle(' IN v_source) = 0
     OR position('public.fn_finalize_bounty_pool(' IN v_source) = 0
     OR position('public.fn_settle_tournament_rake(' IN v_source) = 0
     OR position('UPDATE public.table_seats' IN v_source) = 0
     OR position('UPDATE public.tables' IN v_source) = 0
     OR position('terminal_closed_at = v_completed_at' IN v_source) = 0
     OR position('ORDER BY tp.user_id,tp.id FOR UPDATE' IN v_source) = 0
     OR position('ORDER BY g.tournament_id FOR UPDATE' IN v_source) = 0
     OR position('PERFORM 1 FROM public.club_wallets' IN v_source) = 0
     OR position('PERFORM 1 FROM public.union_wallets' IN v_source) <
          position('PERFORM 1 FROM public.club_wallets' IN v_source)
     OR position('public.fn_settle_tournament_places(' IN v_source) <
          position('PERFORM 1 FROM public.union_wallets' IN v_source)
     OR position('''deal_shares'',v_deal_shares' IN v_source) = 0
     OR position('INSERT INTO public.tournament_terminal_settlements' IN v_source) = 0
     OR position('SET status = ''COMPLETED''' IN v_source) = 0
     OR v_source LIKE '%EXCEPTION WHEN OTHERS%' THEN
    RAISE EXCEPTION 'terminal authority lost its one-cash, fail-closed or receipt invariant';
  END IF;
  IF v_receipt_source IS NULL
     OR v_receipt_source ~* '\m(insert|update|delete|merge|call|perform)\M'
     OR (SELECT provolatile FROM pg_proc
          WHERE oid = 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure)
          <> 's' THEN
    RAISE EXCEPTION 'terminal replay verifier is not read-only and STABLE';
  END IF;
  IF v_mystery_evidence_source IS NULL
     OR v_mystery_evidence_source ~*
          '\m(insert|update|delete|merge|call|perform)\M'
     OR (SELECT provolatile FROM pg_proc
          WHERE oid =
            'public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)'::regprocedure)
          <> 's'
     OR position('public.fn_ca_mystery_bounty_completion_evidence('
                   IN v_source) = 0
     OR position('public.fn_ca_mystery_bounty_completion_evidence('
                   IN v_receipt_source) = 0
     OR position('v_legacy_credit_cents + v_obligation_cents'
                   IN v_mystery_evidence_source) = 0 THEN
    RAISE EXCEPTION 'mixed-era mystery proof is mutable, absent or not shared';
  END IF;
  IF v_hand_source IS NULL
     OR position('ORDER BY tp.user_id,tp.id' IN v_hand_source) = 0
     OR position('ORDER BY ts.id' IN v_hand_source) <
          position('ORDER BY tp.user_id,tp.id' IN v_hand_source)
     OR position('UPDATE public.tournament_players tp' IN v_hand_source) = 0
     OR position('SET chips = target.stack' IN v_hand_source) = 0
     OR position('''tournament_players_synced''' IN v_hand_source) = 0
     OR position('''tournament_player_chips''' IN v_hand_source) = 0
     OR position('SET left_at = v_zero_stack_vacated_at' IN v_hand_source) = 0
     OR position('SET left_at = v_zero_stack_vacated_at' IN v_hand_source) <
          position('UPDATE public.tournament_players tp' IN v_hand_source)
     OR position('''tournament_zero_stack_seats_vacated'''
                   IN v_hand_source) = 0
     OR position('''tournament_zero_stack_seat_ids'''
                   IN v_hand_source) = 0
     OR position('''tournament_zero_stack_user_ids'''
                   IN v_hand_source) = 0
     OR position('''tournament_zero_stack_seat_generations'''
                   IN v_hand_source) = 0
     OR position('''tournament_zero_stack_vacated_at'''
                   IN v_hand_source) = 0
     OR position('FROM public.wallet_transactions' IN v_hand_source) <> 0
     OR position('v_prev_settled' IN v_hand_source) <> 0
     OR position('v_grants' IN v_hand_source) <> 0
     OR position('v_explained' IN v_hand_source) <> 0
     OR position('paid seat/roster generations must be reloaded before dealing'
                   IN v_hand_source) = 0 THEN
    RAISE EXCEPTION 'hand stack authority lost canonical locks or player-chip sync';
  END IF;
  IF v_hand_core_source IS NULL
     OR position('pg_advisory_xact_lock_shared(' IN v_hand_core_source) = 0
     OR position('ca:tournament-terminal-settlement:v1'
                   IN v_hand_core_source) = 0
     OR position('ca:tournament-terminal-settlement:v1'
                   IN v_hand_core_source) >
          position('atomic-table:' IN v_hand_core_source)
     OR position('WHERE c.table_id=p_table_id' IN v_hand_core_source) = 0
     OR position('WHERE h.table_id=p_table_id' IN v_hand_core_source) = 0
     OR position('IF v_written=0 THEN' IN v_hand_core_source) = 0
     OR position('tournament_zero_stack_seat_generations'
                   IN v_hand_core_source) = 0
     OR position('accepted tournament hand lost exact closed seat generation'
                   IN v_hand_core_source) = 0
     OR position('accepted tournament hand lost exact closed seat generation'
                   IN v_hand_core_source) >
          position('INSERT INTO public.tournament_knockout_candidates('
                     IN v_hand_core_source)
     OR v_hand_commit_source IS NULL
     OR position('v_result->''tournament_zero_stack_seat_generations'''
                   IN v_hand_commit_source) = 0
     OR position('(generation.value->>''seat_id'')::uuid = s.id'
                   IN v_hand_commit_source) = 0
     OR position('(generation.value->>''user_id'')::uuid = s.user_id'
                   IN v_hand_commit_source) = 0
     OR position('(generation.value->>''seat_number'')::integer = s.seat_number'
                   IN v_hand_commit_source) = 0
     OR position('(generation.value->>''joined_at'')::timestamptz = s.joined_at'
                   IN v_hand_commit_source) = 0
     OR position('s.left_at =' IN v_hand_commit_source) = 0
     OR position('s.left_at =' IN v_hand_commit_source) >
          position('(generation.value->>''seat_id'')::uuid = s.id'
                     IN v_hand_commit_source)
     OR has_function_privilege('anon',
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
          'EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
          'EXECUTE')
     OR NOT has_function_privilege('service_role',
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
          'EXECUTE') THEN
    RAISE EXCEPTION
      'accepted-hand authority lost exact zero-seat generation or time-bank proof';
  END IF;
  IF v_mystery_pay_source IS NULL
     OR position('PERFORM 1 FROM public.tournaments t' IN v_mystery_pay_source) = 0
     OR position('PERFORM 1 FROM public.tournaments t' IN v_mystery_pay_source) >
          position('ORDER BY o.kind,o.place NULLS LAST,o.user_id,o.id FOR UPDATE'
            IN v_mystery_pay_source)
     OR position('ORDER BY o.kind,o.place NULLS LAST,o.user_id,o.id FOR UPDATE'
          IN v_mystery_pay_source) = 0
     OR position('ORDER BY c.id FOR UPDATE' IN v_mystery_pay_source) <
          position('ORDER BY o.kind,o.place NULLS LAST,o.user_id,o.id FOR UPDATE'
            IN v_mystery_pay_source)
     OR position('ORDER BY a.id FOR UPDATE' IN v_mystery_pay_source) <
          position('ORDER BY c.id FOR UPDATE' IN v_mystery_pay_source)
     OR position('ORDER BY r.user_id,r.id FOR UPDATE OF r'
          IN v_mystery_pay_source) <
          position('ORDER BY a.id FOR UPDATE' IN v_mystery_pay_source)
     OR position('SELECT * INTO v_a' IN v_mystery_pay_source) = 0
     OR position('SELECT * INTO v_a' IN v_mystery_pay_source) <
          position('ORDER BY r.user_id,r.id FOR UPDATE OF r'
            IN v_mystery_pay_source)
     OR v_mystery_reserve_source IS NULL
     OR position('PERFORM 1 FROM public.tournaments t' IN v_mystery_reserve_source) = 0
     OR position('PERFORM 1 FROM public.tournaments t' IN v_mystery_reserve_source) >
          position('FROM public.tournament_bounty_awards' IN v_mystery_reserve_source) THEN
    RAISE EXCEPTION 'live mystery authorities lost tournament-first lock order';
  END IF;
  IF v_table_guard_source IS NULL
     OR position('TG_OP = ''INSERT''' IN v_table_guard_source) = 0
     OR position('FOR SHARE' IN v_table_guard_source) = 0
     OR position('TG_OP = ''DELETE''' IN v_table_guard_source) = 0
     OR position('terminal_closed_at' IN v_table_guard_source) = 0
     OR position('NEW.id IS DISTINCT FROM OLD.id' IN v_table_guard_source) = 0
     OR position('new table % cannot supply a terminal marker'
                   IN v_table_guard_source) = 0
     OR position('live tournament table % cannot supply a terminal marker'
                   IN v_table_guard_source) = 0
     OR position('unscoped table % cannot supply a terminal marker'
                   IN v_table_guard_source) = 0
     OR position('NEW.current_players IS DISTINCT FROM 0'
                   IN v_table_guard_source) = 0
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.tables'::regclass
          AND c.conname = 'tables_terminal_closed_shape'
          AND c.convalidated
          AND pg_get_constraintdef(c.oid) LIKE
            '%NOT (current_players IS DISTINCT FROM 0)%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid = 'public.tournaments'::regclass
          AND g.tgname = 'non_satellite_completed_requires_terminal_receipt'
          AND g.tgdeferrable AND g.tginitdeferred)
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid = 'public.tables'::regclass
          AND g.tgname = 'tournament_table_terminal_close_is_irreversible') THEN
    RAISE EXCEPTION 'terminal lifecycle or table membership guard is absent';
  END IF;
  IF v_terminal_marker_source IS NULL
     OR position('p_new - ''terminal_closed_at'''
                   IN v_terminal_marker_source) = 0
     OR position('p_old - ''terminal_closed_at'''
                   IN v_terminal_marker_source) = 0
     OR position('isfinite(t.ended_at)' IN v_terminal_marker_source) = 0
     OR position('IS NOT DISTINCT FROM t.ended_at'
                   IN v_terminal_marker_source) = 0
     OR v_terminal_stamp_source IS NULL
     OR position('UPDATE public.tournament_players'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_obligations'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_payouts'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_rake_settlements'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.rake_records'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_bounty_chests'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_bounty_awards'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_guarantee_overlays'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.table_seats'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.wallet_transactions'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_bounty_award_recipients'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.tournament_escrow'
                   IN v_terminal_stamp_source) = 0
     OR position('UPDATE public.spin_reserve_ledger'
                   IN v_terminal_stamp_source) = 0
     OR position('terminal_closed_at IS DISTINCT FROM v_terminal_at'
                   IN v_terminal_stamp_source) = 0
     OR v_terminal_stamp_source LIKE '%EXCEPTION WHEN%'
     OR v_terminal_evidence_guard_source IS NULL
     OR position('v_old_marker IS NOT NULL'
                   IN v_terminal_evidence_guard_source) = 0
     OR position('fn_ca_terminal_marker_transition_is_exact('
                   IN v_terminal_evidence_guard_source) = 0
     OR position('v_old_marker IS NOT NULL'
                   IN v_terminal_evidence_guard_source) >
        position('SELECT upper(COALESCE(t.status::text,''''))'
                   IN v_terminal_evidence_guard_source)
     OR v_terminal_parent_guard_source IS NULL
     OR position('upper(COALESCE(OLD.status::text,'''')) IN'
                   IN v_terminal_parent_guard_source) = 0
     OR position('tournament_terminal_settlements'
                   IN v_terminal_parent_guard_source) <> 0 THEN
    RAISE EXCEPTION
      'terminal tuple-marker transition, stamp or immediate guard is incomplete';
  END IF;
  IF v_receipt_source IS NULL
     OR position('mutable evidence lacks its exact terminal marker'
                   IN v_receipt_source) = 0
     OR position('s.terminal_closed_at IS DISTINCT FROM v_h.completed_at'
                   IN v_receipt_source) = 0
     OR position('x.kind NOT IN (''contribution'',''jackpot_draw'')'
                   IN v_receipt_source) = 0 THEN
    RAISE EXCEPTION
      'terminal replay no longer proves every mutable child marker';
  END IF;
  IF v_satellite_receipt_source IS NULL
     OR position('v_source.ended_at IS DISTINCT FROM v_h.source_closed_at'
                   IN v_satellite_receipt_source) = 0
     OR position('tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at'
                   IN v_satellite_receipt_source) = 0
     OR has_function_privilege('service_role',
          'public.fn_ca_satellite_settlement_receipt(uuid,uuid)','EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_settlements s
         JOIN public.tournaments t ON t.id = s.tournament_id
         CROSS JOIN LATERAL unnest(s.source_table_ids)
           AS source_tables(source_table_id)
         JOIN public.tables tb ON tb.id = source_tables.source_table_id
        WHERE tb.terminal_closed_at IS DISTINCT FROM t.ended_at
     ) THEN
    RAISE EXCEPTION
      'satellite receipt or historical terminal marker is not exact';
  END IF;
  IF v_outcome_source IS NULL
     OR position('pg_advisory_xact_lock(' IN v_outcome_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_outcome_source) >
          position('SELECT t.* INTO v_t FROM public.tournaments' IN v_outcome_source)
     OR position('FOR UPDATE' IN v_outcome_source) <
          position('pg_advisory_xact_lock(' IN v_outcome_source)
     OR position('public.fn_ca_tournament_terminal_receipt(' IN v_outcome_source) = 0
     OR position('''definitively_not_committed'',true' IN v_outcome_source) = 0
     OR position('public.fn_settle_' IN v_outcome_source) <> 0 THEN
    RAISE EXCEPTION 'terminal transport outcome resolver lost serialization or purity';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
      OR has_function_privilege('service_role',
        'public.fn_ca_tournament_terminal_receipt(uuid,uuid)','EXECUTE')
      OR has_function_privilege('service_role',
        'public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)','EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)',
       'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)',
       'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)',
       'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_stamp_tournament_terminal_evidence_markers()','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_stamp_tournament_terminal_evidence_markers()','EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_stamp_tournament_terminal_evidence_markers()','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)','EXECUTE')
     OR has_table_privilege('service_role',
       'public.tournament_terminal_settlements','SELECT')
     OR has_table_privilege('service_role',
       'public.tournament_terminal_settlement_cutover','SELECT') THEN
    RAISE EXCEPTION 'terminal authority has an unsafe function or table ACL';
  END IF;
  IF (SELECT count(*) FROM public.tournament_terminal_settlement_cutover c
       WHERE c.authority = 'fn_complete_tournament_terminal:v1'
         AND c.migration_version = '20260909014534'
         AND c.installed_at >= transaction_timestamp()
         AND c.installed_at <= clock_timestamp()
         AND array_position(c.preexisting_completed_ids, NULL) IS NULL
         AND cardinality(c.preexisting_completed_ids) =
             (SELECT count(DISTINCT captured.id)
                FROM unnest(c.preexisting_completed_ids) captured(id))) <> 1 THEN
    RAISE EXCEPTION 'terminal settlement cutover watermark is not exact';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.fn_terminal_tournament_evidence_is_immutable()'),
           ('public.fn_terminal_tournament_seat_is_immutable()'),
           ('public.fn_receipted_tournament_is_immutable()'),
           ('public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'),
           ('public.fn_stamp_tournament_terminal_evidence_markers()'),
           ('public.fn_ca_has_committed_tournament_receipt(uuid)'),
           ('public.fn_terminal_bounty_recipient_is_immutable()'),
           ('public.fn_terminal_wallet_transaction_is_immutable()'),
           ('public.fn_ca_tournament_id_from_credit_key(text)'),
           ('public.fn_terminal_credit_key_is_immutable()'),
           ('public.fn_terminal_tournament_escrow_is_immutable()'),
           ('public.fn_satellite_target_player_provenance_is_immutable()'),
           ('public.fn_satellite_target_rake_is_immutable()'),
           ('public.fn_satellite_transfer_ledger_is_immutable()')
         ) required(signature)
        WHERE to_regprocedure(required.signature) IS NULL
     ) OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('tournament_players'),
           ('tournament_obligations'),
           ('tournament_payouts'),
           ('tournament_rake_settlements'),
           ('rake_records'),
           ('tournament_bounty_chests'),
           ('tournament_bounty_awards'),
           ('tournament_guarantee_overlays'),
           ('table_seats'),
           ('wallet_transactions'),
           ('tournament_bounty_award_recipients'),
           ('tournament_escrow'),
           ('spin_reserve_ledger')
         ) required(relname)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_attribute a
           WHERE a.attrelid = format('public.%I',required.relname)::regclass
             AND a.attname = 'terminal_closed_at'
             AND a.atttypid = 'timestamptz'::regtype
             AND a.attnum > 0
             AND NOT a.attisdropped
             AND NOT a.attnotnull
             AND a.attidentity = ''
             AND a.attgenerated = ''
             AND a.attacl IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM pg_attrdef d
                WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))
     ) OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'::regprocedure
          AND p.prosecdef AND p.provolatile = 's'
     ) OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure
          AND p.prosecdef
     ) OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
        WHERE p.oid IN (
          'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'::regprocedure,
          'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure)
          AND privilege.privilege_type='EXECUTE'
          AND privilege.grantee<>p.proowner
     ) OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger g
         JOIN pg_attribute a
           ON a.attrelid=g.tgrelid AND a.attname='status'
        WHERE g.tgrelid='public.tournaments'::regclass
          AND g.tgname='stamp_tournament_terminal_evidence_markers'
          AND g.tgfoid=
            'public.fn_stamp_tournament_terminal_evidence_markers()'::regprocedure
          AND NOT g.tgisinternal AND g.tgenabled='O'
          AND g.tgtype=21
          AND g.tgattr::text=a.attnum::text
     ) OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('tables','tournament_table_terminal_close_is_irreversible',
             'public.fn_tournament_table_terminal_close_is_irreversible()',31),
           ('table_seats','terminal_tournament_seat_is_immutable',
             'public.fn_terminal_tournament_seat_is_immutable()',31),
           ('tournaments','receipted_tournament_is_immutable',
             'public.fn_receipted_tournament_is_immutable()',27),
           ('tournament_bounty_award_recipients',
             'terminal_bounty_recipient_is_immutable',
             'public.fn_terminal_bounty_recipient_is_immutable()',31),
           ('wallet_transactions','terminal_wallet_transaction_is_immutable',
             'public.fn_terminal_wallet_transaction_is_immutable()',31),
           ('wallet_credit_idempotency','terminal_credit_key_is_immutable',
             'public.fn_terminal_credit_key_is_immutable()',31),
           ('tournament_escrow','terminal_tournament_escrow_is_immutable',
             'public.fn_terminal_tournament_escrow_is_immutable()',31),
           ('tournament_players','satellite_target_player_provenance_is_immutable',
             'public.fn_satellite_target_player_provenance_is_immutable()',31),
           ('rake_records','satellite_target_rake_is_immutable',
             'public.fn_satellite_target_rake_is_immutable()',31),
           ('chip_ledger','satellite_transfer_ledger_is_immutable',
             'public.fn_satellite_transfer_ledger_is_immutable()',31)
         ) required(relname,trigger_name,function_signature,expected_tgtype)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_trigger g
           WHERE g.tgrelid = format('public.%I',required.relname)::regclass
             AND g.tgname = required.trigger_name
             AND g.tgfoid = to_regprocedure(required.function_signature)
             AND NOT g.tgisinternal AND g.tgenabled = 'O'
             AND g.tgtype=required.expected_tgtype)
     ) OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('tournament_players'),
           ('tournament_obligations'),
           ('tournament_payouts'),
           ('chip_ledger'),
           ('tournament_rake_settlements'),
           ('rake_records'),
           ('tournament_bounty_chests'),
           ('tournament_bounty_awards'),
           ('tournament_guarantee_overlays'),
           ('tournament_satellite_awards'),
           ('tournament_satellite_remainders'),
           ('tournament_refund_entitlements'),
           ('tournament_refund_tranches'),
           ('spin_reserve_ledger'),
           ('tournament_spin_cancellation_unwinds')
         ) required(relname)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_trigger g
           WHERE g.tgrelid=format('public.%I',required.relname)::regclass
             AND g.tgname='terminal_tournament_evidence_is_immutable'
             AND g.tgfoid=
               'public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure
             AND NOT g.tgisinternal AND g.tgenabled='O'
             AND g.tgtype=31 AND g.tgattr::text='')
     ) OR (SELECT count(*)
             FROM pg_trigger g
            WHERE g.tgname = 'terminal_tournament_evidence_is_immutable'
              AND g.tgfoid =
                'public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure
              AND NOT g.tgisinternal AND g.tgenabled='O'
              AND g.tgtype=31 AND g.tgattr::text='') <> 15
       OR EXISTS (
         SELECT 1 FROM pg_trigger g
          WHERE g.tgrelid = 'public.tournaments'::regclass
            AND g.tgname = 'zz_ca_escrow_close'
            AND NOT g.tgisinternal AND g.tgenabled IN ('O','A')) THEN
    RAISE EXCEPTION
      'terminal evidence immutability guards or escrow watcher retirement are incomplete';
  END IF;
END;
$verify_terminal_authority$;

COMMIT;
