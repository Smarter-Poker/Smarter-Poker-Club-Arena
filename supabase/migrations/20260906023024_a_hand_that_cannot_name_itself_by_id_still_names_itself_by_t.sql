-- A HAND THAT CANNOT NAME ITSELF BY ID STILL NAMES ITSELF BY TABLE AND NUMBER.
--
-- FeeReconciler.bbj_unlinkable has filed 180 warnings since 2026-08-28, each
-- one saying that some BBJ contribution "sits on rake_records rows with NO
-- hand_id, so they can be reconciled against the jackpot pool by neither this
-- audit nor fn_bbj_repair_unbanked". It was right that the rows exist and wrong
-- about what they are. They are not chips waiting to be banked. They are
-- duplicates, and the reason they exist is that BOTH of this function's
-- idempotency guards are keyed on a hand id that is sometimes NULL.
--
-- THE TWO GUARDS, AND HOW EACH ONE SWITCHES ITSELF OFF.
--
--   INSERT INTO public.rake_records ... ON CONFLICT (hand_id)
--     WHERE hand_id IS NOT NULL DO NOTHING
--
-- A partial index that excludes NULL cannot refuse a NULL, so the insert always
-- succeeded. And:
--
--   v_leg_key := COALESCE(p_hand_id, gen_random_uuid());
--
-- a FRESH RANDOM key on every call, so rake_distribution_legs'
-- ON CONFLICT (leg_key, leg) could never match either - and that is the guard
-- that stands in front of the club wallet. The engine calls this function
-- before logHandHistory has produced a hand row and again after it has, and the
-- second call was not recognised as the same hand: a second rake_records row,
-- and a second increment of period_rake_collected, lifetime_rake_collected and
-- both BBJ counters.
--
-- MEASURED, from the rows. 4,452 such rows exist, 2026-04-16 to 2026-09-05
-- (2,243 as ServerTableEngine.handEnd to 2026-07-24, then 2,209 as
-- atomic_distribute_rake), carrying 16,426.46 of rake_amount and 2,068.82 of
-- bbj_contribution. For the 284 hands whose history has not been pruned, three
-- independent records agree with the LINKED rows alone and not with the
-- unlinked ones:
--
--   hand_history.rake_amount   716.73   linked rake rows   711.33  (283/284 exact)
--   hand_history.bbj_amount    106.80   linked rake rows   106.32  (283/284 exact)
--   bbj_contributions          106.32
--
-- So no chips are missing from the jackpot pool - the pot dropped what the pool
-- received. What was inflated is rake ATTRIBUTION: the club wallet counters,
-- and everything downstream of them.
--
-- THE FIX, AND WHY IT IS THIS ONE. The caller always knows two things even when
-- the hand row does not exist yet: which table, and which hand number. So the
-- function asks hand_history for the id first, and when the id genuinely is not
-- there yet it keys on (table_id, hand_number) instead - for the duplicate
-- check, and for the leg key, which is now DERIVED rather than random. The same
-- hand always produces the same key, so both guards hold whether or not the
-- hand has been written yet.
--
-- WHAT IS NOT DONE HERE. The 4,452 historical rows are left exactly where they
-- are. Deleting them would silently restate five months of VIP points, agent
-- commissions and club rake totals that people have already been paid on, and
-- 10.9 is explicit that a settled record is corrected forward and never edited
-- quiet. Only 371 of them can be PROVEN duplicates from surviving rows; the
-- other 4,081 have had their hands pruned and the proof with them. The measured
-- figure is recorded as an open, owned finding rather than acted on at 03:00 by
-- the agent who found it.
--
-- PROVED BEFORE IT COMMITTED. The migration calls the new function twice with
-- the same table and hand number and no hand id, inside a sub-block whose
-- writes are rolled back, and refuses to apply unless the second call is
-- refused as already_processed and leaves exactly one rake row and one leg.

BEGIN;

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
         guard, so a replayed hand credits once and journals once. Never blocks. */
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
        GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        BEGIN
          INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
          VALUES (p_club_id, NULL, p_rake, v_st, 'atomic_distribute_rake: ' || v_msg);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      v_net, v_route, p_rake, v_union_id;
END;
$function$;

DO $probe$
DECLARE
  v_club uuid;
  v_tbl  uuid;
  v_hn   integer := 987654321;
  v_rows int; v_legs int; v_second record;
