-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260818222446 "bbj_self_heal_unbanked_fees"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f6b5fbeed23ad12da588ee2dd0bb658e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- BBJ SELF-HEAL: recover fees withheld from pots but never banked (2026-08-18)
-- ═══════════════════════════════════════════════════════════════════════════
-- FINDING (live, 2026-08-18): the hourly drift audit reported 2.00 chips of
-- positive drift over 24h. Investigation confirmed it was NOT the known
-- window-boundary artifact: 4 hands of 40,144 had a rake_records row booking
-- a BBJ fee with NO bbj_contributions row. atomic_distribute_rake credits the
-- club wallet only (rake - bbj), deliberately withholding the jackpot slice
-- because bbj_record_contribution is what banks it. So those chips left the
-- pot and ceased to exist.
--
-- WHY THE EXISTING RECOVERY MISSED IT: the engine's recovery path is
-- "logBBJCollection returned false -> queue to pending_fee_distributions".
-- pending_fee_distributions held ZERO rows for these hands (and none at all
-- in 25h), so logBBJCollection never returned false — it was never reached.
-- Two of the four failed 52ms apart on DIFFERENT tables in DIFFERENT clubs,
-- which is the signature of a process-level event (restart/crash) landing
-- between the rake transaction and the banking call, not an RPC error.
--
-- Recovery that lives in the engine process cannot survive the engine process
-- dying. This repairs from DURABLE evidence instead — rake_records, which is
-- written inside the same atomic transaction that withheld the fee — so it
-- works no matter how the engine died.
--
-- IDEMPOTENT BY CONSTRUCTION: the insert carries its own NOT EXISTS guard in
-- the same statement, and the pool balance is only moved for rows that
-- actually inserted (UPDATE ... FROM ins). Running it twice banks nothing
-- twice; running it concurrently cannot double-bank a hand.

CREATE OR REPLACE FUNCTION public.fn_bbj_repair_unbanked(
  p_since_hours integer DEFAULT 48,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  hand_id uuid,
  table_id uuid,
  club_id uuid,
  pool_id uuid,
  amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_pool_id uuid;
  v_main numeric;
  v_backup numeric;
  v_promo numeric;
  v_ratio_main numeric;
  v_ratio_backup numeric;
  v_current_main numeric;
  v_inserted uuid;
BEGIN
  FOR r IN
    SELECT rr.hand_id AS h_id, rr.table_id AS t_id, rr.club_id AS c_id,
           SUM(rr.bbj_contribution) AS amt,
           MAX(COALESCE((rr.metadata->>'big_blind')::numeric, 0)) AS bb
    FROM public.rake_records rr
    WHERE rr.hand_id IS NOT NULL
      AND COALESCE(rr.bbj_contribution, 0) > 0
      AND rr.created_at > now() - make_interval(hours => p_since_hours)
      -- Leave the last 5 minutes alone: the normal banking path may still be
      -- in flight for those hands, and racing it would be the one way this
      -- function could double-bank.
      AND rr.created_at < now() - interval '5 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.bbj_contributions bc WHERE bc.hand_id = rr.hand_id
      )
    GROUP BY rr.hand_id, rr.table_id, rr.club_id
    ORDER BY MIN(rr.created_at)
    LIMIT p_limit
  LOOP
    -- Resolve the pool exactly as the server does: union first, then club.
    SELECT bp.id, bp.main_balance INTO v_pool_id, v_current_main
    FROM public.bbj_pools bp
    WHERE bp.status = 'active'
      AND (
        bp.union_id = (SELECT c.union_id FROM public.clubs c WHERE c.id = r.c_id)
        OR (bp.club_id = r.c_id
            AND (SELECT c.union_id FROM public.clubs c WHERE c.id = r.c_id) IS NULL)
      )
    ORDER BY (bp.union_id IS NOT NULL) DESC
    LIMIT 1;

    CONTINUE WHEN v_pool_id IS NULL;

    -- Same pivot allocation as logBBJCollection (Bible V8 §4.13):
    -- standard 50/25/25, past a 100,000 main balance 30/40/30.
    IF COALESCE(v_current_main, 0) >= 100000 THEN
      v_ratio_main := 0.30; v_ratio_backup := 0.40;
    ELSE
      v_ratio_main := 0.50; v_ratio_backup := 0.25;
    END IF;

    v_main   := ROUND(r.amt * v_ratio_main, 2);
    v_backup := ROUND(r.amt * v_ratio_backup, 2);
    v_promo  := ROUND(r.amt, 2) - v_main - v_backup;

    -- Atomic: insert only if still unbanked, and move the pool ONLY for the
    -- row that actually inserted.
    WITH ins AS (
      INSERT INTO public.bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
      )
      SELECT v_pool_id, r.h_id, r.t_id, r.c_id, r.amt,
             v_main, v_backup, v_promo, NULLIF(r.bb, 0), NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM public.bbj_contributions bc WHERE bc.hand_id = r.h_id
      )
      RETURNING id
    ),
    upd AS (
      UPDATE public.bbj_pools bp
      SET main_balance      = bp.main_balance + v_main,
          backup_balance    = bp.backup_balance + v_backup,
          promo_balance     = bp.promo_balance + v_promo,
          total_contributed = COALESCE(bp.total_contributed, 0) + r.amt,
          hands_contributed = COALESCE(bp.hands_contributed, 0) + 1,
          updated_at        = now()
      FROM ins
      WHERE bp.id = v_pool_id
      RETURNING bp.id
    )
    SELECT ins.id INTO v_inserted FROM ins;

    IF v_inserted IS NOT NULL THEN
      hand_id := r.h_id; table_id := r.t_id; club_id := r.c_id;
      pool_id := v_pool_id; amount := r.amt;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) TO service_role;

COMMENT ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) IS
  'Self-heal: banks BBJ fees that rake_records shows were withheld from pots but that never reached a pool (engine crash between the rake txn and the banking call). Idempotent by construction; skips the last 5 minutes to avoid racing the live path. Service-role only.';
