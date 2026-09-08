/*
 * STAGE B -- strict activation of the tournament-manager request fence.
 *
 * This is deliberately a separate, forward-only cutover from Stage A.  Apply
 * it only after the exact Stage-A engine build is the sole running build and
 * every older process has drained.  There is no timer, watcher, repair sweep,
 * or runtime flag: generation-blind engine compatibility doors are removed
 * transactionally here without changing unrelated shared-estate traffic.
 *
 * The database can prove three things at this boundary:
 *
 *   1. every manager-exclusive or engine-authority Data API route identifies
 *      its actor, while unrelated shared-estate service traffic stays valid;
 *   2. a tournament-manager request holds one exact, fresh lease generation
 *      for the complete PostgREST transaction;
 *   3. a marked manager may mutate the four shared core row families only
 *      inside that tournament.
 *
 * Ordinary service work remains valid because Club Arena and World Hub share
 * this PostgREST database hook and credential. Scheduling, registration,
 * recovery and cash-table services also legitimately share manager relations.
 * It would be incorrect to infer "manager" from service_role or a table name.
 * The runtime's single-client/method-binding guards plus the private-route
 * boundary prove that manager work cannot silently shed its actor marker.
 */

BEGIN;

/* A busy relation aborts the whole cutover instead of making a live table
   wait behind DDL. Re-run only in the audited quiet window after inspecting
   the unchanged catalog; never hide a timeout behind an automatic retry. */
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

/* Refuse an out-of-order cutover or an accidental replacement of an unrelated
   PostgREST hook.  Reapplying this exact migration is harmless. */
DO $require_stage_a_request_authority$
DECLARE
  v_source text;