BEGIN
  -- A REAL table, because a rake row that names a table nobody has is refused
  -- by fn_guard_rake_references. The hand number is one no hand will ever have,
  -- and every write below is rolled back with the sub-block.
  SELECT t.id, t.club_id INTO v_tbl, v_club
    FROM public.tables t
   WHERE t.club_id IS NOT NULL
   ORDER BY t.created_at
   LIMIT 1;
  IF v_club IS NULL OR v_tbl IS NULL THEN RAISE EXCEPTION 'no table to probe against'; END IF;

  BEGIN
    PERFORM public.atomic_distribute_rake(v_tbl, v_club, NULL, v_hn, 1.00, 0.10, 10.00);
    SELECT * INTO v_second FROM public.atomic_distribute_rake(v_tbl, v_club, NULL, v_hn, 1.00, 0.10, 10.00);

    SELECT count(*) INTO v_rows FROM public.rake_records
     WHERE table_id = v_tbl AND (metadata->>'hand_number') = v_hn::text;
    -- One row PER LEG NAME is normal (the club accumulator and, when the game
    -- carries a union stamp, the union share). What must not double is the
    -- club accumulator, which is the leg standing in front of the club wallet.
    SELECT count(*) INTO v_legs FROM public.rake_distribution_legs
     WHERE leg_key = md5('rake:' || v_tbl::text || ':' || v_hn::text)::uuid
       AND leg = 'club_accumulator';

    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'ZZ_PROBE_BAD: two calls left % rake rows, expected 1', v_rows;
    END IF;
    IF v_legs <> 1 THEN
      RAISE EXCEPTION 'ZZ_PROBE_BAD: two calls left % legs, expected 1', v_legs;
    END IF;
    IF NOT COALESCE(v_second.already_processed, false) THEN
      RAISE EXCEPTION 'ZZ_PROBE_BAD: the second call was not reported as already_processed';
    END IF;

    -- Everything above is correct; abort the sub-block so none of it is kept.
    RAISE EXCEPTION 'ZZ_PROBE_OK';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'ZZ_PROBE_OK' THEN
        RAISE NOTICE 'RAKE_DEDUPE_PROBE: one rake row, one leg, second call already_processed - and rolled back';
      ELSE
        RAISE;
      END IF;
  END;
END $probe$;

-- The 180 warnings described these rows as unbanked chips. They are duplicates,
-- and the guard that let them in is closed above.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: these rake_records rows are DUPLICATES, not unbanked chips. '
                 || 'hand_history.bbj_amount and bbj_contributions both agree with the linked '
                 || 'rows alone in 283 of the 284 hands whose history survives, so the pool '
                 || 'received everything the pot dropped. The cause was atomic_distribute_rake '
                 || 'keying both of its idempotency guards on a hand id that is NULL on the '
                 || 'engine''s first call; closed by migration 20260906023024, which resolves '
                 || 'the hand from hand_history and otherwise keys on (table_id, hand_number). '
                 || 'The 4,452 historical rows and their 16,426.46 of over-attributed rake are '
                 || 'left in place and recorded as an open finding rather than restated.'
 WHERE source = 'FeeReconciler.bbj_unlinkable'
   AND resolved IS NOT TRUE;

-- And the finding that IS live gets an owner and a number.
INSERT INTO public.financial_alerts (severity, source, message, context)
VALUES ('warning', 'chip_standard.duplicate_rake_attribution',
  'Rake attribution was inflated by duplicate rake_records rows between 2026-04-16 and '
  || '2026-09-05: 4,452 rows carrying 16,426.46 of rake_amount and 2,068.82 of bbj_contribution '
  || 'that no hand ever dropped. The producer is closed (migration 20260906023024). The rows '
  || 'are NOT deleted: they sit behind five months of VIP points, agent commissions and club '
  || 'rake totals that have already been paid, only 371 of them can be proven duplicates from '
  || 'surviving hand rows, and restating settled earnings is a decision to be taken '
  || 'deliberately rather than by the agent who found it.',
  jsonb_build_object(
    'rows', 4452, 'rake_chips', 16426.46, 'bbj_chips', 2068.82,
    'first', '2026-04-16', 'last', '2026-09-05',
    'provable_duplicates', 371, 'pruned_beyond_proof', 4081,
    'producer_closed_by', '20260906023024',
    'owner', 'rake'));

COMMIT;
