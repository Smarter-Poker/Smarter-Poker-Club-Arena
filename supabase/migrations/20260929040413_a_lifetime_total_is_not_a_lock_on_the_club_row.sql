-- A LIFETIME TOTAL IS NOT A LOCK ON THE CLUB ROW (2026-09-29)
--
-- What was wrong, measured on production 2026-09-29 03:34-03:53 UTC
-- ---------------------------------------------------------------------
-- The hand projection RPC, fn_project_hand_side_effects, was the top remaining
-- Lock/transactionid waiter. Two 45 s and 75 s samples of pg_stat_activity and
-- pg_locks (100-128 ms apart, 350 and 687 samples) agree on what it queues on.
-- Every backend caught in Lock/transactionid held a tuple lock, and those
-- tuples were public.clubs and public.club_wallets: clubs page 46 tuple 4 in
-- 117 observations, page 48 tuple 1 in 74, page 35 tuple 2 in 42, and
-- club_wallets page 0 tuple 41 in 139. 33 wait episodes in the first 45 s
-- window, mean 127 ms, max 814 ms. The engine logged 68 HandProjection
-- timeouts in ten minutes.
--
-- public.clubs holds ten live rows and took 123,272 UPDATEs in eleven hours of
-- uptime, leaving 95 percent dead tuples spread over 756 pages. One statement
-- did that: this branch of atomic_distribute_rake, once per raked hand on a
-- standalone or private club,
--
--     UPDATE public.clubs SET total_rake = COALESCE(total_rake,0) + p_rake
--
-- public.clubs is the platform's settings row and carries fifteen triggers
-- that fire on UPDATE: every lifecycle and treasury guard, the settings audit,
-- the autoledger, and four management event emitters. So a counter bump ran
-- all of them, rewrote a wide row, and then held an exclusive lock on that one
-- row for the REST of the transaction, because atomic_distribute_rake is
-- called near the START of the hand projection and everything else follows it:
-- the BBJ pool, promo, insurance and add-on obligations, the completion stamp,
-- then the whole stats projection (club_member_daily_stats,
-- club_member_table_state, club_hand_daily_shard, player_stats,
-- player_position_stats, ca_hand_player_idx and ca_hand_player_stat through
-- ca_hand_player_facts_one), the outbox DELETE, and finally a PostgREST client
-- round trip before COMMIT. pg_stat_statements puts that tail at 119 ms mean
-- per call, 7.9 buffers dirtied, 25 kB of WAL and 8.25 full page images. At
-- 3.1 clubs UPDATEs per second that single row was locked roughly 37 percent
-- of the wall clock, so hands at different tables in one club queued behind
-- each other for work that had nothing to do with the rake.
--
-- Why the write goes rather than moves
-- ---------------------------------------------------------------------
-- Nothing reads public.clubs.total_rake. Of the 21 SQL functions that mention
-- both clubs and total_rake, none selects it; the two views that mention
-- total_rake (v_bomb_pot_daily, tournament_escrow_shadow) read it from
-- hand_history and tournaments; no page selects it either, and the one that
-- looks like it does, AdminDashboardPage, reads player_stats.total_rake.
--
-- It had also stopped being true, because only the standalone branch ever
-- wrote it. Measured the same hour:
--
--   Deep Stack Society  total_rake 1,685,329.42  wallet 1,685,313.29
--   Club JAQK           total_rake 1,557,737.60  wallet 1,509,880.89
--   SHARK CLUB          total_rake         0.00  wallet 1,523,835.54
--   Midway Union        total_rake         0.00  wallet 3,710,512.50
--
-- So this is not a figure being moved somewhere cheaper. It is a write-only
-- denormalisation, already wrong, whose only remaining effect was to serialise
-- the hand projection. The rake it counted is receipted by the rake_records
-- row inserted a few lines above and totalled by
-- club_wallets.lifetime_rake_collected, both inside this same transaction.
--
-- Nothing is backfilled and nothing is repaired (CLAUDE.md 10.12). The column
-- keeps whatever it holds; it simply stops being written on the hand path.
--
-- This is the same law as "a budget is not one row": a running total kept on
-- one shared row, held locked until the writing transaction commits.

BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT (NULL::numeric)::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid, p_returned_uncalled jsonb DEFAULT NULL::jsonb, p_rake_method text DEFAULT 'DEALT_EQUAL'::text)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_bank_receipt_id uuid; v_banked_at timestamptz;
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
  /* THE RAKE LEG NAMES THE CLUB IT WAS EARNED IN (2026-09-21). Union rake
     is routed by UPDATE-ing union_wallets.rake_wallet; the fn_ca_autoledger
     trigger journals that delta, and union_wallets has no club_id column,
     so every union rake leg was written club-less - 294,877 rows and
     671514.09 in the week of 2026-09-07 alone, and still happening.
     20260920192513 taught the autoledger to read a declaring payer and
     fixed the PRIZE legs; this is the rake payer saying the same thing.
     NOT app.ledger_club_id: that name decides which club a WALLET credit
     is paid into (atomic_credit_wallet_and_log) and is set and restored by
     the rakeback close, so clearing it here would move money. */
  PERFORM set_config('app.ledger_autoledger_club_id', COALESCE(p_club_id::text, ''), true);

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
      PERFORM set_config('app.ledger_autoledger_club_id', '', true);
      RETURN QUERY SELECT false, true, false, v_dup_id, 0::numeric,
                          NULL::text, 0::numeric, v_union_id;
      RETURN;
    END IF;
  END IF;

  IF p_hand_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||p_hand_id::text,0));
  END IF;
  PERFORM public.fn_lock_cash_bank_accounting_week(p_club_id,v_union_id,transaction_timestamp());

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source,
    metadata, rake_method, returned_uncalled
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number, 'is_private', v_is_private, 'union_id', v_union_id, 'accounting_source_version', 2),
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
           public.fn_cash_earning_club(p_hand_id,p_table_id,a.user_id,p_club_id,v_union_id),
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
      ) RETURNING id,created_at INTO v_bank_receipt_id,v_banked_at;
      INSERT INTO public.accounting_cash_bank_receipts(rake_record_id,union_id,club_id,union_transaction_id,banked_at,amount)
       VALUES(v_rr_id,v_union_id,p_club_id,v_bank_receipt_id,v_banked_at,p_rake);

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  ELSE
    v_route := 'chip_retirement';
    -- Retain the original leg key so an earlier treasury credit cannot be
    -- replayed as a second disposition. A historical treasury leg needs an
    -- explicit adjustment; it is not evidence that this source was burned.
    IF EXISTS(SELECT 1 FROM public.rake_distribution_legs
       WHERE leg_key=v_leg_key AND leg='chip_treasury')
     AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts b
       JOIN public.chip_ledger l ON l.id=b.club_ledger_id
       WHERE b.rake_record_id=v_rr_id AND b.union_id IS NULL AND b.union_transaction_id IS NULL
        AND b.club_id=p_club_id AND b.amount=p_rake AND l.amount=b.amount AND l.created_at=b.banked_at
        AND l.from_type='table_stack' AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL
        AND l.club_id=p_club_id AND l.category='burn') THEN
      RAISE EXCEPTION 'cash_rake_legacy_treasury_leg_requires_adjustment' USING ERRCODE='55000';
    END IF;
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'chip_treasury', p_club_id, NULL, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      -- A LIFETIME TOTAL IS NOT A LOCK ON THE CLUB ROW (2026-09-29).
      -- This branch used to run, once per raked hand:
      --     UPDATE public.clubs SET total_rake = total_rake + p_rake
      -- public.clubs holds one row per club and carries fifteen UPDATE
      -- triggers, so a counter bump ran every lifecycle guard, the settings
      -- audit, the autoledger and four management event emitters, and then
      -- held an exclusive lock on that single row for the REST of the hand
      -- projection transaction: the whole stats projection,
      -- ca_hand_player_facts_one, and a PostgREST round trip before COMMIT.
      -- Measured on production 2026-09-29 03:34 to 03:40 UTC: public.clubs
      -- was the most contended tuple behind Lock/transactionid, at 123,272
      -- updates against 10 live rows and 95 percent dead tuples in 756 pages.
      -- Nothing reads the column. No SQL function selects clubs.total_rake
      -- and no page does either, and it had already drifted away from the
      -- wallet total it duplicates: Deep Stack Society 1,685,329.42 against
      -- 1,685,313.29, Club JAQK 1,557,737.60 against 1,509,880.89, and both
      -- SHARK CLUB and Midway Union sat at 0.00 while their wallets held
      -- 1,523,835.54 and 3,710,512.50, because the union route never wrote
      -- it at all. The rake is receipted by the rake_records row inserted
      -- above and totalled by club_wallets.lifetime_rake_collected, both in
      -- this same transaction, so no figure is lost by not writing a third.
      -- The existing deferred chip_ledger issuance trigger registers this
      -- retirement. Calling fn_ca_burn would debit a wallet a second time;
      -- the hand settlement already removed these chips from table stacks.
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, to_type, to_entity_id,
         amount, category, club_id, table_id, hand_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        'table_stack', p_table_id, 'chip_retirement', NULL,
        p_rake, 'burn', p_club_id, p_table_id, p_hand_id, p_tournament_id,
        'Standalone cash rake retired, hand ' || COALESCE('#' || p_hand_number::text, 'unknown')
          || ' (atomic_distribute_rake)') RETURNING id,created_at INTO v_bank_receipt_id,v_banked_at;
      -- The existing immutable source/ledger join records disposition; this
      -- private leg is a burn receipt and must never be counted as funding.
      INSERT INTO public.accounting_cash_bank_receipts(rake_record_id,union_id,club_id,club_ledger_id,banked_at,amount)
       VALUES(v_rr_id,NULL,p_club_id,v_bank_receipt_id,v_banked_at,p_rake);
      -- Any journal or receipt failure aborts the same producer transaction.
      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  PERFORM set_config('app.ledger_autoledger_club_id', '', true);
  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      CASE WHEN v_union_id IS NULL THEN 0::numeric ELSE v_net END, v_route,
                      CASE WHEN v_union_id IS NULL THEN 0::numeric ELSE p_rake END, v_union_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) TO service_role;

DO $rake_postimage$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure
       AND p.prosrc ~ '(?n)^[[:space:]]*UPDATE[[:space:]]+public\.clubs'
  ) THEN
    RAISE EXCEPTION 'RAKE_STILL_WRITES_THE_CLUB_ROW: atomic_distribute_rake';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure
       AND md5(p.prosrc) = 'c5b73345de77a804ba4e77c96c5e9388'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'RAKE_POSTIMAGE_DRIFT: atomic_distribute_rake';
  END IF;
END
$rake_postimage$;

COMMIT;
