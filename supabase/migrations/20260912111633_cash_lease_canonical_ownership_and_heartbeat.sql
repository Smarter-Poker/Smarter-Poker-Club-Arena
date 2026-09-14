-- INACTIVE0018. One MCP outer transaction; coordinated root deployment ownership.
-- Administrative ACL/function changes must be coordinated; no catalog UPDATE required.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.engine_table_leases IN ACCESS EXCLUSIVE MODE;
-- Independent narrowed PR4232-derived packet; MCP owns outer transaction.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $acl_guard$ DECLARE a jsonb; BEGIN
 SELECT jsonb_build_object('owner',pg_get_userbyid(relowner),'acl',relacl::text,'rls',relrowsecurity,'force',relforcerowsecurity) INTO a FROM pg_class WHERE oid='public.engine_table_leases'::regclass;
 IF a IS DISTINCT FROM $expected${"acl": "{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}", "rls": true, "force": false, "owner": "postgres"}$expected$::jsonb THEN RAISE EXCEPTION 'ACL_PREIMAGE: table metadata drift'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',attname,'acl',attacl::text) ORDER BY attnum) INTO a FROM pg_attribute WHERE attrelid='public.engine_table_leases'::regclass AND attnum>0 AND NOT attisdropped;
 IF a IS DISTINCT FROM $expected$[{"acl": null, "name": "table_id"}, {"acl": null, "name": "instance_id"}, {"acl": null, "name": "engine_version"}, {"acl": null, "name": "acquired_at"}, {"acl": null, "name": "heartbeat_at"}, {"acl": null, "name": "lease_generation"}, {"acl": null, "name": "protocol_version"}]$expected$::jsonb THEN RAISE EXCEPTION 'ACL_PREIMAGE: column metadata drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('service_role','anon','authenticated')) THEN RAISE EXCEPTION 'ACL_APPLICATION_ROLE_PARENT_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated') AND rolsuper) THEN RAISE EXCEPTION 'ACL_APPLICATION_SUPERUSER_DRIFT'; END IF;
END $acl_guard$;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.engine_table_leases FROM PUBLIC, anon, authenticated, service_role;
DO $acl_guard$ DECLARE a jsonb; BEGIN
 SELECT jsonb_build_object('owner',pg_get_userbyid(relowner),'acl',relacl::text,'rls',relrowsecurity,'force',relforcerowsecurity) INTO a FROM pg_class WHERE oid='public.engine_table_leases'::regclass;
 IF a IS DISTINCT FROM $expected${"acl": "{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=rxtm/postgres}", "rls": true, "force": false, "owner": "postgres"}$expected$::jsonb THEN RAISE EXCEPTION 'ACL_POSTIMAGE: table metadata drift'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',attname,'acl',attacl::text) ORDER BY attnum) INTO a FROM pg_attribute WHERE attrelid='public.engine_table_leases'::regclass AND attnum>0 AND NOT attisdropped;
 IF a IS DISTINCT FROM $expected$[{"acl": null, "name": "table_id"}, {"acl": null, "name": "instance_id"}, {"acl": null, "name": "engine_version"}, {"acl": null, "name": "acquired_at"}, {"acl": null, "name": "heartbeat_at"}, {"acl": null, "name": "lease_generation"}, {"acl": null, "name": "protocol_version"}]$expected$::jsonb THEN RAISE EXCEPTION 'ACL_POSTIMAGE: column metadata drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('service_role','anon','authenticated')) THEN RAISE EXCEPTION 'ACL_APPLICATION_ROLE_PARENT_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated') AND rolsuper) THEN RAISE EXCEPTION 'ACL_APPLICATION_SUPERUSER_DRIFT'; END IF;
END $acl_guard$;
DO $effective$ DECLARE r text; c record; BEGIN
 FOREACH r IN ARRAY ARRAY['service_role','anon','authenticated'] LOOP
 IF has_table_privilege(r,'public.engine_table_leases','INSERT') OR has_table_privilege(r,'public.engine_table_leases','UPDATE') OR has_table_privilege(r,'public.engine_table_leases','DELETE') OR has_table_privilege(r,'public.engine_table_leases','TRUNCATE') THEN RAISE EXCEPTION 'EFFECTIVE_TABLE_MUTATION_REMAINS: %',r; END IF;
 FOR c IN SELECT attname FROM pg_attribute WHERE attrelid='public.engine_table_leases'::regclass AND attnum>0 AND NOT attisdropped LOOP
 IF has_column_privilege(r,'public.engine_table_leases',c.attname,'INSERT') OR has_column_privilege(r,'public.engine_table_leases',c.attname,'UPDATE') THEN RAISE EXCEPTION 'EFFECTIVE_COLUMN_MUTATION_REMAINS: % %',r,c.attname; END IF;
 END LOOP;
 END LOOP;
END $effective$;

