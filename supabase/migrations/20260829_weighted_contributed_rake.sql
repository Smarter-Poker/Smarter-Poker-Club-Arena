-- 20260829_weighted_contributed_rake.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- WEIGHTED CONTRIBUTED RAKE (Dan, 2026-08-29, BINDING).
--
-- This migration RETIRES equal-dealt rake attribution (FIX 144 / DECISION
-- D-001) for new cash-game hands and replaces it with WEIGHTED CONTRIBUTED
-- rake: a player's credited rake is proportional to the player's actual
-- eligible contribution to the rakeable pot.
--
--   playerWeightedRakeCredit =
--     playerEligibleContribution / totalEligibleContributions * regularRake
--
-- KEY FACTS THE DESIGN LEANS ON:
--   * rake_records.player_contributions has ALWAYS held per-player ELIGIBLE
--     contribution (engine totalInvested, which returnUncalledBet() decrements
--     BEFORE capture) — so uncalled returned bets are already excluded.
--   * Rake COLLECTION (the club/union money legs) is untouched. This changes
--     ATTRIBUTION only. Regular rake, BBJ drop and promo drops remain separate
--     accounting buckets exactly as before.
--
-- MIGRATION BOUNDARY (deterministic per hand):
--   atomic_distribute_rake gains p_rake_method DEFAULT 'DEALT_EQUAL'. The old
--   engine (pre-deploy) omits it -> rows stamped DEALT_EQUAL and processed
--   equal-share, exactly as before. The new engine passes
--   'WEIGHTED_CONTRIBUTED' -> rows stamped and processed weighted. Every
--   consumer below branches PER ROW on rake_method, so a settlement window,
--   a rakeback period or a rollup day that spans the boundary handles each
--   hand under the methodology it was settled with. Historical rows have
--   rake_method 'DEALT_EQUAL' (column default) and are NEVER re-attributed.
--
-- ONE ALLOCATOR: fn_allocate_rake_credits() is the single SQL source of truth
-- for per-player rake credits. atomic_distribute_rake (ledger writes),
-- fn_rakeback_recompute_periods, fn_close_settlement_period,
-- fn_club_rake_rollup_day, fn_agent_downline_rake, fn_bbj_rollup_day and the
-- VIP trigger all consume it. The TS mirror is
-- server/src/services/rakeAllocation.ts, pinned by a shared test-vector suite.
--
-- ROUNDING (deterministic largest-remainder, integer cents):
--   floor(amount_cents * contrib_cents / total_cents) per player, then the
--   leftover cents go one each to the players with the largest integer
--   remainder, ties broken by user_id ascending. The same hand allocated twice
--   produces identical results, and Σ credits == round(amount, 2) exactly.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Schema: methodology stamp + returned-uncalled audit ──────────────────
ALTER TABLE public.rake_records
  ADD COLUMN IF NOT EXISTS rake_method text NOT NULL DEFAULT 'DEALT_EQUAL',
  ADD COLUMN IF NOT EXISTS returned_uncalled jsonb;

