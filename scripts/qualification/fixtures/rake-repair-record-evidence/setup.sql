-- SOURCE ONLY / UNRUN. Minimal caller model; actual atomic definition is loaded
-- only for guard qualification. Functional cases use an explicitly labeled spy.
CREATE TABLE public.hand_history(id uuid PRIMARY KEY,table_id uuid,rake_amount numeric,bbj_amount numeric,pot_size numeric,created_at timestamptz,tournament_id uuid,hand_number bigint);
CREATE TABLE public.tables(id uuid PRIMARY KEY,club_id uuid,tournament_id uuid);
CREATE TABLE public.rake_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),hand_id uuid,table_id uuid,metadata jsonb,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX uq_rake_records_hand_id ON public.rake_records(hand_id) WHERE hand_id IS NOT NULL;
CREATE TABLE public.rake_distribution_legs(leg_key uuid,leg text,amount numeric,created_at timestamptz DEFAULT now(),PRIMARY KEY(leg_key,leg));
CREATE TABLE public.pending_fee_distributions(hand_id uuid,hand_number bigint,resolved_at timestamptz,kind text);
CREATE TABLE public.ca_guard_defs(proname text PRIMARY KEY);
CREATE TABLE public.financial_alerts(
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  severity text NOT NULL,
  source text NOT NULL,
  message text NOT NULL,
  context jsonb DEFAULT '{}'::jsonb,
  resolved boolean DEFAULT false NOT NULL,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_by uuid,
  resolution text
);

CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_guard_watchlist() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_watchlist() TO service_role;

CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT (NULL::numeric)::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid, p_returned_uncalled jsonb DEFAULT NULL::jsonb, p_rake_method text DEFAULT 'DEALT_EQUAL'::text)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_union_id     uuid;
  v_g_union      uuid;
  v_is_private   boolean := false;
  v_club_name    text;
  v_net          numeric;
  v_bbj          numeric := COALESCE(p_bbj, 0);
  v_rr_id        uuid;
  v_first_claim  boolean := false;
  v_recovered    boolean := false;
  v_leg_key      uuid;
  v_n            integer;
  v_cw_after     numeric;
  v_union_rake   numeric;
  v_route        text;
  v_method       text;
  v_alloc_sum    numeric;
  v_st           text;
  v_msg          text;
  v_dup_id       uuid;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,
                        NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  /* ZERO-DRIFT (2026-08-31): declare the ledger context for this transaction
     so every auto-journaled balance delta below is categorized as rake coming
     off the felt, not an anonymous adjustment against suspense. */
  PERFORM set_config('app.ledger_category', 'rake', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);
  -- PHASE 6.4 (2026-09-05): the rake's legs name the hand when it is known.
  PERFORM set_config('app.ledger_hand_id', COALESCE(p_hand_id::text, ''), true);

  v_method := CASE WHEN p_rake_method = 'WEIGHTED_CONTRIBUTED'
                   THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END;

  v_net := p_rake - v_bbj;

  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;

  -- UNION LAW (Dan, restored 2026-08-30): route by the GAME's union stamp,
  -- not club membership. A private club game's rake NEVER touches the union.
  IF p_table_id IS NOT NULL THEN
    SELECT COALESCE(t.is_private, false), t.union_id
      INTO v_is_private, v_g_union
      FROM public.tables t WHERE t.id = p_table_id;
  END IF;
  IF p_tournament_id IS NOT NULL AND NOT v_is_private AND v_g_union IS NULL THEN
    SELECT COALESCE(tr.is_private, false), tr.union_id
      INTO v_is_private, v_g_union
      FROM public.tournaments tr WHERE tr.id = p_tournament_id;
  END IF;

  IF v_is_private THEN
    v_union_id := NULL;
  ELSE
    v_union_id := v_g_union;
    IF v_union_id IS NULL THEN
      SELECT c.union_id INTO v_union_id FROM public.clubs c WHERE c.id = p_club_id;
    END IF;
  END IF;

  /* A HAND THAT CANNOT NAME ITSELF BY ID STILL NAMES ITSELF BY TABLE AND
     NUMBER (2026-09-06). Both idempotency guards below key on p_hand_id, and
     both are disabled when it is NULL: ON CONFLICT (hand_id) WHERE hand_id IS
     NOT NULL matches nothing, and v_leg_key fell back to a FRESH RANDOM uuid,
     so rake_distribution_legs could not dedupe either. The engine calls this
     before logHandHistory has produced a hand row and again after, and the
     second call was treated as a new hand: a duplicate rake_records row, and
     a second increment of the club wallet's period and lifetime rake. 4,452
     such rows exist, 2026-04-16 to 2026-09-05, carrying 16,426.46 of rake and
     2,068.82 of BBJ contribution that no hand ever dropped - measured against
     hand_history and bbj_contributions, which agree with the LINKED rows alone
     in 283 of the 284 cases where the hand still exists.

     So: ask hand_history for the id first, and if it genuinely is not there
     yet, key on what the caller always knows - the table and the hand number. */
  IF p_hand_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
    SELECT h.id INTO p_hand_id
      FROM public.hand_history h
     WHERE h.table_id = p_table_id
       AND h.hand_number = p_hand_number
     ORDER BY h.created_at DESC
     LIMIT 1;
    -- Phase 6.4: the legs name the hand as soon as we know it.
    PERFORM set_config('app.ledger_hand_id', COALESCE(p_hand_id::text, ''), true);
  END IF;

  IF p_hand_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
    SELECT rr.id INTO v_dup_id
      FROM public.rake_records rr
     WHERE rr.table_id = p_table_id
       AND rr.hand_id IS NULL
       AND (rr.metadata->>'hand_number') = p_hand_number::text
       AND rr.created_at > now() - interval '2 days'
     ORDER BY rr.created_at
     LIMIT 1;
    IF v_dup_id IS NOT NULL THEN
      RETURN QUERY SELECT false, true, false, v_dup_id, 0::numeric,
                          NULL::text, 0::numeric, v_union_id;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source,
    metadata, rake_method, returned_uncalled
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number, 'is_private', v_is_private),
    v_method, p_returned_uncalled
  )
  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_rr_id;

  IF v_rr_id IS NOT NULL THEN
    v_first_claim := true;
  ELSE
    SELECT id INTO v_rr_id FROM public.rake_records
      WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
  END IF;

  IF v_first_claim AND p_hand_id IS NOT NULL
     AND p_contributions IS NOT NULL AND jsonb_typeof(p_contributions) = 'object' THEN
    INSERT INTO public.rake_attributions (
      hand_id, player_id, rake_amount, rake_record_id, table_id, club_id,
      gross_contribution, returned_uncalled, eligible_contribution,
      contribution_weight, weighted_rake_credit, bbj_attributed_contribution,
      rake_method
    )
    SELECT p_hand_id,
           a.user_id,
           a.credit,
           v_rr_id, p_table_id,
           COALESCE((SELECT ts.club_id FROM public.table_seats ts
                      WHERE ts.table_id = p_table_id AND ts.user_id = a.user_id
                      ORDER BY ts.joined_at DESC NULLS LAST LIMIT 1), p_club_id),
           (p_contributions ->> a.user_id::text)::numeric
             + COALESCE((p_returned_uncalled ->> a.user_id::text)::numeric, 0),
           COALESCE((p_returned_uncalled ->> a.user_id::text)::numeric, 0),
           (p_contributions ->> a.user_id::text)::numeric,
           a.weight,
           a.credit,
           COALESCE(b.credit, 0),
           v_method
      FROM public.fn_allocate_rake_credits(p_rake, p_contributions, v_method) a
      LEFT JOIN public.fn_allocate_rake_credits(v_bbj, p_contributions, v_method) b
        ON b.user_id = a.user_id
    ON CONFLICT (hand_id, player_id) DO NOTHING;

    SELECT COALESCE(SUM(a.credit), 0) INTO v_alloc_sum
      FROM public.fn_allocate_rake_credits(p_rake, p_contributions, v_method) a;
    IF v_alloc_sum <> round(p_rake, 2) AND v_alloc_sum <> 0 THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('critical', 'atomic_distribute_rake', 'RAKE_ALLOCATION_MISMATCH',
        jsonb_build_object('hand_id', p_hand_id, 'rake', p_rake,
          'allocated', v_alloc_sum, 'method', v_method));
    END IF;
  END IF;

  /* THE LEG KEY IS DERIVED, NEVER RANDOM (2026-09-06). A random key made
     rake_distribution_legs' ON CONFLICT (leg_key, leg) unreachable, so the
     club wallet's period and lifetime rake were incremented again for a hand
     already counted. When the hand has no id, the key is the table and the
     hand number - the same hand always produces the same key. */
  v_leg_key := COALESCE(
    p_hand_id,
    CASE WHEN p_table_id IS NOT NULL AND p_hand_number IS NOT NULL
         THEN md5('rake:' || p_table_id::text || ':' || p_hand_number::text)::uuid
    END,
    gen_random_uuid());
  PERFORM set_config('app.ledger_settlement', 'rake:' || v_leg_key::text, true);

  INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
  VALUES (v_leg_key, 'club_accumulator', p_club_id, v_union_id, v_net)
  ON CONFLICT (leg_key, leg) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    UPDATE public.club_wallets
       SET period_rake_collected     = period_rake_collected     + p_rake,
           period_bbj_contribution   = period_bbj_contribution   + v_bbj,
           lifetime_rake_collected   = lifetime_rake_collected   + p_rake,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj,
           chip_balance              = chip_balance,  -- 2026-09-02 ruling: the club share is paid weekly from the rake treasury, not per hand
           updated_at                = NOW()
     WHERE club_id = p_club_id
     RETURNING chip_balance INTO v_cw_after;

    IF v_cw_after IS NULL THEN
      INSERT INTO public.club_wallets (
        club_id, chip_balance, period_rake_collected, period_bbj_contribution,
        lifetime_rake_collected, lifetime_bbj_contribution
      ) VALUES (
        p_club_id, 0, p_rake, v_bbj, p_rake, v_bbj
      )
      ON CONFLICT (club_id) DO UPDATE SET
        period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,
        period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,
        lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,
        lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,
        chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,
        updated_at                = NOW()
      RETURNING chip_balance INTO v_cw_after;
    END IF;

    INSERT INTO public.club_wallet_transactions (
      club_id, type, amount, balance_after, related_id, reason
    ) VALUES (
      p_club_id, 'rake_in', v_net, v_cw_after, p_hand_id,
      'Rake collected (hand ' || COALESCE('#' || p_hand_number::text, 'unknown') ||
        ', BBJ contribution ' || v_bbj::text || ')'
    );

    IF NOT v_first_claim THEN v_recovered := true; END IF;
  END IF;

  IF v_union_id IS NOT NULL THEN
    v_route := 'union_rake_wallet';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'union_rake', p_club_id, v_union_id, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      -- UNION LAW (restored 2026-08-30): RAKE TREASURY ONLY. chip_balance
      -- (Union Bank) is deliberately NOT touched.
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
           VALUES (v_union_id, 0, p_rake, p_rake)
      ON CONFLICT (union_id) DO UPDATE SET
           rake_wallet          = public.union_wallets.rake_wallet + p_rake,
           total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_rake,
           updated_at           = NOW()
      RETURNING rake_wallet INTO v_union_rake;

      INSERT INTO public.union_wallet_transactions (
        union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes
      ) VALUES (
        v_union_id, p_club_id, p_rake, 'rake', 'rake_wallet', 'credit', v_union_rake,
        'Cash game rake: hand #' || COALESCE(p_hand_number::text, '?') ||
          ' (' || COALESCE(v_club_name, 'club') || ')'
      );

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  ELSE
    v_route := 'club_chip_treasury';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'chip_treasury', p_club_id, NULL, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      /* ZERO-DRIFT: this leg writes its own chip_ledger row below; suppress
         the clubs auto-journal for this one statement. */
      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs
         SET chip_treasury = COALESCE(chip_treasury, 0) + p_rake,
             total_rake    = COALESCE(total_rake, 0) + p_rake,
             updated_at    = NOW()
       WHERE id = p_club_id;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

      /* JOURNAL THE TREASURY LEG (2026-08-31). Inside the leg_key first-claim
         guard, so a replayed hand credits once and journals once. Journal failure rolls back this distribution. */
      BEGIN
        INSERT INTO public.chip_ledger
          (performed_by, from_type, from_entity_id, to_type, to_entity_id,
           amount, category, club_id, table_id, hand_id, tournament_id, description)
        VALUES (
          COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
          'table_stack',   p_table_id,
          'club_treasury', p_club_id,
          p_rake, 'rake', p_club_id, p_table_id, p_hand_id, p_tournament_id,
          'Rake to club treasury, hand ' || COALESCE('#' || p_hand_number::text, 'unknown')
            || ' (atomic_distribute_rake)');
      EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      v_net, v_route, p_rake, v_union_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_rake_repair_unbanked(p_since_hours integer DEFAULT 48, p_limit integer DEFAULT 200)
 RETURNS TABLE(hand_id uuid, club_id uuid, amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '540s'
AS $function$
DECLARE
  r record;
  v_repaired int := 0;
  v_chips numeric := 0;
BEGIN
  FOR r IN
    SELECT hh.id AS h_id, hh.table_id, t.club_id AS c_id, hh.hand_number,
           hh.rake_amount, COALESCE(hh.bbj_amount, 0) AS bbj, hh.pot_size,
           hh.created_at AS h_at,
           CASE WHEN hh.created_at >= '2026-08-29 14:41+00'::timestamptz
                THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END AS method
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.tournament_id IS NULL
       AND t.tournament_id IS NULL
       AND hh.rake_amount > 0
       AND hh.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_since_hours, 48), 1))
       AND hh.created_at < now() - interval '5 minutes'
       AND t.club_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = hh.id)
       -- time-bounded so the probe rides the created_at index: a hand's rake
       -- row is written within minutes (re-drives within hours) of the hand
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr2
                        WHERE rr2.table_id = hh.table_id
                          AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                 AND hh.created_at + interval '12 hours'
                          AND rr2.metadata->>'hand_number' = hh.hand_number::text)
       AND NOT EXISTS (SELECT 1 FROM public.pending_fee_distributions p
                        WHERE p.resolved_at IS NULL AND p.kind = 'rake'
                          AND (p.hand_id = hh.id OR p.hand_number = hh.hand_number))
     ORDER BY hh.created_at
     LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  LOOP
    BEGIN
      PERFORM public.atomic_distribute_rake(
        r.table_id, r.c_id, r.h_id, r.hand_number::integer, r.rake_amount,
        r.bbj, r.pot_size, NULL, NULL, NULL, NULL, r.method);
      v_repaired := v_repaired + 1;
      v_chips := v_chips + r.rake_amount;
      hand_id := r.h_id; club_id := r.c_id; amount := r.rake_amount;
      RETURN NEXT;
    EXCEPTION WHEN others THEN
      NULL; -- next cycle retries; the candidate predicate re-evaluates
    END;
  END LOOP;

  IF v_repaired > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at)
    VALUES (CASE WHEN v_chips > 50 THEN 'warning' ELSE 'info' END,
            'fn_rake_repair_unbanked',
            'Recovered ' || v_repaired || ' unbanked rake hand(s) totalling ' ||
              round(v_chips, 2) || ' chips (engine did not survive to bank them). ' ||
              'Attribution not invented: contributions were lost with the engine.',
            jsonb_build_object('repaired', v_repaired, 'chips', round(v_chips, 2)),
            (v_chips <= 50), CASE WHEN v_chips <= 50 THEN now() ELSE NULL END);
  END IF;

  RETURN;
