-- Isolated accounting fixture input; never a production migration.
-- Canonical metadata and original source pins: provenance.json.

SET check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text DEFAULT 'bonus'::text, p_description text DEFAULT NULL::text, p_reference_id text DEFAULT NULL::text, p_counterparty_id uuid DEFAULT NULL::uuid)
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
    -- NAME THE OTHER SIDE. ab_ca_diamond_transfer_names_its_counterparty refuses
    -- a transfer that cannot, because the register skips a transfer on the row's own
    -- word that a matching leg exists somewhere.
    v_issuance_class := 'transferred';
    v_counterparty := 'player:' || COALESCE(p_counterparty_id::text, 'unknown');
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
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='add_diamonds_to_balance' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.award_diamonds_v2(p_user_id uuid, p_action_key text, p_reference_id text DEFAULT NULL::text, p_target_id text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    c_catalog_version   constant integer := 3;
    c_platform_budget   constant bigint  := 2500000;

    c_login_base        constant integer := 10;
    c_login_step        constant integer := 5;
    c_login_max         constant integer := 110;

    c_egg_monthly_cap   constant integer := 1000;
    c_egg_max_single    constant integer := 1000;

    c_streak_monthly_cap       constant integer := 1000;
    c_daily_bonus_monthly_cap  constant integer := 3750;
    c_training_monthly_cap     constant integer := 1500;
    c_achievement_monthly_cap  constant integer := 1000;
    c_challenge_monthly_cap    constant integer := 1000;

    v_now               timestamptz := now();
    v_today             date;
    v_day_start         timestamptz;
    v_day_end           timestamptz;
    v_month_start       timestamptz;
    v_month_end         timestamptz;
    v_period            text;

    v_found_action      boolean;
    v_base_diamonds     integer;
    v_max_per_day       integer;
    v_counts_cap        boolean;
    v_lifetime          boolean;
    v_category          text;

    v_balance           integer := 0;
    v_multiplier        numeric(6,2) := 1.00;
    v_is_vip            boolean := false;
    v_vip_tier          text;
    v_vip_expires_at    timestamptz;

    v_daily_cap         integer;
    v_monthly_cap       integer;
    v_daily_used        integer := 0;
    v_monthly_used      integer := 0;
    v_daily_remaining   integer;
    v_monthly_remaining integer;

    v_reference_id      text;
    v_requested         integer := 0;
    v_award             integer := 0;
    v_capped            boolean := false;
    v_streak            integer := 0;
    v_action_count      integer := 0;
    v_egg_request       integer := 0;
    v_family_request    integer := 0;
    v_streak_entitlement_continuation boolean := false;
    v_streak_entitlement_initialization boolean := false;
    v_streak_milestone_days integer := 0;
    v_streak_milestone_base integer := 0;
    v_streak_entitlement integer := 0;
    v_streak_already_awarded integer := 0;
    v_streak_claim_count integer := 0;
    v_expected_streak_reference text;

    -- These values always describe the same action family. The allowance is
    -- deliberately applied only after v_requested has been multiplied.
    v_family_monthly_cap integer;
    v_family_month_total bigint := 0;
    v_family_remaining   bigint := 0;
    v_family_all_or_nothing boolean := false;

    v_budget_total      bigint;
    v_budget_spent      bigint;
    v_budget_left       bigint;
    v_new_balance       integer;
    v_metadata          jsonb;
    v_profile_rows      integer := 0;
    v_constraint_name   text;
BEGIN
    v_today       := (v_now AT TIME ZONE 'America/Chicago')::date;
    v_day_start   := v_today::timestamp AT TIME ZONE 'America/Chicago';
    v_day_end     := (v_today + 1)::timestamp AT TIME ZONE 'America/Chicago';
    v_month_start := date_trunc('month', v_today::timestamp) AT TIME ZONE 'America/Chicago';
    v_month_end   := (date_trunc('month', v_today::timestamp) + interval '1 month')
                     AT TIME ZONE 'America/Chicago';
    v_period      := to_char(v_today, 'YYYY-MM');

    IF p_user_id IS NULL OR p_action_key IS NULL OR btrim(p_action_key) = '' THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'invalid_input', 'capped', false,
            'daily_remaining', 0, 'monthly_remaining', 0, 'balance_after', 0
        );
    END IF;

    v_reference_id := COALESCE(btrim(p_reference_id), '');
    v_metadata     := COALESCE(p_metadata, '{}'::jsonb);

    -- Only the server-owned milestone claim ledger may submit an amount that
    -- is already post-multiplier. The row and exact part reference are checked
    -- again below; arbitrary service callers cannot use metadata to bypass a
    -- user's multiplier or manufacture an entitlement.
    BEGIN
        v_streak_entitlement_continuation :=
            p_action_key = 'streak_reward'
            AND COALESCE(v_metadata ->> '_source', '') = 'fn_claim_training_streak_milestone_v2'
            AND COALESCE((v_metadata ->> 'post_multiplier_entitlement')::boolean, false);
        v_streak_entitlement_initialization :=
            p_action_key = 'streak_reward'
            AND COALESCE(v_metadata ->> '_source', '') = 'fn_claim_training_streak_milestone_v2'
            AND NOT v_streak_entitlement_continuation;
    EXCEPTION WHEN invalid_text_representation THEN
        v_streak_entitlement_continuation := false;
        v_streak_entitlement_initialization := false;
    END;

    -- Serialize every award for one user before reading any user-owned state.
    -- The first integer is a namespace reserved for award_diamonds_v2; a hash
    -- collision can only over-serialize two users, never weaken correctness.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        1799876946,
        pg_catalog.hashtext(p_user_id::text)
    );

    SELECT true, c.diamonds, c.max_per_day, c.counts_toward_daily_cap,
           c.lifetime, c.category
      INTO v_found_action, v_base_diamonds, v_max_per_day, v_counts_cap,
           v_lifetime, v_category
      FROM public.diamond_reward_catalog c
     WHERE c.action_key = p_action_key
       AND c.active = true;

    IF NOT FOUND OR NOT COALESCE(v_found_action, false) THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'unknown_action', 'capped', false,
            'daily_remaining', 0, 'monthly_remaining', 0, 'balance_after', 0
        );
    END IF;

    -- This row lock is both a cross-function serialization boundary and the
    -- authoritative balance/multiplier snapshot used by every write below.
    SELECT COALESCE(pr.diamonds, 0),
           COALESCE(pr.diamond_multiplier, 1.00),
           COALESCE(pr.is_vip, false),
           pr.vip_tier,
           pr.vip_expires_at
      INTO v_balance, v_multiplier, v_is_vip, v_vip_tier, v_vip_expires_at
      FROM public.profiles pr
     WHERE pr.id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'user_not_found', 'capped', false,
            'daily_remaining', 0, 'monthly_remaining', 0, 'balance_after', 0
        );
    END IF;

    -- Keep the currently deployed 1x..10x validation contract. Regardless of
    -- the stored multiplier, the post-multiplier caps below remain absolute.
    IF v_multiplier IS NULL OR v_multiplier <= 0 OR v_multiplier > 10 THEN
        v_multiplier := 1.00;
    END IF;

    -- COALESCE is intentional: SQL NULL must never make this VIP check fail
    -- open. The standing economy invariant inspects this exact property.
    v_is_vip := COALESCE(v_is_vip, false)
        AND (
            COALESCE(v_vip_tier, '') = 'lifetime'
            OR (v_vip_expires_at IS NOT NULL AND v_vip_expires_at > v_now)
        );

    -- Kill switch (Diamond Accounting Standard 3.4 layer 6, review D11): a human-opened
    -- diamond_issuance freeze refuses every promotional award until it is cleared.
    IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL) THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'diamond_issuance_frozen', 'capped', false,
            'daily_remaining', 0, 'monthly_remaining', 0, 'balance_after', v_balance
        );
    END IF;

    v_daily_cap   := CASE WHEN v_is_vip THEN 150 ELSE 110 END;
    v_monthly_cap := CASE WHEN v_is_vip THEN 4500 ELSE 3300 END;

    IF v_counts_cap THEN
        SELECT COALESCE(SUM(t.amount), 0)::int
          INTO v_daily_used
          FROM public.diamond_transactions t
          JOIN public.diamond_reward_catalog c ON c.action_key = t.transaction_type
         WHERE t.user_id = p_user_id
           AND t.amount > 0
           AND c.counts_toward_daily_cap = true
           AND t.created_at >= v_day_start
           AND t.created_at < v_day_end;

        SELECT COALESCE(SUM(t.amount), 0)::int
          INTO v_monthly_used
          FROM public.diamond_transactions t
          JOIN public.diamond_reward_catalog c ON c.action_key = t.transaction_type
         WHERE t.user_id = p_user_id
           AND t.amount > 0
           AND c.counts_toward_daily_cap = true
           AND t.created_at >= v_month_start
           AND t.created_at < v_month_end;
    END IF;

    v_daily_remaining   := GREATEST(v_daily_cap - v_daily_used, 0);
    v_monthly_remaining := GREATEST(v_monthly_cap - v_monthly_used, 0);

    IF v_max_per_day IS NOT NULL THEN
        SELECT COUNT(*)::int
          INTO v_action_count
          FROM public.diamond_transactions t
         WHERE t.user_id = p_user_id
           AND t.transaction_type = p_action_key
           AND t.amount > 0
           AND t.created_at >= v_day_start
           AND t.created_at < v_day_end;

        IF v_action_count >= v_max_per_day THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', 0,
                'reason', 'action_limit', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;
    END IF;

    IF v_lifetime AND EXISTS (
        SELECT 1
          FROM public.diamond_transactions t
         WHERE t.user_id = p_user_id
           AND t.transaction_type = p_action_key
           AND t.amount > 0
    ) THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'already_claimed', 'capped', false,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance
        );
    END IF;

    IF v_reference_id <> '' AND EXISTS (
        SELECT 1
          FROM public.diamond_transactions t
         WHERE t.user_id = p_user_id
           AND t.reference_id = v_reference_id
    ) THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'duplicate', 'capped', false,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance
        );
    END IF;

    v_requested := COALESCE(v_base_diamonds, 0);

    IF p_action_key = 'daily_login' THEN
        BEGIN
            WITH ranked AS (
                SELECT (created_at AT TIME ZONE 'America/Chicago')::date AS d,
                       ROW_NUMBER() OVER (
                           ORDER BY (created_at AT TIME ZONE 'America/Chicago')::date DESC
                       ) AS rn
                  FROM public.diamond_transactions
                 WHERE user_id = p_user_id
                   AND transaction_type = 'daily_login'
                   AND amount > 0
                   AND (created_at AT TIME ZONE 'America/Chicago')::date < v_today
                 GROUP BY 1
            )
            SELECT COUNT(*)::int
              INTO v_streak
              FROM ranked
             WHERE d = v_today - rn;
        EXCEPTION WHEN others THEN
            v_streak := 0;
        END;

        v_streak    := v_streak + 1;
        v_requested := LEAST(c_login_base + (v_streak - 1) * c_login_step, c_login_max);

    ELSIF p_action_key = 'easter_egg' THEN
        BEGIN
            v_egg_request := COALESCE((v_metadata ->> 'egg_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_egg_request := 0;
        END;

        v_egg_request := LEAST(GREATEST(v_egg_request, 0), c_egg_max_single);
        v_requested := v_egg_request;
        v_family_monthly_cap := c_egg_monthly_cap;
        v_family_all_or_nothing := true;

    ELSIF p_action_key = 'streak_reward' THEN
        IF v_streak_entitlement_continuation OR v_streak_entitlement_initialization THEN
            BEGIN
                v_streak_milestone_days := COALESCE((v_metadata ->> 'milestone_days')::int, 0);
            EXCEPTION WHEN others THEN
                v_streak_milestone_days := 0;
            END;

            v_streak_milestone_base := CASE v_streak_milestone_days
                WHEN 3 THEN 25
                WHEN 7 THEN 75
                WHEN 14 THEN 150
                WHEN 30 THEN 400
                WHEN 60 THEN 800
                WHEN 100 THEN 2000
                WHEN 365 THEN 10000
                ELSE 0
            END;

            SELECT claims.entitlement_diamonds,
                   claims.diamonds_awarded,
                   claims.claim_count
              INTO v_streak_entitlement,
                   v_streak_already_awarded,
                   v_streak_claim_count
              FROM public.training_streak_milestone_claims claims
             WHERE claims.user_id = p_user_id
               AND claims.milestone_days = v_streak_milestone_days
               AND claims.completed_at IS NULL
             FOR UPDATE;

            v_expected_streak_reference := 'streak_' || p_user_id::text || '_'
                || v_streak_milestone_days::text || '_part_'
                || (v_streak_claim_count + 1)::text;
            v_family_request := CASE
                WHEN v_streak_entitlement_continuation THEN GREATEST(
                    COALESCE(v_streak_entitlement, 0)
                      - COALESCE(v_streak_already_awarded, 0),
                    0
                )
                ELSE v_streak_milestone_base
            END;

            IF NOT FOUND
               OR (
                 v_streak_entitlement_continuation
                 AND COALESCE(v_streak_entitlement, 0) <= 0
               )
               OR (
                 v_streak_entitlement_initialization
                 AND v_streak_entitlement IS NOT NULL
               )
               OR v_streak_milestone_base <= 0
               OR COALESCE(v_streak_already_awarded, 0) > v_streak_milestone_base * 10
               OR v_family_request <= 0
               OR v_family_request > 100000
               OR v_reference_id <> v_expected_streak_reference
               OR COALESCE((v_metadata ->> 'streak_diamonds')::int, -1) <> v_family_request THEN
                RETURN jsonb_build_object(
                    'success', false, 'awarded', 0, 'requested', 0,
                    'reason', 'invalid_entitlement', 'capped', false,
                    'daily_remaining', v_daily_remaining,
                    'monthly_remaining', v_monthly_remaining,
                    'balance_after', v_balance
                );
            END IF;
        ELSE
            BEGIN
                v_family_request := COALESCE((v_metadata ->> 'streak_diamonds')::int, 0);
            EXCEPTION WHEN others THEN
                v_family_request := 0;
            END;
            v_family_request := LEAST(GREATEST(v_family_request, 0), 10000);
        END IF;
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_streak_monthly_cap;

    ELSIF p_action_key IN ('daily_bonus', 'daily_bonus_boost') THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'bonus_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 125);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_daily_bonus_monthly_cap;

    ELSIF p_action_key = 'training_reward' THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'reward_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 50);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_training_monthly_cap;

    ELSIF p_action_key = 'achievement' THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'achievement_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 500);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_achievement_monthly_cap;

    ELSIF p_action_key = 'challenge' THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'challenge_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 500);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_challenge_monthly_cap;

    ELSIF p_action_key = 'tournament_prize' THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'prize_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 10000);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', 0,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
    END IF;

    IF v_requested <= 0 THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'not_eligible', 'capped', false,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance
        );
    END IF;

    -- This is the only multiplier application. Every family and general cap
    -- below is therefore enforced against the amount that could be credited.
    IF NOT v_streak_entitlement_continuation THEN
        v_requested := GREATEST(ROUND(v_requested * v_multiplier)::int, 1);
    END IF;

    IF v_streak_entitlement_initialization THEN
        -- Snapshot the full post-multiplier milestone entitlement only after
        -- the server-owned claim RPC proves post-epoch eligibility. Historical
        -- transaction-backed credit is then deducted exactly once; it is not
        -- multiplied a second time.
        v_streak_entitlement := GREATEST(
            v_requested,
            COALESCE(v_streak_already_awarded, 0)
        );
        IF v_streak_entitlement > v_requested THEN
            -- Historical exact-reference credit can exceed today's price when
            -- the claim-time multiplier was higher. Report an effective
            -- multiplier that reproduces the clamped integer entitlement so
            -- every replay/API response remains internally consistent.
            v_multiplier := ROUND(
                v_streak_entitlement::numeric / v_streak_milestone_base::numeric,
                6
            );
        END IF;
        v_requested := GREATEST(
            v_streak_entitlement - COALESCE(v_streak_already_awarded, 0),
            0
        );
        IF v_requested = 0 THEN
            RETURN jsonb_build_object(
                'success', true, 'awarded', 0, 'requested', 0,
                'entitlement', v_streak_entitlement,
                'reason', 'entitlement_already_paid', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;
    END IF;
    v_award := v_requested;

    IF v_family_monthly_cap IS NOT NULL THEN
        SELECT COALESCE(SUM(t.amount), 0)::bigint
          INTO v_family_month_total
          FROM public.diamond_transactions t
         WHERE t.user_id = p_user_id
           AND t.transaction_type = p_action_key
           AND t.amount > 0
           AND t.created_at >= v_month_start
           AND t.created_at < v_month_end;

        v_family_remaining := GREATEST(
            v_family_monthly_cap::bigint - v_family_month_total,
            0::bigint
        );

        IF v_family_remaining <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'action_limit', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;

        -- Easter eggs preserve their documented whole-award/defer behavior.
        IF v_family_all_or_nothing AND v_award::bigint > v_family_remaining THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'reason', 'action_limit', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;

        v_award := LEAST(v_award::bigint, v_family_remaining)::int;
    END IF;

    IF v_counts_cap THEN
        IF v_daily_remaining <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'daily_cap', 'capped', true,
                'daily_remaining', 0,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;

        IF v_monthly_remaining <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'monthly_cap', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', 0,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;

        v_award := LEAST(v_award, v_daily_remaining, v_monthly_remaining);
    END IF;

    -- RULING 21 (Dan, 2026-09-08): a platform-wide pot never refuses a player, and never
    -- quietly shrinks what they earned. This block read diamond_platform_budget FOR UPDATE,
    -- refused with 'budget_exhausted' when the shared pot was dry, and - worse - did
    --
    --     v_award := LEAST(v_award::bigint, v_budget_left)::int;
    --
    -- so a player owed 100 who arrived when the pot held 7 was paid 7, flagged `capped`, with no
    -- way to learn that the number had nothing to do with anything they had done. Both are gone.
    -- The per-user daily and monthly allowances above are the whole of the limit now, and they
    -- have already been applied to v_award.
    --
    -- v_budget_total, v_budget_spent and v_budget_left are left declared and unused rather than
    -- editing the DECLARE block of a long money function for cosmetics.
    IF v_award <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'nothing_to_award', 'capped', true,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance,
            'multiplier', v_multiplier
        );
    END IF;

    v_capped := v_award < v_requested;
    v_new_balance := v_balance + v_award;

    -- The running total on this one row is gone with the gate it fed. It was also the same
    -- one-hot-row-per-month shape that lost 5,860 awards to lock timeouts on the engine table
    -- this morning, so removing it takes a second contention point out of an award path. What
    -- this award cost is recorded by the journal trigger, in ca_diamond_engine_spend.

    UPDATE public.profiles
       SET diamonds = v_new_balance,
           diamond_balance = v_new_balance,
           updated_at = now()
     WHERE id = p_user_id;
    GET DIAGNOSTICS v_profile_rows = ROW_COUNT;

    IF v_profile_rows <> 1 THEN
        RAISE EXCEPTION 'award_diamonds_v2 profile row disappeared for user %', p_user_id
            USING ERRCODE = 'P0001';
    END IF;

    v_metadata := v_metadata || jsonb_build_object(
        'catalog_version', c_catalog_version,
        'action_key', p_action_key,
        'target_id', p_target_id,
        'requested', v_requested,
        'awarded', v_award,
        'capped', v_capped,
        'multiplier', v_multiplier,
        'entitlement', CASE
            WHEN v_streak_entitlement_initialization
              OR v_streak_entitlement_continuation
              THEN v_streak_entitlement
            ELSE NULL
        END,
        'category', v_category,
        'reference_id', v_reference_id,
        'streak', CASE WHEN p_action_key = 'daily_login' THEN v_streak ELSE NULL END,
        'is_vip', v_is_vip
    );

    INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, reference_id, metadata, created_at,
        counterparty, issuance_class
    ) VALUES (
        p_user_id,
        v_award,
        p_action_key,
        p_action_key,
        format(
            'Diamond Rewards v2: %s%s',
            p_action_key,
            CASE WHEN v_capped THEN ' (capped)' ELSE '' END
        ),
        v_new_balance,
        CASE WHEN v_reference_id = '' THEN NULL ELSE v_reference_id END,
        v_metadata,
        v_now,
        'promo_budget:catalog_v2',
        'promotional'
    );

    IF v_counts_cap THEN
        v_daily_remaining := GREATEST(v_daily_remaining - v_award, 0);
        v_monthly_remaining := GREATEST(v_monthly_remaining - v_award, 0);
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'awarded', v_award,
        'requested', v_requested,
        'entitlement', CASE
            WHEN v_streak_entitlement_initialization
              OR v_streak_entitlement_continuation
              THEN v_streak_entitlement
            ELSE NULL
        END,
        'reason', 'ok',
        'capped', v_capped,
        'daily_remaining', v_daily_remaining,
        'monthly_remaining', v_monthly_remaining,
        'balance_after', v_new_balance
        , 'multiplier', v_multiplier
    );

EXCEPTION
    WHEN unique_violation THEN
        -- Entering this handler rolls back every statement in the function
        -- body, including budget/profile updates. Only the two canonical
        -- reference-id idempotency indexes represent a duplicate award;
        -- unrelated uniqueness defects must stay loud and roll back.
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
        IF v_constraint_name NOT IN (
            'idx_diamond_transactions_reference_id',
            'diamond_transactions_user_reference_uidx'
        ) THEN
            RAISE;
        END IF;
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0,
            'requested', COALESCE(v_requested, 0),
            'reason', 'duplicate', 'capped', false,
            'daily_remaining', COALESCE(v_daily_remaining, 0),
            'monthly_remaining', COALESCE(v_monthly_remaining, 0),
            'balance_after', COALESCE(v_balance, 0)
        );
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='award_diamonds_v2' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.deduct_diamonds(p_user_id uuid, p_amount integer, p_description text DEFAULT ''::text, p_transaction_type text DEFAULT 'game_cost'::text, p_source text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_reference_id text DEFAULT NULL::text, p_cooldown_seconds integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_current integer;
    v_new_balance integer;
    v_effective_type text;
    v_issuance_class text;
    v_counterparty text;
    v_existing_amount numeric;
    v_existing_type text;
    v_existing_counterparty text;
    v_existing_issuance_class text;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Amount must be a positive integer');
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot deduct diamonds for another user');
    END IF;

    v_effective_type := COALESCE(p_source, p_transaction_type);

    -- Derive the destination before the replay check so the same reference
    -- cannot be moved to another recipient or revenue account.
    -- A DEBIT THAT NAMES WHERE THE MONEY WENT IS A TRANSFER. This used to be
    -- decided by the source list below alone, so every new transfer path had to
    -- remember to add itself to it - and on 2026-09-11 the Diamond Wheel did not,
    -- so its spin price was journaled a spend, the register retired 100 diamonds
    -- that were sitting in the host owner's balance, and the hourly detector read
    -- 100 of unexplained supply. The classification follows the money now.
    IF COALESCE(p_metadata->>'recipient_id', '') <> ''
       OR COALESCE(p_source, '') IN ('wallet_transfer', 'wallet_diamond_transfer', 'stream_gift')
       OR COALESCE(p_transaction_type, '') IN ('diamond_gift_sent', 'live_gift_sent') THEN
        v_issuance_class := 'transferred';
        v_counterparty := 'player:' || COALESCE(p_metadata->>'recipient_id', 'unknown');
    ELSE
        v_issuance_class := 'spend';
        v_counterparty := 'revenue:' || COALESCE(p_source, p_transaction_type, 'unknown');
    END IF;

    -- The profile lock serializes the first attempt and every concurrent
    -- replay. A second request cannot pass an early lookup, wait for the first
    -- debit to commit, and then fall through to a duplicate insert error.
    SELECT COALESCE(diamonds, 0)
      INTO v_current
      FROM public.profiles
     WHERE id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User not found');
    END IF;

    IF p_reference_id IS NOT NULL THEN
        SELECT dt.amount,
               COALESCE(dt.transaction_type, dt.type),
               dt.counterparty,
               dt.issuance_class
          INTO v_existing_amount,
               v_existing_type,
               v_existing_counterparty,
               v_existing_issuance_class
          FROM public.diamond_transactions AS dt
         WHERE dt.reference_id = p_reference_id
           AND dt.user_id = p_user_id
         LIMIT 1;

        IF FOUND THEN
            IF v_existing_amount IS DISTINCT FROM -p_amount
               OR v_existing_type IS DISTINCT FROM v_effective_type
               OR v_existing_counterparty IS DISTINCT FROM v_counterparty
               OR v_existing_issuance_class IS DISTINCT FROM v_issuance_class THEN
                RETURN jsonb_build_object(
                    'success', false,
                    'error', 'idempotency_conflict',
                    'balance', v_current,
                    'reference_id', p_reference_id
                );
            END IF;

            RETURN jsonb_build_object(
                'success', true,
                'balance', v_current,
                'charged', (-v_existing_amount)::integer,
                'transaction_type', v_existing_type,
                'reference_id', p_reference_id,
                'counterparty', v_existing_counterparty,
                'issuance_class', v_existing_issuance_class,
                'idempotent', true
            );
        END IF;
    END IF;

    IF v_current < p_amount THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Insufficient diamonds',
            'balance', v_current
        );
    END IF;

    IF p_cooldown_seconds > 0 THEN
        IF EXISTS (
            SELECT 1
              FROM public.diamond_transactions
             WHERE user_id = p_user_id
               AND transaction_type = v_effective_type
               AND created_at >= now() - make_interval(secs => p_cooldown_seconds)
        ) THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'Please wait before sending again',
                'cooldown_active', true
            );
        END IF;
    END IF;

    UPDATE public.profiles
       SET diamonds = diamonds - p_amount,
           diamond_balance = diamonds - p_amount,
           updated_at = now()
     WHERE id = p_user_id
     RETURNING diamonds INTO v_new_balance;

    -- DIAMOND-RULINGS 1: purchased lots are consumed FIFO before promotional balance at every
    -- sink, so a refund or chargeback knows what is left of what was paid for.
    PERFORM public.fn_ca_consume_purchase_lots(p_user_id, p_amount);

    INSERT INTO public.diamond_transactions
        (user_id, amount, transaction_type, type, description, balance_after, metadata,
         reference_id, created_at, counterparty, issuance_class)
    VALUES
        (p_user_id, -p_amount, v_effective_type, v_effective_type, p_description,
         v_new_balance, p_metadata, p_reference_id, now(), v_counterparty, v_issuance_class);

    RETURN jsonb_build_object(
        'success', true,
        'balance', v_new_balance,
        'charged', p_amount,
        'transaction_type', v_effective_type,
        'reference_id', p_reference_id,
        'counterparty', v_counterparty,
        'issuance_class', v_issuance_class,
        'idempotent', false
    );
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='deduct_diamonds' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.enforce_chip_ledger_performed_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.performed_by = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'chip_ledger.performed_by must be a real user, got all-zero sentinel'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Cross-scope between two non-system entity types requires the operator
  -- to be identified - this catches callers who forget to thread userId.
  IF NEW.from_type <> NEW.to_type
     AND NEW.from_type NOT IN ('system_mint', 'system_burn')
     AND NEW.to_type   NOT IN ('system_mint', 'system_burn') THEN
    -- performed_by is already NOT NULL + non-zero here; nothing extra to do.
    NULL;
  END IF;
  RETURN NEW;