DO $$ BEGIN
  ALTER TABLE public.rake_records
    ADD CONSTRAINT rake_records_rake_method_check
    CHECK (rake_method IN ('DEALT_EQUAL', 'WEIGHTED_CONTRIBUTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Per-player, per-hand rake ledger. The table already exists (with
-- uq_rake_attributions_hand_player) but was written by nothing. It becomes
-- the durable, auditable per-player allocation ledger.
ALTER TABLE public.rake_attributions
  ADD COLUMN IF NOT EXISTS rake_record_id uuid,
  ADD COLUMN IF NOT EXISTS table_id uuid,
  ADD COLUMN IF NOT EXISTS club_id uuid,
  ADD COLUMN IF NOT EXISTS gross_contribution numeric,
  ADD COLUMN IF NOT EXISTS returned_uncalled numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS eligible_contribution numeric,
  ADD COLUMN IF NOT EXISTS contribution_weight numeric,
  ADD COLUMN IF NOT EXISTS weighted_rake_credit numeric,
  ADD COLUMN IF NOT EXISTS bbj_attributed_contribution numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rake_method text;

-- The re-drive queue must carry the methodology and the returned-uncalled
-- detail of the hand it re-drives, or a reconciled hand would be re-labelled.
ALTER TABLE public.pending_fee_distributions
  ADD COLUMN IF NOT EXISTS rake_method text,
  ADD COLUMN IF NOT EXISTS returned_uncalled jsonb;

-- ── 2. THE canonical allocator ───────────────────────────────────────────────
-- Returns one row per player with a POSITIVE eligible contribution.
--   credit: the player's rake credit in currency units (2dp)
--   weight: eligible_contribution / total_eligible_contributions
-- p_method 'WEIGHTED_CONTRIBUTED': largest-remainder proportional allocation.
-- p_method 'DEALT_EQUAL' (legacy rows only): the exact historical equal split
--   (integer cents, remainder to the first users by key order) so historical
--   records keep reproducing their historical truth.
CREATE OR REPLACE FUNCTION public.fn_allocate_rake_credits(
  p_amount        numeric,
  p_contributions jsonb,
  p_method        text DEFAULT 'WEIGHTED_CONTRIBUTED'
)
RETURNS TABLE(user_id uuid, credit numeric, weight numeric)
LANGUAGE sql
IMMUTABLE
AS $function$
  WITH c AS (
    SELECT (k.key)::uuid AS uid,
           round((k.value)::numeric * 100)::bigint AS cc
      FROM jsonb_each(COALESCE(p_contributions, '{}'::jsonb)) k
     WHERE jsonb_typeof(k.value) = 'number'
       AND (k.value)::numeric > 0
       AND k.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  t AS (
    SELECT COALESCE(SUM(cc), 0)::bigint AS total,
           round(GREATEST(COALESCE(p_amount, 0), 0) * 100)::bigint AS amt,
           COUNT(*)::bigint AS n
      FROM c
  ),
  weighted AS (
    SELECT c.uid, c.cc,
           (t.amt * c.cc) / t.total AS fl,
           (t.amt * c.cc) % t.total AS rem,
           t.amt, t.total
      FROM c CROSS JOIN t
     WHERE t.total > 0
  ),
  weighted_ranked AS (
    SELECT w.*,
           row_number() OVER (ORDER BY w.rem DESC, w.uid ASC) AS rn,
           SUM(w.fl) OVER () AS fl_sum
      FROM weighted w
  ),
  equal_ranked AS (
    SELECT c.uid, c.cc, t.amt, t.total, t.n,
           row_number() OVER (ORDER BY c.uid ASC) AS rn
      FROM c CROSS JOIN t
     WHERE t.n > 0
  )
  SELECT uid,
         ((fl + CASE WHEN rn <= (amt - fl_sum) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM weighted_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'WEIGHTED_CONTRIBUTED'
  UNION ALL
  SELECT uid,
         (((amt / n) + CASE WHEN rn <= (amt % n) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM equal_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'DEALT_EQUAL';
$function$;

ALTER FUNCTION public.fn_allocate_rake_credits(numeric, jsonb, text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_allocate_rake_credits(numeric, jsonb, text) TO postgres, service_role, authenticated;

-- ── 3. atomic_distribute_rake v2: stamp method + write the per-player ledger ─
-- Money legs (b)(c)(d) are byte-identical to 20260724f. New:
--   * p_returned_uncalled: per-player returned uncalled amounts (audit only)
--   * p_rake_method: DEFAULT 'DEALT_EQUAL' so the pre-deploy engine keeps its
--     exact behaviour; the new engine passes 'WEIGHTED_CONTRIBUTED'
--   * (e) rake_attributions per-player ledger written on FIRST CLAIM in the
--     same transaction, with a reconciliation assert (never blocks: on the
--     impossible mismatch it files a critical financial_alert instead).
DROP FUNCTION IF EXISTS public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid);
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(
  p_table_id          uuid,
  p_club_id           uuid,
  p_hand_id           uuid,
  p_hand_number       integer,
  p_rake              numeric,
  p_bbj               numeric DEFAULT 0,
  p_pot               numeric DEFAULT NULL,
  p_num_players       integer DEFAULT NULL,
  p_contributions     jsonb   DEFAULT NULL,
  p_tournament_id     uuid    DEFAULT NULL,
  p_returned_uncalled jsonb   DEFAULT NULL,
  p_rake_method       text    DEFAULT 'DEALT_EQUAL'
)
RETURNS TABLE(
  applied           boolean,
  already_processed boolean,
  recovered         boolean,
  rake_record_id    uuid,
  club_net_credit   numeric,
  spendable_route   text,
  spendable_amount  numeric,
  union_id_out      uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_union_id     uuid;
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
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,
                        NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  -- Sanitize: anything that is not explicitly weighted is legacy equal-dealt.
  v_method := CASE WHEN p_rake_method = 'WEIGHTED_CONTRIBUTED'
                   THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END;

  v_net := p_rake - v_bbj;

  SELECT c.union_id, c.name INTO v_union_id, v_club_name
    FROM public.clubs c WHERE c.id = p_club_id;

  -- ── (b) MASTER GATE + durable audit: one rake_records row per hand ─────────
  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source,
    metadata, rake_method, returned_uncalled
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number),
    v_method, p_returned_uncalled
  )
  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_rr_id;

  IF v_rr_id IS NOT NULL THEN
    v_first_claim := true;
  ELSE
    -- Already have a rake_records row for this hand: re-drive missing legs only.
    SELECT id INTO v_rr_id FROM public.rake_records
      WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
  END IF;

  -- ── (e) PER-PLAYER RAKE LEDGER (weighted contributed rake law) ─────────────
  -- Idempotent twice over: only on the first claim of the hand, and gated by
  -- uq_rake_attributions_hand_player. BBJ attribution uses the SAME weights —
  -- it is an accounting attribution only and never affects BBJ eligibility,
  -- payouts or the jackpot banking path (bbj_record_contribution is untouched).
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
           v_rr_id, p_table_id, p_club_id,
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

    -- Invariant 4/9: Σ credited == rake collected. By construction this cannot
    -- fail; if it ever does, make it LOUD (durable alert) — never block the
    -- hand's financial settlement.
    SELECT COALESCE(SUM(a.credit), 0) INTO v_alloc_sum
      FROM public.fn_allocate_rake_credits(p_rake, p_contributions, v_method) a;
    IF v_alloc_sum <> round(p_rake, 2) AND v_alloc_sum <> 0 THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('critical', 'atomic_distribute_rake', 'RAKE_ALLOCATION_MISMATCH',
        jsonb_build_object('hand_id', p_hand_id, 'rake', p_rake,
          'allocated', v_alloc_sum, 'method', v_method));
    END IF;
  END IF;

  -- Per-leg claim key. For a null hand_id (legacy tournament-fee shape) there is
  -- nothing to de-dupe on, so synthesize a fresh key => behaves like first claim
  -- (matches legacy non-idempotent behaviour; the cash engine always passes a hand_id).
  v_leg_key := COALESCE(p_hand_id, gen_random_uuid());

  -- ── (c) club_wallets accumulator (inline credit_club_wallet_rake) ──────────
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
           chip_balance              = chip_balance + v_net,
           updated_at                = NOW()
     WHERE club_id = p_club_id
     RETURNING chip_balance INTO v_cw_after;

    IF v_cw_after IS NULL THEN
      INSERT INTO public.club_wallets (
        club_id, chip_balance, period_rake_collected, period_bbj_contribution,
        lifetime_rake_collected, lifetime_bbj_contribution
      ) VALUES (
        p_club_id, v_net, p_rake, v_bbj, p_rake, v_bbj
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

  -- ── (d) spendable-rake route ───────────────────────────────────────────────
  IF v_union_id IS NOT NULL THEN
    v_route := 'union_rake_wallet';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'union_rake', p_club_id, v_union_id, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      -- Inline increment_union_wallet: union holds 100% of cash rake until the
      -- weekly settlement returns 90% to clubs (union nets 10%). Unchanged model.
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
           VALUES (v_union_id, p_rake, p_rake, p_rake)
      ON CONFLICT (union_id) DO UPDATE SET
           chip_balance         = public.union_wallets.chip_balance + p_rake,
           rake_wallet          = public.union_wallets.rake_wallet + p_rake,
           total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_rake,
           updated_at           = NOW()
      RETURNING rake_wallet INTO v_union_rake;

      -- Atomic audit row: balance_after computed IN-TX (no separate read/race).
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
      -- Inline increment_club_chip_pool: standalone club's operational bank.
      UPDATE public.clubs
         SET chip_treasury = COALESCE(chip_treasury, 0) + p_rake,
             total_rake    = COALESCE(total_rake, 0) + p_rake,
             updated_at    = NOW()
       WHERE id = p_club_id;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      v_net, v_route, p_rake, v_union_id;
END;
$function$;

ALTER FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid, jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid, jsonb, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid, jsonb, text) TO postgres, service_role;

-- ── 4. fn_rakeback_recompute_periods: per-row method-aware attribution ───────
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(
  p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_written integer := 0;
BEGIN
  IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('written', 0, 'error', 'missing params');
  END IF;

  -- WEIGHTED CONTRIBUTED RAKE (2026-08-29): each record is attributed under
  -- the methodology it was settled with (rake_method), via the single
  -- canonical allocator. Historical DEALT_EQUAL rows reproduce their
  -- historical equal split; new rows are contribution-weighted.
  WITH shares AS (
    SELECT a.user_id,
           round(a.credit * 100)::bigint AS cents
      FROM rake_records r
      CROSS JOIN LATERAL public.fn_allocate_rake_credits(
        r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
      ) a
     WHERE r.club_id = p_club_id
       AND r.created_at >= p_period_start::timestamptz
       AND r.created_at <  (p_period_end + 1)::timestamptz
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
  ), totals AS (
    SELECT s.user_id, (SUM(s.cents)::numeric / 100) AS total_rake
      FROM shares s
     WHERE p_user_ids IS NULL OR s.user_id = ANY (p_user_ids)
     GROUP BY s.user_id
  ), eligible AS (
    SELECT t.user_id, t.total_rake,
           -- UNION LAW: the agent deal decides the rate, not a fixed ladder.
           public.fn_player_rakeback_rate(t.user_id, p_club_id, t.total_rake) AS rate
      FROM totals t
    -- No cross-club exclusion: a player earns in every club they rake in.
  ), ins AS (
    INSERT INTO rakeback_periods (
      user_id, club_id, period_start, period_end,
      rake_generated, rakeback_rate, rakeback_earned, rakeback_amount,
      total_rake_paid, status
    )
    SELECT e.user_id, p_club_id, p_period_start, p_period_end,
           round(e.total_rake, 2), e.rate,
           round(e.total_rake * e.rate, 2), round(e.total_rake * e.rate, 2),
           round(e.total_rake, 2), 'pending'
      FROM eligible e
     WHERE e.rate > 0
    ON CONFLICT (user_id, club_id, period_start, period_end) DO UPDATE
      SET period_end      = EXCLUDED.period_end,
          rake_generated  = EXCLUDED.rake_generated,
          rakeback_rate   = EXCLUDED.rakeback_rate,
          rakeback_earned = EXCLUDED.rakeback_earned,
          rakeback_amount = EXCLUDED.rakeback_amount,
          total_rake_paid = EXCLUDED.total_rake_paid
      WHERE rakeback_periods.status = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  RETURN jsonb_build_object('written', v_written);
END $function$;

-- ── 5. fn_close_settlement_period: method-aware rake basis ───────────────────
-- Was hard equal-share over jsonb_object_keys (counting even zero-contribution
-- players — an outlier no other consumer shared). Now the same canonical
-- allocator as everything else, per-row rake_method.
CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_period         record;
  v_rake_total     numeric;
  v_rate           numeric;
  v_payout         numeric;
  v_payout_id      uuid;
  v_wallet_balance numeric;
  v_debit          jsonb;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- WEIGHTED CONTRIBUTED RAKE (2026-08-29): per-record methodology.
  SELECT COALESCE(SUM(a.credit), 0)
    INTO v_rake_total
    FROM public.rake_records r
    CROSS JOIN LATERAL public.fn_allocate_rake_credits(
      r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
    ) a
   WHERE r.club_id = v_period.club_id
     AND r.created_at >= v_period.period_start::timestamptz
     AND r.created_at <  (v_period.period_end + 1)::timestamptz
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND (r.player_contributions ? v_period.user_id::text)
     AND a.user_id = v_period.user_id;

  v_rake_total := ROUND(v_rake_total, 2);

  v_rate := CASE
    WHEN v_rake_total >= 10000 THEN 0.30
    WHEN v_rake_total >=  2000 THEN 0.20
    WHEN v_rake_total >=   500 THEN 0.15
    WHEN v_rake_total >=   100 THEN 0.10
    ELSE                            0.05
  END;
  v_payout := ROUND(v_rake_total * v_rate, 4);

  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_rate   = v_rate,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0);
  END IF;

  -- Idempotency claim.
  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_rate * 100, 2), v_payout, 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'payout_exists', 'period_id', p_period_id);
  END IF;

  -- DOUBLE-ENTRY: the club's operational bank funds the payout.
  v_debit := public.fn_debit_treasury(
    v_period.club_id, v_payout,
    'Player rakeback ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    jsonb_build_object('period_id', p_period_id, 'user_id', v_period.user_id,
                       'rake_basis', v_rake_total, 'rate', v_rate));
  IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
    -- Release the claim; period stays pending and retries after the union's
    -- weekly 90% replenishes the treasury.
    DELETE FROM public.rakeback_period_payouts WHERE id = v_payout_id;
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_close_settlement_period',
      'Player rakeback deferred: club treasury cannot fund payout',
      jsonb_build_object('period_id', p_period_id, 'club_id', v_period.club_id,
        'user_id', v_period.user_id, 'payout', v_payout, 'debit_result', v_debit));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_club_treasury',
      'period_id', p_period_id, 'payout', v_payout, 'debit_result', v_debit);
  END IF;

  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id
  );

  SELECT balance INTO v_wallet_balance FROM public.wallets
   WHERE user_id = v_period.user_id AND wallet_type = 'PLAYER';
  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_wallet_balance);

  UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'funded_from', 'club_chip_treasury');
