-- ============================================================================
--  THE MAINTENANCE ANNOUNCEMENT AND EVERY NEW ENTRY HAVE ONE LINEAR ORDER
--
-- `engine_maintenance_break` used to be written independently from rebuy and
-- add-on transactions. A purchase could prove that the platform was open,
-- pause while the :53 `last_hand` announcement committed, and then debit the
-- wallet and grow the prize pool inside the maintenance window. Checking the
-- row twice only narrows that race; it does not close it.
--
-- The durable order is a transaction-scoped advisory read/write lock:
--
--   * maintenance-row INSERT / UPDATE / DELETE takes the EXCLUSIVE lock in a
--     statement trigger, so every writer (including future direct writers) is
--     covered;
--   * registration, cash-seat admission, tournament launch, rebuy and add-on
--     transactions take the SHARED lock before their authoritative gate and
--     hold it through commit or rollback;
--   * ordinary purchases remain concurrent with one another, while a waiting
--     maintenance announcement becomes the single boundary none can cross.
--
-- The entry-only predicate includes the bounded `last_hand` phase. The global
-- money freeze deliberately does not: the hand already in the air must still
-- be able to settle. This therefore closes new entry without ever refusing a
-- pot settlement.
-- ============================================================================

BEGIN;

/* A process may be replaced while both generations can still run cleanup.
   Semantic timestamps are identical on an adopted row, so they cannot prove
   ownership. One opaque token does: adoption atomically rotates it, and every
   later save/clear is a compare-and-set on that exact generation. */
ALTER TABLE public.engine_maintenance_break
  ADD COLUMN IF NOT EXISTS ownership_token uuid;
UPDATE public.engine_maintenance_break
   SET ownership_token = gen_random_uuid()
 WHERE ownership_token IS NULL;
ALTER TABLE public.engine_maintenance_break
  ALTER COLUMN ownership_token SET NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.engine_maintenance_break b
     WHERE b.enforce_freeze
       AND (
         (
           b.phase = 'last_hand'
           /* The engine can legitimately adopt this row until its own
              announcement-anchored :53 -> :00 window ends. Four minutes
              reopened admissions at :57 while a restarted engine still had
              every table parked through :00. */
           AND b.announced_at + INTERVAL '7 minutes' > clock_timestamp()
           AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
         )
         OR
         (
           b.phase = 'counting_down'
           AND b.break_ends_at > clock_timestamp()
           AND b.break_ends_at < clock_timestamp() + INTERVAL '15 minutes'
         )
       )
  );
$function$;

COMMENT ON FUNCTION public.fn_entry_purchases_frozen() IS
  'True while a bounded last-hand announcement or countdown forbids new seats, registrations, launches, rebuys and add-ons. Unlike fn_platform_frozen, this entry-only predicate includes last_hand while allowing the hand already in flight to settle.';

GRANT EXECUTE ON FUNCTION public.fn_entry_purchases_frozen()
  TO anon, authenticated, service_role;

/* The browser and the admission predicate must describe the same persisted
   window after an engine crash. A last_hand row has no stored break_ends_at,
   but its end is not unknown: :53 announcement + two-minute lead + five-minute
   break. Returning that derived instant lets a browser loaded at :59 expire at
   :00 instead of starting a fresh local four-minute timer. */