END; $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='enforce_chip_ledger_performed_by' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_accounting_transfer_document_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 PERFORM public.fn_invoice_accounting_ledger_transfer(NEW.id);
 RETURN NEW;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_accounting_transfer_document_on_insert' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  -- supabase_auth_admin added 2026-09-10: it is GoTrue's own database role
  -- (the signup triggers run as it), never a browser. Without it every signup
  -- wallet trigger raised 42501 here (signup_errors id 9318).
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  -- PERF (2026-09-10, swarm A): OFFSET 0 is an optimisation fence. Without it
  -- the planner evaluated `shifted ?& c_required_steps` first on every row of
  -- engine_maintenance_thaws (167 rows, 0 of them contract_version 3) on every
  -- money write that reaches fn_platform_frozen: 229 us -> 32 us per call.
  -- Same four quals, same max(); the jsonb quals now only see rows that already
  -- passed contract_version = 3 AND release_target_at > clock_timestamp().
  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_active_maintenance_release_boundary' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_admin_holds_no_player_wallet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_is_union boolean;
BEGIN
  IF COALESCE(NEW.role, 'player') <> 'admin' THEN RETURN NEW; END IF;

  SELECT COALESCE(c.is_union, false) INTO v_is_union FROM public.clubs c WHERE c.id = NEW.club_id;
  IF COALESCE(v_is_union, false) THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role
     AND (COALESCE(NEW.chip_balance, 0) <> 0
          OR COALESCE(NEW.locked_chips, 0) <> 0
          OR COALESCE(NEW.held_chips, 0) <> 0
          OR COALESCE(NEW.promo_balance, 0) <> 0) THEN
    RAISE EXCEPTION 'Cash Out The Player Wallet Before Making This Member An Admin'
      USING ERRCODE = 'check_violation',
            DETAIL = format('chip_balance %s, locked %s, held %s, promo %s',
                            COALESCE(NEW.chip_balance, 0), COALESCE(NEW.locked_chips, 0),
                            COALESCE(NEW.held_chips, 0), COALESCE(NEW.promo_balance, 0));
  END IF;

  IF COALESCE(NEW.chip_balance, 0) > 0
     AND (TG_OP = 'INSERT' OR COALESCE(NEW.chip_balance, 0) > COALESCE(OLD.chip_balance, 0)) THEN
    RAISE EXCEPTION 'An Admin Does Not Hold A Player Wallet'
      USING ERRCODE = 'check_violation',
            HINT = 'Send To The Agent Wallet Or The Club Bank Instead.';
  END IF;

  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_admin_holds_no_player_wallet' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_inserts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if coalesce(new.chip_balance, 0) <> 0
     or coalesce(new.promo_balance, 0) <> 0
     or coalesce(new.held_chips, 0) <> 0
     or coalesce(new.locked_chips, 0) <> 0 then
    raise exception 'A membership created from the browser must start with zero chips.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_block_browser_balance_inserts' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_changed text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_table_name = 'club_members' then
    if new.chip_balance is distinct from old.chip_balance then
      v_changed := 'chip_balance';
    elsif new.held_chips is distinct from old.held_chips then
      v_changed := 'held_chips';
    elsif new.locked_chips is distinct from old.locked_chips then
      v_changed := 'locked_chips';
    elsif new.promo_balance is distinct from old.promo_balance then
      v_changed := 'promo_balance';
    end if;
  elsif tg_table_name = 'clubs' then
    if new.chip_treasury is distinct from old.chip_treasury then
      v_changed := 'chip_treasury';
    elsif new.chip_pool is distinct from old.chip_pool then
      v_changed := 'chip_pool';
    end if;
  end if;

  if v_changed is null then
    return new;
  end if;

  raise exception
    'Direct balance mutation of %.% from the browser is forbidden. Chips move only through the money RPCs.',
    tg_table_name, v_changed
    using errcode = 'insufficient_privilege';
end
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_block_browser_balance_writes' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_attested_day_is_restated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  r record;
  v_res jsonb;
BEGIN
  IF v_reason IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    FOR r IN
      SELECT DISTINCT o.created_at::date AS day
        FROM old_rows o
        JOIN public.ca_ledger_day_manifests m ON m.day = o.created_at::date
       ORDER BY 1
    LOOP
      v_res := public.fn_ca_ledger_day_manifest(r.day, 'maintenance:' || v_reason);
      IF COALESCE((v_res->>'tampered')::boolean, false) THEN
        RAISE EXCEPTION 'the manifest for % could not be restated after maintenance "%": %', r.day, v_reason, v_res
          USING ERRCODE = 'P0403';
      END IF;
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT d.day
        FROM (SELECT created_at::date AS day FROM old_rows
              UNION
              SELECT created_at::date FROM new_rows) d
        JOIN public.ca_ledger_day_manifests m ON m.day = d.day
       ORDER BY 1
    LOOP
      v_res := public.fn_ca_ledger_day_manifest(r.day, 'maintenance:' || v_reason);
      IF COALESCE((v_res->>'tampered')::boolean, false) THEN
        RAISE EXCEPTION 'the manifest for % could not be restated after maintenance "%": %', r.day, v_reason, v_res
          USING ERRCODE = 'P0403';
      END IF;
    END LOOP;
  END IF;

  RETURN NULL;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_attested_day_is_restated' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_audit_diamond_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old integer; v_new integer := COALESCE(NEW.diamonds, 0); v_delta integer;
  v_stack text; v_writer text; v_path text; v_journaled boolean := false;
  v_cert boolean; v_fixture boolean; v_sanctioned boolean; v_refuse boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.diamonds IS NOT DISTINCT FROM OLD.diamonds THEN RETURN NEW; END IF;
    v_old := COALESCE(OLD.diamonds, 0);
  ELSE
    IF v_new = 0 THEN RETURN NEW; END IF;
    v_old := 0;
  END IF;
  v_delta := v_new - v_old;

  BEGIN
    GET DIAGNOSTICS v_stack = PG_CONTEXT;
    SELECT (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] INTO v_writer
      FROM regexp_split_to_table(COALESCE(v_stack, ''), E'\n') WITH ORDINALITY AS t(ln, ord)
     WHERE t.ln ~ 'function (?:public\.)?[A-Za-z0-9_]+\('
       AND (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] <> 'fn_ca_audit_diamond_change'
     ORDER BY t.ord LIMIT 1;

    v_path := NULLIF(btrim(COALESCE(current_setting('app.money_path', true), '')), '');
    v_journaled := EXISTS (SELECT 1 FROM public.diamond_transactions dt
                            WHERE dt.user_id = NEW.id AND dt.created_at >= now() - interval '2 seconds');
    v_cert    := public.fn_ca_is_cert_account(NEW.id);
    v_fixture := public.fn_ca_is_fixture_account(NEW.id);

    -- DR6. Every writer here journals in the same transaction; most of them AFTER the balance
    -- write, which is why v_journaled is false at trigger time for a correct credit (2026-09-07
    -- review D4-D6). Gate by name, and by prefix for the daily-challenge family whose body name
    -- has drifted twice.
    v_sanctioned :=
         COALESCE(v_writer, '') IN ('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
                                    'send_wallet_diamond_transfer', 'send_stream_gift', 'handle_new_user',
                                    'fn_ca_diamond_born_with_balance', 'award_diamonds_v2',
                                    'fn_purchase_time_banks_v2', 'reconcile_diamond_purchase_refund',
                                    'fn_diamond_purchase_refund', 'fn_ca_journal_profile_deletion')
      OR COALESCE(v_writer, '') LIKE 'claim_daily_challenge%'
      OR COALESCE(v_path, '') IN ('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
                                  'send_wallet_diamond_transfer', 'send_stream_gift',
                                  'claim_daily_challenge', 'claim_daily_challenges');

    INSERT INTO public.ca_diamond_balance_audit
      (user_id, old_diamonds, new_diamonds, delta, is_cert, db_role, app_name, journaled, writer, money_path)
    VALUES (NEW.id, v_old, v_new, v_delta, v_cert, current_user,
            COALESCE(current_setting('application_name', true), ''), v_journaled, v_writer, v_path);

    IF v_delta <> 0 AND NOT v_journaled AND NOT v_sanctioned THEN
      -- DR6 (DIAMOND-RULINGS 17): once flipped, an unsanctioned balance write on a player
      -- account is refused; fixtures are never refused, only filed at info.
      v_refuse := NOT v_fixture
                  AND public.fn_ca_diamond_rule_mode('DR6:balance_changed_without_journal') = 'refuse';
      PERFORM public.fn_ca_diamond_incident(
        CASE WHEN v_fixture THEN 'DR6:fixture_harness_unjournaled' ELSE 'DR6:balance_changed_without_journal' END,
        CASE WHEN v_fixture THEN 'info' ELSE 'warning' END,
        NEW.id, v_delta, COALESCE(v_writer, v_path, '(no function frame)'),
        jsonb_build_object('money_path', v_path, 'is_cert', v_cert, 'is_fixture', v_fixture, 'tg_op', TG_OP,
                           'writer', v_writer, 'old_diamonds', v_old, 'new_diamonds', v_new,
                           'db_role', current_user,
                           'app_name', COALESCE(current_setting('application_name', true), ''),
                           'journaled_at_trigger_time', v_journaled, 'sanctioned_money_path', v_sanctioned));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (user_id, delta, sqlstate, message)
      VALUES (NEW.id, v_delta, SQLSTATE, 'diamond audit insert failed: ' || SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  IF v_refuse THEN
    RAISE EXCEPTION 'DR6: profiles.diamonds may only change through a sanctioned money path (writer %, delta %)',
      COALESCE(v_writer, v_path, '(no function frame)'), v_delta
      USING ERRCODE = 'P0406', HINT = 'Use add_diamonds_to_balance, deduct_diamonds, fn_ca_mint or fn_ca_burn.';
  END IF;
  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_audit_diamond_change' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid;
  v_club uuid; v_union uuid; v_entity uuid;
  actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NEW;
  END IF;

  o  := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  nn := to_jsonb(NEW);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
  cp  := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE NULL END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (nn->>'id')::uuid
    WHEN nn ? 'union_id' THEN NULLIF(nn->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME = 'agents' THEN NULLIF(nn->>'user_id','')::uuid
    WHEN TG_TABLE_NAME = 'club_members' THEN NULLIF(nn->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(nn->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := COALESCE(NULLIF(o->>col,'')::numeric, 0);
    newv := COALESCE(NULLIF(nn->>col,'')::numeric, 0);
    d := round(newv - oldv, 2);
    CONTINUE WHEN d = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN NEW;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_autoledger' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_block_browser_money_table()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION
      'Direct % on %.% from the browser is forbidden. Chips move only through the money RPCs.',
      TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_block_browser_money_table' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_bridge_rate()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT diamonds_per_chip FROM public.ca_bridge_rate WHERE id = 1;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_bridge_rate' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_caller_is_management()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ok  boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN true;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
    UNION ALL
    SELECT 1 FROM public.club_members cm WHERE cm.user_id = v_uid AND cm.role = 'owner'
    UNION ALL
    SELECT 1 FROM public.unions u WHERE u.owner_id = v_uid
    UNION ALL
    SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
  ) INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_caller_is_management' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_capture_tournament_charge_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_split record;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.from_type IS DISTINCT FROM 'player_wallet'
     OR NEW.to_type IS DISTINCT FROM 'prize_liability'
     OR NEW.to_entity_id IS DISTINCT FROM NEW.tournament_id
     OR lower(COALESCE(NEW.category,'')) NOT IN (
          'tournament_buyin','rebuy','addon') THEN
    RETURN NULL;
  END IF;
  IF NEW.from_entity_id IS NULL OR NEW.club_id IS NULL THEN
    RAISE EXCEPTION 'tournament charge ledger omitted player or source club'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
    NEW.tournament_id,NEW.category,NEW.amount);
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    NEW.tournament_id,NEW.from_entity_id,'wallet_charge',lower(NEW.category),
    NEW.club_id,round(NEW.amount,2),v_split.refund_prize,
    v_split.refund_bounty,v_split.refund_fee,NEW.id,NULL,NULL,NULL,
    'wallet_gross','atomic_wallet_charge',transaction_timestamp());
  RETURN NULL;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_capture_tournament_charge_entitlement' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres"'; END LOOP; END $fixture$;
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
    /* PHASE 6 GATE (2026-09-05): a prize_liability side IS the event, on every
       category, not only the two spin ones. This is what the 6.4 measurement
       missed: 777 tournament rake settlements in three hours (the fee leaving
       an event to a union rake wallet or a club treasury) and every tournament
       add-on named nothing. Read against the rows first: all 777 from_entity_id
       values are real tournaments. The FROM side wins when both sides are
       prize_liability (a satellite seat's pool transfer, which already stamps
       the satellite itself). */
    IF NEW.tournament_id IS NULL THEN
      IF NEW.from_type = 'prize_liability' THEN NEW.tournament_id := NEW.from_entity_id;
      ELSIF NEW.to_type = 'prize_liability' THEN NEW.tournament_id := NEW.to_entity_id;
      END IF;
    END IF;
  END IF;
  /* PHASE 6 GATE: and a table_stack side IS the table. Every cash buy-in,
     add-on and cash-out carries the table on its felt side (231, 53 and 222
     of each measured in the same window, every one a real table row) and
     none of them carried table_id. A cash buy-in is not a hand; the table is
     the name it has. */
  IF NEW.table_id IS NULL THEN
    IF NEW.to_type = 'table_stack' THEN NEW.table_id := NEW.to_entity_id;
    ELSIF NEW.from_type = 'table_stack' THEN NEW.table_id := NEW.from_entity_id;
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
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_chip_ledger_enrich' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_chip_store_declared()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_missing text;
BEGIN
  SELECT s INTO v_missing FROM (VALUES (NEW.from_type), (NEW.to_type)) v(s)
   WHERE s IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ca_chip_store_coverage g WHERE g.store = s)
   LIMIT 1;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'REFUSED: chip store % is not declared in ca_chip_store_coverage', v_missing
      USING ERRCODE = '23514',
            DETAIL  = 'A store the supply basis has never heard of would move chips out of the meter '
                   || 'silently, which is exactly the five supply incidents of 2026-09-11.',
            HINT    = 'Declare it first: INSERT INTO public.ca_chip_store_coverage (store, treatment, counted_by, notes) '
                   || 'VALUES (' || quote_literal(v_missing) || ', ''counted''|''noncirculating''|''uncounted'', '
                   || '<which fn_ca_supply_snapshot component holds it>, <why>). '
                   || 'If it is counted, add it to the basis in the same migration.';
  END IF;
  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_chip_store_declared' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
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
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_consume_purchase_lots' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_current_epoch()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT id FROM public.ca_financial_epochs WHERE is_current LIMIT 1 $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_current_epoch' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_budget_check(p_today date)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today_total bigint;
  v_p95         numeric;
  v_days        integer;
BEGIN
  SELECT COALESCE(sum(awarded), 0) INTO v_today_total
    FROM public.diamond_user_daily_awards WHERE engine = 'club_arena_daily' AND day = p_today;
  SELECT count(*), percentile_cont(0.95) WITHIN GROUP (ORDER BY t.total)
    INTO v_days, v_p95
    FROM (SELECT day, sum(awarded) AS total FROM public.diamond_user_daily_awards
           WHERE engine = 'club_arena_daily' AND day >= p_today - 14 AND day < p_today
           GROUP BY day) t;
  IF v_days < 7 OR v_p95 IS NULL OR v_today_total <= v_p95 THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.financial_alerts a
              WHERE a.source = 'fn_ca_daily_bonus_claim.budget_anomaly'
                AND a.context->>'bonus_date' = p_today::text) THEN
    RETURN;
  END IF;
  INSERT INTO public.financial_alerts (severity, source, message, context)
  VALUES ('warning', 'fn_ca_daily_bonus_claim.budget_anomaly',
          format('daily bonus paid %s diamonds today, above the 14-day p95 of %s', v_today_total, round(v_p95)),
          jsonb_build_object('bonus_date', p_today, 'today', v_today_total, 'p95', round(v_p95, 1), 'days', v_days));
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_budget_check' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_caps(p_user_id uuid, p_is_vip boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now         timestamptz := now();
  v_today       date := (v_now AT TIME ZONE 'America/Chicago')::date;
  v_day_start   timestamptz := v_today::timestamp AT TIME ZONE 'America/Chicago';
  v_day_end     timestamptz := (v_today + 1)::timestamp AT TIME ZONE 'America/Chicago';
  v_month_start timestamptz := date_trunc('month', v_today::timestamp) AT TIME ZONE 'America/Chicago';
  v_month_end   timestamptz := (date_trunc('month', v_today::timestamp) + interval '1 month') AT TIME ZONE 'America/Chicago';
  v_daily_cap   integer := CASE WHEN p_is_vip THEN 150 ELSE 110 END;
  v_monthly_cap integer := CASE WHEN p_is_vip THEN 4500 ELSE 3300 END;
  v_family_cap  integer := 3750;
  v_daily_used  integer;
  v_month_used  integer;
  v_family_used integer;
BEGIN
  SELECT COALESCE(SUM(t.amount), 0)::int INTO v_daily_used
    FROM public.diamond_transactions t
    JOIN public.diamond_reward_catalog c ON c.action_key = t.transaction_type
   WHERE t.user_id = p_user_id AND t.amount > 0 AND c.counts_toward_daily_cap
     AND t.created_at >= v_day_start AND t.created_at < v_day_end;
  SELECT COALESCE(SUM(t.amount), 0)::int INTO v_month_used
    FROM public.diamond_transactions t
    JOIN public.diamond_reward_catalog c ON c.action_key = t.transaction_type
   WHERE t.user_id = p_user_id AND t.amount > 0 AND c.counts_toward_daily_cap
     AND t.created_at >= v_month_start AND t.created_at < v_month_end;
  SELECT COALESCE(SUM(t.amount), 0)::int INTO v_family_used
    FROM public.diamond_transactions t
   WHERE t.user_id = p_user_id AND t.amount > 0 AND t.transaction_type = 'daily_bonus'
     AND t.created_at >= v_month_start AND t.created_at < v_month_end;
  RETURN jsonb_build_object(
    'daily_cap', v_daily_cap,
    'daily_used', v_daily_used,
    'daily_remaining', GREATEST(v_daily_cap - v_daily_used, 0),
    'monthly_cap', v_monthly_cap,
    'monthly_used', v_month_used,
    'monthly_remaining', GREATEST(v_monthly_cap - v_month_used, 0),
    'bonus_monthly_cap', v_family_cap,
    'bonus_monthly_used', v_family_used,
    'bonus_monthly_remaining', GREATEST(v_family_cap - v_family_used, 0),
    'frozen', EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL)
  );
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_caps' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claim(p_slot integer, p_request_id uuid, p_user_id uuid DEFAULT NULL::uuid, p_bonus_date date DEFAULT NULL::date, p_client jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_elig       text;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_day        public.ca_daily_bonus_days;
  v_is_vip     boolean := false;
  v_tile       jsonb;
  v_kind       text;
  v_qty        integer;
  v_diamonds   integer;
  v_feature    text;
  v_existing   public.ca_daily_bonus_claims;
  v_award      jsonb;
  v_credit_id  uuid;
  v_journal_id uuid;
  v_balance    integer;
  v_granted    jsonb;
  v_result     jsonb;
  v_ref        text;
  v_from       jsonb;
  v_lucky      integer := NULL;
  v_boost_id   uuid;
  v_boost_ends timestamptz;
  v_claim_id   uuid := gen_random_uuid();