END;
$function$;

-- ── 6. fn_club_rake_rollup_day: method-aware daily rollup ────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_day(p_club_id uuid, p_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := p_day::timestamptz;
  v_end   timestamptz := (p_day + 1)::timestamptz;
  v_rows  integer := 0;
BEGIN
  IF v_end > date_trunc('day', now()) THEN
    RAISE EXCEPTION 'club rake rollup: day % is not complete', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('club_rake_rollup:' || p_club_id::text || ':' || p_day::text, 42));

  DELETE FROM club_rake_daily_user WHERE club_id = p_club_id AND day = p_day;

  -- WEIGHTED CONTRIBUTED RAKE (2026-08-29): per-record methodology via the
  -- canonical allocator (was: unconditional equal split).
  WITH split AS (
    SELECT a.user_id, round(a.credit * 100)::bigint AS cents
      FROM rake_records r
      CROSS JOIN LATERAL public.fn_allocate_rake_credits(
        r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
      ) a
     WHERE r.club_id = p_club_id
       AND r.created_at >= v_start AND r.created_at < v_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ), ins AS (
    INSERT INTO club_rake_daily_user (club_id, day, user_id, rake_amount, hands)
    SELECT p_club_id, p_day, s.user_id, SUM(s.cents)::numeric / 100, count(*)
      FROM split s GROUP BY s.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;

  -- A day with zero rake is still a COMPLETE day. Recording that is the whole
  -- point: it is what stops the reader treating "no rake" as "not computed".
  INSERT INTO club_rake_rollup_complete (club_id, day, rows_written, computed_at)
  VALUES (p_club_id, p_day, v_rows, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written, computed_at = EXCLUDED.computed_at;

  RETURN v_rows;
END $function$;

-- ── 7. fn_agent_downline_rake: method-aware edge split ───────────────────────
CREATE OR REPLACE FUNCTION public.fn_agent_downline_rake(p_agent_user_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 500)
 RETURNS TABLE(player_id uuid, username text, club_id uuid, club_name text, role text, depth integer, upline_user_id uuid, upline_name text, rake_generated numeric, hands bigint, last_hand_at timestamp with time zone, downline_players integer, downline_rake numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, date_trunc('week', now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_caller uuid := auth.uid();
  v_today  timestamptz := date_trunc('day', now());
  v_day_lo date;
  v_day_hi date;
  v_head_end   timestamptz;
  v_tail_start timestamptz;
BEGIN
  IF v_root IS NULL THEN RAISE EXCEPTION 'no_agent'; END IF;

  IF NOT EXISTS (SELECT 1 FROM agents a
                  WHERE a.user_id = v_root AND a.status='active'
                    AND a.role IN ('super_agent','agent','sub_agent')
                    AND (p_club_id IS NULL OR a.club_id = p_club_id)) THEN
    RAISE EXCEPTION 'not_an_agent';
  END IF;

  IF v_caller IS NOT NULL
     AND v_caller <> v_root
     AND NOT public.fn_is_agent_ancestor(v_caller, v_root, p_club_id)
     AND NOT EXISTS (
       SELECT 1 FROM union_clubs uc
        WHERE (p_club_id IS NULL OR uc.club_id = p_club_id)
          AND public.fn_is_union_overseer(uc.union_id, v_caller))
  THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  v_day_lo := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN v_day_lo := v_day_lo + 1; END IF;
  v_day_hi := LEAST(date_trunc('day', v_to), v_today)::date;
  IF v_day_hi < v_day_lo THEN v_day_hi := v_day_lo; END IF;

  v_head_end   := LEAST(v_day_lo::timestamptz, v_to);
  v_tail_start := GREATEST(v_day_hi::timestamptz, v_from);

  RETURN QUERY
  WITH RECURSIVE chain AS (
    SELECT a.id, a.user_id, a.club_id, a.role, a.parent_agent_id, 0 AS depth
      FROM agents a
     WHERE a.user_id = v_root AND a.status = 'active'
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
    UNION ALL
    SELECT c.id, c.user_id, c.club_id, c.role, c.parent_agent_id, ch.depth + 1
      FROM agents c JOIN chain ch ON c.parent_agent_id = ch.id
     WHERE c.status = 'active'
  ),
  roster AS (
    SELECT DISTINCT cm.user_id AS player_id, cm.club_id, cm.agent_id AS upline_user_id,
           ch.depth + 1 AS depth
      FROM club_members cm
      JOIN chain ch ON ch.user_id = cm.agent_id AND ch.club_id = cm.club_id
     WHERE cm.agent_id IS NOT NULL
  ),
  everyone AS MATERIALIZED (
    SELECT player_id, club_id, upline_user_id, depth FROM roster
    UNION
    SELECT ch.user_id, ch.club_id,
           (SELECT p.user_id FROM agents p WHERE p.id = ch.parent_agent_id),
           ch.depth
      FROM chain ch WHERE ch.depth > 0
  ),
  in_scope_clubs AS MATERIALIZED (SELECT DISTINCT club_id FROM everyone),
  ok_days AS MATERIALIZED (
    SELECT rc.club_id, rc.day
      FROM club_rake_rollup_complete rc
      JOIN in_scope_clubs c ON c.club_id = rc.club_id
     WHERE rc.day >= v_day_lo AND rc.day < v_day_hi
  ),
  -- Normally empty. Each row becomes one bounded index scan below.
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM in_scope_clubs c
      CROSS JOIN generate_series(v_day_lo, v_day_hi - 1, interval '1 day') g
     WHERE v_day_hi > v_day_lo
       AND NOT EXISTS (SELECT 1 FROM ok_days o
                        WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  from_rollup AS (
    SELECT rd.user_id, rd.club_id,
           SUM(rd.rake_amount) AS rake,
           SUM(rd.hands)::bigint AS hands,
           MAX((rd.day + 1)::timestamptz) AS last_at
      FROM club_rake_daily_user rd
      JOIN ok_days o  ON o.club_id = rd.club_id AND o.day = rd.day
      JOIN everyone e ON e.player_id = rd.user_id AND e.club_id = rd.club_id
     GROUP BY rd.user_id, rd.club_id
  ),
  edge_hands AS MATERIALIZED (
    -- partial first day
    SELECT r.id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE r.created_at >= v_from AND r.created_at < v_head_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    -- today / partial last day
    SELECT r.id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE r.created_at >= v_tail_start AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    -- whole days the rollup cannot vouch for, one indexed range each
    SELECT r.id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM gap_days gd
      JOIN rake_records r
        ON r.club_id = gd.club_id
       AND r.created_at >= gd.day::timestamptz
       AND r.created_at <  (gd.day + 1)::timestamptz
     WHERE r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ),
  -- WEIGHTED CONTRIBUTED RAKE (2026-08-29): per-record methodology via the
  -- canonical allocator (was: unconditional equal split).
  edge_split AS MATERIALIZED (
    SELECT a.user_id, eh.club_id, eh.created_at,
           round(a.credit * 100)::bigint AS cents
      FROM edge_hands eh
      CROSS JOIN LATERAL public.fn_allocate_rake_credits(
        eh.rake_amount, eh.player_contributions, COALESCE(eh.rake_method, 'DEALT_EQUAL')
      ) a
  ),
  from_live AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM edge_split s
      JOIN everyone e ON e.player_id = s.user_id AND e.club_id = s.club_id
     GROUP BY s.user_id, s.club_id
  ),
  earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id, b.user_id) AS user_id,
           COALESCE(a.club_id, b.club_id) AS club_id,
           COALESCE(a.rake,0) + COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0) + COALESCE(b.hands,0) AS hands,
           GREATEST(COALESCE(a.last_at,'-infinity'::timestamptz),
                    COALESCE(b.last_at,'-infinity'::timestamptz)) AS last_at
      FROM from_rollup a
      FULL OUTER JOIN from_live b ON b.user_id = a.user_id AND b.club_id = a.club_id
  ),
  downline_agg AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, SUM(ea.rake) AS rake
      FROM earned ea
      JOIN club_members cm ON cm.user_id = ea.user_id AND cm.club_id = ea.club_id
     WHERE cm.agent_id IS NOT NULL
     GROUP BY cm.agent_id, cm.club_id
  ),
  downline_cnt AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, count(*)::int AS players
      FROM club_members cm
     WHERE cm.agent_id IN (SELECT player_id FROM everyone)
     GROUP BY cm.agent_id, cm.club_id
  )
  SELECT e.player_id,
         COALESCE(pr.display_name, pr.username, left(e.player_id::text, 8)),
         e.club_id, cl.name,
         COALESCE(ag.role, 'player'),
         e.depth, e.upline_user_id,
         COALESCE(up.display_name, up.username),
         COALESCE(ea.rake, 0), COALESCE(ea.hands, 0),
         NULLIF(ea.last_at, '-infinity'::timestamptz),
         COALESCE(dc.players, 0), COALESCE(da.rake, 0)
    FROM everyone e
    LEFT JOIN earned ea       ON ea.user_id = e.player_id AND ea.club_id = e.club_id
    LEFT JOIN downline_agg da ON da.upline  = e.player_id AND da.club_id = e.club_id
    LEFT JOIN downline_cnt dc ON dc.upline  = e.player_id AND dc.club_id = e.club_id
    LEFT JOIN profiles pr ON pr.id = e.player_id
    LEFT JOIN profiles up ON up.id = e.upline_user_id
    LEFT JOIN clubs cl    ON cl.id = e.club_id
    LEFT JOIN agents ag   ON ag.user_id = e.player_id AND ag.club_id = e.club_id
                         AND ag.status = 'active'
   WHERE (p_search IS NULL OR p_search = ''
          OR COALESCE(pr.display_name, pr.username, '') ILIKE '%' || p_search || '%')
   ORDER BY COALESCE(ea.rake, 0) DESC
   LIMIT GREATEST(COALESCE(p_limit, 500), 1);
