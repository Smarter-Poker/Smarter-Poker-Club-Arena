-- ═══════════════════════════════════════════════════════════════════════════
--  A HAND COMMIT HOLDS THE CASH LEASE AGAINST ITS OWN HEARTBEAT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The cash path was left half-way through a fix that was completed for
-- tournaments on 2026-09-10. This finishes it.
--
-- ── READ THIS FIRST: WHAT THIS IS NOT ─────────────────────────────────────
--
-- This was found while chasing a restart loop in which every cash table
-- re-claimed its lease about every twenty seconds. IT IS NOT THE CAUSE OF THAT
-- LOOP, and an earlier draft of this migration said it was. The measurement
-- that refutes it is below. That loop is still open and is engine-side.
--
-- ── WHAT IS ACTUALLY WRONG ────────────────────────────────────────────────
--
-- heartbeat_table_leases_v4 renews with FOR NO KEY UPDATE ... SKIP LOCKED, so
-- it never queues behind a settlement. A row it cannot lock comes back 'busy'
-- and extends nothing, by design.
--
-- fn_ca_commit_hand_settlement_exact_before_obligations locks the lease row
-- before it commits a hand, and for cash it took FOR SHARE, which conflicts
-- with FOR NO KEY UPDATE. For the length of a settlement, that table's
-- heartbeat cannot renew that table's lease.
--
-- Proven against production, on an inert row, twice each, rolled back:
--
--   holder takes FOR SHARE      -> heartbeat saw 0 rows   (skipped -> busy)
--   holder takes FOR KEY SHARE  -> heartbeat saw 1 row    (renews normally)
--
-- ── WHY IT IS NOT THE CAUSE OF THE LOOP ───────────────────────────────────
--
-- Replicating the heartbeat's own probe across the 78 cash lease rows: a mean
-- of 0.63 rows skipped per sample, 0.8% of rows. A lease expires only after
-- FOUR consecutive missed renewals, which at 0.8% is about one chance in two
-- billion, not once every twenty seconds on every table. And on all 78 rows
-- heartbeat_at is exactly equal to acquired_at, so no renewal has ever
-- succeeded for any of them - which is not what intermittent contention looks
-- like. Calling heartbeat_table_leases_v4 by hand with a row's own instance
-- and generation returns 'kept'. The database side is healthy.
--
-- So this is a LATENT hazard. It costs nothing at 0.8% and grows with
-- settlement volume.
--
-- ── THE THIRD EDIT IS THE ONE THAT MATTERS ────────────────────────────────
--
-- The primary key of engine_table_leases is table_id alone, so a takeover (an
-- upsert of instance_id/lease_generation) is a NON-KEY update and takes
-- exactly the same lock strength as the heartbeat. No lock a holder can take
-- will block a takeover and admit a heartbeat: they are indistinguishable at
-- the row-lock level. Exclusion therefore has to be asserted by the takeover,
-- which is what the FOR UPDATE added to claim_table_lease_v2 does, and which
-- claim_tournament_lease_v2 has done since 2026-09-10. Dropping the holders to
-- FOR KEY SHARE WITHOUT that would weaken the cash path rather than fix it.
--
-- ── WHAT IS DELIBERATELY NOT CHANGED ──────────────────────────────────────
--
-- fn_stage_a_bridge_legacy_capacity_receipt takes FOR SHARE on a tournament
-- lease and is the same shape. It is left alone: its predicate requires
-- protocol_version = 1, and there are zero protocol_version = 1 rows in either
-- lease table (78 table leases and 694 tournament leases, all version 2), so
-- it locks nothing and cannot starve any heartbeat today. Changing a legacy
-- cutover path that cannot be exercised buys nothing and risks a handoff I
-- cannot test. If Stage A is ever re-run, it needs this same edit first.
--
-- Every edit below is made by SUBSTITUTION against the live catalogue, not by
-- retyping a money path. Each one asserts its site appears exactly once before
-- it changes anything, and every other guard in each function is asserted to
-- survive.

BEGIN;

-- ── 1. THE TWO HOLDERS: FOR SHARE -> FOR KEY SHARE ────────────────────────

