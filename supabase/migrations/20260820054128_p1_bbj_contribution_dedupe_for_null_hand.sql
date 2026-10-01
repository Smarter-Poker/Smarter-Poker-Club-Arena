-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820054128 "p1_bbj_contribution_dedupe_for_null_hand"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f164aa54de56a4574ff647e17c320147 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Same null-hand hole as atomic_distribute_rake, in the jackpot leg.
--
-- bbj_record_contribution dedupes on
--     ON CONFLICT (pool_id, hand_id) WHERE hand_id IS NOT NULL DO NOTHING
-- which by definition cannot fire when the hand id is null. The row is then
-- inserted afresh and bbj_pools.main/backup/promo_balance are incremented AGAIN.
--
-- That path is not rare: 7,317 rake_records rows in the last 30 days carry no
-- hand id, and logBBJCollection is called with the same v_handHistoryId. It now
-- retries the RPC three times (this session's A5 work) and the FeeReconciler
-- re-drives it from the queue as well, so every retry of a committed-but-timed-
-- out contribution inflated the jackpot pool with chips no player paid.
--
-- Fix mirrors the rake one: when there is no hand id, dedupe on the identity the
-- caller does have -- (pool_id, table_id, hand_number). Deliberately a
-- pre-check rather than a unique index, because duplicates already exist in
-- production and deleting historical jackpot rows is Dan's call, not a
-- migration's.
--
-- Also fixes a latent bug in the existing no-op branch: it looked the prior row
-- up with `hand_id = p_hand_id`, which is NULL = NULL -> never true, so on a
-- null-hand re-entry it returned an all-NULL record rather than the real one.
DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'bbj_record_contribution';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'bbj_record_contribution not found';
  END IF;

  -- 1. Pre-check + guard the INSERT.
  v_new := replace(
    v_src,
    '    INSERT INTO bbj_contributions (' || E'\n' ||
    '        pool_id, hand_id, table_id, club_id, amount,',
    '    IF p_hand_id IS NULL THEN' || E'\n' ||
    '        SELECT * INTO v_contribution FROM bbj_contributions' || E'\n' ||
    '         WHERE pool_id = p_pool_id' || E'\n' ||
    '           AND hand_id IS NULL' || E'\n' ||
    '           AND table_id IS NOT DISTINCT FROM p_table_id' || E'\n' ||
    '           AND hand_number IS NOT DISTINCT FROM p_hand_number' || E'\n' ||
    '         ORDER BY created_at' || E'\n' ||
    '         LIMIT 1;' || E'\n' ||
    '        IF v_contribution.id IS NOT NULL THEN' || E'\n' ||
    '            RETURN v_contribution;' || E'\n' ||
    '        END IF;' || E'\n' ||
    '    END IF;' || E'\n' || E'\n' ||
    '    INSERT INTO bbj_contributions (' || E'\n' ||
    '        pool_id, hand_id, table_id, club_id, amount,'
  );
  IF v_new = v_src THEN
    RAISE EXCEPTION 'bbj INSERT anchor not found - refusing to patch blindly';
  END IF;

  -- 2. Make the existing no-op lookup null-safe (NULL = NULL was never true).
  v_src := v_new;
  v_new := replace(
    v_src,
    '         WHERE pool_id = p_pool_id AND hand_id = p_hand_id' || E'\n' ||
    '         LIMIT 1;',
    '         WHERE pool_id = p_pool_id AND hand_id IS NOT DISTINCT FROM p_hand_id' || E'\n' ||
    '         LIMIT 1;'
  );
  IF v_new = v_src THEN
    RAISE EXCEPTION 'bbj no-op lookup anchor not found - refusing to patch blindly';
  END IF;

  EXECUTE v_new;
END
$mig$;
