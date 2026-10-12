-- 20261002171027_the_xid_restorer_reads_xmax_and_reading_779_is_acknowledged.sql
--
-- Version reserved by scripts/reserve-migration-version.sh against this tree,
-- origin/main and every sibling worktree.
--
-- THE XID RESTORER READS XMAX, AND READING 779 IS ACKNOWLEDGED (2026-10-02)
--
-- Follows 20261002164500 (PR #5838, the_supply_meter_counts_a_leg_that_commits
-- _after_its_reading), which fixed the meter that read -100,005.30 at 15:05 UTC
-- and resolved its incidents. Two things it left, both read from rows:
--
-- 1. fn_ca_xid8 RESTORES AN EPOCH AGAINST THE WRONG END OF THE SNAPSHOT.
--    It is the helper the ledger replay (fn_ca_leg_accounts_since_snapshot)
--    uses to ask "was this leg visible to the previous reading?". It took its
--    epoch reference from the snapshot's XMIN, so every xid newer than the
--    oldest running transaction fell into its ELSE branch, ((epoch-1) << 32)
--    + x, which in epoch 0 is negative and wraps to "the future". Measured
--    live 2026-10-02 16:4x UTC: fn_ca_xid8(xmin + 5) = 18446744070211823064.
--    A leg the previous reading HAD seen is therefore judged unseen and
--    counted again whenever any transaction older than it is still open at
--    the next reading (after a wraparound the same branch errs the other way:
--    one epoch too old, always "seen", never counted). Every tuple a statement
--    can see has an xmin below its snapshot's XMAX, so XMAX is the reference:
--    the epoch of xmax for any xmin below its low 32 bits, the epoch before
--    for any above them.
--
-- 2. READING 779 STILL READS -100,005.30 AND IS AN UNACKNOWLEDGED BREACH.
--    20261002164500 restated the window the late leg belongs to (778:
--    restated_burn 902,036.92) but left 779 as recorded, so
--    fn_ca_unacknowledged_supply_breaches() lists it, fn_audit_supply_breaches
--    files it as a critical "supply_breach_unacknowledged" for ever, and the
--    trailing-4h figure the production integrity audit gates on stays at
--    -99,99x until 19:05. Under 20261002164500's own model a late leg belongs
--    to the reading in which its balance first changes: the 100,000.00
--    certification retirement (club 43731738-e631-4e27-8c9c-ffb9dbedc706,
--    chain_seq 10378746/10378747/10378749, stamped 14:04:56.066378, inserted
--    after 14:05:13) is 779's late_burn, and 779 reads
--    -100,005.30 + 100,000.00 = -5.30. The original stays in
--    ca_supply_snapshot_classifications and the breach is acknowledged.
--    No chip moved: the legs are posted, hash-chained, and retired chips the
--    certification club had been issued.
--
-- Wrap ALL DDL for one change in ONE transaction (CLAUDE.md production DDL
-- policy). Refused inside the hourly break window by the database itself.
--
-- @live-proof: position('pg_snapshot_xmax' in pg_get_functiondef('public.fn_ca_xid8(xid)'::regprocedure)) > 0
-- @live-proof: (SELECT round(unexplained, 2) FROM public.ca_supply_snapshots WHERE id = 779) = -5.30
-- @live-proof: (SELECT count(*) FROM public.ca_supply_breach_ack WHERE snapshot_id = 779) = 1

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE
  v_reason text;
  r record;
  v_legs numeric;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'XID_RESTORER_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;

  IF md5(pg_get_functiondef('public.fn_ca_xid8(xid)'::regprocedure)) <> '644a8e1d8ac03a3579adbbd8f5d15a79' THEN
    RAISE EXCEPTION 'fn_ca_xid8 changed since this migration was written; re-read it before applying';
  END IF;

  -- 20261002164500 is installed: 778 carries the restated window
  IF NOT EXISTS (SELECT 1 FROM public.ca_supply_snapshots WHERE id = 778 AND restated_burn = 902036.92) THEN
    RAISE EXCEPTION 'reading 778 is not restated to 902036.92; 20261002164500 must be installed first';
  END IF;

  SELECT * INTO r FROM public.ca_supply_snapshots WHERE id = 779;
  IF r.id IS NULL OR r.taken_at <> '2026-10-02 15:05:01.719765+00'::timestamptz
     OR round(r.unexplained, 2) <> -100005.30 OR r.late_burn IS NOT NULL OR r.late_mint IS NOT NULL THEN
    RAISE EXCEPTION 'reading 779 is not the untouched 15:05 -100005.30 reading (got % at %)', r.unexplained, r.taken_at;
  END IF;

  SELECT sum(l.amount) INTO v_legs
    FROM public.chip_ledger l
   WHERE l.chain_seq IN (10378746, 10378747, 10378749)
     AND l.club_id = '43731738-e631-4e27-8c9c-ffb9dbedc706'
     AND l.to_type = 'chip_retirement'
     AND l.created_at = '2026-10-02 14:04:56.066378+00'::timestamptz;
  IF v_legs IS DISTINCT FROM 100000.00 THEN
    RAISE EXCEPTION 'the late retirement legs sum to %, expected 100000.00', v_legs;
  END IF;
END
$pre$;

