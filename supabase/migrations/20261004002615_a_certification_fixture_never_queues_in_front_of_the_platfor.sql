-- 20261004002615_a_certification_fixture_never_queues_in_front_of_the_platfor.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CERTIFICATION FIXTURE NEVER QUEUES IN FRONT OF THE PLATFORM (phase 7 of
-- 9: availability and break throughput). Full account:
-- docs/changelog/2026-10-04-a-certification-fixture-never-queues-in-front-of-the-platform.md.
--
-- Advisory lock (530090,1) is the platform's maintenance and entry gate: every
-- buy-in, add-on, rebuy, registration, seat acquisition, tournament launch and
-- blind publish takes it SHARED; the maintenance break (save, claim, clear,
-- thaw) takes it EXCLUSIVE under a 32 s lock_timeout. Four production
-- certification fixtures for the welcome flow also take it EXCLUSIVE, with
-- pg_advisory_xact_lock and no timeout. A waiting exclusive request sits in
-- the lock queue and every later shared request queues behind it, so while a
-- fixture waited, every purchase on the platform waited for it. Postgres lock
-- waits of 1 s or more on this key, 24 h to 00:30 UTC 2026-10-04: about 4,500
-- purchase waits; the only exclusive waiters were these fixtures (79 waits, up
-- to 7.6 s), the break save (10) and the thaw (1). The fixture waits fall in
-- every part of the hour, one or more runs an hour.
--
-- Each fixture now asks for the gate with pg_try_advisory_xact_lock every
-- 50 ms for up to 30 s (a try never joins the lock queue, so no purchase
-- waits behind it) and, once it has the gate, holds it exclusively to the end
-- of its transaction exactly as before. If it cannot get the gate in 30 s it
-- raises CERTIFICATION_FIXTURE_GATE_BUSY (55P03), the same class of error a
-- lock timeout gives. The maintenance break functions are unchanged: they
-- must not be starved, so they keep queueing.
--
-- Applied as substitutions on the md5-pinned live texts (one occurrence each,
-- reverse substitution reproduces the pin, privileges unchanged); every
-- post-image md5 was computed read-only on production beforehand.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure)) = 'c0e56e2aafcf8a21aba03edca44a2268')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  v_sig regprocedure; v_def text; v_old text; v_new text; v_n integer; v_after text; v_acl text;
  v_pin text; v_post text;
BEGIN
  v_old := E'  PERFORM pg_advisory_xact_lock(530090,1);\n';
  v_new := E'  /* A CERTIFICATION FIXTURE NEVER QUEUES IN FRONT OF THE PLATFORM (2026-10-03).\n'
        || E'     Every buy-in, registration, seat and launch takes this gate SHARED. A\n'
        || E'     waiting exclusive request sits in the lock queue and every later shared\n'
        || E'     request queues behind it, so while this fixture waited for the gate the\n'
        || E'     whole platform\'s purchases waited for the fixture (in the 24 h to 00:30\n'
        || E'     UTC 2026-10-04: 79 fixture waits of 1 s or more, up to 7.6 s, with about\n'
        || E'     4,500 purchase waits of 1 s or more on the gate). The fixture now asks\n'
        || E'     without queueing, every 50 ms for up to 30 s, and still holds the gate\n'
        || E'     exclusively to the end of its transaction once it has it. */\n'
        || E'  DECLARE\n'
        || E'    v_gate_tries integer := 0;\n'
        || E'  BEGIN\n'
        || E'    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP\n'
        || E'      v_gate_tries := v_gate_tries + 1;\n'
        || E'      IF v_gate_tries >= 600 THEN\n'
        || E'        RAISE EXCEPTION \'CERTIFICATION_FIXTURE_GATE_BUSY\' USING ERRCODE = \'55P03\';\n'
        || E'      END IF;\n'
        || E'      PERFORM pg_sleep(0.05);\n'
        || E'    END LOOP;\n'
        || E'  END;\n';

  -- fn_ca_prepare_post_reset_welcome_certification_fixture
  v_sig := 'public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
  v_pin := 'a1c80d8dc75d92663a97dab835e6cfca';
  v_post := '93be153c305e51ffe3070a0ea0cf480d';
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> v_pin THEN
    RAISE EXCEPTION 'fn_ca_prepare_post_reset_welcome_certification_fixture is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_ca_prepare_post_reset_welcome_certification_fixture: the gate lock occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> v_post OR md5(replace(v_after, v_new, v_old)) <> v_pin THEN
    RAISE EXCEPTION 'fn_ca_prepare_post_reset_welcome_certification_fixture is not its pinned post-image (md5 %)', md5(v_after);
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_prepare_post_reset_welcome_certification_fixture: its privileges changed';
  END IF;

  -- fn_ca_prepare_unused_welcome_certification_board_leases
  v_sig := 'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure;
  v_pin := 'db78e75c9ee907f939d41ff19ee4ae43';
  v_post := 'c0e56e2aafcf8a21aba03edca44a2268';
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> v_pin THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_leases is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_leases: the gate lock occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> v_post OR md5(replace(v_after, v_new, v_old)) <> v_pin THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_leases is not its pinned post-image (md5 %)', md5(v_after);
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_leases: its privileges changed';
  END IF;

  -- fn_ca_prepare_unused_welcome_certification_board_games
  v_sig := 'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure;
  v_pin := '1f1d50b183c3a34bc8f639e80fa9d104';
  v_post := '8202c73dbd2c0e7a3c1f0f5a664ec794';
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> v_pin THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_games is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_games: the gate lock occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> v_post OR md5(replace(v_after, v_new, v_old)) <> v_pin THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_games is not its pinned post-image (md5 %)', md5(v_after);
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_games: its privileges changed';
  END IF;

  -- fn_ca_prepare_unused_welcome_certification_board_origins
  v_sig := 'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure;
  v_pin := 'da70bf140c3b4a7d5077c6746fd4a93f';
  v_post := 'adc1f35047877485a1ac35a124dc7e84';
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> v_pin THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_origins is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_origins: the gate lock occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> v_post OR md5(replace(v_after, v_new, v_old)) <> v_pin THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_origins is not its pinned post-image (md5 %)', md5(v_after);
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_prepare_unused_welcome_certification_board_origins: its privileges changed';
  END IF;
END $subs$;

COMMIT;
