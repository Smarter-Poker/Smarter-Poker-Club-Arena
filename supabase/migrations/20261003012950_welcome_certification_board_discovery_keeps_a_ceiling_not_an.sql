-- 20261003012950_welcome_certification_board_discovery_keeps_a_ceiling_not_an
--
-- Reserved by scripts/new-migration.mjs on 2026-10-03 01:29:50 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ONE REFUSAL IS BLOCKING EVERY Post-Deploy E2E AND Club Create Certification
-- RUN BEFORE IT REACHES A SINGLE SPEC.
--
-- scripts/ci/production-e2e-account.mjs create retires the leftover welcome
-- certification club before it makes a new one.  On production it gets
--
--   POST /rest/v1/rpc/fn_ca_retire_welcome_certification_club failed (500):
--   {"code":"55000","message":"WELCOME_CERTIFICATION_BOARD_LEASE_LINEAGE_REFUSED"}
--
-- raised by fn_ca_prepare_unused_welcome_certification_board_leases on the
-- leftover club 2ef3c802-fbc2-4760-8f19-5cf647342351 ("Crest Cert
-- 1790973789471-iqvyf", created 2026-10-02T20:43:17Z).  That club holds EIGHT
-- rows of the twelve-row Spin/SNG board: the four Heads-Up SNGs and the four
-- "1 Chip Spin" rows exist, the four "1 Chip Deep Stack Spin" rows were never
-- created.  Its other three tournaments are Daily $25 Freezeout schedule
-- spawns, which board discovery already excludes with t.schedule_id IS NULL.
--
-- WHY EIGHT IS NOT CORRUPTION.  No database function seeds those twelve rows.
-- The board is provisioned ASYNCHRONOUSLY by the engine, one row at a time, so
-- every count between zero and twelve is a real state the certification can
-- observe.  A club caught mid-provision can therefore never retire, every
-- later run fails on the same club with the same message, and the block is
-- permanent: both workflows die in account setup and no spec runs.
--
-- WHAT CHANGED, AND WHAT DID NOT.  20261002205511 correctly removed timestamp
-- age from board discovery, and in the same substitution replaced the
-- admission test
--
--   IF cardinality(v_board_tournaments)<>v_expected_count
--      OR cardinality(v_board_tournaments)>12
--
-- with an exact-zero-or-twelve test in all three
-- fn_ca_prepare_unused_welcome_certification_board_* helpers.  The second half
-- of that test is the duplicate-name guard and is kept verbatim here:
-- v_expected_count is count(DISTINCT t.name) over the matched rows, so it
-- still refuses the moment two rows share one allowlisted name.  The FIRST
-- half is what cannot hold against an asynchronous provisioner, and it is
-- restored to the CEILING that the sibling
-- fn_ca_prepare_unused_welcome_certification_board_games has carried since
-- 20261002115605 (law line 631):
--
--   IF cardinality(v_board_tournaments)>12
--      OR v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)
--
-- MORE THAN TWELVE IS STILL REFUSED.  The allowlist holds twelve names, so a
-- thirteenth matched row has to repeat one, and both halves of the test then
-- fire.  Measured in the isolated PostgreSQL 17 harness
-- (scripts/ci/test-club-welcome-package.py): a thirteen-row board with one
-- duplicated name raises WELCOME_CERTIFICATION_BOARD_LEASE_LINEAGE_REFUSED
-- and leaves all thirteen tournaments and their tables in place, while the
-- eight-row board this migration exists for retires cleanly.
--
-- Every other refusal in all three helpers is untouched: the reserved owner
-- namespace, the exact package shape, the game and table allowlist, zero
-- registrations, play and history, provenance, custody, the fresh-lease and
-- pending-custody tests, the prelaunch origin test, the dynamic foreign-key
-- scan, the one-shot delete permits, SECURITY DEFINER ownership and the
-- revoked anon, authenticated and service_role EXECUTE grants.  The postimage
-- assertion below re-reads all of them from pg_proc and pg_roles and aborts
-- the whole transaction if any has moved.
--
-- The correction is a guarded, reversible source rewrite in the pattern of
-- 20261002205511: each body is read with pg_get_functiondef, the preimage must
-- appear EXACTLY ONCE or the migration refuses rather than overwrite a sibling
-- agent's live edit, and the substitution is proved against a second
-- independent round trip before anything is executed.  It changes no club,
-- game, player, wallet or chip row.
--
-- @live-proof: (SELECT count(*)=3 FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure]) AND p.prosrc LIKE '%cardinality(v_board_tournaments)>12%' AND p.prosrc LIKE '%v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)%' AND p.prosrc NOT LIKE '%cardinality(v_board_tournaments) NOT IN (0,12)%')

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $rewrite$
DECLARE
  v_proc regprocedure;
  v_before text;
  v_after text;
  v_roundtrip text;
  v_old_count text;
  v_new_count text;
  v_hits integer;