BEGIN
  -- A BROWSER SPEAKS FOR ITSELF AND FOR NOBODY ELSE.
  IF v_uid IS NOT NULL AND p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a daily bonus for another player' USING ERRCODE = '42501';
  END IF;
  -- THE HORSE'S INPUT DEVICE (CLAUDE.md 10.5). A horse has no session, so the engine names the
  -- player it is acting for. Only the engine may: fn_caller_is_engine is false for any browser.
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_claim requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  v_from := public.fn_ca_daily_bonus_claimed_from(p_client);
  IF p_request_id IS NULL THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'request_id_required', NULL, v_from);
  END IF;
  IF p_slot IS NULL OR p_slot < 1 OR p_slot > 6 THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'no_such_tile', NULL, v_from);
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, v_elig, NULL, v_from);
  END IF;

  -- One claim at a time per player. Every path below runs under this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_daily_bonus:' || v_uid::text, 0));

  -- Replay: the same request id returns the stored result and pays nothing.
  SELECT * INTO v_existing FROM public.ca_daily_bonus_claims
   WHERE user_id = v_uid AND request_id = p_request_id;
  IF FOUND THEN
    RETURN v_existing.result || jsonb_build_object('idempotent', true);
  END IF;

  -- The sheet names the day it showed. A tap that arrives after Chicago
  -- midnight is refused rather than paid against a day the player never saw;
  -- the sheet re-reads and shows today.
  IF p_bonus_date IS NOT NULL AND p_bonus_date <> v_today THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'day_rolled_over',
             jsonb_build_object('today', v_today, 'requested', p_bonus_date), v_from)
           || jsonb_build_object('today', v_today, 'requested', p_bonus_date);
  END IF;

  v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today);

  SELECT t INTO v_tile FROM jsonb_array_elements(v_day.tiles) t WHERE (t->>'slot')::int = p_slot;
  IF v_tile IS NULL THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'no_such_tile', NULL, v_from);
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_daily_bonus_claims
              WHERE user_id = v_uid AND bonus_date = v_today AND slot = p_slot) THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'already_claimed', NULL, v_from);
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;
  IF (v_tile->>'vip_only')::boolean AND NOT v_is_vip THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'vip_only', NULL, v_from);
  END IF;

  -- Resolve what the tile pays. A mystery tile pays what was rolled when the
  -- day opened, times a lucky multiplier rolled right here, on the server,
  -- at the moment of the tap (phase 3). The browser learns both together.
  v_kind     := v_tile->>'kind';
  v_qty      := COALESCE((v_tile->>'quantity')::int, 0);
  v_diamonds := COALESCE((v_tile->>'diamonds')::int, 0);
  IF v_kind = 'mystery' THEN
    v_kind     := v_tile->'mystery'->>'kind';
    v_qty      := COALESCE((v_tile->'mystery'->>'quantity')::int, 0);
    v_diamonds := COALESCE((v_tile->'mystery'->>'diamonds')::int, 0);
    v_lucky    := public.fn_ca_daily_bonus_roll_lucky();
    v_qty      := v_qty * v_lucky;
    v_diamonds := LEAST(125, v_diamonds * v_lucky);
  END IF;

  v_ref := 'ca_daily_bonus:' || v_uid::text || ':' || v_today::text || ':' || p_slot::text;

  IF v_kind = 'diamonds' THEN
    IF v_diamonds <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
    END IF;
    v_award := public.award_diamonds_v2(
      v_uid, 'daily_bonus', v_ref, NULL,
      jsonb_build_object(
        '_source', 'fn_ca_daily_bonus_claim',
        'bonus_diamonds', v_diamonds,
        'bonus_streak', v_day.streak,
        'cycle_day', v_day.cycle_day,
        'slot', p_slot,
        'vip_tile', (v_tile->>'vip_only')::boolean,
        'mystery', v_tile->>'kind' = 'mystery',
        'lucky', v_lucky
      ));
    IF NOT COALESCE((v_award->>'success')::boolean, false) THEN
      -- award_diamonds_v2 writes nothing on refusal, so the tile stays
      -- claimable and the player sees the ledger's own reason.
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot,
               COALESCE(v_award->>'reason', 'award_refused'), v_award, v_from);
    END IF;
    SELECT t.id INTO v_journal_id FROM public.diamond_transactions t
     WHERE t.user_id = v_uid AND t.reference_id = v_ref
     ORDER BY t.created_at DESC LIMIT 1;
    v_balance := (v_award->>'balance_after')::integer;
    v_granted := jsonb_build_object('kind', 'diamonds', 'diamonds', (v_award->>'awarded')::integer,
                                    'quantity', 0, 'diamond_transaction_id', v_journal_id,
                                    'balance_after', v_balance, 'lucky', v_lucky);

  ELSIF v_kind IN ('throwables', 'rabbit_hunts', 'time_bank', 'shield') THEN
    IF v_qty <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
    END IF;
    v_feature := CASE v_kind WHEN 'throwables'   THEN 'throwable'
                             WHEN 'rabbit_hunts' THEN 'rabbit_hunt'
                             WHEN 'shield'       THEN 'streak_shield'
                             ELSE 'time_bank_seconds' END;
    -- A shield keeps for a month; everything else is spent at a table within a week.
    INSERT INTO public.feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at, source)
    VALUES (v_uid, v_feature, 0, 'per_use', v_qty,
            now() + CASE WHEN v_kind = 'shield' THEN interval '30 days' ELSE interval '7 days' END,
            'daily_bonus')
    RETURNING id INTO v_credit_id;
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = v_uid;
    v_granted := jsonb_build_object('kind', v_kind, 'feature', v_feature, 'quantity', v_qty, 'diamonds', 0,
                                    'feature_purchase_id', v_credit_id,
                                    'expires_at', now() + CASE WHEN v_kind = 'shield' THEN interval '30 days' ELSE interval '7 days' END,
                                    'balance_after', v_balance, 'lucky', v_lucky);

  ELSIF v_kind = 'boost' THEN
    -- 2x diamonds on Daily Missions for the tile's hours. One live boost per
    -- player: a second claim while one runs extends nothing and pays nothing.
    IF v_qty <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
    END IF;
    IF EXISTS (SELECT 1 FROM public.player_boosts b
                WHERE b.user_id = v_uid AND b.kind = 'mission_diamonds' AND b.ends_at > now()) THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'boost_already_live', NULL, v_from);
    END IF;
    v_boost_ends := now() + make_interval(hours => v_qty);
    v_boost_id   := gen_random_uuid();          -- written after the claim row it references
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = v_uid;
    v_granted := jsonb_build_object('kind', 'boost', 'factor', 2.00, 'hours', v_qty, 'quantity', v_qty, 'diamonds', 0,
                                    'boost_id', v_boost_id, 'ends_at', v_boost_ends,
                                    'balance_after', v_balance);
  ELSE
    RAISE EXCEPTION 'fn_ca_daily_bonus_claim: unsupported tile kind %', v_kind USING ERRCODE = '22023';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'idempotent', false,
    'slot', p_slot,
    'bonus_date', v_today,
    'tile', v_tile - 'mystery',
    'revealed', CASE WHEN v_tile->>'kind' = 'mystery'
                     THEN (v_tile->'mystery') || jsonb_build_object('lucky', v_lucky, 'quantity', v_qty, 'diamonds', v_diamonds)
                     ELSE NULL END,
    'granted', v_granted,
    'streak', v_day.streak,
    'first_claim_of_day', v_day.first_claimed_at IS NULL
  );

  INSERT INTO public.ca_daily_bonus_claims (id, user_id, bonus_date, slot, request_id, tile, granted, result, claimed_from)
  VALUES (v_claim_id, v_uid, v_today, p_slot, p_request_id, v_tile, v_granted, v_result, v_from);

  IF v_kind = 'boost' THEN
    INSERT INTO public.player_boosts (id, user_id, kind, factor, starts_at, ends_at, source, claim_id)
    VALUES (v_boost_id, v_uid, 'mission_diamonds', 2.00, now(), v_boost_ends, 'daily_bonus', v_claim_id);
  END IF;

  UPDATE public.ca_daily_bonus_days
     SET first_claimed_at = COALESCE(first_claimed_at, now())
   WHERE user_id = v_uid AND bonus_date = v_today;

  -- The two rules. Neither can refuse; both file once per day.
  PERFORM public.fn_ca_daily_bonus_velocity_check(v_today, v_from);
  IF v_kind = 'diamonds' THEN
    PERFORM public.fn_ca_daily_bonus_budget_check(v_today);
  END IF;

  RETURN v_result;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_claim' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claimed_from(p_client jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_headers  jsonb;
  v_ip       text;
  v_ip_class text;
  v_device   text;
  v_platform text;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_headers := NULL;
  END;
  v_ip := split_part(COALESCE(v_headers->>'x-forwarded-for', v_headers->>'cf-connecting-ip', ''), ',', 1);
  v_ip := btrim(v_ip);
  IF v_ip ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$' THEN
    v_ip_class := regexp_replace(v_ip, '\.\d{1,3}$', '.x');
  ELSIF position(':' IN v_ip) > 0 THEN
    v_ip_class := array_to_string((string_to_array(v_ip, ':'))[1:3], ':') || '::x';
  ELSE
    v_ip_class := NULL;
  END IF;
  v_device   := left(regexp_replace(COALESCE(p_client->>'device_id', ''), '[^A-Za-z0-9_.:-]', '', 'g'), 64);
  v_platform := left(regexp_replace(COALESCE(p_client->>'platform', ''), '[^A-Za-z0-9_.:-]', '', 'g'), 32);
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'device_id', NULLIF(v_device, ''),
    'platform',  NULLIF(v_platform, ''),
    'ua',        left(v_headers->>'user-agent', 200),
    'ip_class',  v_ip_class
  ));
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_claimed_from' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claims_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
BEGIN
  IF v_reason IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ca_daily_bonus_claims is append-only (% refused)', TG_OP
    USING ERRCODE = '55000',
          HINT = 'Account deletion and repairs set app.ledger_maintenance to a reason first.';
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_claims_append_only' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_eligibility(p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN RETURN 'unauthenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id) THEN RETURN 'no_profile'; END IF;
  -- Horses are players (Diamond Accounting Standard D22). Fixtures are not.
  IF public.fn_ca_is_cert_account(p_user_id) OR public.fn_ca_is_fixture_account(p_user_id) THEN
    RETURN 'fixture';
  END IF;
  RETURN 'ok';
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_eligibility' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_open_day(p_user_id uuid, p_today date)
 RETURNS ca_daily_bonus_days
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row        public.ca_daily_bonus_days;
  v_yesterday  public.ca_daily_bonus_days;
  v_last       public.ca_daily_bonus_days;
  v_shield     public.feature_purchases;
  v_streak     integer;
  v_cycle_day  integer;
  v_streak_day integer;
  v_tiles      jsonb;
  v_mystery    jsonb;
  v_protected  boolean := false;
  v_shield_id  uuid := NULL;
BEGIN
  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  IF FOUND THEN RETURN v_row; END IF;

  -- The streak advances only across consecutive CLAIMED days. An opened but
  -- unclaimed yesterday is a gap, exactly like a day never opened.
  SELECT * INTO v_yesterday FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today - 1;
  IF FOUND AND v_yesterday.first_claimed_at IS NOT NULL THEN
    v_streak := v_yesterday.streak + 1;
  ELSE
    -- PHASE 3, THE SHIELD. Exactly one missed day, and a shield in hand: the
    -- shield is spent here, at the moment the gap would have reset the
    -- streak, and the streak carries on from the last claimed day. Two missed
    -- days are a reset; a shield covers one day, never a holiday.
    SELECT * INTO v_last FROM public.ca_daily_bonus_days
     WHERE user_id = p_user_id AND bonus_date < p_today AND first_claimed_at IS NOT NULL
     ORDER BY bonus_date DESC LIMIT 1;
    IF FOUND AND v_last.bonus_date = p_today - 2 THEN
      SELECT * INTO v_shield FROM public.feature_purchases f
       WHERE f.user_id = p_user_id AND f.feature = 'streak_shield'
         AND f.uses_remaining > 0 AND (f.expires_at IS NULL OR f.expires_at > now())
       ORDER BY f.expires_at NULLS LAST, f.created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED;
      IF FOUND THEN
        UPDATE public.feature_purchases SET uses_remaining = uses_remaining - 1 WHERE id = v_shield.id;
        v_streak    := v_last.streak + 1;
        v_protected := true;
        v_shield_id := v_shield.id;
      END IF;
    END IF;
    IF NOT v_protected THEN
      v_streak := 1;
    END IF;
  END IF;

  v_cycle_day := ((v_streak - 1) % 7) + 1;
  SELECT c.streak_day INTO v_streak_day
    FROM public.ca_daily_bonus_calendar c
   WHERE c.streak_day = v_streak AND c.active
   LIMIT 1;

  -- The mystery roll is decided when the day opens and stored with the
  -- snapshot, so a claim reveals it rather than rolling it. The lucky
  -- multiplier on top of it is rolled at the claim (phase 3).
  v_mystery := public.fn_ca_daily_bonus_roll_mystery();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slot', c.slot,
           'kind', c.kind,
           'label', c.label,
           'vip_only', c.vip_only,
           'quantity', c.quantity,
           'base_diamonds', c.diamonds,
           -- The diamond tile scales with the platform streak ladder. Clamped
           -- to award_diamonds_v2's 125-per-call ceiling so the sheet never
           -- shows a number the ledger would trim.
           'diamonds', CASE WHEN c.kind = 'diamonds'
                            THEN LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(v_streak))::integer)
                            ELSE 0 END,
           'mystery', CASE WHEN c.kind = 'mystery' THEN v_mystery ELSE NULL END
         ) ORDER BY c.slot), '[]'::jsonb)
    INTO v_tiles
    FROM public.ca_daily_bonus_calendar c
   WHERE c.active
     AND ((v_streak_day IS NOT NULL AND c.streak_day = v_streak_day)
       OR (v_streak_day IS NULL AND c.cycle_day = v_cycle_day));

  IF v_tiles = '[]'::jsonb THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_open_day: no calendar rows for streak % (cycle day %)', v_streak, v_cycle_day
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ca_daily_bonus_days (user_id, bonus_date, streak, cycle_day, streak_day, tiles, streak_protected, shield_consumed_id)
  VALUES (p_user_id, p_today, v_streak, v_cycle_day, v_streak_day, v_tiles, v_protected, v_shield_id)
  ON CONFLICT (user_id, bonus_date) DO NOTHING;

  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  RETURN v_row;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_open_day' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_refuse(p_user_id uuid, p_today date, p_slot integer, p_reason text, p_detail jsonb, p_claimed_from jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.ca_daily_bonus_refusals (user_id, bonus_date, slot, reason, detail, claimed_from)
  VALUES (p_user_id, p_today, p_slot, p_reason, p_detail, p_claimed_from);
  RETURN jsonb_strip_nulls(jsonb_build_object('success', false, 'reason', p_reason, 'detail', p_detail));
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_refuse' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_roll_lucky()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_roll numeric := random();
BEGIN
  -- The lucky multiplier on a mystery tile: 1x 55%, 2x 25%, 3x 12%, 4x 5%,
  -- 5x 3%. Expected 1.61x. It multiplies the rolled prize, and the diamond
  -- engine's 125-per-claim ceiling still applies on top.
  RETURN CASE
    WHEN v_roll < 0.55 THEN 1
    WHEN v_roll < 0.80 THEN 2
    WHEN v_roll < 0.92 THEN 3
    WHEN v_roll < 0.97 THEN 4
    ELSE 5
  END;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_roll_lucky' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_roll_mystery()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_roll numeric := random();
BEGIN
  -- Weights, in cents of expected value: 10 (40%), 25 (25%), 5 throwables
  -- (15%), 3 rabbit hunts (10%), 50 (7%), 100 (3%) = 22.9 cents expected.
  RETURN CASE
    WHEN v_roll < 0.40 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 10,  'quantity', 0)
    WHEN v_roll < 0.65 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 25,  'quantity', 0)
    WHEN v_roll < 0.80 THEN jsonb_build_object('kind', 'throwables',   'diamonds', 0,   'quantity', 5)
    WHEN v_roll < 0.90 THEN jsonb_build_object('kind', 'rabbit_hunts', 'diamonds', 0,   'quantity', 3)
    WHEN v_roll < 0.97 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 50,  'quantity', 0)
    ELSE                    jsonb_build_object('kind', 'diamonds',     'diamonds', 100, 'quantity', 0)
  END;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_roll_mystery' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_elig       text;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_reset_at   timestamptz := ((now() AT TIME ZONE 'America/Chicago')::date + 1)::timestamp AT TIME ZONE 'America/Chicago';
  v_day        public.ca_daily_bonus_days;
  v_is_vip     boolean := false;
  v_caps       jsonb;
  v_tiles      jsonb;
  v_week       jsonb;
  v_next       jsonb;
  v_next_streak integer;
  v_next_cycle  integer;
  v_shield     jsonb;
  v_boost      jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_status requires an authenticated caller' USING ERRCODE = '28000';
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN jsonb_build_object('eligible', false, 'reason', v_elig, 'today', v_today,
                              'reset_at', v_reset_at,
                              'seconds_to_reset', GREATEST(0, floor(extract(epoch FROM (v_reset_at - now())))::integer),
                              'shown_today', false,
                              'tiles', '[]'::jsonb);
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;

  v_day  := public.fn_ca_daily_bonus_open_day(v_uid, v_today);
  v_caps := public.fn_ca_daily_bonus_caps(v_uid, v_is_vip);

  -- Today's tiles with their claim state. The mystery result stays hidden
  -- until it is claimed; the claim reveals it. A diamond tile the daily cap
  -- would trim is flagged so the sheet can say so before the tap.
  SELECT COALESCE(jsonb_agg(
           (t - 'mystery') || jsonb_build_object(
             'claimed', cl.id IS NOT NULL,
             'claimed_at', cl.created_at,
             'granted', cl.granted,
             'revealed', CASE WHEN cl.id IS NOT NULL THEN cl.result->'revealed' ELSE NULL END,
             'locked', (t->>'vip_only')::boolean AND NOT v_is_vip,
             'capped', cl.id IS NULL AND t->>'kind' = 'diamonds'
                       AND (t->>'diamonds')::int > (v_caps->>'daily_remaining')::int
           ) ORDER BY (t->>'slot')::int), '[]'::jsonb)
    INTO v_tiles
    FROM jsonb_array_elements(v_day.tiles) t
    LEFT JOIN public.ca_daily_bonus_claims cl
      ON cl.user_id = v_uid AND cl.bonus_date = v_today AND cl.slot = (t->>'slot')::int;

  -- The week strip. Today's entry comes from the snapshot the day was opened
  -- with, so a chest day (streak 14, 30) reads as the chest and not as the
  -- cycle-day rows it replaced. Every other day is the calendar's cycle row
  -- at the streak that day would carry.
  SELECT jsonb_agg(jsonb_build_object(
           'day', d,
           'streak', v_day.streak - v_day.cycle_day + d,
           'diamonds', CASE WHEN d = v_day.cycle_day THEN
                         (SELECT (t->>'diamonds')::int FROM jsonb_array_elements(v_day.tiles) t
                           WHERE t->>'kind' = 'diamonds' AND NOT (t->>'vip_only')::boolean
                           ORDER BY (t->>'slot')::int LIMIT 1)
                       ELSE
                         (SELECT LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(GREATEST(1, v_day.streak - v_day.cycle_day + d)))::integer)
                            FROM public.ca_daily_bonus_calendar c
                           WHERE c.active AND c.cycle_day = d AND c.kind = 'diamonds' AND NOT c.vip_only
                           ORDER BY c.slot LIMIT 1)
                       END,
           'extras', CASE WHEN d = v_day.cycle_day THEN
                         (SELECT string_agg(t->>'label', ', ' ORDER BY (t->>'slot')::int)
                            FROM jsonb_array_elements(v_day.tiles) t
                           WHERE t->>'kind' <> 'diamonds')
                       ELSE
                         (SELECT string_agg(c.label, ', ' ORDER BY c.slot)
                            FROM public.ca_daily_bonus_calendar c
                           WHERE c.active AND c.cycle_day = d AND c.kind <> 'diamonds')
                       END,
           'chest', d = v_day.cycle_day AND v_day.streak_day IS NOT NULL,
           'state', CASE WHEN d < v_day.cycle_day THEN 'done'
                         WHEN d = v_day.cycle_day THEN 'today'
                         ELSE 'upcoming' END
         ) ORDER BY d)
    INTO v_week
    FROM generate_series(1, 7) d;

  v_next_streak := v_day.streak + 1;
  v_next_cycle  := ((v_next_streak - 1) % 7) + 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', c.kind, 'label', c.label, 'vip_only', c.vip_only, 'quantity', c.quantity,
           'diamonds', CASE WHEN c.kind = 'diamonds'
                            THEN LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(v_next_streak))::integer)
                            ELSE 0 END
         ) ORDER BY c.slot), '[]'::jsonb)
    INTO v_next
    FROM public.ca_daily_bonus_calendar c
   WHERE c.active
     AND ((EXISTS (SELECT 1 FROM public.ca_daily_bonus_calendar s WHERE s.active AND s.streak_day = v_next_streak)
             AND c.streak_day = v_next_streak)
       OR (NOT EXISTS (SELECT 1 FROM public.ca_daily_bonus_calendar s WHERE s.active AND s.streak_day = v_next_streak)
             AND c.cycle_day = v_next_cycle));

  -- PHASE 3. What the player holds: shields (unspent, unexpired credits) and
  -- a live Mission Boost, and whether a shield saved today's streak.
  SELECT jsonb_build_object(
           'held', COALESCE(sum(f.uses_remaining), 0),
           'expires_at', min(f.expires_at))
    INTO v_shield
    FROM public.feature_purchases f
   WHERE f.user_id = v_uid AND f.feature = 'streak_shield'
     AND f.uses_remaining > 0 AND (f.expires_at IS NULL OR f.expires_at > now());
  SELECT jsonb_build_object(
           'active', true, 'factor', b.factor, 'kind', b.kind,
           'ends_at', b.ends_at,
           'seconds_left', GREATEST(0, floor(extract(epoch FROM (b.ends_at - now())))::integer),
           'applied_diamonds', b.applied_diamonds)
    INTO v_boost
    FROM public.player_boosts b
   WHERE b.user_id = v_uid AND b.kind = 'mission_diamonds' AND b.starts_at <= now() AND b.ends_at > now()
   ORDER BY b.ends_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'eligible', true,
    'today', v_today,
    'reset_at', v_reset_at,
    'seconds_to_reset', GREATEST(0, floor(extract(epoch FROM (v_reset_at - now())))::integer),
    'streak', v_day.streak,
    'cycle_day', v_day.cycle_day,
    'streak_day', v_day.streak_day,
    'multiplier', public.fn_get_streak_multiplier(v_day.streak),
    'is_vip', v_is_vip,
    'claimed_today', v_day.first_claimed_at IS NOT NULL,
    'shown_today', v_day.sheet_shown_at IS NOT NULL,
    'unclaimed', (SELECT count(*) FROM jsonb_array_elements(v_tiles) x
                   WHERE NOT (x->>'claimed')::boolean AND NOT (x->>'locked')::boolean),
    'tiles', v_tiles,
    'week', v_week,
    'tomorrow', v_next,
    'caps', v_caps,
    'cents_per_diamond', 1,
    'shield', COALESCE(v_shield, jsonb_build_object('held', 0, 'expires_at', NULL)),
    'streak_protected', COALESCE(v_day.streak_protected, false),
    'boost', COALESCE(v_boost, jsonb_build_object('active', false))
  );
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_status' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_velocity_check(p_today date, p_claimed_from jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_device_users CONSTANT integer := 3;
  c_ip_users     CONSTANT integer := 6;
  v_device text := p_claimed_from->>'device_id';
  v_ip     text := p_claimed_from->>'ip_class';
  v_n      integer;
BEGIN
  IF v_device IS NOT NULL THEN
    SELECT count(DISTINCT user_id) INTO v_n FROM public.ca_daily_bonus_claims
     WHERE bonus_date = p_today AND claimed_from->>'device_id' = v_device;
    IF v_n >= c_device_users AND NOT EXISTS (
         SELECT 1 FROM public.financial_alerts a
          WHERE a.source = 'fn_ca_daily_bonus_claim.device_velocity'
            AND a.context->>'device_id' = v_device AND a.context->>'bonus_date' = p_today::text) THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_ca_daily_bonus_claim.device_velocity',
              format('%s accounts claimed the daily bonus from one device today', v_n),
              jsonb_build_object('device_id', v_device, 'bonus_date', p_today, 'accounts', v_n,
                                 'users', (SELECT jsonb_agg(DISTINCT user_id) FROM public.ca_daily_bonus_claims
                                            WHERE bonus_date = p_today AND claimed_from->>'device_id' = v_device)));
    END IF;
  END IF;
  IF v_ip IS NOT NULL THEN
    SELECT count(DISTINCT user_id) INTO v_n FROM public.ca_daily_bonus_claims
     WHERE bonus_date = p_today AND claimed_from->>'ip_class' = v_ip;
    IF v_n >= c_ip_users AND NOT EXISTS (
         SELECT 1 FROM public.financial_alerts a
          WHERE a.source = 'fn_ca_daily_bonus_claim.ip_velocity'
            AND a.context->>'ip_class' = v_ip AND a.context->>'bonus_date' = p_today::text) THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_ca_daily_bonus_claim.ip_velocity',
              format('%s accounts claimed the daily bonus from one network today', v_n),
              jsonb_build_object('ip_class', v_ip, 'bonus_date', p_today, 'accounts', v_n));
    END IF;
  END IF;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_velocity_check' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid DEFAULT NULL::uuid, p_settlement_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_autoskip_tables text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t text;
