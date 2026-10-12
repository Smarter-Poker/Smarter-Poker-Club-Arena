-- 20261007024757_horse_accepted_roster_at_settlement.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Horse Brain Phase 14.2 (plan package P14-A). The daily horse review cannot
-- tell which accepted players were horses when a hand was played: it reads
-- today's profiles.is_horse, it misses silent and post-only horses because it
-- infers actors from actions, and a caller could put a roster-shaped key into
-- the stored post-commit envelope, because the obligations check accepted
-- extra JSON keys. Nothing that arrives with the request can authenticate who
-- was a horse when the hand was accepted.
--
-- So the accepted roster is now produced INSIDE the settlement transaction,
-- by the one door that accepts the hand, on FIRST acceptance only:
--
--   1. smarter_private.accepted_hand_rosters, the separately protected
--      first-write discriminator. One row per (table_id, hand_number). Only
--      the outer door writes it, in the transaction that first accepts the
--      hand: captured_txid must be txid_current() and the receipt with the
--      same hand id and FINAL post_commit_payload_hash must already be there.
--      It is then immutable (UPDATE, DELETE, TRUNCATE refused) and no role
--      except its owner holds any privilege on it.
--   2. The 12-argument door public.fn_ca_commit_hand_settlement, edited at
--      five md5-pinned exact anchors (the estate's pg_temp.ca_audit_subst):
--      a. a caller-supplied 'accepted_actor_roster' obligations key is refused
--         with the door's existing invalid_post_commit_obligations refusal;
--      b. on the branch that writes post_commit_request_hash (first
--         acceptance), under the locks the door already holds, the capsule is
--         built from the accepted exact seat generations (p_stacks seat_id and
--         seat_joined_at, which the stack core has already proved and locked
--         FOR UPDATE, lawfully departed seats included) and profiles.is_horse
--         read now. Silent and post-only horses are present because the roster
--         is the dealt stack roster, never the action log;
--      c. an equal-hash replay returns the stored row exactly and never reads
--         today's profiles. A receipt with no row (accepted before this
--         migration) answers 'legacy_missing';
--      d. the success result gains 'accepted_roster' {version, status,
--         reasons, payloadDigest, producerVersion, roster}. Nothing else in
--         the result changes.
--
-- WHY THE CAPSULE IS NOT COPIED INTO post_commit_payload (a deliberate
-- deviation from the first draft of the P14-A contract, reported to the
-- lead). Seven installed verifiers rebuild the original obligations request
-- from the stored envelope as payload - 'accepted_hand_facts' (minus
-- pending_addons.ids) and compare its sha256 with post_commit_request_hash:
-- smarter_private.f06_movement_prior, f06_prior_committed_stacks,
-- f06_no_start_prior_committed_stacks, f06_retained_mtt_abort_snapshot,
-- f06_retired_origin_snapshot, f06_historical_loss_pending and
-- public.fn_cash_atomic_original_matches. One more top-level key in the
-- envelope would make every one of them refuse the hand
-- (F06_MOVEMENT_POSTCOMMIT_SEAL, F06_MIXED_PRIOR_POSTCOMMIT_SEAL,
-- live_atomic_receipt_conflicts_with_original) and stop tournament movement
-- and cash accounting for every captured hand. The envelope, its payload hash
-- and its request hash therefore stay byte for byte what they were. The
-- capsule's provenance is the discriminator row, bound to the receipt by
-- (table_id, hand_number, hand_id, post_commit_payload_hash).
--
-- THE ABSOLUTE RULE. Producing the roster never makes a settlement fail and
-- never changes money, stacks, RNG, request identity or the stored envelope.
-- The capsule is built inside its own subtransaction, and the door calls the
-- producer inside a second one: any unexpected error degrades to status
-- 'unavailable' with reason 'roster_producer_error:<sqlstate>' and the hand
-- settles exactly as before. Anything the capsule cannot honestly state
-- (legacy non-exact stacks, fewer than 2 or more than 10 actors, a seat row
-- that no longer exists, duplicate seats, a Lightning anchor hand whose chairs
-- belong to several tables) is 'unavailable' with named reasons and no
-- roster. The producer takes no row lock: the stack core locked the exact seat
-- rows earlier in this transaction, profiles are read with a plain snapshot
-- read, and the one new write is an insert into a private table that nothing
-- else touches, after every existing lock has been taken. Lock order is
-- unchanged.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). is_horse is read here only as data,
-- the identification the law allows. Every dealt seat is in the roster, horse
-- or human, and nothing about the hand depends on the answer.
--
-- PINNED LIVE md5(pg_get_functiondef(...)) of the outer door:
--   before ad4eadeb4df8113db0ba2b598d219aaf  postimage of 20261006154344, the
--          newest re-pin (#6334, after 20261006184554). Reconstructed byte for
--          byte from the captured e9d96bfefffef41bc22b6b6f2d5da452 body plus
--          both later anchor edits, and proved on PostgreSQL 17.
--   after  a40343a901e12f134f0e876c08f604bd
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='a40343a901e12f134f0e876c08f604bd' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, extensions, pg_temp'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure)
-- @live-proof: (SELECT count(*)=2 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgrelid='smarter_private.accepted_hand_rosters'::regclass)
-- @live-proof: NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,'smarter_private.accepted_hand_rosters','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
-- @live-proof: NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE n.nspname='smarter_private' AND p.proname LIKE 'accepted_hand_roster%' AND has_function_privilege(r,p.oid,'EXECUTE'))

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $preimage$
BEGIN
  IF to_regclass('smarter_private.accepted_hand_rosters') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'smarter_private' AND p.proname LIKE 'accepted_hand_roster%') THEN
    RAISE EXCEPTION 'ACCEPTED_ROSTER_ALREADY_INSTALLED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
       AND md5(pg_get_functiondef(oid)) = 'ad4eadeb4df8113db0ba2b598d219aaf'
       AND proowner = 'postgres'::regrole AND prosecdef
       AND proconfig = ARRAY['search_path=public, extensions, pg_temp']
       AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'ACCEPTED_ROSTER_DOOR_PREIMAGE_DRIFT';
  END IF;
