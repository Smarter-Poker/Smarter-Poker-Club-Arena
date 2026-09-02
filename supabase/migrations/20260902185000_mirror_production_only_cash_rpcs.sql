-- ═══════════════════════════════════════════════════════════════════════════════
--  MIRROR THE PRODUCTION-ONLY CASH RPCs INTO THE REPO (2026-09-02, Lane D / C6)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- docs/CHIP-ACCOUNTING-STANDARD.md 2.3 C6: four cash money RPCs had no
-- definition anywhere in this repository. They existed only in pg_proc, so a
-- reviewer could not read them, a rebuild could not recreate them, and nothing
-- pinned their behaviour. This file is a byte-exact mirror of the LIVE bodies,
-- read from pg_get_functiondef() over a READ ONLY connection on 2026-09-02
-- ~18:50 UTC (application_name lane-d-mirror-readonly). It changes nothing.
--
-- md5(prosrc) of each body as mirrored (the pre-flight below refuses to run if
-- production has moved on from any of them, so this file can never REVERT a
-- newer body by being re-applied):
--
--   fn_ca_settle_hand_stacks_absolute    9949274b7348a0bfcb490bf6c5301541
--   resolve_pending_addon                08f176c6e4209b36200d1ac2e86c95c8
--   fn_add_chips                         1c6fc566b6b6e16f5bbd84cb54ae2a95
--   credit_club_wallet_rake              9cc6986c32f217593f26d04f1e489ae6
--
-- Notes a reader needs:
--   fn_ca_settle_hand_stacks_absolute  the engine's absolute stack write, with
--                                      the hand-level conservation check; Lane F
--                                      replaced it at 17:44 UTC today (tournament
--                                      conservation + rebuy-grant reconciliation)
--                                      and THAT body is the one mirrored here.
--   resolve_pending_addon              delivers a table_pending_addons row to the
--                                      seat (capped at max buy-in, excess refunded
--                                      under key addon_refund:<row id>); since
--                                      20260902174500 it also delivers kind='rebuy'.
--   fn_add_chips                       bare club_members.chip_balance += n. Reached
--                                      only from SECURITY DEFINER bodies that log
--                                      their own ledger line (fn_leave_seat_and_refund
--                                      and friends). Mirrored as-is; not a public path.
--   credit_club_wallet_rake            banks a hand's rake into club_wallets and
--                                      writes the club_wallet_transactions 'rake_in'
--                                      row.
--
-- ONE TRANSACTION (CLAUDE.md section 2): four CREATE OR REPLACE statements fire
-- one coalesced PostgREST reload. Idempotent: re-applying against an unchanged
-- production is a no-op; against a changed one it aborts in the pre-flight.

BEGIN;

DO $$
DECLARE
  v_expect jsonb := jsonb_build_object(
    'fn_ca_settle_hand_stacks_absolute', '9949274b7348a0bfcb490bf6c5301541',
    'resolve_pending_addon', '08f176c6e4209b36200d1ac2e86c95c8',
    'fn_add_chips', '1c6fc566b6b6e16f5bbd84cb54ae2a95',
    'credit_club_wallet_rake', '9cc6986c32f217593f26d04f1e489ae6'
  );
  r record;
  v_live text;
