-- 20260925130241_the_escrow_ttl_sweep_reads_the_real_status_domain.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- A DETECTOR THAT LOOKS FOR A VALUE ITS TABLE CANNOT HOLD IS A DETECTOR THAT
-- IS SWITCHED OFF
-- ===========================================================================
--
-- THE DEFECT, measured on production 2026-09-25 12:52 to 13:02 UTC.
--
-- public.fn_ca_escrow_ttl_sweep(), installed by 20260831160515_ca_zero_drift
-- _phase1_watchdogs and driven by cron job ca-escrow-ttl-sweep-10m every ten
-- minutes, scans for expired escrow holds with:
--
--     WHERE status = 'active' AND expires_at IS NOT NULL
--
-- `active` is not in the table's status domain and never has been:
--
--   chip_escrow_holds_status_check   CHECK (status = ANY (ARRAY['held',
--                                     'released','captured','expired']))
--   chip_escrow_holds.status DEFAULT 'held'::text
--
-- Every other reader of this table agrees on the real value. The tournament
-- refund door reads `status = 'held'`; fn_remove_settled_club_member and
-- fn_retire_settled_club both gate on `status = 'held'`. Only the watchdog
-- looks for `active`, so its loop body has never executed once. Its cron job
-- has run 2,054 times since 2026-09-11 06:40 UTC, every one of them
-- `succeeded`, every one of them over zero rows.
--
-- WHAT IT WAS MEANT TO SEE, and did not:
--
--   chip_escrow_holds rows, status 'held'                               166
--   of those, expires_at more than 10 minutes in the past              166
--   chips they carry                                            3,778,600
--   expires_at range                 2026-08-16 20:55:53 .. 2026-08-17 00:26:30
--   distinct owners (auth.users)                                         51
--   distinct things they secured (public.tables)                         37
--   status of all 37 of those tables                                 closed
--   rows the OLD predicate matches, at any time                            0
--
-- Both owning clubs (Club JAQK 128 / 3,456,000 and SHARK CLUB 38 / 322,600)
-- sit inside the Midway union, so every one of these findings clears
-- fn_ca_is_midway_scope and will actually file.
--
-- THIS SWEEP HAS NEVER MOVED A CHIP AND STILL DOES NOT. It calls exactly one
-- thing, fn_ca_raise_drift_incident, and returns a count. It is an OBSERVER,
-- which is what 20260831160515's own header calls it ("Escrow TTL sweeper:
-- expired-but-active holds raise incidents"). This migration repairs its
-- predicate. It does not teach it to pay, release, capture or expire anything,
-- because CLAUDE.md 10.12 forbids exactly that: a scheduled job may not become
-- the thing that settles what a live path should have settled.
--
-- WHY THESE 166 ARE NOT RELEASED HERE, and what is actually owed.
--
-- Measured: NO wallet_transactions row and NO chip_ledger row anywhere on this
-- database references any chip_escrow_holds id - not one of the 705 rows, held
-- or released. public.chip_escrow is empty. chip_ledger has zero rows in the
-- 2026-08-15 20:00 .. 2026-08-16 01:00 window in which all 705 were written.
-- The 539 siblings that ARE released carry released_reason 'table_unlock' and
-- released_at within seconds of their own created_at, and they too moved no
-- chips. No function on this database sums chip_escrow_holds into a balance,
-- a supply snapshot or a conservation identity. So no player is short by these
-- rows, and nothing here can be credited back without inventing a debit that
-- was never taken. Releasing them would be the double-credit, not the repair.
--
-- What the stranded rows DO block, live, today: fn_remove_settled_club_member
-- refuses each of those 51 members with "Release This Member's Escrow First",
-- and fn_retire_settled_club refuses both clubs. That is a real consequence and
-- it is an owner decision, not a defect this migration may quietly clear: the
-- correct terminal status for a hold whose table closed without unlocking it
-- is 'expired', and writing it is a state transition with no author on record.
-- The repaired detector is what puts that decision on the incident board with
-- the exact rows attached, which is the honest outcome available here.
--
-- THE PER-RUN BOUND IS THE ONE THAT WAS ALREADY THERE. LIMIT 25 stays, and is
-- asserted below. Two things now make the first pass observable rather than a
-- flood: the scan is ORDERed by expires_at so the batch is the oldest 25 and
-- the same 25 on replay (the old LIMIT had no ORDER BY and picked whatever the
-- scan returned), and each finding carries the whole backlog's count and total
-- in its metadata, so the 141 holds outside the batch are visible from any one
-- incident without 141 rows being filed. fn_ca_raise_drift_incident folds a
-- repeat of the same dedupe key onto the existing incident, and caps this
-- source at 25 open rows, so ten minutes from now this is 25 incidents and not
-- 166 - and a NEW expired hold tomorrow is still the newest thing in the batch
-- it belongs to.
--
-- ca_ledger_accounts carried the same phantom: the escrow liability's backing
-- read `chip_escrow_holds.amount (active)`, documenting the liability against a
-- value the table cannot hold. Nothing on this database reads that table (no
-- function, no view), so the correction is documentation of record only.
--
-- @live-proof: (SELECT pg_get_functiondef(oid) FROM pg_proc WHERE oid = 'public.fn_ca_escrow_ttl_sweep()'::regprocedure) LIKE '%status = ''held''%'
-- @live-proof: (SELECT pg_get_functiondef(oid) FROM pg_proc WHERE oid = 'public.fn_ca_escrow_ttl_sweep()'::regprocedure) NOT LIKE '%''active''%'
-- @live-proof: (SELECT pg_get_functiondef(oid) FROM pg_proc WHERE oid = 'public.fn_ca_escrow_ttl_sweep()'::regprocedure) LIKE '%ORDER BY h.expires_at%'
-- @live-proof: (SELECT pg_get_functiondef(oid) FROM pg_proc WHERE oid = 'public.fn_ca_escrow_ttl_sweep()'::regprocedure) LIKE '%LIMIT 25%'
-- @live-proof: (SELECT backing FROM public.ca_ledger_accounts WHERE account_type = 'escrow') = 'chip_escrow_holds.amount (held)'
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. The predicate this repair writes must match the domain the table
--    enforces. If someone widened, narrowed or renamed the status domain
--    between the measurement above and this apply, abort rather than install a
--    second wrong literal.
-- ---------------------------------------------------------------------------
DO $status_domain$
DECLARE v_def text; v_default text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.chip_escrow_holds'::regclass
     AND conname  = 'chip_escrow_holds_status_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'failed: chip_escrow_holds_status_check is absent; the status domain is no longer enforced';
  END IF;
  IF v_def NOT LIKE '%''held''%' THEN
    RAISE EXCEPTION 'failed: chip_escrow_holds_status_check does not admit ''held'' (%)', v_def;
  END IF;
  IF v_def LIKE '%''active''%' THEN
    RAISE EXCEPTION 'failed: chip_escrow_holds_status_check now admits ''active''; re-measure before changing the sweep (%)', v_def;
  END IF;

  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.chip_escrow_holds'::regclass AND a.attname = 'status';
  IF COALESCE(v_default, '') NOT LIKE '%''held''%' THEN
    RAISE EXCEPTION 'failed: chip_escrow_holds.status no longer defaults to ''held'' (%)', COALESCE(v_default, '<none>');
  END IF;

  -- Baselines taken INSIDE this transaction, so step 5 proves what THIS
  -- migration did rather than what the estate happened to look like when it
  -- was written. Transaction-local; nothing survives the COMMIT.
  PERFORM set_config('ca.escrow_ttl_baseline_crons',
                     (SELECT count(*)::text FROM cron.job), true);
  PERFORM set_config('ca.escrow_ttl_baseline_holds',
                     (SELECT count(*)::text FROM public.chip_escrow_holds
                       WHERE status = 'held'), true);
  PERFORM set_config('ca.escrow_ttl_baseline_released',
                     (SELECT count(*)::text FROM public.chip_escrow_holds
                       WHERE status = 'released'), true);