BEGIN
  IF to_regprocedure(
       'smarter_private.fn_smarter_data_api_pre_request()'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager request fencing requires the Stage-A request hook first';
  END IF;

  SELECT p.prosrc
    INTO STRICT v_source
    FROM pg_proc p
   WHERE p.oid =
         'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
     AND p.prosecdef;

  IF position('app.smarter_data_actor' IN v_source) = 0
     OR position('x-smarter-data-actor' IN v_source) = 0
     OR position('l.lease_generation = v_lease_generation' IN v_source) = 0
     OR position('FOR SHARE' IN v_source) = 0
     OR position('request.jwt.claims' IN v_source) = 0
     OR position('auth.role()' IN v_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_source) = 0 THEN
    RAISE EXCEPTION
      'Refusing Stage-B activation over an unknown or incomplete request hook';
  END IF;

  IF to_regprocedure(
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'
     ) IS NULL
     OR to_regprocedure(
          'public.heartbeat_tournament_leases_v3(text,jsonb,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.release_tournament_leases_v2(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.heartbeat_table_leases_v3(text,jsonb,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.release_table_leases_v2(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_process_hand_post_commit_obligations(uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager request fencing requires every tournament and table protocol-2 authority door';
  END IF;
END;
$require_stage_a_request_authority$;

REVOKE ALL ON SCHEMA smarter_private
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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
  v_stale_seconds constant integer := 30;
  v_manager_exclusive_paths constant text[] := ARRAY[
    'rpc/fn_ack_tournament_capacity_tables',
    'rpc/fn_begin_tournament_launch_atomic',
    'rpc/fn_bounty_obligation_has_complete_marker',
    'rpc/fn_claim_tournament_bounty_elimination',
    'rpc/fn_close_tournament_addon_period',
    'rpc/fn_close_empty_tournament_table',
    'rpc/fn_close_tournament_entry_window',
    'rpc/fn_collect_bounty',
    'rpc/fn_complete_tournament_entry_reprice',
    'rpc/fn_complete_tournament_launch_atomic',
    'rpc/fn_decline_tournament_rebuy',
    'rpc/fn_eliminate_tournament_player_atomic',
    'rpc/fn_ensure_late_registration_capacity',
    'rpc/fn_get_tournament_satellite_entitlement_depth',
    'rpc/fn_mystery_bounty_pay',
    'rpc/fn_mystery_bounty_reserve',
    'rpc/fn_mystery_bounty_reveal',
    'rpc/fn_mystery_bounty_seed',
    'rpc/fn_open_tournament_rebuy_decisions',
    'rpc/fn_settle_final_table_deal_atomic',
    'rpc/fn_spin_draw_multiplier',
    'rpc/fn_spin_settle_game',
    'rpc/fn_sync_tournament_live_seat_chips',
    'rpc/fn_tournament_has_unsettled_bounties',
    'rpc/process_tournament_rebuy'
  ]::text[];
  v_engine_service_paths constant text[] := ARRAY[
    'rpc/claim_table_lease_v2',
    'rpc/claim_tournament_lease_v2',
    'rpc/fn_ack_tournament_manager_wakes',
    'rpc/fn_apply_prize_guarantee',
    'rpc/fn_ca_commit_hand_settlement',
    'rpc/fn_ca_process_hand_post_commit_obligations',
    'rpc/fn_certify_tournament_finish',
    'rpc/fn_claim_tournament_finish',
    'rpc/fn_finalize_bounty_pool',
    'rpc/fn_mystery_bounty_settle',
    'rpc/fn_normalize_tournament_final_standings',
    'rpc/fn_prepare_tournament_place_obligations',
    'rpc/fn_settle_satellite_finish_atomic',
    'rpc/fn_settle_tournament_obligation',
    'rpc/fn_settle_tournament_places_atomic',
    'rpc/fn_settle_tournament_rake',
    'rpc/fn_sweep_pending_tournament_bounties',
    'rpc/fn_sync_seat_first_player_count',
    'rpc/heartbeat_table_leases_v3',
    'rpc/heartbeat_tournament_leases_v3',
    'rpc/release_table_leases_v2',
    'rpc/release_tournament_leases_v2'
  ]::text[];
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
  /* SECURITY DEFINER makes current_user the function owner.  The JWT claims
     supplied and verified by PostgREST are the request identity here. */
  v_request_role := btrim(COALESCE(auth.role(), ''));
  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));
  /* Direct PostgREST reports `rpc/name`; Supabase gateways may retain the
     `rest/v1/` prefix. Normalize both shapes before applying the same exact
     route allowlist. Never use a suffix/substring match for authority. */
  IF left(v_path, 8) = 'rest/v1/' THEN
    v_path := substr(v_path, 9);
  END IF;

  /* Transaction-local settings are reset by PostgreSQL at transaction end,
     but clear the proof explicitly before evaluating this request as a
     fail-closed defence against an incorrectly pooled session. */
  PERFORM set_config('app.smarter_manager_request_fenced', '', true);
  PERFORM set_config('app.smarter_manager_deleted_table_ids', '', true);

  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* This hook is shared by the entire estate. Do not turn the shared
     service-role credential into a Club-Arena-only protocol. Restrict only
     the RPC routes whose authority belongs to the engine. Manager-exclusive
     routes fail when a callback loses its bound manager context; recovery and
     lease-coordination routes accept the explicitly marked service actor too.
     Old/headerless engine binaries can use neither family after cutover. */
  IF v_path = ANY(v_manager_exclusive_paths)
     AND v_actor IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_AUTHORITY_REQUIRED: manager RPC requires exact lease authority'
      USING ERRCODE = '42501';
  END IF;
  IF v_path = ANY(v_engine_service_paths)
     AND v_actor NOT IN ('service', 'tournament-manager') THEN
    RAISE EXCEPTION
      'ENGINE_DATA_AUTHORITY_REQUIRED: engine RPC requires an identified service actor'
      USING ERRCODE = '42501';
  END IF;

  /* Unrelated World Hub/Club Arena service traffic deliberately remains
     compatible when unmarked. Browser traffic keeps its normal unmarked
     shape too. Only the engine-private paths above require identification. */
  IF v_actor = '' THEN
    IF v_request_role = 'service_role' THEN
      PERFORM set_config('app.smarter_data_actor', 'shared-estate-service', true);
    ELSE
      PERFORM set_config('app.smarter_data_actor', 'browser', true);
    END IF;
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

  IF v_method IN ('GET', 'HEAD', 'OPTIONS') THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     FOR SHARE;
  END IF;

  IF NOT FOUND THEN
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
  /* This marker is written last and only after the exact lease row is held
     FOR SHARE. Row triggers can consume this transaction proof without doing
     the same indexed lease read again for every affected row. */
  PERFORM set_config('app.smarter_manager_request_fenced', 'protocol-2', true);
END;
$function$;

REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() IS
  'Private, non-API Stage-B shared-estate Data API boundary. Unrelated unmarked service_role traffic remains valid; engine-private routes require an identified actor; protocol-2 tournament managers must hold and transaction-lock one exact fresh generation.';

DROP FUNCTION IF EXISTS public.fn_smarter_data_api_pre_request();

/* A marked manager is not merely "some manager".  Every direct row it touches
   must resolve to the same tournament named by the transaction-local request
   proof. The pre-request hook already holds the exact lease FOR SHARE for the
   complete PostgREST transaction. Re-reading that same row once per affected
   row would add hot-path work without strengthening the lock. */
