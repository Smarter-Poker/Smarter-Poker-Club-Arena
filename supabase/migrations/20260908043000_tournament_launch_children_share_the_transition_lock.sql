/*
 * Launch completion used to lock its durable receipt and tournament parent,
 * prove the roster/tables/seats, and then flip RUNNING.  The rows it proved
 * did not all take those locks when they changed.  A child write could
 * therefore commit between the proof SELECTs and the status UPDATE.
 *
 * This migration gives every launch-proof mutation one lock vocabulary:
 * tournament_launch_receipts first, tournaments second.  A live tournament
 * seat also proves an active roster row while holding that parent lock before
 * the historical one-live-seat trigger runs, turning its cross-table check
 * into a serialized decision.
 *
 * Table birth needs one more durable fact.  A table born while REGISTERING is
 * classified as either prelaunch or as belonging to the exact incomplete
 * (launch_id, lease_generation) receipt.  A table born after RUNNING is a
 * capacity table and must have the canonical
 * tournament_capacity_table_receipts row by transaction commit.  The
 * capacity function deliberately inserts the table before its receipt, so
 * this proof is a DEFERRABLE INITIALLY DEFERRED constraint trigger rather
 * than an immediate row check.
 *
 * This is serialization, not stale-manager authorization.  Exact launch
 * generation is persisted and returned by the lock helper so a later RPC
 * boundary can require a transaction-local generation marker without
 * changing the provenance model. One deliberately narrow Stage-A bridge also
 * admits the old engine's raw RUNNING-table INSERT while its exact fresh
 * protocol-1 tournament lease is locked. It creates the canonical capacity
 * receipt and manager wake inside that same transaction; it is not a repair.
 * Stage B removes the bridge after old processes drain.
 */

BEGIN;

