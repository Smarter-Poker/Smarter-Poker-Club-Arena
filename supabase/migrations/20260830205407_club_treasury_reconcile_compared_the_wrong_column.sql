-- =====================================================================
-- THE club_treasury RECONCILER WAS COMPARING THE WRONG COLUMN
-- =====================================================================
-- Applied to production 2026-08-30 20:54 UTC via Supabase apply_migration.
--
-- reconcile_ledger_nightly reconstructs each club's TREASURY from chip_ledger
-- (`to_type/from_type = 'club_treasury'`) and then compares it against
-- `clubs.chip_pool`. The treasury column is `clubs.chip_treasury`.
-- `chip_pool` is a near-empty legacy column:
--
--   club            chip_pool     chip_treasury
--   Club JAQK       12,459.07      1,051,788.71
--   SHARK CLUB           0.00      1,376,610.47
--   Midway Union         0.00              0.00
--
-- So the nightly "club_treasury drift, severity critical" figures were
-- meaningless, which is why they swung -110,377 -> 5,159,494 -> 12,425,392 on
-- consecutive nights. No real economy moves like that; the check was reading a
-- column nothing writes.
--
-- SURGICAL BY CONSTRUCTION. The body is 9,322 characters and contains exactly
-- ONE occurrence of `chip_pool`. Rather than retype a money-reconciliation
-- function (and risk a transcription error in a control), this rewrites the
-- stored source with a single asserted token replacement and re-installs it.
-- The length delta is asserted to be exactly +4 characters.
--
-- SEVERITY DELIBERATELY UNCHANGED. Fixing the column does NOT make this check
-- green: chip_ledger is not a complete journal of treasury movement, so even
-- against the right column the reconstruction is far from the stored balance
-- (Club JAQK -24.3M vs 1.05M). CLAUDE.md 11.5 already records this shape -
-- `atomic_table_buyin` writes `club_members.chip_balance` directly and was
-- invisible to reconciliation for exactly the same reason. Downgrading the
-- alarm now would hide a REAL discrepancy later, so it stays loud, and the
-- honest next step is to make every treasury writer journal to chip_ledger.
--
-- ROLLBACK: replace 'chip_treasury' with 'chip_pool' in the same single
-- position (the `stored AS (...)` CTE of the club_treasury block).
-- =====================================================================

DO $$
DECLARE v_src text; v_new text; v_hits int;
BEGIN
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly';
    IF v_src IS NULL THEN
        RAISE EXCEPTION 'reconcile_ledger_nightly not found.';
    END IF;

    SELECT count(*) INTO v_hits FROM regexp_matches(v_src, 'COALESCE\(chip_pool, 0\)', 'g');
    IF v_hits = 0 THEN
        RAISE NOTICE 'Already applied: no chip_pool reference remains.';
        RETURN;
    END IF;
    IF v_hits <> 1 THEN
        RAISE EXCEPTION 'Refusing: expected exactly 1 occurrence, found %.', v_hits;
    END IF;

    v_new := replace(v_src, 'COALESCE(chip_pool, 0)', 'COALESCE(chip_treasury, 0)');
    IF v_new = v_src THEN
        RAISE EXCEPTION 'Refusing: replacement produced no change.';
    END IF;
    IF length(v_new) <> length(v_src) + 4 THEN
        RAISE EXCEPTION 'Refusing: unexpected length change (% -> %).', length(v_src), length(v_new);
    END IF;

    EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.reconcile_ledger_nightly() RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS %L',
        (SELECT pg_get_function_result(p.oid)
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly'),
        v_new);

    RAISE NOTICE 'reconcile_ledger_nightly now reconciles against clubs.chip_treasury.';
END $$;

DO $$
DECLARE v_pool int; v_treas int;
BEGIN
    SELECT count(*) INTO v_pool
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
           LATERAL regexp_matches(p.prosrc, 'COALESCE\(chip_pool, 0\)', 'g')
     WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';
    SELECT count(*) INTO v_treas
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
           LATERAL regexp_matches(p.prosrc, 'COALESCE\(chip_treasury, 0\)', 'g')
     WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';

    IF v_pool <> 0 THEN
        RAISE EXCEPTION 'Post-apply: chip_pool still referenced % time(s).', v_pool;
    END IF;
    IF v_treas < 1 THEN
        RAISE EXCEPTION 'Post-apply: chip_treasury not present.';
    END IF;
    RAISE NOTICE 'Verified: chip_pool 0 references, chip_treasury % reference(s).', v_treas;
END $$;
