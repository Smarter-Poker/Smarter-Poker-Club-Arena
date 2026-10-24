-- Dan 2026-10-22, correcting the same night's order: "every other club should
-- stick to the original rules. i only want midway union to operate this way
-- for the time being."
--
-- So the 10 / 30 / 60 split moves off the global policy row and onto the
-- Midway Union pool alone. ca_bbj_policy goes back to its original rule (50 /
-- 25 / 25 below 100,000 in main, 25 / 25 / 50 at or above it) for every other
-- pool, and ca_bbj_pool_policy carries a per-pool override that
-- fn_bbj_allocate reads first. Promo is still always the remainder.

CREATE TABLE IF NOT EXISTS public.ca_bbj_pool_policy (
  pool_id         uuid PRIMARY KEY REFERENCES public.bbj_pools(id) ON DELETE CASCADE,
  standard_main   numeric NOT NULL CHECK (standard_main >= 0 AND standard_main <= 1),
  standard_backup numeric NOT NULL CHECK (standard_backup >= 0 AND standard_backup <= 1),
  pivot_main      numeric NOT NULL CHECK (pivot_main >= 0 AND pivot_main <= 1),
  pivot_backup    numeric NOT NULL CHECK (pivot_backup >= 0 AND pivot_backup <= 1),
  note            text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (standard_main + standard_backup <= 1),
  CHECK (pivot_main + pivot_backup <= 1)
);
ALTER TABLE public.ca_bbj_pool_policy ENABLE ROW LEVEL SECURITY;
-- Changed only by a migration; the service role reads it and nothing else
-- (as applied on production, ALL was granted and 20261023031034 narrowed it).
REVOKE ALL ON TABLE public.ca_bbj_pool_policy FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_bbj_pool_policy TO service_role;

-- Every other pool: the original rule.
UPDATE public.ca_bbj_policy
   SET standard_main = 0.5,
       standard_backup = 0.25,
       pivot_main = 0.25,
       pivot_backup = 0.25,
       note = 'Dan 2026-08-18: below the pivot a drop is 50% main / 25% backup / 25% promo; at or above 100,000 in main it is 25 / 25 / 50. Promo is always the remainder. Restored 2026-10-22 for every pool without its own row in ca_bbj_pool_policy. Mirrors server/src/config/RakeConfig.ts; the database is the allocator.',
       updated_at = now()
 WHERE id = 1;

-- The Midway Union pool only, for the time being.
INSERT INTO public.ca_bbj_pool_policy (pool_id, standard_main, standard_backup, pivot_main, pivot_backup, note)
SELECT p.id, 0.10, 0.30, 0.10, 0.30,
       'Dan 2026-10-22: for the time being only the Midway Union jackpot takes 10% main / 30% backup / 60% promo, below and above the pivot alike; every other pool keeps the original rule.'
  FROM public.bbj_pools p
  JOIN public.unions u ON u.id = p.union_id
 WHERE p.club_id IS NULL AND p.merged_into_pool_id IS NULL AND u.name ILIKE 'Midway Union%'
ON CONFLICT (pool_id) DO UPDATE
   SET standard_main = EXCLUDED.standard_main, standard_backup = EXCLUDED.standard_backup,
       pivot_main = EXCLUDED.pivot_main, pivot_backup = EXCLUDED.pivot_backup,
       note = EXCLUDED.note, updated_at = now();

