-- Why: the legacy repair sweep banked accepted BBJ payments without hand
-- numbers/big blinds. Exact replay then refused the incomplete receipt and
-- repeatedly blocked the next hand. 91 pending receipts matched this shape.
-- What: missing descriptive replay fields require a hash-verified immutable
-- accepted hand; all existing identity, amount and destination checks remain.
-- Legacy repair excludes accepted-hand obligations. No data is backfilled,
-- no balance is adjusted and no obligation is marked complete by this migration.
-- Proof: isolated PostgreSQL replay, conflict, tamper and repair-ownership cases.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.bbj_record_contribution(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,integer,uuid)'::regprocedure))
       <> '523a1db036474234718a7e664f4eee8e'
     OR md5(pg_get_functiondef('public.fn_bbj_repair_unbanked(integer,integer)'::regprocedure))
       <> 'b32b9405f3504c6b1a55cb264de0db3f' THEN
    RAISE EXCEPTION 'BBJ receipt or repair definition changed; re-audit before applying';
  END IF;
END;
$guard$;
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
    v_context jsonb;
    v_setting text;
BEGIN
    IF p_pool_id IS NULL OR p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
       OR p_amount <= 0 OR p_amount <> round(p_amount, 2)
       OR (p_hand_id IS NULL AND (p_table_id IS NULL OR p_hand_number IS NULL)) THEN
        RAISE EXCEPTION 'BBJ contribution requires a stable hand identity and positive whole-cent amount'
            USING ERRCODE = '22023';
    END IF;

    -- Identity is independent of its destination. Serialize a retry before
    -- reading the receipt, including requests that have no history UUID.
    IF p_hand_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('bbj:hand:' || p_hand_id::text, 0));
    END IF;
    IF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
            'bbj:table-hand:' || p_table_id::text || ':' || p_hand_number::text, 0));
    END IF;

    SELECT COALESCE(alloc_cum_amount, 0), COALESCE(main_balance, 0) INTO v_prev_cum, v_main_now
      FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'bbj_record_contribution: pool % not found', p_pool_id;
    END IF;

    SELECT * INTO v_contribution FROM bbj_contributions
     WHERE (p_hand_id IS NOT NULL AND hand_id = p_hand_id)
        OR (p_table_id IS NOT NULL AND p_hand_number IS NOT NULL
            AND table_id = p_table_id AND hand_number = p_hand_number)
     ORDER BY created_at LIMIT 1;
    IF v_contribution.id IS NOT NULL THEN
        -- The old repair sweep banked accepted hands with NULL descriptive
        -- fields. A retry may fill those fields in its RETURN VALUE only when
        -- the immutable accepted-hand envelope independently proves the exact
        -- requested payment. No stored receipt, pool or allocator is changed.
        IF (v_contribution.hand_number IS NULL OR v_contribution.big_blind IS NULL)
           AND EXISTS (
             SELECT 1 FROM public.hand_atomic_commits c
              WHERE c.hand_id = p_hand_id
                AND c.table_id = p_table_id
                AND c.hand_number = p_hand_number
                AND jsonb_typeof(c.post_commit_payload->'bbj_contribution') = 'object'
                AND c.post_commit_payload_hash = encode(extensions.digest(
                  convert_to(c.post_commit_payload::text, 'UTF8'), 'sha256'), 'hex')
                AND (c.post_commit_payload->'bbj_contribution'->>'club_id')::uuid = p_club_id
                AND (c.post_commit_payload->'bbj_contribution'->>'amount')::numeric = p_amount
                AND (c.post_commit_payload->'bbj_contribution'->>'big_blind')::numeric = p_big_blind
           ) THEN
            v_contribution.hand_number := COALESCE(v_contribution.hand_number, p_hand_number);
            v_contribution.big_blind := COALESCE(v_contribution.big_blind, p_big_blind);
        END IF;
        IF v_contribution.hand_id IS DISTINCT FROM p_hand_id
           OR v_contribution.pool_id IS DISTINCT FROM p_pool_id
           OR v_contribution.table_id IS DISTINCT FROM p_table_id
           OR v_contribution.club_id IS DISTINCT FROM p_club_id
           OR v_contribution.amount IS DISTINCT FROM p_amount
           OR v_contribution.big_blind IS DISTINCT FROM p_big_blind
           OR v_contribution.hand_number IS DISTINCT FROM p_hand_number THEN
            RAISE EXCEPTION 'BBJ contribution identity reused with a different payment payload'
                USING ERRCODE = '22023';
        END IF;
        RETURN v_contribution;
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
    RETURNING * INTO v_contribution;

    /* ZERO-DRIFT (2026-08-31): the pool credit below auto-journals via
       trg_ca_autoledger; declare what it is. */
    SELECT jsonb_object_agg(k, COALESCE(current_setting(k, true), '')) INTO v_context
      FROM unnest(ARRAY['app.ledger_category','app.ledger_counterparty',
                       'app.ledger_counterparty_entity','app.ledger_settlement',
                       'app.ledger_hand_id']) AS settings(k);
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

    FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
        PERFORM set_config(v_setting, v_context->>v_setting, true);
    END LOOP;

    RETURN v_contribution;
END;
$function$;

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
  -- CHIP STANDARD (2026-09-05): a sweep that moves money checks the freeze
  -- (CLAUDE.md section 13 rule 5). fn_ca_auto_reconcile_tick runs this every
  -- minute from pg_cron, which does not stop for the break, and bbj_pools is
  -- not under the freeze guard; the drops it re-banked at :55 and :00 were
  -- the ones whose legs the freeze refused. It returns empty during the break
  -- and re-banks them at the next tick after play resumes.
  IF public.fn_platform_frozen() THEN
    RETURN;
  END IF;
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
      -- Accepted hands have one immutable obligation processor. Its live
      -- table/worker retries own this payment; the legacy repair job must not
      -- create a second receipt shape while that processor is recovering.
      AND NOT EXISTS (
        SELECT 1 FROM public.hand_atomic_commits c
         WHERE c.hand_id = rr.hand_id AND c.post_commit_payload IS NOT NULL
      )
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

REVOKE ALL ON FUNCTION public.bbj_record_contribution(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_record_contribution(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,integer,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_repair_unbanked(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_repair_unbanked(integer,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
