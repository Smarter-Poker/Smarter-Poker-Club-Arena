/* WHY. At 10:21:44 today the BBJ meter changed what it measures: from a
   per-interval residue, which could only climb because a drop whose
   transaction begins before a reading and commits after it lands in no
   interval, to a cumulative figure since the pool opened, which comes back on
   its own. The very first reading on the new basis was compared against the
   last reading on the old one - 0.65 against 0.50, 0.49 against 0.30 - and
   the meter called that growth and raised two incidents.

   Nothing had grown. Every reading since has been 0.00, including the 10:38
   run that covered real movement: 77.20 of drops, 17.75 of sweeps and 700.00
   of payouts on one pool, 118.85 of drops and 27.57 of sweeps on the other.

   The ledger replay already learned this lesson and carries basis_version for
   exactly this reason. The BBJ meter does not, so it had no way to know the
   two numbers were not comparable. It does now: a reading records its basis,
   and a reading taken on a different basis from the one before it is recorded
   but never called growth. A write failure still raises on its own, because
   that is a fact about the world and not a comparison. */

DO $ddl$
DECLARE i int;
BEGIN
  FOR i IN 1..25 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      ALTER TABLE public.ca_bbj_pool_snapshots ADD COLUMN IF NOT EXISTS basis_version text;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END
$ddl$;

DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  ------------------------------------------------------------------
  -- The reading records the basis it was taken on.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_reconcile';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_bbj_reconcile is gone'; END IF;
  IF position($chk$basis_version$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'fn_bbj_reconcile already records its basis';
  END IF;
  IF position($chk$     unexplained_main, unexplained_backup, unexplained_promo)$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the snapshot insert moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$     unexplained_main, unexplained_backup, unexplained_promo)$old$,
$new$     unexplained_main, unexplained_backup, unexplained_promo, basis_version)$new$);

  v_new := replace(v_new,
$old$     round((v_promo - v_base.promo) - jp, 2))
  RETURNING * INTO v_row;$old$,
$new$     round((v_promo - v_base.promo) - jp, 2),
     -- THE READING SAYS WHAT IT MEASURED. Change the arithmetic above and
     -- change this string with it: fn_bbj_reconcile_all refuses to call a
     -- reading growth when the reading before it was taken on another basis.
     'cumulative-since-open-v1')
  RETURNING * INTO v_row;$new$);

  IF v_new = v_src THEN RAISE EXCEPTION 'fn_bbj_reconcile did not learn to record its basis'; END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  -- Growth is only growth against a comparable reading.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_reconcile_all';
  IF position($chk$basis_version$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'fn_bbj_reconcile_all already checks the basis';
  END IF;
  IF position($chk$    v_prev_cum := COALESCE(CASE WHEN prev.is_baseline THEN 0$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the growth comparison moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$    v_prev_cum := COALESCE(CASE WHEN prev.is_baseline THEN 0
                                ELSE prev.unexplained_main + prev.unexplained_backup + prev.unexplained_promo END, 0);$old$,
$new$    /* NOT COMPARABLE IS NOT GROWTH (2026-09-09). prev may have been taken
       before this meter changed what it measures. Two numbers from two
       different bases say nothing about each other, and calling the
       difference growth is how the basis change of 10:21 today raised two
       incidents against pools that had not moved. When the bases differ the
       reading is recorded and the growth test is skipped for that one run;
       the next run has a comparable predecessor and the test resumes. A
       write failure is a fact rather than a comparison, so it still raises
       on its own below. */
    v_comparable := (prev.id IS NOT NULL AND NOT prev.is_baseline
                     AND prev.basis_version IS NOT DISTINCT FROM s.basis_version);
    v_prev_cum := COALESCE(CASE WHEN prev.is_baseline THEN 0
                                ELSE prev.unexplained_main + prev.unexplained_backup + prev.unexplained_promo END, 0);$new$);

  v_new := replace(v_new,
$old$    IF (abs(v_two) > 0.01 AND abs(v_two) > abs(v_prev_cum) AND sign(v_two) = COALESCE(NULLIF(sign(v_prev_cum), 0), sign(v_two)))
       OR s.write_failures > 0 THEN$old$,
$new$    IF (v_comparable AND abs(v_two) > 0.01 AND abs(v_two) > abs(v_prev_cum)
        AND sign(v_two) = COALESCE(NULLIF(sign(v_prev_cum), 0), sign(v_two)))
       OR s.write_failures > 0 THEN$new$);

  v_new := replace(v_new,
$old$  v_out jsonb := '[]'::jsonb; v_two numeric; v_prev_cum numeric := 0;$old$,
$new$  v_out jsonb := '[]'::jsonb; v_two numeric; v_prev_cum numeric := 0; v_comparable boolean := false;$new$);

  IF v_new = v_src THEN RAISE EXCEPTION 'fn_bbj_reconcile_all did not learn the basis rule'; END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname IN ('fn_bbj_reconcile','fn_bbj_reconcile_all')
         AND position($chk$basis_version$chk$ IN pg_get_functiondef(p.oid)) > 0) <> 2 THEN
    RAISE EXCEPTION 'the basis rule did not reach both halves of the meter';
  END IF;
END
$mig$;;