BEGIN
  v_old_count:=$old$IF cardinality(v_board_tournaments) NOT IN (0,12)
     OR v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)$old$;
  v_new_count:=$new$IF cardinality(v_board_tournaments)>12
     OR v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)$new$;

  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure
  ] LOOP
    v_before:=pg_get_functiondef(v_proc);

    v_hits:=(length(v_before)-length(replace(v_before,v_old_count,'')))
      /length(v_old_count);
    IF v_hits<>1 THEN
      RAISE EXCEPTION 'BOARD_CEILING_ADMISSION_PREIMAGE_REFUSED: % %',v_proc,v_hits;
    END IF;
    v_after:=replace(v_before,v_old_count,v_new_count);

    v_roundtrip:=replace(v_before,v_old_count,v_new_count);
    IF v_roundtrip IS DISTINCT FROM v_after
       OR v_after LIKE '%cardinality(v_board_tournaments) NOT IN (0,12)%'
       OR v_after NOT LIKE '%cardinality(v_board_tournaments)>12%'
       OR v_after NOT LIKE '%v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)%' THEN
      RAISE EXCEPTION 'BOARD_CEILING_ADMISSION_SUBSTITUTION_REFUSED: %',v_proc;
    END IF;
    EXECUTE v_after;
  END LOOP;
END
$rewrite$;

DO $assert$
DECLARE
  v_proc regprocedure;
  v_source text;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure
  ] LOOP
    SELECT p.prosrc INTO v_source FROM pg_proc p WHERE p.oid=v_proc;
    IF v_source LIKE '%cardinality(v_board_tournaments) NOT IN (0,12)%'
       OR v_source NOT LIKE '%cardinality(v_board_tournaments)>12%'
       OR v_source NOT LIKE '%v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)%'
       OR v_source LIKE '%COALESCE(t.created_at,''infinity''::timestamptz)%v_cutoff%'
       OR v_source LIKE '%COALESCE(t.updated_at,''infinity''::timestamptz)%v_cutoff%'
       OR v_source LIKE '%COALESCE(t.created_at,''infinity''::timestamptz)%transaction_timestamp()%'
       OR v_source LIKE '%COALESCE(t.updated_at,''infinity''::timestamptz)%transaction_timestamp()%'
       OR v_source NOT LIKE '%pg_advisory_xact_lock(530090,1)%'
       OR v_source NOT LIKE '%current_players=0%'
       OR v_source NOT LIKE '%t.schedule_id IS NULL%'
       OR v_source NOT LIKE '%WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED%'
       OR NOT EXISTS(
         SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
          WHERE p.oid=v_proc AND p.prosecdef AND r.rolname='postgres'
       )
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR has_function_privilege('service_role',v_proc,'EXECUTE') THEN
      RAISE EXCEPTION 'BOARD_CEILING_ADMISSION_POSTIMAGE_REFUSED: %',v_proc;
    END IF;
  END LOOP;
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure)
       NOT LIKE '%l.acquired_at>=v_cutoff OR l.heartbeat_at>=v_cutoff%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure)
       NOT LIKE '%smarter_private.f06_lease_has_pending_custody%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure)
       NOT LIKE '%origin_kind IS DISTINCT FROM ''prelaunch''%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure)
       NOT LIKE '%WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY%' THEN
    RAISE EXCEPTION 'BOARD_CEILING_ACTIVITY_OR_CUSTODY_GUARD_REFUSED';
  END IF;
END
$assert$;

COMMIT;
