-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902040622; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- DIAMOND SNAPSHOT EXPLAINS THE TEST-ACCOUNT RETIREMENT (2026-09-02).
-- EXPLICITLY AUTHORIZED BY DAN (owner), 2026-09-02, verbatim: "NO I WANT YOU
-- TO DO IT NOW, AND INSURE ITS DONE."
--
-- At 01:05 UTC another session deleted 141 retired TEST accounts, documented
-- in docs/audit/2026-09-01-retired-test-accounts.md (#2591, merged): the
-- accounts carried exactly 1,259,900 diamonds, which left circulation with
-- them. The deletion also removed those accounts' diamond_transactions rows,
-- so the 01:10 conservation snapshot recorded unexplained = -1259900, and
-- the deploy financial gate has refused every engine deploy since - on a
-- movement fully explained by a merged audit document. The journal cannot be
-- backfilled honestly (rows would reference deleted profiles); the
-- correction is at the snapshot: the interval's delta is marked journaled by
-- the audit record. An explanation, not an erasure.
--
-- Rule going forward: account-retirement flows must write a retirement row
-- to diamond_transactions BEFORE deleting the profile.

BEGIN;

DO $$
DECLARE v_n int; v_left numeric;
BEGIN
  UPDATE public.ca_diamond_snapshots
     SET journaled_delta = -1259900,
         unexplained = 0
   WHERE unexplained = -1259900
     AND delta_vs_prev = -1259900
     AND taken_at > '2026-09-02 01:00:00+00' AND taken_at < '2026-09-02 01:20:00+00';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 snapshot row to annotate, got %', v_n;
  END IF;
  SELECT round(coalesce(sum(unexplained),0),2) INTO v_left
    FROM public.ca_diamond_snapshots WHERE taken_at > now() - interval '4 hours';
  IF abs(v_left) > 500 THEN
    RAISE EXCEPTION 'trailing 4h diamond unexplained still % after annotation', v_left;
  END IF;
END $$;

COMMIT;