BEGIN
  -- validate against the LIVE vocabulary so this can never lag a CHECK change
  IF p_category IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_category_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_category || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: category % is not in the ledger vocabulary - add it to chip_ledger_category_check FIRST, then declare it', p_category;
  END IF;
  IF p_counterparty IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_from_type_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_counterparty || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: counterparty % is not in the ledger vocabulary - add it to the from/to type CHECKs FIRST, then declare it', p_counterparty;
  END IF;

  PERFORM set_config('app.ledger_category', p_category, true);
  PERFORM set_config('app.ledger_counterparty', p_counterparty, true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
  IF p_settlement_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_settlement', p_settlement_id::text, true);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM set_config('app.ledger_idempotency_key', p_idempotency_key, true);
  END IF;
  IF p_autoskip_tables IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_autoskip_tables LOOP
      IF v_t !~ '^[a-z_]+$' THEN
        RAISE EXCEPTION 'fn_ca_declare_ledger: bad autoskip table name %', v_t;
      END IF;
      PERFORM set_config('app.ledger_autoskip_' || v_t, '1', true);
    END LOOP;
  END IF;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_declare_ledger' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_born_with_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_fixture boolean := false;
BEGIN
  BEGIN
    v_fixture := public.fn_ca_is_fixture_account(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    v_fixture := false;
  END;
  -- DR2 (DIAMOND-RULINGS 17): once flipped, a player profile may not be born holding
  -- diamonds; every seeder inserts 0 and the Mint grants under signup:<id>. Fixtures are
  -- filed at info and never refused. The raise is outside the handlers below on purpose.
  IF NOT v_fixture AND public.fn_ca_diamond_rule_mode('DR2:balance_born_outside_the_mint') = 'refuse' THEN
    RAISE EXCEPTION 'DR2: a profile may not be born holding % diamonds; insert 0 and let fn_ca_mint grant under signup:<id>', NEW.diamonds
      USING ERRCODE = 'P0402';
  END IF;
  BEGIN
    PERFORM public.fn_ca_diamond_incident(
      'DR2:balance_born_outside_the_mint',
      CASE WHEN v_fixture THEN 'info' ELSE 'warning' END,
      NEW.id, NEW.diamonds, 'profiles INSERT',
      jsonb_build_object('is_horse', NEW.is_horse, 'is_fixture', v_fixture,
                         'app_name', COALESCE(current_setting('application_name', true), ''),
                         'db_role', CURRENT_USER, 'username', NEW.username, 'diamonds', NEW.diamonds));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ca_diamond_born_with_balance could not record the incident for %: %', NEW.id, SQLERRM;
  END;
  BEGIN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after,
       supply_after, reason, performed_by, performed_by_label)
    VALUES
      ('seed:' || NEW.id::text, 'mint', 'diamonds', 'player', NEW.id,
       COALESCE(NULLIF(BTRIM(NEW.username), ''), NEW.id::text), NEW.diamonds, 0, NEW.diamonds,
       public.fn_ca_mint_supply('diamonds') + NEW.diamonds,
       CASE WHEN v_fixture THEN 'balance present at fixture profile INSERT' ELSE 'balance present at profile INSERT' END,
       NULL, 'zz_ca_diamond_born_with_balance')
    ON CONFLICT (op_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ca_diamond_born_with_balance could not register the seed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_born_with_balance' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_catalog_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_sql text;
BEGIN
    BEGIN
        v_sql := format(
            'INSERT INTO public.%I (op, old_row, new_row) VALUES ($1, $2, $3)',
            TG_TABLE_NAME || '_history');
        IF TG_OP = 'INSERT' THEN
            EXECUTE v_sql USING TG_OP, NULL::jsonb, to_jsonb(NEW);
        ELSIF TG_OP = 'DELETE' THEN
            EXECUTE v_sql USING TG_OP, to_jsonb(OLD), NULL::jsonb;
        ELSE
            EXECUTE v_sql USING TG_OP, to_jsonb(OLD), to_jsonb(NEW);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.fn_ca_diamond_incident(
            'D21:catalog_history_write_failed', 'warning', NULL, NULL,
            'fn_ca_diamond_catalog_history',
            jsonb_build_object('table', TG_TABLE_NAME, 'op', TG_OP,
                               'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM));
    END;
    RETURN NULL;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_catalog_history' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earn_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_engine text; v_period text; v_day date; v_budget bigint; v_spent bigint; v_awarded bigint;
    v_cap integer; v_cap_vip integer; v_is_vip boolean := false; v_at timestamptz;
    v_refuse text; v_refuse_detail text; v_armed boolean;
BEGIN
    BEGIN
        IF COALESCE(NEW.issuance_class, '') IN ('purchased', 'transferred', 'refund', 'admin', 'arena', 'spend', 'deletion', 'bridge') THEN
            RETURN NULL;
        END IF;
        IF COALESCE(NEW.type, '') = 'purchase' OR COALESCE(NEW.transaction_type, '') = 'purchase' THEN
            RETURN NULL;
        END IF;
        -- Fixture accounts are not players (2026-09-07 review DEF-03): their issuance is not
        -- promotional spend. Horses ARE players and are counted.
        IF public.fn_ca_is_fixture_account(NEW.user_id) THEN
            RETURN NULL;
        END IF;

        v_at     := COALESCE(NEW.created_at, now());
        v_engine := CASE WHEN NEW.issuance_class IS NULL THEN 'unclassified'
                         ELSE public.fn_ca_diamond_engine_of(NEW.type, NEW.transaction_type, NEW.source,
                                                             NEW.description, NEW.reference_id) END;
        v_period := to_char((v_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM');
        v_day    := (v_at AT TIME ZONE 'America/Chicago')::date;

        -- THE PER-USER ROW FIRST. It is keyed (user_id, engine, day), so it contends only with the
        -- same player's own concurrent awards - which is to say, essentially never. It used to sit
        -- after the budget write and was therefore lost every time the budget write timed out,
        -- taking the per-user cap figure down with it.
        INSERT INTO public.diamond_user_daily_awards (user_id, engine, day, awarded, updated_at)
        VALUES (NEW.user_id, v_engine, v_day, NEW.amount, now())
        ON CONFLICT (user_id, engine, day) DO UPDATE
           SET awarded = diamond_user_daily_awards.awarded + EXCLUDED.awarded, updated_at = now()
        RETURNING awarded INTO v_awarded;

        -- THE BUDGET LINE EXISTS, BUT ITS TOTAL IS NO LONGER MAINTAINED HERE. This upsert touches
        -- the row only when the line is missing for a new period, so it is a once-a-month write,
        -- not a once-an-award one.
        INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds, updated_at)
        VALUES (v_period, v_engine,
                COALESCE((SELECT b.budget_diamonds FROM public.diamond_reward_budgets b
                           WHERE b.engine = v_engine AND b.period < v_period
                           ORDER BY b.period DESC LIMIT 1), 2500000),
                0, now())
        ON CONFLICT (period, engine) DO NOTHING;

        -- ONE INSERT, NO CONTENTION. Two awards never touch the same row, so there is nothing to
        -- wait behind. This is the whole fix.
        INSERT INTO public.ca_diamond_engine_spend (period, engine, user_id, amount, journal_id, at)
        VALUES (v_period, v_engine, NEW.user_id, NEW.amount, NEW.id, v_at)
        ON CONFLICT (journal_id) DO NOTHING;

        -- RULING 21: THE ENGINE'S MONTHLY TOTAL IS A FORECAST, NOT A GATE. It is a pot shared
        -- between players, so refusing on it punishes whoever arrives last for what everybody
        -- else earned. The spend row appended above is the measurement, and the economy report
        -- reads it; nothing here refuses, and no incident is filed per award - daily_missions is
        -- 4.2x its line today, so one would fire on every single award and be muted inside a day
        -- (10.84). The only cap that refuses is the per-user one below.

        SELECT c.max_per_user_per_day, c.max_per_user_per_day_vip INTO v_cap, v_cap_vip
          FROM public.diamond_engine_daily_caps c WHERE c.engine = v_engine;
        IF v_cap_vip IS NOT NULL THEN
            SELECT COALESCE(p.is_vip, false) AND (COALESCE(p.vip_tier, '') = 'lifetime'
                     OR (p.vip_expires_at IS NOT NULL AND p.vip_expires_at > now()))
              INTO v_is_vip FROM public.profiles p WHERE p.id = NEW.user_id;
            IF COALESCE(v_is_vip, false) THEN v_cap := v_cap_vip; END IF;
        END IF;

        IF v_cap IS NOT NULL AND v_awarded > v_cap THEN
            IF public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse' THEN
                v_refuse := COALESCE(v_refuse, 'DR7:user_over_daily_cap');
                v_refuse_detail := COALESCE(v_refuse_detail, format('engine %s day %s cap %s awarded %s', v_engine, v_day, v_cap, v_awarded));
            END IF;
            PERFORM public.fn_ca_diamond_incident('DR7:user_over_daily_cap', 'warning', NEW.user_id, NEW.amount,
                'fn_ca_diamond_earn_ledger',
                jsonb_build_object('engine', v_engine, 'day', v_day, 'is_vip', v_is_vip,
                                   'max_per_user_per_day', v_cap, 'awarded_today', v_awarded,
                                   'journal_id', NEW.id, 'reference_id', NEW.reference_id));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- A FAILURE HERE MEANS A GUARD DID NOT RUN, and that is a different thing from a counter
        -- being late. While both rules are in `log` it is a warning; the moment either is armed to
        -- refuse, a write that could not complete is the guard failing OPEN, so it is CRITICAL and
        -- says so. The award is still paid: a player never loses an earned reward because our
        -- bookkeeping stumbled (10.9 rule 3), and "I could not tell" gets its own severity rather
        -- than being folded into silence (10.86).
        -- Only the per-user cap can refuse now (ruling 21), so it alone decides whether a
        -- write that could not complete means a guard failed open. The engine pot is a forecast
        -- and its rule row is deleted below; consulting a rule that no longer exists would read
        -- as armed while being nothing at all.
        v_armed := public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse';
        PERFORM public.fn_ca_diamond_incident('DR7:ledger_write_failed',
            CASE WHEN v_armed THEN 'critical' ELSE 'warning' END, NEW.user_id, NEW.amount,
            'fn_ca_diamond_earn_ledger',
            jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'journal_id', NEW.id,
                               'reference_id', NEW.reference_id, 'rules_armed', v_armed,
                               'note', CASE WHEN v_armed
                                            THEN 'A rule is armed to refuse and this write did not complete, so neither cap was evaluated for this award. The guard failed OPEN.'
                                            ELSE 'Both rules are in log mode; nothing was refused either way.' END));
    END;
    -- DIAMOND-RULINGS 17/18: a flipped DR7 refuses the credit. Raising here aborts the writer's
    -- whole transaction (balance, journal, ledger rows), so nothing is issued and nothing is
    -- half-written. The incident above rolls back with it; the writer's error carries the reason.
    IF v_refuse IS NOT NULL THEN
        RAISE EXCEPTION '%: promotional issuance refused (%)', v_refuse, v_refuse_detail
            USING ERRCODE = 'P0407';
    END IF;
    RETURN NULL;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_earn_ledger' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN COALESCE(p_transaction_type,p_type)='referral_qualified' THEN 'qualified_referrals'
        WHEN starts_with(p_reference_id, 'ca_daily_bonus:')   THEN 'club_arena_daily'
        WHEN starts_with(p_reference_id, 'wheel:')            THEN 'wheel'
        WHEN starts_with(p_reference_id, 'trivia_tourn_')     THEN 'trivia_tournaments'
        WHEN starts_with(p_reference_id, 'trivia_session_')   THEN 'trivia'
        WHEN starts_with(p_reference_id, 'trivia_wheel_')     THEN 'trivia'
        WHEN starts_with(p_reference_id, 'challenge_claim')   THEN 'daily_challenges'
        WHEN starts_with(p_reference_id, 'daily_mission_milestones:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily-missions-historical-multiplier:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily_mission_')    THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'streak_milestone_') THEN 'share_streak'
        WHEN starts_with(p_reference_id, 'streak_')           THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'signup:')           THEN 'signup'
        WHEN starts_with(p_reference_id, 'easter_egg_')       THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'video_favorite_')   THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'vip_stipend_')      THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'hotd_')             THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'progress_')         THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'customization-cert-fund') THEN 'cert_fixture'
        WHEN p_source = 'complete_daily_challenge' THEN 'memory_game'
        WHEN p_source = 'handle_new_user'          THEN 'signup'
        WHEN p_source = 'union'                    THEN 'union_grant'
        WHEN p_source = 'the_mint'                 THEN 'mint'
        WHEN COALESCE(p_transaction_type, p_type) IN ('wheel_prize', 'wheel_spin') THEN 'wheel'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'referral_bonus', 'referral_bonus_reversal', 'referral_qualified',
                'referral_referee', 'referral_vip_conversion',
                'referral_milestone', 'referral_reward')                    THEN 'referrals'
        WHEN COALESCE(p_transaction_type, p_type) = 'signup_bonus'         THEN 'signup'
        WHEN COALESCE(p_transaction_type, p_type) = 'union_grant'          THEN 'union_grant'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'pvp_refund', 'pvp_win', 'pvp_tie_refund', 'trivia_run',
                'trivia_daily_bonus', 'daily_trivia', 'trivia_reward',
                'trivia_prize_wheel', 'endless_reward', 'survival_reward',
                'mixed_reward', 'time_attack_reward', 'trivia_double_win')  THEN 'trivia'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'tournament_prize', 'tournament_entry_refund',
                'tournament_cancel_refund')                                THEN 'trivia_tournaments'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_challenge_claim') THEN 'daily_challenges'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_mission_milestone', 'daily_mission_reward') THEN 'daily_missions'
        WHEN COALESCE(p_transaction_type, p_type) = 'streak_reward'        THEN 'share_streak'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'daily_login', 'easter_egg', 'training_reward',
                'video_favorite', 'vip_stipend')                           THEN 'catalog_v2'
        WHEN COALESCE(p_transaction_type, p_type) IN ('credit', 'earn', 'bonus') THEN 'legacy_credit'
        WHEN p_description LIKE 'Diamond Rewards v2:%'                      THEN 'catalog_v2'
        ELSE 'other'
    END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_engine_of' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_incident(p_rule text, p_severity text, p_user_id uuid, p_amount numeric, p_writer text, p_detail jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_sev text := COALESCE(p_severity, 'info');
BEGIN
  -- Fixture accounts are not players (docs/DIAMOND-RULINGS.md): a rule filed against one is info
  -- unless it is critical. Horses are players and are never fixtures.
  IF v_sev <> 'critical' AND p_user_id IS NOT NULL AND public.fn_ca_is_fixture_account(p_user_id) THEN
    v_sev := 'info';
  END IF;
  INSERT INTO public.ca_diamond_incidents (rule, severity, user_id, amount, writer, detail)
  VALUES (p_rule, v_sev, p_user_id, p_amount, p_writer,
          COALESCE(p_detail, '{}'::jsonb) || CASE WHEN v_sev <> COALESCE(p_severity, 'info')
                                                  THEN jsonb_build_object('severity_requested', p_severity, 'fixture_account', true)
                                                  ELSE '{}'::jsonb END);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_incident could not record % (%): %', p_rule, p_writer, SQLERRM;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_incident' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_classifier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_type text := COALESCE(NEW.transaction_type, NEW.type, 'unknown');
  v_stack text; v_writer text; v_filled boolean := false;
BEGIN
  IF NEW.issuance_class IS NULL THEN
    v_filled := true;
    NEW.issuance_class := CASE
      WHEN v_type = 'purchase' THEN 'purchased'
      WHEN v_type = 'refund' OR right(v_type, 7) = '_refund' THEN 'refund'
      WHEN v_type IN ('transfer', 'diamond_gift_received', 'live_gift_received', 'diamond_received',
                      'diamond_gift_sent', 'live_gift_sent', 'spend_transfer') THEN 'transferred'
      WHEN v_type = 'adjustment' THEN 'admin'
      WHEN v_type = 'mint' THEN 'admin'
      WHEN v_type = 'burn' THEN 'deletion'
      WHEN v_type IN ('union_grant', 'signup_bonus') THEN 'promotional'
      WHEN COALESCE(NEW.amount, 0) < 0 THEN 'spend'
      WHEN EXISTS (SELECT 1 FROM public.diamond_reward_catalog c WHERE c.action_key = v_type)
           OR COALESCE(NEW.description, '') LIKE 'Diamond Rewards v2:%' THEN 'promotional'
      ELSE 'earned'
    END;
  END IF;
  IF NEW.counterparty IS NULL THEN
    v_filled := true;
    NEW.counterparty := CASE NEW.issuance_class
      WHEN 'purchased' THEN 'purchase_clearing'
      WHEN 'refund' THEN CASE WHEN v_type IN ('refund', 'stripe') THEN 'purchase_clearing' ELSE 'revenue:' || v_type END
      WHEN 'transferred' THEN 'player:' || COALESCE(NEW.metadata->>'recipient_id', NEW.metadata->>'sender_id', 'unknown')
      WHEN 'admin' THEN 'adjustment'
      WHEN 'deletion' THEN 'retired'
      WHEN 'spend' THEN 'revenue:' || v_type
      ELSE 'promo_budget:' || public.fn_ca_diamond_engine_of(NEW.type, NEW.transaction_type, NEW.source, NEW.description, NEW.reference_id)
    END;
  END IF;
  IF v_filled THEN
    BEGIN
      GET DIAGNOSTICS v_stack = PG_CONTEXT;
      SELECT (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] INTO v_writer
        FROM regexp_split_to_table(COALESCE(v_stack, ''), E'\n') WITH ORDINALITY AS t(ln, ord)
       WHERE t.ln ~ 'function (?:public\.)?[A-Za-z0-9_]+\('
         AND (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] <> 'fn_ca_diamond_journal_classifier'
       ORDER BY t.ord LIMIT 1;
      PERFORM public.fn_ca_diamond_incident(
        'DR12:journal_row_unclassified_by_writer', 'info', NEW.user_id, NEW.amount,
        COALESCE(v_writer, '(no function frame)'),
        jsonb_build_object('type', NEW.type, 'transaction_type', NEW.transaction_type,
                           'description', left(NEW.description, 120), 'reference_id', NEW.reference_id,
                           'classified_as', NEW.issuance_class, 'counterparty', NEW.counterparty,
                           'note', 'the writer left issuance_class or counterparty NULL; the classifier filled them. Fix the writer.'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_journal_classifier' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_is_transfer(p_type text, p_transaction_type text, p_source text, p_issuance_class text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  WITH v AS (
    SELECT lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), '')) AS kind,
           lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), '')) AS class,
           lower(COALESCE(NULLIF(btrim(p_source), ''), '')) AS src
  )
  SELECT CASE
    -- The Mint's own doors register their own rows; the seed door writes its
    -- own 'seed:<id>' row. Neither is a transfer and neither may be judged as
    -- one. Same order, same reasons, as fn_ca_diamond_journal_origin.
    WHEN v.src = 'the_mint' THEN false
    WHEN v.kind = 'signup_bonus' OR v.src = 'handle_new_user' THEN false
    ELSE v.class = 'transferred'
      OR v.kind IN ('transfer', 'diamond_gift_sent', 'diamond_gift_received', 'diamond_received',
                    'live_gift_sent', 'live_gift_received', 'wallet_transfer',
                    'wallet_diamond_transfer', 'stream_gift', 'union_grant_transfer')
      OR v.kind LIKE '%gift%' OR v.kind LIKE '%transfer%'
  END
  FROM v;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_journal_is_transfer' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind  text := lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), ''));
  v_class text := lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), ''));
  v_src   text := lower(COALESCE(NULLIF(btrim(p_source), ''), ''));
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN RETURN NULL; END IF;
  -- The Mint's own doors register their own rows.
  IF v_src = 'the_mint' THEN RETURN NULL; END IF;
  -- SO DOES THE SEED DOOR. fn_ca_diamond_born_with_balance writes the
  -- 'seed:<id>' register row for the signup grant and then the journal row.
  -- Registering it here as well counts one movement twice (2026-09-05: 18
  -- duplicate pairs, 9,000 diamonds). Named writer, not a class: every OTHER
  -- promotional credit still registers here.
  IF v_kind = 'signup_bonus' OR v_src = 'handle_new_user' THEN RETURN NULL; END IF;
  -- Player to player: supply moves, none is created or retired.
  IF public.fn_ca_diamond_journal_is_transfer(p_type, p_transaction_type, p_source, p_issuance_class) THEN
    RETURN NULL;
  END IF;
  -- THE ARENA DOORS MOVE MONEY, THEY DO NOT ISSUE IT. A deposit takes diamonds out of
  -- profiles.diamonds and puts them in the platform club's member wallet; a withdrawal is the
  -- mirror. The player still owns them and the supply is unchanged, so the register must not
  -- follow either leg - the same treatment, for the same reason, as a player-to-player transfer
  -- above. Classified as 'spend' (deposit) and 'arena' (withdrawal), the register would have
  -- burned the float on the way in and minted it on the way out (2026-09-08).
  IF v_kind IN ('arena_deposit', 'arena_withdraw') THEN RETURN NULL; END IF;
  -- The deletion door writes its own register row.
  IF v_class = 'deletion' THEN RETURN NULL; END IF;
  -- A test fixture row is not supply the Mint issued.
  IF v_kind LIKE 'test%' THEN RETURN NULL; END IF;

  IF p_amount > 0 THEN
    IF v_class = 'purchased' OR v_kind IN ('purchase', 'stripe_purchase', 'diamond_purchase') THEN
      RETURN 'purchase';
    ELSIF v_class = 'refund' OR v_kind LIKE '%refund%' OR v_kind = 'diamond_refund' THEN
      RETURN 'refund';
    ELSIF v_class = 'promotional' OR v_kind IN ('union_grant', 'bonus', 'promo',
                                                 'promo_purchased', 'easter_egg', 'vip_daily',
                                                 'vip_stipend', 'vip_monthly') THEN
      RETURN 'promotion';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'admin_grant') THEN
      RETURN 'adjustment';
    -- 'arcade%' only. The 'arena' CLASS now belongs to the arena doors, which are handled
    -- as transfers above; leaving it here would have made a withdrawal mint.
    ELSIF v_kind LIKE 'arcade%' THEN
      RETURN 'arena';
    ELSE
      RETURN 'reward';
    END IF;
  ELSE
    IF v_kind IN ('chip_mint', 'chip_purchase', 'mint_chips', 'diamonds_to_chips') OR v_class = 'bridge' THEN
      RETURN 'bridge';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'chargeback', 'clawback') THEN
      RETURN 'adjustment';
    ELSE
      RETURN 'spend';
    END IF;
  END IF;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_journal_origin' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_follows_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.fn_ca_register_diamond_journal_row(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- The diamonds already moved and the journal row stands. A register that
    -- could not be written is an incident, not a refused purchase.
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'MINT:register_follow_failed', 'critical', NEW.user_id, NEW.amount,
        'fn_ca_diamond_register_follows_journal',
        jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM,
                           'journal_id', NEW.id, 'reference_id', NEW.reference_id));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN NULL;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_register_follows_journal' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_rule_mode(p_rule text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((SELECT m.mode FROM public.ca_diamond_rule_modes m WHERE m.rule = p_rule), 'log');
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_rule_mode' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_transfer_names_its_counterparty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_cp text := btrim(COALESCE(NEW.counterparty, ''));
BEGIN
  IF COALESCE(NEW.amount, 0) = 0 THEN
    RETURN NEW;
  END IF;
  -- COALESCE, not NOT: an unreadable answer must not be read as "refuse". The
  -- register follows anything this says no to, so nothing goes unrecorded either way.
  IF COALESCE(public.fn_ca_diamond_journal_is_transfer(NEW.type, NEW.transaction_type,
                                                       NEW.source, NEW.issuance_class), false) = false THEN
    RETURN NEW;   -- the register will follow this row; nothing to prove here
  END IF;
  IF v_cp ~* '^player:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = substring(v_cp from 8)::uuid) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a diamond transfer must name the player on the other side: % of % diamonds for % carries counterparty %',
    COALESCE(NEW.transaction_type, NEW.type, 'transfer'), NEW.amount, NEW.user_id,
    COALESCE(NULLIF(v_cp, ''), '(none)')
    USING ERRCODE = 'P0408',
          HINT = 'The Mint register skips a transfer because supply only moves - which is only true if another leg moved it back. Name the counterparty: add_diamonds_to_balance p_counterparty_id, or recipient_id in the deduct_diamonds metadata.';
END
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_transfer_names_its_counterparty' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_engine_spend_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION
    'ca_diamond_engine_spend is append-only: % on id % refused. It is the register of engine spend, and it replaced a running total whose mutability cost 5,861 awards. Correct it forward with a new row.',
    TG_OP, COALESCE(OLD.id, -1);
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_engine_spend_append_only' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_overlay_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Explicit rows only: the autoledger twin (description 'auto-ledgered ...')
  -- of the same debit is not a second overlay. None has been written since
  -- the lock trigger was fixed on 09-03; the shadow still skips them.
  IF COALESCE(NEW.description, '') LIKE 'auto-ledgered%' THEN RETURN NULL; END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'overlay', p_overlay_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_escrow_on_overlay_leg' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
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
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_escrow_on_reserve_leg' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_transfer_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.metadata->>'entry_split_version' = '2' THEN
    IF round(NEW.amount,2) IS DISTINCT FROM round((NEW.metadata->>'entry_prize')::numeric
        + (NEW.metadata->>'entry_bounty')::numeric + (NEW.metadata->>'entry_fee')::numeric,2)
       OR (NEW.metadata->>'entry_prize')::numeric < 0
       OR (NEW.metadata->>'entry_bounty')::numeric < 0
       OR (NEW.metadata->>'entry_fee')::numeric < 0 THEN
      RAISE EXCEPTION 'Satellite transfer does not match its funded split' USING ERRCODE='23514';
    END IF;
    PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite split entry',
      p_gross_in => round(NEW.amount - (NEW.metadata->>'entry_fee')::numeric,2),
      p_bounty_in => (NEW.metadata->>'entry_bounty')::numeric);
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite seat in', p_satellite_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_escrow_on_seat_transfer_leg' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_house_board_allows_automation(p_club_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  -- DERIVED FIRST: the platform club is the house board, and always will be, without anybody
  -- remembering to add it to a list. This is the half that cannot rot.
  SELECT COALESCE((SELECT c.is_platform FROM public.clubs c WHERE c.id = p_club_id), false)
     -- LEGACY, AND IT IS DEBT: four chip house boards that predate clubs.is_platform and carry no
     -- flag of their own. Give them one and these four lines delete themselves.
     OR p_club_id = ANY (ARRAY[
          'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,   -- Club JAQK
          'a0000000-0000-0000-0000-000000000001'::uuid,   -- SHARK CLUB
          'fade0000-0000-0000-0000-000000000001'::uuid,   -- Midway Union
          '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid    -- Deep Stack Society
        ]);
$$
;
CREATE OR REPLACE FUNCTION public.fn_ca_is_cert_account(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- DEFINER, like fn_ca_is_fixture_account. It reads auth.users, which `authenticated` cannot
  -- select from, so as INVOKER it answered one thing for service_role and another for everyone
  -- else - a predicate whose result depended on the caller rather than the account.
  --
  -- A HORSE IS A PLAYER (CLAUDE.md 10.5), so it is never certification equipment, whatever its
  -- address looks like. The fleet shares an email domain, which classified 468 of them as test
  -- equipment until 2026-09-08.
  SELECT p_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))
    AND (
      EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p_user_id AND c.active)
      OR p_user_id::text LIKE '00000000-0000-0000-0000-%'
      OR EXISTS (SELECT 1 FROM auth.users u
                  WHERE u.id = p_user_id
                    AND (u.email LIKE '%@horses.smarter.poker'
                         OR u.email LIKE '%.invalid'))
    );
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_is_cert_account' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role","authenticated"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_is_fixture_account(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))
    AND (
      p_user_id::text LIKE '00000000-0000-0000-0000-%'
      OR EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p_user_id AND c.active)
      OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id AND u.email LIKE '%.invalid')
    );
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_is_fixture_account' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_issuance_leg_is_registered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_pol public.ca_mint_policy%ROWTYPE;
  v_24h numeric;
