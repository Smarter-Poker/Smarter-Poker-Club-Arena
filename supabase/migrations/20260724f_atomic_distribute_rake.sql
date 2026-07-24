-- 20260724f_atomic_distribute_rake.sql
-- RAKE-AUDIT 2026-07-24 [money] P0: make Club Arena cash-game RAKE distribution
-- ATOMIC + IDEMPOTENT + RECOVERABLE, mirroring bbj_atomic_payout_v2.
--
-- BEFORE: engine did per-hand, non-atomic, fire-and-forget legs —
--   credit_club_wallet_rake (accumulator) + EITHER increment_union_wallet
--   (+ read-then-insert union_wallet_transactions) OR increment_club_chip_pool,
--   plus a separate fire-and-forget rake_records insert. Any leg failure LOST
--   that rake; a retry/restart DOUBLE-credited (no idempotency).
--
-- AFTER: ONE SECURITY DEFINER transaction:
--   (a) idempotency gate on the hand (partial-unique rake_records.hand_id +
--       per-leg claim ledger rake_distribution_legs) — re-call is a no-op that
--       can RE-DRIVE any missing leg without re-crediting the others;
--   (b) durable rake_records insert (no longer fire-and-forget);
--   (c) club_wallets accumulator credit (inline credit_club_wallet_rake logic);
--   (d) spendable-rake route: club-in-union -> union_wallets.rake_wallet += rake
--       + union_wallet_transactions audit (balance_after computed IN-TX, no
--       separate read); standalone -> clubs.chip_treasury += rake
--       (inline increment_club_chip_pool logic).
--
-- UNION ECONOMIC MODEL PRESERVED: the union still holds 100% of cash rake in
-- rake_wallet and returns 90% to clubs weekly (nets 10%). This RPC does NOT
-- split at collection and does NOT touch the weekly settlement (settle_club_rakeback).

-- ── 1. Per-leg idempotency ledger (mirrors bbj_payout_recipients) ────────────
CREATE TABLE IF NOT EXISTS public.rake_distribution_legs (
  leg_key    uuid NOT NULL,
  leg        text NOT NULL,
  club_id    uuid,
  union_id   uuid,
  amount     numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (leg_key, leg)
);
ALTER TABLE public.rake_distribution_legs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rake_distribution_legs FROM PUBLIC;
GRANT SELECT, INSERT ON public.rake_distribution_legs TO service_role;

-- ── 2. Master idempotency gate: one rake_records row per hand ────────────────
-- No existing duplicates (verified: 0 dup non-null hand_id). Partial so the
-- 3.7k legacy null-hand rows (tournament fees) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rake_records_hand_id
  ON public.rake_records (hand_id) WHERE hand_id IS NOT NULL;

-- ── 3. The atomic distributor ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid);
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(
  p_table_id      uuid,
  p_club_id       uuid,
  p_hand_id       uuid,
  p_hand_number   integer,
  p_rake          numeric,
  p_bbj           numeric DEFAULT 0,
  p_pot           numeric DEFAULT NULL,
  p_num_players   integer DEFAULT NULL,
  p_contributions jsonb   DEFAULT NULL,
  p_tournament_id uuid    DEFAULT NULL
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
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,
                        NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  v_net := p_rake - v_bbj;

  SELECT c.union_id, c.name INTO v_union_id, v_club_name
    FROM public.clubs c WHERE c.id = p_club_id;

  -- ── (b) MASTER GATE + durable audit: one rake_records row per hand ─────────
  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source, metadata
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number)
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

ALTER FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_distribute_rake(uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid) TO postgres, service_role;