-- Candidate only. MCP apply_migration supplies the single outer transaction.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ DECLARE e jsonb; a jsonb; BEGIN
FOR e IN SELECT value FROM jsonb_array_elements($expected$[{"acl": "{postgres=X/postgres,service_role=X/postgres}", "owner": "postgres", "config": ["search_path=public, pg_temp"], "signature": "claim_table_lease_v2(uuid,text,text,uuid,integer)", "definition": "CREATE OR REPLACE FUNCTION public.claim_table_lease_v2(p_table_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)\n RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nDECLARE\n  v_holder text;\n  v_heartbeat timestamptz;\n  v_generation uuid;\n  v_protocol integer;\nBEGIN\n  IF p_table_id IS NULL\n     OR length(btrim(COALESCE(p_instance_id, ''))) = 0\n     OR p_requested_generation IS NULL THEN\n    RAISE EXCEPTION\n      'claim_table_lease_v2 requires table_id, instance_id, and requested_generation'\n      USING ERRCODE = '22023';\n  END IF;\n  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN\n    RAISE EXCEPTION 'claim_table_lease_v2 requires the audited 30 second stale window'\n      USING ERRCODE = '22023';\n  END IF;\n\n  INSERT INTO public.engine_table_leases AS l (\n    table_id,\n    instance_id,\n    engine_version,\n    acquired_at,\n    heartbeat_at,\n    lease_generation,\n    protocol_version\n  ) VALUES (\n    p_table_id,\n    p_instance_id,\n    p_version,\n    clock_timestamp(),\n    clock_timestamp(),\n    p_requested_generation,\n    2\n  )\n  ON CONFLICT (table_id) DO UPDATE\n     SET instance_id = EXCLUDED.instance_id,\n         engine_version = EXCLUDED.engine_version,\n         acquired_at = CASE\n           WHEN l.protocol_version = 2\n            AND l.instance_id = EXCLUDED.instance_id\n            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at\n           ELSE clock_timestamp()\n         END,\n         heartbeat_at = clock_timestamp(),\n         lease_generation = EXCLUDED.lease_generation,\n         protocol_version = 2\n   WHERE (\n       l.protocol_version = 2\n       AND l.instance_id = EXCLUDED.instance_id\n       AND l.lease_generation = EXCLUDED.lease_generation\n     )\n      OR (\n       l.protocol_version < 2\n       AND l.instance_id = EXCLUDED.instance_id\n     )\n      OR (\n           l.heartbeat_at < clock_timestamp() - make_interval(\n             secs => public.fn_engine_lease_stale_seconds()\n           )\n       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation\n         )\n  RETURNING l.instance_id,\n            l.heartbeat_at,\n            l.lease_generation,\n            l.protocol_version\n       INTO v_holder, v_heartbeat, v_generation, v_protocol;\n\n  IF v_holder IS NOT NULL THEN\n    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, v_protocol;\n    RETURN;\n  END IF;\n\n  SELECT l.instance_id,\n         l.heartbeat_at,\n         l.lease_generation,\n         l.protocol_version\n    INTO v_holder, v_heartbeat, v_generation, v_protocol\n    FROM public.engine_table_leases l\n   WHERE l.table_id = p_table_id;\n\n  RETURN QUERY\n    SELECT false,\n           v_holder,\n           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),\n           v_generation,\n           v_protocol;\nEND;\n$function$\n"}, {"acl": "{postgres=X/postgres}", "owner": "postgres", "config": ["search_path=public, pg_temp"], "signature": "fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)", "definition": "CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nDECLARE\n  v_tournament_id uuid;\n  v_locked_tournament_id uuid;\n  v_holder text;\n  v_generation uuid;\n  v_protocol_version integer;\n  v_heartbeat_at timestamptz;\n  v_lease_found boolean;\n  v_scope text;\nBEGIN\n  IF length(btrim(COALESCE(p_instance_id, ''))) = 0\n     OR p_lease_generation IS NULL THEN\n    RETURN jsonb_build_object(\n      'success', false,\n      'atomic_hand_commit', false,\n      'reason', 'invalid_hand_lease_authority'\n    );\n  END IF;\n\n  /* This read is deliberately unlocked and is used only to choose one lease\n     relation.  No mutation follows until the chosen lease is locked and the\n     tables row is itself locked/re-read below. */\n  SELECT t.tournament_id INTO v_tournament_id\n    FROM public.tables t\n   WHERE t.id = p_table_id;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');\n  END IF;\n\n  IF v_tournament_id IS NULL THEN\n    v_scope := 'table';\n    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at\n      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at\n      FROM public.engine_table_leases l\n     WHERE l.table_id = p_table_id\n     FOR SHARE;\n    v_lease_found := FOUND;\n  ELSE\n    v_scope := 'tournament';\n    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at\n      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at\n      FROM public.engine_tournament_leases l\n     WHERE l.tournament_id = v_tournament_id\n     -- A HAND COMMIT DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT\n     -- (2026-09-10): FOR KEY SHARE excludes a takeover (FOR UPDATE) and\n     -- nothing else, so the heartbeat can still renew this row.\n     FOR KEY SHARE;\n    v_lease_found := FOUND;\n  END IF;\n\n  IF NOT v_lease_found\n     OR v_protocol_version IS DISTINCT FROM 2\n     OR v_holder IS DISTINCT FROM p_instance_id\n     OR v_generation IS DISTINCT FROM p_lease_generation THEN\n    RETURN jsonb_build_object(\n      'success', false,\n      'atomic_hand_commit', false,\n      'reason', 'hand_lease_lost',\n      'lease_scope', v_scope,\n      'lease_generation', v_generation\n    );\n  END IF;\n\n  IF v_heartbeat_at < clock_timestamp() - make_interval(\n       secs => public.fn_engine_lease_stale_seconds()\n     ) THEN\n    RETURN jsonb_build_object(\n      'success', false,\n      'atomic_hand_commit', false,\n      'reason', 'hand_lease_stale',\n      'lease_scope', v_scope,\n      'lease_generation', v_generation\n    );\n  END IF;\n\n  /* Match the unchanged core and manager lock order before taking the mutable\n     table row.  FOR SHARE excludes tournament lifecycle updates without\n     serializing hands at distinct tables in the same event. */\n  IF v_tournament_id IS NOT NULL THEN\n    PERFORM 1\n      FROM public.tournaments t\n     WHERE t.id = v_tournament_id\n     FOR SHARE;\n    IF NOT FOUND THEN\n      RETURN jsonb_build_object('success', false, 'reason', 'tournament_not_found');\n    END IF;\n  END IF;\n\n  /* Cash uses lease -> table. Tournament settlement uses\n     lease -> tournament parent -> table. Holding the exact lease now prevents\n     takeover until the unchanged core has committed or rolled back. */\n  SELECT t.tournament_id INTO v_locked_tournament_id\n    FROM public.tables t\n   WHERE t.id = p_table_id\n   FOR UPDATE;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');\n  END IF;\n  IF v_locked_tournament_id IS DISTINCT FROM v_tournament_id THEN\n    RETURN jsonb_build_object(\n      'success', false,\n      'atomic_hand_commit', false,\n      'reason', 'hand_lease_scope_changed'\n    );\n  END IF;\n\n  RETURN public.fn_ca_commit_hand_settlement_before_lease_generation(\n    p_table_id,\n    p_hand_number,\n    p_stacks,\n    p_rake,\n    p_bbj,\n    p_ref,\n    p_inflow,\n    p_hand_row,\n    p_units\n  );\nEND;\n$function$\n"}, {"acl": "{postgres=X/postgres,service_role=X/postgres}", "owner": "postgres", "config": ["search_path=public, extensions, pg_temp"], "signature": "fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)", "definition": "CREATE OR REPLACE FUNCTION public.fn_ca_resolve_unbound_pending_addons(p_table_id uuid, p_max_buy_in numeric, p_instance_id text, p_lease_generation uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'extensions', 'pg_temp'\nAS $function$\nDECLARE\n  v_holder text;\n  v_generation uuid;\n  v_protocol integer;\n  v_heartbeat timestamptz;\n  v_tournament_id uuid;\n  v_addon public.table_pending_addons%ROWTYPE;\n  v_resolution record;\n  v_rows jsonb := '[]'::jsonb;\nBEGIN\n  IF p_table_id IS NULL\n     OR p_max_buy_in IS NULL\n     OR p_max_buy_in <= 0\n     OR length(btrim(COALESCE(p_instance_id, ''))) = 0\n     OR p_lease_generation IS NULL THEN\n    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');\n  END IF;\n\n  /* One lock vocabulary with the durable hand processor. Take it first on\n     both paths so two pending-row consumers cannot form a reverse lock order\n     through resolve_pending_addon's seat lock. */\n  PERFORM pg_advisory_xact_lock(\n    hashtextextended('hand-post-commit:' || p_table_id::text, 0)\n  );\n\n  SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at\n    INTO v_holder, v_generation, v_protocol, v_heartbeat\n    FROM public.engine_table_leases l\n   WHERE l.table_id = p_table_id\n   FOR SHARE;\n  IF NOT FOUND\n     OR v_protocol IS DISTINCT FROM 2\n     OR v_holder IS DISTINCT FROM p_instance_id\n     OR v_generation IS DISTINCT FROM p_lease_generation\n     OR v_heartbeat < clock_timestamp() - make_interval(\n          secs => public.fn_engine_lease_stale_seconds()\n        ) THEN\n    RETURN jsonb_build_object(\n      'ok', false,\n      'reason', 'lease_lost',\n      'lease_generation', v_generation\n    );\n  END IF;\n\n  /* Exact hand settlement takes lease -> table as well. Holding this row\n     through selection and delivery makes \"not frozen\" a stable statement. */\n  SELECT t.tournament_id INTO v_tournament_id\n    FROM public.tables t\n   WHERE t.id = p_table_id\n   FOR UPDATE;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');\n  END IF;\n  IF v_tournament_id IS NOT NULL THEN\n    RETURN jsonb_build_object('ok', false, 'reason', 'cash_table_required');\n  END IF;\n\n  FOR v_addon IN\n    SELECT a.*\n      FROM public.table_pending_addons a\n     WHERE a.table_id = p_table_id\n       AND a.resolved_at IS NULL\n       AND NOT EXISTS (\n         SELECT 1\n           FROM public.hand_atomic_commits c\n          WHERE c.table_id = p_table_id\n            AND jsonb_typeof(\n                  c.post_commit_payload #> '{pending_addons,ids}'\n                ) = 'array'\n            AND (c.post_commit_payload #> '{pending_addons,ids}') ? a.id::text\n       )\n     ORDER BY a.created_at, a.id\n     FOR UPDATE\n  LOOP\n    SELECT * INTO STRICT v_resolution\n      FROM public.resolve_pending_addon(v_addon.id, p_max_buy_in);\n    v_rows := v_rows || jsonb_build_array(jsonb_build_object(\n      'id', v_addon.id,\n      'user_id', v_addon.user_id,\n      'kind', COALESCE(v_addon.kind, 'addon'),\n      'applied', COALESCE(v_resolution.applied, 0),\n      'refunded', COALESCE(v_resolution.refunded, 0)\n    ));\n  END LOOP;\n\n  RETURN jsonb_build_object(\n    'ok', true,\n    'table_id', p_table_id,\n    'lease_generation', p_lease_generation,\n    'resolved', jsonb_array_length(v_rows),\n    'rows', v_rows\n  );\nEND;\n$function$\n"}, {"acl": "{postgres=X/postgres,service_role=X/postgres}", "owner": "postgres", "config": ["search_path=public, pg_temp"], "signature": "heartbeat_table_leases_v4(text,jsonb,integer)", "definition": "CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v4(p_instance_id text, p_claims jsonb, p_stale_seconds integer DEFAULT 30)\n RETURNS TABLE(table_id uuid, state text, lease_generation uuid)\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nBEGIN\n  IF length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN\n    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires a non-empty instance_id'\n      USING ERRCODE = '22023';\n  END IF;\n  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN\n    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires the audited 30 second stale window'\n      USING ERRCODE = '22023';\n  END IF;\n  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN\n    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires a JSON array of claims'\n      USING ERRCODE = '22023';\n  END IF;\n  IF EXISTS (\n    SELECT 1\n      FROM jsonb_array_elements(p_claims) item\n     WHERE jsonb_typeof(item) <> 'object'\n        OR length(btrim(COALESCE(item ->> 'table_id', ''))) = 0\n        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0\n  ) THEN\n    RAISE EXCEPTION\n      'heartbeat_table_leases_v4 requires table_id and lease_generation for every claim'\n      USING ERRCODE = '22023';\n  END IF;\n\n  /* Cast before any UPDATE and reject duplicate table ids for the whole\n     request.  A partial heartbeat would falsely make omitted claims look\n     current to the engine. */\n  IF EXISTS (\n    WITH asked AS (\n      SELECT (item ->> 'table_id')::uuid AS id\n        FROM jsonb_array_elements(p_claims) item\n    )\n    SELECT 1 FROM asked GROUP BY id HAVING count(*) <> 1\n  ) THEN\n    RAISE EXCEPTION 'heartbeat_table_leases_v4 refuses duplicate tables'\n      USING ERRCODE = '22023';\n  END IF;\n\n  RETURN QUERY\n  WITH asked AS MATERIALIZED (\n    SELECT (item ->> 'table_id')::uuid AS id,\n           (item ->> 'lease_generation')::uuid AS requested_generation\n      FROM jsonb_array_elements(p_claims) item\n  ),\n  lockable AS MATERIALIZED (\n    SELECT l.table_id\n      FROM public.engine_table_leases l\n      JOIN asked a ON a.id = l.table_id\n     WHERE l.instance_id = p_instance_id\n       AND l.protocol_version = 2\n       AND l.lease_generation = a.requested_generation\n       AND l.heartbeat_at >= clock_timestamp() - make_interval(\n         secs => public.fn_engine_lease_stale_seconds()\n       )\n     -- Keep the same conflicting lock as the UPDATE, but never queue behind\n     -- a settlement while holding already-renewed leases for other tables.\n     FOR NO KEY UPDATE OF l SKIP LOCKED\n  ),\n  renewed AS (\n    UPDATE public.engine_table_leases l\n       SET heartbeat_at = clock_timestamp()\n      FROM asked a, lockable k\n     WHERE l.table_id = a.id\n       AND k.table_id = l.table_id\n       AND l.instance_id = p_instance_id\n       AND l.protocol_version = 2\n       AND l.lease_generation = a.requested_generation\n       AND l.heartbeat_at >= clock_timestamp() - make_interval(\n         secs => public.fn_engine_lease_stale_seconds()\n       )\n    RETURNING l.table_id, l.lease_generation\n  )\n  SELECT a.id,\n         CASE\n           WHEN r.table_id IS NOT NULL THEN 'kept'\n           WHEN l.table_id IS NULL THEN 'missing'\n           WHEN l.heartbeat_at < clock_timestamp() - make_interval(\n             secs => public.fn_engine_lease_stale_seconds()\n           ) THEN 'stale'\n           WHEN l.instance_id = p_instance_id\n            AND l.protocol_version = 2\n            AND l.lease_generation = a.requested_generation THEN 'busy'\n           ELSE 'taken'\n         END,\n         l.lease_generation\n    FROM asked a\n    LEFT JOIN renewed r ON r.table_id = a.id\n    LEFT JOIN public.engine_table_leases l ON l.table_id = a.id;\nEND;\n$function$\n"}]$expected$::jsonb) LOOP
 SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'config',p.proconfig,'acl',p.proacl::text) INTO a FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(e->>'signature'));
 IF a IS DISTINCT FROM e THEN RAISE EXCEPTION '4375_PREIMAGE: exact definition/owner/config/ACL drift'; END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=split_part(e->>'signature','(',1))<>1 THEN RAISE EXCEPTION '4375_PREIMAGE: overload drift'; END IF;