CREATE OR REPLACE FUNCTION public.fn_assert_tournament_manager_write_scope(
  p_tournament_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_lease_generation uuid;
BEGIN
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_REQUIRED: manager actor is absent'
      USING ERRCODE = '42501';
  END IF;

  IF current_setting('app.smarter_manager_request_fenced', true)
       IS DISTINCT FROM 'protocol-2' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_REQUIRED: request lease proof is absent'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_tournament_id :=
      NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
    v_lease_generation :=
      NULLIF(
        current_setting('app.smarter_tournament_lease_generation', true),
        ''
      )::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed authority context'
      USING ERRCODE = '22023';
  END;

  IF p_tournament_id IS NULL
     OR v_tournament_id IS NULL
     OR v_lease_generation IS NULL
     OR p_tournament_id IS DISTINCT FROM v_tournament_id THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: row belongs to another tournament'
      USING ERRCODE = '42501';
  END IF;

END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_tournament_manager_write_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_deleted_table_ids uuid[];
BEGIN
  /* Shared tables have valid ordinary service writers.  Only the explicitly
     marked manager actor is scoped by this trigger; guessing from relation
     names would reject registration, scheduling, recovery, and cash games. */
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.id; END IF;
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  ELSIF TG_TABLE_NAME = 'tables' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  ELSIF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT t.tournament_id INTO v_old_tournament_id
        FROM public.tables t
       WHERE t.id = OLD.table_id;
      IF NOT FOUND THEN
        /* An ON DELETE CASCADE seat trigger runs after its parent table tuple
           has become invisible to this statement. The parent's own BEFORE
           DELETE scope trigger already proved the exact tournament. Consume
           that transaction proof only for a nested DELETE; a direct orphan
           mutation still fails closed. */
        BEGIN
          v_deleted_table_ids := COALESCE(
            NULLIF(
              current_setting('app.smarter_manager_deleted_table_ids', true),
              ''
            )::uuid[],
            '{}'::uuid[]
          );
        EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
          v_deleted_table_ids := '{}'::uuid[];
        END;
        IF TG_OP = 'DELETE'
           AND pg_trigger_depth() > 1
           AND OLD.table_id = ANY(v_deleted_table_ids) THEN
          BEGIN
            v_old_tournament_id :=
              NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
          EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
            v_old_tournament_id := NULL;
          END;
          IF v_old_tournament_id IS NULL THEN
            RAISE EXCEPTION
              'TOURNAMENT_MANAGER_SCOPE_VIOLATION: cascaded seat has no parent proof'
              USING ERRCODE = '42501';
          END IF;
        ELSE
          RAISE EXCEPTION
            'TOURNAMENT_MANAGER_SCOPE_VIOLATION: old seat table is missing'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT t.tournament_id INTO v_new_tournament_id
        FROM public.tables t
       WHERE t.id = NEW.table_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'TOURNAMENT_MANAGER_SCOPE_VIOLATION: new seat table is missing'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: unsupported trigger relation'
      USING ERRCODE = '55000';
  END IF;

  IF v_old_tournament_id IS NOT NULL THEN
    PERFORM public.fn_assert_tournament_manager_write_scope(v_old_tournament_id);
  END IF;
  IF v_new_tournament_id IS NOT NULL
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    PERFORM public.fn_assert_tournament_manager_write_scope(v_new_tournament_id);
  END IF;

  /* A manager must never touch a cash table/seat (NULL tournament_id), nor may
     it turn a tournament table into a cash table. */
  IF (TG_OP <> 'INSERT' AND v_old_tournament_id IS NULL)
     OR (TG_OP <> 'DELETE' AND v_new_tournament_id IS NULL) THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: manager write has no tournament'
      USING ERRCODE = '42501';
  END IF;

  /* The exact parent row has now passed manager scope. Persist its id only
     for this transaction so the subsequent FK ON DELETE CASCADE can prove
     why its parent tuple is no longer visible. This is not a broad nested-
     trigger exemption: the child must name an id admitted here. */
  IF TG_TABLE_NAME = 'tables' AND TG_OP = 'DELETE' THEN
    BEGIN
      v_deleted_table_ids := COALESCE(
        NULLIF(
          current_setting('app.smarter_manager_deleted_table_ids', true),
          ''
        )::uuid[],
        '{}'::uuid[]
      );
    EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
      RAISE EXCEPTION
        'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed deleted-table proof'
        USING ERRCODE = '22023';
    END;
    IF NOT OLD.id = ANY(v_deleted_table_ids) THEN
      v_deleted_table_ids := array_append(v_deleted_table_ids, OLD.id);
    END IF;
    PERFORM set_config(
      'app.smarter_manager_deleted_table_ids',
      v_deleted_table_ids::text,
      true
    );
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_tournament_manager_write_scope()
  FROM PUBLIC, anon, authenticated, service_role;

/* `a0_` is intentional. PostgreSQL runs same-kind triggers alphabetically;
   manager authority must lock the lease before the existing `aa_` launch
   triggers lock receipt/tournament parents. */
DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tournaments;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tournament_players;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tables;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.table_seats;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

/* No application role may bypass the exact RPCs by editing lease rows. */
REVOKE ALL ON TABLE public.engine_tournament_leases
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.engine_table_leases
  FROM PUBLIC, anon, authenticated, service_role;

/* Remove every generation-blind or superseded engine door after the old
   process drain. No CASCADE: an unexpected dependency aborts this cutover. */
DROP FUNCTION IF EXISTS public.claim_tournament_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.release_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
);
DROP FUNCTION IF EXISTS public.fn_complete_tournament_launch_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_table_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.release_table_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
);