END
$preimage$;

-- ===========================================================================
-- 1. THE DISCRIMINATOR. Insert-once, immutable, private.
-- ===========================================================================
CREATE TABLE smarter_private.accepted_hand_rosters (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  post_commit_payload_hash text NOT NULL CHECK (post_commit_payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('captured','unavailable')),
  reasons text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reasons) <= 16),
  roster jsonb,
  producer_version text NOT NULL DEFAULT 'accepted_hand_roster_v1'
    CHECK (producer_version = 'accepted_hand_roster_v1'),
  captured_txid bigint NOT NULL DEFAULT txid_current(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, hand_number),
  CHECK ((status = 'captured') = (roster IS NOT NULL)),
  CHECK ((status = 'captured') = (cardinality(reasons) = 0)),
  CHECK (roster IS NULL OR jsonb_typeof(roster) = 'object')
);
ALTER TABLE smarter_private.accepted_hand_rosters OWNER TO postgres;
REVOKE ALL ON smarter_private.accepted_hand_rosters FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE smarter_private.accepted_hand_rosters IS
  'P14.2 first-write discriminator: the accepted actor roster of one hand, written only by public.fn_ca_commit_hand_settlement in the transaction that first accepts the hand, bound to its receipt by hand_id and the final post_commit_payload_hash. Immutable. A roster-shaped key anywhere else has no provenance.';

CREATE FUNCTION smarter_private.accepted_hand_roster_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ACCEPTED_ROSTER_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.captured_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'ACCEPTED_ROSTER_TRANSACTION_REQUIRED' USING ERRCODE = '55000';
  END IF;
  -- The receipt this row discriminates already carries the final payload hash
  -- in this transaction; the door holds it FOR UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM public.hand_atomic_commits c
     WHERE c.table_id = NEW.table_id
       AND c.hand_number = NEW.hand_number
       AND c.hand_id = NEW.hand_id
       AND c.post_commit_payload_hash = NEW.post_commit_payload_hash) THEN
    RAISE EXCEPTION 'ACCEPTED_ROSTER_RECEIPT_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$body$;
ALTER FUNCTION smarter_private.accepted_hand_roster_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.accepted_hand_roster_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER accepted_hand_roster_guard BEFORE INSERT OR UPDATE OR DELETE
 ON smarter_private.accepted_hand_rosters FOR EACH ROW EXECUTE FUNCTION smarter_private.accepted_hand_roster_guard();
CREATE TRIGGER accepted_hand_roster_no_truncate BEFORE TRUNCATE
 ON smarter_private.accepted_hand_rosters FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.accepted_hand_roster_guard();

-- ===========================================================================
-- 2. THE PRODUCER. Three private functions, none SECURITY DEFINER: they run
--    only inside the definer door, as its owner. No role may execute them.
-- ===========================================================================