END $function$;

-- ── 8. fn_bbj_rollup_day: BBJ per-player attribution follows contribution ────
-- Dan 2026-08-29: track how much each player contributed to the BBJ. The three
-- banks (main / backup / promo) are each allocated with the SAME canonical
-- allocator under the hand's rake_method, so weighted hands attribute BBJ by
-- eligible contribution. Accounting attribution ONLY — BBJ eligibility,
-- payouts and pool banking are untouched.
CREATE OR REPLACE FUNCTION public.fn_bbj_rollup_day(p_club_id uuid, p_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_start timestamptz := p_day::timestamptz;
  v_end   timestamptz := (p_day + 1)::timestamptz;
  v_rows  integer := 0;
BEGIN
  -- A day still in progress would be rewritten by the next run with a
  -- different answer. Same guard, same reason, as the rake rollup.
  IF v_end > date_trunc('day', now()) THEN
    RAISE EXCEPTION 'bbj rollup: day % is not complete', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('bbj_rollup:' || p_club_id::text || ':' || p_day::text, 42));

  DELETE FROM bbj_daily_user WHERE club_id = p_club_id AND day = p_day;

  WITH src AS (
    SELECT b.id,
           b.main_portion   AS m,
           b.backup_portion AS bk,
           b.promo_portion  AS pr,
           r.player_contributions AS contribs,
           COALESCE(r.rake_method, 'DEALT_EQUAL') AS method
      FROM bbj_contributions b
      JOIN rake_records r ON r.hand_id = b.hand_id
     WHERE b.club_id = p_club_id
       AND b.created_at >= v_start AND b.created_at < v_end
       AND b.amount > 0
       AND r.player_contributions IS NOT NULL
  ), split AS (
    SELECT am.user_id,
           round(am.credit * 100)::bigint AS m_cents,
           COALESCE(round(ab.credit * 100)::bigint, 0) AS bk_cents,
           COALESCE(round(ap.credit * 100)::bigint, 0) AS pr_cents
      FROM src s
      CROSS JOIN LATERAL public.fn_allocate_rake_credits(COALESCE(s.m, 0),  s.contribs, s.method) am
      LEFT JOIN LATERAL public.fn_allocate_rake_credits(COALESCE(s.bk, 0), s.contribs, s.method) ab
        ON ab.user_id = am.user_id
      LEFT JOIN LATERAL public.fn_allocate_rake_credits(COALESCE(s.pr, 0), s.contribs, s.method) ap
        ON ap.user_id = am.user_id
  ), ins AS (
    INSERT INTO bbj_daily_user
      (club_id, day, user_id, bbj_amount, main_amount, backup_amount, promo_amount, hands)
    SELECT p_club_id, p_day, sp.user_id,
           SUM(sp.m_cents + sp.bk_cents + sp.pr_cents)::numeric / 100,
           SUM(sp.m_cents)::numeric  / 100,
           SUM(sp.bk_cents)::numeric / 100,
           SUM(sp.pr_cents)::numeric / 100,
           count(*)
      FROM split sp GROUP BY sp.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;

  RETURN v_rows;
END;
$function$;

-- ── 9. Cash VIP points now accrue on WEIGHTED RAKE CREDIT ────────────────────
-- The old trigger awarded floor(player_contributions value) — i.e. 1 point per
-- CHIP WAGERED — while claiming "1 pt per rake chip". Under the weighted rake
-- law, VIP points from cash rake follow the player's weighted rake credit
-- (matching fn_settle_tournament_rake, which already awards on attributed
-- rake). DEALT_EQUAL rows (historical + pre-deploy engine) keep the legacy
-- wagered-chip behaviour so the boundary is exact and nothing is re-scored.
CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE k text; v text; pts bigint; uid uuid; rec record;
BEGIN
  IF NEW.player_contributions IS NULL OR jsonb_typeof(NEW.player_contributions) <> 'object' THEN
    RETURN NEW;
  END IF;

  IF NEW.rake_method = 'WEIGHTED_CONTRIBUTED' THEN
    -- 1 VIP point per whole chip of WEIGHTED RAKE CREDIT.
    FOR rec IN
      SELECT a.user_id AS uid, floor(a.credit)::bigint AS pts
        FROM public.fn_allocate_rake_credits(NEW.rake_amount, NEW.player_contributions, 'WEIGHTED_CONTRIBUTED') a
    LOOP
      IF rec.pts > 0 THEN
        INSERT INTO vip_points_ledger (user_id, points, reason, source_type, source_id)
        VALUES (rec.uid, rec.pts, 'Rake generated', 'rake', NEW.id)
        ON CONFLICT (user_id, source_type, source_id) DO NOTHING;
        IF FOUND THEN
          INSERT INTO vip_points (user_id, current_points, lifetime_points)
          VALUES (rec.uid, rec.pts, rec.pts)
          ON CONFLICT (user_id) DO UPDATE SET
            current_points  = vip_points.current_points + rec.pts,
            lifetime_points = vip_points.lifetime_points + rec.pts,
            updated_at = now();
        END IF;
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  -- Legacy path (DEALT_EQUAL rows): unchanged wagered-chip accrual.
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.player_contributions) LOOP
    BEGIN uid := k::uuid; EXCEPTION WHEN others THEN CONTINUE; END;
    BEGIN
      pts := floor(COALESCE(v::numeric, 0))::bigint;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
    IF pts > 0 THEN
      INSERT INTO vip_points_ledger (user_id, points, reason, source_type, source_id)
      VALUES (uid, pts, 'Rake generated', 'rake', NEW.id)
      ON CONFLICT (user_id, source_type, source_id) DO NOTHING;
      IF FOUND THEN
        INSERT INTO vip_points (user_id, current_points, lifetime_points)
        VALUES (uid, pts, pts)
        ON CONFLICT (user_id) DO UPDATE SET
          current_points  = vip_points.current_points + pts,
          lifetime_points = vip_points.lifetime_points + pts,
          updated_at = now();
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END; $function$;

