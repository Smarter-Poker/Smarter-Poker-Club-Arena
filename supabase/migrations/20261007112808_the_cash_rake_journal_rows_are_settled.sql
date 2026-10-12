-- 20261007112808_the_cash_rake_journal_rows_are_settled.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLY AFTER 20261007112751, which stops the hourly Diamond cash rake sweep
-- writing wallet journal rows. This file settles the rows it wrote before that.
--
-- ============================================================================
-- THE DAMAGE, READ FROM ROWS ON 2026-10-07 (11:22 UTC)
-- ============================================================================
--
-- The first six hourly sweeps (05:14 to 10:14 UTC; the 11:14 run found nothing
-- unswept) wrote 46 negative 'cash_rake' rows into diamond_transactions, one
-- per payer per sweep, totalling 4,460 Diamonds. None of them moved
-- profiles.diamonds, and none should have: each rake had already left the
-- payer's arena custody when its hand settled, so the payer's cash-out was
-- already smaller by it. The journal therefore records each rake twice, and
-- for exactly these 13 wallets SUM(diamond_transactions.amount) is below
-- profiles.diamonds by exactly their cash_rake total. Every other wallet's
-- journal explains its balance exactly.
--
-- THE SETTLEMENT (CLAUDE.md 10.9). Nobody's balance moves. The wallets are
-- right and the journal is wrong, so the journal is what is corrected. The 46
-- rows are append-only and are left exactly as written (never rewrite or
-- delete a settled record); each one gets ONE correcting row of the opposite
-- sign, keyed 'cash_rake_correction:<original row id>', so the correction is
-- traceable row for row and cannot be written twice (the reference_id index
-- is UNIQUE and the insert also checks NOT EXISTS).
--
-- WHY THE REGISTER MUST NOT FOLLOW THE CORRECTIONS. The register burn each
-- original row drove (player holder, 'diamond-journal:spend:<id>') is CORRECT:
-- the rake was retired from the payer's custody and minted to the house, and
-- fn_ca_diamond_register_vs_supply() is 0 with those burns in it. Following a
-- +4,460 correction would mint 4,460 Diamonds that exist nowhere and break
-- that identity. source 'journal_backfill' is the named source
-- fn_ca_diamond_journal_origin already refuses to register (20260930055147),
-- for exactly this reason. issuance_class 'admin' keeps the corrections out of
-- the promotional earn ledger, and a positive row allocates no Lifetime VIP lot.
--
-- LIFETIME VIP LOTS. The 46 rows also allocated 2,386 Diamonds of phantom
-- spend against Lifetime VIP diamond lots (30 allocations). Those lots expire
-- between 2026-12-31 and 2027-01-02. Restoring their remaining_amount would
-- make more Diamonds expire from these players later than would expire now,
-- which is taking back from a player for our defect (10.9 rule 3). They are
-- left as they are and reported in the changelog.
--
-- WHO IS AFFECTED, AND WHAT THEY GET. Thirteen players, every one of them a
-- horse, and settled exactly as a human would be (10.5): no wallet moves, and
-- each gets a correcting ledger row for each Diamond Arena rake line that
-- their cash-out had already paid: kanelockhart 1,199 (6 rows), wilderquintero
-- 1,063 (6), oakesvane 459 (5), cyrusthackeray 395 (3), groveellsworth 356 (2),
-- quinnsinclair 247 (3), maceabernathy 156 (5), sagemontrose 153 (2),
-- sagehartley 106 (4), prairieunderwood 102 (3), thornefairbanks 91 (3),
-- indigoravenscroft 82 (1), kaneashcroft 51 (3). Total 4,460 over 46 rows.
--
-- NOT A REPAIR JOB (10.12). A one-time settlement in a migration; the live
-- writer was fixed first (20261007112751). No cron, no sweep, nothing reruns.
-- No is_horse anywhere in this file: the cohort is the 46 rows and nothing else.
--
-- One transaction (production DDL policy rule 1). Never inside :50-:03 UTC.
--
-- @live-proof: (SELECT count(*) = 46 FROM public.diamond_transactions WHERE transaction_type = 'cash_rake_correction' AND reference_id LIKE 'cash_rake_correction:%')

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. THE LIVE WRITER IS ALREADY FIXED, OR NOTHING HERE RUNS.
DO $pre$
BEGIN
  IF position('diamond_transactions' IN
       pg_get_functiondef('public.fn_ca_diamond_sweep_cash_rake(text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'apply 20261007112751 first: the sweep still writes wallet journal rows';
  END IF;
END
$pre$;

-- 2. THE COHORT, READ ONCE, AND THE BOARD ASSERTED BEFORE ANYTHING IS WRITTEN.
CREATE TEMP TABLE zz_cash_rake_rows ON COMMIT DROP AS
SELECT t.id, t.user_id, t.amount, t.created_at, t.metadata->>'sweep_id' AS sweep_id
  FROM public.diamond_transactions t
 WHERE t.transaction_type = 'cash_rake'
   AND NOT EXISTS (SELECT 1 FROM public.diamond_transactions c
                    WHERE c.reference_id = 'cash_rake_correction:' || t.id::text);

CREATE TEMP TABLE zz_journal_gap ON COMMIT DROP AS
SELECT p.id AS user_id,
       p.diamonds::bigint - COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                       WHERE t.user_id = p.id), 0)::bigint AS gap
  FROM public.profiles p
 WHERE p.diamonds::bigint <> COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                        WHERE t.user_id = p.id), 0)::bigint;