BEGIN
  IF NEW.from_type = ANY (v_outside) AND NOT (NEW.to_type = ANY (v_outside))
     AND NEW.category <> 'correction' THEN
    SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
    IF NEW.amount > v_pol.per_operation_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: % chips in one leg is over the per-operation ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        NEW.amount, v_pol.per_operation_cap_chips USING ERRCODE = 'P0403';
    END IF;
    v_24h := public.fn_ca_mint_issued_24h('chips', NEW.id) + NEW.amount;
    IF v_24h > v_pol.rolling_24h_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: this leg would bring the last 24 hours to % chips, over the rolling ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        v_24h, v_pol.rolling_24h_cap_chips USING ERRCODE = 'P0403';
    END IF;
  END IF;
  PERFORM public.fn_ca_register_issuance_leg(NEW.id);
  RETURN NULL;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_issuance_leg_is_registered' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
  v_sev text;
  v_j jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSIF TG_TABLE_NAME = 'vip_points_ledger' THEN
      /* Phase 8 (2026-09-08). A VIP leg is written once, final: the award
         writer no longer inserts 0 and updates it afterwards. Nothing on this
         table may change. */
      v_allowed_update := false;
    ELSIF TG_TABLE_NAME = 'agent_commissions' THEN
      /* Phase 8. A commission row is what was earned on one hand. The only
         thing that happens to it afterwards is being settled, once. */
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
        AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
        AND NEW.commission_rate IS NOT DISTINCT FROM OLD.commission_rate
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND (OLD.settled_at IS NULL OR NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at);
    ELSIF TG_TABLE_NAME = 'rakeback_period_payouts' THEN
      /* Phase 8. What was paid, to whom, for which period, never changes;
         status, paid_at, wallet_transaction_id and failure_reason are the
         payout's own bookkeeping. */
      v_allowed_update :=
        NEW.payout_amount IS NOT DISTINCT FROM OLD.payout_amount
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.rakeback_period_id IS NOT DISTINCT FROM OLD.rakeback_period_id
        AND NEW.currency IS NOT DISTINCT FROM OLD.currency
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  /* Phase 8. fn_close_settlement_period inserts a payout row as its
     idempotency claim BEFORE debiting the treasury and deletes it again on a
     shortfall, inside the same transaction. That is a compensation, not a
     mutation of history, so this table's DELETE is allowed - and RECORDED,
     every time, so a person can tell a compensation from a hand on the
     table. The meter counts these. */
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'rakeback_period_payouts' THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true),
            COALESCE(v_reason, 'rakeback-payout-delete: compensation on a treasury shortfall, or maintenance without app.ledger_maintenance'),
            to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      -- a routine, recorded maintenance is filed, not shouted about
      SELECT k.severity INTO v_sev
        FROM public.ca_ledger_maintenance_kinds k WHERE k.kind = v_kind;
      v_sev := COALESCE(v_sev, 'warning');
      /* A REGISTERED MAINTENANCE KIND MARKED `info` IS RECORDED, NOT RAISED
         (2026-09-10). The row above is already written to
         ca_ledger_mutation_log, whole, before this point. A kind the
         registry declares `info` says so deliberately - "expected,
         scheduled and reversible: recorded, not alarming" - so it does not
         also open a board item once per run, for ever. An UNREGISTERED
         kind still defaults to warning and still raises. */
      IF v_sev <> 'info' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', v_sev,
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- DR5. The diamond journal is deleted from on an hourly cadence by the
    -- certification fleet. Keep the row and say who took it. Nothing here can
    -- refuse the DELETE the branch above has already permitted.
    IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           (v_j->>'user_id')::uuid, v_reason)
        ON CONFLICT (id) DO NOTHING;

        PERFORM public.fn_ca_diamond_incident(
          'DR5:journal_row_deleted_under_maintenance', 'info',
          (v_j->>'user_id')::uuid, (v_j->>'amount')::numeric,
          'fn_ca_journal_append_only',
          jsonb_build_object('reason', v_reason,
                             'reference_id', v_j->>'reference_id',
                             'type', v_j->>'type',
                             'db_role', current_user));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row deleted under maintenance (%): %',
          v_reason, SQLERRM;
      END;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_journal_append_only' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text DEFAULT 'admin'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_asset text := lower(btrim(COALESCE(p_asset, '')));
  v_dest  text := lower(btrim(COALESCE(p_destination, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_class text := lower(btrim(COALESCE(p_class, 'admin')));
  v_holder uuid;
  v_prior jsonb; v_before numeric; v_after numeric; v_label text;
  v_supply numeric; v_chip_id uuid; v_dia_id uuid; v_actorlb text; v_result jsonb;
  v_pol public.ca_mint_policy%ROWTYPE;
  v_cap numeric; v_roll numeric; v_24h numeric;
BEGIN
  -- The trigger door (2026-09-08, DIAMOND-RULINGS 17 / roadmap 1.3): handle_new_user and the
  -- other seeders fire inside a trigger owned by the database itself, where auth.role() is
  -- NULL. The database's own code may mint; a browser never reaches this branch because a
  -- SECURITY DEFINER trigger runs as the owner and a client session is never at depth > 0.
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT (pg_trigger_depth() > 0
              AND current_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin')) THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;
    IF NOT v_admin THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
    END IF;
  END IF;

  IF v_asset NOT IN ('chips', 'diamonds') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'asset_must_be_chips_or_diamonds');
  END IF;
  IF v_asset = 'chips' AND v_dest NOT IN ('club', 'union') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chips_are_issued_to_a_club_or_union_wallet_only');
  END IF;
  IF v_asset = 'diamonds' AND v_dest NOT IN ('player', 'house') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_issued_to_a_player_or_to_the_house_only');
  END IF;
  -- The foundation's issuance_class list (diamond_transactions_issuance_class_chk).
  -- Recorded on the diamond journal row; carried but unused for chips, which have
  -- their own ledger.
  IF v_class NOT IN ('purchased', 'promotional', 'earned', 'transferred', 'seeded',
                     'refund', 'spend', 'bridge', 'deletion', 'admin', 'arena',
                     'house', 'unknown') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_issuance_class', 'class', v_class);
  END IF;
  IF v_asset = 'diamonds' AND v_dest = 'house' THEN
    IF p_target_id IS NOT NULL AND p_target_id <> c_house THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_house_target_is_the_house_sentinel_or_null');
    END IF;
  ELSIF p_target_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive_to_two_decimals');
  END IF;
  IF v_asset = 'diamonds' AND p_amount <> round(p_amount, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_whole_numbers');
  END IF;
  -- Kill switch (standard 3.4 layer 6, review D11): a human-opened diamond_issuance freeze
  -- refuses diamond minting until it is cleared. Burns and chips are untouched.
  IF v_asset = 'diamonds' AND EXISTS (SELECT 1 FROM public.ca_payout_freeze f
                                        WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_issuance_frozen');
  END IF;
  -- THE POLICY (ca_mint_policy): a per-operation cap and a rolling 24-hour
  -- ceiling, both refused here with a reason the operator can read, and
  -- refused again at commit by the constraint trigger for chips whatever the
  -- door. 24h issuance is read from the register with the advisory lock held
  -- below, so two operators cannot both fit under the ceiling at once.
  SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
  v_cap  := CASE WHEN v_asset = 'chips' THEN v_pol.per_operation_cap_chips ELSE v_pol.per_operation_cap_diamonds END;
  v_roll := CASE WHEN v_asset = 'chips' THEN v_pol.rolling_24h_cap_chips ELSE v_pol.rolling_24h_cap_diamonds END;
  IF p_amount > v_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_over_the_single_mint_cap',
                              'cap', v_cap, 'requested', p_amount);
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'issuance_needs_a_real_reason');
  END IF;
  IF COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_key_required');
  END IF;

  SELECT result INTO v_prior FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  END IF;
  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_ca_mint', v_actor);

  PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:' || v_asset));

  v_24h := public.fn_ca_mint_issued_24h(v_asset) + p_amount;
  IF v_24h > v_roll THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'over_the_rolling_24h_issuance_ceiling',
                              'ceiling', v_roll, 'issued_24h', v_24h - p_amount, 'requested', p_amount);
  END IF;

  IF v_asset = 'diamonds' THEN
    IF v_dest = 'house' THEN
      INSERT INTO public.ca_diamond_house (id, balance)
      VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
      SELECT COALESCE(balance, 0) INTO v_before
        FROM public.ca_diamond_house WHERE id = 1 FOR UPDATE;
      UPDATE public.ca_diamond_house
         SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
       WHERE id = 1 RETURNING balance INTO v_after;
      v_label  := 'the house';
      v_holder := c_house;
      -- No diamond_transactions row: that journal is keyed by a user (two FKs to
      -- auth.users and profiles) and the house is not one. ca_mint_ledger is the
      -- record of a house-side issuance.
    ELSE
      SELECT COALESCE(diamonds, 0), COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
        INTO v_before, v_label FROM public.profiles WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
      END IF;
      UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) + p_amount
       WHERE id = p_target_id RETURNING diamonds INTO v_after;
      -- The op id is the journal reference (DR4: a credit carries its reference), so the earn
      -- ledger files a promotional mint under its engine by prefix (signup: -> signup).
      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class, reference_id)
      VALUES (p_target_id, 'earn', 'mint', p_amount, v_after,
              'The Mint: ' || v_reason, 'the_mint',
              jsonb_build_object('minted_by', v_actor, 'op_id', p_op_id),
              'issuance', v_class, p_op_id)
      RETURNING id INTO v_dia_id;
      v_holder := p_target_id;
    END IF;
  ELSE
    -- The leg is declared WITH A KEY and found by that key: never by shape.
    PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve', NULL, NULL, 'mint:' || p_op_id, NULL);
    IF v_dest = 'club' THEN
      SELECT COALESCE(chip_treasury, 0), name INTO v_before, v_label
        FROM public.clubs WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
      END IF;
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount
       WHERE id = p_target_id RETURNING chip_treasury INTO v_after;
      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
      VALUES (p_target_id, v_actor, NULL, p_amount, 'treasury_mint',
              'The Mint: ' || v_reason, v_after);
    ELSE
      SELECT name INTO v_label FROM public.unions WHERE id = p_target_id;
      IF v_label IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'union_not_found');
      END IF;
      INSERT INTO public.union_wallets (union_id, created_at, updated_at)
      VALUES (p_target_id, now(), now()) ON CONFLICT (union_id) DO NOTHING;
      SELECT COALESCE(chip_balance, 0) INTO v_before
        FROM public.union_wallets WHERE union_id = p_target_id FOR UPDATE;
      UPDATE public.union_wallets
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
       WHERE union_id = p_target_id RETURNING chip_balance INTO v_after;
    END IF;
    SELECT id INTO v_chip_id FROM public.chip_ledger WHERE idempotency_key = 'mint:' || p_op_id;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    IF v_chip_id IS NULL THEN
      RAISE EXCEPTION 'fn_ca_mint: the balance moved but no journal leg was written for key mint:% - refusing to register an issuance the journal does not carry', p_op_id;
    END IF;
    v_holder := p_target_id;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = v_asset;
  SELECT COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
    INTO v_actorlb FROM public.profiles WHERE id = v_actor;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id)
  VALUES
    (p_op_id, 'mint', v_asset, v_dest, v_holder, v_label, p_amount,
     v_before, v_after, v_supply, v_reason, v_actor, v_actorlb, v_chip_id, v_dia_id);

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false, 'action', 'mint',
    'asset', v_asset, 'destination', v_dest, 'issuance_class', v_class,
    'target_id', v_holder, 'target_label', v_label, 'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'supply_after', v_supply,
    'ledger_id', v_chip_id, 'issued_24h_after', v_24h, 'rolling_24h_cap', v_roll,
    'minted_by', v_actor, 'reason', v_reason, 'op_id', p_op_id);

  UPDATE public.ca_op_claims SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';

  RETURN v_result;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_mint' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_mint_issued_24h(p_asset text, p_except_leg uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(m.amount), 0)
    FROM public.ca_mint_ledger m
   WHERE m.asset = p_asset AND m.action = 'mint'
     AND m.origin <> 'baseline'
     AND m.created_at > now() - interval '24 hours'
     AND (p_except_leg IS NULL OR m.chip_ledger_id IS DISTINCT FROM p_except_leg);
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_mint_issued_24h' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_mint_register_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
BEGIN
  -- The one permitted update: linking a row to its journal leg.
  IF TG_OP = 'UPDATE'
     AND OLD.chip_ledger_id IS NULL AND NEW.chip_ledger_id IS NOT NULL
     AND NEW.op_id IS NOT DISTINCT FROM OLD.op_id
     AND NEW.action IS NOT DISTINCT FROM OLD.action
     AND NEW.asset IS NOT DISTINCT FROM OLD.asset
     AND NEW.holder_type IS NOT DISTINCT FROM OLD.holder_type
     AND NEW.holder_id IS NOT DISTINCT FROM OLD.holder_id
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.balance_before IS NOT DISTINCT FROM OLD.balance_before
     AND NEW.balance_after IS NOT DISTINCT FROM OLD.balance_after
     AND NEW.supply_after IS NOT DISTINCT FROM OLD.supply_after
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.performed_by IS NOT DISTINCT FROM OLD.performed_by
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.diamond_tx_id IS NOT DISTINCT FROM OLD.diamond_tx_id THEN
    RETURN NEW;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) END);
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_mint_register_append_only', 'unauthorized_adjustment', 'warning',
        'register-bypass:' || TG_OP || ':' || split_part(v_reason, ':', 1),
        0, NULL, NULL, 'ledger', 'ca_mint_ledger',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on the mint register: ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log. Confirm the maintenance was intended, then resolve.',
        true,
        jsonb_build_object('operation', TG_OP, 'reason', v_reason, 'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on ca_mint_ledger is forbidden: the mint register is append-only. A retirement offsets an issuance; neither is ever edited or removed. Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP USING ERRCODE = 'P0403';
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_mint_register_append_only' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_mint_supply(p_asset text)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    FROM public.ca_mint_ledger WHERE asset = p_asset;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_mint_supply' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_noncirculating_chip_stores()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY['system_mint', 'system_burn', 'issuance_reserve', 'chip_retirement']::text[];
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_register_diamond_journal_row(p_tx_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t record; v_origin text; v_action text; v_label text; v_actorlb text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_actor uuid := auth.uid();
BEGIN
  SELECT * INTO t FROM public.diamond_transactions WHERE id = p_tx_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = t.id) THEN
    RETURN false;
  END IF;
  v_origin := public.fn_ca_diamond_journal_origin(t.type, t.transaction_type, t.source, t.issuance_class, t.amount);
  IF v_origin IS NULL THEN RETURN false; END IF;

  v_action := CASE WHEN t.amount > 0 THEN 'mint' ELSE 'burn' END;
  v_after  := COALESCE(t.balance_after, 0);
  v_before := v_after - t.amount;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_label FROM public.profiles p WHERE p.id = t.user_id;
  v_label := COALESCE(v_label, t.user_id::text);
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_actorlb FROM public.profiles p WHERE p.id = v_actor;
  v_op := 'diamond-journal:' || v_origin || ':' || t.id::text;
  v_reason := CASE v_action
                WHEN 'mint' THEN 'The Mint issued ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
                ELSE 'The Mint retired ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
              END
              || COALESCE(NULLIF(btrim(t.description), ''), COALESCE(t.transaction_type, t.type, 'diamond movement'));

  -- NO GLOBAL LOCK ON THIS PATH. It used to hold pg_advisory_xact_lock('ca_mint_ledger:diamonds')
  -- to make supply_after an exact running total. An xact-scoped lock is held until the CALLER
  -- commits, so every diamond movement serialised the whole economy behind whatever transaction
  -- happened to be moving diamonds - and on 2026-09-08, once one transaction could claim several
  -- challenges at once, twenty-four movements died on lock_timeout and went unrecorded.
  --
  -- supply_after is therefore the supply OBSERVED as this row was written, not a serialised
  -- running total: two simultaneous movements may each omit the other. Nothing reads it. The
  -- authority on supply is fn_ca_mint_supply(), which sums the movements, and the identity that
  -- matters - that sum equals what players hold - does not depend on this column at all.
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'diamonds';
  v_supply := v_supply + CASE WHEN v_action = 'mint' THEN abs(t.amount) ELSE -abs(t.amount) END;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id, created_at)
  VALUES
    (v_op, v_action, 'diamonds', 'player', t.user_id, v_label, abs(t.amount),
     v_before, v_after, v_supply, v_reason,
     v_actor, v_actorlb, NULL, t.id, COALESCE(t.created_at, now()))
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_register_diamond_journal_row' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_ca_register_issuance_leg(p_ledger_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l record; v_action text; v_holder_type text; v_holder uuid; v_label text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT * INTO l FROM public.chip_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.chip_ledger_id = l.id) THEN
    RETURN false;
  END IF;
  IF l.category = 'correction' AND l.metadata->>'posted_via' = 'fn_ca_post_correction' THEN
    RETURN false;  -- a correction moves no balance (a_correction_is_not_a_mint)
  END IF;
  IF l.from_type = ANY (v_outside) AND NOT (l.to_type = ANY (v_outside)) THEN
    v_action := 'mint'; v_holder := l.to_entity_id;
    v_holder_type := CASE l.to_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSIF l.to_type = ANY (v_outside) AND NOT (l.from_type = ANY (v_outside)) THEN
    v_action := 'burn'; v_holder := l.from_entity_id;
    v_holder_type := CASE l.from_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSE
    RETURN false;  -- store to store, or circulating to circulating
  END IF;
  -- The autoledger stamps a union wallet's row with the union id; a union is
  -- also a row in clubs (is_union), so resolve by what the id actually is.
  IF v_holder_type = 'club' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_holder AND COALESCE(c.is_union, false)) THEN
    v_holder_type := 'union';
  END IF;
  IF v_holder IS NULL THEN
    v_holder_type := 'circulation';
  END IF;
  IF v_holder_type = 'circulation' THEN
    v_holder := '00000000-0000-0000-0000-00000000c1c0';  -- the circulation sentinel (the house is ...d1a0)
  END IF;
  v_label := CASE v_holder_type
    WHEN 'club'   THEN (SELECT c.name FROM public.clubs c WHERE c.id = v_holder)
    WHEN 'union'  THEN COALESCE((SELECT u.name FROM public.unions u WHERE u.id = v_holder), (SELECT c.name FROM public.clubs c WHERE c.id = v_holder))
    WHEN 'player' THEN (SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) FROM public.profiles p WHERE p.id = v_holder)
    ELSE 'circulation' END;
  -- A leg written by hand (a linked compensating entry) carries no balances;
  -- the register still wants a pair, so the pair is the amount itself.
  /* A door that wrote its own register row but did not link the leg
     (fn_ca_burn looks the leg up by a shape it does not always match):
     adopt that row rather than write a second one. Same action, holder,
     amount, asset, within five seconds of the leg, not yet linked. */
  UPDATE public.ca_mint_ledger m
     SET chip_ledger_id = l.id
   WHERE m.id = (SELECT m2.id FROM public.ca_mint_ledger m2
                  WHERE m2.chip_ledger_id IS NULL AND m2.asset = 'chips' AND m2.action = v_action
                    AND m2.amount = l.amount AND m2.holder_id = v_holder
                    AND m2.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds'
                  ORDER BY m2.created_at LIMIT 1);
  IF FOUND THEN RETURN false; END IF;
  v_before := COALESCE(CASE WHEN v_action = 'mint' THEN l.pre_to_balance ELSE l.pre_from_balance END, 0);
  v_after  := COALESCE(CASE WHEN v_action = 'mint' THEN l.post_to_balance ELSE l.post_from_balance END,
                       v_before + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
       + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  v_op := 'ledger:' || l.id::text;
  v_reason := left(COALESCE(NULLIF(btrim(l.description), ''), l.category) || ' (' || l.category
              || CASE WHEN l.idempotency_key IS NOT NULL THEN ', key ' || l.idempotency_key ELSE '' END
              || '; registered from the journal leg)', 500);
  IF length(btrim(v_reason)) < 10 THEN v_reason := v_reason || ' - registered from the journal'; END IF;
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason, performed_by, performed_by_label, db_role, chip_ledger_id, created_at)
  VALUES (v_op, v_action, 'chips', v_holder_type, v_holder, v_label, l.amount,
          v_before, v_after, v_supply, v_reason, l.performed_by, COALESCE(l.actor_service, l.db_role), l.db_role, l.id, l.created_at)
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_touch_updated_at' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_caller_is_engine' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    v_old_tournament_id:=NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP<>'DELETE' THEN
    v_new_tournament_id:=NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
      USING ERRCODE='55000';
  END IF;
  v_tournament_id:=COALESCE(v_new_tournament_id,v_old_tournament_id);
  IF v_tournament_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='chip_ledger' AND TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=v_tournament_id) THEN
    RAISE EXCEPTION 'cancelled tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_cancelled_tournament_evidence_is_immutable' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_check_anti_farming_gift_cap(p_sender_id uuid, p_recipient_id uuid, p_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 DECLARE
   v_pair_24h              bigint;
   v_total_24h             bigint;
   v_burst_60s             bigint;
   v_fresh_paid_24h        bigint;
   v_active_ban            boolean;
   v_is_flagged            boolean;
   v_created_at            timestamptz;
   v_first_purchase_at     timestamptz;
   v_account_age_days      numeric;
   v_days_since_purchase   numeric;
   v_lift_via_age          timestamptz;
   v_lift_via_purchase     timestamptz;
   v_lift_at               timestamptz;
   v_lift_date_str         text;
   v_lift_msg              text;
   CAP_PER_PAIR_24H        constant integer := 5000;
   CAP_PER_USER_24H        constant integer := 50000;
   CAP_BURST_60S           constant integer := 2000;
   CAP_FRESH_PAID_24H      constant integer := 500;
   TRUST_AGE_DAYS          constant integer := 120;
   NEW_USER_DAYS           constant integer := 30;
   PURCHASE_COOLDOWN_DAYS  constant integer := 7;
 BEGIN
   -- ── Argument validation ─────────────────────────────────────────────────
   IF p_sender_id IS NULL OR p_recipient_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', 'Invalid Arguments',
       'code', 'invalid_args',
       'title', 'Invalid Request',
       'popup_message', 'The Request Is Missing Required Information',
       'popup_explanation', 'Please Refresh The Page And Try Again'
     );
   END IF;
   IF p_sender_id = p_recipient_id THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', 'Cannot Send To Self',
       'code', 'self_transfer',
       'title', 'Cannot Send To Yourself',
       'popup_message', 'You Cannot Send Diamonds To Your Own Account',
       'popup_explanation', 'Please Choose A Different Recipient'
     );
   END IF;

   -- DIAMOND-RULINGS 12: the hard-coded exempt account is gone. An account that is to be
   -- exempt from this ladder is a row in a table Dan owns, with a reason, never a literal
   -- in a function body that nothing outside it can see.

   -- ── Banned-by-recipient ─────────────────────────────────────────────────
   SELECT EXISTS (
     SELECT 1 FROM live_bans lb
       JOIN live_streams ls ON ls.id = lb.stream_id
      WHERE lb.banned_user_id = p_sender_id
        AND ls.broadcaster_id = p_recipient_id
   ) INTO v_active_ban;
   IF v_active_ban THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', 'You Are Banned From This Broadcaster',
       'code', 'banned_by_recipient',
       'title', 'You Are Banned',
       'popup_message', 'This Broadcaster Has Banned You From Sending Gifts',
       'popup_explanation', 'You Will Need To Contact The Broadcaster Directly To Request An Unban'
     );
   END IF;

   -- ── Load sender state ───────────────────────────────────────────────────
   SELECT COALESCE(is_farming_flagged, false), created_at
     INTO v_is_flagged, v_created_at
     FROM profiles WHERE id = p_sender_id;

   -- ── Compute lift timestamps (used by any blocked path below) ────────────
   IF v_is_flagged IS NOT TRUE THEN
     SELECT MIN(completed_at) INTO v_first_purchase_at
       FROM diamond_purchases
       WHERE user_id = p_sender_id
         AND status = 'completed'
         AND refunded_at IS NULL;

     v_account_age_days := CASE
       WHEN v_created_at IS NULL THEN 0
       ELSE EXTRACT(epoch FROM (now() - v_created_at)) / 86400
     END;
     v_days_since_purchase := CASE
       WHEN v_first_purchase_at IS NULL THEN NULL
       ELSE EXTRACT(epoch FROM (now() - v_first_purchase_at)) / 86400
     END;

     v_lift_via_age := CASE
       WHEN v_created_at IS NULL THEN NULL
       ELSE v_created_at + make_interval(days => TRUST_AGE_DAYS)
     END;
     v_lift_via_purchase := CASE
       WHEN v_first_purchase_at IS NULL THEN NULL
       ELSE v_first_purchase_at + make_interval(days => PURCHASE_COOLDOWN_DAYS)
     END;
     v_lift_at := CASE
       WHEN v_lift_via_age IS NOT NULL AND v_lift_via_purchase IS NOT NULL THEN LEAST(v_lift_via_age, v_lift_via_purchase)
       WHEN v_lift_via_purchase IS NOT NULL THEN v_lift_via_purchase
       WHEN v_lift_via_age IS NOT NULL THEN v_lift_via_age
       ELSE NULL
     END;
   ELSE
     v_lift_at := NULL;  -- flagged: requires admin action
   END IF;

   -- DIAMOND-RULINGS 4, with CLAUDE.md 10.86: there is no lift any more, so this stops
   -- answering with a date. A field that names a day nothing will happen on is worse than an
   -- empty one - it is the shape of a signal that answers when it does not know.
   v_lift_at := NULL;

   -- Title-Cased lift date string ("Your Limits Are Fully Lifted On May 19, 2026")
   v_lift_msg := CASE
     WHEN v_is_flagged THEN 'Your Account Has Restrictions That Require Admin Review To Lift'
     WHEN false THEN ''
     ELSE
       'Your Sending Limits Are Per Recipient, Per Day And Per Minute, And They Apply To Every Account'
   END;

   -- ── Trust ladder (only for unflagged senders) ───────────────────────────
   IF v_is_flagged IS NOT TRUE THEN
     -- DIAMOND-RULINGS 4: the two waivers are removed. Tier 4 lifted every cap seven days
     -- after the cheapest purchase a farmer can make, and tier 5 lifted them for any account
     -- that had simply existed for 120 days. Age is not trust and a receipt is not trust; the
     -- pair, user and burst caps below are what this ladder is for, and they cost a real
     -- player nothing.

     -- Tier 6: <30d + paid + <7d since purchase → 500/24h cap (with popup)
     IF v_account_age_days < NEW_USER_DAYS
        AND v_first_purchase_at IS NOT NULL THEN
       SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_fresh_paid_24h
         FROM diamond_transactions
        WHERE user_id = p_sender_id
          AND amount  < 0
          AND created_at > now() - interval '24 hours'
          AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
            OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));

       IF v_fresh_paid_24h + p_amount > CAP_FRESH_PAID_24H THEN
         RETURN jsonb_build_object(
           'allowed', false,
           'reason',  format('Fresh-Paid Users Are Capped At %s Diamonds / 24h For The First 7 Days After Purchase', CAP_FRESH_PAID_24H),
           'code',    'fresh_paid_24h_cap',
           'title',   'Daily Limit Reached',
           'popup_message', format('You Have Reached Your Daily %s Diamond Sending Limit', CAP_FRESH_PAID_24H),
           'popup_explanation', format('New Paid Accounts Are Limited To %s Diamonds Per Day During The First 7 Days After Your First Purchase To Protect Against Fraud', CAP_FRESH_PAID_24H),
           'next_send_message', 'You Can Send More Diamonds Tomorrow',
           'limits_lift_at', v_lift_at,
           'limits_lift_message', v_lift_msg,
           'amount_sent_24h', v_fresh_paid_24h,
           'amount_cap_24h', CAP_FRESH_PAID_24H
         );
       END IF;

       RETURN jsonb_build_object(
         'allowed', true,
         'reason',  'fresh_paid_within_500_per_day',
         'code',    'ok'
       );
     END IF;
   END IF;

   -- ── Tier 7: standard pair/user/burst caps (with popups) ─────────────────

   SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_pair_24h
     FROM diamond_transactions
    WHERE user_id = p_sender_id
      AND amount  < 0
      AND created_at > now() - interval '24 hours'
      AND metadata->>'recipient_id' = p_recipient_id::text
      AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
        OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
   IF v_pair_24h + p_amount > CAP_PER_PAIR_24H THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', format('Pair Limit Hit (%s Diamonds / 24h To This User)', CAP_PER_PAIR_24H),
       'code', 'pair_24h_cap',
       'title', 'Pair Limit Reached',
       'popup_message', format('You Have Sent %s Diamonds To This User In The Last 24 Hours', CAP_PER_PAIR_24H),
       'popup_explanation', format('You Can Send Up To %s Diamonds Per User Per Day While Your Account Is Not Yet Fully Trusted', CAP_PER_PAIR_24H),
       'next_send_message', 'You Can Send More Diamonds To This User Tomorrow',
       'limits_lift_at', v_lift_at,
       'limits_lift_message', v_lift_msg,
       'amount_sent_24h', v_pair_24h,
       'amount_cap_24h', CAP_PER_PAIR_24H
     );
   END IF;

   SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_total_24h
     FROM diamond_transactions
    WHERE user_id = p_sender_id
      AND amount  < 0
      AND created_at > now() - interval '24 hours'
      AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
        OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
   IF v_total_24h + p_amount > CAP_PER_USER_24H THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', format('Daily Limit Hit (%s Diamonds / 24h)', CAP_PER_USER_24H),
       'code', 'user_24h_cap',
       'title', 'Daily Limit Reached',
       'popup_message', format('You Have Sent %s Diamonds Total In The Last 24 Hours', CAP_PER_USER_24H),
       'popup_explanation', format('Your Account Can Send Up To %s Diamonds Per Day Until It Is Fully Trusted', CAP_PER_USER_24H),
       'next_send_message', 'You Can Send More Diamonds Tomorrow',
       'limits_lift_at', v_lift_at,
       'limits_lift_message', v_lift_msg,
       'amount_sent_24h', v_total_24h,
       'amount_cap_24h', CAP_PER_USER_24H
     );
   END IF;

   SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_burst_60s
     FROM diamond_transactions
    WHERE user_id = p_sender_id
      AND amount  < 0
      AND created_at > now() - interval '60 seconds'
      AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
        OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
   IF v_burst_60s + p_amount > CAP_BURST_60S THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', format('Slow Down - %s Diamonds In 60s Is Too Fast', CAP_BURST_60S),
       'code', 'burst_cap',
       'title', 'Sending Too Fast',
       'popup_message', format('You Have Sent %s Diamonds In The Last 60 Seconds', CAP_BURST_60S),
       'popup_explanation', format('Please Wait A Few Seconds Between Gifts To Avoid Hitting The %s Diamond Burst Limit', CAP_BURST_60S),
       'next_send_message', 'You Can Send More In About A Minute',
       'limits_lift_at', v_lift_at,
       'limits_lift_message', v_lift_msg,
       'amount_sent_60s', v_burst_60s,
       'amount_cap_60s', CAP_BURST_60S
     );
   END IF;

   RETURN jsonb_build_object('allowed', true, 'reason', 'within_caps', 'code', 'ok');
 END;
 $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_check_anti_farming_gift_cap' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  /* THE AUTOSKIP CONTRACT IS ONE CONTRACT (2026-09-09). Every other journal
     writer on this platform stands down when the caller sets
     app.ledger_autoskip_<table>, because the caller is writing the leg itself
     with the period, the key and the metadata that only it knows. This writer
     never learned that clause. So a settlement that suppressed the clubs
     trigger and wrote its own named leg still got an anonymous twin from this
     side, and the movement reached the journal twice: on 2026-09-09 round 2
     moved 20,377.49 of commission and recorded 40,754.98 of legs. Standing
     down here is what makes one movement, one leg true for the busiest
     balance column on the platform. */
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN
    RETURN NEW;
  END IF;

  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text);

  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_club_members_ledger_writer' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_club_settlement_frozen(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT c.settlement_locked
       AND (c.settlement_lock_until IS NULL OR c.settlement_lock_until > now())
       FROM clubs c WHERE c.id = p_club_id),
    false);
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_club_settlement_frozen' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_balance_mirrors_canonical()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.diamond_balance := NEW.diamonds;
  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_balance_mirrors_canonical' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_cover_lock(p_host uuid, p_kind text, OUT o_promo numeric, OUT o_bank numeric, OUT o_cover numeric)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_kind = 'union' THEN
    INSERT INTO public.union_wallets (union_id, created_at, updated_at) VALUES (p_host, now(), now())
    ON CONFLICT (union_id) DO NOTHING;
    SELECT COALESCE(w.promo_wallet, 0), COALESCE(w.chip_balance, 0)
      INTO o_promo, o_bank
      FROM public.union_wallets w WHERE w.union_id = p_host FOR UPDATE;
  ELSE
    SELECT COALESCE(c.promo_balance, 0), COALESCE(c.chip_treasury, 0)
      INTO o_promo, o_bank
      FROM public.clubs c WHERE c.id = p_host FOR UPDATE;
  END IF;
  -- A wallet that has somehow gone negative covers nothing; it does not get to
  -- eat the other wallet's headroom on the way past.
  o_promo := GREATEST(COALESCE(o_promo, 0), 0);
  o_bank  := GREATEST(COALESCE(o_bank, 0), 0);
  o_cover := o_promo + o_bank;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_cover_lock' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_fund_promo(p_club_id uuid, p_amount numeric, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_lock record;
  v_promo_after numeric; v_bank_after numeric;
  v_key text;
  v_previous public.chip_ledger%ROWTYPE;
  v_source uuid;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;

  -- The caller's token is the whole of the replay guard, so it is checked
  -- before anything is locked. A key this function cannot trust is not an
  -- excuse to fall back on a generated one - that is the bug being fixed.
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Request Could Not Be Identified. Try Again');
  END IF;
  v_key := 'diamond-games-fund:' || p_key;

  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Move This Money');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Enter How Many Chips To Move');
  END IF;
  -- Both wallet-history tables hold whole cents. Refusing in words beats
  -- throwing a constraint violation at an operator who typed one digit too many.
  IF p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Chips Move In Whole Cents');
  END IF;
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Try Again In A Few Minutes');
  END IF;

  -- This takes the host's wallet row FOR UPDATE, which is what makes the
  -- check-then-act below safe: a second press for the same host waits here.
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_lock FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;

  -- ── the replay guard ────────────────────────────────────────────────────
  -- Union bank legs identify the wallet ROW; club legs identify the club.
  IF v_kind = 'union' THEN
    SELECT id INTO v_source FROM public.union_wallets WHERE union_id = v_host;
  ELSE
    v_source := v_host;
  END IF;
  SELECT l.* INTO v_previous FROM public.chip_ledger l WHERE l.idempotency_key = v_key;
  IF FOUND THEN
    -- A token identifies one actor, host and amount, not any later request
    -- carrying the same text. Preserve the historical namespace so old keys
    -- still replay instead of funding a second time after this upgrade.
    IF v_previous.performed_by IS DISTINCT FROM v_user
       OR v_previous.from_entity_id IS DISTINCT FROM v_source
       OR v_previous.to_entity_id IS DISTINCT FROM v_host
       OR v_previous.from_type IS DISTINCT FROM (CASE WHEN v_kind = 'union' THEN 'union_bank' ELSE 'club_treasury' END)
       OR v_previous.to_type IS DISTINCT FROM 'promo_wallet'
       OR v_previous.category IS DISTINCT FROM 'treasury_transfer'
       OR v_previous.amount IS DISTINCT FROM p_amount THEN
      RETURN jsonb_build_object('ok', false, 'error',
        'That Request Key Was Already Used For Different Funding');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true,
                              'promo_chips', v_lock.o_promo,
                              'bank_chips', v_lock.o_bank,
                              'cover_chips', GREATEST(v_lock.o_promo, 0) + GREATEST(v_lock.o_bank, 0));
  END IF;

  IF v_lock.o_bank < p_amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bank Does Not Hold That Many Chips',
                              'bank_chips', v_lock.o_bank);
  END IF;

  -- treasury_transfer is the vocabulary's word for chips moving between a host's
  -- own wallets; the journal refuses a category it does not know, and inventing
  -- one here would mean widening chip_ledger_category_check for a button.
  PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'promo_wallet', v_host, NULL, v_key, ARRAY[]::text[]);
  IF v_kind = 'union' THEN
    UPDATE public.union_wallets
       SET chip_balance = chip_balance - p_amount,
           promo_wallet = COALESCE(promo_wallet, 0) + p_amount,
           updated_at = now()
     WHERE union_id = v_host AND chip_balance >= p_amount
     RETURNING promo_wallet, chip_balance INTO v_promo_after, v_bank_after;
  ELSE
    UPDATE public.clubs
       SET chip_treasury = chip_treasury - p_amount,
           promo_balance = COALESCE(promo_balance, 0) + p_amount,
           updated_at = now()
     WHERE id = v_host AND chip_treasury >= p_amount
     RETURNING promo_balance, chip_treasury INTO v_promo_after, v_bank_after;
  END IF;
  IF v_promo_after IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bank Does Not Hold That Many Chips');
  END IF;

  -- The replay guard above reads the journal, so a move that wrote no leg
  -- would be a move that can be made twice. Refuse rather than allow that.
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key = v_key) THEN
    RAISE EXCEPTION 'fn_diamond_game_fund_promo: the move wrote no journal leg under %, so a replay could not be told apart from a first press', v_key;
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  -- ── the operator's own wallet history, whichever shape the host is ──────
  IF v_kind = 'union' THEN
    INSERT INTO public.union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    VALUES (v_host, NULL, 'promo_wallet', 'credit', p_amount, v_promo_after, 'treasury_transfer',
            'Moved Into The Promo Wallet For The Diamond Games', v_user);
  ELSE
    INSERT INTO public.club_wallet_transactions
      (club_id, type, amount, balance_after, actor_id, reason)
    VALUES (v_host, 'other', -p_amount, v_bank_after,  v_user,
            'Moved Into The Promo Wallet For The Diamond Games');
  END IF;

  RETURN jsonb_build_object('ok', true, 'replayed', false,
                            'promo_chips', v_promo_after, 'bank_chips', v_bank_after,
                            'cover_chips', GREATEST(v_promo_after, 0) + GREATEST(v_bank_after, 0));
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_fund_promo' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_owner(p_host uuid, p_kind text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_kind = 'union' THEN (SELECT u.owner_id FROM public.unions u WHERE u.id = p_host)
              ELSE (SELECT c.owner_id FROM public.clubs c WHERE c.id = p_host) END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_owner' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_pay_chips(p_category text, p_host uuid, p_kind text, p_club uuid, p_user uuid, p_amount numeric, p_key text, p_note text, p_meta jsonb, OUT promo_after numeric, OUT bank_after numeric, OUT cover_after numeric, OUT member_after numeric, OUT from_promo numeric, OUT from_bank numeric)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock record;