DO $rewrite$
DECLARE
  v_names  CONSTANT text[] := ARRAY[
    'fn_ca_commit_hand_settlement_exact_before_obligations',
    'fn_ca_resolve_unbound_pending_addons'
  ];
  -- Anchored on the cash lease read itself, so the OTHER FOR SHARE in the
  -- settlement (on public.tournaments) and both FOR UPDATEs are out of reach.
  v_pattern CONSTANT text :=
    '(FROM\s+public\.engine_table_leases\s+l\s+WHERE\s+l\.table_id\s*=\s*p_table_id\s+)FOR\s+SHARE;';
  v_name   text;
  v_oid    oid;
  v_def    text;
  v_new    text;
  v_hits   int;
  v_done   int := 0;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name AND p.prokind = 'f';
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'lease lock migration refused: public.% not found', v_name;
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name) <> 1 THEN
      RAISE EXCEPTION 'lease lock migration refused: public.% is overloaded', v_name;
    END IF;

    v_def := pg_get_functiondef(v_oid);

    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, v_pattern, 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION
        'lease lock migration refused: public.% has % cash-lease lock sites, expected exactly 1',
        v_name, v_hits;
    END IF;

    v_new := regexp_replace(v_def, v_pattern, '\1FOR KEY SHARE;');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'lease lock migration refused: rewrite of public.% changed nothing', v_name;
    END IF;

    -- The generation check is the protection that remains once the row lock
    -- stops excluding takeovers. If it is not there, do not ship the weaker lock.
    IF v_new !~ 'v_generation IS DISTINCT FROM p_lease_generation' THEN
      RAISE EXCEPTION
        'lease lock migration refused: public.% has no lease-generation check to fall back on', v_name;
    END IF;
    IF v_new ~ 'engine_table_leases\s+l\s+WHERE\s+l\.table_id\s*=\s*p_table_id\s+FOR\s+SHARE;' THEN
      RAISE EXCEPTION 'lease lock migration refused: public.% still holds FOR SHARE on the cash lease', v_name;
    END IF;

    EXECUTE v_new;
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> 2 THEN
    RAISE EXCEPTION 'lease lock migration refused: rewrote % holders, expected 2', v_done;
  END IF;
END;
$rewrite$;

-- ── 2. THE TAKEOVER ASSERTS ITS OWN EXCLUSION ─────────────────────────────
--
-- Mirrors claim_tournament_lease_v2 (2026-09-10). Without this, dropping the
-- holders to FOR KEY SHARE would let a takeover commit underneath an in-flight
-- settlement instead of waiting for it.

DO $rewrite$
DECLARE
  v_oid     oid;
  v_def     text;
  v_new     text;
  v_hits    int;
  v_pattern CONSTANT text := '(\n)([ \t]*)INSERT INTO public\.engine_table_leases AS l \(';
  v_insert  CONSTANT text :=
$q$
  /* A BUSY TABLE KEEPS ITS LEASE (2026-09-12): the takeover waits for every
     in-flight settlement (they hold FOR KEY SHARE on this row). The upsert
     below only takes FOR NO KEY UPDATE on its own, which FOR KEY SHARE does
     not block - so without this the settlement's lock would exclude nothing.
     This is the cash half of the pair claim_tournament_lease_v2 has had since
     2026-09-10. */
  PERFORM 1 FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id
   FOR UPDATE;

$q$;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'claim_table_lease_v2' AND p.prokind = 'f';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'lease lock migration refused: claim_table_lease_v2 not found';
  END IF;

  v_def := pg_get_functiondef(v_oid);

  IF v_def ~ 'FOR\s+UPDATE' THEN
    RAISE EXCEPTION
      'lease lock migration refused: claim_table_lease_v2 already takes a row lock; re-read it before editing';
  END IF;

  SELECT count(*) INTO v_hits FROM regexp_matches(v_def, v_pattern, 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'lease lock migration refused: claim_table_lease_v2 has % upsert sites, expected exactly 1', v_hits;
  END IF;

  v_new := regexp_replace(v_def, v_pattern, v_insert || '\2INSERT INTO public.engine_table_leases AS l (');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'lease lock migration refused: rewrite of claim_table_lease_v2 changed nothing';
  END IF;

  -- The upsert and the audited stale-window guard must both survive the edit.
  IF v_new !~ 'ON CONFLICT \(table_id\) DO UPDATE' THEN
    RAISE EXCEPTION 'lease lock migration refused: claim_table_lease_v2 lost its upsert';
  END IF;
  IF v_new !~ 'fn_engine_lease_stale_seconds' THEN
    RAISE EXCEPTION 'lease lock migration refused: claim_table_lease_v2 lost its stale-window guard';
  END IF;

  EXECUTE v_new;
END;
$rewrite$;

-- ── 3. THE END STATE, READ BACK FROM THE CATALOGUE ────────────────────────

DO $verify$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND pg_get_functiondef(p.oid)
           ~ 'engine_table_leases\s+l\s+WHERE\s+l\.table_id\s*=\s*p_table_id\s+FOR\s+SHARE;';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'lease lock migration failed: still holding FOR SHARE on a cash lease in %', v_bad;
  END IF;

  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='claim_table_lease_v2' AND p.prokind='f') !~ 'FOR UPDATE'
  THEN
    RAISE EXCEPTION 'lease lock migration failed: claim_table_lease_v2 does not exclude a settlement';
  END IF;

  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='heartbeat_table_leases_v4' AND p.prokind='f')
       !~ 'FOR NO KEY UPDATE OF l SKIP LOCKED'
  THEN
    RAISE EXCEPTION 'lease lock migration failed: the heartbeat is not the protocol this was reasoned against';
  END IF;
END;
$verify$;

COMMIT;