END LOOP; END $guard$;

-- Original PR4375 body begins (only standalone BEGIN/COMMIT removed).
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



-- Original body ends.
DO $guard$ DECLARE e jsonb; a jsonb; BEGIN
FOR e IN SELECT value FROM jsonb_array_elements($expected$[{"acl": "{postgres=X/postgres,service_role=X/postgres}", "owner": "postgres", "config": ["search_path=public, pg_temp"], "signature": "claim_table_lease_v2(uuid,text,text,uuid,integer)", "definition": "CREATE OR REPLACE FUNCTION public.claim_table_lease_v2(p_table_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)\n RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nDECLARE\n  v_holder text;\n  v_heartbeat timestamptz;\n  v_generation uuid;\n  v_protocol integer;\nBEGIN\n  IF p_table_id IS NULL\n     OR length(btrim(COALESCE(p_instance_id, ''))) = 0\n     OR p_requested_generation IS NULL THEN\n    RAISE EXCEPTION\n      'claim_table_lease_v2 requires table_id, instance_id, and requested_generation'\n      USING ERRCODE = '22023';\n  END IF;\n  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN\n    RAISE EXCEPTION 'claim_table_lease_v2 requires the audited 30 second stale window'\n      USING ERRCODE = '22023';\n  END IF;\n\n  /* A BUSY TABLE KEEPS ITS LEASE (2026-09-12): the takeover waits for every\n     in-flight settlement (they hold FOR KEY SHARE on this row). The upsert\n     below only takes FOR NO KEY UPDATE on its own, which FOR KEY SHARE does\n     not block - so without this the settlement's lock would exclude nothing.\n     This is the cash half of the pair claim_tournament_lease_v2 has had since\n     2026-09-10. */\n  PERFORM 1 FROM public.engine_table_leases l\n   WHERE l.table_id = p_table_id\n   FOR UPDATE;\n\n  INSERT INTO public.engine_table_leases AS l (\n    table_id,\n    instance_id,\n    engine_version,\n    acquired_at,\n    heartbeat_at,\n    lease_generation,\n    protocol_version\n  ) VALUES (\n    p_table_id,\n    p_instance_id,\n    p_version,\n    clock_timestamp(),\n    clock_timestamp(),\n    p_requested_generation,\n    2\n  )\n  ON CONFLICT (table_id) DO UPDATE\n     SET instance_id = EXCLUDED.instance_id,\n         engine_version = EXCLUDED.engine_version,\n         acquired_at = CASE\n           WHEN l.protocol_version = 2\n            AND l.instance_id = EXCLUDED.instance_id\n            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at\n           ELSE clock_timestamp()\n         END,\n         heartbeat_at = clock_timestamp(),\n         lease_generation = EXCLUDED.lease_generation,\n         protocol_version = 2\n   WHERE (\n       l.protocol_version = 2\n       AND l.instance_id = EXCLUDED.instance_id\n       AND l.lease_generation = EXCLUDED.lease_generation\n     )\n      OR (\n       l.protocol_version < 2\n       AND l.instance_id = EXCLUDED.instance_id\n     )\n      OR (\n           l.heartbeat_at < clock_timestamp() - make_interval(\n             secs => public.fn_engine_lease_stale_seconds()\n           )\n       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation\n         )\n  RETURNING l.instance_id,\n            l.heartbeat_at,\n            l.lease_generation,\n            l.protocol_version\n       INTO v_holder, v_heartbeat, v_generation, v_protocol;\n\n  IF v_holder IS NOT NULL THEN\n    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, v_protocol;\n    RETURN;\n  END IF;\n\n  SELECT l.instance_id,\n         l.heartbeat_at,\n         l.lease_generation,\n         l.protocol_version\n    INTO v_holder, v_heartbeat, v_generation, v_protocol\n    FROM public.engine_table_leases l\n   WHERE l.table_id = p_table_id;\n\n  RETURN QUERY\n    SELECT false,\n           v_holder,\n           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),\n           v_generation,\n           v_protocol;\nEND;\n$function$\n"}, {"acl": "{postgres=X/postgres}", "owner": "postgres", "config": ["search_path=public, pg_temp"], "signature": "fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)", "definition": "CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nDECLARE\n  v_tournament_id uuid;\n  v_locked_tournament_id uuid;\n  v_holder text;\n  v_generation uuid;\n  v_protocol_version integer;\n  v_heartbeat_at timestamptz;\n  v_lease_found boolean;\n  v_scope text;\nBEGIN\n  IF length(btrim(COALESCE(p_instance_id, ''))) = 0\n     OR p_lease_generation IS NULL THEN\n    RETURN jsonb_build_object(\n      'success', false,\n      'atomic_hand_commit', false,\n      'reason', 'invalid_hand_lease_authority'\n    );\n  END IF;\n\n  /* This read is deliberately unlocked and is used only to choose one lease\n     relation.  No mutation follows until the chosen lease is locked and the\n     tables row is itself locked/re-read below. */\n  SELECT t.tournament_id INTO v_tournament_id\n    FROM public.tables t\n   WHERE t.id = p_table_id;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');\n  END IF;\n\n  IF v_tournament_id IS NULL THEN\n    v_scope := 'table';\n    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at\n      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at\n      FROM public.engine_table_leases l\n     WHERE l.table_id = p_table_id\n     FOR KEY SHARE;\n    v_lease_found := FOUND;\n  ELSE\n    v_scope := 'tournament';\n    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at\n      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at\n      FROM public.engine_tournament_leases l\n     WHERE l.tournament_id = v_tournament_id\n     -- A HAND COMMIT DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT\n     -- (2026-09-10): FOR KEY SHARE excludes a takeover (FOR UPDATE) and\n     -- nothing else, so the heartbeat can still renew this row.\n     FOR KEY SHARE;\n    v_lease_found := FOUND;\n  END IF;\n\n  IF NOT v_lease_found\n     OR v_protocol_version IS DISTINCT FROM 2\n     OR v_holder IS DISTINCT FROM p_instance_id\n     OR v_generation IS DISTINCT FROM p_lease_generation THEN\n    RETURN jsonb_build_object(\n      'success', false,\n      'atomic_hand_commit', false,\n      'reason', 'hand_lease_lost',\n      'lease_scope', v_scope,\n      'lease_generation', v_generation\n    );\n  END IF;\n\n  IF v_heartbeat_at < clock_timestamp() - make_interval(\n       secs => public.fn_engine_lease_stale_seconds()\n     ) THEN\n    RETURN jsonb_build_object(\n      'success', false,\n      'atomic_hand_commit', false,\n      'reason', 'hand_lease_stale',\n      'lease_scope', v_scope,\n      'lease_generation', v_generation\n    );\n  END IF;\n\n  /* Match the unchanged core and manager lock order before taking the mutable\n     table row.  FOR SHARE excludes tournament lifecycle updates without\n     serializing hands at distinct tables in the same event. */\n  IF v_tournament_id IS NOT NULL THEN\n    PERFORM 1\n      FROM public.tournaments t\n     WHERE t.id = v_tournament_id\n     FOR SHARE;\n    IF NOT FOUND THEN\n      RETURN jsonb_build_object('success', false, 'reason', 'tournament_not_found');\n    END IF;\n  END IF;\n\n  /* Cash uses lease -> table. Tournament settlement uses\n     lease -> tournament parent -> table. Holding the exact lease now prevents\n     takeover until the unchanged core has committed or rolled back. */\n  SELECT t.tournament_id INTO v_locked_tournament_id\n    FROM public.tables t\n   WHERE t.id = p_table_id\n   FOR UPDATE;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');\n  END IF;\n  IF v_locked_tournament_id IS DISTINCT FROM v_tournament_id THEN\n    RETURN jsonb_build_object(\n      'success', false,\n      'atomic_hand_commit', false,\n      'reason', 'hand_lease_scope_changed'\n    );\n  END IF;\n\n  RETURN public.fn_ca_commit_hand_settlement_before_lease_generation(\n    p_table_id,\n    p_hand_number,\n    p_stacks,\n    p_rake,\n    p_bbj,\n    p_ref,\n    p_inflow,\n    p_hand_row,\n    p_units\n  );\nEND;\n$function$\n"}, {"acl": "{postgres=X/postgres,service_role=X/postgres}", "owner": "postgres", "config": ["search_path=public, extensions, pg_temp"], "signature": "fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)", "definition": "CREATE OR REPLACE FUNCTION public.fn_ca_resolve_unbound_pending_addons(p_table_id uuid, p_max_buy_in numeric, p_instance_id text, p_lease_generation uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'extensions', 'pg_temp'\nAS $function$\nDECLARE\n  v_holder text;\n  v_generation uuid;\n  v_protocol integer;\n  v_heartbeat timestamptz;\n  v_tournament_id uuid;\n  v_addon public.table_pending_addons%ROWTYPE;\n  v_resolution record;\n  v_rows jsonb := '[]'::jsonb;\nBEGIN\n  IF p_table_id IS NULL\n     OR p_max_buy_in IS NULL\n     OR p_max_buy_in <= 0\n     OR length(btrim(COALESCE(p_instance_id, ''))) = 0\n     OR p_lease_generation IS NULL THEN\n    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');\n  END IF;\n\n  /* One lock vocabulary with the durable hand processor. Take it first on\n     both paths so two pending-row consumers cannot form a reverse lock order\n     through resolve_pending_addon's seat lock. */\n  PERFORM pg_advisory_xact_lock(\n    hashtextextended('hand-post-commit:' || p_table_id::text, 0)\n  );\n\n  SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at\n    INTO v_holder, v_generation, v_protocol, v_heartbeat\n    FROM public.engine_table_leases l\n   WHERE l.table_id = p_table_id\n   FOR KEY SHARE;\n  IF NOT FOUND\n     OR v_protocol IS DISTINCT FROM 2\n     OR v_holder IS DISTINCT FROM p_instance_id\n     OR v_generation IS DISTINCT FROM p_lease_generation\n     OR v_heartbeat < clock_timestamp() - make_interval(\n          secs => public.fn_engine_lease_stale_seconds()\n        ) THEN\n    RETURN jsonb_build_object(\n      'ok', false,\n      'reason', 'lease_lost',\n      'lease_generation', v_generation\n    );\n  END IF;\n\n  /* Exact hand settlement takes lease -> table as well. Holding this row\n     through selection and delivery makes \"not frozen\" a stable statement. */\n  SELECT t.tournament_id INTO v_tournament_id\n    FROM public.tables t\n   WHERE t.id = p_table_id\n   FOR UPDATE;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');\n  END IF;\n  IF v_tournament_id IS NOT NULL THEN\n    RETURN jsonb_build_object('ok', false, 'reason', 'cash_table_required');\n  END IF;\n\n  FOR v_addon IN\n    SELECT a.*\n      FROM public.table_pending_addons a\n     WHERE a.table_id = p_table_id\n       AND a.resolved_at IS NULL\n       AND NOT EXISTS (\n         SELECT 1\n           FROM public.hand_atomic_commits c\n          WHERE c.table_id = p_table_id\n            AND jsonb_typeof(\n                  c.post_commit_payload #> '{pending_addons,ids}'\n                ) = 'array'\n            AND (c.post_commit_payload #> '{pending_addons,ids}') ? a.id::text\n       )\n     ORDER BY a.created_at, a.id\n     FOR UPDATE\n  LOOP\n    SELECT * INTO STRICT v_resolution\n      FROM public.resolve_pending_addon(v_addon.id, p_max_buy_in);\n    v_rows := v_rows || jsonb_build_array(jsonb_build_object(\n      'id', v_addon.id,\n      'user_id', v_addon.user_id,\n      'kind', COALESCE(v_addon.kind, 'addon'),\n      'applied', COALESCE(v_resolution.applied, 0),\n      'refunded', COALESCE(v_resolution.refunded, 0)\n    ));\n  END LOOP;\n\n  RETURN jsonb_build_object(\n    'ok', true,\n    'table_id', p_table_id,\n    'lease_generation', p_lease_generation,\n    'resolved', jsonb_array_length(v_rows),\n    'rows', v_rows\n  );\nEND;\n$function$\n"}, {"acl": "{postgres=X/postgres,service_role=X/postgres}", "owner": "postgres", "config": ["search_path=public, pg_temp"], "signature": "heartbeat_table_leases_v4(text,jsonb,integer)", "definition": "CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v4(p_instance_id text, p_claims jsonb, p_stale_seconds integer DEFAULT 30)\n RETURNS TABLE(table_id uuid, state text, lease_generation uuid)\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nBEGIN\n  IF length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN\n    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires a non-empty instance_id'\n      USING ERRCODE = '22023';\n  END IF;\n  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN\n    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires the audited 30 second stale window'\n      USING ERRCODE = '22023';\n  END IF;\n  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN\n    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires a JSON array of claims'\n      USING ERRCODE = '22023';\n  END IF;\n  IF EXISTS (\n    SELECT 1\n      FROM jsonb_array_elements(p_claims) item\n     WHERE jsonb_typeof(item) <> 'object'\n        OR length(btrim(COALESCE(item ->> 'table_id', ''))) = 0\n        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0\n  ) THEN\n    RAISE EXCEPTION\n      'heartbeat_table_leases_v4 requires table_id and lease_generation for every claim'\n      USING ERRCODE = '22023';\n  END IF;\n\n  /* Cast before any UPDATE and reject duplicate table ids for the whole\n     request.  A partial heartbeat would falsely make omitted claims look\n     current to the engine. */\n  IF EXISTS (\n    WITH asked AS (\n      SELECT (item ->> 'table_id')::uuid AS id\n        FROM jsonb_array_elements(p_claims) item\n    )\n    SELECT 1 FROM asked GROUP BY id HAVING count(*) <> 1\n  ) THEN\n    RAISE EXCEPTION 'heartbeat_table_leases_v4 refuses duplicate tables'\n      USING ERRCODE = '22023';\n  END IF;\n\n  RETURN QUERY\n  WITH asked AS MATERIALIZED (\n    SELECT (item ->> 'table_id')::uuid AS id,\n           (item ->> 'lease_generation')::uuid AS requested_generation\n      FROM jsonb_array_elements(p_claims) item\n  ),\n  lockable AS MATERIALIZED (\n    SELECT l.table_id\n      FROM public.engine_table_leases l\n      JOIN asked a ON a.id = l.table_id\n     WHERE l.instance_id = p_instance_id\n       AND l.protocol_version = 2\n       AND l.lease_generation = a.requested_generation\n       AND l.heartbeat_at >= clock_timestamp() - make_interval(\n         secs => public.fn_engine_lease_stale_seconds()\n       )\n     -- Keep the same conflicting lock as the UPDATE, but never queue behind\n     -- a settlement while holding already-renewed leases for other tables.\n     FOR NO KEY UPDATE OF l SKIP LOCKED\n  ),\n  renewed AS (\n    UPDATE public.engine_table_leases l\n       SET heartbeat_at = clock_timestamp()\n      FROM asked a, lockable k\n     WHERE l.table_id = a.id\n       AND k.table_id = l.table_id\n       AND l.instance_id = p_instance_id\n       AND l.protocol_version = 2\n       AND l.lease_generation = a.requested_generation\n       AND l.heartbeat_at >= clock_timestamp() - make_interval(\n         secs => public.fn_engine_lease_stale_seconds()\n       )\n    RETURNING l.table_id, l.lease_generation\n  )\n  SELECT a.id,\n         CASE\n           WHEN r.table_id IS NOT NULL THEN 'kept'\n           WHEN l.table_id IS NULL THEN 'missing'\n           WHEN l.heartbeat_at < clock_timestamp() - make_interval(\n             secs => public.fn_engine_lease_stale_seconds()\n           ) THEN 'stale'\n           WHEN l.instance_id = p_instance_id\n            AND l.protocol_version = 2\n            AND l.lease_generation = a.requested_generation THEN 'busy'\n           ELSE 'taken'\n         END,\n         l.lease_generation\n    FROM asked a\n    LEFT JOIN renewed r ON r.table_id = a.id\n    LEFT JOIN public.engine_table_leases l ON l.table_id = a.id;\nEND;\n$function$\n"}]$expected$::jsonb) LOOP
 SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'config',p.proconfig,'acl',p.proacl::text) INTO a FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(e->>'signature'));
 IF a IS DISTINCT FROM e THEN RAISE EXCEPTION '4375_POSTIMAGE: exact definition/owner/config/ACL drift'; END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=split_part(e->>'signature','(',1))<>1 THEN RAISE EXCEPTION '4375_POSTIMAGE: overload drift'; END IF;