BEGIN
  FOR r IN SELECT key AS fn, value #>> '{}' AS md5 FROM jsonb_each(v_expect) LOOP
    SELECT md5(p.prosrc) INTO v_live
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;
    IF v_live IS NULL THEN
      RAISE EXCEPTION 'mirror pre-flight: % is not in production - this file mirrors, it does not create', r.fn;
    END IF;
    IF v_live <> r.md5 THEN
      RAISE EXCEPTION 'mirror pre-flight: % live md5 % differs from mirrored % - production moved on; re-read pg_get_functiondef and re-mirror rather than reverting it',
        r.fn, v_live, r.md5;
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_ca_settle_hand_stacks_absolute  (md5 9949274b7348a0bfcb490bf6c5301541)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute(p_table_id uuid, p_hand_number bigint, p_stacks jsonb DEFAULT '[]'::jsonb, p_rake numeric DEFAULT NULL::numeric, p_bbj numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hand uuid; v_claimed integer; v_prior record; v_ca_id uuid;
  e jsonb; v_uid uuid; v_new numeric; v_old numeric; v_delta_sum numeric := 0;
  v_n integer := 0; v_updated integer; v_err text; v_result jsonb;
  -- chip-std Lane F (2026-09-02): tournament conservation
  v_tournament_id uuid; v_prev_settled timestamptz; v_grants jsonb := '{}'::jsonb;
  v_explained numeric := 0;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute is engine/service only';
  END IF;
  IF p_table_id IS NULL OR p_hand_number IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_ids');
  END IF;
  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_stacks) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_stacks');
  END IF;

  -- stable hand id from (table, hand number)
  v_hand := md5('ca-hand:' || p_table_id::text || ':' || p_hand_number::text)::uuid;

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

    -- lock seats, compute deltas
    FOR e IN SELECT * FROM jsonb_array_elements(p_stacks) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_new := round((e->>'stack')::numeric, 2);
      IF v_new IS NULL OR v_new < 0 THEN
        RAISE EXCEPTION 'invalid stack for %: %', e->>'user_id', e->>'stack';
      END IF;
      SELECT ts.stack INTO v_old FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;
      END IF;
      v_delta_sum := v_delta_sum + (v_new - COALESCE(v_old, 0));
      v_n := v_n + 1;
    END LOOP;

    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', round(v_delta_sum,2),
                                  'rake', p_rake, 'bbj', p_bbj)
      WHERE id = v_ca_id AND state='locked_for_calculation';

    -- ═══ TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02) ═══
    -- A tournament table has no rake and no BBJ drop, so the named seats must
    -- sum, after this write, to exactly what they summed to before it. The
    -- engine declares p_rake = NULL for tournaments, so the strict check that
    -- follows never ran for them. A shortfall that exactly matches rebuy /
    -- re-entry / add-on grants landed on the named seats since this table's
    -- previous settlement is the engine having dealt from a stack that did not
    -- yet hold the grant (process_tournament_rebuy does stack += chips on a
    -- live seat): the grant is re-added to that seat so the write conserves
    -- instead of erasing it. Anything else is refused whole, with the numbers.
    SELECT tb.tournament_id INTO v_tournament_id FROM public.tables tb WHERE tb.id = p_table_id;
    IF v_tournament_id IS NOT NULL AND round(v_delta_sum, 2) <> 0 THEN
      SELECT max(k.completed_at) INTO v_prev_settled
        FROM public.settlement_idempotency_keys k
       WHERE k.table_id = p_table_id AND k.status = 'succeeded' AND k.hand_id <> v_hand;
      SELECT COALESCE(jsonb_object_agg(g.user_id::text, g.chips), '{}'::jsonb),
             COALESCE(sum(g.chips), 0)
        INTO v_grants, v_explained
        FROM (
          SELECT w.user_id,
                 sum(CASE WHEN w.category = 'addon'
                          THEN COALESCE(NULLIF(t.addon_chips, 0), t.starting_chips, 0)
                          ELSE COALESCE(NULLIF(t.rebuy_chips, 0), t.starting_chips, 0) END) AS chips
            FROM public.wallet_transactions w
            JOIN public.tournaments t ON t.id = w.related_entity_id
           WHERE w.related_entity_id = v_tournament_id
             AND w.category IN ('rebuy', 'addon')
             AND w.type = 'debit'
             AND w.created_at > COALESCE(v_prev_settled, now() - interval '30 minutes')
             AND w.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(p_stacks) x)
           GROUP BY w.user_id
        ) g;
      IF v_explained > 0 AND round(v_delta_sum + v_explained, 2) = 0 THEN
        p_stacks := (SELECT jsonb_agg(
                       CASE WHEN v_grants ? (x->>'user_id')
                            THEN x || jsonb_build_object('stack',
                                   round((x->>'stack')::numeric, 2) + (v_grants->>(x->>'user_id'))::numeric)
                            ELSE x END)
                     FROM jsonb_array_elements(p_stacks) x);
        v_delta_sum := 0;
      ELSE
        RAISE EXCEPTION 'conservation violation (tournament %): stack deltas % across % seat(s) of table % hand % (grants since previous settlement: %) - tournament chips must sum to what they summed to before the hand; write refused whole',
          v_tournament_id, round(v_delta_sum, 2), v_n, p_table_id, p_hand_number, v_explained;
      END IF;
    END IF;

    -- strict conservation only when rake is declared
    IF p_rake IS NOT NULL
       AND round(v_delta_sum + p_rake + COALESCE(p_bbj, 0), 2) <> 0 THEN
      RAISE EXCEPTION 'conservation violation: stack deltas %.2f + rake %.2f + bbj %.2f != 0',
        v_delta_sum, p_rake, COALESCE(p_bbj, 0);
    END IF;
    UPDATE public.ca_settlements SET state='validated' WHERE id = v_ca_id AND state='calculated';

    FOR e IN SELECT * FROM jsonb_array_elements(p_stacks) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_new := round((e->>'stack')::numeric, 2);
      UPDATE public.table_seats ts SET stack = v_new
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN
        RAISE EXCEPTION 'seat write failed for % - hand write rejected whole', v_uid;
      END IF;
    END LOOP;
    UPDATE public.ca_settlements SET state='ledger_posted' WHERE id = v_ca_id AND state='validated';
    UPDATE public.ca_settlements SET state='post_commit_verified' WHERE id = v_ca_id AND state='ledger_posted';

    v_result := jsonb_build_object('success', true, 'players', v_n,
      'table_id', p_table_id, 'hand_id', v_hand, 'hand_number', p_hand_number,
      'net_deltas', round(v_delta_sum, 2), 'rake', p_rake, 'bbj', p_bbj,
      'conservation_checked', p_rake IS NOT NULL);

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
    IF v_err LIKE 'conservation violation%' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settle_hand_stacks_absolute', 'ledger_imbalance', 'warning',
        'hand-conservation:' || p_table_id::text,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2), 0,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2),
        'settlement', 'table_seats', v_hand, NULL, NULL, p_table_id, NULL, v_hand,
        v_ca_id::text, NULL, NULL,
        'engine submitted a hand whose stack deltas do not conserve: ' || left(v_err, 200),
        false, jsonb_build_object('hand_number', p_hand_number));
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_number', p_hand_number);
  END;