END;
$status_domain$;

-- ---------------------------------------------------------------------------
-- 2. The sweep, with the real status value. Same shape, same single call, same
--    RETURNS int, same SECURITY DEFINER, same per-run LIMIT 25. What is added
--    is a deterministic oldest-first order and, on every finding, the size of
--    the backlog the bound deliberately leaves behind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_ttl_sweep()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
  n int := 0;
  v_expired_holds  bigint  := 0;
  v_expired_amount numeric := 0;
BEGIN
  -- The whole standing backlog, so a bounded batch can still say how much it
  -- is not reporting. Counted under the same predicate the loop uses.
  SELECT count(*), COALESCE(sum(h.amount), 0)
    INTO v_expired_holds, v_expired_amount
    FROM chip_escrow_holds h
   WHERE h.status = 'held' AND h.expires_at IS NOT NULL
     AND h.expires_at < now() - interval '10 minutes';

  FOR r IN
    SELECT * FROM chip_escrow_holds h
     WHERE h.status = 'held' AND h.expires_at IS NOT NULL
       AND h.expires_at < now() - interval '10 minutes'
     ORDER BY h.expires_at, h.id
     LIMIT 25
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_escrow_ttl_sweep', 'settlement_error', 'warning',
      'escrow-expired:' || r.id::text,
      r.amount, r.amount, 0, 'settlement', 'chip_escrow_holds', r.user_id,
      r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'escrow hold (' || r.hold_type || ') expired ' ||
        floor(extract(epoch FROM now() - r.expires_at)/60) || ' min ago but was never released',
      NULL, jsonb_build_object('hold_id', r.id, 'hold_type', r.hold_type,
                               'related_id', r.related_id, 'expires_at', r.expires_at,
                               'expired_holds_total', v_expired_holds,
                               'expired_amount_total', v_expired_amount));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_escrow_ttl_sweep() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A detector that files needs a named owner. This one has no