-- ── 10. Admin drill-down: full reconciliation object for one hand ────────────
CREATE OR REPLACE FUNCTION public.fn_hand_rake_breakdown(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rr record;
  v_players jsonb;
  v_allocated numeric;
BEGIN
  SELECT * INTO v_rr FROM public.rake_records WHERE hand_id = p_hand_id
   ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'player_id', ra.player_id,
           'gross_contribution', ra.gross_contribution,
           'returned_uncalled', ra.returned_uncalled,
           'eligible_contribution', ra.eligible_contribution,
           'contribution_weight', ra.contribution_weight,
           'weighted_rake_credit', ra.weighted_rake_credit,
           'bbj_attributed_contribution', ra.bbj_attributed_contribution
         ) ORDER BY ra.weighted_rake_credit DESC), '[]'::jsonb),
         COALESCE(SUM(ra.weighted_rake_credit), 0)
    INTO v_players, v_allocated
    FROM public.rake_attributions ra WHERE ra.hand_id = p_hand_id;

  RETURN jsonb_build_object(
    'found', true,
    'hand_id', p_hand_id,
    'rake_method', v_rr.rake_method,
    'gross_pot', v_rr.pot_size,
    'regular_rake_collected', v_rr.rake_amount,
    'bbj_drop_collected', v_rr.bbj_contribution,
    'net_pot_paid_to_players',
      CASE WHEN v_rr.pot_size IS NULL THEN NULL
           ELSE v_rr.pot_size - v_rr.rake_amount - COALESCE(v_rr.bbj_contribution, 0) END,
    'total_eligible_contributions', (
      SELECT COALESCE(SUM((e.value)::numeric), 0)
        FROM jsonb_each(COALESCE(v_rr.player_contributions, '{}'::jsonb)) e
       WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::numeric > 0),
    'players', v_players,
    'reconciliation', jsonb_build_object(
      'expected_regular_rake', round(v_rr.rake_amount, 2),
      'allocated_regular_rake', round(v_allocated, 2),
      'difference', round(v_rr.rake_amount - v_allocated, 2),
      'valid', (round(v_allocated, 2) = round(v_rr.rake_amount, 2))
    )
  );
