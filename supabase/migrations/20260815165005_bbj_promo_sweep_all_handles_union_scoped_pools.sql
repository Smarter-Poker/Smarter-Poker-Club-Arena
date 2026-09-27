-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815165005 "bbj_promo_sweep_all_handles_union_scoped_pools"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 eb1e858cab5f85ff0dd3bc39516653c1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- BBJ promo sweep — handle UNION-SCOPED pools (the overwhelming majority)
-- ═══════════════════════════════════════════════════════════════════════════
-- fn_sweep_bbj_promo(p_club_id) looked pools up by club_id only. Live data:
--   1,005 of 1,007 pools are UNION-scoped (union_id set, club_id NULL) holding
--   26,114.90 promo; only 2 are club-scoped, holding 21,346.50.
-- The engine (server/src/services/supabase/bbj.ts) seeds a pool keyed by
-- union_id when the club belongs to a union, and by club_id otherwise. The
-- club-only lookup therefore missed 99.8% of pools.
--
-- fn_sweep_bbj_promo_all() handles BOTH shapes and is the function to schedule:
--   union-scoped pool -> that union's promo_wallet
--   club-scoped pool  -> the club's union if it has one, else the club wallet
-- Each pool is drained inside its own row lock, and one bad pool cannot abort
-- the whole run.

CREATE OR REPLACE FUNCTION public.fn_sweep_bbj_promo_all()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  r              record;
  v_promo        numeric;
  v_union_id     uuid;
  v_after        numeric;
  v_swept_total  numeric := 0;
  v_pools        int := 0;
  v_to_union     int := 0;
  v_to_club      int := 0;
  v_errors       int := 0;
BEGIN
  FOR r IN
    SELECT id, club_id, union_id
      FROM bbj_pools
     WHERE COALESCE(promo_balance, 0) > 0
     ORDER BY id
  LOOP
    BEGIN
      -- Re-read under a row lock; another sweep may have drained it already.
      SELECT COALESCE(promo_balance, 0) INTO v_promo
        FROM bbj_pools WHERE id = r.id FOR UPDATE;
      IF v_promo <= 0 THEN CONTINUE; END IF;

      -- Resolve the destination union: the pool's own union, or the club's.
      v_union_id := r.union_id;
      IF v_union_id IS NULL AND r.club_id IS NOT NULL THEN
        SELECT union_id INTO v_union_id FROM clubs WHERE id = r.club_id;
      END IF;

      UPDATE bbj_pools SET promo_balance = 0, updated_at = NOW() WHERE id = r.id;

      IF v_union_id IS NOT NULL THEN
        UPDATE unions
           SET promo_wallet          = COALESCE(promo_wallet, 0) + v_promo,
               promo_funded_from_bbj = COALESCE(promo_funded_from_bbj, 0) + v_promo,
               updated_at            = NOW()
         WHERE id = v_union_id
        RETURNING promo_wallet INTO v_after;

        IF v_after IS NULL THEN
          -- Union row missing: put it back rather than vaporise the chips.
          UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
          v_errors := v_errors + 1;
          CONTINUE;
        END IF;

        INSERT INTO union_wallet_transactions
          (id, union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes, created_at)
        VALUES
          (gen_random_uuid(), v_union_id, 'promo_wallet', 'credit', v_promo, v_after,
           'bbj_promo_sweep', r.club_id,
           'BBJ promo slice (25% of contribution) swept from pool', NOW());

        v_to_union := v_to_union + 1;

      ELSIF r.club_id IS NOT NULL THEN
        UPDATE clubs
           SET promo_balance = COALESCE(promo_balance, 0) + v_promo, updated_at = NOW()
         WHERE id = r.club_id
        RETURNING promo_balance INTO v_after;

        IF v_after IS NULL THEN
          UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
          v_errors := v_errors + 1;
          CONTINUE;
        END IF;

        INSERT INTO chip_transactions (
          id, club_id, from_user_id, to_user_id, amount,
          transaction_type, notes, balance_after, created_at
        ) VALUES (
          gen_random_uuid(), r.club_id, NULL, NULL, v_promo,
          'bbj_promo_sweep',
          'BBJ promo slice swept to club promo wallet (club has no union)',
          v_after, NOW()
        );

        v_to_club := v_to_club + 1;
      ELSE
        -- Orphan pool with neither owner: leave the money where it is.
        UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
        v_errors := v_errors + 1;
        CONTINUE;
      END IF;

      v_swept_total := v_swept_total + v_promo;
      v_pools := v_pools + 1;

    EXCEPTION WHEN OTHERS THEN
      -- One bad pool must never abort the whole sweep.
      v_errors := v_errors + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'pools_swept', v_pools,
    'total_swept', v_swept_total,
    'to_union', v_to_union,
    'to_club', v_to_club,
    'errors', v_errors
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_sweep_bbj_promo_all() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_sweep_bbj_promo_all() TO service_role;

COMMENT ON FUNCTION public.fn_sweep_bbj_promo_all() IS
  'Sweeps the BBJ promo slice from every pool to its union promo wallet (or the club wallet for unionless clubs). Schedule this; it is idempotent - a second run with nothing accrued sweeps 0.';