--    ca_detector_registry row, so its first real finding would auto-register
--    it as 'unassigned'. Its three sibling escrow detectors are owned by
--    "chip standard"; so is this.
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_detector_registry (source, owner, sla_hours, note)
VALUES ('fn_ca_escrow_ttl_sweep', 'chip standard', 24,
        'expired escrow holds: reports, never releases; bounded to 25 oldest per run')
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. The liability is documented against a value that exists.
-- ---------------------------------------------------------------------------
UPDATE public.ca_ledger_accounts
   SET backing = 'chip_escrow_holds.amount (held)'
 WHERE account_type = 'escrow'
   AND backing = 'chip_escrow_holds.amount (active)';

-- ---------------------------------------------------------------------------
-- 5. Prove the end state, precisely enough to be machine-checked.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_src      text;
  v_backing  text;
  v_visible  bigint;
  v_amount   numeric;
  v_phantom  bigint;
  v_held     bigint;
  v_released bigint;
  v_job      record;
  v_crons    bigint;
BEGIN
  v_src := pg_get_functiondef('public.fn_ca_escrow_ttl_sweep()'::regprocedure);

  -- the phantom is gone, in every form
  IF v_src LIKE '%''active''%' THEN
    RAISE EXCEPTION 'failed: the sweep still mentions the phantom status ''active''';
  END IF;
  IF v_src NOT LIKE '%h.status = ''held''%' THEN
    RAISE EXCEPTION 'failed: the sweep does not read status = ''held''';
  END IF;
  -- both the count and the loop must be on the real value: two sites, no more
  IF (length(v_src) - length(replace(v_src, 'h.status = ''held''', ''))) / length('h.status = ''held''') <> 2 THEN
    RAISE EXCEPTION 'failed: the sweep carries % status-held site(s), expected exactly 2',
      (length(v_src) - length(replace(v_src, 'h.status = ''held''', ''))) / length('h.status = ''held''');
  END IF;

  -- the per-run bound survives, and the batch is deterministic
  IF v_src NOT LIKE '%LIMIT 25%' THEN
    RAISE EXCEPTION 'failed: the sweep lost its per-run bound of 25';
  END IF;
  IF v_src NOT LIKE '%ORDER BY h.expires_at, h.id%' THEN
    RAISE EXCEPTION 'failed: the sweep''s bounded batch is not ordered oldest-first, so it is not the same batch twice';
  END IF;
  IF v_src NOT LIKE '%expired_holds_total%' OR v_src NOT LIKE '%expired_amount_total%' THEN
    RAISE EXCEPTION 'failed: a bounded batch that does not report the backlog it left behind hides it';
  END IF;

  -- it still only observes: no money door was opened in this body
  IF v_src ~* 'UPDATE[[:space:]]+(public\.)?(wallets|chip_escrow_holds|club_members|clubs)'
     OR v_src ~* 'INSERT[[:space:]]+INTO[[:space:]]+(public\.)?(wallet_transactions|chip_ledger|chip_transactions)'
     OR v_src ~* 'DELETE[[:space:]]+FROM[[:space:]]+(public\.)?chip_escrow_holds' THEN
    RAISE EXCEPTION 'failed: the sweep acquired a write path; CLAUDE.md 10.12 forbids a scheduled job settling what a live path owes';
  END IF;

  -- RED -> GREEN on the installed catalogue: the old predicate saw nothing,
  -- the new one sees the measured backlog.
  SELECT count(*) INTO v_phantom FROM public.chip_escrow_holds
   WHERE status = 'active' AND expires_at IS NOT NULL
     AND expires_at < now() - interval '10 minutes';
  IF v_phantom <> 0 THEN
    RAISE EXCEPTION 'failed: the phantom predicate matched % row(s); the premise of this repair is wrong', v_phantom;
  END IF;
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_visible, v_amount
    FROM public.chip_escrow_holds
   WHERE status = 'held' AND expires_at IS NOT NULL
     AND expires_at < now() - interval '10 minutes';
  IF v_visible = 0 THEN
    RAISE EXCEPTION 'failed: the repaired predicate sees nothing, so this apply proves nothing';
  END IF;

  -- This migration settles nothing. Two questions, both asked:
  --   (a) did THIS transaction move a hold out of 'held'? and
  --   (b) is the population still the one the header measured?
  SELECT count(*) FILTER (WHERE status = 'held'),
         count(*) FILTER (WHERE status = 'released')
    INTO v_held, v_released
    FROM public.chip_escrow_holds;
  IF v_held::text <> current_setting('ca.escrow_ttl_baseline_holds', true)
     OR v_released::text <> current_setting('ca.escrow_ttl_baseline_released', true) THEN
    RAISE EXCEPTION 'failed: this transaction changed chip_escrow_holds from %/% to %/% held/released; it must move no hold',
      current_setting('ca.escrow_ttl_baseline_holds', true),
      current_setting('ca.escrow_ttl_baseline_released', true), v_held, v_released;
  END IF;
  IF v_held <> 166 OR v_released <> 539 THEN
    RAISE EXCEPTION 'failed: chip_escrow_holds reads % held / % released, measured 166 / 539 on 2026-09-25; re-measure and re-review the release question before installing',
      v_held, v_released;
  END IF;

  -- the documented backing names a value the table can hold
  SELECT backing INTO v_backing FROM public.ca_ledger_accounts WHERE account_type = 'escrow';
  IF v_backing <> 'chip_escrow_holds.amount (held)' THEN
    RAISE EXCEPTION 'failed: the escrow liability is still backed by %', COALESCE(v_backing, '<no row>');
  END IF;

  -- the existing schedule is the one that runs it, unchanged, and NOTHING was
  -- added: no new cron, watcher, reconciler or repair loop (CLAUDE.md 10.12).
  SELECT * INTO v_job FROM cron.job WHERE jobname = 'ca-escrow-ttl-sweep-10m';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'failed: ca-escrow-ttl-sweep-10m is gone; the repaired sweep has no driver';
  END IF;
  IF NOT v_job.active OR v_job.schedule <> '*/10 * * * *' THEN
    RAISE EXCEPTION 'failed: ca-escrow-ttl-sweep-10m is % on schedule %', v_job.active, v_job.schedule;
  END IF;
  SELECT count(*) INTO v_crons FROM cron.job;
  IF v_crons::text <> current_setting('ca.escrow_ttl_baseline_crons', true) THEN
    RAISE EXCEPTION 'failed: cron.job went from % rows to %; this migration must add and remove none',
      current_setting('ca.escrow_ttl_baseline_crons', true), v_crons;
  END IF;
  IF v_src ~* 'cron\.(schedule|unschedule|alter_job)' THEN
    RAISE EXCEPTION 'failed: the sweep body now schedules work of its own';
  END IF;

  -- and the first weekly book is not on this path
  IF (SELECT earliest_period_start FROM public.union_settlement_floor
       WHERE union_id = 'fade0000-0000-0000-0000-000000000001')
     <> timestamptz '2026-09-21T07:00:00Z' THEN
    RAISE EXCEPTION 'failed: the union discovery cursor moved';
  END IF;
  IF (SELECT earliest_period_start FROM public.club_settlement_floor
       WHERE club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')
     <> timestamptz '2026-09-21T07:00:00Z' THEN
    RAISE EXCEPTION 'failed: the club discovery cursor moved';
  END IF;

  RAISE NOTICE 'PASS: fn_ca_escrow_ttl_sweep reads status=held and now sees % expired hold(s) carrying % chips (bound 25/run, oldest first); % held / % released rows untouched; escrow backing documented as held; % cron rows, cursors 2026-09-21T07:00Z',
    v_visible, v_amount, v_held, v_released, v_crons;
END;
$verify$;

COMMIT;
