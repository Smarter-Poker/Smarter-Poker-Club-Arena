-- 20260920161502_club_data_exports_expire_at_the_door.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Club Data CSV exports (games, players) are short-lived immutable jobs in
-- public.ca_club_data_exports, paged by ca_club_data_export_page and deleted
-- by ca_club_data_export_cancel or after fifteen minutes. Two things were
-- wrong with how they died, and one thing was missing.
--
-- 1. Expiry was not physical. The page RPC refused an expired job, but its
--    prepared rows stayed on disk until somebody happened to start another
--    export, at which point that browser inherited an UNBOUNDED global
--    DELETE of every expired job on the estate (cascading into every one of
--    their rows). An idle club could retain private prepared rows for ever;
--    a busy one could park a start behind somebody else's cleanup.
-- 2. The start RPCs serialised only equal request ids, so one session could
--    prepare many giant jobs at once. The unique index below makes one
--    physical job per user the invariant, and a per-user try-lock refuses a
--    second concurrent start immediately (SQLSTATE 55000, the message the
--    client classifies as "busy") instead of queueing report builders.
-- 3. Rake Snapshot had no complete export at all. ca_rake_export_start
--    materialises one deterministic, complete Rake CSV job through the
--    canonical ca_rake_snapshot door and the same private helpers it uses,
--    with the request context stored beside the rows so every page can
--    recheck the exact scope that produced it (club / union / delegated
--    agent), and refuse the whole file when membership, the agent tree,
--    horse visibility or commission entitlement drifted after preparation.
--
-- An earlier draft of this change (never applied anywhere) made expiry
-- physical with a pg_cron job. That draft is retired by this file. The
-- owner rule is no cron, no repair loop, correctness in the request itself,
-- so expiry now happens AT THE DOORS, bounded and non-blocking:
--
--   * every start RPC (game, player, rake) first reclaims the caller's OWN
--     expired job and its rows (bounded to one export, SKIP LOCKED, never
--     behind any shared lock), then checks the one-slot rule, and only at
--     the end of a successful build retires anyone else's stranded expired
--     job through ca_prune_expired_club_data_exports(2000): at most 2,000
--     rows and 25 parents per call, advisory try-lock plus SKIP LOCKED so
--     it can never wait, placed last so the row locks it takes are held
--     only until that same commit;
--   * ca_club_data_export_cancel deletes the caller's own job (SKIP LOCKED,
--     so a job already being retired elsewhere is simply reported as gone)
--     and then runs the same bounded prune;
--   * ca_club_data_export_page stays STABLE and deletes nothing.
--
-- The only garbage a cron could ever have found is an expired job whose
-- owner never starts or cancels again; any other user's next start or
-- cancel retires it, 2,000 rows at a time. The own-slot step runs BEFORE
-- the shared prune so a busy prune try-lock can never refuse a caller
-- whose only obstacle is their own stale job.
--
-- OBJECTS
--   new      public.ca_prune_expired_club_data_exports(integer)  (private: postgres only)
--   new      public.ca_can_read_rake_agent(uuid, uuid)          (private: service_role only)
--   new      public.ca_rake_export_start(text, uuid, date, date, uuid, text, text, uuid)
--            (carries the same 120s statement budget as the game/player doors)
--   replaced public.ca_club_data_export_page(uuid, integer, integer)
--   replaced public.ca_club_data_export_cancel(uuid)
--   rewritten in place (pg_get_functiondef + replace, every anchor verified
--   present in production on 2026-09-20, and this file aborts if one is not):
--            public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid)
--            public.ca_club_player_export_start(uuid,date,date,text,uuid)
--            public.fn_ca_rake_by_agent / fn_ca_rake_by_club / fn_ca_rake_by_downline
--            (identity tie-breakers in ORDER BY; the downline source walk is
--            widened from 5,000 to 20,001 rows so a request over the 20,000
--            row export ceiling fails loudly instead of looking complete)
--   table    public.ca_club_data_exports: club_id DROP NOT NULL; eleven new
--            columns (scope_type, scope_id, union_id, agent_user_id,
--            date_from, date_to, request_search, sort_key, total_amount,
--            metadata, metadata_fingerprint); kind check gains 'rake';
--            new CHECK ca_club_data_exports_rake_context_check; new UNIQUE
--            index idx_ca_club_data_exports_one_per_user (user_id).
--
-- CLIENT COMPATIBILITY (the published client keeps working):
--   ca_club_game_export_start / ca_club_player_export_start: same parameter
--     names, types and defaults; same return keys (export_id, total_rows,
--     status). No keys added. A request id replays only a live job of the
--     door's own kind; the same id held by a live job of another kind is
--     refused 22023 ('Club Data request id was already used for different
--     inputs') instead of being handed back as this kind.
--   ca_club_data_export_page: same parameters; keeps rows, total_rows,
--     next_offset, has_more, expires_at and ADDS kind, metadata,
--     metadata_fingerprint. A missing or expired job is now 55000
--     ('export is unavailable' / 'export expired; prepare a new export')
--     instead of 42501, which is reserved for a real authorization loss
--     ('export is no longer authorized').
--   ca_club_data_export_cancel: same parameter, still RETURNS boolean.
--   ca_rake_export_start (new): returns export_id, status, kind, total_rows,
--     total_amount, expires_at, metadata, metadata_fingerprint. It replays
--     only a Rake job (22023 for another kind's request id), and a delegated
--     agent book over 20,000 rows is refused 54000 before any search
--     filtering, naming the whole unfiltered book.
--
-- Every SECURITY DEFINER function this file creates or touches carries a
-- fixed search_path of public, pg_temp.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- A start RPC holds row locks on ca_club_data_exports for up to 120s while it
-- builds. If one is running when this applies, fail cleanly and re-apply
-- once later rather than queueing every writer behind the ALTER TABLE.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. The bounded, non-blocking prune. Private: only the SECURITY DEFINER doors
--    below call it. No cron, no session lock; a transaction-scoped try-lock
--    means overlapping callers skip instead of queueing, and every row it
--    touches is SKIP LOCKED.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_prune_expired_club_data_exports(
  p_batch integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  -- Per-call ceiling is 5,000 rows; the browser doors pass 2,000. This runs
  -- inside a request, not a maintenance window.
  v_budget integer := GREATEST(1, LEAST(COALESCE(p_batch, 1000), 5000));
  v_remaining integer;
  v_rows_deleted integer := 0;
  v_jobs_deleted integer := 0;
  v_deleted integer;
  v_export_id uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_parent_number integer;
BEGIN
  -- Overlapping callers skip. The lock is transaction-scoped so it releases
  -- on every return or error with no session state to leak.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('ca-club-data-export-expiry', 0)
  ) THEN
    RETURN 0;
  END IF;

  -- Walk a few parents while sharing one child-row budget. Every child lookup
  -- is bounded by the (export_id, ordinal) primary-key prefix. v_seen keeps a
  -- locked or still-populated parent from starving later work in this call.
  v_remaining := v_budget;
  FOR v_parent_number IN 1..25 LOOP
    SELECT export_job.id
      INTO v_export_id
      FROM public.ca_club_data_exports export_job
     WHERE export_job.expires_at < now()
       AND export_job.id <> ALL(v_seen)
     ORDER BY export_job.expires_at, export_job.id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    EXIT WHEN NOT FOUND;
    v_seen := array_append(v_seen, v_export_id);

    WITH doomed_rows AS MATERIALIZED (
      SELECT export_row.export_id, export_row.ordinal
        FROM public.ca_club_data_export_rows export_row
       WHERE export_row.export_id = v_export_id
       ORDER BY export_row.ordinal
       LIMIT v_remaining
       FOR UPDATE OF export_row SKIP LOCKED
    ), deleted_rows AS (
      DELETE FROM public.ca_club_data_export_rows export_row
       USING doomed_rows doomed
       WHERE export_row.export_id = doomed.export_id
         AND export_row.ordinal = doomed.ordinal
       RETURNING 1
    )
    SELECT count(*)::integer INTO v_deleted FROM deleted_rows;

    v_rows_deleted := v_rows_deleted + v_deleted;
    v_remaining := v_remaining - v_deleted;

    -- The parent goes only after its child set is observed empty, so this
    -- delete never cascades and a concurrently locked child keeps the parent.
    DELETE FROM public.ca_club_data_exports export_job
     WHERE export_job.id = v_export_id
       AND NOT EXISTS (
         SELECT 1
           FROM public.ca_club_data_export_rows export_row
          WHERE export_row.export_id = v_export_id
       );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_jobs_deleted := v_jobs_deleted + v_deleted;

    EXIT WHEN v_remaining <= 0;
  END LOOP;

  RETURN v_rows_deleted + v_jobs_deleted;
END
$function$;

COMMENT ON FUNCTION public.ca_prune_expired_club_data_exports(integer) IS
  'Bounded, non-blocking retirement of expired Club Data and Rake Snapshot export jobs: at most 25 parents and 5,000 prepared rows per call, advisory try-lock plus SKIP LOCKED, empty parents only. Called from the export doors; there is no schedule.';

REVOKE ALL ON FUNCTION public.ca_prune_expired_club_data_exports(integer)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rake Snapshot jobs share the private job store. The request context is
--    stored beside the materialised rows so every page can recheck the exact
--    scope that created it. Game/player jobs keep their old shape; the
--    stronger context check applies only to the new rake kind.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_club_data_exports
  ALTER COLUMN club_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS scope_type text,
  ADD COLUMN IF NOT EXISTS scope_id uuid,
  ADD COLUMN IF NOT EXISTS union_id uuid,
  ADD COLUMN IF NOT EXISTS agent_user_id uuid,
  ADD COLUMN IF NOT EXISTS date_from date,
  ADD COLUMN IF NOT EXISTS date_to date,
  ADD COLUMN IF NOT EXISTS request_search text,
  ADD COLUMN IF NOT EXISTS sort_key text,
  ADD COLUMN IF NOT EXISTS total_amount numeric,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata_fingerprint text;

ALTER TABLE public.ca_club_data_exports
  DROP CONSTRAINT IF EXISTS ca_club_data_exports_kind_check;
ALTER TABLE public.ca_club_data_exports
  ADD CONSTRAINT ca_club_data_exports_kind_check
  CHECK (kind IN ('games', 'players', 'rake'));

ALTER TABLE public.ca_club_data_exports
  DROP CONSTRAINT IF EXISTS ca_club_data_exports_rake_context_check;
ALTER TABLE public.ca_club_data_exports
  ADD CONSTRAINT ca_club_data_exports_rake_context_check
  CHECK (
    kind <> 'rake'
    OR (
      scope_type IN ('club', 'union', 'agent')
      AND scope_id IS NOT NULL
      AND date_from IS NOT NULL
      AND date_to IS NOT NULL
      AND date_from <= date_to
      AND sort_key IS NOT NULL
      AND (
        (scope_type = 'club' AND club_id = scope_id AND agent_user_id IS NULL)
        OR (scope_type = 'union' AND union_id = scope_id AND club_id IS NULL
            AND agent_user_id IS NULL)
        OR (scope_type = 'agent' AND club_id = scope_id
            AND agent_user_id IS NOT NULL)
      )
      AND (
        (status = 'preparing' AND metadata = '{}'::jsonb
         AND metadata_fingerprint IS NULL AND total_amount IS NULL)
        OR (
          status = 'ready'
          AND metadata ->> 'kind' = 'rake'
          AND metadata ->> 'scope_type' = scope_type
          AND NULLIF(metadata ->> 'scope_id', '')::uuid = scope_id
          AND NULLIF(metadata ->> 'club_id', '')::uuid
              IS NOT DISTINCT FROM club_id
          AND NULLIF(metadata ->> 'union_id', '')::uuid
              IS NOT DISTINCT FROM union_id
          AND NULLIF(metadata ->> 'agent_user_id', '')::uuid
              IS NOT DISTINCT FROM agent_user_id
          AND NULLIF(metadata ->> 'date_from', '')::date = date_from
          AND NULLIF(metadata ->> 'date_to', '')::date = date_to
          AND NULLIF(metadata ->> 'search', '')
              IS NOT DISTINCT FROM request_search
          AND metadata ->> 'sort' = sort_key
          AND metadata ->> 'generated_at' IS NOT NULL
          AND NULLIF(metadata ->> 'breakdown_total', '')::numeric
              IS NOT DISTINCT FROM total_amount
          AND metadata ? 'contains_admin_commission'
          AND total_amount IS NOT NULL
          AND metadata_fingerprint IS NOT NULL
          AND metadata_fingerprint = md5(metadata::text)
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. One physical job per user. The browser API is the sole writer, so this
--    is the resource invariant. Production is checked before the index is
--    created rather than silently choosing which immutable job to destroy.
-- ---------------------------------------------------------------------------
DO $one_slot_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.ca_club_data_exports
     GROUP BY user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'CLUB_DATA_EXPORT_SLOT: existing users own more than one physical export';
  END IF;
END
$one_slot_preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_club_data_exports_one_per_user
  ON public.ca_club_data_exports(user_id);

DO $one_slot_selfcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index index_row
      JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
      JOIN pg_class table_class ON table_class.oid = index_row.indrelid
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_attribute indexed_attribute
        ON indexed_attribute.attrelid = table_class.oid
       AND indexed_attribute.attname = 'user_id'
       AND NOT indexed_attribute.attisdropped
     WHERE table_namespace.nspname = 'public'
       AND table_class.relname = 'ca_club_data_exports'
       AND index_class.relname = 'idx_ca_club_data_exports_one_per_user'
       AND index_row.indisunique
       AND index_row.indisvalid
       AND index_row.indisready
       AND index_row.indpred IS NULL
       AND index_row.indnkeyatts = 1
       AND index_row.indkey[0] = indexed_attribute.attnum
  ) THEN
    RAISE EXCEPTION
      'CLUB_DATA_EXPORT_SLOT: one physical export/user is not database-enforced';
  END IF;
END
$one_slot_selfcheck$;

-- ---------------------------------------------------------------------------
-- 4. The two existing start RPCs, rewritten in place. The original functions
--    performed an unbounded global DELETE of every expired parent (cascading
--    into every prepared row) and serialised only equal request UUIDs. Each
--    legacy fragment is replaced in the current catalog definition; every
--    anchor must be found exactly once, and the post-conditions refuse a
--    partial transformation, so this can never half-apply. This keeps the
--    forward change small instead of carrying two independent 250-line copies
--    of the materialisation queries that could drift apart later.
-- ---------------------------------------------------------------------------
DO $expire_at_the_door$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_rewritten text;
  v_anchor text;
  v_replacement text;
  v_anchor_number integer;
  v_anchors text[];
  v_replacements text[];
  v_config text;
  v_door_number integer;
  v_kind text;
  v_live_lookup text;
  v_live_fragment text;
  v_global_sweep constant text :=
    'DELETE FROM public.ca_club_data_exports WHERE expires_at < now();';
  v_request_lock constant text :=
    'PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text||'':''||v_request::text,0));';
  v_ready_lookup constant text :=
    'WHERE user_id=v_user AND request_id=v_request AND status=''ready'';';
  v_request_delete constant text :=
    E'DELETE FROM public.ca_club_data_exports\n   WHERE user_id=v_user AND request_id=v_request;';
  v_ready_update constant text :=
    E'     SET total_rows=v_total,status=''ready''\n   WHERE id=v_export_id;';
  v_user_lock constant text :=
    E'IF NOT pg_try_advisory_xact_lock(\n' ||
    E'    hashtextextended(''ca-club-data-export-user:'' || v_user::text, 0)\n' ||
    E'  ) THEN\n' ||
    E'    RAISE EXCEPTION ''Another Club Data export is already being prepared.''\n' ||
    E'      USING ERRCODE = ''55000'';\n' ||
    E'  END IF;';
  -- The replacement for the ready lookup is built per door below: a request
  -- id replays only a live job of the door's OWN kind, and the same id held
  -- by a live job of another kind is refused as a different request (22023)
  -- instead of being replayed as this kind or rebuilt over it.
  v_doors constant regprocedure[] := ARRAY[
    'public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid)'::regprocedure,
    'public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure
  ];
  v_kinds constant text[] := ARRAY['games', 'players'];
  v_slot_guard constant text :=
    E'-- The expired job owned by the caller is reclaimed first, and never behind\n' ||
    E'  -- the shared prune''s try-lock: an owner whose previous export lost its\n' ||
    E'  -- cleanup must not be locked out of the next one. Bounded to one export\n' ||
    E'  -- (50,000 rows exceeds anything a door can prepare); SKIP LOCKED so a\n' ||
    E'  -- prune retiring the same parent from another session is never waited on.\n' ||
    E'  DELETE FROM public.ca_club_data_export_rows own_row\n' ||
    E'   USING (\n' ||
    E'     SELECT stale_row.export_id, stale_row.ordinal\n' ||
    E'       FROM public.ca_club_data_export_rows stale_row\n' ||
    E'       JOIN public.ca_club_data_exports expired_slot\n' ||
    E'         ON expired_slot.id = stale_row.export_id\n' ||
    E'      WHERE expired_slot.user_id = v_user\n' ||
    E'        AND expired_slot.expires_at < now()\n' ||
    E'      ORDER BY stale_row.export_id, stale_row.ordinal\n' ||
    E'      LIMIT 50000\n' ||
    E'      FOR UPDATE OF stale_row SKIP LOCKED\n' ||
    E'   ) doomed\n' ||
    E'   WHERE own_row.export_id = doomed.export_id\n' ||
    E'     AND own_row.ordinal = doomed.ordinal;\n' ||
    E'\n' ||
    E'  DELETE FROM public.ca_club_data_exports expired_slot\n' ||
    E'   USING (\n' ||
    E'     SELECT reclaimable.id\n' ||
    E'       FROM public.ca_club_data_exports reclaimable\n' ||
    E'      WHERE reclaimable.user_id = v_user\n' ||
    E'        AND reclaimable.expires_at < now()\n' ||
    E'      FOR UPDATE SKIP LOCKED\n' ||
    E'   ) reclaimed\n' ||
    E'   WHERE expired_slot.id = reclaimed.id\n' ||
    E'     AND NOT EXISTS (\n' ||
    E'       SELECT 1\n' ||
    E'         FROM public.ca_club_data_export_rows export_row\n' ||
    E'        WHERE export_row.export_id = expired_slot.id\n' ||
    E'     );\n' ||
    E'\n' ||
    E'  IF EXISTS (\n' ||
    E'    SELECT 1\n' ||
    E'      FROM public.ca_club_data_exports active_slot\n' ||
    E'     WHERE active_slot.user_id = v_user\n' ||
    E'  ) THEN\n' ||
    E'    RAISE EXCEPTION ''Another Club Data export is already being prepared, downloaded, or cleaned up.''\n' ||
    E'      USING ERRCODE = ''55000'';\n' ||
    E'  END IF;';
  v_door_prune constant text :=
    E'     SET total_rows=v_total,status=''ready''\n' ||
    E'   WHERE id=v_export_id;\n' ||
    E'\n' ||
    E'  -- Somebody else''s stranded expired job, if any: bounded, non-blocking,\n' ||
    E'  -- and last, so the row locks it takes are held only until this commit.\n' ||
    E'  PERFORM public.ca_prune_expired_club_data_exports(2000);';
BEGIN
  v_anchors := ARRAY[
    v_global_sweep, v_request_lock, v_ready_lookup, v_request_delete, v_ready_update
  ];

  FOR v_door_number IN 1..array_length(v_doors, 1) LOOP
    v_signature := v_doors[v_door_number];
    v_kind := v_kinds[v_door_number];
    v_live_fragment := 'AND expires_at >= now() AND kind = ' || quote_literal(v_kind) || ';';
    v_live_lookup :=
      E'WHERE user_id = v_user AND request_id = v_request AND status = ''ready''\n' ||
      E'     ' || v_live_fragment || E'\n' ||
      E'  -- A request id replays only a job of this door''s own kind. The same id\n' ||
      E'  -- held by a live job of another kind is a different request: refused,\n' ||
      E'  -- never replayed as this kind and never rebuilt over it.\n' ||
      E'  IF v_export_id IS NULL AND EXISTS (\n' ||
      E'    SELECT 1\n' ||
      E'      FROM public.ca_club_data_exports other_kind\n' ||
      E'     WHERE other_kind.user_id = v_user\n' ||
      E'       AND other_kind.request_id = v_request\n' ||
      E'       AND other_kind.kind <> ' || quote_literal(v_kind) || E'\n' ||
      E'       AND other_kind.expires_at >= now()\n' ||
      E'  ) THEN\n' ||
      E'    RAISE EXCEPTION ''Club Data request id was already used for different inputs''\n' ||
      E'      USING ERRCODE = ''22023'';\n' ||
      E'  END IF;';
    v_replacements := ARRAY[
      '-- Expiry is owned by the doors: the caller''s own slot below, then the bounded prune at the end of this call.',
      v_user_lock, v_live_lookup, v_slot_guard, v_door_prune
    ];

    SELECT pg_get_functiondef(v_signature) INTO v_definition;
    IF v_definition IS NULL THEN
      RAISE EXCEPTION 'CLUB_DATA_EXPORT_DOOR: % is not defined', v_signature;
    END IF;

    v_rewritten := v_definition;
    FOR v_anchor_number IN 1..array_length(v_anchors, 1) LOOP
      v_anchor := v_anchors[v_anchor_number];
      v_replacement := v_replacements[v_anchor_number];
      -- Exactly one occurrence, or this file must not touch the function.
      IF (length(v_rewritten) - length(replace(v_rewritten, v_anchor, ''))) / length(v_anchor) <> 1 THEN
        RAISE EXCEPTION
          'CLUB_DATA_EXPORT_DOOR: anchor % of 5 is not present exactly once in %; refusing to half-apply',
          v_anchor_number, v_signature;
      END IF;
      v_rewritten := replace(v_rewritten, v_anchor, v_replacement);
    END LOOP;

    EXECUTE v_rewritten;
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature
    );

    -- Post-conditions: every legacy fragment gone, every new one present, the
    -- own-slot step BEFORE the shared prune, grants and budget untouched.
    SELECT pg_get_functiondef(v_signature) INTO v_definition;
    IF position(v_global_sweep IN v_definition) > 0 THEN
      RAISE EXCEPTION
        'CLUB_DATA_EXPORT_RETENTION: % still performs an unbounded expiry sweep',
        v_signature;
    END IF;
    IF position(v_request_lock IN v_definition) > 0
       OR position('pg_try_advisory_xact_lock' IN v_definition) = 0
       OR position('ca-club-data-export-user:' IN v_definition) = 0 THEN
      RAISE EXCEPTION
        'CLUB_DATA_EXPORT_SLOT: % does not use the shared fail-fast user lock',
        v_signature;
    END IF;
    IF position(v_ready_lookup IN v_definition) > 0
       OR position(v_live_fragment IN v_definition) = 0 THEN
      RAISE EXCEPTION
        'CLUB_DATA_EXPORT_SLOT: % can return an expired or other-kind idempotent job',
        v_signature;
    END IF;
    IF position('other_kind.kind <> ' || quote_literal(v_kind) IN v_definition) = 0
       OR position('Club Data request id was already used for different inputs' IN v_definition) = 0
       OR position('other_kind.kind <> ' || quote_literal(v_kind) IN v_definition)
          > position('active_slot.user_id = v_user' IN v_definition) THEN
      RAISE EXCEPTION
        'CLUB_DATA_EXPORT_SLOT: % does not refuse a request id held by another kind before its own slot',
        v_signature;
    END IF;
    IF position(v_request_delete IN v_definition) > 0
       OR position('FOR UPDATE OF stale_row SKIP LOCKED' IN v_definition) = 0
       OR position('active_slot.user_id = v_user' IN v_definition) = 0
       OR position(
         'Another Club Data export is already being prepared, downloaded, or cleaned up.' IN
         v_definition
       ) = 0 THEN
      RAISE EXCEPTION
        'CLUB_DATA_EXPORT_SLOT: % can replace an occupied user slot',
        v_signature;
    END IF;
    IF (length(v_definition)
        - length(replace(v_definition, 'public.ca_prune_expired_club_data_exports(2000)', '')))
       / length('public.ca_prune_expired_club_data_exports(2000)') <> 1
       OR position('public.ca_prune_expired_club_data_exports(2000)' IN v_definition)
          < position('active_slot.user_id = v_user' IN v_definition)
       OR position('public.ca_prune_expired_club_data_exports(2000)' IN v_definition)
          < position('SET total_rows=v_total' IN v_definition) THEN
      RAISE EXCEPTION
        'CLUB_DATA_EXPORT_RETENTION: % does not run the bounded prune once, after its own slot and its own build',
        v_signature;
    END IF;
    IF NOT has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR has_function_privilege('anon', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION
        'CLUB_DATA_EXPORT_SLOT: % changed its declared caller grants',
        v_signature;
    END IF;
    SELECT array_to_string(p.proconfig, ';') INTO v_config
      FROM pg_proc p WHERE p.oid = v_signature;
    IF COALESCE(v_config, '') NOT LIKE '%statement_timeout=120s%'
       OR COALESCE(v_config, '') NOT LIKE '%search_path=public, pg_temp%' THEN
      RAISE EXCEPTION
        'CLUB_DATA_EXPORT_DOOR: % lost its 120s statement budget or its fixed search_path (%)',
        v_signature, v_config;
    END IF;
  END LOOP;
END
$expire_at_the_door$;

-- The expiry rewrite must leave the horse mask the player door already carries
-- (20260903035252) exactly where it was: a prepared payload names a horse only
-- when the caller may see the flag. Refuse the whole file if it did not.
DO $player_door_keeps_the_horse_mask$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure
  );
BEGIN
  IF position(
       '(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false))'
       IN v_definition
     ) = 0
     OR position('pr.avatar_url,COALESCE(pr.is_horse,false) is_horse' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'CLUB_DATA_EXPORT_DOOR: the player export door lost its horse mask';
  END IF;
END
$player_door_keeps_the_horse_mask$;

-- ---------------------------------------------------------------------------
-- 5. Every complete export page must have stable membership at its
--    boundaries. Keep the financial relations in their one canonical helper
--    each; only add identity tie-breakers to those helpers' existing ORDER BY
--    clauses. The downline helper's source walk is widened by one sentinel
--    row so a request over the 20,000-row export ceiling fails loudly instead
--    of appearing complete at an old hidden 5,000-row cap. Already-repaired
--    helpers are recognised; a helper that is neither raw nor repaired aborts.
-- ---------------------------------------------------------------------------
DO $make_rake_order_total$
DECLARE
  v_definition text;
  v_rewritten text;
  v_signature regprocedure;
BEGIN
  v_signature := 'public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure;
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF position('f.agent_user_id::text ASC NULLS LAST' IN v_definition) = 0 THEN
    v_rewritten := replace(
      v_definition,
      '               f.name ASC) AS rn',
      E'               f.name ASC,\n' ||
      E'               f.agent_user_id::text ASC NULLS LAST) AS rn'
    );
    IF v_rewritten = v_definition THEN
      RAISE EXCEPTION
        'RAKE_EXPORT_ORDER: fn_ca_rake_by_agent identity anchor not found';
    END IF;
    EXECUTE v_rewritten;
  END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);

  v_signature := 'public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text)'::regprocedure;
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF position('f.club_id::text ASC' IN v_definition) = 0 THEN
    v_rewritten := replace(
      v_definition,
      E'       f.name ASC\n     OFFSET',
      E'       f.name ASC,\n       f.club_id::text ASC\n     OFFSET'
    );
    IF v_rewritten = v_definition THEN
      RAISE EXCEPTION
        'RAKE_EXPORT_ORDER: fn_ca_rake_by_club identity anchor not found';
    END IF;
    EXECUTE v_rewritten;
  END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);

  v_signature := 'public.fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer,text,text)'::regprocedure;
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  v_rewritten := v_definition;
  IF position('NULL, 20001) d' IN v_rewritten) = 0 THEN
    v_rewritten := replace(v_rewritten, 'NULL, 5000) d', 'NULL, 20001) d');
  END IF;
  IF position('f.player_id::text ASC' IN v_rewritten) = 0 THEN
    v_rewritten := replace(
      v_rewritten,
      E'       f.username ASC\n     OFFSET',
      E'       f.username ASC,\n       f.player_id::text ASC\n     OFFSET'
    );
  END IF;
  IF position('NULL, 20001) d' IN v_rewritten) = 0
     OR position('f.player_id::text ASC' IN v_rewritten) = 0 THEN
    RAISE EXCEPTION
      'RAKE_EXPORT_ORDER: fn_ca_rake_by_downline completeness anchors not found';
  END IF;
  IF v_rewritten <> v_definition THEN
    EXECUTE v_rewritten;
  END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);

  IF position(
       'f.agent_user_id::text ASC NULLS LAST' IN pg_get_functiondef(
         'public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure
       )
     ) = 0
     OR position(
       'f.club_id::text ASC' IN pg_get_functiondef(
         'public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text)'::regprocedure
       )
     ) = 0
     OR position(
       'f.player_id::text ASC' IN pg_get_functiondef(
         'public.fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer,text,text)'::regprocedure
       )
     ) = 0
     OR position(
       'NULL, 20001) d' IN pg_get_functiondef(
         'public.fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer,text,text)'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION 'RAKE_EXPORT_ORDER: deterministic helper repair did not persist';
  END IF;
END
$make_rake_order_total$;

-- ---------------------------------------------------------------------------
-- 6. The same agent visibility claim enforced inside fn_agent_downline_rake,
--    expressed as a cheap page-time predicate. Deliberately private: browsers
--    enter through ca_rake_export_start / ca_club_data_export_page.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_can_read_rake_agent(
  p_agent_user_id uuid,
  p_club_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND p_agent_user_id IS NOT NULL
     AND p_club_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.agents target_agent
        WHERE target_agent.user_id = p_agent_user_id
          AND target_agent.club_id = p_club_id
          AND target_agent.status = 'active'
          AND target_agent.role IN ('super_agent', 'agent', 'sub_agent')
     )
     AND (
       auth.uid() = p_agent_user_id
       OR public.fn_is_agent_ancestor(auth.uid(), p_agent_user_id, p_club_id)
       OR public.fn_is_club_admin_uid(p_club_id)
       OR EXISTS (
         SELECT 1
           FROM public.union_clubs union_club
          WHERE union_club.club_id = p_club_id
            AND public.fn_is_union_overseer(union_club.union_id, auth.uid())
       )
     );
$function$;

REVOKE ALL ON FUNCTION public.ca_can_read_rake_agent(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_can_read_rake_agent(uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 7. The Rake Snapshot export door.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_rake_export_start(
  p_scope_type text,
  p_scope_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_agent_user_id uuid DEFAULT NULL::uuid,
  p_search text DEFAULT NULL::text,
  p_sort text DEFAULT 'rake'::text,
  p_request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
-- The same bounded budget the game/player doors carry (20260831181000): a
-- 20,000-row export pages the canonical helpers up to a hundred times and
-- must not be at the mercy of the browser role's eight-second default.
-- PostgREST hoists a function's statement_timeout into the request's own
-- transaction, so a browser call runs under this budget, not the role's 8s
-- (production, 2026-09-21: fn_requeue_unbanked_cash_rake, configured 120s,
-- has run 69.8s through PostgREST). A direct SQL caller keeps the statement
-- timer it started with; the budget does not extend it.
SET statement_timeout = '120s'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_scope text := lower(COALESCE(NULLIF(btrim(p_scope_type), ''), ''));
  v_scope_id uuid := p_scope_id;
  v_club_id uuid;
  v_union_id uuid;
  v_agent_user_id uuid;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end - 6);
  v_search text := NULLIF(left(btrim(COALESCE(p_search, '')), 160), '');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort), ''), 'rake'));
  v_request uuid := COALESCE(p_request_id, gen_random_uuid());
  v_chunk integer;
  v_max_rows constant integer := 20000;
  v_export_id uuid;
  v_expires_at timestamptz;
  v_existing public.ca_club_data_exports%ROWTYPE;
  v_response jsonb;
  v_reported integer;
  v_inserted integer;
  v_agent_overflow boolean;
  v_book_rows integer;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sign in to prepare a Rake Snapshot export'
      USING ERRCODE = '42501';
  END IF;
  IF v_scope NOT IN ('club', 'union', 'agent') OR v_scope_id IS NULL THEN
    RAISE EXCEPTION 'Rake Snapshot export scope is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF v_start < v_end - 730 THEN v_start := v_end - 730; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;

  IF v_scope = 'club' THEN
    v_club_id := v_scope_id;
    v_agent_user_id := NULL;
    v_chunk := 200;
    IF v_sort NOT IN ('rake', 'name', 'cost', 'players') THEN v_sort := 'rake'; END IF;
    IF NOT public.ca_can_read_club_production(v_club_id) THEN
      RAISE EXCEPTION 'Rake Snapshot export is no longer authorized'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope = 'union' THEN
    v_union_id := v_scope_id;
    v_agent_user_id := NULL;
    v_chunk := 200;
    IF v_sort NOT IN ('rake', 'name', 'hands') THEN v_sort := 'rake'; END IF;
    IF NOT public.ca_can_oversee_union(v_union_id) THEN
      RAISE EXCEPTION 'Rake Snapshot export is no longer authorized'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_club_id := v_scope_id;
    v_agent_user_id := COALESCE(p_agent_user_id, v_user);
    v_chunk := 500;
    IF v_sort NOT IN ('rake', 'name', 'hands') THEN v_sort := 'rake'; END IF;
    IF NOT public.ca_can_read_rake_agent(v_agent_user_id, v_club_id) THEN
      RAISE EXCEPTION 'Rake Snapshot export is no longer authorized'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- One start per user at a time, refused immediately rather than queued.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('ca-club-data-export-user:' || v_user::text, 0)
  ) THEN
    RAISE EXCEPTION 'Another Club Data export is already being prepared.'
      USING ERRCODE = '55000';
  END IF;

  -- A retried request resumes the same immutable job, and only a Rake job.
  SELECT *
    INTO v_existing
    FROM public.ca_club_data_exports existing_job
   WHERE existing_job.user_id = v_user
     AND existing_job.request_id = v_request
     AND existing_job.kind = 'rake'
     AND existing_job.expires_at >= now();

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.scope_type IS DISTINCT FROM v_scope
       OR v_existing.scope_id IS DISTINCT FROM v_scope_id
       OR v_existing.agent_user_id IS DISTINCT FROM v_agent_user_id
       OR v_existing.date_from IS DISTINCT FROM v_start
       OR v_existing.date_to IS DISTINCT FROM v_end
       OR v_existing.request_search IS DISTINCT FROM v_search
       OR v_existing.sort_key IS DISTINCT FROM v_sort THEN
      RAISE EXCEPTION 'Rake Snapshot request id was already used for different inputs'
        USING ERRCODE = '22023';
    END IF;
    IF v_existing.status <> 'ready' THEN
      RAISE EXCEPTION 'Rake Snapshot export is still being prepared'
        USING ERRCODE = '55000';
    END IF;
    IF COALESCE(
         (v_existing.metadata ->> 'contains_admin_commission')::boolean,
         false
       )
       AND NOT public.fn_is_club_admin_uid(v_existing.club_id) THEN
      RAISE EXCEPTION
        'Rake Snapshot export permissions changed; prepare a new export'
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'export_id', v_existing.id,
      'status', v_existing.status,
      'kind', v_existing.kind,
      'total_rows', v_existing.total_rows,
      'total_amount', v_existing.total_amount,
      'expires_at', v_existing.expires_at,
      'metadata', v_existing.metadata,
      'metadata_fingerprint', v_existing.metadata_fingerprint
    );
  END IF;

  -- The same request id held by a live job of another kind is a different
  -- request: refused, never replayed as Rake and never rebuilt over it.
  IF EXISTS (
    SELECT 1
      FROM public.ca_club_data_exports other_kind
     WHERE other_kind.user_id = v_user
       AND other_kind.request_id = v_request
       AND other_kind.kind <> 'rake'
       AND other_kind.expires_at >= now()
  ) THEN
    RAISE EXCEPTION 'Rake Snapshot request id was already used for different inputs'
      USING ERRCODE = '22023';
  END IF;

  -- The expired job owned by the caller is reclaimed first, and never behind
  -- the shared prune's try-lock: an owner whose previous export lost its
  -- cleanup must not be locked out of the next one. Bounded to one export
  -- (50,000 rows exceeds anything a door can prepare); SKIP LOCKED so a
  -- prune retiring the same parent from another session is never waited on.
  DELETE FROM public.ca_club_data_export_rows own_row
   USING (
     SELECT stale_row.export_id, stale_row.ordinal
       FROM public.ca_club_data_export_rows stale_row
       JOIN public.ca_club_data_exports expired_slot
         ON expired_slot.id = stale_row.export_id
      WHERE expired_slot.user_id = v_user
        AND expired_slot.expires_at < now()
      ORDER BY stale_row.export_id, stale_row.ordinal
      LIMIT 50000
      FOR UPDATE OF stale_row SKIP LOCKED
   ) doomed
   WHERE own_row.export_id = doomed.export_id
     AND own_row.ordinal = doomed.ordinal;

  DELETE FROM public.ca_club_data_exports expired_slot
   USING (
     SELECT reclaimable.id
       FROM public.ca_club_data_exports reclaimable
      WHERE reclaimable.user_id = v_user
        AND reclaimable.expires_at < now()
      FOR UPDATE SKIP LOCKED
   ) reclaimed
   WHERE expired_slot.id = reclaimed.id
     AND NOT EXISTS (
       SELECT 1
         FROM public.ca_club_data_export_rows export_row
        WHERE export_row.export_id = expired_slot.id
     );

  IF EXISTS (
    SELECT 1
      FROM public.ca_club_data_exports active_slot
     WHERE active_slot.user_id = v_user
  ) THEN
    RAISE EXCEPTION
      'Another Club Data export is already being prepared, downloaded, or cleaned up.'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.ca_club_data_exports(
    user_id, club_id, request_id, kind, scope_type, scope_id, union_id,
    agent_user_id, date_from, date_to, request_search, sort_key
  )
  VALUES (
    v_user, v_club_id, v_request, 'rake', v_scope, v_scope_id, v_union_id,
    v_agent_user_id, v_start, v_end, v_search, v_sort
  )
  RETURNING id, expires_at INTO v_export_id, v_expires_at;

  -- One data-changing statement owns the reporting snapshot. Its first call
  -- goes through ca_rake_snapshot, the public canonical door and authorization
  -- gate. Remaining pages call only the same private helpers that door uses.
  -- No Rake arithmetic or commission allocation is reimplemented here.
  WITH first_snapshot AS MATERIALIZED (
    SELECT public.ca_rake_snapshot(
      v_scope,
      v_club_id,
      v_union_id,
      v_start,
      v_end,
      v_agent_user_id,
      v_chunk,
      0,
      v_search,
      v_sort
    ) AS document
  -- Search is applied after fn_ca_rake_by_downline's deliberately widened
  -- 20,001-row source walk. Count that unfiltered source independently: a
  -- narrow search must never turn a truncated downline into a "complete" file.
  ), agent_capacity AS MATERIALIZED (
    SELECT public.fn_ca_rake_by_downline(
             v_agent_user_id,
             v_club_id,
             (v_start::timestamp AT TIME ZONE 'UTC'),
             ((v_end + 1)::timestamp AT TIME ZONE 'UTC'),
             1,
             0,
             NULL,
             'rake'
           ) AS document
     WHERE v_scope = 'agent'
  ), snapshot_shape AS MATERIALIZED (
    SELECT first_snapshot.document,
           GREATEST(
             COALESCE((first_snapshot.document ->> 'breakdown_count')::integer, 0),
             0
           ) AS total,
           (
             v_scope = 'club'
             AND public.fn_is_club_admin_uid(v_club_id)
           ) AS contains_admin_commission,
           COALESCE(
             (agent_capacity.document ->> 'total')::integer,
             0
           ) > v_max_rows AS agent_overflow
      FROM first_snapshot
      LEFT JOIN agent_capacity ON true
  ), bounded_snapshot AS MATERIALIZED (
    SELECT *
      FROM snapshot_shape
     WHERE snapshot_shape.total <= v_max_rows
       AND NOT snapshot_shape.agent_overflow
  ), page_offsets AS (
    SELECT generate_series(0, bounded_snapshot.total - 1, v_chunk)::integer AS page_offset,
           bounded_snapshot.document,
           bounded_snapshot.total,
           bounded_snapshot.contains_admin_commission
      FROM bounded_snapshot
  ), page_packs AS MATERIALIZED (
    SELECT page_offsets.page_offset,
           CASE
             WHEN page_offsets.page_offset = 0 THEN
               jsonb_build_object(
                 'rows', COALESCE(page_offsets.document -> 'breakdown', '[]'::jsonb)
               )
             WHEN v_scope = 'club' THEN public.fn_ca_rake_by_agent(
               v_club_id, v_start, v_end, v_chunk, page_offsets.page_offset,
               v_search, v_sort
             )
             WHEN v_scope = 'union' THEN public.fn_ca_rake_by_club(
               ARRAY(
                 SELECT union_club.club_id
                   FROM public.union_clubs union_club
                  WHERE union_club.union_id = v_union_id
                  ORDER BY union_club.club_id
               ),
               v_start, v_end, v_chunk, page_offsets.page_offset, v_search, v_sort
             )
             ELSE public.fn_ca_rake_by_downline(
               v_agent_user_id,
               v_club_id,
               (v_start::timestamp AT TIME ZONE 'UTC'),
               ((v_end + 1)::timestamp AT TIME ZONE 'UTC'),
               v_chunk,
               page_offsets.page_offset,
               v_search,
               v_sort
             )
           END AS page_document
      FROM page_offsets
  ), collected AS MATERIALIZED (
    SELECT page_row.row_data
      FROM page_packs
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(page_packs.page_document -> 'rows', '[]'::jsonb)
      ) WITH ORDINALITY AS page_row(row_data, page_ordinal)
  ), ordered AS (
    SELECT row_number() OVER (
             ORDER BY
               CASE WHEN v_scope = 'club' THEN
                 COALESCE((collected.row_data ->> 'is_unassigned')::boolean, false)
               END ASC NULLS LAST,
               CASE WHEN v_scope = 'club' AND v_sort = 'name' THEN
                 lower(COALESCE(collected.row_data ->> 'name', ''))
               END ASC NULLS LAST,
               CASE WHEN v_scope = 'club' AND v_sort = 'cost' THEN
                 NULLIF(collected.row_data ->> 'commission_earned', '')::numeric
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'club' AND v_sort = 'players' THEN
                 COALESCE((collected.row_data ->> 'network_players')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'club' AND v_sort = 'rake' THEN
                 COALESCE((collected.row_data ->> 'network_rake')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'union' AND v_sort = 'name' THEN
                 lower(COALESCE(collected.row_data ->> 'name', ''))
               END ASC NULLS LAST,
               CASE WHEN v_scope = 'union' AND v_sort = 'hands' THEN
                 COALESCE((collected.row_data ->> 'hands')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'union' AND v_sort = 'rake' THEN
                 COALESCE((collected.row_data ->> 'fee')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'agent' AND v_sort = 'name' THEN
                 lower(COALESCE(collected.row_data ->> 'name', ''))
               END ASC NULLS LAST,
               CASE WHEN v_scope = 'agent' AND v_sort = 'hands' THEN
                 COALESCE((collected.row_data ->> 'hands')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'agent' AND v_sort = 'rake' THEN
                 COALESCE((collected.row_data ->> 'rake')::numeric, 0)
               END DESC NULLS LAST,
               lower(COALESCE(collected.row_data ->> 'name', '')) ASC,
               CASE WHEN v_scope = 'club' THEN
                 COALESCE(collected.row_data ->> 'agent_user_id', '')
               END ASC,
               CASE WHEN v_scope = 'union' THEN
                 COALESCE(collected.row_data ->> 'club_id', '')
               END ASC,
               CASE WHEN v_scope = 'agent' THEN
                 COALESCE(collected.row_data ->> 'player_id', '')
               END ASC
           )::integer AS ordinal,
           collected.row_data AS payload
      FROM collected
  ), inserted_rows AS (
    INSERT INTO public.ca_club_data_export_rows(export_id, ordinal, payload)
    SELECT v_export_id, ordered.ordinal, ordered.payload
      FROM ordered
     ORDER BY ordered.ordinal
    RETURNING ordinal
  ), ready_metadata AS MATERIALIZED (
    SELECT jsonb_build_object(
             'schema_version', 1,
             'kind', 'rake',
             'scope_type', v_scope,
             'scope_id', v_scope_id,
             'club_id', v_club_id,
             -- Scope identity, not incidental membership context: a club that
             -- belongs to a union is still a club-scoped immutable request.
             'union_id', v_union_id,
             'agent_user_id', v_agent_user_id,
             'date_from', v_start,
             'date_to', v_end,
             'search', v_search,
             'sort', v_sort,
             'generated_at', snapshot_shape.document -> 'generated_at',
             'scope_label', snapshot_shape.document -> 'scope_label',
             'breakdown_kind', snapshot_shape.document -> 'breakdown_kind',
             'breakdown_total', COALESCE(
               (snapshot_shape.document ->> 'breakdown_total')::numeric,
               0
             ),
             'commission_total', snapshot_shape.document -> 'commission_total',
             'contains_admin_commission', snapshot_shape.contains_admin_commission
           ) AS metadata,
           snapshot_shape.total,
           COALESCE(
             (snapshot_shape.document ->> 'breakdown_total')::numeric,
             0
           ) AS total_amount
      FROM snapshot_shape
     WHERE snapshot_shape.total <= v_max_rows
       AND NOT snapshot_shape.agent_overflow
  ), finalized AS (
    UPDATE public.ca_club_data_exports export_job
       SET status = 'ready',
           total_rows = ready_metadata.total,
           total_amount = ready_metadata.total_amount,
           union_id = NULLIF(ready_metadata.metadata ->> 'union_id', '')::uuid,
           metadata = ready_metadata.metadata,
           metadata_fingerprint = md5(ready_metadata.metadata::text)
      FROM ready_metadata
     WHERE export_job.id = v_export_id
       AND (SELECT count(*) FROM inserted_rows) = ready_metadata.total
    RETURNING jsonb_build_object(
      'export_id', export_job.id,
      'status', export_job.status,
      'kind', export_job.kind,
      'total_rows', export_job.total_rows,
      'total_amount', export_job.total_amount,
      'expires_at', export_job.expires_at,
      'metadata', export_job.metadata,
      'metadata_fingerprint', export_job.metadata_fingerprint
    ) AS response
  )
  SELECT (SELECT finalized.response FROM finalized),
         snapshot_shape.total,
         (SELECT count(*)::integer FROM inserted_rows),
         snapshot_shape.agent_overflow
    INTO v_response, v_reported, v_inserted, v_agent_overflow
    FROM snapshot_shape;

  IF COALESCE(v_agent_overflow, false) THEN
    -- Refused before any search filtering, and the refusal names the whole
    -- unfiltered book, never the searched subset. The capacity walk above
    -- stops at its 20,001-row sentinel, so the book is counted once more
    -- here, uncapped, on this refusal path only.
    SELECT count(*)::integer
      INTO v_book_rows
      FROM public.fn_agent_downline_rake(
             v_agent_user_id,
             v_club_id,
             (v_start::timestamp AT TIME ZONE 'UTC'),
             ((v_end + 1)::timestamp AT TIME ZONE 'UTC'),
             NULL,
             2147483647
           );
    RAISE EXCEPTION
      'Rake Snapshot export has % rows; the safe limit is %',
      v_book_rows,
      v_max_rows
      USING ERRCODE = '54000';
  END IF;
  IF v_reported > v_max_rows THEN
    RAISE EXCEPTION
      'Rake Snapshot export has % rows; the safe limit is %',
      v_reported,
      v_max_rows
      USING ERRCODE = '54000';
  END IF;
  IF v_reported IS NULL OR v_inserted IS DISTINCT FROM v_reported
     OR v_response IS NULL THEN
    RAISE EXCEPTION
      'Rake Snapshot export changed while it was being prepared'
      USING ERRCODE = '40001';
  END IF;

  -- Somebody else's stranded expired job, if any: bounded, non-blocking,
  -- and last, so the row locks it takes are held only until this commit.
  PERFORM public.ca_prune_expired_club_data_exports(2000);

  RETURN v_response;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_rake_export_start(
  text, uuid, date, date, uuid, text, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_export_start(
  text, uuid, date, date, uuid, text, text, uuid
) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. The page door. Keeps the original lifecycle, makes an unavailable or
--    expired job distinct from a real authorization loss, branches the current
--    authorization check by the immutable scope stored on a Rake job, and
--    refuses a whole file whose narrower entitlements drifted after it was
--    prepared. STABLE: it deletes nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_club_data_export_page(
  p_export_id uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_job public.ca_club_data_exports%ROWTYPE;
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit, 1000), 2000), 1);
  v_rows jsonb;
  v_authorized boolean := false;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sign in to read an export' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_job
    FROM public.ca_club_data_exports export_job
   WHERE export_job.id = p_export_id
     AND export_job.user_id = v_user;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'export is unavailable' USING ERRCODE = '55000';
  END IF;
  IF v_job.expires_at <= now() THEN
    RAISE EXCEPTION 'export expired; prepare a new export' USING ERRCODE = '55000';
  END IF;
  IF v_job.status <> 'ready' THEN
    RAISE EXCEPTION 'export is still being prepared' USING ERRCODE = '55000';
  END IF;

  IF v_job.kind IN ('games', 'players') THEN
    v_authorized := public.ca_can_view_club_finances(v_job.club_id);
  ELSIF v_job.kind = 'rake' AND v_job.scope_type = 'club' THEN
    v_authorized := public.ca_can_read_club_production(v_job.club_id);
  ELSIF v_job.kind = 'rake' AND v_job.scope_type = 'union' THEN
    v_authorized := public.ca_can_oversee_union(v_job.union_id);
  ELSIF v_job.kind = 'rake' AND v_job.scope_type = 'agent' THEN
    v_authorized := public.ca_can_read_rake_agent(
      v_job.agent_user_id,
      v_job.club_id
    );
  END IF;

  IF NOT COALESCE(v_authorized, false) THEN
    RAISE EXCEPTION 'export is no longer authorized' USING ERRCODE = '42501';
  END IF;

  -- A union lead's authority follows today's union_clubs edges. A club that
  -- leaves after preparation takes its already-materialized row out of scope;
  -- invalidate the whole file before any later page can leak or be combined
  -- with an earlier page.
  IF v_job.kind = 'rake'
     AND v_job.scope_type = 'union'
     AND EXISTS (
       SELECT 1
         FROM public.ca_club_data_export_rows prepared_union_row
        WHERE prepared_union_row.export_id = p_export_id
          AND NOT EXISTS (
            SELECT 1
              FROM public.union_clubs current_union_club
             WHERE current_union_club.union_id = v_job.union_id
               AND current_union_club.club_id::text =
                   prepared_union_row.payload ->> 'club_id'
          )
     ) THEN
    RAISE EXCEPTION 'Rake Snapshot export permissions changed; prepare a new export'
      USING ERRCODE = '55000';
  END IF;

  -- Agent authority follows the current active agent tree and current player
  -- assignments. Rebuild identity + upline edges only (never the financial
  -- query) and require every prepared row to remain in that exact subtree.
  -- This catches a child/player leaving and a child being re-parented even
  -- while the root and viewer remain otherwise authorized.
  IF v_job.kind = 'rake'
     AND v_job.scope_type = 'agent'
     AND EXISTS (
       WITH RECURSIVE current_tree AS (
         SELECT root_agent.id,
                root_agent.user_id,
                root_agent.club_id,
                root_agent.parent_agent_id,
                0 AS depth,
                NULL::uuid AS upline_user_id,
                ARRAY[root_agent.id]::uuid[] AS path
           FROM public.agents root_agent
          WHERE root_agent.user_id = v_job.agent_user_id
            AND root_agent.club_id = v_job.club_id
            AND root_agent.status = 'active'
         UNION ALL
         SELECT child_agent.id,
                child_agent.user_id,
                child_agent.club_id,
                child_agent.parent_agent_id,
                current_tree.depth + 1,
                current_tree.user_id,
                current_tree.path || child_agent.id
           FROM current_tree
           JOIN public.agents child_agent
             ON child_agent.parent_agent_id = current_tree.id
            AND child_agent.club_id = v_job.club_id
            AND child_agent.status = 'active'
          WHERE child_agent.id <> ALL(current_tree.path)
       ), current_members AS MATERIALIZED (
         SELECT current_tree.user_id AS member_user_id,
                current_tree.upline_user_id
           FROM current_tree
          WHERE current_tree.depth > 0
         UNION
         SELECT club_member.user_id,
                club_member.agent_id
           FROM public.club_members club_member
           JOIN current_tree
             ON current_tree.user_id = club_member.agent_id
            AND current_tree.club_id = club_member.club_id
          WHERE club_member.club_id = v_job.club_id
            AND club_member.agent_id IS NOT NULL
       )
       SELECT 1
         FROM public.ca_club_data_export_rows prepared_agent_row
        WHERE prepared_agent_row.export_id = p_export_id
          AND NOT EXISTS (
            SELECT 1
              FROM current_members current_member
             WHERE current_member.member_user_id::text =
                   prepared_agent_row.payload ->> 'player_id'
               AND current_member.upline_user_id::text IS NOT DISTINCT FROM
                   prepared_agent_row.payload ->> 'upline_user_id'
          )
     ) THEN
    RAISE EXCEPTION 'Rake Snapshot export permissions changed; prepare a new export'
      USING ERRCODE = '55000';
  END IF;

  -- A player job prepared while this viewer was entitled can contain facts a
  -- super agent may not know. Refuse the whole file after a downgrade so no
  -- client can combine unmasked early pages with masked later pages.
  IF v_job.kind = 'players'
     AND NOT COALESCE(public.fn_can_see_horse_flag(v_job.club_id), false)
     AND EXISTS (
       SELECT 1
         FROM public.ca_club_data_export_rows sensitive
        WHERE sensitive.export_id = p_export_id
          AND sensitive.payload @> '{"is_horse": true}'::jsonb
     ) THEN
    RAISE EXCEPTION 'player export permissions changed; prepare a new export'
      USING ERRCODE = '55000';
  END IF;

  -- Club Rake rows can carry commission cost only when the canonical helper
  -- saw an owner/co-owner/admin. A downgrade to super agent keeps production
  -- access but loses cost access, so the prepared file is retired as a unit.
  IF v_job.kind = 'rake'
     AND COALESCE(
       (v_job.metadata ->> 'contains_admin_commission')::boolean,
       false
     )
     AND NOT public.fn_is_club_admin_uid(v_job.club_id) THEN
    RAISE EXCEPTION 'Rake Snapshot export permissions changed; prepare a new export'
      USING ERRCODE = '55000';
  END IF;

  IF v_job.kind = 'rake'
     AND v_job.metadata_fingerprint IS DISTINCT FROM md5(v_job.metadata::text) THEN
    RAISE EXCEPTION 'Rake Snapshot export metadata is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(
           jsonb_agg(export_row.payload ORDER BY export_row.ordinal),
           '[]'::jsonb
         )
    INTO v_rows
    FROM public.ca_club_data_export_rows export_row
   WHERE export_row.export_id = p_export_id
     AND export_row.ordinal > v_offset
     AND export_row.ordinal <= v_offset + v_limit;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'kind', v_job.kind,
    'total_rows', v_job.total_rows,
    'next_offset', LEAST(
      v_offset + jsonb_array_length(v_rows),
      v_job.total_rows
    ),
    'has_more', v_offset + jsonb_array_length(v_rows) < v_job.total_rows,
    'expires_at', v_job.expires_at,
    'metadata', v_job.metadata,
    'metadata_fingerprint', v_job.metadata_fingerprint
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_data_export_page(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_export_page(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. The cancel door: the caller's own job by primary key (SKIP LOCKED, so a
--    job that a start or prune is already retiring is reported as gone rather
--    than waited on), then the same bounded opportunistic prune. Same
--    signature and boolean result as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_club_data_export_cancel(p_export_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_deleted integer := 0;
BEGIN
  IF v_user IS NULL OR p_export_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.ca_club_data_exports cancelled_job
   USING (
     SELECT owned_job.id
       FROM public.ca_club_data_exports owned_job
      WHERE owned_job.id = p_export_id
        AND owned_job.user_id = v_user
      FOR UPDATE SKIP LOCKED
   ) owned
   WHERE cancelled_job.id = owned.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Anyone's stranded expired job: bounded and non-blocking.
  PERFORM public.ca_prune_expired_club_data_exports(2000);

  RETURN v_deleted = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_data_export_cancel(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_export_cancel(uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. Comments.
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.ca_rake_export_start(
  text, uuid, date, date, uuid, text, text, uuid
) IS
  'Materializes one complete, deterministic Rake Snapshot CSV job under the canonical scope query and current authorization in one reporting statement; reclaims the caller''s own expired job first and retires a bounded slice of anyone''s stranded expired jobs last.';
COMMENT ON FUNCTION public.ca_club_data_export_page(uuid, integer, integer) IS
  'Pages a private immutable Data or Rake export, distinguishing expiry from access loss and rechecking scope plus narrower horse/commission entitlements. STABLE; deletes nothing.';
COMMENT ON FUNCTION public.ca_club_data_export_cancel(uuid) IS
  'Deletes the caller''s own export job (cascading its rows) and then retires a bounded slice of anyone''s stranded expired jobs. No schedule owns expiry; the doors do.';
COMMENT ON FUNCTION public.ca_can_read_rake_agent(uuid, uuid) IS
  'Private page-time predicate: may the caller read the Rake Snapshot of this agent in this club (self, upline ancestor, club admin, or union overseer).';
COMMENT ON TABLE public.ca_club_data_exports IS
  'Short-lived immutable Club Data and Rake Snapshot CSV jobs, one per user. Direct access is denied; authorized RPCs own every read and delete, and expiry is enforced at those doors.';
COMMENT ON TABLE public.ca_club_data_export_rows IS
  'Deterministically ordered payload rows for short-lived Data and Rake exports; cascades on cancel, retired in bounded slices after expiry.';

-- ---------------------------------------------------------------------------
-- 11. Self-checks: constraint, function-body anchors, ACLs, fixed search_path
--     on every SECURITY DEFINER function this file created or touched.
-- ---------------------------------------------------------------------------
DO $rake_export_selfcheck$
DECLARE
  v_start_definition text;
  v_page_definition text;
  v_cancel_definition text;
  v_context_constraint text;
  v_signature regprocedure;
  v_config text;
BEGIN
  SELECT pg_get_functiondef(
    'public.ca_rake_export_start(text,uuid,date,date,uuid,text,text,uuid)'::regprocedure
  ) INTO v_start_definition;
  SELECT pg_get_functiondef(
    'public.ca_club_data_export_page(uuid,integer,integer)'::regprocedure
  ) INTO v_page_definition;
  SELECT pg_get_functiondef(
    'public.ca_club_data_export_cancel(uuid)'::regprocedure
  ) INTO v_cancel_definition;
  SELECT pg_get_constraintdef(constraint_row.oid)
    INTO v_context_constraint
    FROM pg_constraint constraint_row
   WHERE constraint_row.conrelid = 'public.ca_club_data_exports'::regclass
     AND constraint_row.conname = 'ca_club_data_exports_rake_context_check';

  IF v_context_constraint IS NULL
     OR position('scope_type' IN v_context_constraint) = 0
     OR position('metadata_fingerprint' IN v_context_constraint) = 0 THEN
    RAISE EXCEPTION 'RAKE_EXPORT_SCHEMA: immutable context check is absent';
  END IF;
  IF position('public.ca_rake_snapshot' IN v_start_definition) = 0
     OR position('public.fn_ca_rake_by_agent' IN v_start_definition) = 0
     OR position('public.fn_ca_rake_by_club' IN v_start_definition) = 0
     OR position('public.fn_ca_rake_by_downline' IN v_start_definition) = 0
     OR position('v_max_rows constant integer := 20000' IN v_start_definition) = 0
     OR position('count(*) FROM inserted_rows' IN v_start_definition) = 0
     OR position('INTO v_book_rows' IN v_start_definition) = 0 THEN
    RAISE EXCEPTION 'RAKE_EXPORT_BUILD: canonical or completeness guard is absent';
  END IF;
  IF position('existing_job.kind = ''rake''' IN v_start_definition) = 0
     OR position('other_kind.kind <> ''rake''' IN v_start_definition) = 0
     OR position('other_kind.kind <> ''rake''' IN v_start_definition)
        > position('active_slot.user_id = v_user' IN v_start_definition) THEN
    RAISE EXCEPTION 'RAKE_EXPORT_REPLAY: rake door can replay or rebuild over another kind''s request id';
  END IF;
  -- Own slot first, shared prune last (after the build), exactly once.
  IF position('FOR UPDATE OF stale_row SKIP LOCKED' IN v_start_definition) = 0
     OR position('active_slot.user_id = v_user' IN v_start_definition) = 0
     OR (length(v_start_definition)
         - length(replace(v_start_definition, 'public.ca_prune_expired_club_data_exports(2000)', '')))
        / length('public.ca_prune_expired_club_data_exports(2000)') <> 1
     OR position('public.ca_prune_expired_club_data_exports(2000)' IN v_start_definition)
        < position('active_slot.user_id = v_user' IN v_start_definition)
     OR position('public.ca_prune_expired_club_data_exports(2000)' IN v_start_definition)
        < position('count(*) FROM inserted_rows' IN v_start_definition) THEN
    RAISE EXCEPTION 'RAKE_EXPORT_RETENTION: rake door does not reclaim its own slot first and prune last';
  END IF;
  IF position('FOR UPDATE SKIP LOCKED' IN v_cancel_definition) = 0
     OR position('public.ca_prune_expired_club_data_exports(2000)' IN v_cancel_definition) = 0
     OR position('public.ca_prune_expired_club_data_exports(2000)' IN v_cancel_definition)
        < position('GET DIAGNOSTICS v_deleted = ROW_COUNT' IN v_cancel_definition) THEN
    RAISE EXCEPTION 'RAKE_EXPORT_RETENTION: cancel door does not delete its own job then prune';
  END IF;
  IF position('DELETE' IN v_page_definition) > 0 THEN
    RAISE EXCEPTION 'RAKE_EXPORT_PAGE: the STABLE page door must not delete';
  END IF;
  IF position('USING ERRCODE = ''55000''' IN v_page_definition) = 0
     OR position('USING ERRCODE = ''42501''' IN v_page_definition) = 0
     OR position('public.ca_can_read_club_production' IN v_page_definition) = 0
     OR position('public.ca_can_oversee_union' IN v_page_definition) = 0
     OR position('public.ca_can_read_rake_agent' IN v_page_definition) = 0
     OR position('current_union_club' IN v_page_definition) = 0
     OR position('current_members AS MATERIALIZED' IN v_page_definition) = 0
     OR position('prepared_agent_row.payload ->> ''upline_user_id''' IN v_page_definition) = 0
     OR position('fn_can_see_horse_flag' IN v_page_definition) = 0
     OR position('contains_admin_commission' IN v_page_definition) = 0
     OR position('metadata_fingerprint' IN v_page_definition) = 0 THEN
    RAISE EXCEPTION 'RAKE_EXPORT_PAGE: authorization or integrity guard is absent';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.ca_rake_export_start(text,uuid,date,date,uuid,text,text,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.ca_rake_export_start(text,uuid,date,date,uuid,text,text,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.ca_can_read_rake_agent(uuid,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege('anon', 'public.ca_club_data_export_cancel(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ca_club_data_export_cancel(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ca_club_data_export_cancel(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ca_club_data_export_page(uuid,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ca_club_data_export_page(uuid,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RAKE_EXPORT_ACL: public/private execution grants are wrong';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.ca_prune_expired_club_data_exports(integer)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.ca_prune_expired_club_data_exports(integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'CLUB_DATA_EXPORT_RETENTION: browser roles can execute the retention worker';
  END IF;

  -- All three start doors carry the same 120s statement_timeout in their
  -- function configuration.
  FOREACH v_signature IN ARRAY ARRAY[
    'public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid)'::regprocedure,
    'public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure,
    'public.ca_rake_export_start(text,uuid,date,date,uuid,text,text,uuid)'::regprocedure
  ]
  LOOP
    SELECT array_to_string(p.proconfig, ';') INTO v_config
      FROM pg_proc p WHERE p.oid = v_signature;
    IF COALESCE(v_config, '') NOT LIKE '%statement_timeout=120s%' THEN
      RAISE EXCEPTION
        'RAKE_EXPORT_BUDGET: % does not carry the 120s statement budget (%)',
        v_signature, v_config;
    END IF;
  END LOOP;

  -- Every SECURITY DEFINER function this file created or touched carries the
  -- fixed search_path public, pg_temp.
  FOREACH v_signature IN ARRAY ARRAY[
    'public.ca_prune_expired_club_data_exports(integer)'::regprocedure,
    'public.ca_can_read_rake_agent(uuid,uuid)'::regprocedure,
    'public.ca_rake_export_start(text,uuid,date,date,uuid,text,text,uuid)'::regprocedure,
    'public.ca_club_data_export_page(uuid,integer,integer)'::regprocedure,
    'public.ca_club_data_export_cancel(uuid)'::regprocedure,
    'public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid)'::regprocedure,
    'public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure,
    'public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure,
    'public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text)'::regprocedure,
    'public.fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer,text,text)'::regprocedure
  ]
  LOOP
    SELECT array_to_string(p.proconfig, ';') INTO v_config
      FROM pg_proc p WHERE p.oid = v_signature;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_signature AND p.prosecdef)
       OR COALESCE(v_config, '') NOT LIKE '%search_path=public, pg_temp%' THEN
      RAISE EXCEPTION
        'RAKE_EXPORT_SEARCH_PATH: % is not SECURITY DEFINER with search_path public, pg_temp (%)',
        v_signature, v_config;
    END IF;
  END LOOP;
END
$rake_export_selfcheck$;

-- ---------------------------------------------------------------------------
-- 12. No schedule owns expiry. A previous draft of this change scheduled a
--     pg_cron job named ca-club-data-export-expiry; it was never applied to
--     production, but if any environment carries one it is removed here, and
--     this file refuses to commit while any such job remains.
-- ---------------------------------------------------------------------------
DO $no_expiry_schedule$
DECLARE
  v_job record;
  v_remaining integer;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is not installed here; no expiry schedule can exist';
    RETURN;
  END IF;

  FOR v_job IN EXECUTE
    'SELECT jobid FROM cron.job WHERE jobname LIKE ''ca-club-data-export-expiry%'''
  LOOP
    EXECUTE format('SELECT cron.unschedule(%s::bigint)', v_job.jobid);
  END LOOP;

  EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname LIKE ''ca-club-data-export-expiry%'''
     INTO v_remaining;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      'CLUB_DATA_EXPORT_RETENTION: % expiry schedule(s) remain; expiry belongs to the doors, not to a schedule',
      v_remaining;
  END IF;
END
$no_expiry_schedule$;

COMMIT;