END $function$;

REVOKE EXECUTE ON FUNCTION public.fn_hand_rake_breakdown(uuid) FROM anon;

-- ── 11. Reconciliation watchdog: allocation drift over a window ──────────────
-- Lists WEIGHTED_CONTRIBUTED hands whose per-player ledger does not sum back
-- to the rake collected (missing rows, or a credit mismatch). Consumed by the
-- engine's FeeReconciler audit sweep, which files a financial alert per find.
CREATE OR REPLACE FUNCTION public.fn_rake_attribution_drift(p_hours integer DEFAULT 24)
RETURNS TABLE(hand_id uuid, rake_amount numeric, allocated numeric, difference numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT r.hand_id,
         r.rake_amount,
         COALESCE(SUM(ra.weighted_rake_credit), 0) AS allocated,
         round(r.rake_amount - COALESCE(SUM(ra.weighted_rake_credit), 0), 2) AS difference
    FROM public.rake_records r
    LEFT JOIN public.rake_attributions ra ON ra.hand_id = r.hand_id
   WHERE r.rake_method = 'WEIGHTED_CONTRIBUTED'
     AND r.hand_id IS NOT NULL
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND r.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))
   GROUP BY r.hand_id, r.rake_amount
  HAVING round(r.rake_amount - COALESCE(SUM(ra.weighted_rake_credit), 0), 2) <> 0;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_rake_attribution_drift(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_attribution_drift(integer) TO service_role;

-- ── 12. SELF-TEST: the spec's reference vectors, asserted at apply time ──────
-- These are the worked examples from the migration directive (§35-§38). If the
-- allocator disagrees with any of them, the migration ABORTS.
DO $$
DECLARE
  v jsonb;
  c numeric;
  s numeric;
BEGIN
  -- §35: A=50 B=25 C=15 D=10 E=0 F=0, rake 5 -> 2.50 / 1.25 / 0.75 / 0.50, E/F absent
  v := '{"00000000-0000-0000-0000-00000000000a": 50,
         "00000000-0000-0000-0000-00000000000b": 25,
         "00000000-0000-0000-0000-00000000000c": 15,
         "00000000-0000-0000-0000-00000000000d": 10,
         "00000000-0000-0000-0000-00000000000e": 0,
         "00000000-0000-0000-0000-00000000000f": 0}'::jsonb;
  SELECT credit INTO c FROM public.fn_allocate_rake_credits(5, v, 'WEIGHTED_CONTRIBUTED')
   WHERE user_id = '00000000-0000-0000-0000-00000000000a';
  IF c <> 2.50 THEN RAISE EXCEPTION 'self-test §35 A: got %', c; END IF;
  SELECT credit INTO c FROM public.fn_allocate_rake_credits(5, v, 'WEIGHTED_CONTRIBUTED')
   WHERE user_id = '00000000-0000-0000-0000-00000000000d';
  IF c <> 0.50 THEN RAISE EXCEPTION 'self-test §35 D: got %', c; END IF;
  SELECT count(*) INTO s FROM public.fn_allocate_rake_credits(5, v, 'WEIGHTED_CONTRIBUTED');
  IF s <> 4 THEN RAISE EXCEPTION 'self-test §35: zero contributors must get no rows (got % rows)', s; END IF;
  SELECT SUM(credit) INTO s FROM public.fn_allocate_rake_credits(5, v, 'WEIGHTED_CONTRIBUTED');
  IF s <> 5.00 THEN RAISE EXCEPTION 'self-test §35 sum: got %', s; END IF;

  -- §37: A=40 B=40 (uncalled 60 already excluded upstream), rake 4 -> 2.00 each
  v := '{"00000000-0000-0000-0000-00000000000a": 40,
         "00000000-0000-0000-0000-00000000000b": 40}'::jsonb;
  SELECT credit INTO c FROM public.fn_allocate_rake_credits(4, v, 'WEIGHTED_CONTRIBUTED')
   WHERE user_id = '00000000-0000-0000-0000-00000000000a';
  IF c <> 2.00 THEN RAISE EXCEPTION 'self-test §37 A: got %', c; END IF;

  -- §38: A=25 all-in, B=100, C=100, rake 4 -> 0.44 / 1.78 / 1.78
  v := '{"00000000-0000-0000-0000-00000000000a": 25,
         "00000000-0000-0000-0000-00000000000b": 100,
         "00000000-0000-0000-0000-00000000000c": 100}'::jsonb;
  SELECT credit INTO c FROM public.fn_allocate_rake_credits(4, v, 'WEIGHTED_CONTRIBUTED')
   WHERE user_id = '00000000-0000-0000-0000-00000000000a';
  IF c <> 0.44 THEN RAISE EXCEPTION 'self-test §38 A: got %', c; END IF;
  SELECT SUM(credit) INTO s FROM public.fn_allocate_rake_credits(4, v, 'WEIGHTED_CONTRIBUTED');
  IF s <> 4.00 THEN RAISE EXCEPTION 'self-test §38 sum: got %', s; END IF;

  -- §36: SB=1 BB=20 BTN=20, rake 2 -> reconciles to exactly 2.00
  v := '{"00000000-0000-0000-0000-00000000000a": 1,
         "00000000-0000-0000-0000-00000000000b": 20,
         "00000000-0000-0000-0000-00000000000c": 20}'::jsonb;
  SELECT SUM(credit) INTO s FROM public.fn_allocate_rake_credits(2, v, 'WEIGHTED_CONTRIBUTED');
  IF s <> 2.00 THEN RAISE EXCEPTION 'self-test §36 sum: got %', s; END IF;

  -- Legacy parity: DEALT_EQUAL reproduces the historical equal split exactly
  -- (integer cents, remainder to the first positive contributors by key ASC).
  v := '{"00000000-0000-0000-0000-00000000000a": 50,
         "00000000-0000-0000-0000-00000000000b": 25,
         "00000000-0000-0000-0000-00000000000c": 15}'::jsonb;
  SELECT credit INTO c FROM public.fn_allocate_rake_credits(5, v, 'DEALT_EQUAL')
   WHERE user_id = '00000000-0000-0000-0000-00000000000a';
  IF c <> 1.67 THEN RAISE EXCEPTION 'self-test legacy A: got %', c; END IF;
  SELECT credit INTO c FROM public.fn_allocate_rake_credits(5, v, 'DEALT_EQUAL')
   WHERE user_id = '00000000-0000-0000-0000-00000000000c';
  IF c <> 1.66 THEN RAISE EXCEPTION 'self-test legacy C: got %', c; END IF;
  SELECT SUM(credit) INTO s FROM public.fn_allocate_rake_credits(5, v, 'DEALT_EQUAL');
  IF s <> 5.00 THEN RAISE EXCEPTION 'self-test legacy sum: got %', s; END IF;

  -- Invariant 5: zero rake -> zero credit for everyone.
  SELECT COALESCE(SUM(credit), 0) INTO s FROM public.fn_allocate_rake_credits(0, v, 'WEIGHTED_CONTRIBUTED');
  IF s <> 0 THEN RAISE EXCEPTION 'self-test zero-rake: got %', s; END IF;
END $$;

-- ── 13. Close the re-declared SECURITY DEFINER writers to browser roles ─────
-- (check-definer-authorization). None of these derives an actor from
-- auth.uid() — they are engine/cron surfaces. fn_close_settlement_period is
-- reached by browsers ONLY through fn_claim_rakeback (which derives
-- auth.uid()) and settle_club_rakeback; both are SECURITY DEFINER, so they
-- keep working after direct EXECUTE is revoked. PUBLIC is named alongside the
-- roles deliberately: revoking a role while PUBLIC still holds EXECUTE reads
-- as a fix and does nothing. Mirrored in 20260829b_weighted_rake_definer_grants.sql
-- (the applied production migration for these statements).

REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.fn_close_settlement_period(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_settlement_period(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_day(uuid, date) TO service_role;

REVOKE ALL ON FUNCTION public.fn_bbj_rollup_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_rollup_day(uuid, date) TO service_role;