CREATE TABLE IF NOT EXISTS public.tournament_table_origins (
  table_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL,
  origin_kind text NOT NULL,
  launch_id uuid,
  launch_lease_generation uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_table_origins_table_fk
    FOREIGN KEY (table_id) REFERENCES public.tables(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT tournament_table_origins_tournament_fk
    FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON DELETE CASCADE,
  CONSTRAINT tournament_table_origins_launch_fk
    FOREIGN KEY (launch_id) REFERENCES public.tournament_launch_receipts(launch_id)
    ON DELETE RESTRICT,
  CONSTRAINT tournament_table_origins_kind_check CHECK (
    (origin_kind = 'launch'
      AND launch_id IS NOT NULL
      AND launch_lease_generation IS NOT NULL)
    OR
    (origin_kind IN ('prelaunch', 'capacity', 'legacy')
      AND launch_id IS NULL
      AND launch_lease_generation IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tournament_table_origins_tournament
  ON public.tournament_table_origins(tournament_id, origin_kind, table_id);

ALTER TABLE public.tournament_table_origins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_table_origins
  FROM PUBLIC, anon, authenticated, service_role;

/* Backfill precedes the future-write constraint trigger.  Historical rows did
   not cross this admission boundary, so do not manufacture proof from their
   present-day status or timestamps.  `legacy` is private migration provenance
   only: no runtime trigger below emits it and no application role can write
   this table. */
INSERT INTO public.tournament_table_origins (
  table_id,
  tournament_id,
  origin_kind,
  launch_id,
  launch_lease_generation,
  recorded_at
)
SELECT t.id,
       t.tournament_id,
       'legacy',
       NULL,
       NULL,
       COALESCE(t.created_at, clock_timestamp())
  FROM public.tables t
 WHERE t.tournament_id IS NOT NULL
ON CONFLICT (table_id) DO NOTHING;

/* One helper owns the order.  It locks ALL relevant receipt rows in UUID
   order, then ALL tournament parents in the same order.  The returned exact
   launch identity is intentionally part of the interface for a future
   generation-authorized mutation wrapper; this migration does not claim that
   a row trigger can identify a stale manager process. */
CREATE OR REPLACE FUNCTION public.fn_lock_tournament_launch_proof_parents(
  p_tournament_ids uuid[]
) RETURNS TABLE (
  tournament_id uuid,
  parent_status text,
  launch_id uuid,
  launch_lease_generation uuid,
  launch_completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT requested.id ORDER BY requested.id)
    INTO v_ids
    FROM unnest(p_tournament_ids) AS requested(id)
   WHERE requested.id IS NOT NULL;

  IF v_ids IS NULL THEN
    RETURN;
  END IF;

  /* Do not invert these two blocks.  Launch completion already owns receipt
     -> parent, and every child must join that order. */
  /* A few legacy RPCs entered with the tournament parent already locked.
     Waiting for a receipt owned by completion would make a cycle: completion
     waits for their parent while they wait for its receipt.  Fail that outer
     transaction as retryable instead of waiting; a clean retry enters this
     helper before touching another launch-proof row. */
  BEGIN
    PERFORM 1
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = ANY(v_ids)
     ORDER BY r.tournament_id
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION
      'TOURNAMENT_TRANSITION_BUSY: launch proof receipt is changing'
      USING ERRCODE = '40001';
  END;

  PERFORM 1
    FROM public.tournaments t
   WHERE t.id = ANY(v_ids)
   ORDER BY t.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM unnest(v_ids) AS requested(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.tournaments t WHERE t.id = requested.id
     )
  ) THEN
    RAISE EXCEPTION 'tournament launch proof child names a missing parent'
      USING ERRCODE = '23503';
  END IF;

  RETURN QUERY
    SELECT t.id,
           t.status::text,
           r.launch_id,
           r.lease_generation,
           r.completed_at
      FROM public.tournaments t
      LEFT JOIN public.tournament_launch_receipts r
        ON r.tournament_id = t.id
     WHERE t.id = ANY(v_ids)
     ORDER BY t.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_lock_tournament_launch_proof_parents(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

/* Roster rows are one side of both launch proof and the live-seat invariant.
   INSERT remains serialized after RUNNING because late registration is a
   real field mutation. High-frequency chip/link and active-to-active status
   updates take the launch locks only while the parent can still be completed;
   a destructive roster transition always takes them. */
CREATE OR REPLACE FUNCTION public.trg_lock_tournament_player_launch_proof()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ids uuid[];
  v_proof_open boolean;
  v_must_lock_live_seat_invariant boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.chips IS NOT DISTINCT FROM OLD.chips
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number THEN
    RETURN NEW;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id]
  END;

  /* A completed launch no longer needs every chip/link maintenance write to
     take its proof locks.  It DOES still need every mutation that can remove
     the active roster supporting a concurrent live-seat acquisition to share
     the same receipt -> tournament lock.  Without this distinction, a seat
     INSERT could prove an active roster while a concurrent DELETE or
     active-to-inactive UPDATE skipped the parent lock; each transaction could
     then commit the half of an impossible state it observed before the other.
     Identity changes and inactive/unknown status transitions stay on the
     conservative side.  Only same-active status/link/chip traffic may use the
     completed-launch fast path below. */
  v_must_lock_live_seat_invariant :=
    TG_OP = 'DELETE'
    OR (
      TG_OP = 'UPDATE'
      AND (
        NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NOT (
          OLD.status IN ('registered', 'playing')
          AND NEW.status IN ('registered', 'playing')
        )
      )
    );

  IF TG_OP <> 'INSERT' AND NOT v_must_lock_live_seat_invariant THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS aa_tournament_player_launch_proof_lock
  ON public.tournament_players;
CREATE TRIGGER aa_tournament_player_launch_proof_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.trg_lock_tournament_player_launch_proof();

REVOKE ALL ON FUNCTION public.trg_lock_tournament_player_launch_proof()
  FROM PUBLIC, anon, authenticated, service_role;

/* Resolve the tournament, take receipt -> parent, and prove the roster before
   `trg_one_live_seat_per_tournament` performs its historical cross-table
   uniqueness scan.  PostgreSQL orders same-kind triggers by name; the `aa_`
   name is therefore part of the concurrency contract and is asserted below. */
CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_ids uuid[];
  v_is_live_acquisition boolean := false;
  v_proof_open boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
     AND NEW.stack IS NOT DISTINCT FROM OLD.stack
     AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT t.tournament_id INTO v_old_tournament_id
      FROM public.tables t
     WHERE t.id = OLD.table_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.tournament_id INTO v_new_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
    ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
  END;

  IF TG_OP = 'INSERT' THEN
    v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_is_live_acquisition := NEW.left_at IS NULL
      AND NEW.user_id IS NOT NULL
      AND (
        OLD.left_at IS NOT NULL
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.table_id IS DISTINCT FROM NEW.table_id
      );
  END IF;

  IF NOT v_is_live_acquisition THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);

  IF TG_OP <> 'DELETE'
     AND NEW.left_at IS NULL
     AND NEW.user_id IS NOT NULL
     AND v_new_tournament_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_new_tournament_id
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
      NEW.user_id, v_new_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS aa_tournament_live_seat_proof_lock
  ON public.table_seats;
CREATE TRIGGER aa_tournament_live_seat_proof_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_lock_and_validate_tournament_live_seat();

REVOKE ALL ON FUNCTION public.trg_lock_and_validate_tournament_live_seat()
  FROM PUBLIC, anon, authenticated, service_role;

/* Table INSERT is both a proof mutation and the provenance admission point.
   Once a table belongs to a tournament, moving it to another tournament would
   rewrite history and is refused. */
CREATE OR REPLACE FUNCTION public.trg_lock_and_classify_tournament_table()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ids uuid[];
  v_parent_status text;
  v_launch_id uuid;
  v_launch_generation uuid;
  v_launch_completed_at timestamptz;
  v_proof_open boolean;
  v_needs_origin boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.current_players IS NOT DISTINCT FROM OLD.current_players
     AND NEW.max_players IS NOT DISTINCT FROM OLD.max_players
     AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted THEN
    RETURN NEW;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id]
  END;

  v_needs_origin := TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL;
  IF TG_OP = 'UPDATE'
     AND OLD.tournament_id IS NULL
     AND NEW.tournament_id IS NOT NULL THEN
    v_needs_origin := true;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.tournament_id IS NOT NULL
     AND NEW.tournament_id IS DISTINCT FROM OLD.tournament_id THEN
    PERFORM *
      FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_ORIGIN_IMMUTABLE: table % cannot change tournament', OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF NOT v_needs_origin THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  IF v_needs_origin THEN
    SELECT locked.parent_status,
           locked.launch_id,
           locked.launch_lease_generation,
           locked.launch_completed_at
      INTO v_parent_status,
           v_launch_id,
           v_launch_generation,
           v_launch_completed_at
      FROM public.fn_lock_tournament_launch_proof_parents(
        ARRAY[NEW.tournament_id]
      ) AS locked;

    IF upper(v_parent_status) = 'RUNNING' THEN
      IF v_launch_id IS NOT NULL AND v_launch_completed_at IS NULL THEN
        RAISE EXCEPTION
          'TOURNAMENT_TABLE_ORIGIN_STATE_MISMATCH: RUNNING parent has an incomplete launch receipt'
          USING ERRCODE = '55000';
      END IF;
      INSERT INTO public.tournament_table_origins (
        table_id, tournament_id, origin_kind
      ) VALUES (
        NEW.id, NEW.tournament_id, 'capacity'
      );
    ELSIF upper(v_parent_status) = 'REGISTERING' THEN
      IF v_launch_id IS NULL THEN
        INSERT INTO public.tournament_table_origins (
          table_id, tournament_id, origin_kind
        ) VALUES (
          NEW.id, NEW.tournament_id, 'prelaunch'
        );
      ELSIF v_launch_completed_at IS NULL THEN
        INSERT INTO public.tournament_table_origins (
          table_id,
          tournament_id,
          origin_kind,
          launch_id,
          launch_lease_generation
        ) VALUES (
          NEW.id,
          NEW.tournament_id,
          'launch',
          v_launch_id,
          v_launch_generation
        );
      ELSE
        RAISE EXCEPTION
          'TOURNAMENT_TABLE_ORIGIN_STATE_MISMATCH: REGISTERING parent has a completed launch receipt'
          USING ERRCODE = '55000';
      END IF;
    ELSIF v_launch_id IS NULL THEN
      INSERT INTO public.tournament_table_origins (
        table_id, tournament_id, origin_kind
      ) VALUES (
        NEW.id, NEW.tournament_id, 'prelaunch'
      );
    ELSE
      RAISE EXCEPTION
        'STALE_TOURNAMENT_LAUNCH_TABLE: completed or inconsistent launch cannot create table %',
        NEW.id
        USING ERRCODE = '55000';
    END IF;
  ELSE
    PERFORM *
      FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS aa_tournament_table_launch_proof_lock
  ON public.tables;
CREATE TRIGGER aa_tournament_table_launch_proof_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_lock_and_classify_tournament_table();

REVOKE ALL ON FUNCTION public.trg_lock_and_classify_tournament_table()
  FROM PUBLIC, anon, authenticated, service_role;

/* The old engine creates a dynamic RUNNING table with one raw PostgREST
   INSERT. It cannot issue the canonical capacity RPC inside that request.
   During Stage A only, the deferred validator may complete that exact old
   transaction by creating the normal late-registration wake and capacity
   receipt before it decides whether the origin is proved.

   This is deliberately narrower than service_role. The verified request role
   and claims must both be service_role, every Smarter actor header must be
   absent, the transaction actor must still be legacy-unmarked, the request
   must be POST /tables, and that tournament must have one fresh protocol-1
   lease locked FOR SHARE. Marked or protocol-2 work never enters the bridge
   and therefore still owes its receipt before validation. Stage B removes
   this private helper at a locked writer boundary; already-committed tables
   remain ordinary capacity origins with ordinary durable receipts. */
CREATE OR REPLACE FUNCTION public.fn_stage_a_bridge_legacy_capacity_receipt(
  p_table_id uuid,
  p_tournament_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_request_role text;
  v_actor_marker text;
  v_method text;
  v_path text;
  v_wake_id bigint;
  v_stale_seconds constant integer := 30;
BEGIN
  IF p_table_id IS NULL OR p_tournament_id IS NULL THEN
    RETURN false;
  END IF;

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
    RAISE EXCEPTION
      'DATA_ACTOR_INVALID: malformed legacy capacity request context'
      USING ERRCODE = '22023';
  END;

  v_request_role := btrim(COALESCE(auth.role(), ''));
  v_actor_marker := btrim(
    COALESCE(current_setting('app.smarter_data_actor', true), '')
  );
  v_method := upper(
    btrim(COALESCE(current_setting('request.method', true), ''))
  );
  v_path := lower(
    btrim(COALESCE(current_setting('request.path', true), ''), '/')
  );
  IF left(v_path, 8) = 'rest/v1/' THEN
    v_path := substr(v_path, 9);
  END IF;

  IF v_request_role <> 'service_role'
     OR btrim(COALESCE(v_claims ->> 'role', '')) <> 'service_role'
     OR btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')) <> ''
     OR btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', '')) <> ''
     OR btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', '')) <> ''
     OR btrim(
          COALESCE(
            v_headers ->> 'x-smarter-tournament-lease-generation',
            ''
          )
        ) <> ''
     OR v_actor_marker NOT IN ('', 'legacy-unmarked')
     OR COALESCE(
          current_setting('app.smarter_manager_request_fenced', true),
          ''
        ) <> ''
     OR v_method <> 'POST'
     OR v_path <> 'tables' THEN
    RETURN false;
  END IF;

  /* This row lock is the rolling cutover handoff. Lease replacement and the
     Stage-B relation lock cannot cross the raw table INSERT transaction. */
  PERFORM 1
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
     AND l.protocol_version = 1
     AND l.heartbeat_at >=
         clock_timestamp() - make_interval(secs => v_stale_seconds)
   FOR SHARE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_wake_id := public.fn_emit_tournament_manager_wake(
    p_tournament_id,
    'late_registration'
  );
  IF v_wake_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.tournament_capacity_table_receipts (
    table_id,
    tournament_id,
    manager_wake_id
  ) VALUES (
    p_table_id,
    p_tournament_id,
    v_wake_id
  );

  /* Match the canonical capacity function's level-triggered receipt rule:
     every still-unadmitted table points at the newest pending wake. */
  UPDATE public.tournament_capacity_table_receipts
     SET manager_wake_id = v_wake_id,
         updated_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id
     AND manager_admitted_at IS NULL;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

/* This function is executed at transaction end for each future provenance
   row.  It is what turns "capacity" from a trigger-time label into same-
   transaction durable proof. */
CREATE OR REPLACE FUNCTION public.trg_validate_tournament_table_origin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_parent_status text;
BEGIN
  SELECT t.status::text INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament table origin lost parent tournament %', NEW.tournament_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.origin_kind = 'capacity' THEN
    IF upper(v_parent_status) = 'RUNNING'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = NEW.table_id
            AND c.tournament_id = NEW.tournament_id
       ) THEN
      PERFORM public.fn_stage_a_bridge_legacy_capacity_receipt(
        NEW.table_id,
        NEW.tournament_id
      );
    END IF;

    IF upper(v_parent_status) <> 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = NEW.table_id
            AND c.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_CAPACITY_RECEIPT_REQUIRED: RUNNING table % must create its canonical capacity receipt in the same transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'launch' THEN
    IF upper(v_parent_status) <> 'REGISTERING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
            AND r.launch_id = NEW.launch_id
            AND r.lease_generation = NEW.launch_lease_generation
            AND r.completed_at IS NULL
       ) THEN
      RAISE EXCEPTION
        'STALE_TOURNAMENT_LAUNCH_TABLE: table % does not belong to the exact incomplete launch receipt',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'prelaunch' THEN
    IF upper(v_parent_status) = 'RUNNING'
       OR EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_PRELAUNCH_ORIGIN_STALE: table % crossed a launch boundary in its birth transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'legacy' THEN
    /* Only the pre-trigger migration backfill can create this honestly.  ACLs
       exclude every application role, and the runtime classifier has no
       legacy branch. */
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'unknown tournament table origin %', NEW.origin_kind
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_table_origin_is_proven
  ON public.tournament_table_origins;