BEGIN
  from_promo := 0;
  from_bank  := 0;
  IF COALESCE(p_amount, 0) <= 0 THEN
    SELECT c.o_promo, c.o_bank, c.o_cover INTO promo_after, bank_after, cover_after
      FROM public.fn_diamond_game_cover_lock(p_host, p_kind) c;
    SELECT COALESCE(m.chip_balance, 0) INTO member_after FROM public.club_members m
     WHERE m.club_id = p_club AND m.user_id = p_user LIMIT 1;
    RETURN;
  END IF;

  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_lock FROM public.fn_diamond_game_cover_lock(p_host, p_kind) c;
  from_promo := LEAST(p_amount, v_lock.o_promo);
  from_bank  := p_amount - from_promo;
  IF from_bank > v_lock.o_bank THEN
    RAISE EXCEPTION 'diamond games: cover % is below the % payout of % after the gate passed',
      v_lock.o_cover, p_category, p_amount;
  END IF;

  promo_after := v_lock.o_promo;
  bank_after  := v_lock.o_bank;

  IF from_promo > 0 THEN
    PERFORM public.fn_ca_declare_ledger(p_category, 'player_wallet', p_user, NULL, p_key, ARRAY['club_members']);
    IF p_kind = 'union' THEN
      UPDATE public.union_wallets SET promo_wallet = COALESCE(promo_wallet, 0) - from_promo, updated_at = now()
       WHERE union_id = p_host AND COALESCE(promo_wallet, 0) >= from_promo
       RETURNING promo_wallet INTO promo_after;
    ELSE
      UPDATE public.clubs SET promo_balance = COALESCE(promo_balance, 0) - from_promo, updated_at = now()
       WHERE id = p_host AND COALESCE(promo_balance, 0) >= from_promo
       RETURNING promo_balance INTO promo_after;
    END IF;
    IF promo_after IS NULL THEN
      RAISE EXCEPTION 'diamond games: the promo wallet refused the % payout of %', p_category, from_promo;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = p_key) THEN
      RAISE EXCEPTION 'diamond games: the promo wallet moved but no leg was journaled for %', p_key;
    END IF;
    UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + from_promo, updated_at = now()
     WHERE club_id = p_club AND user_id = p_user
       AND COALESCE(status, 'active') IN ('active', 'approved')
     RETURNING chip_balance INTO member_after;
    IF member_after IS NULL THEN
      RAISE EXCEPTION 'diamond games: the % payout landed nowhere for % in club %', p_category, p_user, p_club;
    END IF;
  END IF;

  IF from_bank > 0 THEN
    -- THE BANK BACKS IT (Dan 2026-09-10). Its own key, so the split reads as two
    -- rows that add up to the prize rather than one row that hides where half of
    -- it came from.
    PERFORM public.fn_ca_declare_ledger(p_category, 'player_wallet', p_user, NULL, p_key || ':bank', ARRAY['club_members']);
    IF p_kind = 'union' THEN
      UPDATE public.union_wallets SET chip_balance = COALESCE(chip_balance, 0) - from_bank, updated_at = now()
       WHERE union_id = p_host AND COALESCE(chip_balance, 0) >= from_bank
       RETURNING chip_balance INTO bank_after;
    ELSE
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) - from_bank, updated_at = now()
       WHERE id = p_host AND COALESCE(chip_treasury, 0) >= from_bank
       RETURNING chip_treasury INTO bank_after;
    END IF;
    IF bank_after IS NULL THEN
      RAISE EXCEPTION 'diamond games: the host bank refused the % payout of %', p_category, from_bank;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = p_key || ':bank') THEN
      RAISE EXCEPTION 'diamond games: the host bank moved but no leg was journaled for %', p_key || ':bank';
    END IF;
    UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + from_bank, updated_at = now()
     WHERE club_id = p_club AND user_id = p_user
       AND COALESCE(status, 'active') IN ('active', 'approved')
     RETURNING chip_balance INTO member_after;
    IF member_after IS NULL THEN
      RAISE EXCEPTION 'diamond games: the % payout landed nowhere for % in club %', p_category, p_user, p_club;
    END IF;
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  -- The autoskip is transaction-scoped and fn_ca_declare_ledger only sets it.
  -- Cleared here so a later balance write in the same transaction is journaled:
  -- left set, the next write on this table would silently write no journal row.
  PERFORM set_config('app.ledger_autoskip_club_members', '', true);
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_clubs', '', true);

  cover_after := GREATEST(promo_after, 0) + GREATEST(bank_after, 0);

  IF p_kind = 'union' THEN
    IF from_promo > 0 THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
      VALUES (p_host, p_club, 'promo_wallet', 'debit', from_promo, promo_after, p_category, p_note, p_user);
    END IF;
    IF from_bank > 0 THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
      VALUES (p_host, p_club, 'chip_balance', 'debit', from_bank, bank_after, p_category,
              p_note || ' (promo wallet was short, the bank covered it)', p_user);
    END IF;
  END IF;

  INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  VALUES (p_club, NULL, p_user, p_amount, p_category, p_note,
          COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('from_promo', from_promo, 'from_bank', from_bank),
          member_after);
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_pay_chips' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_pay_diamonds(p_owner uuid, p_user uuid, p_amount integer, p_note text, p_reference text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_res jsonb;
BEGIN
  IF p_amount <= 0 THEN RETURN; END IF;
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'diamond games: no owner to pay the diamond prize %', p_reference;
  END IF;
  v_res := public.add_diamonds_to_balance(p_owner, -p_amount, 'transfer', p_note, p_reference || ':host', p_user);
  IF COALESCE((v_res->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'diamond games: the host owner could not pay the diamond prize %: %', p_reference, v_res->>'error';
  END IF;
  v_res := public.add_diamonds_to_balance(p_user, p_amount, 'transfer', p_note, p_reference, p_owner);
  IF COALESCE((v_res->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'diamond games: the diamond prize could not be credited %: %', p_reference, v_res->>'error';
  END IF;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_pay_diamonds' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_reserved_cover_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE host uuid; cover numeric; old_cover numeric; held numeric;
BEGIN
 IF TG_TABLE_NAME='clubs' THEN
  host:=NEW.id; cover:=GREATEST(COALESCE(NEW.promo_balance,0),0)+GREATEST(COALESCE(NEW.chip_treasury,0),0);
  old_cover:=GREATEST(COALESCE(OLD.promo_balance,0),0)+GREATEST(COALESCE(OLD.chip_treasury,0),0);
 ELSE
  host:=NEW.union_id; cover:=GREATEST(COALESCE(NEW.promo_wallet,0),0)+GREATEST(COALESCE(NEW.chip_balance,0),0);
  old_cover:=GREATEST(COALESCE(OLD.promo_wallet,0),0)+GREATEST(COALESCE(OLD.chip_balance,0),0);
 END IF;
 IF cover>=old_cover THEN RETURN NEW; END IF;
 SELECT COALESCE(sum(reserved_chips),0) INTO held FROM public.diamond_game_pools WHERE host_id=host;
 IF cover<held THEN RAISE EXCEPTION 'These Chips Are Reserved For Open Game Rounds'; END IF;
 RETURN NEW;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_reserved_cover_guard' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_games_spent_today(p_host uuid, p_user uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    SELECT sum(s.spin_price_diamonds)::numeric
      FROM public.wheel_spins s
     WHERE s.host_id = p_host AND s.user_id = p_user
       AND NOT COALESCE(s.is_welcome, false)
       AND (s.created_at AT TIME ZONE 'America/Chicago')::date
           = (now() AT TIME ZONE 'America/Chicago')::date), 0)
  + COALESCE((SELECT sum(r.bet_diamonds)::numeric FROM public.diamond_game_round_book r
    WHERE r.host_id=p_host AND r.user_id=p_user
    AND (r.created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date),0);
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_games_spent_today' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_diamond_side_tables_follow_profiles()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delta bigint := CASE WHEN TG_OP = 'INSERT'
                         THEN COALESCE(NEW.diamonds, 0)
                         ELSE COALESCE(NEW.diamonds, 0) - COALESCE(OLD.diamonds, 0) END;
BEGIN
  IF TG_OP <> 'INSERT' AND v_delta = 0 THEN RETURN NEW; END IF;
  BEGIN
    INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0), GREATEST(v_delta, 0), GREATEST(-v_delta, 0), now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0),
          lifetime_earned = public.user_diamonds.lifetime_earned + GREATEST(v_delta, 0),
          lifetime_spent  = public.user_diamonds.lifetime_spent  + GREATEST(-v_delta, 0),
          updated_at = now();
    INSERT INTO public.user_diamond_balance (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
          lifetime_earned = public.user_diamond_balance.lifetime_earned + GREATEST(v_delta, 0)::int,
          lifetime_spent  = public.user_diamond_balance.lifetime_spent  + GREATEST(-v_delta, 0)::int,
          updated_at = now();
    INSERT INTO public.diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
          lifetime_earned = COALESCE(public.diamond_wallets.lifetime_earned, 0) + GREATEST(v_delta, 0)::int,
          lifetime_spent  = COALESCE(public.diamond_wallets.lifetime_spent, 0)  + GREATEST(-v_delta, 0)::int,
          updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    -- A mirror is a mirror: it must never be able to refuse the thing it mirrors (2026-09-07 review
    -- D10: the two side tables carry FKs to auth.users and the seeder inserts the profile first).
    PERFORM public.fn_ca_diamond_incident('DR10:mirror_write_failed', 'warning', NEW.id, NEW.diamonds,
      'fn_diamond_side_tables_follow_profiles',
      jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'tg_op', TG_OP));
  END;
  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_side_tables_follow_profiles' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_enforce_anti_farming_caps()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$                                                                                 
 DECLARE                                                                                       
   v_recipient uuid;                                                                           
   v_check     jsonb;                                                                          
   v_kingfish  uuid := '47965354-0e56-43ef-931c-ddaab82af765';                                 
 BEGIN                                                                                         
   -- Only enforce on outbound (debit) rows                                                    
   IF NEW.amount IS NULL OR NEW.amount >= 0 THEN                                               
     RETURN NEW;                                                                               
   END IF;                                                                                     
                                                                                               
   -- Only on user→user diamond movement channels.                                             
   -- COALESCE coerces NULL to '' so NULL columns evaluate to FALSE (not NULL)                 
   -- in the IN check. Critical because deduct_diamonds writes source=NULL on                  
   -- every non-gift call (game_cost, course_purchase, etc.) and we need those                 
   -- to fall through to the early RETURN NEW.                                                 
   IF NOT (                                                                                    
        COALESCE(NEW.transaction_type, '') IN ('live_gift_sent','diamond_gift_sent')           
     OR COALESCE(NEW.source, '') IN ('stream_gift','wallet_transfer','wallet_diamond_transfer')
   ) THEN                                                                                      
     RETURN NEW;                                                                               
   END IF;                                                                                     
                                                                                               
   -- KINGFISH sender bypass                                                                   
   IF NEW.user_id = v_kingfish THEN                                                            
     RETURN NEW;                                                                               
   END IF;                                                                                     
                                                                                               
   -- Recipient_id required in metadata for enforced channels                                  
   v_recipient := NULLIF(NEW.metadata->>'recipient_id', '')::uuid;                             
   IF v_recipient IS NULL THEN                                                                 
     RAISE EXCEPTION 'Anti-farming: recipient_id missing from metadata for % transaction',     
       COALESCE(NEW.transaction_type, NEW.source)                                              
       USING ERRCODE = 'check_violation';                                                      
   END IF;                                                                                     
                                                                                               
   -- Delegate to shared cap function                                                          
   v_check := public.fn_check_anti_farming_gift_cap(NEW.user_id, v_recipient, ABS(NEW.amount));
                                                                                               
   IF NOT (v_check->>'allowed')::boolean THEN                                                  
     RAISE EXCEPTION 'Anti-farming: %', v_check->>'reason'                                     
       USING ERRCODE = 'check_violation', DETAIL = v_check::text;                              
   END IF;                                                                                     
                                                                                               
   RETURN NEW;                                                                                 
 END;                                                                                          
 $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_enforce_anti_farming_caps' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(current_setting('app.freeze_bypass', TRUE), '') = 'on';
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_freeze_bypass_active' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_get_streak_multiplier(p_streak_days integer)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$ BEGIN RETURN CASE WHEN p_streak_days >= 30 THEN 2.0 WHEN p_streak_days >= 14 THEN 1.8 WHEN p_streak_days >= 7 THEN 1.5 WHEN p_streak_days >= 3 THEN 1.2 ELSE 1.0 END; END; $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_get_streak_multiplier' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_guard_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed text;
  v_stack text;
BEGIN
  IF public.fn_is_service_context() THEN RETURN NEW; END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~ 'function (public[.])?deduct_diamonds[(]'
     OR v_stack ~ 'function (public[.])?fn_union_send_to_member[(]'
     OR v_stack ~ 'function (public[.])?claim_daily_challenge[(]'
     OR v_stack ~ 'function (public[.])?claim_daily_challenges[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_daily_bonus_claim[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_daily_bonus_boost_extra[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_free_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_plinko_drop[(]'
     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'
     OR v_stack ~ 'function (public[.])?fn_diamond_game_take_bet[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin_core[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_mint[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_burn[(]'
     OR v_stack ~ 'function (public[.])?send_stream_gift[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_deposit[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'
     -- DIAMOND PHASE 8: a tournament entry is custody; its charge and refund
     -- move the wallet from client doors.
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_charge[(]'
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_refund[(]'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.diamonds IS DISTINCT FROM OLD.diamonds THEN v_changed := 'diamonds';
  ELSIF NEW.diamond_balance IS DISTINCT FROM OLD.diamond_balance THEN v_changed := 'diamond_balance';
  ELSIF NEW.diamond_multiplier IS DISTINCT FROM OLD.diamond_multiplier THEN v_changed := 'diamond_multiplier';
  ELSIF NEW.is_vip IS DISTINCT FROM OLD.is_vip THEN v_changed := 'is_vip';
  ELSIF NEW.vip_tier IS DISTINCT FROM OLD.vip_tier THEN v_changed := 'vip_tier';
  ELSIF NEW.vip_expires_at IS DISTINCT FROM OLD.vip_expires_at THEN v_changed := 'vip_expires_at';
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION
      'profiles.% is server-managed and cannot be modified by role %',
      v_changed, current_user
      USING ERRCODE = '42501',
            HINT = 'Use a server-authoritative, ledgered money RPC.';
  END IF;

  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_guard_profile_privileged_columns' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_is_service_context()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
    v_raw_claims text;
    v_jwt_role   text;
BEGIN
    v_raw_claims := current_setting('request.jwt.claims', true);

    IF v_raw_claims IS NOT NULL
       AND btrim(v_raw_claims) <> ''
       AND btrim(v_raw_claims) <> 'null'
    THEN
        BEGIN
            v_jwt_role := v_raw_claims::jsonb ->> 'role';
        EXCEPTION WHEN others THEN
            -- Unparseable claims: fail CLOSED. A malformed JWT must never be
            -- mistaken for "no JWT".
            RETURN false;
        END;

        RETURN v_jwt_role = 'service_role';
    END IF;

    -- No JWT context.
    IF current_user IN ('anon', 'authenticated') THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_is_service_context' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_is_union_overseer(p_union_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_union_id IS NOT NULL AND p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id AND u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = p_union_id AND a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = p_union_id AND COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.club_members m
                WHERE m.club_id = p_union_id AND m.user_id = p_user_id
                  AND m.role IN ('owner','co_owner','admin')
                  AND m.status IN ('active','approved'))
  );
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_is_union_overseer' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_membership_starts_with_zero_chips()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_bot, false)
     OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.user_id AND COALESCE(p.is_horse, false))
  THEN
    RETURN NEW;
  END IF;

  NEW.chip_balance  := 0;
  NEW.held_chips    := 0;
  NEW.locked_chips  := 0;
  NEW.promo_balance := 0;
  NEW.credit_used   := 0;

  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_membership_starts_with_zero_chips' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_platform_frozen' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_refuse_operator_move_while_settling()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims text;