CREATE OR REPLACE FUNCTION public.fn_maintenance_break_state()
RETURNS TABLE (
  phase text,
  break_ends_at timestamptz,
  remaining_ms integer,
  reason text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  WITH candidate AS (
    SELECT b.phase,
           CASE
             WHEN b.phase = 'last_hand' THEN b.announced_at + INTERVAL '7 minutes'
             ELSE b.break_ends_at
           END AS effective_end,
           b.announced_at,
           b.reason
      FROM public.engine_maintenance_break b
     WHERE b.enforce_freeze
  )
  SELECT c.phase,
         c.effective_end,
         GREATEST(
           0,
           LEAST(
             15 * 60 * 1000,
             EXTRACT(EPOCH FROM (c.effective_end - NOW())) * 1000
           )
         )::integer,
         c.reason
    FROM candidate c
   WHERE c.effective_end > NOW()
     AND c.effective_end < NOW() + INTERVAL '15 minutes'
     AND (
       c.phase <> 'last_hand'
       OR c.announced_at < NOW() + INTERVAL '30 seconds'
     );
$function$;

COMMENT ON FUNCTION public.fn_maintenance_break_state() IS
  'The live maintenance break and its absolute announcement-anchored end. Last-hand and countdown state self-expire at the same instant used by the engine entry freeze.';

GRANT EXECUTE ON FUNCTION public.fn_maintenance_break_state()
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_serialize_engine_maintenance_break_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  /* PostgreSQL takes ACCESS EXCLUSIVE before firing a TRUNCATE trigger. Waiting
     for the advisory boundary from there would invert the canonical order
     against an admitted entry that next reads this table. This singleton has
     no legitimate truncate path, so refuse immediately instead of deadlocking. */
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'engine_maintenance_break may not be truncated'
      USING ERRCODE = '0A000';
  END IF;
  /* One exclusive writer boundary. The matching entry paths take this key in
     shared mode, so purchases stay concurrent with each other but can never
     straddle a maintenance-row commit. Transaction scope prevents a pooled
     connection from retaining the lock. */
  PERFORM pg_advisory_xact_lock(530090, 1);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS aa_serialize_maintenance_break_write
  ON public.engine_maintenance_break;
CREATE TRIGGER aa_serialize_maintenance_break_write
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.engine_maintenance_break
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_serialize_engine_maintenance_break_write();

REVOKE ALL ON FUNCTION public.fn_serialize_engine_maintenance_break_write()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE TRUNCATE ON TABLE public.engine_maintenance_break
  FROM PUBLIC, anon, authenticated, service_role;

/* The engine used to write the row through an ordinary PostgREST table
   upsert. `service_role` has an eight-second statement timeout in production,
   while an already-admitted entry transaction is deliberately allowed up to
   thirty seconds to finish. The exclusive boundary could therefore time out
   before the valid shared holder committed, cancel the visible break, and
   miss the hour entirely.

   These two service-only RPCs give the boundary writer a timeout larger than
   the maximum guarded entry transaction. The advisory lock is literally the
   first statement, before the UPSERT/DELETE can acquire a row lock. The table
   trigger remains installed as the backstop for every future direct writer. */
CREATE OR REPLACE FUNCTION public.fn_save_engine_maintenance_break(
  p_phase text,
  p_announced_at timestamptz,
  p_break_started_at timestamptz,
  p_break_ends_at timestamptz,
  p_reason text,
  p_declared_by text,
  p_ownership_token uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '45s'
SET lock_timeout = '40s'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  IF p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_TOKEN_REQUIRED'
      USING ERRCODE = '22004';
  END IF;
  PERFORM pg_advisory_xact_lock(530090, 1);
  INSERT INTO public.engine_maintenance_break (
    id, phase, announced_at, break_started_at, enforce_freeze,
    break_ends_at, reason, declared_by, ownership_token, updated_at
  ) VALUES (
    true, p_phase, p_announced_at, p_break_started_at, true,
    p_break_ends_at, p_reason, p_declared_by, p_ownership_token, clock_timestamp()
  )
  ON CONFLICT (id) DO UPDATE SET
    phase = EXCLUDED.phase,
    announced_at = EXCLUDED.announced_at,
    break_started_at = EXCLUDED.break_started_at,
    enforce_freeze = EXCLUDED.enforce_freeze,
    break_ends_at = EXCLUDED.break_ends_at,
    reason = EXCLUDED.reason,
    declared_by = EXCLUDED.declared_by,
    ownership_token = EXCLUDED.ownership_token,
    updated_at = EXCLUDED.updated_at
  WHERE public.engine_maintenance_break.ownership_token = EXCLUDED.ownership_token;
  /* The conflict row may only belong to this exact generation. Without this
     predicate a retiring process can overwrite the token a replacement just
     claimed and regain authority over the row. */
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_LOST: save refused'
      USING ERRCODE = '40001';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_save_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_save_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, text, uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_claim_engine_maintenance_break(
  p_expected_ownership_token uuid,
  p_new_ownership_token uuid,
  p_declared_by text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '45s'
SET lock_timeout = '40s'
AS $function$
DECLARE
  v_row public.engine_maintenance_break%ROWTYPE;
BEGIN
  IF p_expected_ownership_token IS NULL OR p_new_ownership_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_token_required');
  END IF;
  PERFORM pg_advisory_xact_lock(530090, 1);
  SELECT * INTO v_row
    FROM public.engine_maintenance_break b
   WHERE b.id = true
   FOR UPDATE;
  IF NOT FOUND OR v_row.ownership_token <> p_expected_ownership_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_changed');
  END IF;
  UPDATE public.engine_maintenance_break
     SET ownership_token = p_new_ownership_token,
         declared_by = p_declared_by,
         updated_at = clock_timestamp()
   WHERE id = true
     AND ownership_token = p_expected_ownership_token
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_changed');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'phase', v_row.phase,
    'announced_at', v_row.announced_at,
    'break_started_at', v_row.break_started_at,
    'break_ends_at', v_row.break_ends_at,
    'reason', v_row.reason,
    'ownership_token', v_row.ownership_token
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_claim_engine_maintenance_break(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_engine_maintenance_break(uuid, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_clear_engine_maintenance_break(
  p_phase text,
  p_announced_at timestamptz,
  p_break_started_at timestamptz,
  p_break_ends_at timestamptz,
  p_reason text,
  p_ownership_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '45s'
SET lock_timeout = '40s'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_REQUIRED: a break may only clear its own generation'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(530090, 1);
  DELETE FROM public.engine_maintenance_break b
   WHERE b.id = true
     AND b.phase IS NOT DISTINCT FROM p_phase
     AND b.announced_at IS NOT DISTINCT FROM p_announced_at
     AND b.break_started_at IS NOT DISTINCT FROM p_break_started_at
     AND b.break_ends_at IS NOT DISTINCT FROM p_break_ends_at
     AND b.reason IS NOT DISTINCT FROM p_reason
     AND b.ownership_token = p_ownership_token;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_clear_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_clear_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, uuid
) TO service_role;

/* Take the shared side at STATEMENT START for tournament-player INSERTs, whose
   satellite settlement path may already own several economic rows by the time
   the row trigger fires. The canonical multi-statement RPCs below take this
   lock as their first statement. Cash-seat INSERTs and RUNNING transitions use
   a fail-fast row backstop because tournament table-balancing/status updates
   are non-admissions and must never queue behind an exclusive writer late. */
CREATE OR REPLACE FUNCTION public.fn_serialize_entry_statement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  /* This is a backstop for a direct/unwrapped INSERT. A canonical RPC already
     owns the shared lock before touching any rows. An unexpected outer caller
     may already own unrelated rows, so waiting behind a queued maintenance
     writer here could form a soft deadlock. Fail the whole statement
     immediately and transactionally instead; the caller may retry from its
     outer boundary. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS aa_serialize_table_seat_insert ON public.table_seats;

DROP TRIGGER IF EXISTS aa_serialize_tournament_player_insert
  ON public.tournament_players;
CREATE TRIGGER aa_serialize_tournament_player_insert
  BEFORE INSERT ON public.tournament_players
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_serialize_entry_statement();

DROP TRIGGER IF EXISTS aa_serialize_tournament_launch ON public.tournaments;

REVOKE ALL ON FUNCTION public.fn_serialize_entry_statement()
  FROM PUBLIC, anon, authenticated, service_role;

/* Replace the existing entry guard in place so its three attached row triggers
   keep their OID binding. Canonical admission RPCs acquire the shared boundary
   before any row mutation; this trigger is the fail-fast direct-SQL backstop. */
CREATE OR REPLACE FUNCTION public.fn_refuse_new_entries_while_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_is_cash boolean;
BEGIN
  /* Classify non-admissions before asking for the boundary. Departures,
     ordinary seat updates, tournament table balancing, earned satellite
     seats, and non-RUNNING status changes can arrive inside transactions that
     already own their own rows. They are not new entry and must never acquire
     this lock late. */
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'UPDATE'
       AND NOT (
         (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL)
         OR OLD.user_id IS DISTINCT FROM NEW.user_id
       ) THEN
      RETURN NEW;
    END IF;

    SELECT (t.tournament_id IS NULL) INTO v_is_cash
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    /* Tournament seating is movement inside an already-admitted field. This
       includes INSERT and reuse of a vacated destination row (UPDATE that
       clears left_at or changes user_id). Freezing the latter after its source
       seat was vacated strands a player between tables. New tournament entry
       remains guarded at tournament_players and in its canonical outer RPC. */
    IF NOT COALESCE(v_is_cash, true) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'tournaments' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'RUNNING' THEN
      RETURN NEW;
    END IF;
    /* This is not a new launch: fn_begin_tournament_launch_atomic already
       admitted it before the maintenance boundary. Only the private completion
       RPC can set this exact transaction-local marker, and the immutable
       incomplete receipt proves which launch it is completing. */
    IF OLD.status = 'REGISTERING'
       AND EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_tournament_launch', true)
                = NEW.id::text || ':' || r.launch_id::text
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_LAUNCH_RECEIPT_REQUIRED: REGISTERING to RUNNING belongs to the atomic launch completion RPC'
      USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    /* Every roster insertion must serialize on its tournament parent before
       launch completion proves the field. Canonical registration functions
       already take this lock before their first child mutation, so this is
       re-entrant there; it closes the direct-owner/legacy path that could
       otherwise commit a new registered row between completion's roster read
       and its RUNNING write. */
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
        USING ERRCODE = '23503';
    END IF;

    IF COALESCE(NEW.is_satellite_qualifier, false)
       AND NEW.source_satellite_id IS NOT NULL
       AND current_setting('app.atomic_satellite_settlement', true)
           = NEW.source_satellite_id::text THEN
      RETURN NEW;
    END IF;
  END IF;

  /* Canonical RPCs own this already, so try-lock is re-entrant. A direct or
     previously unknown outer caller fails without waiting while it may hold
     other rows; this is the deadlock-safe backstop, not the normal path. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN NEW;
  END IF;

  IF NOT public.fn_entry_purchases_frozen() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'PLATFORM_FROZEN: scheduled maintenance has closed new entries. % on % was refused without moving chips.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55006',
          HINT = 'Retry after the maintenance break has ended.';
END;
$function$;

COMMENT ON FUNCTION public.fn_refuse_new_entries_while_frozen() IS
  'Serializes new cash seats, tournament registrations and launches against the maintenance announcement, then refuses them during both last_hand and counting_down. Existing tournament-seat moves and in-flight hand settlement remain allowed.';

REVOKE ALL ON FUNCTION public.fn_refuse_new_entries_while_frozen()
  FROM PUBLIC, anon, authenticated;
/* All supported roster entry doors are SECURITY DEFINER RPCs. Keeping direct
   service-role INSERT authority would leave an unwrapped path around their
   request receipts and status gates, even though the parent-row trigger above
   now serializes it safely. Remove that path at the catalog boundary. */
REVOKE INSERT ON TABLE public.tournament_players FROM service_role;

/* Seat-first games can reactivate a departed row instead of INSERTing. Put
   that admission shape behind the same row predicate; ordinary stack/status
   updates and tournament table moves remain untouched. */
DROP TRIGGER IF EXISTS zz_freeze_entry_guard ON public.table_seats;
CREATE TRIGGER zz_freeze_entry_guard
  BEFORE INSERT OR UPDATE OF left_at, user_id ON public.table_seats
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();

/* A committed purchase must remain answerable after the maintenance boundary.
   The legacy cash key tables do not bind every immutable input (some do not
   even name the table), so treating a key-only match as success can acknowledge
   a substituted request. These receipts bind the COMPLETE semantic request to
   the exact response in the same transaction as the money mutation. A retry
   reads this proof before the freeze gate; a reused key with different inputs
   fails closed. */
CREATE TABLE IF NOT EXISTS public.entry_purchase_idempotency_receipts (
  key_domain text NOT NULL,
  idempotency_key text NOT NULL,
  request jsonb NOT NULL,
  response jsonb,
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  CONSTRAINT entry_purchase_idempotency_receipts_pkey
    PRIMARY KEY (key_domain, idempotency_key),
  CONSTRAINT entry_purchase_idempotency_receipts_domain_nonempty
    CHECK (length(btrim(key_domain)) > 0),
  CONSTRAINT entry_purchase_idempotency_receipts_key_nonempty
    CHECK (length(btrim(idempotency_key)) > 0)
);

ALTER TABLE public.entry_purchase_idempotency_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.entry_purchase_idempotency_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_entry_purchase_receipt_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.response IS NOT NULL OR OLD.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'ENTRY_PURCHASE_RECEIPT_IMMUTABLE: completed receipts cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.key_domain IS DISTINCT FROM NEW.key_domain
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request IS DISTINCT FROM NEW.request
     OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
     OR OLD.response IS NOT NULL
     OR NEW.response IS NULL
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'ENTRY_PURCHASE_RECEIPT_IMMUTABLE: only the first completion is allowed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS z_entry_purchase_receipt_is_immutable
  ON public.entry_purchase_idempotency_receipts;
CREATE TRIGGER z_entry_purchase_receipt_is_immutable
  BEFORE UPDATE OR DELETE ON public.entry_purchase_idempotency_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_entry_purchase_receipt_is_immutable();

REVOKE ALL ON FUNCTION public.trg_entry_purchase_receipt_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_claim_entry_purchase_receipt(
  p_key_domain text,
  p_idempotency_key text,
  p_request jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  INSERT INTO public.entry_purchase_idempotency_receipts
    (key_domain, idempotency_key, request)
  VALUES (p_key_domain, p_idempotency_key, p_request)
  ON CONFLICT (key_domain, idempotency_key) DO NOTHING
  RETURNING request, response INTO v_request, v_response;
  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  /* The unique-index wait above cannot observe an uncommitted placeholder.
     A committed placeholder without a response means some code violated the
     same-transaction contract, so it is corruption-not permission to rerun
     a money core. */
  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key is already bound to a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NULL THEN
    RAISE EXCEPTION
      'INCOMPLETE_IDEMPOTENCY_RECEIPT: % key was committed without its response',
      p_key_domain
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('claimed', false, 'response', v_response);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_record_entry_purchase_receipt(
  p_key_domain text,
  p_idempotency_key text,
  p_request jsonb,
  p_response jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN p_response;
  END IF;
  IF p_request IS NULL OR p_response IS NULL THEN
    RAISE EXCEPTION 'entry purchase receipts require a non-null request and response'
      USING ERRCODE = '22004';
  END IF;

  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key completed concurrently for a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NOT NULL THEN
    RETURN v_response;
  END IF;

  UPDATE public.entry_purchase_idempotency_receipts r
     SET response = p_response,
         completed_at = transaction_timestamp()
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
     AND r.request IS NOT DISTINCT FROM p_request
     AND r.response IS NULL
  RETURNING r.response INTO STRICT v_response;
  RETURN v_response;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_release_entry_purchase_claim(
  p_key_domain text,
  p_idempotency_key text,
  p_request jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN;
  END IF;
  DELETE FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
     AND r.request IS NOT DISTINCT FROM p_request
     AND r.response IS NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_claim_entry_purchase_receipt(text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_record_entry_purchase_receipt(text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_release_entry_purchase_claim(text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
/* These are implementation details of the SECURITY DEFINER purchase doors.
   Granting them to service_role would expose three independent PostgREST RPCs
   capable of claiming, completing, or discarding a receipt without moving the
   corresponding money in the same transaction. Keep them owner-only. */

/* Canonical multi-statement entry RPCs must acquire the boundary BEFORE any
   parent/mission/wallet row. Their existing audited implementations remain
   byte-for-byte under private names; the public shapes are narrow first-lock
   delegates. This prevents the row-lock -> queued-exclusive -> shared-lock
   soft-deadlock that a trigger acquired too late. */
DO $wrap_registration_order_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_register_for_tournament_before_maintenance_announcement_gate(uuid,boolean)')
     IS NULL THEN
    IF to_regprocedure('public.fn_register_for_tournament(uuid,boolean)') IS NULL THEN
      RAISE EXCEPTION 'canonical two-argument tournament registration missing';
    END IF;
    ALTER FUNCTION public.fn_register_for_tournament(uuid, boolean)
      RENAME TO fn_register_for_tournament_before_maintenance_announcement_gate;
  END IF;
END;
$wrap_registration_order_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament_before_maintenance_announcement_gate(
  uuid, boolean
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(
  p_tournament_id uuid,
  p_seat_first_internal boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_register_for_tournament_before_maintenance_announcement_gate(
    p_tournament_id, p_seat_first_internal
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament(uuid, boolean)
  TO service_role;

DO $wrap_horse_registration_order_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)')
     IS NULL THEN
    IF to_regprocedure('public.fn_register_horse_for_tournament(uuid,uuid)') IS NULL THEN
      RAISE EXCEPTION 'canonical horse tournament registration missing';
    END IF;
    ALTER FUNCTION public.fn_register_horse_for_tournament(uuid, uuid)
      RENAME TO fn_register_horse_for_tournament_before_maintenance_gate;
  END IF;
END;
$wrap_horse_registration_order_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(
  uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_maintenance_gate(
    p_tournament_id, p_user_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid)
  TO service_role;

DO $wrap_seat_first_human_order_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)')
     IS NULL THEN
    IF to_regprocedure('public.fn_take_seat_and_buy_in(uuid,integer)') IS NULL THEN
      RAISE EXCEPTION 'canonical seat-first human purchase missing';
    END IF;
    ALTER FUNCTION public.fn_take_seat_and_buy_in(uuid, integer)
      RENAME TO fn_take_seat_and_buy_in_before_maintenance_announcement_gate;
  END IF;
END;
$wrap_seat_first_human_order_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(
  uuid, integer
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in(
  p_table_id uuid,
  p_seat_number integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(
    p_table_id, p_seat_number
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_take_seat_and_buy_in(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_take_seat_and_buy_in(uuid, integer)
  TO authenticated, service_role;

DO $wrap_seat_first_horse_order_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)')
     IS NULL THEN
    IF to_regprocedure('public.fn_seat_horse_in_seat_first_game(uuid,uuid)') IS NULL THEN
      RAISE EXCEPTION 'canonical seat-first horse purchase missing';
    END IF;
    ALTER FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid)
      RENAME TO fn_seat_horse_in_seat_first_game_before_maintenance_gate;
  END IF;
END;
$wrap_seat_first_horse_order_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(
  uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(
    p_tournament_id, p_user_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid)
  TO service_role;

DO $wrap_late_reg_seating_order_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)')
     IS NULL THEN
    IF to_regprocedure('public.fn_seat_late_registrant(uuid,uuid)') IS NULL THEN
      RAISE EXCEPTION 'canonical late-registrant seating function missing';
    END IF;
    ALTER FUNCTION public.fn_seat_late_registrant(uuid, uuid)
      RENAME TO fn_seat_late_registrant_before_maintenance_gate;
  END IF;
END;
$wrap_late_reg_seating_order_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_seat_late_registrant_before_maintenance_gate(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_seat_late_registrant_before_maintenance_gate(
    p_tournament_id, p_user_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_seat_late_registrant(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_late_registrant(uuid, uuid)
  TO service_role;

/* The repair sweep is an outer transaction around repeated horse-seat calls.
   Acquiring the shared maintenance boundary only in the inner call is too
   late: the sweep already owns its singleton advisory lock and can already
   have created/locked a table. A queued exclusive announcement plus a new
   entry waiting on those repair locks can then form a soft deadlock. The
   public sweep therefore takes the shared boundary before even its singleton
   lock, and it performs no repair at all during last_hand/counting_down. */
DO $wrap_seat_first_repair_order_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_repair_seat_first_games_before_maintenance_gate(integer)')
     IS NULL THEN
    IF to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NULL THEN
      RAISE EXCEPTION 'canonical seat-first repair function missing';
    END IF;
    ALTER FUNCTION public.fn_repair_seat_first_games(integer)
      RENAME TO fn_repair_seat_first_games_before_maintenance_gate;
  END IF;
END;
$wrap_seat_first_repair_order_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games_before_maintenance_gate(integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games(
  p_limit integer DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object(
      'repaired', 0,
      'horses_seated', 0,
      'out_of_time', false,
      'skipped', 'platform_frozen',
      'elapsed_ms', 0
    );
  END IF;
  RETURN public.fn_repair_seat_first_games_before_maintenance_gate(p_limit);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_repair_seat_first_games(integer)
  TO service_role;

/* Cash seat moves INSERT the destination seat after locking the move and both
   seats. They therefore need the same outer first-lock rule as seat-first
   repair: maintenance-first refuses before any move mutation; move-first owns
   the boundary until both seats and the durable move receipt agree. */
DO $wrap_cash_seat_moves_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_cash_seat_move_execute_before_maintenance_gate(uuid)')
     IS NULL THEN
    IF to_regprocedure('public.fn_cash_seat_move_execute(uuid)') IS NULL THEN
      RAISE EXCEPTION 'canonical cash seat move executor missing';
    END IF;
    ALTER FUNCTION public.fn_cash_seat_move_execute(uuid)
      RENAME TO fn_cash_seat_move_execute_before_maintenance_gate;
  END IF;

  IF to_regprocedure('public.fn_cash_seat_swap_execute_before_maintenance_gate(uuid)')
     IS NULL THEN
    IF to_regprocedure('public.fn_cash_seat_swap_execute(uuid)') IS NULL THEN
      RAISE EXCEPTION 'canonical cash seat swap executor missing';
    END IF;
    ALTER FUNCTION public.fn_cash_seat_swap_execute(uuid)
      RENAME TO fn_cash_seat_swap_execute_before_maintenance_gate;
  END IF;
END;
$wrap_cash_seat_moves_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute_before_maintenance_gate(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_swap_execute_before_maintenance_gate(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute(p_move_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_cash_seat_swap_execute_before_maintenance_gate(p_move_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute(p_move_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_cash_seat_move_execute_before_maintenance_gate(p_move_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_execute(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_swap_execute(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_swap_execute(uuid)
  TO service_role;

/* A tournament launch used to cross the maintenance boundary only after Spin
   settlement, registration migration, stack credits, and table creation. A
   crash-safe launch now has two durable edges: begin admits and records the
   immutable launch while the tournament remains REGISTERING; complete proves
   all setup, marks the same receipt complete and flips RUNNING atomically just
   before any dealer is admitted. A crash between those edges is discoverable
   as REGISTERING and resumes the idempotent setup path. */
CREATE TABLE IF NOT EXISTS public.tournament_launch_receipts (
  tournament_id uuid PRIMARY KEY
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  launch_id uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz
);

ALTER TABLE public.tournament_launch_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_launch_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_tournament_launch_receipt_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'completed tournament launch receipts cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     OR NEW.launch_id IS DISTINCT FROM OLD.launch_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
     OR (OLD.completed_at IS NULL AND NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'a tournament launch receipt may only be completed once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_launch_receipt_is_immutable
  ON public.tournament_launch_receipts;
CREATE TRIGGER tournament_launch_receipt_is_immutable
  BEFORE UPDATE OR DELETE ON public.tournament_launch_receipts
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_launch_receipt_is_immutable();

REVOKE ALL ON FUNCTION public.trg_tournament_launch_receipt_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

/* Once setup has crossed the durable launch admission edge, the receipt's
   timestamp is the advertised clock. Letting an owner, nudge, or repair writer
   move start_time underneath that receipt makes every retry reconstruct a
   different launch. Lock the schedule at the root; begin's adoption rule below
   remains the defensive path for drift that predates this trigger. */
CREATE OR REPLACE FUNCTION public.trg_lock_tournament_start_time_during_launch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.start_time IS DISTINCT FROM OLD.start_time
     AND EXISTS (
       SELECT 1
         FROM public.tournament_launch_receipts r
        WHERE r.tournament_id = OLD.id
          AND r.completed_at IS NULL
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_LAUNCH_START_TIME_LOCKED: an incomplete launch receipt owns the advertised start'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_start_time_locked_during_launch
  ON public.tournaments;
CREATE TRIGGER tournament_start_time_locked_during_launch
  BEFORE UPDATE OF start_time ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.trg_lock_tournament_start_time_during_launch();

REVOKE ALL ON FUNCTION public.trg_lock_tournament_start_time_during_launch()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_started_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_existing public.tournament_launch_receipts%ROWTYPE;
  v_status text;
  v_tournament_started_at timestamptz;
  v_requested_started_at timestamptz := COALESCE(p_started_at, transaction_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF p_tournament_id IS NULL OR p_launch_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT * INTO v_existing
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    IF p_started_at IS NOT NULL
       AND v_existing.launch_id = p_launch_id
       AND v_existing.started_at IS DISTINCT FROM p_started_at THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_request_mismatch');
    END IF;
    SELECT t.status, t.started_at INTO v_status, v_tournament_started_at
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND
       OR (v_existing.completed_at IS NULL AND v_status <> 'REGISTERING')
       OR (v_existing.completed_at IS NOT NULL
           AND (v_status <> 'RUNNING'
                OR v_tournament_started_at IS DISTINCT FROM v_existing.started_at)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'claimed', true,
      'launch_id', v_existing.launch_id,
      'replay', true,
      'started_at', v_existing.started_at,
      'completed', v_existing.completed_at IS NOT NULL,
      'status', v_status
    );
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  SELECT t.status, t.started_at INTO v_status, v_tournament_started_at
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF v_status <> 'REGISTERING' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_status_changed',
      'status', v_status
    );
  END IF;
  IF v_tournament_started_at IS NOT NULL
     AND v_tournament_started_at IS DISTINCT FROM v_requested_started_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_started_at_mismatch');
  END IF;

  INSERT INTO public.tournament_launch_receipts (
    tournament_id, launch_id, started_at
  ) VALUES (
    p_tournament_id, p_launch_id, v_requested_started_at
  );

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'launch_id', p_launch_id,
    'replay', false,
    'started_at', v_requested_started_at,
    'completed', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(
  p_tournament_id uuid,
  p_launch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_receipt public.tournament_launch_receipts%ROWTYPE;
  v_status text;
  v_started_at timestamptz;
  v_completed_at timestamptz := transaction_timestamp();
  v_required_field integer;
  v_active_count bigint;
  v_bad_roster_count bigint;
  v_live_seat_count bigint;
  v_bad_live_seat_count bigint;
  v_distinct_live_users bigint;
  v_distinct_live_coordinates bigint;
  v_matching_roster_seats bigint;
  v_bad_table_count bigint;
  v_is_paid_spin boolean;
  v_spin_multiplier numeric;
  v_spin_ledger_count bigint;
  v_spin_ledger_multiplier numeric;
BEGIN
  SELECT * INTO v_receipt
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_receipt.launch_id <> p_launch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;
  IF v_receipt.completed_at IS NOT NULL THEN
    SELECT t.status, t.started_at INTO v_status, v_started_at
      FROM public.tournaments t
     WHERE t.id = p_tournament_id;
    IF NOT FOUND OR v_status <> 'RUNNING'
       OR v_started_at IS DISTINCT FROM v_receipt.started_at THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'completed', true,
      'replay', true,
      'status', v_status,
      'started_at', v_started_at,
      'completed_at', v_receipt.completed_at
    );
  END IF;

  SELECT t.status,
         t.started_at,
         CASE WHEN COALESCE(t.max_players, 0) > 0
              THEN GREATEST(2, LEAST(3, t.max_players))
              ELSE 3 END,
         ((lower(COALESCE(t.variant, '')) = 'spin'
           OR upper(COALESCE(t.tournament_type, '')) = 'SPIN')
          AND COALESCE(t.buy_in_amount, 0) > 0),
         t.spin_multiplier
    INTO v_status, v_started_at, v_required_field,
         v_is_paid_spin, v_spin_multiplier
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_status <> 'REGISTERING'
     OR (v_started_at IS NOT NULL AND v_started_at IS DISTINCT FROM v_receipt.started_at) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
  END IF;

  /* Completion is the status transaction, so it owns the final database
     proof too. Every registration/admission path locks this tournament row:
     one that committed first is visible here and makes completion refuse;
     one waiting behind us observes RUNNING and rolls back. This removes the
     proof-to-complete race that no sequence of client reads can close. */
  SELECT count(*),
         count(*) FILTER (
           WHERE p.status <> 'playing'
              OR p.user_id IS NULL
              OR COALESCE(p.chips, 0) <= 0
              OR p.table_id IS NULL
              OR p.seat_number IS NULL
              OR p.seat_number <= 0
         )
    INTO v_active_count, v_bad_roster_count
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing');

  IF v_active_count < v_required_field OR v_bad_roster_count <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_roster_unproven',
      'active_players', v_active_count,
      'required_players', v_required_field,
      'invalid_players', v_bad_roster_count
    );
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE s.user_id IS NULL
              OR COALESCE(s.stack, 0) <= 0
              OR s.seat_number IS NULL
              OR s.seat_number <= 0
              OR s.seat_number > COALESCE(t.max_players, 0)
         ),
         count(DISTINCT s.user_id),
         count(DISTINCT (s.table_id, s.seat_number))
    INTO v_live_seat_count, v_bad_live_seat_count,
         v_distinct_live_users, v_distinct_live_coordinates
    FROM public.table_seats s
    JOIN public.tables t ON t.id = s.table_id
   WHERE t.tournament_id = p_tournament_id
     AND s.left_at IS NULL;

  SELECT count(*) INTO v_matching_roster_seats
    FROM public.tournament_players p
    JOIN public.table_seats s
      ON s.user_id = p.user_id
     AND s.table_id = p.table_id
     AND s.seat_number = p.seat_number
     AND s.left_at IS NULL
    JOIN public.tables t
      ON t.id = s.table_id
     AND t.tournament_id = p_tournament_id
   WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing');

  IF v_live_seat_count <> v_active_count
     OR v_bad_live_seat_count <> 0
     OR v_distinct_live_users <> v_active_count
     OR v_distinct_live_coordinates <> v_active_count
     OR v_matching_roster_seats <> v_active_count THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_seats_unproven',
      'active_players', v_active_count,
      'live_seats', v_live_seat_count,
      'matching_seats', v_matching_roster_seats
    );
  END IF;

  SELECT count(*) INTO v_bad_table_count
    FROM public.tables t
    LEFT JOIN (
      SELECT s.table_id, count(*) AS live_count
        FROM public.table_seats s
       WHERE s.left_at IS NULL
       GROUP BY s.table_id
    ) seats ON seats.table_id = t.id
   WHERE t.tournament_id = p_tournament_id
     AND (seats.table_id IS NULL
          OR t.status NOT IN ('running', 'waiting')
          OR t.current_players IS DISTINCT FROM seats.live_count);

  IF v_bad_table_count <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_tables_unproven',
      'invalid_tables', v_bad_table_count
    );
  END IF;

  IF v_is_paid_spin THEN
    SELECT count(*), min(l.multiplier)
      INTO v_spin_ledger_count, v_spin_ledger_multiplier
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind = 'jackpot_draw';
    IF v_spin_ledger_count <> 1
       OR COALESCE(v_spin_multiplier, 0) <= 0
       OR v_spin_ledger_multiplier IS DISTINCT FROM v_spin_multiplier THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'launch_spin_settlement_unproven',
        'draw_rows', v_spin_ledger_count
      );
    END IF;
  END IF;

  PERFORM set_config(
    'app.atomic_tournament_launch',
    p_tournament_id::text || ':' || p_launch_id::text,
    true
  );
  UPDATE public.tournaments
     SET status = 'RUNNING',
         started_at = v_receipt.started_at
   WHERE id = p_tournament_id
     AND status = 'REGISTERING';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament launch status changed inside its completion transaction'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.tournament_launch_receipts
     SET completed_at = v_completed_at
   WHERE tournament_id = p_tournament_id
     AND launch_id = p_launch_id
     AND completed_at IS NULL;
  RETURN jsonb_build_object(
    'ok', true,
    'completed', true,
    'replay', false,
    'status', 'RUNNING',
    'started_at', v_receipt.started_at,
    'completed_at', v_completed_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid)
  TO service_role;

/* A finalized satellite pool is normally immutable. Its one legitimate debit
   is delivery of a frozen seat entitlement during the private all-or-none
   satellite finalizer. The previous blanket trigger swallowed that debit in
   fn_award_satellite_seat's legacy warning path, after which the exact outer
   postcondition rolled the entire award back as unbacked. Admit only the one
   in-flight seat whose immutable batch, entitlement, source finisher and
   already-inserted target registration agree; every other finalized mutation
   keeps the original refusal. The outer settlement subtransaction then proves
   target pool/rake, source debit, payout and transfer ledger together or rolls
   every one of them back. */
CREATE OR REPLACE FUNCTION public.trg_freeze_finalized_tournament_prize_pool()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delta numeric;
  v_candidate_count integer := 0;
BEGIN
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND NOT COALESCE(NEW.prize_pool_finalized, false) THEN
    RAISE EXCEPTION
      'finalized tournament % prize pool cannot be reopened', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND (NEW.payout_structure IS DISTINCT FROM OLD.payout_structure
          OR NEW.spin_multiplier IS DISTINCT FROM OLD.spin_multiplier) THEN
    RAISE EXCEPTION
      'finalized tournament % payout structure and Spin draw cannot change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND round(COALESCE(NEW.guaranteed_prize, 0), 2)
         IS DISTINCT FROM round(COALESCE(OLD.guaranteed_prize, 0), 2) THEN
    RAISE EXCEPTION 'finalized tournament % guarantee cannot change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND round(COALESCE(NEW.prize_pool, 0), 2)
         IS DISTINCT FROM round(COALESCE(OLD.prize_pool, 0), 2) THEN
    v_delta := round(COALESCE(OLD.prize_pool, 0) - COALESCE(NEW.prize_pool, 0), 2);

    IF v_delta > 0
       AND COALESCE(NEW.prize_pool, 0) >= 0
       AND COALESCE(NEW.prize_pool_finalized, false)
       AND OLD.status = 'COMPLETING'
       AND OLD.satellite_target_id IS NOT NULL
       AND current_setting('app.atomic_satellite_settlement', true) = OLD.id::text
       /* No second column may hitchhike on the narrowly admitted debit. */
       AND (to_jsonb(NEW) - 'prize_pool') = (to_jsonb(OLD) - 'prize_pool') THEN
      SELECT count(*)::integer
        INTO v_candidate_count
        FROM public.tournament_satellite_settlement_batches b
        JOIN public.tournament_satellite_entitlements e
          ON e.tournament_id = b.tournament_id
         AND e.target_tournament_id = b.target_tournament_id
         AND e.target_tournament_id = OLD.satellite_target_id
         AND round(e.ticket_value, 2) = v_delta
        JOIN public.tournament_players source_player
          ON source_player.tournament_id = OLD.id
         AND source_player.position = e.position
         AND source_player.status IN ('winner', 'eliminated')
        JOIN public.tournament_players target_player
          ON target_player.tournament_id = e.target_tournament_id
         AND target_player.user_id = source_player.user_id
         AND COALESCE(target_player.is_satellite_qualifier, false)
         AND target_player.source_satellite_id = OLD.id
        JOIN public.tournaments target
          ON target.id = e.target_tournament_id
       WHERE b.tournament_id = OLD.id
         AND b.settled_at IS NULL
         AND round(
               GREATEST(COALESCE(target.buy_in_amount, 0), 0)
               + GREATEST(COALESCE(target.buy_in_fee, 0), 0),
               2
             ) = v_delta
         AND (
           SELECT count(*)::integer
             FROM public.rake_records target_rake
            WHERE target_rake.tournament_id = target.id
              AND target_rake.source = 'fn_award_satellite_seat'
              AND target_rake.metadata->>'satellite_id' = OLD.id::text
              AND target_rake.metadata->>'user_id' = source_player.user_id::text
              AND target_rake.metadata->>'registration_id' = target_player.id::text
         ) = CASE WHEN COALESCE(target.buy_in_fee, 0) > 0 THEN 1 ELSE 0 END
         AND (
           SELECT count(*)::integer
             FROM public.rake_records exact_target_rake
            WHERE exact_target_rake.tournament_id = target.id
              AND exact_target_rake.source = 'fn_award_satellite_seat'
              AND exact_target_rake.metadata->>'satellite_id' = OLD.id::text
              AND exact_target_rake.metadata->>'user_id' = source_player.user_id::text
              AND exact_target_rake.metadata->>'registration_id' = target_player.id::text
              AND round(exact_target_rake.rake_amount, 2)
                  = round(COALESCE(target.buy_in_fee, 0), 2)
              AND round(COALESCE(exact_target_rake.pot_size, 0), 2) = v_delta
         ) = CASE WHEN COALESCE(target.buy_in_fee, 0) > 0 THEN 1 ELSE 0 END
         /* At this exact instruction the target seat exists, but the source
            payout and transfer journal do not. A replay or second debit has
            either one and therefore cannot match this predicate. */
         AND NOT EXISTS (
           SELECT 1
             FROM public.tournament_payouts payout
            WHERE payout.tournament_id = OLD.id
              AND payout.user_id = source_player.user_id
              AND payout.position = e.position
              AND payout.source = 'satellite_seat'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM public.chip_ledger ledger
            WHERE ledger.idempotency_key =
              'tourney:' || OLD.id::text || ':seat:'
              || source_player.user_id::text || ':pool_transfer'
         );
    END IF;

    IF v_candidate_count = 1 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'finalized tournament % prize pool cannot change from % to %',
      NEW.id, OLD.prize_pool, NEW.prize_pool USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_freeze_finalized_tournament_prize_pool()
  FROM PUBLIC, anon, authenticated, service_role;

/* Satellite qualification is final-hand settlement. Acquire the same shared
   boundary first, set the existing transaction-local settlement marker in the
   private core, and keep the lower-level award helper unreachable. */
DO $wrap_satellite_settlement_order_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)')
     IS NULL THEN
    IF to_regprocedure('public.fn_settle_satellite_finish_atomic(uuid,text)') IS NULL THEN
      RAISE EXCEPTION 'canonical atomic satellite finalizer missing';
    END IF;
    ALTER FUNCTION public.fn_settle_satellite_finish_atomic(uuid, text)
      RENAME TO fn_settle_satellite_finish_atomic_before_maintenance_gate;
  END IF;
END;
$wrap_satellite_settlement_order_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic_before_maintenance_gate(
  uuid, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_finish_atomic(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine.satellite_finish'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  RETURN public.fn_settle_satellite_finish_atomic_before_maintenance_gate(
    p_tournament_id, p_source
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;

/* Preserve the audited purchase core under a private name and put the same
   shared transaction boundary around its complete wallet/ledger/pool/stack
   mutation. Renaming preserves the implementation and lets this migration
   remain a small, reviewable wrapper rather than retyping the money body. */
DO $wrap_rebuy_for_maintenance$
BEGIN
  IF to_regprocedure('public.process_tournament_rebuy_before_maintenance_announcement_gate(uuid,uuid,text,numeric,numeric,integer,text)')
     IS NULL THEN
    IF to_regprocedure('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)')
       IS NULL THEN
      RAISE EXCEPTION 'canonical process_tournament_rebuy function missing';
    END IF;
    ALTER FUNCTION public.process_tournament_rebuy(
      uuid, uuid, text, numeric, numeric, integer, text
    ) RENAME TO process_tournament_rebuy_before_maintenance_announcement_gate;
  END IF;
END;
$wrap_rebuy_for_maintenance$;

REVOKE ALL ON FUNCTION public.process_tournament_rebuy_before_maintenance_announcement_gate(
  uuid, uuid, text, numeric, numeric, integer, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text,
  p_cost numeric,
  p_chips numeric,
  p_current_level integer DEFAULT NULL,
  p_client_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_receipt_key text;
  v_request jsonb;
  v_response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT (COALESCE(auth.role(), 'service_role') = 'service_role')
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE = '42501';
  END IF;

  v_receipt_key := CASE
    WHEN p_rebuy_type = 'addon'
      THEN 'tourney:' || p_tournament_id::text || ':addon:' || p_user_id::text
    WHEN p_client_token IS NOT NULL AND length(btrim(p_client_token)) > 0
      THEN 'tourney:' || p_tournament_id::text || ':' || p_rebuy_type || ':' ||
           p_user_id::text || ':tok:' || btrim(p_client_token)
    ELSE NULL
  END;
  v_request := jsonb_build_object(
    'tournament_id', p_tournament_id,
    'user_id', p_user_id,
    'rebuy_type', p_rebuy_type,
    'cost', p_cost,
    'chips', p_chips,
    'current_level', p_current_level,
    'client_token', CASE WHEN p_client_token IS NULL THEN NULL ELSE btrim(p_client_token) END
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'tournament_chip_purchase', v_receipt_key, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN v_response->'response';
  END IF;

  /* A historical key has no response/argument receipt. It cannot truthfully
     answer a post-boundary retry, so refuse instead of guessing success from
     a key that binds only user and amount. Every call committed through this
     wrapper carries the complete receipt above in the same transaction. */
  IF v_receipt_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_receipt_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical tournament purchase key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed rebuys and add-ons; no chips moved'
      USING ERRCODE = '55006',
            HINT = 'Retry after the maintenance break has ended.';
  END IF;

  v_response := public.process_tournament_rebuy_before_maintenance_announcement_gate(
    p_tournament_id,
    p_user_id,
    p_rebuy_type,
    p_cost,
    p_chips,
    p_current_level,
    p_client_token
  );
  RETURN public.fn_record_entry_purchase_receipt(
    'tournament_chip_purchase', v_receipt_key, v_request, v_response
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.process_tournament_rebuy(
  uuid, uuid, text, numeric, numeric, integer, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(
  uuid, uuid, text, numeric, numeric, integer, text
) TO authenticated, service_role;

/* A cash-wallet door must never be usable as an alternate tournament-seat
   creator. The entry trigger intentionally permits tournament seat moves,
   because those move already-owned chips during balancing. Therefore each
   RPC which DEBITS a cash wallet or club treasury proves that its target is a
   real cash table before it reaches that intentionally exempt INSERT/UPDATE. */
CREATE OR REPLACE FUNCTION public.fn_assert_cash_chip_purchase_table(p_table_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_is_template boolean;
BEGIN
  SELECT t.tournament_id, COALESCE(t.is_template, false)
    INTO v_tournament_id, v_is_template
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TABLE_NOT_FOUND: cash chip purchase target does not exist'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION
      'CASH_PURCHASE_ONLY: cash buy-in, rebuy and add-on RPCs cannot fund a tournament table'
      USING ERRCODE = '55000';
  END IF;
  IF v_is_template THEN
    RAISE EXCEPTION 'IS_TEMPLATE: this is a saved table template, not a live game'
      USING ERRCODE = '55000';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assert_cash_chip_purchase_table(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_assert_cash_chip_purchase_table(uuid)
  TO service_role;

DO $wrap_cash_buyin_for_maintenance$
BEGIN
  IF to_regprocedure('public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)')
     IS NULL THEN
    IF to_regprocedure('public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)')
       IS NULL THEN
      RAISE EXCEPTION 'canonical atomic_table_buyin function missing';
    END IF;
    ALTER FUNCTION public.atomic_table_buyin(
      uuid, uuid, integer, numeric, boolean, uuid, uuid
    ) RENAME TO atomic_table_buyin_before_maintenance_announcement_gate;
  END IF;
END;
$wrap_cash_buyin_for_maintenance$;

REVOKE ALL ON FUNCTION public.atomic_table_buyin_before_maintenance_announcement_gate(
  uuid, uuid, integer, numeric, boolean, uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(
  p_user_id uuid,
  p_table_id uuid,
  p_seat_number integer,
  p_amount numeric,
  p_auto_rebuy boolean DEFAULT false,
  p_club_id uuid DEFAULT NULL::uuid,
  p_idempotency_key uuid DEFAULT NULL::uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_replay jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot buy in for another user' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object(
    'door', 'atomic_table_buyin',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'seat_number', p_seat_number,
    'amount', p_amount,
    'auto_rebuy', p_auto_rebuy,
    'club_id', p_club_id
  );
  v_replay := public.fn_claim_entry_purchase_receipt(
    'cash_transaction', p_idempotency_key::text, v_request
  );
  IF NOT COALESCE((v_replay->>'claimed')::boolean, false) THEN
    RETURN;
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transaction_idempotency_keys k
     WHERE k.key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical cash key does not prove its table and seat'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash buy-ins; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  PERFORM public.atomic_table_buyin_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_seat_number, p_amount, p_auto_rebuy,
    p_club_id, p_idempotency_key
  );
  PERFORM public.fn_record_entry_purchase_receipt(
    'cash_transaction',
    p_idempotency_key::text,
    v_request,
    jsonb_build_object('completed', true)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_table_buyin(
  uuid, uuid, integer, numeric, boolean, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_table_buyin(
  uuid, uuid, integer, numeric, boolean, uuid, uuid
) TO authenticated, service_role;

DO $wrap_cash_rebuy_for_maintenance$
BEGIN
  IF to_regprocedure('public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid)')
     IS NULL THEN
    IF to_regprocedure('public.atomic_table_rebuy(uuid,uuid,numeric,uuid)') IS NULL THEN
      RAISE EXCEPTION 'canonical atomic_table_rebuy function missing';
    END IF;
    ALTER FUNCTION public.atomic_table_rebuy(uuid, uuid, numeric, uuid)
      RENAME TO atomic_table_rebuy_before_maintenance_announcement_gate;
  END IF;
END;
$wrap_cash_rebuy_for_maintenance$;

REVOKE ALL ON FUNCTION public.atomic_table_rebuy_before_maintenance_announcement_gate(
  uuid, uuid, numeric, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric,
  p_idempotency_key uuid DEFAULT NULL::uuid
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
  v_balance numeric;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot rebuy for another player' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object(
    'door', 'atomic_table_rebuy',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'cash_transaction', p_idempotency_key::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN (v_response->'response'->>'balance')::numeric;
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transaction_idempotency_keys k
     WHERE k.key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical cash key does not prove its table'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash rebuys; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_balance := public.atomic_table_rebuy_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_amount, p_idempotency_key
  );
  v_response := public.fn_record_entry_purchase_receipt(
    'cash_transaction',
    p_idempotency_key::text,
    v_request,
    jsonb_build_object('balance', v_balance)
  );
  RETURN (v_response->>'balance')::numeric;
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_table_rebuy(uuid, uuid, numeric, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_table_rebuy(uuid, uuid, numeric, uuid)
  TO authenticated, service_role;

DO $wrap_cash_addon_for_maintenance$
BEGIN
  IF to_regprocedure('public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text)')
     IS NULL THEN
    IF to_regprocedure('public.atomic_table_addon(uuid,uuid,numeric,boolean,text)') IS NULL THEN
      RAISE EXCEPTION 'canonical atomic_table_addon function missing';
    END IF;
    ALTER FUNCTION public.atomic_table_addon(uuid, uuid, numeric, boolean, text)
      RENAME TO atomic_table_addon_before_maintenance_announcement_gate;
  END IF;
END;
$wrap_cash_addon_for_maintenance$;

REVOKE ALL ON FUNCTION public.atomic_table_addon_before_maintenance_announcement_gate(
  uuid, uuid, numeric, boolean, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.atomic_table_addon(
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric,
  p_apply_to_seat boolean DEFAULT true,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
  v_balance numeric;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  v_request := jsonb_build_object(
    'door', 'atomic_table_addon',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'amount', p_amount,
    'apply_to_seat', p_apply_to_seat
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'cash_addon', p_idempotency_key, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN (v_response->'response'->>'balance')::numeric;
  END IF;
  IF p_idempotency_key IS NOT NULL AND length(btrim(p_idempotency_key)) > 0
     AND EXISTS (
       SELECT 1 FROM public.table_addon_idempotency k
        WHERE k.key = p_idempotency_key
     ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical add-on key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash add-ons; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_balance := public.atomic_table_addon_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_amount, p_apply_to_seat, p_idempotency_key
  );
  v_response := public.fn_record_entry_purchase_receipt(
    'cash_addon',
    p_idempotency_key,
    v_request,
    jsonb_build_object('balance', v_balance)
  );
  RETURN (v_response->>'balance')::numeric;
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_table_addon(uuid, uuid, numeric, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_table_addon(uuid, uuid, numeric, boolean, text)
  TO service_role;

DO $wrap_horse_funding_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)')
     IS NULL THEN
    IF to_regprocedure('public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)') IS NULL THEN
      RAISE EXCEPTION 'canonical fn_horse_fund_from_treasury function missing';
    END IF;
    ALTER FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)
      RENAME TO fn_horse_fund_from_treasury_before_maintenance_gate;
  END IF;
END;
$wrap_horse_funding_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(
  uuid, uuid, numeric, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury(
  p_table_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_op_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  v_request := jsonb_build_object(
    'door', 'fn_horse_fund_from_treasury',
    'table_id', p_table_id,
    'user_id', p_user_id,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN v_response->'response';
  END IF;

  IF p_op_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.idempotency_key = 'horse_fund:' || p_op_id::text
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical horse key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN jsonb_build_object(
      'success', false,
      'deferred', true,
      'error', 'PLATFORM_FROZEN: scheduled maintenance has deferred this horse rebuy'
    );
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_response := public.fn_horse_fund_from_treasury_before_maintenance_gate(
    p_table_id, p_user_id, p_amount, p_op_id
  );
  IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN v_response;
  END IF;
  RETURN public.fn_record_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request, v_response
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)
  TO service_role;

DO $wrap_horse_seating_for_maintenance$
BEGIN
  IF to_regprocedure('public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)')
     IS NULL THEN
    IF to_regprocedure('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)')
       IS NULL THEN
      RAISE EXCEPTION 'canonical fn_horse_seat_from_treasury function missing';
    END IF;
    ALTER FUNCTION public.fn_horse_seat_from_treasury(uuid, uuid, integer, numeric, uuid)
      RENAME TO fn_horse_seat_from_treasury_before_maintenance_gate;
  END IF;
END;
$wrap_horse_seating_for_maintenance$;

REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(
  uuid, uuid, integer, numeric, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(
  p_table_id uuid,
  p_user_id uuid,
  p_seat_number integer,
  p_amount numeric,
  p_op_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  v_request := jsonb_build_object(
    'door', 'fn_horse_seat_from_treasury',
    'table_id', p_table_id,
    'user_id', p_user_id,
    'seat_number', p_seat_number,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN v_response->'response';
  END IF;

  IF p_op_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.idempotency_key = 'horse_fund:' || p_op_id::text
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical horse key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN jsonb_build_object(
      'success', false,
      'deferred', true,
      'error', 'PLATFORM_FROZEN: scheduled maintenance has deferred this horse seat'
    );
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_response := public.fn_horse_seat_from_treasury_before_maintenance_gate(
    p_table_id, p_user_id, p_seat_number, p_amount, p_op_id
  );
  IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN v_response;
  END IF;
  RETURN public.fn_record_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request, v_response
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury(
  uuid, uuid, integer, numeric, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_seat_from_treasury(
  uuid, uuid, integer, numeric, uuid
) TO service_role;

DO $assert_maintenance_entry_boundary$
DECLARE
  v_maintenance_trigger_count integer;
  v_statement_trigger_count integer;
  v_entry_trigger_count integer;
  v_write_guard text;
  v_trigger_def text;
  v_entry_guard text;
  v_satellite_pool_guard text;
  v_rebuy_guard text;
  v_guarded_door text;
BEGIN
  SELECT count(*) INTO v_maintenance_trigger_count
    FROM pg_trigger
   WHERE tgrelid = 'public.engine_maintenance_break'::regclass
     AND tgname = 'aa_serialize_maintenance_break_write'
     AND NOT tgisinternal;
  IF v_maintenance_trigger_count <> 1 THEN
    RAISE EXCEPTION 'maintenance write serialization trigger is not canonical';
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_trigger_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.engine_maintenance_break'::regclass
     AND t.tgname = 'aa_serialize_maintenance_break_write'
     AND NOT t.tgisinternal;
  IF position('TRUNCATE' IN v_trigger_def) = 0 THEN
    RAISE EXCEPTION 'TRUNCATE is outside the maintenance writer boundary';
  END IF;

  SELECT count(*) INTO v_statement_trigger_count
    FROM pg_trigger
   WHERE tgname = 'aa_serialize_tournament_player_insert'
     AND tgrelid = 'public.tournament_players'::regclass
     AND NOT tgisinternal;
  IF v_statement_trigger_count <> 1
     OR EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname IN ('aa_serialize_table_seat_insert', 'aa_serialize_tournament_launch')
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'only tournament-player inserts may retain the early statement backstop';
  END IF;

  SELECT count(*) INTO v_entry_trigger_count
    FROM pg_trigger
   WHERE tgname IN ('zz_freeze_entry_guard', 'zz_freeze_launch_guard')
     AND tgrelid IN (
       'public.table_seats'::regclass,
       'public.tournament_players'::regclass,
       'public.tournaments'::regclass
     )
     AND NOT tgisinternal;
  IF v_entry_trigger_count <> 3 THEN
    RAISE EXCEPTION 'all three new-entry doors must retain their freeze guard';
  END IF;

  v_write_guard := pg_get_functiondef(
    'public.fn_serialize_engine_maintenance_break_write()'::regprocedure
  );
  v_entry_guard := pg_get_functiondef(
    'public.fn_refuse_new_entries_while_frozen()'::regprocedure
  );
  v_rebuy_guard := pg_get_functiondef(
    'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure
  );
  v_satellite_pool_guard := pg_get_functiondef(
    'public.trg_freeze_finalized_tournament_prize_pool()'::regprocedure
  );

  IF position('pg_advisory_xact_lock(530090, 1)' IN v_write_guard) = 0
     OR position('TG_OP = ''TRUNCATE''' IN v_write_guard) = 0
     OR position('may not be truncated' IN v_write_guard) = 0
     OR position('pg_try_advisory_xact_lock_shared(530090, 1)' IN v_entry_guard) = 0
     OR position('fn_entry_purchases_frozen()' IN v_entry_guard) = 0
     OR position('pg_advisory_xact_lock_shared(530090, 1)' IN v_rebuy_guard) = 0
     OR position('fn_entry_purchases_frozen()' IN v_rebuy_guard) = 0 THEN
    RAISE EXCEPTION 'maintenance and entry transactions do not share one advisory boundary';
  END IF;

  IF (SELECT p.provolatile
        FROM pg_proc p
       WHERE p.oid = 'public.fn_entry_purchases_frozen()'::regprocedure) <> 'v'
     OR NOT (SELECT c.relrowsecurity
               FROM pg_class c
              WHERE c.oid = 'public.entry_purchase_idempotency_receipts'::regclass)
     OR has_table_privilege('anon', 'public.entry_purchase_idempotency_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.entry_purchase_idempotency_receipts', 'SELECT')
     OR has_table_privilege('service_role', 'public.entry_purchase_idempotency_receipts', 'INSERT')
     OR NOT (SELECT c.relrowsecurity
               FROM pg_class c
              WHERE c.oid = 'public.tournament_launch_receipts'::regclass)
     OR has_table_privilege('anon', 'public.tournament_launch_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.tournament_launch_receipts', 'SELECT')
     OR has_table_privilege('service_role', 'public.tournament_launch_receipts', 'INSERT') THEN
    RAISE EXCEPTION 'entry predicate volatility or receipt RLS/ACL boundary is not canonical';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.process_tournament_rebuy_before_maintenance_announcement_gate(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.process_tournament_rebuy_before_maintenance_announcement_gate(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'maintenance rebuy wrapper ACL boundary is not canonical';
  END IF;

  FOREACH v_guarded_door IN ARRAY ARRAY[
    'public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)',
    'public.atomic_table_rebuy(uuid,uuid,numeric,uuid)',
    'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)',
    'public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)',
    'public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)',
    'public.fn_register_for_tournament(uuid,boolean)',
    'public.fn_register_horse_for_tournament(uuid,uuid)',
    'public.fn_take_seat_and_buy_in(uuid,integer)',
    'public.fn_seat_horse_in_seat_first_game(uuid,uuid)',
    'public.fn_seat_late_registrant(uuid,uuid)',
    'public.fn_repair_seat_first_games(integer)',
    'public.fn_cash_seat_move_execute(uuid)',
    'public.fn_cash_seat_swap_execute(uuid)',
    'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)',
    'public.fn_settle_satellite_finish_atomic(uuid,text)'
  ] LOOP
    IF position('pg_advisory_xact_lock_shared(530090, 1)'
                IN pg_get_functiondef(v_guarded_door::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'entry or settlement door is outside the maintenance boundary: %',
        v_guarded_door;
    END IF;
  END LOOP;

  FOREACH v_guarded_door IN ARRAY ARRAY[
    'public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)',
    'public.atomic_table_rebuy(uuid,uuid,numeric,uuid)',
    'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)',
    'public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)',
    'public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)'
  ] LOOP
    IF position('fn_entry_purchases_frozen()'
                IN pg_get_functiondef(v_guarded_door::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'cash chip purchase door does not enforce the freeze: %',
        v_guarded_door;
    END IF;
  END LOOP;

  IF position('app.atomic_satellite_settlement' IN v_entry_guard) = 0
     OR position('is_satellite_qualifier' IN v_entry_guard) = 0
     OR position('source_satellite_id' IN v_entry_guard) = 0
     OR has_function_privilege(
       'service_role',
       'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'satellite settlement is not narrowly exempt and private';
  END IF;

  IF position('app.atomic_satellite_settlement' IN v_satellite_pool_guard) = 0
     OR position('tournament_satellite_settlement_batches' IN v_satellite_pool_guard) = 0
     OR position('tournament_satellite_entitlements' IN v_satellite_pool_guard) = 0
     OR position('target_player.source_satellite_id = OLD.id' IN v_satellite_pool_guard) = 0
     OR position('v_candidate_count = 1' IN v_satellite_pool_guard) = 0
     OR position('to_jsonb(NEW) - ''prize_pool''' IN v_satellite_pool_guard) = 0 THEN
    RAISE EXCEPTION 'finalized satellite pool debit lacks exact in-flight entitlement proof';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_complete_tournament_launch_atomic(uuid,uuid)',
       'EXECUTE'
     )
     OR position(
       'UPDATE public.tournaments'
       IN pg_get_functiondef(
         'public.fn_complete_tournament_launch_atomic(uuid,uuid)'::regprocedure
       )
     ) = 0
     OR position(
       'app.atomic_tournament_launch'
       IN pg_get_functiondef(
         'public.fn_complete_tournament_launch_atomic(uuid,uuid)'::regprocedure
       )
     ) = 0
     OR position('app.atomic_tournament_launch' IN v_entry_guard) = 0 THEN
    RAISE EXCEPTION 'tournament launch receipt boundary is not atomic and service-only';
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_proc p
           WHERE p.oid='public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure)
     OR NOT (SELECT p.prosecdef FROM pg_proc p
             WHERE p.oid='public.atomic_table_rebuy(uuid,uuid,numeric,uuid)'::regprocedure)
     OR NOT (SELECT p.prosecdef FROM pg_proc p
             WHERE p.oid='public.atomic_table_addon(uuid,uuid,numeric,boolean,text)'::regprocedure)
     OR NOT (SELECT p.prosecdef FROM pg_proc p
             WHERE p.oid='public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)'::regprocedure)
     OR NOT (SELECT p.prosecdef FROM pg_proc p
             WHERE p.oid='public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'a canonical chip door changed its SECURITY mode';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_claim_entry_purchase_receipt(text,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_record_entry_purchase_receipt(text,text,jsonb,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_release_entry_purchase_claim(text,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_repair_seat_first_games_before_maintenance_gate(integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_cash_seat_move_execute_before_maintenance_gate(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_cash_seat_swap_execute_before_maintenance_gate(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'a private pre-maintenance cash chip door is still callable';
  END IF;

  IF position(
       'pg_advisory_xact_lock(530090, 1)'
       IN pg_get_functiondef(
         'public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)'::regprocedure
       )
     ) = 0
     OR NOT COALESCE((
       SELECT p.proconfig @> ARRAY['statement_timeout=45s', 'lock_timeout=40s']
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)'::regprocedure
     ), false)
     OR has_function_privilege(
       'authenticated',
       'public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)',
       'EXECUTE'
     )
     OR position(
       'ownership_token = EXCLUDED.ownership_token'
       IN pg_get_functiondef(
         'public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)'::regprocedure
       )
     ) = 0
     OR position(
       'ownership_token = p_expected_ownership_token'
       IN pg_get_functiondef(
         'public.fn_claim_engine_maintenance_break(uuid,uuid,text)'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION 'maintenance writer RPC is not first-lock, bounded and service-only';
  END IF;
END;
$assert_maintenance_entry_boundary$;

COMMIT;
