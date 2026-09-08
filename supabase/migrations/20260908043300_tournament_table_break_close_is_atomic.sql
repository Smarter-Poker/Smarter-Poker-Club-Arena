/*
 * A tournament table break used to have two independent holes:
 *
 *   1. the engine stopped and disappeared from TournamentManager before the
 *      tables.status write was checked, so a failed HTTP write left a stopped
 *      dealer in GameServer's global registries and no local object able to
 *      finish the close;
 *   2. a concurrent live-seat acquisition could read an open table, then
 *      commit after the unguarded status='closed' write.
 *
 * The database invariant below covers both the new exact manager RPC and the
 * rolling-deploy legacy UPDATE.  A live-seat acquisition takes the tournament
 * parent in the existing `aa_` trigger and then takes the table row FOR SHARE
 * here.  A close already owns the table UPDATE lock and refuses while a live
 * seat exists.  Therefore either the seat commits first and the close refuses,
 * or the close commits first and the seat observes `closed` and refuses.  No
 * timer, sweep, or after-the-fact repair is part of the correctness boundary.
 */

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_tournament_table_close_requires_empty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_parent_status text;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NOT (
       (lower(NEW.status::text) = 'closed'
        AND lower(OLD.status::text) IS DISTINCT FROM 'closed')
       OR (COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false))
     ) THEN
    RETURN NEW;
  END IF;

  SELECT upper(t.status::text)
    INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;

  /* Terminal cleanup has its own atomic settlement/seat-release contracts.
     The dangerous path is a joinable or playing event whose table is being
     removed underneath a field that may still acquire a seat. */
  IF v_parent_status IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
        WHERE s.table_id = OLD.id
          AND s.left_at IS NULL
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_CLOSE_NOT_EMPTY: table % still has a live seat', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF lower(NEW.status::text) = 'closed' THEN
    NEW.current_players := 0;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS ab_tournament_table_close_requires_empty
  ON public.tables;
CREATE TRIGGER ab_tournament_table_close_requires_empty
  BEFORE UPDATE OF status, is_deleted ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_table_close_requires_empty();

REVOKE ALL ON FUNCTION public.trg_tournament_table_close_requires_empty()
  FROM PUBLIC, anon, authenticated, service_role;

/* Runs after aa_tournament_live_seat_proof_lock.  That earlier trigger owns
   receipt -> tournament-parent order; this one then takes the table row. */
CREATE OR REPLACE FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_table_status text;
  v_is_deleted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.left_at IS NOT NULL
       OR NEW.user_id IS NULL
       OR (
         OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
       ) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT lower(t.status::text), COALESCE(t.is_deleted, false)
    INTO v_table_status, v_is_deleted
    FROM public.tables t
   WHERE t.id = NEW.table_id
     AND t.tournament_id IS NOT NULL
   FOR SHARE;

  IF FOUND AND (v_table_status = 'closed' OR v_is_deleted) THEN
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_CLOSED: table % cannot acquire a live seat', NEW.table_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS ab_refuse_live_seat_on_closed_tournament_table
  ON public.table_seats;
CREATE TRIGGER ab_refuse_live_seat_on_closed_tournament_table
  BEFORE INSERT OR UPDATE OF table_id, user_id, left_at ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table();

REVOKE ALL ON FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table()
  FROM PUBLIC, anon, authenticated, service_role;

/* New engines close through one exact manager-authorized transaction.  The
   Stage-A pre-request hook has already validated and locked this generation;
   the explicit checks make the RPC fail closed under direct SQL invocation as
   well, and make the catalog contract self-contained. */