END LOOP; END $guard$;

-- Explicit final ACL dependency.
DO $acl_guard$ DECLARE a jsonb; BEGIN
 SELECT jsonb_build_object('owner',pg_get_userbyid(relowner),'acl',relacl::text,'rls',relrowsecurity,'force',relforcerowsecurity) INTO a FROM pg_class WHERE oid='public.engine_table_leases'::regclass;
 IF a IS DISTINCT FROM $expected${"acl": "{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=rxtm/postgres}", "rls": true, "force": false, "owner": "postgres"}$expected$::jsonb THEN RAISE EXCEPTION 'ACL_POSTIMAGE: table metadata drift'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',attname,'acl',attacl::text) ORDER BY attnum) INTO a FROM pg_attribute WHERE attrelid='public.engine_table_leases'::regclass AND attnum>0 AND NOT attisdropped;
 IF a IS DISTINCT FROM $expected$[{"acl": null, "name": "table_id"}, {"acl": null, "name": "instance_id"}, {"acl": null, "name": "engine_version"}, {"acl": null, "name": "acquired_at"}, {"acl": null, "name": "heartbeat_at"}, {"acl": null, "name": "lease_generation"}, {"acl": null, "name": "protocol_version"}]$expected$::jsonb THEN RAISE EXCEPTION 'ACL_POSTIMAGE: column metadata drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('service_role','anon','authenticated')) THEN RAISE EXCEPTION 'ACL_APPLICATION_ROLE_PARENT_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated') AND rolsuper) THEN RAISE EXCEPTION 'ACL_APPLICATION_SUPERUSER_DRIFT'; END IF;
END $acl_guard$;
DO $effective$ DECLARE r text; c record; BEGIN
 FOREACH r IN ARRAY ARRAY['service_role','anon','authenticated'] LOOP
 IF has_table_privilege(r,'public.engine_table_leases','INSERT') OR has_table_privilege(r,'public.engine_table_leases','UPDATE') OR has_table_privilege(r,'public.engine_table_leases','DELETE') OR has_table_privilege(r,'public.engine_table_leases','TRUNCATE') THEN RAISE EXCEPTION 'EFFECTIVE_TABLE_MUTATION_REMAINS: %',r; END IF;
 FOR c IN SELECT attname FROM pg_attribute WHERE attrelid='public.engine_table_leases'::regclass AND attnum>0 AND NOT attisdropped LOOP
 IF has_column_privilege(r,'public.engine_table_leases',c.attname,'INSERT') OR has_column_privilege(r,'public.engine_table_leases',c.attname,'UPDATE') THEN RAISE EXCEPTION 'EFFECTIVE_COLUMN_MUTATION_REMAINS: % %',r,c.attname; END IF;
 END LOOP;
 END LOOP;
END $effective$;
