-- Exact read-only production function definitions captured 2026-09-14 12:29 UTC.
CREATE OR REPLACE FUNCTION public.fn_ca_unit_floor_cents(p_cents bigint, p_unit_cents integer DEFAULT 1)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_cents IS NULL THEN NULL
    WHEN p_cents <= 0 THEN 0
    ELSE (trunc(p_cents::numeric
                / (CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                        THEN p_unit_cents::numeric ELSE 1 END))
          * (CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                  THEN p_unit_cents::numeric ELSE 1 END))::bigint
  END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unit_cents(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id
       AND c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
  ) THEN 100 ELSE 1 END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- DIAMOND PHASE 9: the expected split is taken at the event's unit
  -- (fn_ca_tournament_unit_cents: a cent for a chip event, so every
  -- expression below is what it was; a whole Diamond for a Diamond event).
  -- A mystery chest splits into unit-floored equal shares with the remainder
  -- to the first claimant by user id; a regular or PKO head splits into
  -- unit-floored equal shares with the remainder to the last claimant, and a
  -- PKO cash half is the unit-floored half of the share.
  SELECT COALESCE((
    SELECT CASE WHEN o.mode='mystery_chest' THEN
      EXISTS (
        SELECT 1 FROM public.tournament_bounty_awards a
         WHERE a.bounty_obligation_id=o.id AND a.status='completed'
           AND (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.paid_at IS NOT NULL)=a.amount_cents
           AND NOT EXISTS (
             SELECT 1
               FROM (
                 SELECT claimant_id,ordinal,claimant_count,
                        CASE WHEN u.unit = 1 THEN
                          floor(a.amount_cents / claimant_count)
                            + CASE WHEN ordinal <= mod(a.amount_cents,claimant_count)
                                   THEN 1 ELSE 0 END
                        ELSE
                          public.fn_ca_unit_floor_cents(floor(a.amount_cents / claimant_count)::bigint, u.unit)
                            + CASE WHEN ordinal = 1
                                   THEN a.amount_cents
                                        - public.fn_ca_unit_floor_cents(floor(a.amount_cents / claimant_count)::bigint, u.unit) * claimant_count
                                   ELSE 0 END
                        END AS expected_cents
                   FROM (
                     SELECT (c->>'user_id')::uuid AS claimant_id,
                            row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                            count(*) OVER () AS claimant_count
                       FROM jsonb_array_elements(o.claimants) c
                   ) ordered_claimants
                   CROSS JOIN (SELECT public.fn_ca_tournament_unit_cents(o.tournament_id) AS unit) u
               ) expected
              WHERE NOT EXISTS (
                SELECT 1 FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.user_id=expected.claimant_id
                   AND r.amount_cents=expected.expected_cents
                   AND r.paid_at IS NOT NULL
              )
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_award_recipients r
              WHERE r.award_id=a.id
                AND (r.paid_at IS NULL OR NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(o.claimants) c
                   WHERE (c->>'user_id')::uuid=r.user_id
                ))
           )
      )
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM (
            SELECT claimant_id, ordinal, claimant_count, u.unit,
                   CASE WHEN ordinal < claimant_count
                        THEN public.fn_ca_unit_floor_cents(floor(head_cents / claimant_count)::bigint, u.unit)
                        ELSE head_cents
                             - public.fn_ca_unit_floor_cents(floor(head_cents / claimant_count)::bigint, u.unit) * (claimant_count - 1)
                   END AS expected_cents
              FROM (
                SELECT (c->>'user_id')::uuid AS claimant_id,
                       row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                       count(*) OVER () AS claimant_count,
                       round(o.head_amount * 100)::bigint AS head_cents
                  FROM jsonb_array_elements(o.claimants) c
              ) ordered_claimants
              CROSS JOIN (SELECT public.fn_ca_tournament_unit_cents(o.tournament_id) AS unit) u
          ) expected
         WHERE expected.expected_cents > 0
           AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounties b
            WHERE b.bounty_obligation_id=o.id
              AND b.collector_player_id=expected.claimant_id
              AND round(b.bounty_amount * 100)::bigint=expected.expected_cents
              AND round(COALESCE(b.added_to_collector_bounty,0) * 100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN expected.expected_cents
                              - public.fn_ca_unit_floor_cents(floor(expected.expected_cents/2.0)::bigint, expected.unit)
                         ELSE 0 END
              AND round((b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))*100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN public.fn_ca_unit_floor_cents(floor(expected.expected_cents/2.0)::bigint, expected.unit)
                         ELSE expected.expected_cents END
         )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.claimants) c
              WHERE (c->>'user_id')::uuid=b.collector_player_id
           )
      )
      AND round(COALESCE((
        SELECT sum(b.bounty_amount) FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
      ),0),2)=round(o.head_amount,2)
    END
      FROM public.tournament_bounty_obligations o
     WHERE o.id=p_obligation_id
  ),false);
$function$;

CREATE OR REPLACE FUNCTION public.fn_collect_bounty(p_tournament_id uuid, p_eliminated_user_id uuid, p_collector_user_id uuid, p_claimants jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
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

    /* A BUST BELONGS TO THE PHASE ITS HAND WAS PLAYED IN (2026-09-11). A
       persisted mystery_pre obligation is a head earned before activation;
       the seed keeps it outside the chest pool, so it is paid from the
       regular half after the chests open. Refusing it only strands it. */
    IF COALESCE(v_t.is_mystery_bounty, false)
       AND v_t.mystery_bounty_stage = 'active'
       AND o.mode IS DISTINCT FROM 'mystery_pre' THEN
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
    -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row;
    -- the bank is what the entries put in less what it already paid.
    IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
      SELECT e.bounty_balance INTO v_available
        FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
    END IF;

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
        IF v_share_cents > 0 THEN
          v_share_cents := public.fn_ca_unit_floor_cents(
            v_share_cents::bigint,
            public.fn_ca_tournament_unit_cents(p_tournament_id))::integer;
        END IF;
      ELSE
        v_share_cents := v_cents - v_assigned_cents;
      END IF;
      v_assigned_cents := v_assigned_cents + v_share_cents;
      CONTINUE WHEN v_share_cents <= 0;

      IF v_mode = 'pko' THEN
        v_cash_cents := public.fn_ca_unit_floor_cents(
          (v_share_cents / 2)::bigint,
          public.fn_ca_tournament_unit_cents(p_tournament_id))::integer;
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

CREATE OR REPLACE FUNCTION public.fn_collect_bounty_obligation(p_obligation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_prior_context text := current_setting('app.bounty_obligation_id',true);
  v_result jsonb;
BEGIN
  SELECT * INTO o FROM public.tournament_bounty_obligations WHERE id=p_obligation_id;
  IF NOT FOUND OR o.mode='mystery_chest' THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_found');
  END IF;
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);
  v_result := public.fn_collect_bounty(
    o.tournament_id,o.eliminated_user_id,o.knocker_user_id,o.claimants);
  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb) TO service_role;