CREATE OR REPLACE FUNCTION public.fn_bbj_allocate(p_amount numeric, p_main_balance numeric, p_pool_id uuid)
 RETURNS TABLE(main_portion numeric, backup_portion numeric, promo_portion numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pol public.ca_bbj_policy%ROWTYPE;
  v_own public.ca_bbj_pool_policy%ROWTYPE;
  v_rm numeric; v_rb numeric; v_amt numeric := round(COALESCE(p_amount, 0), 2);
  v_state public.ca_bbj_alloc_state%ROWTYPE;
  v_exact_m numeric; v_exact_b numeric;
BEGIN
  SELECT * INTO v_pol FROM public.ca_bbj_policy WHERE id = 1;
  -- A pool with its own row (Dan 2026-10-22: the Midway Union) uses it; every
  -- other pool uses the platform rule.
  IF p_pool_id IS NOT NULL THEN
    SELECT * INTO v_own FROM public.ca_bbj_pool_policy WHERE pool_id = p_pool_id;
    IF FOUND THEN
      v_pol.standard_main := v_own.standard_main; v_pol.standard_backup := v_own.standard_backup;
      v_pol.pivot_main := v_own.pivot_main; v_pol.pivot_backup := v_own.pivot_backup;
    END IF;
  END IF;
  IF COALESCE(p_main_balance, 0) >= v_pol.pivot_threshold THEN
    v_rm := v_pol.pivot_main; v_rb := v_pol.pivot_backup;
  ELSE
    v_rm := v_pol.standard_main; v_rb := v_pol.standard_backup;
  END IF;

  IF p_pool_id IS NULL THEN
    main_portion   := round(v_amt * v_rm, 2);
    backup_portion := round(v_amt * v_rb, 2);
    promo_portion  := round(v_amt - main_portion - backup_portion, 2);
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.ca_bbj_alloc_state (pool_id) VALUES (p_pool_id) ON CONFLICT (pool_id) DO NOTHING;
  SELECT * INTO v_state FROM public.ca_bbj_alloc_state WHERE pool_id = p_pool_id FOR UPDATE;

  v_exact_m := v_amt * v_rm + v_state.main_residue;
  v_exact_b := v_amt * v_rb + v_state.backup_residue;
  main_portion   := round(v_exact_m, 2);
  backup_portion := round(v_exact_b, 2);
  -- A bank cannot be asked for more than the drop, nor less than nothing.
  main_portion   := LEAST(GREATEST(main_portion, 0), v_amt);
  backup_portion := LEAST(GREATEST(backup_portion, 0), v_amt - main_portion);
  promo_portion  := round(v_amt - main_portion - backup_portion, 2);

  UPDATE public.ca_bbj_alloc_state
     SET main_residue   = round(v_exact_m - main_portion, 6),
         backup_residue = round(v_exact_b - backup_portion, 6),
         updated_at     = now()
   WHERE pool_id = p_pool_id;
  RETURN NEXT;
END;
$function$;

-- The page's read names the pool it is showing, so the Midway Union page shows
-- the Midway Union rule. No pool, or a pool without its own row: the platform rule.
DROP FUNCTION IF EXISTS public.fn_bbj_allocation_policy();
CREATE FUNCTION public.fn_bbj_allocation_policy(p_pool_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  -- These are the allocator's public rates, not pool balances or diagnostics.
  -- Service transport has no user subject; a player must have a real subject.
  WITH r AS (
    SELECT p.pivot_threshold,
           COALESCE(o.standard_main, p.standard_main) AS standard_main,
           COALESCE(o.standard_backup, p.standard_backup) AS standard_backup,
           COALESCE(o.pivot_main, p.pivot_main) AS pivot_main,
           COALESCE(o.pivot_backup, p.pivot_backup) AS pivot_backup
      FROM public.ca_bbj_policy p
      LEFT JOIN public.ca_bbj_pool_policy o ON o.pool_id = p_pool_id
     WHERE p.id = 1 AND (auth.role() = 'service_role' OR auth.uid() IS NOT NULL)
  )
  SELECT jsonb_build_object(
    'pivot_threshold', r.pivot_threshold,
    'standard_main', r.standard_main,
    'standard_backup', r.standard_backup,
    'standard_promo', round(1 - r.standard_main - r.standard_backup, 4),
    'pivot_main', r.pivot_main,
    'pivot_backup', r.pivot_backup,
    'pivot_promo', round(1 - r.pivot_main - r.pivot_backup, 4))
  FROM r;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_allocation_policy(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_allocation_policy(uuid) TO authenticated, service_role;

-- Prove it against the allocator: the platform rule (no pool) splits a 10,000
-- drop 5,000 / 2,500 / 2,500 below the pivot and 2,500 / 2,500 / 5,000 at it,
-- and exactly one pool (the Midway Union) carries its own 10 / 30 row.
DO $$
DECLARE r record; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.ca_bbj_pool_policy;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly one pool override (the Midway Union), found %', v_n; END IF;
  SELECT * INTO r FROM public.fn_bbj_allocate(10000, 0);
  IF (r.main_portion, r.backup_portion, r.promo_portion) IS DISTINCT FROM (5000.00, 2500.00, 2500.00) THEN
    RAISE EXCEPTION 'platform standard split is %/%/%', r.main_portion, r.backup_portion, r.promo_portion;
  END IF;
  SELECT * INTO r FROM public.fn_bbj_allocate(10000, 100000);
  IF (r.main_portion, r.backup_portion, r.promo_portion) IS DISTINCT FROM (2500.00, 2500.00, 5000.00) THEN
    RAISE EXCEPTION 'platform pivot split is %/%/%', r.main_portion, r.backup_portion, r.promo_portion;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_bbj_pool_policy o JOIN public.bbj_pools p ON p.id = o.pool_id
                  JOIN public.unions u ON u.id = p.union_id
                  WHERE o.standard_main = 0.10 AND o.standard_backup = 0.30 AND o.pivot_main = 0.10 AND o.pivot_backup = 0.30
                    AND u.name ILIKE 'Midway Union%') THEN
    RAISE EXCEPTION 'the Midway Union override is not 10/30';
  END IF;
END $$;