/* Keep only the exact protocol-2 application doors. */
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_table_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_table_leases_v2(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;

/* Stage A deliberately left the old seat-first repair callable while an older
   engine could still be running its two-request creator. At this Stage-B
   boundary only the exact new engine may remain. Run the legacy repair once,
   in this transaction, and refuse to retire it unless every historical
   REGISTERING seat-first listing now has a joinable table. A maintenance
   freeze makes the repair return without writing; the remaining-row proof
   below then aborts the cutover instead of silently dropping the only legacy
   recovery door. */
DO $finish_and_retire_seat_first_repair$
DECLARE
  v_cleanup_result jsonb;
BEGIN
  IF to_regprocedure(
       'public.fn_create_seat_first_game_atomic(uuid,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B seat-first repair retirement requires the atomic creator first';
  END IF;

  IF to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NOT NULL THEN
    SELECT public.fn_repair_seat_first_games(1000)
      INTO v_cleanup_result;
    RAISE NOTICE 'Final bounded seat-first cleanup result: %', v_cleanup_result;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.status = 'REGISTERING'
       AND (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.max_players, 0) <= 2)
       AND NOT EXISTS (
         SELECT 1
           FROM public.tables tb
          WHERE tb.tournament_id = t.id
            AND COALESCE(tb.is_deleted, false) = false
            AND tb.status IN ('waiting', 'running')
       )
  ) THEN
    RAISE EXCEPTION
      'Stage-B seat-first repair retirement refused: an unjoinable legacy listing remains';
  END IF;
END;
$finish_and_retire_seat_first_repair$;

DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games(integer);
DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games_before_maintenance_gate(integer);