-- 1. A 32-bit tuple xmin, restored against the snapshot's XMAX.
CREATE OR REPLACE FUNCTION public.fn_ca_xid8(p_xmin xid)
RETURNS xid8
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  /* RESTORED AGAINST XMAX, NOT XMIN (2026-10-02, 20261002170824). Every
     tuple the calling statement can see has an xmin below its snapshot's
     xmax, so the epoch of xmax is the epoch of any xmin below its low 32
     bits, and the one before for any xmin above them (the counter wrapped
     since). Against xmin, every xid newer than the oldest running
     transaction came back as "the future" in epoch 0 and as one epoch too
     old after a wraparound. */
  WITH cur AS (
    SELECT pg_snapshot_xmax(pg_current_snapshot())::text::bigint AS cur64
  ), parts AS (
    SELECT cur64 >> 32 AS epoch, cur64 & 4294967295 AS cur32, p_xmin::text::bigint AS x FROM cur
  )
  SELECT CASE
           /* bootstrap / frozen sentinel: older than everything */
           WHEN x < 3 THEN x
           WHEN x < cur32 THEN (epoch << 32) + x
           /* at or past xmax with no earlier epoch: not yet visible, as it is */
           WHEN epoch = 0 THEN x
           ELSE ((epoch - 1) << 32) + x
         END::text::xid8
    FROM parts;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_xid8(xid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_xid8(xid) TO service_role;

-- 2. Reading 779 carries its late leg; the original is kept and acknowledged.
DO $record$
DECLARE
  v_rows integer;
  v_note CONSTANT text :=
    'Meter blind spot, not a chip movement (20261002164500 fixed the meter). The 100,000.00 certification retirement of club '
    || '43731738-e631-4e27-8c9c-ffb9dbedc706 (chain_seq 10378746/10378747/10378749) was stamped 14:04:56 and committed after '
    || 'the 14:05:00 reading, so its balance first left the supply in reading 779 while its legs sat in window 778. Recorded '
    || 'here as 779 late_burn 100,000.00: 779 reads -5.30. No chip was lost or created; the kill switch only escalated and '
    || 'no payout freeze was opened. migration 20261002170824_the_xid_restorer_reads_xmax_and_reading_779_is_acknowledged';
BEGIN
  INSERT INTO public.ca_supply_snapshot_classifications
    (snapshot_id, original_unexplained, classification, club_id, evidence, classified_at)
  VALUES
    /* club_id stays NULL: it references clubs(id) and the certification club
       no longer exists; it is named in the evidence instead. */
    (779, -100005.30, 'commit_straddled_the_reading', NULL,
     jsonb_build_object(
       'club_id', '43731738-e631-4e27-8c9c-ffb9dbedc706',
       'what', 'a retirement transaction began before the 14:05:00.176 reading and committed after it; its legs fell in window 778 and its balance in reading 779',
       'legs', jsonb_build_array(
         jsonb_build_object('chain_seq', 10378746, 'from_type', 'bbj_pool', 'amount', 100.00),
         jsonb_build_object('chain_seq', 10378747, 'from_type', 'spin_reserve', 'amount', 200.00),
         jsonb_build_object('chain_seq', 10378749, 'from_type', 'club_treasury', 'amount', 99700.00)),
       'legs_created_at', '2026-10-02 14:04:56.066378+00',
       'legs_inserted_between', '2026-10-02 14:05:13.13 and 14:05:13.82 (neighbouring chain_seq rows)',
       'reading_778_burn_recorded', 802036.92,
       'reading_778_restated_burn', 902036.92,
       'late_burn', 100000.00,
       'restated_unexplained', -5.30,
       'meter_fixed_by', '20261002164500_the_supply_meter_counts_a_leg_that_commits_after_its_reading',
       'migration', '20261002170824_the_xid_restorer_reads_xmax_and_reading_779_is_acknowledged'),
     now());

  UPDATE public.ca_supply_snapshots
     SET late_mint = 0, late_burn = 100000.00,
         unexplained = round(unexplained, 2) + 100000.00
   WHERE id = 779 AND round(unexplained, 2) = -100005.30 AND late_burn IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to restate reading 779, restated %', v_rows; END IF;

  INSERT INTO public.ca_supply_breach_ack (snapshot_id, acknowledged_by, reason, acknowledged_at)
  VALUES (779, 'migration 20261002170824_the_xid_restorer_reads_xmax_and_reading_779_is_acknowledged', v_note, now());
END
$record$;

DO $post$
BEGIN
  -- the newest issued xid restores to itself (it came back as "the future")
  IF public.fn_ca_xid8(((pg_snapshot_xmax(pg_current_snapshot())::text::bigint - 1) & 4294967295)::text::xid)::text
     <> (pg_snapshot_xmax(pg_current_snapshot())::text::bigint - 1)::text THEN
    RAISE EXCEPTION 'post-condition: fn_ca_xid8 misrestores the newest issued xid';
  END IF;
  -- and a leg committed hours ago is visible to this snapshot
  IF NOT (SELECT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), pg_current_snapshot())
            FROM public.chip_ledger l WHERE l.chain_seq = 10378749) THEN
    RAISE EXCEPTION 'post-condition: fn_ca_xid8 judges a committed leg invisible';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_unacknowledged_supply_breaches() b WHERE b.snapshot_id = 779) THEN
    RAISE EXCEPTION 'post-condition: reading 779 is still an unacknowledged breach';
  END IF;
END
$post$;

COMMIT;
