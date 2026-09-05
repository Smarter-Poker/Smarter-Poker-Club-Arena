-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4.3, SECOND CUT - THE ALLOCATOR CARRIES ITS ROUNDING RESIDUE
-- (chip standard, 2026-09-04 21:25 UTC).
--
-- Read within twelve minutes of the first cut going live: the union pool's
-- drops split 26.0 / 26.0 / 48.0 and the club pool's 51.7 / 25.4 / 22.9,
-- against a policy of 25 / 25 / 50 and 50 / 25 / 25. Not a bug in the rule:
-- a drop is a few cents (0.15 is common), round-half-up on each of main and
-- backup favours them, and promo takes what is left. Per drop it is under a
-- cent; per hour it is ~14 chips walking from promo to main, every hour,
-- forever. The retired cumulative method was exact but could not survive the
-- pivot changing the ratio mid-stream.
--
-- The fix that is exact under any ratio change: carry the fractional cent.
-- Each pool keeps a residue per bank (ca_bbj_alloc_state); a drop's exact
-- share plus the carried residue is rounded, and the new residue is what
-- rounding dropped, so the long-run split is the policy's to the cent and
-- no single drop is more than half a cent off. fn_bbj_allocate gains a pool
-- argument that carries the residue; without it, it is the pure calculation
-- it was. The drop and the repair pass the pool.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ca_bbj_alloc_state (
  pool_id        uuid PRIMARY KEY,
  main_residue   numeric NOT NULL DEFAULT 0 CHECK (main_residue > -0.01 AND main_residue < 0.01),
  backup_residue numeric NOT NULL DEFAULT 0 CHECK (backup_residue > -0.01 AND backup_residue < 0.01),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_bbj_alloc_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_bbj_alloc_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_bbj_alloc_state TO service_role;
COMMENT ON TABLE public.ca_bbj_alloc_state IS
  'Per-pool fractional-cent residue carried between BBJ drops so the long-run main/backup/promo split equals ca_bbj_policy exactly (chip standard Phase 4.3, second cut).';

CREATE OR REPLACE FUNCTION public.fn_bbj_allocate(p_amount numeric, p_main_balance numeric, p_pool_id uuid)
 RETURNS TABLE(main_portion numeric, backup_portion numeric, promo_portion numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pol public.ca_bbj_policy%ROWTYPE;
  v_rm numeric; v_rb numeric; v_amt numeric := round(COALESCE(p_amount, 0), 2);
  v_state public.ca_bbj_alloc_state%ROWTYPE;
  v_exact_m numeric; v_exact_b numeric;
BEGIN
  SELECT * INTO v_pol FROM public.ca_bbj_policy WHERE id = 1;
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
REVOKE ALL ON FUNCTION public.fn_bbj_allocate(numeric, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_allocate(numeric, numeric, uuid) TO service_role;

-- The drop and the repair carry the residue. Only the allocate call changes.
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

    RETURN v_contribution;
END;
$function$;
REVOKE ALL ON FUNCTION public.bbj_record_contribution(uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_record_contribution(uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, integer, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_repair_unbanked(p_since_hours integer DEFAULT 48, p_limit integer DEFAULT 200)
 RETURNS TABLE(hand_id uuid, table_id uuid, club_id uuid, pool_id uuid, amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_pool_id uuid; v_main numeric; v_backup numeric; v_promo numeric;
  v_current_main numeric; v_inserted uuid;
BEGIN
  FOR r IN
    SELECT rr.hand_id AS h_id, rr.table_id AS t_id, rr.club_id AS c_id,
           SUM(rr.bbj_contribution) AS amt,
           MAX(COALESCE((rr.metadata->>'big_blind')::numeric, 0)) AS bb,
           MIN(rr.created_at) AS hand_at
    FROM public.rake_records rr
    WHERE rr.hand_id IS NOT NULL
      AND COALESCE(rr.bbj_contribution, 0) > 0
      AND rr.created_at > now() - make_interval(hours => p_since_hours)
      AND rr.created_at < now() - interval '5 minutes'
      AND NOT EXISTS (SELECT 1 FROM public.bbj_contributions bc WHERE bc.hand_id = rr.hand_id)
    GROUP BY rr.hand_id, rr.table_id, rr.club_id
    ORDER BY MIN(rr.created_at)
    LIMIT p_limit
  LOOP
    SELECT bp.id, bp.main_balance INTO v_pool_id, v_current_main
    FROM public.bbj_pools bp
    WHERE bp.status = 'active'
      AND ((bp.union_id = (SELECT c.union_id FROM public.clubs c WHERE c.id = r.c_id))
        OR (bp.club_id = r.c_id AND (SELECT c.union_id FROM public.clubs c WHERE c.id = r.c_id) IS NULL))
    ORDER BY (bp.union_id IS NOT NULL) DESC
    LIMIT 1
    FOR UPDATE OF bp;

    CONTINUE WHEN v_pool_id IS NULL;

    -- ONE ALLOCATOR (Phase 4.3): the same split the drop uses, residue carried.
    SELECT a.main_portion, a.backup_portion, a.promo_portion INTO v_main, v_backup, v_promo
      FROM public.fn_bbj_allocate(r.amt, v_current_main, v_pool_id) a;

    -- ZERO-DRIFT phase 2: repaired drops = bbj_contribution vs table_stack.
    PERFORM set_config('app.ledger_category', 'bbj_contribution', true);
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(r.t_id::text, ''), true);

    WITH ins AS (
      INSERT INTO public.bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number, created_at
      )
      SELECT v_pool_id, r.h_id, r.t_id, r.c_id, r.amt,
             v_main, v_backup, v_promo, NULLIF(r.bb, 0), NULL, r.hand_at
      WHERE NOT EXISTS (SELECT 1 FROM public.bbj_contributions bc WHERE bc.hand_id = r.h_id)
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
      FROM ins WHERE bp.id = v_pool_id RETURNING bp.id
    )
    SELECT ins.id INTO v_inserted FROM ins;

    IF v_inserted IS NOT NULL THEN
      hand_id := r.h_id; table_id := r.t_id; club_id := r.c_id;
      pool_id := v_pool_id; amount := r.amt;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) TO service_role;

-- Assert: 1,000 drops of 0.15 at the pivot split 25/25/50 to the cent, in a
-- transaction we roll back with a savepoint.
DO $$
DECLARE i int; m numeric := 0; b numeric := 0; p numeric := 0; r record; v_pool uuid := gen_random_uuid();
BEGIN
  FOR i IN 1..1000 LOOP
    SELECT * INTO r FROM public.fn_bbj_allocate(0.15, 100000, v_pool);
    m := m + r.main_portion; b := b + r.backup_portion; p := p + r.promo_portion;
    IF round(r.main_portion + r.backup_portion + r.promo_portion, 2) <> 0.15 THEN
      RAISE EXCEPTION 'a drop did not re-sum: % % %', r.main_portion, r.backup_portion, r.promo_portion;
    END IF;
  END LOOP;
  IF abs(m - 37.50) > 0.01 OR abs(b - 37.50) > 0.01 OR abs(p - 75.00) > 0.02 THEN
    RAISE EXCEPTION 'residue carry is not exact: main % backup % promo % on 150.00', m, b, p;
  END IF;
  DELETE FROM public.ca_bbj_alloc_state WHERE pool_id = v_pool;
END $$;