CREATE OR REPLACE FUNCTION public.fn_close_empty_tournament_table(
  p_tournament_id uuid,
  p_table_id uuid,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor text;
  v_actor_tournament_id uuid;
  v_actor_generation uuid;
  v_parent_status text;
  v_table_status text;
  v_current_players integer;
BEGIN
  IF p_tournament_id IS NULL OR p_table_id IS NULL OR p_lease_generation IS NULL THEN
    RAISE EXCEPTION 'fn_close_empty_tournament_table requires three UUIDs'
      USING ERRCODE = '22023';
  END IF;

  v_actor := current_setting('app.smarter_data_actor', true);
  BEGIN
    v_actor_tournament_id :=
      NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
    v_actor_generation :=
      NULLIF(current_setting('app.smarter_tournament_lease_generation', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED: malformed request authority'
      USING ERRCODE = '42501';
  END;

  IF v_actor IS DISTINCT FROM 'tournament-manager'
     OR v_actor_tournament_id IS DISTINCT FROM p_tournament_id
     OR v_actor_generation IS DISTINCT FROM p_lease_generation THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED: table close authority does not match request'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
     AND l.protocol_version = 2
     AND l.lease_generation = p_lease_generation
     AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED: table close lease is stale'
      USING ERRCODE = '42501';
  END IF;

  SELECT upper(t.status::text)
    INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_parent_status <> 'RUNNING' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'tournament_not_running',
      'status', v_parent_status
    );
  END IF;

  SELECT lower(t.status::text), COALESCE(t.current_players, 0)
    INTO v_table_status, v_current_players
    FROM public.tables t
   WHERE t.id = p_table_id
     AND t.tournament_id = p_tournament_id
     AND NOT COALESCE(t.is_deleted, false)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  PERFORM 1
    FROM public.table_seats s
   WHERE s.table_id = p_table_id
     AND s.left_at IS NULL
   ORDER BY s.id
   FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'live_seats_remain');
  END IF;

  IF v_table_status <> 'closed' OR v_current_players <> 0 THEN
    UPDATE public.tables
       SET status = 'closed',
           current_players = 0,
           updated_at = clock_timestamp()
     WHERE id = p_table_id
       AND tournament_id = p_tournament_id;
  END IF;

  SELECT lower(t.status::text), COALESCE(t.current_players, 0)
    INTO v_table_status, v_current_players
    FROM public.tables t
   WHERE t.id = p_table_id
     AND t.tournament_id = p_tournament_id;

  RETURN jsonb_build_object(
    'ok', v_table_status = 'closed' AND v_current_players = 0,
    'reason', CASE
      WHEN v_table_status = 'closed' AND v_current_players = 0 THEN 'closed'
      ELSE 'close_not_durable'
    END,
    'table_id', p_table_id,
    'tournament_id', p_tournament_id,
    'status', v_table_status,
    'current_players', v_current_players
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_close_empty_tournament_table(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_empty_tournament_table(uuid, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_close_empty_tournament_table(uuid, uuid, uuid) IS
  'Exact protocol-2 tournament-manager table-break close. Locks the live generation, parent, table, and seats; refuses a non-empty table and returns a durable terminal receipt.';

DO $assert_tournament_table_break_close_contract$
DECLARE
  v_close_source text;
  v_table_guard_source text;
  v_seat_guard_source text;
BEGIN
  SELECT p.prosrc INTO STRICT v_close_source
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_close_empty_tournament_table(uuid,uuid,uuid)'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_table_guard_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_tournament_table_close_requires_empty()'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_seat_guard_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_refuse_live_seat_on_closed_tournament_table()'::regprocedure
     AND p.prosecdef;

  IF position('l.protocol_version = 2' IN v_close_source) = 0
     OR position('l.lease_generation = p_lease_generation' IN v_close_source) = 0
     OR position($needle$interval '30 seconds'$needle$ IN v_close_source) = 0
     OR position('FOR SHARE' IN v_close_source) = 0
     OR position('FOR UPDATE' IN v_close_source) = 0
     OR position($needle$s.left_at IS NULL$needle$ IN v_close_source) = 0 THEN
    RAISE EXCEPTION 'exact table-break close lost its generation or empty-table proof';
  END IF;

  IF position($needle$v_parent_status IN ('REGISTERING', 'RUNNING')$needle$
       IN v_table_guard_source) = 0
     OR position($needle$s.left_at IS NULL$needle$ IN v_table_guard_source) = 0
     OR position('NEW.current_players := 0' IN v_table_guard_source) = 0 THEN
    RAISE EXCEPTION 'legacy direct close no longer refuses live tournament seats';
  END IF;

  IF position('FOR SHARE' IN v_seat_guard_source) = 0
     OR position($needle$v_table_status = 'closed'$needle$ IN v_seat_guard_source) = 0 THEN
    RAISE EXCEPTION 'live-seat acquisition no longer serializes with table close';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
     WHERE tg.tgrelid = 'public.tables'::regclass
       AND tg.tgname = 'ab_tournament_table_close_requires_empty'
       AND NOT tg.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
     WHERE tg.tgrelid = 'public.table_seats'::regclass
       AND tg.tgname = 'ab_refuse_live_seat_on_closed_tournament_table'
       AND NOT tg.tgisinternal
  ) THEN
    RAISE EXCEPTION 'table-break close serialization triggers are missing';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role',
       'public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'table-break close RPC ACL is not service-only';
  END IF;
END;
$assert_tournament_table_break_close_contract$;

COMMIT;
