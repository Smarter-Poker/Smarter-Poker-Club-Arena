-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260822224905 "recover_unbanked_fees_to_union_bank"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3c90ccb24fe0297916e0f61f0cbfe154 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Recover the fees that left pots and never reached a ledger, into the union bank
-- Date: 2026-08-22 · Tier 3 (moves real chips) · Dan's call, verbatim:
--   "just add the chips to the union bank, and don't worry about is as long as
--    the bug is fixed now."
--
-- The bug is fixed: FeeReconciler now retries the queue insert, checks whether
-- the fee is already queued or banked before alarming (CA #270, #283), and the
-- alarm carries the full re-drive payload from now on (CA #295).
--
-- These are the ones from BEFORE that, which cannot be re-driven properly: the
-- alerts never recorded `contributions`, the per-player split
-- atomic_distribute_rake needs, and auditBBJDrift already states why guessing
-- it is worse than not — "guessing it would corrupt rakeback attribution".
-- So the chips go to the union bank as a lump, unattributed, on instruction.
--
-- ROLLBACK
--   UPDATE union_wallets SET chip_balance = chip_balance - <amount>
--    WHERE union_id = 'fade0000-0000-0000-0000-000000000001';
--   DELETE FROM union_wallet_transactions WHERE tx_type = 'unbanked_fee_recovery';
--   UPDATE financial_alerts SET resolved = false, resolved_at = NULL
--    WHERE source = 'FeeReconciler.queue_failed'
--      AND context ? 'recovered_to_union_bank';
-- ============================================================================
DO $recover$
DECLARE
  v_union      uuid;
  v_rake       numeric := 0;
  v_bbj        numeric := 0;
  v_total      numeric := 0;
  v_rows       integer := 0;
  v_before     numeric;
  v_after      numeric;
BEGIN
  -- IDEMPOTENT. Re-running must not pay twice.
  IF EXISTS (SELECT 1 FROM union_wallet_transactions WHERE tx_type = 'unbanked_fee_recovery') THEN
    RAISE NOTICE 'unbanked_fee_recovery already booked - nothing to do.';
    RETURN;
  END IF;

  CREATE TEMP TABLE _atrisk ON COMMIT DROP AS
  WITH a AS (
    SELECT fa.id, fa.context->>'kind' AS kind,
           nullif(fa.context->>'handId','')::uuid       AS hand_id,
           (fa.context->>'tableId')::uuid               AS table_id,
           (fa.context->>'clubId')::uuid                AS club_id,
           nullif(fa.context->>'handNumber','')::bigint AS hand_number,
           coalesce((fa.context->>'rake')::numeric, 0)  AS rake,
           coalesce((fa.context->>'bbj')::numeric, 0)   AS bbj
      FROM financial_alerts fa
     WHERE fa.source = 'FeeReconciler.queue_failed'
       AND fa.resolved IS NOT TRUE
  )
  SELECT a.*, CASE WHEN a.kind = 'rake' THEN a.rake ELSE a.bbj END AS chips
    FROM a
   WHERE NOT EXISTS (SELECT 1 FROM pending_fee_distributions p
                      WHERE p.hand_number = a.hand_number AND p.kind = a.kind
                        AND p.table_id = a.table_id)
     -- Per kind. A rake alert is judged against rake_records ONLY and a bbj
     -- alert against bbj_contributions ONLY; checking both for both marks a
     -- hand safe because its OTHER half landed, and understates the loss.
     AND NOT (CASE WHEN a.kind = 'rake'
                   THEN EXISTS (SELECT 1 FROM rake_records r
                                 WHERE r.hand_id = a.hand_id
                                    OR (r.table_id = a.table_id AND r.global_hand_id = a.hand_number))
                   ELSE EXISTS (SELECT 1 FROM bbj_contributions b
                                 WHERE b.table_id = a.table_id AND b.hand_number = a.hand_number)
              END);

  SELECT count(*),
         round(coalesce(sum(chips) FILTER (WHERE kind = 'rake'), 0), 2),
         round(coalesce(sum(chips) FILTER (WHERE kind = 'bbj_contribution'), 0), 2)
    INTO v_rows, v_rake, v_bbj FROM _atrisk;
  v_total := round(v_rake + v_bbj, 2);

  IF v_rows = 0 THEN RAISE NOTICE 'nothing at risk - nothing to do.'; RETURN; END IF;

  -- Sanity band. Measured 452.43 over 193 rows. A wildly different number means
  -- the classification changed underneath this and it must not pay blind.
  IF v_total <= 0 OR v_total > 2000 THEN
    RAISE EXCEPTION 'refusing: computed % chips over % rows, outside the expected band', v_total, v_rows;
  END IF;

  SELECT DISTINCT c.union_id INTO v_union
    FROM _atrisk a JOIN clubs c ON c.id = a.club_id WHERE c.union_id IS NOT NULL;
  IF v_union IS NULL THEN
    RAISE EXCEPTION 'refusing: no union resolves for the affected club(s)';
  END IF;
  IF (SELECT count(DISTINCT c.union_id) FROM _atrisk a JOIN clubs c ON c.id = a.club_id) <> 1 THEN
    RAISE EXCEPTION 'refusing: more than one union affected - this migration books to one bank';
  END IF;

  SELECT chip_balance INTO v_before FROM union_wallets WHERE union_id = v_union FOR UPDATE;
  IF v_before IS NULL THEN RAISE EXCEPTION 'no union_wallets row for %', v_union; END IF;

  UPDATE union_wallets
     SET chip_balance = round(coalesce(chip_balance,0) + v_total, 2), updated_at = now()
   WHERE union_id = v_union
   RETURNING chip_balance INTO v_after;

  -- One row per kind, so the books say what the money was.
  INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
  SELECT v_union, 'chip_balance', 'credit', v_rake, v_after, 'unbanked_fee_recovery',
         'Rake withheld from pots that never reached rake_records - '
           || (SELECT count(*) FROM _atrisk WHERE kind = 'rake')
           || ' hand(s), 2026-08-20..22. FeeReconciler.queue_failed. Unattributed: the '
           || 'alerts did not record per-player contributions. Dan 2026-08-22.'
   WHERE v_rake > 0;

  INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
  SELECT v_union, 'chip_balance', 'credit', v_bbj, v_after, 'unbanked_fee_recovery',
         'BBJ slices withheld from pots that never reached a jackpot pool - '
           || (SELECT count(*) FROM _atrisk WHERE kind = 'bbj_contribution')
           || ' hand(s), 2026-08-20..22. Booked to the union bank rather than '
           || 'bbj_wallet on instruction; the jackpot pool is that much lighter.'
   WHERE v_bbj > 0;

  -- Close them in the SAME transaction, so this set can never be counted twice.
  UPDATE financial_alerts fa
     SET resolved = true, resolved_at = now(),
         context = fa.context || jsonb_build_object('recovered_to_union_bank', v_union)
    FROM _atrisk t WHERE fa.id = t.id;

  IF round(v_after - v_before, 2) <> v_total THEN
    RAISE EXCEPTION 'balance moved % but % was owed', round(v_after - v_before, 2), v_total;
  END IF;

  RAISE NOTICE 'Booked % chips (rake %, bbj %) over % alert(s) to union % bank. % -> %',
    v_total, v_rake, v_bbj, v_rows, v_union, v_before, v_after;
END $recover$;