-- Builds the capsule, or says why it cannot. Writes nothing. Never raises:
-- an unexpected error is reported as roster_producer_error:<sqlstate>.
CREATE FUNCTION smarter_private.accepted_hand_roster_build(
  p_table_id uuid, p_hand_number bigint, p_hand_id uuid, p_stacks jsonb,
  p_exact boolean, p_lightning_seats jsonb, p_captured_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $body$
DECLARE
  v_reasons text[] := '{}';
  v_actors jsonb;
  v_roster jsonb;
  v_state text;
BEGIN
  BEGIN
    IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' THEN
      v_reasons := v_reasons || 'stack_roster_invalid'::text;
    ELSIF jsonb_array_length(p_stacks) < 2 THEN
      v_reasons := v_reasons || 'actor_count_below_two'::text;
    ELSIF jsonb_array_length(p_stacks) > 10 THEN
      v_reasons := v_reasons || 'actor_count_above_ten'::text;
    END IF;
    IF p_exact IS NOT TRUE THEN
      v_reasons := v_reasons || 'legacy_stack_seat_generation'::text;
    END IF;
    IF COALESCE(p_lightning_seats, '{}'::jsonb) <> '{}'::jsonb THEN
      -- Anchor chairs belong to several physical tables; their seat numbers
      -- are not one table's positions, so the capsule cannot state them.
      v_reasons := v_reasons || 'lightning_seat_positions_unbound'::text;
    END IF;
    IF p_hand_number IS NULL OR p_hand_number < 1 OR p_hand_number > 9007199254740991 THEN
      v_reasons := v_reasons || 'hand_number_out_of_range'::text;
    END IF;

    IF cardinality(v_reasons) = 0 THEN
      WITH stack AS (
        SELECT (x->>'user_id')::uuid AS user_id,
               (x->>'seat_id')::uuid AS seat_id,
               x->>'seat_joined_at' AS joined_text,
               (x->>'seat_joined_at')::timestamptz AS joined_at
          FROM jsonb_array_elements(p_stacks) x
      ), joined AS (
        -- The exact generation the stack core proved: same row id, joiner and
        -- joined_at at this table. A lawfully departed seat keeps its row.
        SELECT s.user_id, s.seat_id, s.joined_text, s.joined_at,
               ts.id AS row_id, ts.seat_number,
               p.id AS profile_id, p.is_horse
          FROM stack s
          LEFT JOIN public.table_seats ts
            ON ts.id = s.seat_id AND ts.user_id = s.user_id
           AND ts.joined_at = s.joined_at AND ts.table_id = p_table_id
          LEFT JOIN public.profiles p ON p.id = s.user_id
      )
      SELECT
        jsonb_agg(jsonb_build_object(
          'userId', j.user_id::text,
          'seat', j.seat_number,
          'seatId', j.seat_id::text,
          'seatJoinedAt', j.joined_text,
          'classification', CASE WHEN j.profile_id IS NULL OR j.is_horse IS NULL THEN 'unknown'
                                 WHEN j.is_horse THEN 'horse' ELSE 'human' END,
          'status', CASE WHEN j.profile_id IS NULL THEN 'profile_missing'
                         WHEN j.is_horse IS NULL THEN 'classification_null'
                         ELSE 'canonical_boolean' END)
          ORDER BY j.user_id::text COLLATE "C"),
        array_remove(ARRAY[
          CASE WHEN bool_or(j.row_id IS NULL) THEN 'seat_generation_row_missing' END,
          CASE WHEN NOT bool_or(j.row_id IS NULL)
                AND bool_or(j.seat_number < 1 OR j.seat_number > 10) THEN 'seat_number_out_of_range' END,
          CASE WHEN NOT bool_or(j.row_id IS NULL)
                AND count(DISTINCT j.seat_number) <> count(*) THEN 'duplicate_seat_number' END,
          CASE WHEN count(DISTINCT j.seat_id) <> count(*) THEN 'duplicate_seat_id' END,
          CASE WHEN count(DISTINCT j.user_id) <> count(*) THEN 'duplicate_actor' END,
          CASE WHEN bool_or(j.joined_text !~
                 '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$')
               THEN 'seat_joined_at_format' END,
          CASE WHEN bool_or(j.joined_at > p_captured_at) THEN 'seat_joined_after_capture' END
        ]::text[], NULL)
        INTO v_actors, v_reasons
        FROM joined j;
    END IF;

    IF cardinality(v_reasons) = 0 THEN
      v_roster := jsonb_build_object(
        'version', 1,
        'basis', 'profiles_read_in_acceptance_transaction',
        'tableId', p_table_id::text,
        'handId', p_hand_id::text,
        'handNumber', p_hand_number,
        'capturedAt', to_char(p_captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'actors', v_actors);
      IF octet_length(v_roster::text) > 16000 THEN
        v_reasons := ARRAY['roster_too_large'];
        v_roster := NULL;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_reasons := ARRAY['roster_producer_error:' || v_state];
    v_roster := NULL;
  END;
  IF cardinality(v_reasons) > 0 THEN v_roster := NULL; END IF;
  RETURN jsonb_build_object(
    'status', CASE WHEN v_roster IS NULL THEN 'unavailable' ELSE 'captured' END,
    'reasons', to_jsonb(v_reasons),
    'roster', v_roster);
END
$body$;
ALTER FUNCTION smarter_private.accepted_hand_roster_build(uuid,bigint,uuid,jsonb,boolean,jsonb,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.accepted_hand_roster_build(uuid,bigint,uuid,jsonb,boolean,jsonb,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

-- First acceptance: build, record the discriminator, return the door's field.
-- If the row cannot be recorded as built, an 'unavailable' row naming why is
-- recorded instead; if even that fails, the door still reports 'unavailable'
-- and a later replay of the hand reads 'legacy_missing'. Never raises into
-- the settlement for a recording failure.
CREATE FUNCTION smarter_private.accepted_hand_roster_first(
  p_table_id uuid, p_hand_number bigint, p_hand_id uuid, p_stacks jsonb,
  p_exact boolean, p_lightning_seats jsonb, p_payload_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $body$
DECLARE
  v_captured timestamptz := transaction_timestamp();
  v_built jsonb;
  v_status text;
  v_reasons text[];
  v_roster jsonb;
  v_state text;
BEGIN
  v_built := smarter_private.accepted_hand_roster_build(p_table_id, p_hand_number, p_hand_id,
    p_stacks, p_exact, p_lightning_seats, v_captured);
  v_status := v_built->>'status';
  v_roster := NULLIF(v_built->'roster', 'null'::jsonb);
  SELECT COALESCE(array_agg(r ORDER BY o), '{}') INTO v_reasons
    FROM jsonb_array_elements_text(v_built->'reasons') WITH ORDINALITY AS t(r, o);
  BEGIN
    INSERT INTO smarter_private.accepted_hand_rosters
      (table_id, hand_number, hand_id, post_commit_payload_hash, status, reasons,
       roster, producer_version, captured_txid, captured_at)
    VALUES
      (p_table_id, p_hand_number, p_hand_id, p_payload_hash, v_status, v_reasons,
       v_roster, 'accepted_hand_roster_v1', txid_current(), v_captured);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_status := 'unavailable';
    v_reasons := ARRAY['roster_record_error:' || v_state];
    v_roster := NULL;
    BEGIN
      INSERT INTO smarter_private.accepted_hand_rosters
        (table_id, hand_number, hand_id, post_commit_payload_hash, status, reasons,
         roster, producer_version, captured_txid, captured_at)
      VALUES
        (p_table_id, p_hand_number, p_hand_id, p_payload_hash, v_status, v_reasons,
         NULL, 'accepted_hand_roster_v1', txid_current(), v_captured);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
  RETURN jsonb_build_object(
    'version', 1,
    'status', v_status,
    'reasons', to_jsonb(v_reasons),
    'payloadDigest', p_payload_hash,
    'producerVersion', 'accepted_hand_roster_v1',
    'roster', v_roster);
END
$body$;
ALTER FUNCTION smarter_private.accepted_hand_roster_first(uuid,bigint,uuid,jsonb,boolean,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.accepted_hand_roster_first(uuid,bigint,uuid,jsonb,boolean,jsonb,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Replay: the stored row, exactly. Never reads profiles.
CREATE FUNCTION smarter_private.accepted_hand_roster_replay(
  p_table_id uuid, p_hand_number bigint, p_hand_id uuid, p_payload_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $body$
DECLARE r smarter_private.accepted_hand_rosters;
BEGIN
  SELECT * INTO r FROM smarter_private.accepted_hand_rosters
   WHERE table_id = p_table_id AND hand_number = p_hand_number;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('version', 1, 'status', 'legacy_missing',
      'reasons', jsonb_build_array('accepted_roster_not_recorded'),
      'payloadDigest', p_payload_hash,
      'producerVersion', 'accepted_hand_roster_v1', 'roster', NULL);
  END IF;
  IF r.hand_id IS DISTINCT FROM p_hand_id
     OR r.post_commit_payload_hash IS DISTINCT FROM p_payload_hash THEN
    RETURN jsonb_build_object('version', 1, 'status', 'unavailable',
      'reasons', jsonb_build_array('roster_discriminator_mismatch'),
      'payloadDigest', p_payload_hash,
      'producerVersion', 'accepted_hand_roster_v1', 'roster', NULL);
  END IF;
  RETURN jsonb_build_object('version', 1, 'status', r.status,
    'reasons', to_jsonb(r.reasons), 'payloadDigest', r.post_commit_payload_hash,
    'producerVersion', r.producer_version, 'roster', r.roster);
END
$body$;
ALTER FUNCTION smarter_private.accepted_hand_roster_replay(uuid,bigint,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.accepted_hand_roster_replay(uuid,bigint,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 3. THE DOOR, edited at five exact anchors, each required to occur once.
-- ===========================================================================
CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
  'ad4eadeb4df8113db0ba2b598d219aaf', 'a40343a901e12f134f0e876c08f604bd',
  ARRAY[$o$  v_lightning_seats jsonb := '{}'::jsonb;
BEGIN
$o$,
$o$     OR p_post_commit_obligations ? 'accepted_hand_facts'
$o$,
$o$    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;
  ELSE
$o$,
$o$        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
  END IF;
$o$,
$o$  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash
  );
$o$],
  ARRAY[$n$  v_lightning_seats jsonb := '{}'::jsonb;
  -- P14.2 (20261007024757): the accepted actor roster this result reports.
  v_accepted_roster jsonb;
  v_roster_state text;
BEGIN
$n$,
$n$     OR p_post_commit_obligations ? 'accepted_hand_facts'
     /* P14.2: the accepted roster is produced by this transaction alone. */
     OR p_post_commit_obligations ? 'accepted_actor_roster'
$n$,
$n$    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;

    /* THE ACCEPTED ROSTER (P14.2, 20261007024757). First acceptance only,
       under the locks already held, from the exact seat generations the stack
       core proved and profiles read now. It never changes the envelope, its
       hashes, money or stacks, and it can never fail the hand: any error here
       is reported as 'unavailable' and the hand settles as before. */
    BEGIN
      v_accepted_roster := smarter_private.accepted_hand_roster_first(
        p_table_id, p_hand_number, v_hand_id, p_stacks,
        v_exact_seat_generation, v_lightning_seats, v_hash);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_roster_state = RETURNED_SQLSTATE;
      v_accepted_roster := jsonb_build_object('version', 1, 'status', 'unavailable',
        'reasons', jsonb_build_array('roster_producer_error:' || v_roster_state),
        'payloadDigest', v_hash, 'producerVersion', 'accepted_hand_roster_v1',
        'roster', NULL);
    END;
  ELSE
$n$,
$n$        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
    /* P14.2: a replay returns the stored roster exactly; today's profiles
       are never consulted again. */
    BEGIN
      v_accepted_roster := smarter_private.accepted_hand_roster_replay(
        p_table_id, p_hand_number, v_hand_id, v_hash);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_roster_state = RETURNED_SQLSTATE;
      v_accepted_roster := jsonb_build_object('version', 1, 'status', 'unavailable',
        'reasons', jsonb_build_array('roster_replay_error:' || v_roster_state),
        'payloadDigest', v_hash, 'producerVersion', 'accepted_hand_roster_v1',
        'roster', NULL);
    END;
  END IF;
$n$,
$n$  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash,
    'accepted_roster', v_accepted_roster
  );
$n$]);

DO $postimage$
BEGIN
  IF (SELECT md5(pg_get_functiondef(oid)) = 'a40343a901e12f134f0e876c08f604bd'
             AND proowner = 'postgres'::regrole AND prosecdef
             AND proconfig = ARRAY['search_path=public, extensions, pg_temp']
             AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
        FROM pg_proc
       WHERE oid = 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure) IS NOT TRUE
     OR (SELECT count(*) FROM pg_trigger
          WHERE NOT tgisinternal AND tgenabled = 'O'
            AND tgrelid = 'smarter_private.accepted_hand_rosters'::regclass) <> 2
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
                 WHERE has_table_privilege(r, 'smarter_private.accepted_hand_rosters',
                       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r
                 WHERE n.nspname = 'smarter_private' AND p.proname LIKE 'accepted_hand_roster%'
                   AND has_function_privilege(r, p.oid, 'EXECUTE'))
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'smarter_private' AND p.proname LIKE 'accepted_hand_roster%'
            AND NOT p.prosecdef AND p.proowner = 'postgres'::regrole) <> 4 THEN
    RAISE EXCEPTION 'ACCEPTED_ROSTER_POSTIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
END
$postimage$;

COMMIT;