CREATE CONSTRAINT TRIGGER tournament_table_origin_is_proven
  AFTER INSERT ON public.tournament_table_origins
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_validate_tournament_table_origin();

REVOKE ALL ON FUNCTION public.trg_validate_tournament_table_origin()
  FROM PUBLIC, anon, authenticated, service_role;

/* Future writes cannot relabel a table after its deferred admission passed.
   DELETE is owned by the table FK cascade; direct roles have no table ACL. */
CREATE OR REPLACE FUNCTION public.trg_tournament_table_origin_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'tournament table origin is immutable'
    USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS tournament_table_origin_is_immutable
  ON public.tournament_table_origins;
CREATE TRIGGER tournament_table_origin_is_immutable
  BEFORE UPDATE ON public.tournament_table_origins
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_table_origin_is_immutable();

REVOKE ALL ON FUNCTION public.trg_tournament_table_origin_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

/* A live tournament seat must still have an active roster when its
   transaction commits.  The roster-side trigger catches DELETE/status/user/
   tournament changes; this permits canonical elimination to mark a player
   eliminated and vacate the seat later in the SAME transaction. */
CREATE OR REPLACE FUNCTION public.trg_assert_live_tournament_seat_has_roster()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_user_id uuid;
  v_parent_status text;
BEGIN
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'DELETE' OR NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    SELECT t.tournament_id INTO v_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSE
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;
    v_tournament_id := OLD.tournament_id;
    v_user_id := OLD.user_id;
  END IF;

  IF v_tournament_id IS NOT NULL THEN
    SELECT t.status::text INTO v_parent_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;

  /* Terminal cleanup may intentionally close the roster and seats in
     separate idempotent requests.  The invariant is strict while the event
     is joinable or playable; finished/cancelled tables are separately barred
     from acquiring new live seats and may drain without being wedged. */
  IF v_tournament_id IS NOT NULL
     AND upper(COALESCE(v_parent_status, '')) IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables t ON t.id = s.table_id
        WHERE t.tournament_id = v_tournament_id
          AND s.user_id = v_user_id
          AND s.left_at IS NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament_id
          AND p.user_id = v_user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament % at commit',
      v_user_id, v_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_live_seat_has_active_roster
  ON public.table_seats;