END $function$;
REVOKE ALL ON FUNCTION public.fn_rake_repair_unbanked(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_repair_unbanked(integer,integer) TO service_role;

CREATE TEMP TABLE qualification_received_40522(payload jsonb NOT NULL);
INSERT INTO qualification_received_40522 VALUES($original$[{"rake_record_id":"0054df8f-ebf1-4cfc-bee8-eb80a2238266","hand_id":"96b0e5d3-3dc2-4104-aed8-f5fc6f9af316","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4188349,"rake_amount":0.11,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.11,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"96b0e5d3-3dc2-4104-aed8-f5fc6f9af316","union_id":null,"created_at":"2026-09-01T10:06:09.298839+00:00"},{"leg":"club_accumulator","amount":0.05,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"96b0e5d3-3dc2-4104-aed8-f5fc6f9af316","union_id":null,"created_at":"2026-09-01T10:06:09.298839+00:00"}]},{"rake_record_id":"041d001c-f24d-49c1-9895-f1cc7833537d","hand_id":"fd573788-fb75-4713-a9f9-237bc60052e9","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4192755,"rake_amount":5,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"fd573788-fb75-4713-a9f9-237bc60052e9","union_id":null,"created_at":"2026-09-01T10:19:41.061547+00:00"},{"leg":"club_accumulator","amount":4.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"fd573788-fb75-4713-a9f9-237bc60052e9","union_id":null,"created_at":"2026-09-01T10:19:41.061547+00:00"}]},{"rake_record_id":"12f74216-723a-4a75-aa3b-e5bc2480db0e","hand_id":"11e09b32-274d-4408-9978-bf29798ac4ce","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4195218,"rake_amount":0.8,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.8,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"11e09b32-274d-4408-9978-bf29798ac4ce","union_id":null,"created_at":"2026-09-01T10:29:23.557972+00:00"},{"leg":"club_accumulator","amount":0.3,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"11e09b32-274d-4408-9978-bf29798ac4ce","union_id":null,"created_at":"2026-09-01T10:29:23.557972+00:00"}]},{"rake_record_id":"1652ac09-65e2-47aa-8c22-68ef2d8378f6","hand_id":"05484087-6f9c-479c-9f93-501dc44135b7","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4197308,"rake_amount":0.17,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.17,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"05484087-6f9c-479c-9f93-501dc44135b7","union_id":null,"created_at":"2026-09-01T10:39:34.223442+00:00"},{"leg":"club_accumulator","amount":0.11,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"05484087-6f9c-479c-9f93-501dc44135b7","union_id":null,"created_at":"2026-09-01T10:39:34.223442+00:00"}]},{"rake_record_id":"1790afc6-2229-4441-bf16-b145abde5a1c","hand_id":"591d3548-cb04-497d-b7f9-b042e7a31588","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4198022,"rake_amount":3.35,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":3.35,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"591d3548-cb04-497d-b7f9-b042e7a31588","union_id":null,"created_at":"2026-09-01T10:41:50.357585+00:00"},{"leg":"club_accumulator","amount":2.85,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"591d3548-cb04-497d-b7f9-b042e7a31588","union_id":null,"created_at":"2026-09-01T10:41:50.357585+00:00"}]},{"rake_record_id":"1a70c0fc-c8e2-4e3c-acbb-2d3fa96f1322","hand_id":"19923559-bbfb-40d0-ac91-cb82007b0cff","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4202277,"rake_amount":0.6,"bbj_amount":0,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.6,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"19923559-bbfb-40d0-ac91-cb82007b0cff","union_id":null,"created_at":"2026-09-01T10:56:02.074945+00:00"},{"leg":"club_accumulator","amount":0.6,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"19923559-bbfb-40d0-ac91-cb82007b0cff","union_id":null,"created_at":"2026-09-01T10:56:02.074945+00:00"}]},{"rake_record_id":"2041ee69-e515-4e88-a3f8-09c47f301d27","hand_id":"09ef1203-c5c1-4075-a0b1-606300897f15","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4198736,"rake_amount":1.8,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1.8,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"09ef1203-c5c1-4075-a0b1-606300897f15","union_id":null,"created_at":"2026-09-01T10:44:12.1499+00:00"},{"leg":"club_accumulator","amount":1.3,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"09ef1203-c5c1-4075-a0b1-606300897f15","union_id":null,"created_at":"2026-09-01T10:44:12.1499+00:00"}]},{"rake_record_id":"24570861-0159-4fae-8873-50808555139c","hand_id":"2f913d7c-bf32-441f-8371-ac101eb52afd","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4202779,"rake_amount":5,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"2f913d7c-bf32-441f-8371-ac101eb52afd","union_id":null,"created_at":"2026-09-01T11:01:01.786035+00:00"},{"leg":"club_accumulator","amount":4.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"2f913d7c-bf32-441f-8371-ac101eb52afd","union_id":null,"created_at":"2026-09-01T11:01:01.786035+00:00"}]},{"rake_record_id":"26ddf8c8-f1e5-4a0d-bf52-53fce12e7553","hand_id":"73cbf101-36fe-42ac-9a6f-e5baaa6981f0","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4193356,"rake_amount":0.66,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.66,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"73cbf101-36fe-42ac-9a6f-e5baaa6981f0","union_id":null,"created_at":"2026-09-01T10:21:47.557361+00:00"},{"leg":"club_accumulator","amount":0.6,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"73cbf101-36fe-42ac-9a6f-e5baaa6981f0","union_id":null,"created_at":"2026-09-01T10:21:47.557361+00:00"}]},{"rake_record_id":"2706e173-23f4-41ae-959b-f86bcf799420","hand_id":"37e02999-7040-4ca9-b948-8c234aa4efd8","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4192396,"rake_amount":0.8,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.8,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"37e02999-7040-4ca9-b948-8c234aa4efd8","union_id":null,"created_at":"2026-09-01T10:17:24.532412+00:00"},{"leg":"club_accumulator","amount":0.3,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"37e02999-7040-4ca9-b948-8c234aa4efd8","union_id":null,"created_at":"2026-09-01T10:17:24.532412+00:00"}]},{"rake_record_id":"295dffd9-efd2-4f83-96d6-8e08dd113916","hand_id":"5d4b988d-ba45-4189-9cce-cfcba4455f7f","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4190749,"rake_amount":2,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":2,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"5d4b988d-ba45-4189-9cce-cfcba4455f7f","union_id":null,"created_at":"2026-09-01T10:12:28.809848+00:00"},{"leg":"club_accumulator","amount":1.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"5d4b988d-ba45-4189-9cce-cfcba4455f7f","union_id":null,"created_at":"2026-09-01T10:12:28.809848+00:00"}]},{"rake_record_id":"2ca840c2-848b-41ed-b4f6-1d6203357fcc","hand_id":"fe1046d5-b64a-4b84-84df-c0485ae717aa","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4195780,"rake_amount":0.12,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.12,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"fe1046d5-b64a-4b84-84df-c0485ae717aa","union_id":null,"created_at":"2026-09-01T10:32:38.166654+00:00"},{"leg":"club_accumulator","amount":0.06,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"fe1046d5-b64a-4b84-84df-c0485ae717aa","union_id":null,"created_at":"2026-09-01T10:32:38.166654+00:00"}]},{"rake_record_id":"2cb9db12-099f-4e47-9bb3-baf98b744d19","hand_id":"8e7c4cf0-444e-4e33-a132-b0614f5aa79b","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4188538,"rake_amount":1.5,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"8e7c4cf0-444e-4e33-a132-b0614f5aa79b","union_id":null,"created_at":"2026-09-01T10:06:40.643748+00:00"},{"leg":"club_accumulator","amount":1,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"8e7c4cf0-444e-4e33-a132-b0614f5aa79b","union_id":null,"created_at":"2026-09-01T10:06:40.643748+00:00"}]},{"rake_record_id":"35c2800e-4b1e-4872-9bdd-6d254356e0f4","hand_id":"ca218545-29d3-40d7-98cb-172ca28718dc","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4189410,"rake_amount":5,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"ca218545-29d3-40d7-98cb-172ca28718dc","union_id":null,"created_at":"2026-09-01T10:09:49.566601+00:00"},{"leg":"club_accumulator","amount":4.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"ca218545-29d3-40d7-98cb-172ca28718dc","union_id":null,"created_at":"2026-09-01T10:09:49.566601+00:00"}]},{"rake_record_id":"3efda297-0d86-4cb1-8006-dec407e102f1","hand_id":"37dbdb4c-3b09-46be-9069-f6be2e3d8e6e","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4193979,"rake_amount":3.35,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":3.35,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"37dbdb4c-3b09-46be-9069-f6be2e3d8e6e","union_id":null,"created_at":"2026-09-01T10:24:13.707191+00:00"},{"leg":"club_accumulator","amount":2.85,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"37dbdb4c-3b09-46be-9069-f6be2e3d8e6e","union_id":null,"created_at":"2026-09-01T10:24:13.707191+00:00"}]},{"rake_record_id":"4cbef808-061a-4603-8b90-39386693be84","hand_id":"0a6ba2b7-25cb-4c05-b0cc-3cf67462554c","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4191275,"rake_amount":0.56,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.56,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"0a6ba2b7-25cb-4c05-b0cc-3cf67462554c","union_id":null,"created_at":"2026-09-01T10:14:19.268691+00:00"},{"leg":"club_accumulator","amount":0.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"0a6ba2b7-25cb-4c05-b0cc-3cf67462554c","union_id":null,"created_at":"2026-09-01T10:14:19.268691+00:00"}]},{"rake_record_id":"5142af7d-a41d-4131-a9b5-0c154aca27b2","hand_id":"380e993b-d993-4209-a02a-a60acc4505d4","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4195592,"rake_amount":0.08,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.08,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"380e993b-d993-4209-a02a-a60acc4505d4","union_id":null,"created_at":"2026-09-01T10:31:11.930942+00:00"},{"leg":"club_accumulator","amount":0.02,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"380e993b-d993-4209-a02a-a60acc4505d4","union_id":null,"created_at":"2026-09-01T10:31:11.930942+00:00"}]},{"rake_record_id":"5779f955-6c89-4500-9d08-5ab67c6b68d5","hand_id":"d30d294d-8762-4f28-88c0-6d5cd2d186ba","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4189951,"rake_amount":0.15,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.15,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"d30d294d-8762-4f28-88c0-6d5cd2d186ba","union_id":null,"created_at":"2026-09-01T10:10:35.073038+00:00"},{"leg":"club_accumulator","amount":0.09,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"d30d294d-8762-4f28-88c0-6d5cd2d186ba","union_id":null,"created_at":"2026-09-01T10:10:35.073038+00:00"}]},{"rake_record_id":"5ad69cc1-a613-4aee-9626-35db55b25a86","hand_id":"bca165cb-c5e2-4f07-83c5-520d0b0ae87b","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4202603,"rake_amount":1.3,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1.3,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"bca165cb-c5e2-4f07-83c5-520d0b0ae87b","union_id":null,"created_at":"2026-09-01T10:58:52.150293+00:00"},{"leg":"club_accumulator","amount":0.8,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"bca165cb-c5e2-4f07-83c5-520d0b0ae87b","union_id":null,"created_at":"2026-09-01T10:58:52.150293+00:00"}]},{"rake_record_id":"5be93a96-2357-4ad8-ad6f-89dfe3d95dd5","hand_id":"eeb212c2-178c-46be-af22-39cfd3165820","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4187701,"rake_amount":2.4,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":2.4,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"eeb212c2-178c-46be-af22-39cfd3165820","union_id":null,"created_at":"2026-09-01T10:03:36.308412+00:00"},{"leg":"club_accumulator","amount":1.9,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"eeb212c2-178c-46be-af22-39cfd3165820","union_id":null,"created_at":"2026-09-01T10:03:36.308412+00:00"}]},{"rake_record_id":"623535e0-8693-4fc7-ab14-cb4b64790614","hand_id":"d706a7a3-69b7-4a86-99e2-be326967b9ce","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4196054,"rake_amount":1.5,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"d706a7a3-69b7-4a86-99e2-be326967b9ce","union_id":null,"created_at":"2026-09-01T10:34:25.204021+00:00"},{"leg":"club_accumulator","amount":1.44,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"d706a7a3-69b7-4a86-99e2-be326967b9ce","union_id":null,"created_at":"2026-09-01T10:34:25.204021+00:00"}]},{"rake_record_id":"683883ee-40e6-4268-aa1e-634588ccfa09","hand_id":"134dccb4-63ea-455c-aa6b-89f42d42b91f","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4200315,"rake_amount":0.9,"bbj_amount":0,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.9,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"134dccb4-63ea-455c-aa6b-89f42d42b91f","union_id":null,"created_at":"2026-09-01T10:49:51.252728+00:00"},{"leg":"club_accumulator","amount":0.9,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"134dccb4-63ea-455c-aa6b-89f42d42b91f","union_id":null,"created_at":"2026-09-01T10:49:51.252728+00:00"}]},{"rake_record_id":"689bde3c-6f2f-44c1-9d9b-b327c5291a62","hand_id":"7864b947-57af-4c35-b224-4ae6af454916","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4191598,"rake_amount":0.08,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.08,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"7864b947-57af-4c35-b224-4ae6af454916","union_id":null,"created_at":"2026-09-01T10:15:28.907547+00:00"},{"leg":"club_accumulator","amount":0.02,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"7864b947-57af-4c35-b224-4ae6af454916","union_id":null,"created_at":"2026-09-01T10:15:28.907547+00:00"}]},{"rake_record_id":"6f3d95a9-c07a-496e-87dc-f3236b0f8b76","hand_id":"c62bbaad-2e1e-4025-b231-55c669a33dbb","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4202752,"rake_amount":0.11,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.11,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"c62bbaad-2e1e-4025-b231-55c669a33dbb","union_id":null,"created_at":"2026-09-01T11:00:34.203726+00:00"},{"leg":"club_accumulator","amount":0.05,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"c62bbaad-2e1e-4025-b231-55c669a33dbb","union_id":null,"created_at":"2026-09-01T11:00:34.203726+00:00"}]},{"rake_record_id":"7115b48f-09fc-4c72-a7bb-6bd03d782e1c","hand_id":"baf0add9-f37c-4d18-b38b-e5523d7f48e4","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4188968,"rake_amount":5,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"baf0add9-f37c-4d18-b38b-e5523d7f48e4","union_id":null,"created_at":"2026-09-01T10:07:56.096647+00:00"},{"leg":"club_accumulator","amount":4.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"baf0add9-f37c-4d18-b38b-e5523d7f48e4","union_id":null,"created_at":"2026-09-01T10:07:56.096647+00:00"}]},{"rake_record_id":"72f59cee-29cd-4ca9-9665-e3eacb4f7939","hand_id":"0b18aee0-7df8-4bd0-9b63-b69c920758d1","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4199282,"rake_amount":1.8,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1.8,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"0b18aee0-7df8-4bd0-9b63-b69c920758d1","union_id":null,"created_at":"2026-09-01T10:46:21.501839+00:00"},{"leg":"club_accumulator","amount":1.3,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"0b18aee0-7df8-4bd0-9b63-b69c920758d1","union_id":null,"created_at":"2026-09-01T10:46:21.501839+00:00"}]},{"rake_record_id":"764344fb-736e-4248-8c2e-30eb98ab970b","hand_id":"2735eba2-6ff5-4859-b4c3-8b008a709d48","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4191868,"rake_amount":5,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"2735eba2-6ff5-4859-b4c3-8b008a709d48","union_id":null,"created_at":"2026-09-01T10:16:49.387375+00:00"},{"leg":"club_accumulator","amount":4.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"2735eba2-6ff5-4859-b4c3-8b008a709d48","union_id":null,"created_at":"2026-09-01T10:16:49.387375+00:00"}]},{"rake_record_id":"7648dd53-1101-4088-8f85-2754bb7e469d","hand_id":"ee9b44c9-701b-46a6-9a19-d84d36e343ba","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4197627,"rake_amount":1.5,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"ee9b44c9-701b-46a6-9a19-d84d36e343ba","union_id":null,"created_at":"2026-09-01T10:41:09.447208+00:00"},{"leg":"club_accumulator","amount":1.44,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"ee9b44c9-701b-46a6-9a19-d84d36e343ba","union_id":null,"created_at":"2026-09-01T10:41:09.447208+00:00"}]},{"rake_record_id":"775ea5fa-0678-4c99-a0cd-e33317974977","hand_id":"011fa6db-3947-4524-9355-02dddf98a58d","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4197141,"rake_amount":0.2,"bbj_amount":0,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.2,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"011fa6db-3947-4524-9355-02dddf98a58d","union_id":null,"created_at":"2026-09-01T10:38:23.451249+00:00"},{"leg":"club_accumulator","amount":0.2,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"011fa6db-3947-4524-9355-02dddf98a58d","union_id":null,"created_at":"2026-09-01T10:38:23.451249+00:00"}]},{"rake_record_id":"79f3c139-3d09-433d-8303-444d4a9deba0","hand_id":"f5be1989-1240-43b3-9fe1-4be7dd8320bf","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4193751,"rake_amount":2.6,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":2.6,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"f5be1989-1240-43b3-9fe1-4be7dd8320bf","union_id":null,"created_at":"2026-09-01T10:22:17.604997+00:00"},{"leg":"club_accumulator","amount":2.1,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"f5be1989-1240-43b3-9fe1-4be7dd8320bf","union_id":null,"created_at":"2026-09-01T10:22:17.604997+00:00"}]},{"rake_record_id":"82ef74fe-d742-458b-a01d-14eae118c5e6","hand_id":"d2e27a86-4429-4d32-84dd-eab10926789e","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4190796,"rake_amount":0.04,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.04,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"d2e27a86-4429-4d32-84dd-eab10926789e","union_id":null,"created_at":"2026-09-01T10:13:19.69086+00:00"},{"leg":"club_accumulator","amount":-0.02,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"d2e27a86-4429-4d32-84dd-eab10926789e","union_id":null,"created_at":"2026-09-01T10:13:19.69086+00:00"}]},{"rake_record_id":"8372f0ae-aab8-4a90-a993-e3b831020b09","hand_id":"88c222bb-3a07-4084-a83e-4234c566a2b8","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4187149,"rake_amount":3.35,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":3.35,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"88c222bb-3a07-4084-a83e-4234c566a2b8","union_id":null,"created_at":"2026-09-01T10:01:11.653048+00:00"},{"leg":"club_accumulator","amount":2.85,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"88c222bb-3a07-4084-a83e-4234c566a2b8","union_id":null,"created_at":"2026-09-01T10:01:11.653048+00:00"}]},{"rake_record_id":"85d6f5f2-f4a7-4caf-a408-105fd00ac825","hand_id":"e731cb8a-6748-469e-be54-1d172e2755f4","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4188016,"rake_amount":0.09,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.09,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"e731cb8a-6748-469e-be54-1d172e2755f4","union_id":null,"created_at":"2026-09-01T10:04:47.077344+00:00"},{"leg":"club_accumulator","amount":0.03,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"e731cb8a-6748-469e-be54-1d172e2755f4","union_id":null,"created_at":"2026-09-01T10:04:47.077344+00:00"}]},{"rake_record_id":"922fc39e-5652-4991-b8e5-610385e4fde3","hand_id":"8aede729-a197-4dd1-b064-d5d009547f6b","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4190096,"rake_amount":1.9,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1.9,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"8aede729-a197-4dd1-b064-d5d009547f6b","union_id":null,"created_at":"2026-09-01T10:11:45.782382+00:00"},{"leg":"club_accumulator","amount":1.4,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"8aede729-a197-4dd1-b064-d5d009547f6b","union_id":null,"created_at":"2026-09-01T10:11:45.782382+00:00"}]},{"rake_record_id":"94df4a02-aa57-4131-925d-9b560fbc4e5d","hand_id":"426a957e-9a24-402b-a56e-4fa5d9431f21","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4201493,"rake_amount":0.36,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.36,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"426a957e-9a24-402b-a56e-4fa5d9431f21","union_id":null,"created_at":"2026-09-01T10:55:08.420281+00:00"},{"leg":"club_accumulator","amount":0.3,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"426a957e-9a24-402b-a56e-4fa5d9431f21","union_id":null,"created_at":"2026-09-01T10:55:08.420281+00:00"}]},{"rake_record_id":"978d1b95-5aff-4220-9980-894e20acdf5a","hand_id":"c801c49c-18f4-4d81-8d26-aedad6fd9043","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4194540,"rake_amount":0.06,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.06,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"c801c49c-18f4-4d81-8d26-aedad6fd9043","union_id":null,"created_at":"2026-09-01T10:25:32.545088+00:00"},{"leg":"club_accumulator","amount":0,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"c801c49c-18f4-4d81-8d26-aedad6fd9043","union_id":null,"created_at":"2026-09-01T10:25:32.545088+00:00"}]},{"rake_record_id":"97c6e42e-dabd-4ab1-b4a9-7386ad5c85e7","hand_id":"df9103cf-9a44-40b8-9dcf-9b80cac7faeb","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4196460,"rake_amount":0.25,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.25,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"df9103cf-9a44-40b8-9dcf-9b80cac7faeb","union_id":null,"created_at":"2026-09-01T10:35:57.548844+00:00"},{"leg":"club_accumulator","amount":0.19,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"df9103cf-9a44-40b8-9dcf-9b80cac7faeb","union_id":null,"created_at":"2026-09-01T10:35:57.548844+00:00"}]},{"rake_record_id":"9b7cb1e1-bc88-4e3b-a296-bb617075cb3f","hand_id":"bba7cecd-4d56-4c37-b1e1-6e8d5384032a","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4202459,"rake_amount":0.17,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.17,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"bba7cecd-4d56-4c37-b1e1-6e8d5384032a","union_id":null,"created_at":"2026-09-01T10:58:57.543654+00:00"},{"leg":"club_accumulator","amount":0.11,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"bba7cecd-4d56-4c37-b1e1-6e8d5384032a","union_id":null,"created_at":"2026-09-01T10:58:57.543654+00:00"}]},{"rake_record_id":"a64f1893-5067-4213-8742-1e0081276358","hand_id":"7c3170da-24c7-4f02-953a-e7bb5b70e104","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4194774,"rake_amount":5,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"7c3170da-24c7-4f02-953a-e7bb5b70e104","union_id":null,"created_at":"2026-09-01T10:27:02.71549+00:00"},{"leg":"club_accumulator","amount":4.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"7c3170da-24c7-4f02-953a-e7bb5b70e104","union_id":null,"created_at":"2026-09-01T10:27:02.71549+00:00"}]},{"rake_record_id":"a9249a47-719e-419e-909c-90872b3e7d57","hand_id":"0f91a0c2-ae25-43e8-894e-90cac21a4a58","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4194859,"rake_amount":0.98,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.98,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"0f91a0c2-ae25-43e8-894e-90cac21a4a58","union_id":null,"created_at":"2026-09-01T10:27:53.175862+00:00"},{"leg":"club_accumulator","amount":0.92,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"0f91a0c2-ae25-43e8-894e-90cac21a4a58","union_id":null,"created_at":"2026-09-01T10:27:53.175862+00:00"}]},{"rake_record_id":"b24859bd-44e6-475f-a46e-ea66409adaa5","hand_id":"5b9dda32-79e5-4c6e-9a2a-553abd5518d3","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4198324,"rake_amount":1,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"5b9dda32-79e5-4c6e-9a2a-553abd5518d3","union_id":null,"created_at":"2026-09-01T10:42:42.397641+00:00"},{"leg":"club_accumulator","amount":0.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"5b9dda32-79e5-4c6e-9a2a-553abd5518d3","union_id":null,"created_at":"2026-09-01T10:42:42.397641+00:00"}]},{"rake_record_id":"b2818532-abe3-4672-9876-56aaf3824ac8","hand_id":"cd7fb02a-499f-4660-b0fc-9bfa4e73e534","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4195603,"rake_amount":5,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"cd7fb02a-499f-4660-b0fc-9bfa4e73e534","union_id":null,"created_at":"2026-09-01T10:32:08.094482+00:00"},{"leg":"club_accumulator","amount":4.5,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"cd7fb02a-499f-4660-b0fc-9bfa4e73e534","union_id":null,"created_at":"2026-09-01T10:32:08.094482+00:00"}]},{"rake_record_id":"b359677a-0aac-4890-ad3c-4c2daccc4d08","hand_id":"a2024a7c-21d4-4e2c-9c30-9d7a5de28df7","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4202358,"rake_amount":3.35,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":3.35,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"a2024a7c-21d4-4e2c-9c30-9d7a5de28df7","union_id":null,"created_at":"2026-09-01T11:01:09.536881+00:00"},{"leg":"club_accumulator","amount":2.85,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"a2024a7c-21d4-4e2c-9c30-9d7a5de28df7","union_id":null,"created_at":"2026-09-01T11:01:09.536881+00:00"}]},{"rake_record_id":"b957b72a-24a7-497e-ac5e-4a1168e9b258","hand_id":"e10da9ed-d099-4eec-bca3-a996d7bc5ee0","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4188164,"rake_amount":0.9,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.9,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"e10da9ed-d099-4eec-bca3-a996d7bc5ee0","union_id":null,"created_at":"2026-09-01T10:05:18.135271+00:00"},{"leg":"club_accumulator","amount":0.4,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"e10da9ed-d099-4eec-bca3-a996d7bc5ee0","union_id":null,"created_at":"2026-09-01T10:05:18.135271+00:00"}]},{"rake_record_id":"baf800e5-0f81-48f0-93ae-84a0fdb1dfdc","hand_id":"f0ba5ffb-1ece-4c8b-80de-b818c39d9976","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4196017,"rake_amount":1.2,"bbj_amount":0,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1.2,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"f0ba5ffb-1ece-4c8b-80de-b818c39d9976","union_id":null,"created_at":"2026-09-01T10:33:02.725069+00:00"},{"leg":"club_accumulator","amount":1.2,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"f0ba5ffb-1ece-4c8b-80de-b818c39d9976","union_id":null,"created_at":"2026-09-01T10:33:02.725069+00:00"}]},{"rake_record_id":"c01c9929-e0ed-44e0-b077-d4c5722bcb95","hand_id":"78614d7f-757a-442a-b9fe-d2f05aeebe2c","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4197544,"rake_amount":3.35,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":3.35,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"78614d7f-757a-442a-b9fe-d2f05aeebe2c","union_id":null,"created_at":"2026-09-01T10:40:23.233566+00:00"},{"leg":"club_accumulator","amount":2.85,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"78614d7f-757a-442a-b9fe-d2f05aeebe2c","union_id":null,"created_at":"2026-09-01T10:40:23.233566+00:00"}]},{"rake_record_id":"c4c538f1-5c22-412b-b26b-b1763330886c","hand_id":"5008ab3d-e683-4a93-8dce-212b90f3736c","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4200894,"rake_amount":0.39,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.39,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"5008ab3d-e683-4a93-8dce-212b90f3736c","union_id":null,"created_at":"2026-09-01T10:56:26.232971+00:00"},{"leg":"club_accumulator","amount":0.33,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"5008ab3d-e683-4a93-8dce-212b90f3736c","union_id":null,"created_at":"2026-09-01T10:56:26.232971+00:00"}]},{"rake_record_id":"c8a4d71b-4dff-4768-ac89-c7fd9c7caee3","hand_id":"c058b011-6225-46e1-857a-72dc27e4336a","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4187754,"rake_amount":0.27,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.27,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"c058b011-6225-46e1-857a-72dc27e4336a","union_id":null,"created_at":"2026-09-01T10:03:43.083541+00:00"},{"leg":"club_accumulator","amount":0.21,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"c058b011-6225-46e1-857a-72dc27e4336a","union_id":null,"created_at":"2026-09-01T10:03:43.083541+00:00"}]},{"rake_record_id":"d38a65c4-944d-460a-8fe9-4c7c44daf78a","hand_id":"fa1345d4-0b74-4636-ae81-e5429fbcde8e","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4191941,"rake_amount":0.06,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.06,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"fa1345d4-0b74-4636-ae81-e5429fbcde8e","union_id":null,"created_at":"2026-09-01T10:16:22.280646+00:00"},{"leg":"club_accumulator","amount":0,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"fa1345d4-0b74-4636-ae81-e5429fbcde8e","union_id":null,"created_at":"2026-09-01T10:16:22.280646+00:00"}]},{"rake_record_id":"d3cd65cc-9662-4e36-a728-302dd242a739","hand_id":"6b9f76ab-189f-4d26-a011-ef1b08a5ebe6","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4193282,"rake_amount":0.9,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.9,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"6b9f76ab-189f-4d26-a011-ef1b08a5ebe6","union_id":null,"created_at":"2026-09-01T10:20:47.611222+00:00"},{"leg":"club_accumulator","amount":0.4,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"6b9f76ab-189f-4d26-a011-ef1b08a5ebe6","union_id":null,"created_at":"2026-09-01T10:20:47.611222+00:00"}]},{"rake_record_id":"d46a3c24-c86c-4365-ab15-40458bc9c5e5","hand_id":"76bd07a2-fee2-416b-a91d-f0b2af6baf9c","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4199897,"rake_amount":0.91,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.91,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"76bd07a2-fee2-416b-a91d-f0b2af6baf9c","union_id":null,"created_at":"2026-09-01T10:48:43.076359+00:00"},{"leg":"club_accumulator","amount":0.85,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"76bd07a2-fee2-416b-a91d-f0b2af6baf9c","union_id":null,"created_at":"2026-09-01T10:48:43.076359+00:00"}]},{"rake_record_id":"da770f89-5770-4f52-ad3c-1c7f2de43dc9","hand_id":"0d7d262f-c84c-404e-b170-4ad925eea030","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4188924,"rake_amount":0.44,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.44,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"0d7d262f-c84c-404e-b170-4ad925eea030","union_id":null,"created_at":"2026-09-01T10:07:54.026958+00:00"},{"leg":"club_accumulator","amount":0.38,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"0d7d262f-c84c-404e-b170-4ad925eea030","union_id":null,"created_at":"2026-09-01T10:07:54.026958+00:00"}]},{"rake_record_id":"ddfeca9b-f9c5-460d-8e34-2d068f707976","hand_id":"38597a19-6674-4581-ab36-82d8dd13f982","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4186996,"rake_amount":1,"bbj_amount":0,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":1,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"38597a19-6674-4581-ab36-82d8dd13f982","union_id":null,"created_at":"2026-09-01T10:00:05.567519+00:00"},{"leg":"club_accumulator","amount":1,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"38597a19-6674-4581-ab36-82d8dd13f982","union_id":null,"created_at":"2026-09-01T10:00:05.567519+00:00"}]},{"rake_record_id":"de28f939-2bc7-4eef-92c8-183ec7ca23b7","hand_id":"6f56c9e0-c424-41ed-8cf4-8fa1e7b34337","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4198751,"rake_amount":0.05,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.05,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"6f56c9e0-c424-41ed-8cf4-8fa1e7b34337","union_id":null,"created_at":"2026-09-01T10:44:12.927394+00:00"},{"leg":"club_accumulator","amount":-0.01,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"6f56c9e0-c424-41ed-8cf4-8fa1e7b34337","union_id":null,"created_at":"2026-09-01T10:44:12.927394+00:00"}]},{"rake_record_id":"ded83996-aacb-477e-bf76-0576f3c365bc","hand_id":"fd71642a-a7ac-4e74-ae9e-9709a56ddbb8","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4187051,"rake_amount":0.1,"bbj_amount":0,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.1,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"fd71642a-a7ac-4e74-ae9e-9709a56ddbb8","union_id":null,"created_at":"2026-09-01T10:01:01.175895+00:00"},{"leg":"club_accumulator","amount":0.1,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"fd71642a-a7ac-4e74-ae9e-9709a56ddbb8","union_id":null,"created_at":"2026-09-01T10:01:01.175895+00:00"}]},{"rake_record_id":"e31dd8d6-53c5-413e-a0a9-780d83646e0d","hand_id":"54dc3b73-30b7-49eb-96ed-5b4c294dd6eb","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4187311,"rake_amount":0.15,"bbj_amount":0,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.15,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"54dc3b73-30b7-49eb-96ed-5b4c294dd6eb","union_id":null,"created_at":"2026-09-01T10:02:24.53578+00:00"},{"leg":"club_accumulator","amount":0.15,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"54dc3b73-30b7-49eb-96ed-5b4c294dd6eb","union_id":null,"created_at":"2026-09-01T10:02:24.53578+00:00"}]},{"rake_record_id":"e63f66b2-c96c-41d4-b9dd-5be72d9f65e1","hand_id":"2121059b-b15f-4098-9a03-a37ef24003f1","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4192997,"rake_amount":0.04,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.04,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"2121059b-b15f-4098-9a03-a37ef24003f1","union_id":null,"created_at":"2026-09-01T10:19:56.26296+00:00"},{"leg":"club_accumulator","amount":-0.02,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"2121059b-b15f-4098-9a03-a37ef24003f1","union_id":null,"created_at":"2026-09-01T10:19:56.26296+00:00"}]},{"rake_record_id":"e6da2327-c5b4-4279-b68f-83a991cb1186","hand_id":"940aca48-6d2a-4e6b-abfb-66a2bce58457","table_id":"e955722c-ee54-41a2-bd75-01e66c17cc77","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4187399,"rake_amount":0.4,"bbj_amount":0.5,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.4,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"940aca48-6d2a-4e6b-abfb-66a2bce58457","union_id":null,"created_at":"2026-09-01T10:02:13.72637+00:00"},{"leg":"club_accumulator","amount":-0.1,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"940aca48-6d2a-4e6b-abfb-66a2bce58457","union_id":null,"created_at":"2026-09-01T10:02:13.72637+00:00"}]},{"rake_record_id":"ebb710ec-10cf-40b4-8844-370184e4ebba","hand_id":"f9feb233-5cdb-460e-886c-9fa30c7e8a9a","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4199298,"rake_amount":0.05,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.05,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"f9feb233-5cdb-460e-886c-9fa30c7e8a9a","union_id":null,"created_at":"2026-09-01T10:46:45.213908+00:00"},{"leg":"club_accumulator","amount":-0.01,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"f9feb233-5cdb-460e-886c-9fa30c7e8a9a","union_id":null,"created_at":"2026-09-01T10:46:45.213908+00:00"}]},{"rake_record_id":"ebf48774-1dc7-4a42-a9c9-d1284f755923","hand_id":"448ee063-9cef-41fd-acfb-71b52b1e644f","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4200383,"rake_amount":0.18,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.18,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"448ee063-9cef-41fd-acfb-71b52b1e644f","union_id":null,"created_at":"2026-09-01T10:56:19.642553+00:00"},{"leg":"club_accumulator","amount":0.12,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"448ee063-9cef-41fd-acfb-71b52b1e644f","union_id":null,"created_at":"2026-09-01T10:56:19.642553+00:00"}]},{"rake_record_id":"fd7e6e34-275a-46de-9e2c-7c17910f407e","hand_id":"a07b967e-9ec9-4bab-b774-cb6ff40e6503","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4187660,"rake_amount":0.02,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.02,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"a07b967e-9ec9-4bab-b774-cb6ff40e6503","union_id":null,"created_at":"2026-09-01T10:02:51.907117+00:00"},{"leg":"club_accumulator","amount":-0.04,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"a07b967e-9ec9-4bab-b774-cb6ff40e6503","union_id":null,"created_at":"2026-09-01T10:02:51.907117+00:00"}]},{"rake_record_id":"ffbc5b6d-017b-4f2e-b897-94a1a3b477b0","hand_id":"8b105603-b794-4014-87f4-8ff48ba55d4a","table_id":"68fa89a6-b843-4eb7-b850-06f83db7ea25","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","hand_number":4202323,"rake_amount":0.08,"bbj_amount":0.06,"original_repair_at":"2026-09-01T17:52:02.7044+00:00","claims":[{"leg":"chip_treasury","amount":0.08,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"8b105603-b794-4014-87f4-8ff48ba55d4a","union_id":null,"created_at":"2026-09-01T10:56:58.969753+00:00"},{"leg":"club_accumulator","amount":0.02,"club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3","leg_key":"8b105603-b794-4014-87f4-8ff48ba55d4a","union_id":null,"created_at":"2026-09-01T10:56:58.969753+00:00"}]}]$original$::jsonb);
CREATE TEMP TABLE qualification_actual_atomic(definition text);
INSERT INTO qualification_actual_atomic SELECT pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure);
CREATE TEMP TABLE qualification_modes(hand_id uuid PRIMARY KEY,mode text);
CREATE TEMP TABLE qualification_calls(hand_id uuid,arguments jsonb,applied boolean,bank_claim_new boolean);
CREATE TEMP TABLE qualification_bank_moves(hand_id uuid,amount numeric);
CREATE TEMP SEQUENCE qualification_attempts START 1;
CREATE FUNCTION pg_temp.install_atomic_spy() RETURNS void LANGUAGE plpgsql AS $install_spy$
BEGIN
  EXECUTE $spy$CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid,p_club_id uuid,p_hand_id uuid,p_hand_number integer,p_rake numeric,p_bbj numeric DEFAULT 0,p_pot numeric DEFAULT NULL::numeric,p_num_players integer DEFAULT NULL::integer,p_contributions jsonb DEFAULT NULL::jsonb,p_tournament_id uuid DEFAULT NULL::uuid,p_returned_uncalled jsonb DEFAULT NULL::jsonb,p_rake_method text DEFAULT 'DEALT_EQUAL')
  RETURNS TABLE(applied boolean,already_processed boolean,recovered boolean,rake_record_id uuid,club_net_credit numeric,spendable_route text,spendable_amount numeric,union_id_out uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s'
  AS $body$
  DECLARE v_mode text;v_record uuid;v_first boolean;v_bank boolean;v_count integer;
  BEGIN
    PERFORM nextval('pg_temp.qualification_attempts');
    SELECT mode INTO v_mode FROM pg_temp.qualification_modes WHERE hand_id=p_hand_id;
    IF v_mode='throw' THEN RAISE EXCEPTION 'fixture atomic failure'; END IF;
    IF p_num_players IS NOT NULL OR p_contributions IS NOT NULL OR p_returned_uncalled IS NOT NULL OR p_tournament_id IS NOT NULL THEN
      RAISE EXCEPTION 'fixture: caller changed original NULL economic inputs';
    END IF;
    INSERT INTO public.rake_records(hand_id,table_id,metadata)
    VALUES(p_hand_id,p_table_id,jsonb_build_object('hand_number',p_hand_number))
    ON CONFLICT(hand_id) WHERE hand_id IS NOT NULL DO NOTHING RETURNING id INTO v_record;
    v_first:=v_record IS NOT NULL;
    IF v_record IS NULL THEN SELECT id INTO v_record FROM public.rake_records WHERE hand_id=p_hand_id; END IF;
    IF v_mode='already_processed' THEN v_first:=false; END IF;
    -- This is a MODEL, not execution of actual atomic banking. The independent
    -- record and bank-claim outcomes expose the caller's measurement contract.
    v_bank:=false;
    IF v_mode IS DISTINCT FROM 'already_processed' THEN
      INSERT INTO public.rake_distribution_legs(leg_key,leg,amount)
      VALUES(p_hand_id,'chip_treasury',p_rake) ON CONFLICT(leg_key,leg) DO NOTHING;
      GET DIAGNOSTICS v_count=ROW_COUNT;
      v_bank:=v_count=1;
      IF v_bank THEN INSERT INTO pg_temp.qualification_bank_moves VALUES(p_hand_id,p_rake); END IF;
    END IF;
    INSERT INTO pg_temp.qualification_calls VALUES(p_hand_id,jsonb_build_object(
      'table_id',p_table_id,'club_id',p_club_id,'hand_id',p_hand_id,'hand_number',p_hand_number,
      'rake',p_rake,'bbj',p_bbj,'pot',p_pot,'num_players',p_num_players,'contributions',p_contributions,
      'tournament_id',p_tournament_id,'returned_uncalled',p_returned_uncalled,'rake_method',p_rake_method),v_first,v_bank);
    RETURN QUERY SELECT v_first,NOT v_first,false,v_record,p_rake-p_bbj,'club',p_rake,NULL::uuid;
  END;
  $body$;$spy$;
END;
$install_spy$;
CREATE FUNCTION pg_temp.restore_actual_atomic() RETURNS void LANGUAGE plpgsql AS $restore$
BEGIN EXECUTE (SELECT definition FROM pg_temp.qualification_actual_atomic); END;
$restore$;
