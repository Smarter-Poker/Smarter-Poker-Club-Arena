-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819210653 "bbj_retire_unsafe_rpcs_sweep_audit_parity_and_conservation_baseline"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8723b99e85c6402925ab4deca44bfe76 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- AUDIT PASS 3 (2026-08-19) — BBJ integrity hardening. Findings #10-#12.
-- Parameter names AND defaults preserved exactly per overload (Postgres
-- refuses CREATE OR REPLACE that renames a parameter or drops its default).

-- ─── 1. Retire add_bbj_contribution (all three overloads) ──────────────────
-- LIVE SECURITY HOLE: the 9-arg bigint overload was granted to `authenticated`
-- and takes CALLER-SUPPLIED main/backup/promo portions, writes them straight
-- into bbj_pools, writes NO bbj_contributions ledger row, has NO idempotency,
-- ignores the 100k pivot, and touches the dead pool_amount column. Any logged-in
-- user could inflate the promo bank, which the sweep moves to the union promo
-- wallet and promo rain pays out. Both code callers are DEAD (Club Arena
-- BBJService.recordContribution has no callers; World Hub LobbyManager.js is
-- not referenced by any page/route). bbj_record_contribution is the sole path.

CREATE OR REPLACE FUNCTION public.add_bbj_contribution(
  p_table_id uuid, p_club_id uuid, p_amount numeric, p_big_blind numeric,
  p_hand_number integer, p_stakes_tier text, p_main_portion numeric,
  p_backup_portion numeric, p_promo_portion numeric
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'add_bbj_contribution retired 2026-08-19 (audit pass 3): no ledger row, no idempotency, caller-supplied splits. Use bbj_record_contribution.';
END $$;

CREATE OR REPLACE FUNCTION public.add_bbj_contribution(
  p_club_id uuid, p_table_id uuid, p_hand_number bigint, p_amount numeric,
  p_big_blind numeric, p_stakes_tier text, p_main_portion numeric DEFAULT NULL::numeric,
  p_backup_portion numeric DEFAULT NULL::numeric, p_promo_portion numeric DEFAULT NULL::numeric
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'add_bbj_contribution retired 2026-08-19 (audit pass 3). Use bbj_record_contribution.';
END $$;

CREATE OR REPLACE FUNCTION public.add_bbj_contribution(
  p_club_id uuid, p_table_id uuid, p_hand_number bigint, p_amount numeric,
  p_big_blind numeric, p_stakes_tier text
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'add_bbj_contribution retired 2026-08-19 (audit pass 3). Use bbj_record_contribution.';
END $$;

REVOKE ALL ON FUNCTION public.add_bbj_contribution(uuid,uuid,numeric,numeric,integer,text,numeric,numeric,numeric) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_bbj_contribution(uuid,uuid,bigint,numeric,numeric,text,numeric,numeric,numeric) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_bbj_contribution(uuid,uuid,bigint,numeric,numeric,text) FROM public, anon, authenticated;

-- get_union_bbj_status returned hardcoded {balance: 0, active: false} to every
-- authenticated caller — a lie that reads as "no jackpot". Return the truth.
CREATE OR REPLACE FUNCTION public.get_union_bbj_status(p_union_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $$
DECLARE v_p record;
BEGIN
  SELECT main_balance, backup_balance, promo_balance, status, hands_contributed
    INTO v_p FROM bbj_pools
   WHERE union_id = p_union_id AND status = 'active' LIMIT 1;
  IF v_p IS NULL THEN
    RETURN jsonb_build_object('balance', 0, 'active', false, 'note', 'no active union pool');
  END IF;
  RETURN jsonb_build_object(
    'balance', round(v_p.main_balance, 2), 'active', true,
    'main_balance', round(v_p.main_balance, 2),
    'backup_balance', round(v_p.backup_balance, 2),
    'promo_balance', round(v_p.promo_balance, 2),
    'hands_contributed', v_p.hands_contributed);
END $$;

-- ─── 2. Sweep audit parity (union destination) ─────────────────────────────
-- fn_sweep_bbj_promo (single-club) wrote NO union_wallet_transactions row when
-- the destination was a union — only fn_sweep_bbj_promo_all did. Union sweeps
-- through that path moved money with no ledger entry anywhere.
CREATE OR REPLACE FUNCTION public.fn_sweep_bbj_promo(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_promo numeric; v_pool_id uuid; v_union_id uuid; v_dest text; v_after numeric;
BEGIN
  SELECT c.union_id INTO v_union_id FROM clubs c WHERE c.id = p_club_id;

  SELECT bp.id, COALESCE(bp.promo_balance, 0) INTO v_pool_id, v_promo
    FROM bbj_pools bp
   WHERE bp.status = 'active'
     AND ((v_union_id IS NOT NULL AND bp.union_id = v_union_id)
       OR (v_union_id IS NULL AND bp.club_id = p_club_id))
   ORDER BY (bp.union_id IS NOT NULL) DESC
   LIMIT 1
   FOR UPDATE;

  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no bbj pool for club');
  END IF;
  IF v_promo <= 0 THEN
    RETURN jsonb_build_object('success', true, 'swept', 0, 'note', 'nothing to sweep');
  END IF;

  UPDATE bbj_pools SET promo_balance = 0, updated_at = NOW() WHERE id = v_pool_id;

  IF v_union_id IS NOT NULL THEN
    INSERT INTO union_wallets (union_id, promo_wallet)
    VALUES (v_union_id, v_promo)
    ON CONFLICT (union_id) DO UPDATE
      SET promo_wallet = COALESCE(union_wallets.promo_wallet, 0) + EXCLUDED.promo_wallet
    RETURNING promo_wallet INTO v_after;

    IF v_after IS NULL THEN
      UPDATE bbj_pools SET promo_balance = v_promo WHERE id = v_pool_id;
      RETURN jsonb_build_object('success', false, 'error', 'union wallet credit failed');
    END IF;

    UPDATE unions
       SET promo_funded_from_bbj = COALESCE(promo_funded_from_bbj, 0) + v_promo,
           updated_at = NOW()
     WHERE id = v_union_id;

    INSERT INTO union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes)
    VALUES
      (v_union_id, p_club_id, 'promo_wallet', 'credit', v_promo, v_after,
       'bbj_promo_sweep', 'BBJ promo slice swept from pool (single-club sweep)');

    v_dest := 'union';
  ELSE
    UPDATE clubs
       SET promo_balance = COALESCE(promo_balance, 0) + v_promo, updated_at = NOW()
     WHERE id = p_club_id
    RETURNING promo_balance INTO v_after;
    v_dest := 'club';

    INSERT INTO chip_transactions (
      id, club_id, from_user_id, to_user_id, amount,
      transaction_type, notes, balance_after, created_at
    ) VALUES (
      gen_random_uuid(), p_club_id, NULL, NULL, v_promo,
      'bbj_promo_sweep',
      'BBJ promo slice swept to club promo wallet (club has no union)',
      v_after, NOW()
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'swept', v_promo,
                            'destination', v_dest, 'balance_after', v_after);
END $$;

-- ─── 3. Pool lineage + conservation baseline (data, not a constant) ────────
ALTER TABLE public.bbj_pools ADD COLUMN IF NOT EXISTS merged_into_pool_id uuid;
COMMENT ON COLUMN public.bbj_pools.merged_into_pool_id IS
  'Set when a pool was merged into another (2026-08-19: JAQK club pool -> Midway union pool). Lifetime counters moved to the target; this pool''s bbj_contributions rows deliberately keep their original pool_id so history is not rewritten.';

UPDATE public.bbj_pools
   SET merged_into_pool_id = 'f9806a7f-e7a2-47d2-a676-36336e3a5337'
 WHERE id = '0867a7fd-58d9-4768-9919-06532afe79f3'
   AND merged_into_pool_id IS NULL;

CREATE TABLE IF NOT EXISTS public.bbj_conservation_baseline (
  id            integer PRIMARY KEY DEFAULT 1,
  baseline_gap  numeric NOT NULL,
  tolerance     numeric NOT NULL DEFAULT 1.00,
  measured_at   timestamptz NOT NULL DEFAULT now(),
  note          text,
  CONSTRAINT bbj_conservation_baseline_singleton CHECK (id = 1)
);
ALTER TABLE public.bbj_conservation_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bbj_conservation_baseline FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.bbj_conservation_baseline TO service_role;

INSERT INTO public.bbj_conservation_baseline (id, baseline_gap, tolerance, note)
SELECT 1,
       round(
         (SELECT COALESCE(SUM(amount),0) FROM bbj_contributions)
       + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_fund')
       - (SELECT COALESCE(SUM(total_amount),0) FROM bbj_payouts)
       - (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_promo_sweep')
       - (SELECT COALESCE(SUM(amount),0) FROM chip_transactions WHERE transaction_type='bbj_promo_sweep')
       - (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions WHERE category='promotion' AND description='BBJ promo pool payout')
       - (SELECT COALESCE(SUM(main_balance+backup_balance+promo_balance),0) FROM bbj_pools)
       , 2),
       1.00,
       'Frozen historical delta measured 2026-08-19 (audit pass 3): manual promo sweeps predating audit rows (incl. the known one-time 47,607.05) plus pool consolidations. Verified stable to the cent across repeated measurements, with zero orphan pool rows. The selftest alerts on MOVEMENT from this baseline, which is what indicates new loss.'
ON CONFLICT (id) DO NOTHING;