END $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- resolve_pending_addon  (md5 08f176c6e4209b36200d1ac2e86c95c8)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_pending_addon(p_pending_id uuid, p_max_buy_in numeric DEFAULT NULL::numeric)
 RETURNS TABLE(applied numeric, refunded numeric, was_resolved boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row        table_pending_addons%ROWTYPE;
  v_stack      numeric;
  v_headroom   numeric;
  v_applied    numeric := 0;
  v_refunded   numeric := 0;
BEGIN
  SELECT * INTO v_row
    FROM table_pending_addons
   WHERE id = p_pending_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending add-on % not found', p_pending_id;
  END IF;

  IF v_row.resolved_at IS NOT NULL THEN
    -- Idempotent no-op: someone (a retry, a concurrent engine, the recovery
    -- sweep) already resolved this row.
    applied      := COALESCE(v_row.applied_to_stack, 0);
    refunded     := COALESCE(v_row.refunded, 0);
    was_resolved := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Lock the seat so a concurrent stack write cannot race the headroom math.
  SELECT stack INTO v_stack
    FROM table_seats
   WHERE table_id = v_row.table_id
     AND user_id  = v_row.user_id
     AND left_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Player is no longer seated: the whole add-on goes back to the wallet.
    v_applied  := 0;
    v_refunded := v_row.amount;
  ELSE
    IF p_max_buy_in IS NULL THEN
      -- NULL max buy-in means "unlimited", NOT "refund everything".
      v_applied := v_row.amount;
    ELSE
      v_headroom := GREATEST(p_max_buy_in - COALESCE(v_stack, 0), 0);
      v_applied  := LEAST(v_row.amount, v_headroom);
    END IF;
    v_refunded := ROUND(v_row.amount - v_applied, 2);
    v_applied  := ROUND(v_applied, 2);

    IF v_applied > 0 THEN
      UPDATE table_seats
         SET stack = COALESCE(stack, 0) + v_applied
       WHERE table_id = v_row.table_id
         AND user_id  = v_row.user_id
         AND left_at IS NULL;
    END IF;
  END IF;

  IF v_refunded > 0 THEN
    -- Delegate the wallet write to atomic_credit_wallet_and_log so the
    -- guard_wallet_balance_write PG_CONTEXT check sees a whitelisted frame,
    -- and so the refund is itself idempotent under retry.
    PERFORM atomic_credit_wallet_and_log(
      v_row.user_id,
      v_refunded,
      'addon_refund',
      'Add-on refund (exceeds max buy-in or seat vacated)',
      v_row.table_id,
      NULL::uuid,
      NULL::uuid,
      'addon_refund:' || v_row.id::text
    );
  END IF;

  UPDATE table_pending_addons
     SET resolved_at      = now(),
         applied_to_stack = v_applied,
         refunded         = v_refunded
   WHERE id = v_row.id;

  applied      := v_applied;
  refunded     := v_refunded;
  was_resolved := true;
  RETURN NEXT;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_add_chips  (md5 1c6fc566b6b6e16f5bbd84cb54ae2a95)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_add_chips(p_user_id uuid, p_club_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    UPDATE club_members 
    SET chip_balance = chip_balance + p_amount
    WHERE club_id = p_club_id 
      AND user_id = p_user_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Club member not found';
    END IF;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- credit_club_wallet_rake  (md5 9cc6986c32f217593f26d04f1e489ae6)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credit_club_wallet_rake(p_club_id uuid, p_rake numeric, p_bbj numeric DEFAULT 0, p_hand_id uuid DEFAULT NULL::uuid, p_hand_number integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance_after numeric;
  v_net_credit    numeric;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN;
  END IF;

  -- net credit (what stays with the club after BBJ contribution)
  v_net_credit := p_rake - COALESCE(p_bbj, 0);

  UPDATE public.club_wallets
     SET period_rake_collected     = period_rake_collected     + p_rake,
         period_bbj_contribution   = period_bbj_contribution   + COALESCE(p_bbj, 0),
         lifetime_rake_collected   = lifetime_rake_collected   + p_rake,
         lifetime_bbj_contribution = lifetime_bbj_contribution + COALESCE(p_bbj, 0),
         chip_balance              = chip_balance + v_net_credit,
         updated_at                = NOW()
   WHERE club_id = p_club_id
   RETURNING chip_balance INTO v_balance_after;

  -- If club_wallets row didn't exist (shouldn't happen - backfilled in
  -- migration 20260428000004 - but be defensive), insert one.
  IF v_balance_after IS NULL THEN
    INSERT INTO public.club_wallets (
      club_id, chip_balance,
      period_rake_collected, period_bbj_contribution,
      lifetime_rake_collected, lifetime_bbj_contribution
    ) VALUES (
      p_club_id, v_net_credit,
      p_rake, COALESCE(p_bbj, 0),
      p_rake, COALESCE(p_bbj, 0)
    )
    ON CONFLICT (club_id) DO UPDATE SET
      period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,
      period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,
      lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,
      lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,
      chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,
      updated_at                = NOW()
    RETURNING chip_balance INTO v_balance_after;
  END IF;

  -- Append-only audit row in club_wallet_transactions.
  -- amount = net (post-BBJ) chip increment to the club balance.
  INSERT INTO public.club_wallet_transactions (
    club_id, type, amount, balance_after, related_id, reason
  ) VALUES (
    p_club_id, 'rake_in', v_net_credit, v_balance_after, p_hand_id,
    'Rake collected (hand ' ||
      COALESCE('#' || p_hand_number::text, 'unknown') ||
      ', BBJ contribution ' || COALESCE(p_bbj, 0)::text || ')'
  );
END;
$function$;

-- Post-apply: the bodies are still the mirrored ones (CREATE OR REPLACE with
-- identical text is a no-op on prosrc, so the md5s must be unchanged).
DO $$
DECLARE
  v_expect jsonb := jsonb_build_object(
    'fn_ca_settle_hand_stacks_absolute', '9949274b7348a0bfcb490bf6c5301541',
    'resolve_pending_addon', '08f176c6e4209b36200d1ac2e86c95c8',
    'fn_add_chips', '1c6fc566b6b6e16f5bbd84cb54ae2a95',
    'credit_club_wallet_rake', '9cc6986c32f217593f26d04f1e489ae6'
  );
  r record;
  v_live text;
BEGIN
  FOR r IN SELECT key AS fn, value #>> '{}' AS md5 FROM jsonb_each(v_expect) LOOP
    SELECT md5(p.prosrc) INTO v_live
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;
    IF v_live IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'mirror post-apply: % md5 % <> %', r.fn, v_live, r.md5;
    END IF;
  END LOOP;
  RAISE NOTICE 'mirror_production_only_cash_rpcs: four bodies mirrored byte-exact';
END $$;

COMMIT;