BEGIN
  -- Only operator movement. Everything a TABLE does is excluded on purpose:
  -- fn_atomic_buyin writes 'mint', so a freeze that caught mints would refuse
  -- buy-ins mid-session, and a settlement freeze is not a maintenance break.
  IF NEW.transaction_type IS NULL OR NEW.transaction_type NOT IN (
       'agent_wallet_send', 'agent_wallet_claim_back', 'agent_wallet_self_stake',
       'club_bank_send', 'club_bank_claim', 'club_bank_reversal',
       'promo_wallet_send', 'commission_claim',
       'admin_adjustment', 'admin_removal'
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.club_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The settlement runner and every server-side job move chips as
  -- service_role, and the freeze exists to protect exactly that work.
  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF coalesce(auth.role(), '') = 'service_role'
     OR session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF public.fn_club_settlement_frozen(NEW.club_id) THEN
    RAISE EXCEPTION
      'SETTLEMENT_FROZEN: this club is squaring its books. % was refused; it will succeed when the freeze lifts.',
      NEW.transaction_type
      USING ERRCODE = '55006',
            HINT = 'A settlement freeze stops operator transfers, not play. Nothing is lost - retry once the freeze is lifted.';
  END IF;

  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_refuse_operator_move_while_settling' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ONBOARDING NEVER FREEZES (to-do #2563 item 1). A membership row carrying
  -- no chips is identity, not money. This table, INSERT only, zero balance.
  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- CHIP STANDARD (2026-09-05): A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A
  -- WRITE. When a balance write was permitted (a money table outside this
  -- guard, or a permitted role), its chip_ledger leg is written by the
  -- autoledger inside that same statement, at trigger depth 2 or more.
  -- Refusing the leg while the write stands is the one outcome the standard
  -- cannot allow: 104 BBJ bank moves (9.69 chips) lost their legs this way at :55 and
  -- :00 up to 09-05 06:58 (ca_ledger_write_failures, sqlstate 55006), each one an unexplained movement on the BBJ meter. A direct
  -- INSERT on chip_ledger from a client (depth 1) is still refused.
  IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_refuse_while_frozen' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_satellite_transfer_ledger_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_satellite_transfer_ledger_is_immutable' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_terminal_tournament_evidence_is_immutable' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_union_can_manage_wallets(p_union_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_union_id IS NULL OR p_user_id IS NULL THEN RETURN false; END IF;
  RETURN public.fn_is_union_overseer(p_union_id, p_user_id)
      OR EXISTS (
        SELECT 1 FROM public.club_members member
         WHERE member.club_id = p_union_id
           AND member.user_id = p_user_id
           AND member.role = 'co_owner'
           AND member.status IN ('active', 'approved')
      )
      OR EXISTS (
        SELECT 1 FROM public.union_admins admin
         WHERE admin.union_id = p_union_id
           AND admin.user_id = p_user_id
           AND COALESCE(admin.role, '') IN ('co_owner', 'admin', 'owner')
      );
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_union_can_manage_wallets' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(current_setting('app.ledger_maintenance', true), '') IS NOT NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% is append-only: a spin is a fact and is never edited or deleted', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_append_only' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_can_operate(p_host_id uuid, p_host_kind text, p_user uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user IS NULL THEN RETURN false; END IF;
  IF COALESCE(auth.role(), '') = 'service_role' THEN RETURN true; END IF;
  IF public.fn_ca_caller_is_management() THEN RETURN true; END IF;
  IF p_host_kind = 'union' THEN
    RETURN public.fn_union_can_manage_wallets(p_host_id, p_user);
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_host_id AND c.owner_id = p_user)
      OR EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.club_id = p_host_id AND cm.user_id = p_user
                    AND cm.role IN ('owner', 'co_owner', 'admin')
                    AND COALESCE(cm.status, 'active') IN ('active', 'approved'));
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_can_operate' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_commit()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_seed text;
  v_hash text;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  -- One open commit per player: a fresh one replaces any unspent older ones,
  -- so a stale hash on a stale tab can never be spun.
  DELETE FROM public.wheel_seed_commits WHERE user_id = v_user AND consumed_by IS NULL;
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  INSERT INTO public.wheel_seed_commits (user_id, server_seed, server_seed_hash)
  VALUES (v_user, v_seed, v_hash) RETURNING id, expires_at INTO v_id, v_exp;
  RETURN jsonb_build_object('ok', true, 'commit_id', v_id, 'server_seed_hash', v_hash, 'expires_at', v_exp);
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_commit' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_config_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.wheel_config_history (host_id, changed_by, before, after)
  VALUES (NEW.host_id, COALESCE(NEW.updated_by, auth.uid()),
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NEW;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_config_history' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_host(p_club_id uuid, OUT host_id uuid, OUT host_kind text)
 RETURNS record
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(c.union_id, c.id),
         CASE WHEN c.union_id IS NULL THEN 'club' ELSE 'union' END
    FROM public.clubs c WHERE c.id = p_club_id;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_host' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_purchased_available(p_user uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(l.issued - l.consumed - l.refunded), 0)::integer
    FROM public.diamond_purchase_lots l
   WHERE l.user_id = p_user AND l.frozen_at IS NULL
     AND (l.issued - l.consumed - l.refunded) > 0;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_purchased_available' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_segments_audit(p_version integer)
 RETURNS TABLE(weight_total bigint, spec_rtp numeric, chip_share numeric, diamond_share numeric, house_share numeric, sd_chips numeric, hit_rate numeric, segments integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer;
  v_intake numeric;
BEGIN
  SELECT v.spin_price_diamonds INTO v_price FROM public.wheel_segment_versions v WHERE v.version = p_version;
  IF v_price IS NULL OR v_rate IS NULL THEN RETURN; END IF;
  v_intake := v_price::numeric / v_rate;   -- the spin in chips
  RETURN QUERY
  WITH s AS (
    SELECT g.weight,
           CASE g.kind WHEN 'chips' THEN g.amount WHEN 'diamonds' THEN g.amount / v_rate ELSE 0 END AS value_chips,
           g.kind
      FROM public.wheel_segments g WHERE g.version = p_version
  ), t AS (
    SELECT SUM(weight)::bigint AS w,
           SUM(value_chips * weight) / NULLIF(SUM(weight), 0) AS ev,
           SUM(CASE WHEN kind = 'chips' THEN value_chips * weight ELSE 0 END) / NULLIF(SUM(weight), 0) AS ev_chips,
           SUM(CASE WHEN kind = 'diamonds' THEN value_chips * weight ELSE 0 END) / NULLIF(SUM(weight), 0) AS ev_dia,
           SUM(CASE WHEN kind <> 'nothing' THEN weight ELSE 0 END)::numeric / NULLIF(SUM(weight), 0) AS hit,
           count(*)::integer AS n
      FROM s
  )
  SELECT t.w,
         round(t.ev / v_intake, 6),
         round(t.ev_chips / v_intake, 6),
         round(t.ev_dia / v_intake, 6),
         round(1 - t.ev / v_intake, 6),
         round(sqrt((SELECT SUM(power(s.value_chips - t.ev, 2) * s.weight) FROM s) / t.w), 6),
         round(t.hit, 6),
         t.n
    FROM t;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_segments_audit' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO PUBLIC,"postgres","anon","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_core(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_welcome boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_bank numeric; v_bank_after numeric;
  v_promo numeric; v_bank_only numeric; v_pay record;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
  -- The welcome budget is a window, not a lifetime total, and a welcome spin is
  -- the whole wheel or it is not offered. Both figures are measured once, up
  -- front, under the config lock that serialises every spin on this host.
  v_welcome_spent numeric := 0; v_welcome_top numeric := 0;
BEGIN
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Failed Its Audit. The Wheel Is Closed Until It Is Fixed');
  END IF;
  SELECT cfg.spin_price_diamonds / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_price  := cfg.spin_price_diamonds;
  v_intake := v_price::numeric / v_rate;
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted: the whole price
  -- is taken in by the host's owner, and the prize is paid out of what the host
  -- holds. The chip side is bounded by the chips this wheel has taken in (this
  -- spin included) plus the host's allowance; the diamond side by the diamonds
  -- it has taken in plus the seed the host put up. Both are "never more than
  -- taken in", stated on the money that actually moved.
  -- A WELCOME SPIN TAKES NOTHING IN (Dan 2026-09-10: the owner "simply receives
  -- no diamonds"). So it adds nothing to the float and nothing to the intake the
  -- paid game's invariant is stated on; its payout is charged to the welcome
  -- budget instead, a few lines below.
  v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;
  v_intake_chips := round((pool.intake_diamonds + v_dia_now)::numeric / v_rate, 2);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;

  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;

  -- ── the welcome spin: once per member, ever, and only out of a real budget ─
  IF p_welcome THEN
    IF NOT cfg.welcome_spin_enabled THEN
      RETURN jsonb_build_object('ok', false, 'error', 'There Is No Welcome Spin Here');
    END IF;
    IF COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spin Is Not Funded Here Yet');
    END IF;
    IF v_user = v_owner THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Host Does Not Take Its Own Welcome Spin');
    END IF;
    -- The unique index is what actually enforces this; the check is here to
    -- answer the player in words rather than with a constraint violation.
    IF EXISTS (SELECT 1 FROM public.wheel_spins s
                WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'You Have Already Taken Your Welcome Spin Here');
    END IF;
    -- A WELCOME SPIN IS THE WHOLE WHEEL OR IT IS NOT OFFERED (2026-09-11).
    -- The budget used to be checked tier by tier, so as the spend approached it
    -- the top prizes locked one after another and the last new members to
    -- arrive were handed a visibly worse wheel than the first ones. A gift that
    -- gets meaner the longer you take to join is not the gift Dan described.
    -- So the budget is asked ONE question before anything is offered: can it
    -- still cover the biggest prize on this table? If it can, every tier is
    -- live. If it cannot, there is no welcome spin here until the window turns.
    -- ONE DEFINITION OF THE QUESTION (2026-09-11). The door, the page and the
    -- entry read all asked it, and the entry read asked a DIFFERENT one, so a
    -- player could be told "Welcome Spin Ready" and then be refused by the
    -- door. There is one helper now and three callers.
    SELECT r.o_spent, r.o_top INTO v_welcome_spent, v_welcome_top
      FROM public.fn_wheel_welcome_room(v_host) r;
    IF v_welcome_spent + v_welcome_top > cfg.welcome_budget_chips THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spins Here Are Gone For Now');
    END IF;
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF NOT p_welcome AND v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's cover and its owner's diamonds, locked ─────────────────────
  -- The promo wallet pays first and the host's own chip bank stands behind it
  -- (Dan 2026-09-10). v_bank is the two together: what a prize may draw on.
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  -- ── eligibility: the affordability gate ────────────────────────────────────
  FOR seg IN SELECT * FROM public.wheel_segments g WHERE g.version = cfg.segment_version ORDER BY g.ord LOOP
    IF seg.kind = 'chips' THEN
      -- There is no welcome branch here any more. The budget was asked about
      -- the WHOLE table before the spin was allowed, so on a welcome spin every
      -- tier is affordable by construction and none of them may be locked for
      -- being expensive. The exposure gate below is the paid wheel's alone: a
      -- welcome spin took nothing in, so it may not lean on what the paid game
      -- took in either.
      IF NOT p_welcome AND pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'cover', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      -- THE PAID WHEEL'S FLOAT IS NOT THE GIFT'S TO SPEND (audit 2026-09-11).
      -- A welcome diamond prize comes from the owner and is charged to the
      -- welcome budget, which was checked just above. Gating it on the paid
      -- float as well locked tiers a club had every right to give away, and
      -- draining that float for it made the paid wheel pay for the welcome.
      IF NOT p_welcome AND pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'diamond_float',
                      'unlocks_at', round(seg.amount * v_mult - v_dia_now, 0));
        CONTINUE;
      END IF;
      IF v_owner_dia + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'owner_diamonds',
                      'unlocks_at', round(seg.amount * v_mult, 0));
        CONTINUE;
      END IF;
    END IF;
    v_eligible := v_eligible || seg.ord;
    v_total := v_total + seg.weight;
  END LOOP;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Prize Can Be Paid Right Now. Try Again Shortly', 'locked', v_locked);
  END IF;

  -- ── the roll: committed seed, player seed, per-player nonce ────────────────
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_spins s WHERE s.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  v_acc := 0;
  FOR seg IN SELECT * FROM public.wheel_segments g
              WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_segments g
     WHERE g.version = cfg.segment_version AND g.ord = v_eligible[array_length(v_eligible, 1)];
  END IF;

  -- ── 1. the spin is paid for, unless it is the welcome ─────────────────────
  -- THE OWNER SIMPLY RECEIVES NO DIAMONDS (Dan 2026-09-10). Not a refund, not a
  -- credit and back out again: on a welcome spin no diamond moves anywhere. The
  -- player pays nothing, the owner takes nothing, and what the host gives up is
  -- exactly the spin price it would have been paid.
  IF NOT p_welcome THEN
    v_deduct := public.deduct_diamonds(
      v_user, v_price,
      format('Diamond Wheel Spin (%s Diamonds)', v_price),
      'wheel_spin', 'wheel_spin',
      jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                         'commit_id', p_commit_id, 'segment_version', cfg.segment_version,
                         'recipient_id', v_owner),
      'wheel:' || v_spin_id::text, 0);
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                                'detail', v_deduct->>'error');
    END IF;
    -- The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.
    v_credit := public.add_diamonds_to_balance(v_owner, v_price, 'transfer',
                  format('Diamond Wheel Intake (%s Diamonds)', v_price), 'wheel:' || v_spin_id::text || ':intake', v_user);
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the spin price could not be credited to the host owner: %', v_credit->>'error';
    END IF;
    IF cfg.purchased_only THEN
      v_remaining := v_price;
      FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                    WHERE l.user_id = v_user AND l.frozen_at IS NULL
                      AND (l.issued - l.consumed - l.refunded) > 0
                    ORDER BY l.created_at, l.id FOR UPDATE LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
        UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'fn_wheel_spin_core: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
      END IF;
    END IF;
  END IF;

  -- ── 2. the prize ───────────────────────────────────────────────────────────
  IF v_pick.kind = 'chips' THEN
    v_prize_chips := round(v_pick.amount * v_mult, 2);
    v_value_chips := v_prize_chips;
    IF v_bank < v_prize_chips THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the host cover % is below the prize % after the gate passed', v_bank, v_prize_chips;
    END IF;
    -- ONE PAYER FOR EVERY CHIP THE DIAMOND GAMES PAY. The promo wallet goes
    -- first and the host's own bank covers whatever is left (Dan 2026-09-10),
    -- journaled from the paying side so each row names the column the chips
    -- left, and the member side stands down so nothing is journaled twice.
    SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(
      'wheel_prize', v_host, v_kind, p_club_id, v_user, v_prize_chips,
      'wheel-prize:' || v_spin_id::text,
      format('Diamond Wheel: %s', v_pick.label),
      jsonb_build_object('spin_id', v_spin_id, 'host_id', v_host, 'host_kind', v_kind,
                         'segment_version', cfg.segment_version, 'ord', v_pick.ord,
                         'welcome', p_welcome));
    v_member_after := v_pay.member_after;
    v_bank_after   := v_pay.cover_after;
    v_promo        := v_pay.promo_after;
    v_bank_only    := v_pay.bank_after;
    v_bank := v_bank_after;
  ELSIF v_pick.kind = 'diamonds' THEN
    v_prize_dia := (v_pick.amount * v_mult)::integer;
    v_value_chips := round(v_prize_dia::numeric / v_rate, 4);
    -- The diamond prize is paid BY THE HOST'S OWNER, out of what the wheel took
    -- in (Dan 2026-09-10). Two transfer legs, one transaction; nothing is issued.
    PERFORM public.fn_diamond_game_pay_diamonds(v_owner, v_user, v_prize_dia,
              format('Diamond Wheel: %s', v_pick.label), 'wheel:' || v_spin_id::text || ':prize');
  END IF;

  -- ── 4. the pool remembers, on the right side of the books ─────────────────
  -- A welcome payout NEVER enters chips_paid. chips_paid is bounded by what the
  -- paid game took in; the welcome is bounded by the budget the host declared.
  -- Two promises, kept apart, both checked below.
  UPDATE public.wheel_pools
     SET spins = spins + CASE WHEN p_welcome THEN 0 ELSE 1 END,
         welcome_spins = welcome_spins + CASE WHEN p_welcome THEN 1 ELSE 0 END,
         intake_diamonds = intake_diamonds + v_dia_now,
         chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,
         welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,
         diamond_float = diamond_float + v_dia_now
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: chips_paid % would exceed the chips taken in % + allowance % - the gate was bypassed',
      pool.chips_paid, round(pool.intake_diamonds::numeric / v_rate, 2), cfg.exposure_allowance_chips;
  END IF;
  -- The window is what is bounded now, not the lifetime total, and the row for
  -- THIS spin is not written until a few lines below - so the assertion is made
  -- on the figure the gate used plus what this spin just paid. Both were read
  -- under the config lock, so no other spin on this host can have moved them.
  IF p_welcome AND v_welcome_spent + v_value_chips > cfg.welcome_budget_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: the welcome window has paid % against a budget of % - the gate was bypassed',
      v_welcome_spent + v_value_chips, cfg.welcome_budget_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, cfg.segment_version,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, v_pick.amount * v_mult, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_spin_core' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_result(s wheel_spins)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'welcome', COALESCE(s.is_welcome, false),
    'spin_id', s.id, 'club_id', s.club_id, 'host_id', s.host_id,
    'segment_version', s.segment_version, 'spin_price_diamonds', s.spin_price_diamonds,
    'diamonds_per_chip', s.diamonds_per_chip,
    'outcome', jsonb_build_object('ord', s.outcome_ord, 'kind', s.outcome_kind, 'amount', s.outcome_amount,
                                  'label', (SELECT g.label FROM public.wheel_segments g
                                             WHERE g.version = s.segment_version AND g.ord = s.outcome_ord),
                                  'value_chips', s.prize_value_chips),
    'fairness', jsonb_build_object('commit_id', s.commit_id, 'server_seed_hash', s.server_seed_hash,
                                   'server_seed', s.server_seed, 'client_seed', s.client_seed,
                                   'nonce', s.nonce, 'roll', s.roll, 'weight_total', s.weight_total,
                                   'eligible_ords', to_jsonb(s.eligible_ords), 'locked', s.locked),
    'balances', jsonb_build_object('diamonds', s.diamonds_after, 'member_chips', s.member_chips_after),
    'pool', jsonb_build_object('chips_paid', s.pool_chips_paid_after,
                               'diamond_float', s.pool_diamond_float_after),
    'created_at', s.created_at);
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_spin_result' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role","authenticated"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_room(p_host uuid, OUT o_spent numeric, OUT o_top numeric, OUT o_open boolean)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  cfg public.wheel_configs%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_mult integer := 1;
BEGIN
  o_spent := 0; o_top := 0; o_open := false;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = p_host;
  IF cfg.host_id IS NULL THEN RETURN; END IF;

  -- The VIP multiplier the table is priced at, the same way the core reads it.
  SELECT COALESCE(cfg.spin_price_diamonds / v.spin_price_diamonds, 1) INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_mult := COALESCE(v_mult, 1);

  -- The biggest prize this table can pay, in chips, whichever kind it is.
  SELECT COALESCE(max(CASE WHEN g.kind = 'chips'    THEN g.amount::numeric * v_mult
                           WHEN g.kind = 'diamonds' THEN round((g.amount * v_mult)::numeric / v_rate, 4)
                           ELSE 0 END), 0)
    INTO o_top
    FROM public.wheel_segments g WHERE g.version = cfg.segment_version;

  o_spent := public.fn_wheel_welcome_spent(p_host, cfg.welcome_budget_period_days);
  -- A budget of zero is unfunded, not open with nothing in it.
  o_open := COALESCE(cfg.welcome_budget_chips, 0) > 0
        AND o_spent + o_top <= cfg.welcome_budget_chips;
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_welcome_room' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_spent(p_host uuid, p_days integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(s.prize_value_chips), 0)
    FROM public.wheel_spins s
   WHERE s.host_id = p_host
     AND s.is_welcome
     AND (COALESCE(p_days, 0) <= 0 OR s.created_at >= now() - make_interval(days => p_days));
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_welcome_spent' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, true);
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_welcome_spin' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_state(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_used boolean := false;
  v_member boolean := false;
  v_reason text := NULL;
  v_owner uuid;
  v_segments jsonb;
  v_taken integer := 0;
  v_spent numeric := 0; v_top numeric := 0;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg  FROM public.wheel_configs WHERE host_id = v_host;
  SELECT * INTO pool FROM public.wheel_pools   WHERE host_id = v_host;
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);

  -- THE WELCOME SPIN IS THE REAL WHEEL (Dan 2026-09-10: "a free 100 diamond
  -- spin"), so the table it shows is the wheel's own table, not a smaller one
  -- kept beside it. What is offered is exactly what a paying player sees.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ord', g.ord, 'label', g.label, 'kind', g.kind,
                                               'amount', g.amount, 'weight', g.weight,
                                               'value_chips', CASE WHEN g.kind = 'chips' THEN g.amount::numeric
                                                                   ELSE round(g.amount::numeric / v_rate, 4) END,
                                               'probability', round(g.weight::numeric / NULLIF(t.total, 0), 6),
                                               'locked', false)
                            ORDER BY g.ord), '[]'::jsonb)
    INTO v_segments
    FROM public.wheel_segments g,
         (SELECT sum(weight) AS total FROM public.wheel_segments WHERE version = (SELECT segment_version FROM public.wheel_configs WHERE host_id = v_host)) t
   WHERE g.version = (SELECT segment_version FROM public.wheel_configs WHERE host_id = v_host);

  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.welcome_spin_enabled THEN
    v_reason := 'closed';
  END IF;
  IF v_reason IS NULL AND COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
    v_reason := 'unfunded';
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.wheel_spins s
                    WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) INTO v_used;
    SELECT EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = v_user
                      AND COALESCE(m.status, 'active') IN ('active', 'approved')) INTO v_member;
  END IF;
  SELECT COALESCE(pool.welcome_spins, 0) INTO v_taken;
  IF v_reason IS NULL AND v_used THEN v_reason := 'used'; END IF;
  -- The same one question the door asks: can the window still cover the biggest
  -- prize on this table? The page and the door must agree, so the figure comes
  -- from the same helper rather than from a second copy of the arithmetic.
  SELECT r.o_spent, r.o_top INTO v_spent, v_top FROM public.fn_wheel_welcome_room(v_host) r;
  IF v_reason IS NULL AND v_spent + v_top > COALESCE(cfg.welcome_budget_chips, 0) THEN v_reason := 'pot_empty'; END IF;
  IF v_reason IS NULL AND v_user IS NOT NULL AND NOT v_member THEN v_reason := 'not_member'; END IF;
  -- The host does not welcome itself: an owner spinning their own wheel for
  -- free would spend the club's budget on the club's own account.
  IF v_reason IS NULL AND v_user IS NOT NULL AND v_user = v_owner THEN v_reason := 'owner'; END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled', COALESCE(cfg.welcome_spin_enabled, false) AND COALESCE(cfg.enabled, false),
    'available', v_user IS NOT NULL AND v_reason IS NULL,
    'reason', v_reason,
    'used', v_used,
    'once_only', true,
    'spin_price_diamonds', COALESCE(cfg.spin_price_diamonds, 0),
    'budget_chips', COALESCE(cfg.welcome_budget_chips, 0),
    'budget_period_days', COALESCE(cfg.welcome_budget_period_days, 0),
    'budget_paid_chips', v_spent,
    'budget_left_chips', GREATEST(COALESCE(cfg.welcome_budget_chips, 0) - v_spent, 0),
    'top_prize_chips', v_top,
    'lifetime_chips_paid', COALESCE(pool.welcome_chips_paid, 0),
    'welcome_spins', v_taken,
    'segments', v_segments);