CREATE CONSTRAINT TRIGGER tournament_live_seat_has_active_roster
  AFTER INSERT ON public.table_seats
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_live_tournament_seat_has_roster();

DROP TRIGGER IF EXISTS tournament_live_seat_update_has_active_roster
  ON public.table_seats;
CREATE CONSTRAINT TRIGGER tournament_live_seat_update_has_active_roster
  AFTER UPDATE OF table_id, user_id, left_at ON public.table_seats
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_live_tournament_seat_has_roster();

DROP TRIGGER IF EXISTS tournament_roster_cannot_orphan_live_seat
  ON public.tournament_players;
CREATE CONSTRAINT TRIGGER tournament_roster_cannot_orphan_live_seat
  AFTER DELETE ON public.tournament_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_live_tournament_seat_has_roster();

DROP TRIGGER IF EXISTS tournament_roster_update_cannot_orphan_live_seat
  ON public.tournament_players;
CREATE CONSTRAINT TRIGGER tournament_roster_update_cannot_orphan_live_seat
  AFTER UPDATE OF tournament_id, user_id, status ON public.tournament_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_live_tournament_seat_has_roster();

REVOKE ALL ON FUNCTION public.trg_assert_live_tournament_seat_has_roster()
  FROM PUBLIC, anon, authenticated, service_role;

