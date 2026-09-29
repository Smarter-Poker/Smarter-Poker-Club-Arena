-- 20260926131014_a_fenced_manager_s_stopped_custody_park_goes_through_the_pro.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- One transaction, one schema-cache reload (CLAUDE.md production DDL policy).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A FENCED MANAGER'S STOPPED CUSTODY PARK GOES THROUGH THE PROCESS WRITE
-- (2026-09-26). This is the database half of #5323 for the engine that is
-- serving now, and it is what lets #5323 itself ship.
--
-- Engine cd5892e8 (sealed 09:08Z) predates #5323. Its terminal engines still
-- write stopped time-bank custody with savePresenceAtPark - a POST upsert to
-- engine_presence_parked under the dead manager's data-actor headers - and
-- this hook fences every one: 758 POSTs answered 403 at the 12:53Z fan-out
-- (edge logs). With the bank never on disk the census reports
-- stopped_bank_custody_stuck for 630 tables at every countdown since 09:55Z
-- (engine_maintenance_break_log.unparked_at_countdown = 630, five breaks,
-- ready_for_restart_at null), the certificate is shut by design (#5288), and
-- every release since 09:08Z has died waiting for it - including 3956bc0b49,
-- the release that carries the fix. The engine cannot be replaced by the
-- release that fixes the reason it cannot be replaced.
--
-- The fix does not relax the certificate, the census or the release script,
-- and it never admits a bank that is not on disk. It lets the write the old
-- engine is ALREADY making at every :53 fan-out land through the refusing
-- function #5323 reviewed and applied (20260926090846):
--
--   1. The hook, at the point it would fence, admits exactly one shape -
--      POST to engine_presence_parked - under a marker of its own,
--      'fenced-manager-stopped-custody'. Never as a manager. Reads, PATCH,
--      DELETE, RPCs and every other path are fenced exactly as before.
--   2. A BEFORE INSERT trigger on engine_presence_parked sees the marker and:
--        - raises the SAME TOURNAMENT_MANAGER_FENCED error for any row that
--          is not stopped custody (engine_instance '<instance>:stopped_custody',
--          a version-1 time_bank_snapshot with an integral handNumber and a
--          players object) - the ordinary announcement upsert, which writes
--          time_bank_snapshot null, is refused as it always was;
--        - otherwise calls public.fn_park_stopped_time_bank_custody with the
--          header's tournament and generation. That function refuses by name
--          over a later hand, a newer park, an adopted or open mixed F06
--          transfer, a table outside the tournament, and a busy transfer lock.
--          On ok the raw upsert is suppressed (RETURN NULL), so the row on disk
--          is the function's, never ON CONFLICT DO UPDATE's. On any refusal the
--          trigger raises, the engine's save returns false, and it records no
--          acknowledgement: the gate stays shut for that table (10.86).
--
-- Only a confirmed write lets cd5892e8 set acknowledgedTimeBankPark, which is
-- the only thing that clears hasUnretiredStoppedTimeBankCustody(). So the
-- certificate opens for exactly the tables whose bank is now on disk, by the
-- same rules the fixed engine will apply, and for no other.
--
-- Changelog: docs/changelog/2026-09-26-a-fenced-managers-stopped-custody-goes-through-the-process-write.md

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_method text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  /* Must remain identical to TOURNAMENT_LEASE_STALE_SECONDS and the claim RPC
     default. The catalog assertion below pins this audited takeover window. */
  v_stale_seconds constant integer := 30;
BEGIN
  BEGIN
    v_headers := COALESCE(
      NULLIF(current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: malformed PostgREST request context'
      USING ERRCODE = '22023';
  END;

  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  /* This function is SECURITY DEFINER, so current_user is its owner, not the
     impersonated API role. The transaction-scoped, PostgREST-verified JWT
     claims are the request identity inside this privileged function. */
  v_request_role := btrim(COALESCE(auth.role(), ''));
  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));

  /* This route cannot exist while smarter_private stays outside db-schemas.
     Keep the refusal as fail-closed defence if that deployment boundary is
     ever misconfigured. */
  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* Stage A strict mode is intentionally OFF.  Unmarked old engines and
     ordinary browser clients remain compatible until a later activation
     migration.  Recording the local marker lets downstream Stage-B guards
     distinguish this path without guessing from table names or payloads. */
  IF v_actor = '' THEN
    PERFORM set_config('app.smarter_data_actor', 'legacy-unmarked', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: marked server actor requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor = 'service' THEN
    IF v_protocol <> '1'
       OR length(btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', ''))) > 0
       OR length(
            btrim(
              COALESCE(v_headers ->> 'x-smarter-tournament-lease-generation', '')
            )
          ) > 0 THEN
      RAISE EXCEPTION 'DATA_ACTOR_INVALID: service authority headers are inconsistent'
        USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.smarter_data_actor', 'service', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: unknown actor or protocol'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS NULL OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END IF;

  /* PostgREST executes this hook inside the same transaction as the requested
     statement.  Read-only GET/HEAD requests need exact validation only.
     Every possible mutation method takes a shared row lock first; a lease
     takeover/update therefore waits until this manager transaction commits. */
  IF v_method IN ('GET', 'HEAD', 'OPTIONS')
     OR current_setting('transaction_read_only') = 'on' THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): FOR KEY SHARE, not
        FOR SHARE. The heartbeat renews heartbeat_at with FOR NO KEY
        UPDATE ... SKIP LOCKED; FOR SHARE made every in-flight manager
        request read as busy and expired the manager after 20 seconds.
        A takeover still waits: claim_tournament_lease_v2 takes FOR
        UPDATE, which FOR KEY SHARE does conflict with. */
     FOR KEY SHARE;
  END IF;

  IF NOT FOUND THEN
    /* A FENCED MANAGER'S STOPPED CUSTODY GOES THROUGH THE PROCESS WRITE
       (2026-09-26, migration 20260926131014). Exactly one request shape
       passes this point: a POST to engine_presence_parked. It is admitted
       under its own marker, never as a manager, and
       smarter_private.fn_fenced_manager_stopped_custody_park() (BEFORE
       INSERT on that table) either routes a stopped-custody row through
       public.fn_park_stopped_time_bank_custody - the same refusing write the
       engine calls at the process root since #5323 - and suppresses the raw
       upsert, or raises this same TOURNAMENT_MANAGER_FENCED. Every other
       method, path and row is fenced exactly as before. */
    IF v_method = 'POST' AND v_path = 'engine_presence_parked' THEN
      PERFORM set_config('app.smarter_data_actor', 'fenced-manager-stopped-custody', true);
      PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
      PERFORM set_config(
        'app.smarter_tournament_lease_generation',
        v_lease_generation::text,
        true
      );
      RETURN;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation',
    v_lease_generation::text,
    true
  );
END;
$function$;

CREATE OR REPLACE FUNCTION smarter_private.fn_fenced_manager_stopped_custody_park()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_hand jsonb;
  v_tournament uuid;
  v_generation uuid;
  v_result jsonb;
BEGIN
  /* Every other writer - the service actor, a live manager, legacy-unmarked,
     and fn_park_stopped_time_bank_custody's own insert below - passes
     untouched. */
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'fenced-manager-stopped-custody' THEN
    RETURN NEW;
  END IF;

  v_snapshot := NEW.time_bank_snapshot;
  v_hand := v_snapshot -> 'handNumber';
  IF right(COALESCE(NEW.engine_instance, ''), 16) IS DISTINCT FROM ':stopped_custody'
     OR jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
     OR (v_snapshot -> 'version') IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(v_hand) IS DISTINCT FROM 'number'
     OR (v_hand::text)::numeric < 0
     OR (v_hand::text)::numeric <> trunc((v_hand::text)::numeric)
     OR jsonb_typeof(v_snapshot -> 'players') IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.disconnect_states) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_tournament := NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
    v_generation :=
      NULLIF(current_setting('app.smarter_tournament_lease_generation', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_tournament := NULL;
  END;
  IF v_tournament IS NULL OR v_generation IS NULL THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  /* The custody is written as the process, by the reviewed refusing write.
     Transaction-local, and restored before anything else can read it. */
  PERFORM set_config('app.smarter_data_actor', 'service', true);
  v_result := public.fn_park_stopped_time_bank_custody(
    NEW.table_id,
    v_tournament,
    v_generation,
    (v_hand::text)::bigint,
    NEW.parked_at::text,
    NEW.disconnect_states,
    v_snapshot -> 'players',
    NEW.engine_instance
  );
  PERFORM set_config('app.smarter_data_actor', 'fenced-manager-stopped-custody', true);

  IF (v_result ->> 'ok') = 'true' THEN
    -- The function wrote the row. Suppress the raw ON CONFLICT DO UPDATE.
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'STOPPED_CUSTODY_REFUSED: %', COALESCE(v_result ->> 'refused', 'unknown')
    USING ERRCODE = '42501';
END
$function$;

REVOKE ALL ON FUNCTION smarter_private.fn_fenced_manager_stopped_custody_park()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fenced_manager_stopped_custody_park
  BEFORE INSERT ON public.engine_presence_parked
  FOR EACH ROW EXECUTE FUNCTION smarter_private.fn_fenced_manager_stopped_custody_park();

DO $post$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure;
  IF position('fenced-manager-stopped-custody' IN v_src) = 0
     OR position('TOURNAMENT_MANAGER_FENCED' IN v_src) = 0
     OR position('FOR KEY SHARE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FENCED_CUSTODY_POSTIMAGE: the request hook lost a guard';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.engine_presence_parked'::regclass
                    AND t.tgname = 'trg_fenced_manager_stopped_custody_park'
                    AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'FENCED_CUSTODY_POSTIMAGE: the trigger is not enabled';
  END IF;
END
$post$;

COMMIT;