END $function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_welcome_state' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","authenticated","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stack   TEXT;
  v_bypass  TEXT;
  v_allowed TEXT[] := ARRAY[
    'atomic_credit_wallet_and_log','atomic_deduct_wallet_and_log','atomic_wallet_transfer',
    'atomic_chip_transfer','fn_idempotent_credit_wallet','fn_idempotent_deduct_wallet',
    'fn_idempotent_wallet_transfer','atomic_table_buyin','atomic_table_cashout',
    'atomic_table_rebuy','atomic_table_addon','atomic_table_withdraw','atomic_seat_horse','player_leave_table','atomic_tournament_register',
    'atomic_tournament_unregister','atomic_cancel_tournament','distribute_tournament_prizes',
    'process_tournament_rebuy',
    'atomic_pay_player_rakeback','credit_agent_commission',
    'credit_player_rakeback','fn_cancel_cashout','fn_reject_cashout',
    'fn_clawback_chips_atomic','distribute_chips','mint_club_chips','add_chips','add_to_promo_wallet',
    'credit_player_wallet','deduct_player_wallet','wallet_internal_transfer','wallet_user_transfer',
    'create_user_wallets','reconcile_ledger_nightly',
    -- added 2026-08-15 with the chip-removal authority policy
    'fn_admin_remove_player_chips','fn_approve_cashout_atomic','fn_cancel_cashout_atomic',
    -- added 2026-08-21 with the diamond-backed Chip Mint (Dan's directive)
    'fn_mint_chips_from_diamonds',
    -- added 2026-08-23 with the Club Bank Cashier (Dan directive)
    'fn_club_bank_send',
    'fn_club_bank_claim_back', 'fn_promo_wallet_send',
    'fn_club_bank_reverse'
    -- removed 2026-08-31 (phase 6): execute_commission_payout, which credited a
    -- wallet, debited nothing and never marked the commission settled.
    -- removed 2026-09-01 (phase 7): atomic_pay_agent_settlement, a staff payout
    -- that decremented a column nothing incremented.
  ];
  v_fn TEXT;
BEGIN
  v_bypass := current_setting('app.bypass_wallet_guard', true);
  IF v_bypass = 'on' THEN RETURN NEW; END IF;
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  FOREACH v_fn IN ARRAY v_allowed LOOP
    IF v_stack ~ ('function (public\.)?' || v_fn || '\(') THEN
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION
    'Direct balance mutation on %.% is forbidden by Phase 4.1.6a guard. '
    'All balance changes must flow through the whitelisted SECURITY DEFINER '
    'RPCs (atomic_*, fn_idempotent_*, distribute_chips, mint_club_chips, etc.) '
    'that log to chip_ledger. Admin override: '
    'SELECT set_config(''app.bypass_wallet_guard'', ''on'', true);',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='guard_wallet_balance_write' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.trg_union_rake_weekly()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.union_id IS NOT NULL
     AND NEW.wallet = 'rake_wallet'
     AND NEW.direction = 'credit'
     AND NEW.tx_type = 'rake' THEN
    INSERT INTO public.union_rake_weekly (union_id, club_id, week_start, rake_total, updated_at)
    VALUES (NEW.union_id, NEW.club_id, date_trunc('week', NEW.created_at)::date,
            COALESCE(NEW.amount, 0), now())
    ON CONFLICT ON CONSTRAINT union_rake_weekly_key DO UPDATE
      SET rake_total = public.union_rake_weekly.rake_total + EXCLUDED.rake_total,
          updated_at = now();
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Never let a display rollup block the engine banking rake. A failure here
  -- costs a stale panel; the function's fallback still reads the ledger.
  RAISE WARNING 'union_rake_weekly maintenance failed for tx %: %', NEW.id, SQLERRM;
  RETURN NULL;
END
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='trg_union_rake_weekly' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
CREATE OR REPLACE FUNCTION public.zz_chip_ledger_key_is_claimed_once()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* 99.92% of legs carry no key and this does nothing for them. */
  IF NEW.idempotency_key IS NULL THEN
    RETURN NEW;
  END IF;

  /* No ON CONFLICT: the unique violation IS the refusal, and it must reach the
     caller exactly as ux_chip_ledger_idempotency_key's does today. Both are
     live until the cut; either one refusing is the correct outcome. */
  INSERT INTO public.chip_ledger_idem (idempotency_key, leg_id, created_at)
  VALUES (NEW.idempotency_key, NEW.id, COALESCE(NEW.created_at, now()));

  RETURN NEW;
END;
$function$
;
DO $fixture$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='zz_chip_ledger_key_is_claimed_once' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO "postgres","service_role"'; END LOOP; END $fixture$;
RESET check_function_bodies;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='add_diamonds_to_balance' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='bf12296402133e7917d61c91ba0e9328f01606287349cf6d8cd096513467fe3d')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','add_diamonds_to_balance'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='award_diamonds_v2' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='568a58bf86a8fc7a159feb9708f11b6e83170f630d713afab53f459f1870bdc4')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','award_diamonds_v2'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='deduct_diamonds' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='fd840332ec2cdcf62856eb6befcee071fff1b6108b4426b669d3c10267820334')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','deduct_diamonds'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='enforce_chip_ledger_performed_by' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='13753ad5849313d8751bf581bbb26bd1833ec499edb4ae7c6941da9c54ecb579')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','enforce_chip_ledger_performed_by'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_accounting_transfer_document_on_insert' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='589cd51f30a11ea8048b827aecf085a8d58699e7ee76ee1e32aae5e49c05fc11')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_accounting_transfer_document_on_insert'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_active_maintenance_release_boundary' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='4d35241aa431aa58e133ca9d09c50b8fa911cec26d464a3362cff3cec92c20a7')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_active_maintenance_release_boundary'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_admin_holds_no_player_wallet' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='aaf5de457136c46a2f61873ca16466f99f641c2d1802614f3f412778684c7a57')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_admin_holds_no_player_wallet'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_block_browser_balance_inserts' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='519fd388a2fa086df616f12f7c4c9da4dc6496214206876e32536f690b3f16a1')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_block_browser_balance_inserts'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_block_browser_balance_writes' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='0e03602303656386a72c9965519340f4a19a95bbec248aee34212aca5376aabd')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_block_browser_balance_writes'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_attested_day_is_restated' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='cf28683f98003403a9088e8a4a9a2814cbd749d4fee43658dd462b4f0dee7d8e')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_attested_day_is_restated'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_audit_diamond_change' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='24d3425702fb3c6db168beff6f862046a6273226f31e8248789db2be5f505204')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_audit_diamond_change'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_autoledger' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='c6cb4c3b195b7b4f3ffcdc6316f546721c3a5f57ff00511d2548640a53272fdc')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_autoledger'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_block_browser_money_table' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='418746f26e4130d20c22fc776e2ab4f763e305c58f85f85ec94ada62c164641b')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_block_browser_money_table'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_bridge_rate' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='565cd049a710d23206b3d6723ce6b289b02ee87562e3cead2a8bdabedabf4f1b')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_bridge_rate'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_caller_is_management' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='114b15fd953d361cbe362451410a5d072c9083b58dab4b8d609041d33f4d7995')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_caller_is_management'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_capture_tournament_charge_entitlement' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='99549b35b5ddb15a56962c1993c116843958bfa1d691793bee385736cfe6a16a')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_capture_tournament_charge_entitlement'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_chip_ledger_enrich' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='666b9070facf98c98f2a147a155d9d265130aaa7a7171d5c7e555a2801cfb8ff')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_chip_ledger_enrich'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_chip_store_declared' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='9f9689c319dd49298ee2472520cdc667342b7f59c11a82970d7aba419753291a')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_chip_store_declared'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_consume_purchase_lots' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='be740f60e823db33a4bf63293470fa4204d6622d6497efb7455977ef44fb19b6')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_consume_purchase_lots'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_current_epoch' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='470a97d97e628d7466bc1d1be0898d02faa7a17054e88a1d18d371903e48b54c')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_current_epoch'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_budget_check' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='18c6aa15f9a05243191c260bbd66dd944f06abfe2fdac1a7775d3d3434683f42')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_budget_check'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_caps' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='9d3bba72212911e9511e2db975aa52c4669fa3ec6f02bae4ce28bc24205c69ed')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_caps'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_claim' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='51bf1d42e3f24e8d0ff45829f293c85986300e727f650c4130bfeafac5abf7c7')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_claim'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_claimed_from' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='793ed2e07f5da78ff419a4146a79377435de3160336dba4abc07ffad6f44880e')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_claimed_from'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_claims_append_only' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='1d5bbc3b7af73187409d3384cd31e64b7d463b254e802ea89ef2a6c6d865fcdc')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_claims_append_only'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_eligibility' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='fa342350ef9c1d147f6f489386d73a1a34f604d3c41a12c8239d0386150a4dd0')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_eligibility'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_open_day' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='2180756a80d39350b79ff50b9b6f0b108f5c566bae849bb62fed3f326c76f87c')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_open_day'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_refuse' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3b4375ea68cb8d2c3a1ec2e82a52a1c75a4bb5bd732b4e31deb3847ab98597f4')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_refuse'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_roll_lucky' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='d9c4c4385a81304b52308451a28d1fa091c2fb03058e039e284ffad92669c2fe')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_roll_lucky'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_roll_mystery' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='da1ddfaed2ca1fdcab352f9e2a5f0aa79be0aef7371af0f5cc7276f7af27fb5c')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_roll_mystery'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_status' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='96c48dc9f7be954173d918b490bee7dd45f272f1260cccd7afc22b044422ae63')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_status'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_daily_bonus_velocity_check' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='74a0775b6e1c17dbad1cc114450f2685b695f78cd4f06a446a96d4b0f351e3f0')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_daily_bonus_velocity_check'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_declare_ledger' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='bf736f3db4a8c68934eb978347e82195cd80f2e9172afd8c5a7327f6e2f00a11')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_declare_ledger'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_born_with_balance' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='ab360a6131e7eef7d20e3487e5ef3c94da7c9db8ef8c53ae16fce79fd261dcee')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_born_with_balance'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_catalog_history' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='eb4ad708935d66d874ffaef1a3968f4a7c0f921eba236bd0e463b4efacf7c44e')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_catalog_history'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_earn_ledger' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='d081c4264d1c271360c3c7ed0941064b53169d5a027a0ad4e652045f935334c5')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_earn_ledger'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_engine_of' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='d2d106cb00aaf98e1356d8af5ea6ede68c9d6d0d48fd8517b376578f7a7a2fac')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_engine_of'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_incident' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='a4c45f2540f51f0b9fcd2fbe96f146f914ad8f39ed382ebfff45f19621078270')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_incident'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_journal_classifier' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='8270ad0a51698ebc13e5a7b91c816585f6e9ceb605a5a5bafb28337aee25c09e')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_journal_classifier'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_journal_is_transfer' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='fae09364ee42d53ba61415da8c11d259e4e52d5a580df6373f9a2f243f77e575')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_journal_is_transfer'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_journal_origin' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='91d39733c339ad529ab7f5b85ac9f886ef732c498938b538f9e382f51e9873cb')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_journal_origin'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_register_follows_journal' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='91e4d30ba2cbd7366bb33d6f98d8fa36631029f12636c32ef088072ae5a6b65a')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_register_follows_journal'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_rule_mode' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='72bfd8bbfceae0429578e592b79b39b06add4e9e66775d1a3751853cf1016805')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_rule_mode'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_transfer_names_its_counterparty' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='936be6489e51cb9cd75aec328dbb006a92eb46998133fb68ccb780982332070b')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_diamond_transfer_names_its_counterparty'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_engine_spend_append_only' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='4501e69ce37ee0654f40001c63c39cff8b637713b4ed19fa53b811af733d685e')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_engine_spend_append_only'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_escrow_on_overlay_leg' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='5e28e22236e98d5dfed07eafd55cebc64c2383479edc6115489fbd394243699c')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_escrow_on_overlay_leg'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_escrow_on_reserve_leg' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='86f9f7917a724b1695bb9df32bc261ab6934d68cb9a33bfed61c4882be7c25ee')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_escrow_on_reserve_leg'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_escrow_on_seat_transfer_leg' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3e932f2a75b1b08702d4d92faa3b8e13b60e740ad8fbf76c366d242a2e90a0b0')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_escrow_on_seat_transfer_leg'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_house_board_allows_automation' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='58d587852dc2043463d0ee00ca8ba1cb8105e743af27d029e7b3045207c0650b')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_house_board_allows_automation'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_is_cert_account' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='5a09dfad40d5019977b883ffdff3ba9d0e1b59d3ad252c40381123ebb8271ea3')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_is_cert_account'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_is_fixture_account' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b504b225a25868de686d0ce4ffd9140902aef3d722336b4d6966e0384aac5639')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_is_fixture_account'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_issuance_leg_is_registered' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='66324f56b85879639a1388226f63e0047d9f4dd53665627aa2f75c8a9c80dde1')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_issuance_leg_is_registered'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_journal_append_only' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b5acbe01ca773e3de3521abf897f37a9cc9d2cb1db36388d2ef6482d21d8792e')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_journal_append_only'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_mint' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='0acf220f35c73d97906c4daa0d096cb6ba7d2acba974c35b3ba3f0a3c712a8cb')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_mint'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_mint_issued_24h' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='7204f2f5c4f0f85be9a84c2431661a78f6fcd6b0f0a5abe72f42eef324b15fa0')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_mint_issued_24h'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_mint_register_append_only' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3175db53bd3e1506a2ca79efc92abf498b0d1f79fc0ec2335074d68a0151358c')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_mint_register_append_only'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_mint_supply' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='dc70eda89c90cd22c5b9cd04a6128ded298505a90bbbe8e8f7753daabc2cc0e7')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_mint_supply'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_noncirculating_chip_stores' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='32ab42fa2fcf417430bc87a8fc724f81bfe6b672c34c59ada1378fe0972a72f5')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_noncirculating_chip_stores'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_register_diamond_journal_row' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b85d1a8bc345820ea5a550d464b70d662b872e834149f3820de5cd20ef540a56')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_register_diamond_journal_row'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_register_issuance_leg' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='959f670972ef49b812daf6b34e036efdc5674443ed43109af0ae1da8045aa397')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_register_issuance_leg'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_touch_updated_at' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='807101d3537080bc746ef96448d5657ff72f33f8ea428f3b1f37cac0cf86d39c')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_ca_touch_updated_at'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_caller_is_engine' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='f45d32b0cf924cca73d2c7576abf603d48599fd5a9cb844b1fb508bed5bde448')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_caller_is_engine'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_cancelled_tournament_evidence_is_immutable' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='582fca6e850bd6d330ea1bf53f931b5477bca0f7682ca50074866a86999f92e3')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_cancelled_tournament_evidence_is_immutable'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_check_anti_farming_gift_cap' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='018c78e947b7be614b475277a20b5fd47c2a55e05042ff62fbd921cf53625ffc')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_check_anti_farming_gift_cap'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_club_members_ledger_writer' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='14fe1b7cb9a89d53483f58c7d3019545c6431d5ba3d72ee4c57cbed96948a7fd')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_club_members_ledger_writer'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_club_settlement_frozen' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='242d76e28ff8c579a5c44767057e7bf982ba4bd58a07229dc4c9ce5679a6dc26')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_club_settlement_frozen'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_balance_mirrors_canonical' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='4944cd8e23cfa75af853afe8a39092e2cdab84360484ab547bde2b52f1969f1a')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_balance_mirrors_canonical'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_cover_lock' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='d97e0a1a41d6d6b9619b29636e62301b0770e4e314e7f6ab291c4e64e9f9f9bd')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_game_cover_lock'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_fund_promo' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b5bd04484bba8ebf66ff6f492b5fa6e9c783ceb9b533fcbbc9c4915826bf0d52')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_game_fund_promo'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_owner' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='9243ec27a8e4c4ed6fdf077f24e0d6c507d062a4e241ee512b8734edd79ae9ea')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_game_owner'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_pay_chips' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='c8332e221246567a15a4964cfb5feeb5f2015f5d2adeb8ce4855f980eeca0fd9')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_game_pay_chips'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_pay_diamonds' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3ef6b278e277d85d28db12270419581d49ee5bb65489f7525d8b33a3dde90762')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_game_pay_diamonds'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_game_reserved_cover_guard' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='7e0a8a30f16f216f28704e706e46cc4b9a6287aa19b7e6ee45277fc54ae80908')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_game_reserved_cover_guard'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_games_spent_today' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='f97acfd741abc176f516528d28ae7b07f569222eaf1a4dac0a3bb9eb8c9d0c18')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_games_spent_today'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_side_tables_follow_profiles' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='edf18b2d9984cce0f09cedbd6ec8f6f2c58a8d42ff64c3cc13353fa27103fd7c')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_diamond_side_tables_follow_profiles'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_enforce_anti_farming_caps' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='17f085dc1785ca9905cfce97aa524207b8c48708d203a0f09f57b999b18a66c5')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_enforce_anti_farming_caps'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_freeze_bypass_active' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='f865d4069c59e23b4beda52ab0a93ad0b870349c681b9b197a25956e0d105aa6')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_freeze_bypass_active'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_get_streak_multiplier' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='38952d40e6956341ebda840983f7715ee9fd61c6d268d6adcdcfdc295d77a0b1')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_get_streak_multiplier'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_guard_profile_privileged_columns' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='e5d615211610d9b00ca897b5b7643eeec414f4e935f2b95ff5432332d888e278')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_guard_profile_privileged_columns'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_is_service_context' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='a453ebe6f653f3df4554fc5386abaf4e294d640088633af0069790de76ca1053')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_is_service_context'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_is_union_overseer' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='6d0849af55a3003e9baf7e210dd3d31218c5470a0ee6282700e34ab6f09b4e38')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_is_union_overseer'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_membership_starts_with_zero_chips' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='519a7ac92103bf51663b56dbbc2231444cfc7225232d18c4fed42d51a26dbee0')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_membership_starts_with_zero_chips'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_platform_frozen' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='83e8dbd760894cd61c39ce1113b0448d2609ac378cb6018f2d231f09b409c96d')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_platform_frozen'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_refuse_operator_move_while_settling' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='2728d45c93638d3b7358d6a4f2929fe7a1861717e3ccfc9695d9997ad7d03a4f')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_refuse_operator_move_while_settling'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_refuse_while_frozen' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='f74f74e785c9588947fd2fb2c5a1d9e1d2b8102eb35de8ce8556353d8a319915')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_refuse_while_frozen'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_satellite_transfer_ledger_is_immutable' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='e7c0990e417619b03d9cc945556bbf242eed1cb1a4bda87e9fe17cbc79ef9724')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_satellite_transfer_ledger_is_immutable'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_terminal_tournament_evidence_is_immutable' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='d1f0b930944f5f1ad4825fdb4788e0fac2facf413f797bfbe2fb99a7bdc39062')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_terminal_tournament_evidence_is_immutable'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_union_can_manage_wallets' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3326ec726f7b3c4646b9df55559c353ba63347333b1d7a66e7343d9368a6560c')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_union_can_manage_wallets'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_append_only' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='c68048e2419dff42a28e03eb7718a6dd51de001c4ee08ac75c8ba09237db21e9')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_append_only'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_can_operate' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='05f571e74fbf9c5d876cd96c5eb1e9bdd820e02fec6c834c9a4cbd6ca3bc5b71')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_can_operate'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_commit' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='dd989a258e5b458592e256da4fb85552393f68c790d102b713b91cab9defdeb7')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_commit'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_config_history' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3bd837735fe272cbba5b2b4a8c53f2fe4ce2cd9bf75844a81c2953a042e458fd')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_config_history'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_host' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='9bf302c8a617a05e7f045f6f1fa66283fb8c21f436840f120c6e8c5f78b682f1')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_host'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_purchased_available' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='7505ff8f50ba2fa6f2b799f3754da6e423ab64d4b1bf150ff186a7b51cd703fe')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_purchased_available'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_segments_audit' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='4a180d22278418bdaf8d7e2d97eb2d8d76bb4c71906aef602bd65f934f17257b')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_segments_audit'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_spin_core' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b09a88dc1ddd2d1f2cdb922497640d2afaff4c5fa1341392a621ede6c7271101')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_spin_core'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_spin_result' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3d4aa7dc65e509d3994f32f8ed00ca7468e08d71ec5ac15230cc1c0fea942661')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_spin_result'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_welcome_room' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='651aedfce74d97503c366a54dd879f1ff3a343be9473f39cc0948e72605ada9d')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_welcome_room'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_welcome_spent' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='fa4353c1d4b8fdbfdc0f6ede24e847a92d127d547a32436ac560ee6f66636032')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_welcome_spent'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_welcome_spin' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='a351b1b85ec61c3d89b25a8f6450f58f5be459d6713316f20715507792c090cf')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_welcome_spin'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_welcome_state' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='d5531e7f943f9e93bf9d119cb379cb7f04753fa2691d307a6e5decd43806bbe3')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','fn_wheel_welcome_state'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='guard_wallet_balance_write' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='d79082b2fd27ce2b9974b46a9e0f04e54f44e4e221b3dda9dbe634cfb89cc32b')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','guard_wallet_balance_write'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='trg_union_rake_weekly' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='6234d4fbf6ec6bb350adf8dbe846d932eff55f62bd91e4c3f777e9c8cd9c325d')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','trg_union_rake_weekly'; END IF; END $fixture$;
DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='zz_chip_ledger_key_is_claimed_once' AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='540a91a39157f4bbff88c516a04cca29d1c32f59c974b94f9ca5cd3f0de3b87d')<>1 THEN RAISE EXCEPTION 'Diamond fixture function witness failed: %','zz_chip_ledger_key_is_claimed_once'; END IF; END $fixture$;