DO $assert_tournament_launch_child_serialization$
DECLARE
  v_lock_source text;
  v_player_source text;
  v_seat_source text;
  v_table_source text;
  v_origin_source text;
  v_legacy_capacity_bridge_source text;
  v_capacity_source text;
  v_receipt_lock_at integer;
  v_parent_lock_at integer;
  v_one_live_name text;
BEGIN
  SELECT p.prosrc INTO STRICT v_lock_source
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_lock_tournament_launch_proof_parents(uuid[])'::regprocedure;
  SELECT p.prosrc INTO STRICT v_seat_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_lock_and_validate_tournament_live_seat()'::regprocedure;
  SELECT p.prosrc INTO STRICT v_player_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_lock_tournament_player_launch_proof()'::regprocedure;
  SELECT p.prosrc INTO STRICT v_table_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_lock_and_classify_tournament_table()'::regprocedure;
  SELECT p.prosrc INTO STRICT v_origin_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_validate_tournament_table_origin()'::regprocedure;
  SELECT p.prosrc INTO STRICT v_legacy_capacity_bridge_source
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_capacity_source
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure;

  v_receipt_lock_at := position(
    'FROM public.tournament_launch_receipts r' IN v_lock_source
  );
  v_parent_lock_at := position(
    'FROM public.tournaments t' IN v_lock_source
  );
  IF v_receipt_lock_at = 0
     OR v_parent_lock_at <= v_receipt_lock_at
     OR position('FOR UPDATE' IN v_lock_source) = 0
     OR position('FOR UPDATE NOWAIT' IN v_lock_source) = 0
     OR position('r.lease_generation' IN v_lock_source) = 0 THEN
    RAISE EXCEPTION 'launch child helper lost receipt -> parent lock order or exact generation context';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = 'public.tournament_players'::regclass
          AND tg.tgname = 'aa_tournament_player_launch_proof_lock'
          AND NOT tg.tgisinternal
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = 'public.table_seats'::regclass
          AND tg.tgname = 'aa_tournament_live_seat_proof_lock'
          AND NOT tg.tgisinternal
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = 'public.tables'::regclass
          AND tg.tgname = 'aa_tournament_table_launch_proof_lock'
          AND NOT tg.tgisinternal
     ) THEN
    RAISE EXCEPTION 'a launch proof child table is missing its BEFORE lock trigger';
  END IF;

  SELECT tg.tgname INTO v_one_live_name
    FROM pg_trigger tg
   WHERE tg.tgrelid = 'public.table_seats'::regclass
     AND tg.tgname = 'trg_one_live_seat_per_tournament'
     AND NOT tg.tgisinternal;
  IF v_one_live_name IS NULL
     OR 'aa_tournament_live_seat_proof_lock' >= v_one_live_name
     OR position('p.status IN (''registered'', ''playing'')' IN v_seat_source) = 0
     OR position('fn_lock_tournament_launch_proof_parents' IN v_seat_source) = 0 THEN
    RAISE EXCEPTION 'live tournament seats are not roster-proven and serialized before one-live-seat';
  END IF;

  IF position('v_must_lock_live_seat_invariant' IN v_player_source) = 0
     OR position($needle$TG_OP = 'DELETE'$needle$ IN v_player_source) = 0
     OR position('NEW.tournament_id IS DISTINCT FROM OLD.tournament_id' IN v_player_source) = 0
     OR position('NEW.user_id IS DISTINCT FROM OLD.user_id' IN v_player_source) = 0
     OR position($needle$OLD.status IN ('registered', 'playing')$needle$ IN v_player_source) = 0
     OR position($needle$NEW.status IN ('registered', 'playing')$needle$ IN v_player_source) = 0
     OR position(
          'AND NOT v_must_lock_live_seat_invariant' IN v_player_source
        ) = 0 THEN
    RAISE EXCEPTION 'roster mutations can bypass the live-seat parent lock';
  END IF;

  IF position('upper(v_parent_status) = ''RUNNING''' IN v_table_source) = 0
     OR position('''capacity''' IN v_table_source) = 0
     OR position('''prelaunch''' IN v_table_source) = 0
     OR position('v_launch_generation' IN v_table_source) = 0
     OR position('STALE_TOURNAMENT_LAUNCH_TABLE' IN v_table_source) = 0 THEN
    RAISE EXCEPTION 'tournament table birth lost durable origin classification';
  END IF;
  IF position('''legacy''' IN v_table_source) > 0 THEN
    RAISE EXCEPTION 'runtime table classification may not mint legacy provenance';
  END IF;

  IF position('tournament_capacity_table_receipts' IN v_origin_source) = 0
     OR position(
          'fn_stage_a_bridge_legacy_capacity_receipt' IN v_origin_source
        ) = 0
     OR position('r.launch_id = NEW.launch_id' IN v_origin_source) = 0
     OR position('r.lease_generation = NEW.launch_lease_generation' IN v_origin_source) = 0
     OR position('r.completed_at IS NULL' IN v_origin_source) = 0
     OR position('ELSIF NEW.origin_kind = ''legacy'' THEN' IN v_origin_source) = 0 THEN
    RAISE EXCEPTION 'deferred table-origin proof lost capacity, exact launch, or honest legacy validation';
  END IF;

  IF position('request.headers' IN v_legacy_capacity_bridge_source) = 0
     OR position('request.jwt.claims' IN v_legacy_capacity_bridge_source) = 0
     OR position('auth.role()' IN v_legacy_capacity_bridge_source) = 0
     OR position($needle$'legacy-unmarked'$needle$
                 IN v_legacy_capacity_bridge_source) = 0
     OR position($needle$v_method <> 'POST'$needle$
                 IN v_legacy_capacity_bridge_source) = 0
     OR position($needle$v_path <> 'tables'$needle$
                 IN v_legacy_capacity_bridge_source) = 0
     OR position('l.protocol_version = 1'
                 IN v_legacy_capacity_bridge_source) = 0
     OR position('v_stale_seconds constant integer := 30'
                 IN v_legacy_capacity_bridge_source) = 0
     OR position('FOR SHARE' IN v_legacy_capacity_bridge_source) = 0
     OR position('fn_emit_tournament_manager_wake'
                 IN v_legacy_capacity_bridge_source) = 0
     OR position('INSERT INTO public.tournament_capacity_table_receipts'
                 IN v_legacy_capacity_bridge_source) = 0 THEN
    RAISE EXCEPTION 'Stage-A legacy capacity bridge is broad or non-canonical';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger tg
     WHERE tg.tgrelid = 'public.tournament_table_origins'::regclass
       AND tg.tgname = 'tournament_table_origin_is_proven'
       AND tg.tgconstraint <> 0
       AND tg.tgdeferrable
       AND tg.tginitdeferred
       AND NOT tg.tgisinternal
  ) THEN
    RAISE EXCEPTION 'table origin proof is not DEFERRABLE INITIALLY DEFERRED';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_constraint c
        WHERE c.conrelid = 'public.tournament_table_origins'::regclass
          AND c.conname = 'tournament_table_origins_table_fk'
          AND c.condeferrable
          AND c.condeferred
     )
     OR (
       SELECT count(*)
         FROM pg_trigger tg
        WHERE tg.tgname IN (
          'tournament_live_seat_has_active_roster',
          'tournament_live_seat_update_has_active_roster',
          'tournament_roster_cannot_orphan_live_seat',
          'tournament_roster_update_cannot_orphan_live_seat'
        )
          AND tg.tgconstraint <> 0
          AND tg.tgdeferrable
          AND tg.tginitdeferred
          AND NOT tg.tgisinternal
     ) <> 4 THEN
    RAISE EXCEPTION 'same-transaction table birth or live-seat roster proof is not deferred';
  END IF;

  IF position('INSERT INTO public.tables' IN v_capacity_source) = 0
     OR position('INSERT INTO public.tournament_capacity_table_receipts' IN v_capacity_source)
        <= position('INSERT INTO public.tables' IN v_capacity_source) THEN
    RAISE EXCEPTION 'canonical capacity no longer creates table then same-transaction receipt';
  END IF;

  IF (SELECT count(*) FROM public.tables t WHERE t.tournament_id IS NOT NULL)
     <> (SELECT count(*) FROM public.tournament_table_origins) THEN
    RAISE EXCEPTION 'existing tournament table origin backfill is incomplete';
  END IF;

  IF NOT (SELECT c.relrowsecurity
            FROM pg_class c
           WHERE c.oid = 'public.tournament_table_origins'::regclass)
     OR has_table_privilege('anon', 'public.tournament_table_origins', 'SELECT')
     OR has_table_privilege('authenticated', 'public.tournament_table_origins', 'SELECT')
     OR has_table_privilege('service_role', 'public.tournament_table_origins', 'INSERT')
     OR has_function_privilege(
       'service_role',
       'public.fn_lock_tournament_launch_proof_parents(uuid[])',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'launch table provenance or private lock helper ACL is unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid IN (
       'public.fn_lock_tournament_launch_proof_parents(uuid[])'::regprocedure,
       'public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)'::regprocedure,
       'public.trg_lock_tournament_player_launch_proof()'::regprocedure,
       'public.trg_lock_and_validate_tournament_live_seat()'::regprocedure,
       'public.trg_lock_and_classify_tournament_table()'::regprocedure,
       'public.trg_validate_tournament_table_origin()'::regprocedure,
       'public.trg_assert_live_tournament_seat_has_roster()'::regprocedure
     )
       AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION 'a launch child serialization trigger/helper is not SECURITY DEFINER';
  END IF;
END;
$assert_tournament_launch_child_serialization$;

COMMIT;