DO $board$
DECLARE v_rows bigint; v_total bigint; v_users bigint; v_gaps bigint; v_gap_total bigint; v_mismatch bigint;
BEGIN
  SELECT count(*), COALESCE(-SUM(amount),0), count(DISTINCT user_id)
    INTO v_rows, v_total, v_users FROM zz_cash_rake_rows;
  IF v_rows <> 46 OR v_total <> 4460 OR v_users <> 13 THEN
    RAISE EXCEPTION 'THE BOARD MOVED. Measured 46 cash_rake rows, 4460 Diamonds, 13 wallets on 2026-10-07; found %, %, %. Re-read before settling (CLAUDE.md 10.9 rule 4).',
      v_rows, v_total, v_users;
  END IF;
  SELECT count(*), COALESCE(SUM(gap),0) INTO v_gaps, v_gap_total FROM zz_journal_gap;
  IF v_gaps <> 13 OR v_gap_total <> 4460 THEN
    RAISE EXCEPTION 'THE BOARD MOVED. Measured 13 wallets 4460 Diamonds the journal cannot explain; found % and %.',
      v_gaps, v_gap_total;
  END IF;
  -- Every gap is exactly that wallet's cash_rake total, and no other wallet drifts.
  SELECT count(*) INTO v_mismatch
    FROM zz_journal_gap g
    FULL JOIN (SELECT user_id, -SUM(amount) AS rake FROM zz_cash_rake_rows GROUP BY user_id) r
      ON r.user_id = g.user_id
   WHERE g.gap IS DISTINCT FROM r.rake;
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION '% wallets drift by something other than their cash_rake rows; stop and read them', v_mismatch;
  END IF;
END
$board$;

-- 3. ONE CORRECTING ROW PER ORIGINAL ROW. No balance moves.
INSERT INTO public.diamond_transactions
  (user_id, type, transaction_type, amount, balance_after, description,
   reference_id, source, issuance_class, counterparty, metadata)
SELECT r.user_id, 'cash_rake_correction', 'cash_rake_correction', (-r.amount)::integer,
       (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = r.user_id),
       'Diamond Arena Rake Correction. This Rake Was Already Taken From Your Table Stack, So Your Cash-Out Already Showed It.',
       'cash_rake_correction:' || r.id::text,
       'journal_backfill', 'admin', 'adjustment',
       jsonb_build_object(
         'settlement', '20261007112808_the_cash_rake_journal_rows_are_settled',
         'corrects', r.id, 'corrects_created_at', r.created_at, 'sweep_id', r.sweep_id,
         'reason', 'fn_ca_diamond_sweep_cash_rake journalled rake the cash-out had already reflected',
         'balance_changed', false)
  FROM zz_cash_rake_rows r
 ORDER BY r.created_at, r.id;

-- 4. PROOF: the journal explains every balance, no balance moved, the register
--    did not follow, and the identity is whole.
DO $proof$
DECLARE v_gaps bigint; v_new bigint; v_reg bigint; v_diff numeric;
BEGIN
  SELECT count(*) INTO v_gaps FROM public.profiles p
   WHERE p.diamonds::bigint <> COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                          WHERE t.user_id = p.id), 0)::bigint;
  IF v_gaps <> 0 THEN
    RAISE EXCEPTION '% wallets still have a balance their journal cannot explain', v_gaps;
  END IF;
  SELECT count(*) INTO v_new FROM public.diamond_transactions WHERE transaction_type = 'cash_rake_correction';
  IF v_new <> 46 THEN
    RAISE EXCEPTION '% correction rows, not 46', v_new;
  END IF;
  SELECT count(*) INTO v_reg FROM public.ca_mint_ledger m
    JOIN public.diamond_transactions t ON t.id = m.diamond_tx_id
   WHERE t.transaction_type = 'cash_rake_correction';
  IF v_reg <> 0 THEN
    RAISE EXCEPTION 'the register followed % correction rows', v_reg;
  END IF;
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole (difference %)', v_diff;
  END IF;
  RAISE NOTICE '46 cash_rake rows corrected; every journal explains its balance; register untouched; identity 0';
END
$proof$;

COMMIT;