DO $assert_seat_first_repair_retired$
BEGIN
  IF to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NOT NULL
     OR to_regprocedure(
          'public.fn_repair_seat_first_games_before_maintenance_gate(integer)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'A legacy seat-first repair door survived Stage B';
  END IF;
END;
$assert_seat_first_repair_retired$;

DO $assert_strict_manager_request_fence$
DECLARE
  v_hook_source text;
  v_scope_source text;
  v_row_guard_source text;
BEGIN
  SELECT p.prosrc INTO STRICT v_hook_source
    FROM pg_proc p
   WHERE p.oid =
         'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_scope_source
    FROM pg_proc p
   WHERE p.oid =
         'public.fn_assert_tournament_manager_write_scope(uuid)'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_row_guard_source
    FROM pg_proc p
   WHERE p.oid =
         'public.trg_tournament_manager_write_scope()'::regprocedure
     AND p.prosecdef;

  IF position('TOURNAMENT_MANAGER_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position('ENGINE_DATA_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position($needle$'shared-estate-service'$needle$ IN v_hook_source) = 0
     OR position($needle$'browser'$needle$ IN v_hook_source) = 0
     OR position('FOR SHARE' IN v_hook_source) = 0
     OR position('l.lease_generation = v_lease_generation' IN v_hook_source) = 0
     OR position('app.smarter_manager_request_fenced' IN v_hook_source) = 0
     OR position('auth.role()' IN v_hook_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_hook_source) = 0
     OR position($needle$left(v_path, 8) = 'rest/v1/'$needle$ IN v_hook_source) = 0
     OR position($needle$'protocol-2'$needle$ IN v_scope_source) = 0
     OR position('p_tournament_id IS DISTINCT FROM v_tournament_id' IN v_scope_source) = 0
     OR position('app.smarter_manager_deleted_table_ids' IN v_row_guard_source) = 0
     OR position('OLD.table_id = ANY(v_deleted_table_ids)' IN v_row_guard_source) = 0
     OR position('pg_trigger_depth() > 1' IN v_row_guard_source) = 0 THEN
    RAISE EXCEPTION 'Stage-B route authority or manager row scope is incomplete';
  END IF;

  IF to_regprocedure('public.claim_tournament_lease(uuid,text,text,integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases_v2(text,uuid[],integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure('public.release_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid)'
        ) IS NOT NULL
     OR to_regprocedure('public.claim_table_lease(uuid,text,text,integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases_v2(text,uuid[],integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure('public.release_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'A legacy or superseded tournament/table authority door survived Stage B';
  END IF;

  IF has_table_privilege('service_role', 'public.engine_tournament_leases', 'SELECT')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'INSERT')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'UPDATE')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can still edit tournament leases outside exact RPCs';
  END IF;

  IF has_table_privilege('service_role', 'public.engine_table_leases', 'SELECT')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'INSERT')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'UPDATE')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can still edit table leases outside exact RPCs';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Exact engine RPC grants or private settlement-core ACL are wrong';
  END IF;

  IF (SELECT count(*)
        FROM pg_trigger t
       WHERE t.tgname = 'a0_tournament_manager_write_scope'
         AND t.tgrelid IN (
           'public.tournaments'::regclass,
           'public.tournament_players'::regclass,
           'public.tables'::regclass,
           'public.table_seats'::regclass
         )
         AND NOT t.tgisinternal) <> 4 THEN
    RAISE EXCEPTION 'Every manager-owned row family is not scope guarded';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) setting(value)
     WHERE r.rolname = 'authenticator'
       AND setting.value =
           'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'
  ) THEN
    RAISE EXCEPTION 'PostgREST strict request hook setting is absent';
  END IF;

  IF to_regprocedure('public.fn_smarter_data_api_pre_request()') IS NOT NULL THEN
    RAISE EXCEPTION 'Strict request hook remains callable from the exposed public schema';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'anon',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_schema_privilege('service_role', 'smarter_private', 'USAGE')
     OR NOT has_schema_privilege('anon', 'smarter_private', 'USAGE')
     OR NOT has_schema_privilege('authenticated', 'smarter_private', 'USAGE')
     OR has_schema_privilege('service_role', 'smarter_private', 'CREATE')
     OR has_schema_privilege('anon', 'smarter_private', 'CREATE')
     OR has_schema_privilege('authenticated', 'smarter_private', 'CREATE')
     OR has_function_privilege(
       'authenticator',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(p.proacl) acl
        WHERE p.oid =
              'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(n.nspacl) acl
        WHERE n.nspname = 'smarter_private'
          AND acl.grantee = 0
          AND acl.privilege_type IN ('USAGE', 'CREATE')
     ) THEN
    RAISE EXCEPTION 'Private strict request hook ACL is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
      CROSS JOIN LATERAL regexp_split_to_table(
        split_part(setting.value, '=', 2),
        '[[:space:]]*,[[:space:]]*'
      ) AS exposed(schema_name)
     WHERE r.rolname = 'authenticator'
       AND setting.value LIKE 'pgrst.db_schemas=%'
       AND exposed.schema_name = 'smarter_private'
  ) THEN
    RAISE EXCEPTION 'smarter_private must not be a PostgREST exposed schema';
  END IF;
END;
$assert_strict_manager_request_fence$;

COMMENT ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid) IS
  'Private Stage-B row-scope proof. A manager write must consume the transaction marker set only after the request hook locks its exact fresh protocol-2 lease, then name that same tournament and generation.';
COMMENT ON FUNCTION public.trg_tournament_manager_write_scope() IS
  'Scopes marked tournament-manager writes on tournaments, tournament_players, tables and table_seats to the transaction authority established by the Data API request hook.';

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

COMMIT;

/*
 * ROLLBACK ORDER (emergency forward migration, never an ad-hoc production
 * toggle): restore the Stage-A hook first; restore only the legacy tournament
 * overloads from the tournament-lease generation migration, table overloads
 * and superseded nine- and eleven-argument settlement from the table-lease
 * generation migration if an old engine is being deliberately reintroduced;
 * keep the obligations-aware twelve-argument core; then remove the four a0_
 * triggers and the two private scope functions.
 * Reopening any superseded engine door without also restoring Stage-A
 * compatibility is an invalid mixed protocol. Normal rollback is a new
 * audited migration.
 */
