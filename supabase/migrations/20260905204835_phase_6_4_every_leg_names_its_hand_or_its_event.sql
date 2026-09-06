-- 20260905204835_phase_6_4_every_leg_names_its_hand_or_its_event.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 6.4, 2026-09-05 20:5x UTC):
--
-- The roadmap's 6.4 read "idempotency_key populated (NULL on 126,559 of
-- 126,593 rows) so the ledger dedupes by itself". Measured today: 1,116 of
-- 1,628,490 rows keyed (0.1%); 232,000 rows a day. Read against the design
-- before building: under the autoledger the BALANCE WRITE is the truth and
-- the leg follows it inside the same statement, so a unique key on the leg
-- that rejected a "duplicate" would leave a balance write standing with no
-- leg - the one outcome the standard cannot allow (it is what the freeze did
-- to 104 BBJ legs before 07:57). Dedupe belongs on the DOOR (every door is
-- idempotent on its own op or hand id; the journal's keys are there for the
-- keyed operations that have one). What the ledger lacked was not dedupe but
-- NAMES: 231,211 legs a day, 29,617 naming a hand, 50,359 naming an event,
-- and the biggest door on the platform (the BBJ drop, 91,184 legs a day)
-- naming neither.
--
-- Every leg now names its hand or its event: the enrich trigger reads
-- app.ledger_hand_id / app.ledger_tournament_id, derives the hand from a
-- 'rake:<hand>' or 'bbj:<hand>' settlement, and a spin's reserve legs carry
-- the spin from their prize_liability side. bbj_record_contribution stamps
-- 'bbj:<hand>' and the hand id on its drop; atomic_distribute_rake stamps the
-- hand id on its legs. Nothing rewrites history.
--
-- PARTITIONING (the second half of 6.4), measured and planned, not done:
-- 636 MB heap, 665 MB of indexes (13 of them), 232k rows a day, 7M a month.
-- ca_mint_ledger.chip_ledger_id references chip_ledger(id); a partitioned
-- parent's unique key must carry the partition column, so that foreign key
-- cannot survive as written (it becomes a trigger-checked reference), and
-- the conversion is a new partitioned table, a copy, a swap of thirteen
-- indexes and six triggers inside one freeze window. That is its own dated
-- cut before month four (December at this volume), not a side effect of a
-- control migration.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_chip_ledger_enrich()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev text;
BEGIN
  NEW.amount := round(NEW.amount, 2);
  NEW.created_at := COALESCE(NEW.created_at, now());

  NEW.epoch_id      := COALESCE(NEW.epoch_id, public.fn_ca_current_epoch());
  NEW.actor_service := COALESCE(NEW.actor_service,
                                current_setting('application_name', true));
  NEW.db_role       := COALESCE(NEW.db_role, current_user);
  NEW.correlation_id := COALESCE(NEW.correlation_id,
      NULLIF(current_setting('app.ledger_correlation', true), '')::uuid);
  NEW.settlement_id  := COALESCE(NEW.settlement_id,
      NULLIF(current_setting('app.ledger_settlement', true), ''));
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := NULLIF(current_setting('app.ledger_idempotency_key', true), '');
    IF NEW.idempotency_key IS NOT NULL THEN
      -- consume-once: the next row in this transaction must not inherit it
      PERFORM set_config('app.ledger_idempotency_key', '', true);
    END IF;
  END IF;

  /* PHASE 6.4 (2026-09-05): EVERY LEG NAMES ITS HAND OR ITS EVENT. The doors
     that know the hand say so on app.ledger_hand_id (the rake door and the
     BBJ drop, since today) or on a 'bbj:<hand>' settlement; the rake
     settlement is not read for it because it carries a random key when the
     hand is unknown, and a guessed hand is worse than none; a spin's reserve legs
     carry the spin on their prize_liability side. Read them here, once, so
     the hand and the event are columns a per-hand audit can index on rather
     than strings it has to parse. 231,211 legs a day; 29,617 named a hand
     and 50,359 an event before this. */
  IF NEW.hand_id IS NULL THEN
    NEW.hand_id := NULLIF(current_setting('app.ledger_hand_id', true), '')::uuid;
    IF NEW.hand_id IS NULL AND NEW.settlement_id ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW.hand_id := split_part(NEW.settlement_id, ':', 2)::uuid;
    END IF;
  END IF;
  IF NEW.tournament_id IS NULL THEN
    NEW.tournament_id := NULLIF(current_setting('app.ledger_tournament_id', true), '')::uuid;
    IF NEW.tournament_id IS NULL THEN
      IF NEW.category = 'spin_entry' AND NEW.from_type = 'prize_liability' THEN NEW.tournament_id := NEW.from_entity_id;
      ELSIF NEW.category = 'spin_prize' AND NEW.to_type = 'prize_liability' THEN NEW.tournament_id := NEW.to_entity_id;
      END IF;
    END IF;
  END IF;

  -- Tamper evidence: monotone sequence + per-row content checksum. NOT chained
  -- through the previous row's hash at insert time - that would put a global
  -- serialization point (and deadlock surface) inside every money transaction,
  -- which the availability policy forbids. prev_hash is best-effort forensics.
  NEW.chain_seq := nextval('public.chip_ledger_chain_seq');
  SELECT row_hash INTO v_prev
    FROM public.chip_ledger
   WHERE chain_seq = NEW.chain_seq - 1;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(extensions.digest(
      'v1'
      || '|' || NEW.chain_seq::text
      || '|' || COALESCE(NEW.epoch_id::text,'')
      || '|' || NEW.amount::text
      || '|' || NEW.from_type || ':' || COALESCE(NEW.from_entity_id::text,'')
      || '|' || NEW.to_type   || ':' || COALESCE(NEW.to_entity_id::text,'')
      || '|' || NEW.category
      || '|' || COALESCE(NEW.idempotency_key,'')
      || '|' || COALESCE(NEW.correlation_id::text,'')
      || '|' || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_chip_ledger_enrich() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bbj_record_contribution(p_pool_id uuid, p_hand_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT 0, p_main_portion numeric DEFAULT 0, p_backup_portion numeric DEFAULT 0, p_promo_portion numeric DEFAULT 0, p_big_blind numeric DEFAULT 2.00, p_hand_number integer DEFAULT NULL::integer, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS bbj_contributions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
    v_contribution bbj_contributions;
    v_prev_cum numeric;
    v_main_now numeric;
    v_main     numeric;
    v_backup   numeric;
    v_promo    numeric;
BEGIN
    IF p_hand_id IS NULL THEN
        IF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id
               AND hand_id IS NULL
               AND table_id = p_table_id
               AND hand_number = p_hand_number
             ORDER BY created_at
             LIMIT 1;
        ELSE
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id
               AND hand_id IS NULL
               AND table_id IS NOT DISTINCT FROM p_table_id
               AND hand_number IS NOT DISTINCT FROM p_hand_number
             ORDER BY created_at
             LIMIT 1;
        END IF;

        IF v_contribution.id IS NOT NULL THEN
            RETURN v_contribution;
        END IF;
    END IF;

    SELECT COALESCE(alloc_cum_amount, 0), COALESCE(main_balance, 0) INTO v_prev_cum, v_main_now
      FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'bbj_record_contribution: pool % not found', p_pool_id;
    END IF;

    /* A replayed hand must not consume the residue: the duplicate check on
       (pool_id, hand_id) runs BEFORE the allocator is asked. */
    IF p_hand_id IS NOT NULL THEN
        SELECT * INTO v_contribution FROM bbj_contributions
         WHERE pool_id = p_pool_id AND hand_id = p_hand_id LIMIT 1;
        IF v_contribution.id IS NOT NULL THEN
            RETURN v_contribution;
        END IF;
    END IF;

    /* ONE ALLOCATOR (chip standard Phase 4.3, 2026-09-04). The split is the
       policy's, read against the pool's main balance under the lock, with the
       pool's rounding residue carried so the long-run split is exact. The
       caller's p_main_portion / p_backup_portion / p_promo_portion are
       accepted for the signature's sake and ignored. alloc_cum_amount is kept
       running for continuity; it no longer decides anything. */
    SELECT a.main_portion, a.backup_portion, a.promo_portion INTO v_main, v_backup, v_promo
      FROM public.fn_bbj_allocate(COALESCE(p_amount, 0), v_main_now, p_pool_id) a;

    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_club_id, p_amount,
        v_main, v_backup, v_promo, p_big_blind, p_hand_number
    )
    ON CONFLICT (pool_id, hand_id) WHERE hand_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_contribution;

    IF v_contribution.id IS NULL THEN
        IF p_hand_id IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id = p_hand_id
             LIMIT 1;
        ELSIF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id IS NULL
               AND table_id = p_table_id AND hand_number = p_hand_number
             LIMIT 1;
        ELSE
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id IS NULL
             LIMIT 1;
        END IF;
        RETURN v_contribution;
    END IF;

    /* ZERO-DRIFT (2026-08-31): the pool credit below auto-journals via
       trg_ca_autoledger; declare what it is. */
    PERFORM set_config('app.ledger_category', 'bbj_contribution', true);
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);
    -- PHASE 6.4 (2026-09-05): the drop's legs name the hand.
    PERFORM set_config('app.ledger_settlement', CASE WHEN p_hand_id IS NULL THEN '' ELSE 'bbj:' || p_hand_id::text END, true);
    PERFORM set_config('app.ledger_hand_id', COALESCE(p_hand_id::text, ''), true);

    UPDATE bbj_pools
    SET
        main_balance      = main_balance   + v_main,
        backup_balance    = backup_balance + v_backup,
        promo_balance     = promo_balance  + v_promo,
        total_contributed = total_contributed + p_amount,
        alloc_cum_amount  = v_prev_cum + COALESCE(p_amount, 0),
        hands_contributed = COALESCE(hands_contributed, 0) + 1,
        updated_at        = now()
    WHERE id = p_pool_id;

    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_settlement', '', true);
    PERFORM set_config('app.ledger_hand_id', '', true);

    RETURN v_contribution;
END;
$function$;
REVOKE ALL ON FUNCTION public.bbj_record_contribution(uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_record_contribution(uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, integer, uuid) TO service_role;

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

  v_leg_key := COALESCE(p_hand_id, gen_random_uuid());
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
REVOKE ALL ON FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid, jsonb, text) TO service_role;

DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_chip_ledger_enrich') NOT LIKE '%app.ledger_hand_id%' THEN RAISE EXCEPTION 'the enrich trigger does not read the hand'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'bbj_record_contribution') NOT LIKE '%''bbj:'' || p_hand_id::text%' THEN RAISE EXCEPTION 'the drop does not name its hand'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'atomic_distribute_rake') NOT LIKE '%app.ledger_hand_id%' THEN RAISE EXCEPTION 'the rake does not name its hand'; END IF;
END $$;

COMMIT;
