-- Why: NULL-hand retries could both bank after checking the receipt before the pool lock.
-- What: serialize stable identities, bind their payload, and restore nested journal context.
-- Measured: isolated PostgreSQL concurrent retries, payload conflicts, residue and journal rollback.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.bbj_record_contribution(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,integer,uuid)'::regprocedure))
    <> 'e088beec3a36cb3fc7e3954896870a82' THEN
  RAISE EXCEPTION 'BBJ contribution definition changed; re-audit before applying';
 END IF;
END $guard$;
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
$function$
;
REVOKE ALL ON FUNCTION public.bbj_record_contribution(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_record_contribution(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,integer,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
