-- GREEN: run AFTER the candidate migration on the same cluster.
--
-- Proves, in order: the repaired sweep sees the expired holds; the per-run
-- bound is respected; the batch is the oldest 25; a finding carries the whole
-- backlog; the four wrong-status decoys and the unexpired hold are refused; an
-- out-of-scope hold files nothing; a replay is idempotent; and NOTHING was
-- released, credited or journalled by any of it.
BEGIN;

DO $green$
DECLARE
  v_n1 int; v_n2 int;
  v_inc bigint; v_inc2 bigint;
  v_occ bigint;
  v_total bigint; v_amount numeric;
  v_batch_min timestamptz; v_batch_max timestamptz;
  v_bad bigint;
  f record; a record;
BEGIN
  SELECT * INTO f FROM public.zz_escrow_rehearsal_fingerprint;

  DELETE FROM public.ca_incident_events;
  DELETE FROM public.ca_drift_incidents;

  -- ── 1. it sees them, and the per-run bound holds ────────────────────────
  v_n1 := public.fn_ca_escrow_ttl_sweep();
  IF v_n1 <> 25 THEN
    RAISE EXCEPTION 'GREEN FAIL: the sweep scanned % rows, expected exactly its bound of 25', v_n1;
  END IF;

  -- ── 2. one incident per in-scope hold in the batch; the out-of-scope hold
  --       is in the batch and files nothing (fn_ca_is_midway_scope) ─────────
  SELECT count(*) INTO v_inc FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_ttl_sweep' AND dedupe_key LIKE 'escrow-expired:%';
  IF v_inc <> 24 THEN
    RAISE EXCEPTION 'GREEN FAIL: % incidents filed from a 25-row batch holding 1 out-of-scope hold, expected 24', v_inc;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents
              WHERE dedupe_key = 'escrow-expired:e50f0000-0000-0000-0000-000000000099') THEN
    RAISE EXCEPTION 'GREEN FAIL: an out-of-scope club''s hold was filed';
  END IF;

  -- ── 3. the batch is the OLDEST 25 by expires_at, deterministically ──────
  SELECT min(h.expires_at), max(h.expires_at) INTO v_batch_min, v_batch_max
    FROM public.chip_escrow_holds h
   WHERE 'escrow-expired:' || h.id::text IN (
           SELECT dedupe_key FROM public.ca_drift_incidents
            WHERE source = 'fn_ca_escrow_ttl_sweep');
  IF EXISTS (
    SELECT 1 FROM public.chip_escrow_holds h
     WHERE h.status = 'held' AND h.expires_at < now() - interval '10 minutes'
       AND h.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
       AND h.expires_at < v_batch_max
       AND 'escrow-expired:' || h.id::text NOT IN (
             SELECT dedupe_key FROM public.ca_drift_incidents
              WHERE source = 'fn_ca_escrow_ttl_sweep')) THEN
    RAISE EXCEPTION 'GREEN FAIL: an in-scope hold older than the batch''s newest member was skipped; the batch is not oldest-first';
  END IF;

  -- ── 4. every finding carries the backlog the bound left behind ───────────
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_total, v_amount
    FROM public.chip_escrow_holds
   WHERE status = 'held' AND expires_at < now() - interval '10 minutes';
  SELECT count(*) INTO v_bad FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_ttl_sweep'
     AND ( (metadata->>'expired_holds_total')::bigint  IS DISTINCT FROM v_total
        OR (metadata->>'expired_amount_total')::numeric IS DISTINCT FROM v_amount );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'GREEN FAIL: % incident(s) do not report the standing backlog (% holds / % chips)', v_bad, v_total, v_amount;
  END IF;

  -- ── 5. the identity of a finding: amount, owner, club, entity ────────────
  SELECT * INTO a FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_ttl_sweep' ORDER BY dedupe_key LIMIT 1;
  IF a.entity_type <> 'chip_escrow_holds' OR a.layer <> 'settlement'
     OR a.classification <> 'settlement_error' OR a.severity <> 'warning' THEN
    RAISE EXCEPTION 'GREEN FAIL: a finding lost its identity (% / % / % / %)',
      a.entity_type, a.layer, a.classification, a.severity;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.chip_escrow_holds h
     WHERE h.id = (a.metadata->>'hold_id')::uuid
       AND h.user_id = a.entity_id AND h.club_id = a.club_id
       -- the installed argument order: discrepancy = expected = the held
       -- amount, actual = 0, i.e. "these chips are owed and none came back"
       AND h.amount = a.discrepancy_amount
       AND h.amount = a.expected_amount
       AND a.actual_amount = 0) THEN
    RAISE EXCEPTION 'GREEN FAIL: a finding does not name its own hold''s owner, club and amount (owner %, club %, expected %, actual %, discrepancy %)',
      a.entity_id, a.club_id, a.expected_amount, a.actual_amount, a.discrepancy_amount;
  END IF;

  -- ── 6. nothing whose status is not 'held', and nothing unexpired, filed ──
  IF EXISTS (
    SELECT 1 FROM public.ca_drift_incidents i
      JOIN public.chip_escrow_holds h ON h.id = (i.metadata->>'hold_id')::uuid
     WHERE i.source = 'fn_ca_escrow_ttl_sweep'
       AND (h.status <> 'held' OR h.expires_at >= now() - interval '10 minutes')) THEN
    RAISE EXCEPTION 'GREEN FAIL: a released, captured, expired or unexpired hold was reported';
  END IF;

  -- ── 7. replay is idempotent: same bound, same rows, occurrences advance ──
  v_n2 := public.fn_ca_escrow_ttl_sweep();
  IF v_n2 <> 25 THEN
    RAISE EXCEPTION 'GREEN FAIL: the replay scanned % rows, expected the same bound of 25', v_n2;
  END IF;
  SELECT count(*) INTO v_inc2 FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_ttl_sweep' AND dedupe_key LIKE 'escrow-expired:%';
  IF v_inc2 <> v_inc THEN
    RAISE EXCEPTION 'GREEN FAIL: a replay filed % incidents where the first pass filed %', v_inc2, v_inc;
  END IF;
  SELECT min(occurrences) INTO v_occ FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_ttl_sweep' AND dedupe_key LIKE 'escrow-expired:%';
  IF v_occ < 2 THEN
    RAISE EXCEPTION 'GREEN FAIL: a replay did not fold onto the open incident (min occurrences %)', v_occ;
  END IF;

  -- ── 8. AND IT RELEASED NOTHING. Two sweeps, no hold moved status, no chip
  --       credited, no ledger leg written. A hold that must not be released is
  --       refused because this detector has no release path at all. ──────────
  IF (SELECT count(*) FROM public.chip_escrow_holds) <> f.holds
     OR (SELECT count(*) FROM public.chip_escrow_holds WHERE status = 'held')     <> f.held
     OR (SELECT count(*) FROM public.chip_escrow_holds WHERE status = 'released') <> f.released
     OR (SELECT count(*) FROM public.chip_escrow_holds WHERE status = 'captured') <> f.captured
     OR (SELECT count(*) FROM public.chip_escrow_holds WHERE status = 'expired')  <> f.expired
     OR (SELECT md5(string_agg(id::text || status || amount::text, ',' ORDER BY id))
           FROM public.chip_escrow_holds) <> f.holds_hash THEN
    RAISE EXCEPTION 'GREEN FAIL: the sweep changed chip_escrow_holds';
  END IF;
  IF (SELECT COALESCE(sum(balance), 0) FROM public.wallets) <> f.wallet_total THEN
    RAISE EXCEPTION 'GREEN FAIL: the sweep moved chips into a wallet';
  END IF;
  IF (SELECT count(*) FROM public.wallet_transactions) <> f.wt_rows
     OR (SELECT count(*) FROM public.chip_ledger) <> f.cl_rows THEN
    RAISE EXCEPTION 'GREEN FAIL: the sweep wrote a money journal row';
  END IF;

  -- ── 9. the liability is documented against a value the table can hold ────
  IF (SELECT backing FROM public.ca_ledger_accounts WHERE account_type = 'escrow')
     <> 'chip_escrow_holds.amount (held)' THEN
    RAISE EXCEPTION 'GREEN FAIL: the escrow backing still names a phantom status';
  END IF;

  -- ── 10. no new schedule, and the Sept 28 cursors are where they were ─────
  IF (SELECT count(*) FROM cron.job) <> 2
     OR NOT EXISTS (SELECT 1 FROM cron.job
                     WHERE jobname = 'ca-escrow-ttl-sweep-10m'
                       AND active AND schedule = '*/10 * * * *') THEN
    RAISE EXCEPTION 'GREEN FAIL: the schedule surface changed';
  END IF;
  IF (SELECT earliest_period_start FROM public.union_settlement_floor
       WHERE union_id = 'fade0000-0000-0000-0000-000000000001') <> timestamptz '2026-09-21T07:00:00Z'
     OR (SELECT earliest_period_start FROM public.club_settlement_floor
       WHERE club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3') <> timestamptz '2026-09-21T07:00:00Z' THEN
    RAISE EXCEPTION 'GREEN FAIL: a weekly discovery cursor moved';
  END IF;

  RAISE NOTICE 'GREEN PASS: 2 sweeps x bound 25 over % expired held holds (% chips) -> % incidents, oldest-first, backlog reported, replay folded (min occurrences %), zero holds moved, zero chips credited, zero journal rows, cursors 2026-09-21T07:00Z',
    v_total, v_amount, v_inc2, v_occ;
END;
$green$;

ROLLBACK;
