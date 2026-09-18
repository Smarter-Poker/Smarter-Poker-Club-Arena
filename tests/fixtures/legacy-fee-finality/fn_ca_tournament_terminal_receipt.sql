CREATE OR REPLACE FUNCTION public.fn_ca_tournament_terminal_receipt(p_tournament_id uuid, p_observed_winner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
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
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF v_h.accounting_state IS DISTINCT FROM COALESCE(v_accounting->>'status','legacy')
     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>2) THEN
    RAISE EXCEPTION 'terminal accounting state has no exact durable receipt' USING ERRCODE='P0404';
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
  -- Match the terminal writer's one-recipient receipt across every verified
  -- partial credit interval. The exact credit-key and total checks still apply.
  IF (SELECT count(DISTINCT p.user_id) FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'bubble_protection') > 1 THEN
    RAISE EXCEPTION 'tournament % has multiple durable bubble payout recipients',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',round(sum(p.amount),2))
    INTO v_durable_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection'
   GROUP BY p.user_id,tp.position;
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
  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    SELECT e.bounty_out INTO v_bounty_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
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
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    -- DIAMOND PHASE 8: a Diamond event's fee is its fee bank, settled to the house.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
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
     OR (v_r.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND NOT v_deferred
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'chip_retirement:%'
              AND NOT (v_h.receipt_version=1 AND v_h.accounting_state='legacy'
                       AND v_r.destination LIKE 'club_treasury:%'))) THEN
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
      'attributed',NOT v_deferred,
      'accounting',v_accounting,
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
$function$
