-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831133150; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PLAYER COMMAND PHASE 3: SECURITY + SCALE HARDENING (2026-08-31)
--
-- This migration tightens the existing role-shaped roster contract without
-- replacing it: ordinary members skip hierarchy/financial work, live seats use
-- indexable branches instead of an OR across two tables, searches are literal
-- and bounded, cursors are bound to their viewer/query context, and replayed
-- note writes return the same complete response as the original request.

DO $patch_roster_rows$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure)
    INTO v_definition;

  v_old := E'  v_union_staff boolean := false;\nBEGIN';
  v_new := E'  v_union_staff boolean := false;\n  v_needs_hierarchy boolean := false;\nBEGIN';
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ca_club_roster_rows hierarchy declaration drifted';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'  IF NOT v_service\n     AND NOT v_platform_admin\n     AND NOT v_union_staff';
  v_new := E'  v_needs_hierarchy := v_service OR v_platform_admin OR v_union_staff OR EXISTS (\n'
    '    SELECT 1 FROM public.club_members viewer\n'
    '     WHERE viewer.user_id = v_actor\n'
    '       AND viewer.club_id = ANY(v_scope)\n'
    '       AND viewer.role IN (''owner'', ''co_owner'', ''admin'', ''super_agent'', ''agent'', ''sub_agent'')\n'
    '       AND coalesce(viewer.status, ''approved'') IN (''active'', ''approved'')\n'
    '  );\n\n'
    '  IF NOT v_service\n     AND NOT v_platform_admin\n     AND NOT v_union_staff';
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ca_club_roster_rows access gate drifted';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := '    SELECT e.parent AS root, e.child AS descendant, 1 AS depth FROM edges e';
  v_new := '    SELECT e.parent AS root, e.child AS descendant, 1 AS depth FROM edges e WHERE v_needs_hierarchy';
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ca_club_roster_rows closure seed drifted';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'  seated AS MATERIALIZED (\n'
    '    SELECT DISTINCT ts.user_id AS uid\n'
    '      FROM public.table_seats ts\n'
    '      JOIN public.tables t ON t.id = ts.table_id\n'
    '     WHERE ts.left_at IS NULL\n'
    '       AND ts.user_id IS NOT NULL\n'
    '       AND t.status IN (''waiting'', ''running'')\n'
    '       AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))\n'
    '  ),';
  v_new := E'  seated AS MATERIALIZED (\n'
    '    SELECT DISTINCT live.uid\n'
    '      FROM (\n'
    '        SELECT ts.user_id AS uid\n'
    '          FROM public.table_seats ts\n'
    '          JOIN public.tables t ON t.id = ts.table_id\n'
    '         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL\n'
    '           AND ts.club_id = ANY(v_scope)\n'
    '           AND t.status IN (''waiting'', ''running'')\n'
    '        UNION\n'
    '        SELECT ts.user_id AS uid\n'
    '          FROM public.tables t\n'
    '          JOIN public.table_seats ts ON ts.table_id = t.id\n'
    '         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL\n'
    '           AND t.club_id = ANY(v_scope)\n'
    '           AND t.status IN (''waiting'', ''running'')\n'
    '      ) live\n'
    '  ),';
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ca_club_roster_rows seated block drifted';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_definition := replace(
    v_definition,
    '      JOIN base b ON b.m_user_id = cm.user_id',
    E'      JOIN base b ON b.m_user_id = cm.user_id\n      JOIN access ac ON ac.uid = cm.user_id AND ac.sensitive'
  );
  v_definition := replace(
    v_definition,
    '      JOIN base b ON b.m_user_id = a.user_id',
    E'      JOIN base b ON b.m_user_id = a.user_id\n      JOIN access ac ON ac.uid = a.user_id AND ac.sensitive'
  );
  v_definition := replace(
    v_definition,
    '      JOIN base b ON b.m_user_id = r.user_id',
    E'      JOIN base b ON b.m_user_id = r.user_id\n      JOIN access ac ON ac.uid = r.user_id AND ac.sensitive'
  );

  EXECUTE v_definition;
END
$patch_roster_rows$;

DO $patch_summary_seats$
DECLARE
  v_definition text;
  v_old text := E'  ), seated AS MATERIALIZED (\n'
    '    SELECT DISTINCT ts.user_id\n'
    '      FROM public.table_seats ts\n'
    '      JOIN public.tables t ON t.id = ts.table_id\n'
    '     WHERE ts.left_at IS NULL\n'
    '       AND ts.user_id IS NOT NULL\n'
    '       AND t.status IN (''waiting'', ''running'')\n'
    '       AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))\n'
    '  )';
  v_new text := E'  ), seated AS MATERIALIZED (\n'
    '    SELECT DISTINCT live.user_id\n'
    '      FROM (\n'
    '        SELECT ts.user_id\n'
    '          FROM public.table_seats ts\n'
    '          JOIN public.tables t ON t.id = ts.table_id\n'
    '         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL\n'
    '           AND ts.club_id = ANY(v_scope)\n'
    '           AND t.status IN (''waiting'', ''running'')\n'
    '        UNION\n'
    '        SELECT ts.user_id\n'
    '          FROM public.tables t\n'
    '          JOIN public.table_seats ts ON ts.table_id = t.id\n'
    '         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL\n'
    '           AND t.club_id = ANY(v_scope)\n'
    '           AND t.status IN (''waiting'', ''running'')\n'
    '      ) live\n'
    '  )';
BEGIN
  SELECT pg_get_functiondef('public.ca_club_members_summary(uuid)'::regprocedure)
    INTO v_definition;
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ca_club_members_summary seated block drifted';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$patch_summary_seats$;

DO $patch_page_contract$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.ca_club_members_page(uuid,text,text,text,jsonb,integer)'::regprocedure
  ) INTO v_definition;

  v_definition := replace(
    v_definition,
    'v_search text := lower(btrim(coalesce(p_search, '''')));',
    'v_search text := lower(left(btrim(coalesce(p_search, '''')), 120));'
  );

  v_old := E'  -- A cursor is an opaque server token, but it still crosses a hostile client\n';
  v_new := E'  -- A cursor belongs to one viewer, club and normalized query. A token from\n'
    '  -- another tab or saved view restarts safely instead of skipping rows.\n'
    '  IF v_cursor IS NOT NULL AND (\n'
    '    coalesce(v_cursor->>''v'', '''') <> ''2''\n'
    '    OR coalesce(v_cursor->>''club'', '''') <> p_club_id::text\n'
    '    OR coalesce(v_cursor->>''actor'', '''') <> coalesce(v_actor::text, ''service'')\n'
    '    OR coalesce(v_cursor->>''search'', '''') <> md5(v_search)\n'
    '    OR coalesce(v_cursor->>''filter'', '''') <> v_filter\n'
    '    OR coalesce(v_cursor->>''sort'', '''') <> v_sort\n'
    '  ) THEN\n'
    '    v_cursor := NULL;\n'
    '  END IF;\n\n'
    '  -- A cursor is an opaque server token, but it still crosses a hostile client\n';
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ca_club_members_page cursor preamble drifted';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_definition := replace(v_definition, 'lower(r.alias) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(r.alias)) > 0');
  v_definition := replace(v_definition, 'lower(r.username) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(r.username)) > 0');
  v_definition := replace(v_definition, 'lower(coalesce(r.player_number, '''')) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(coalesce(r.player_number, ''''))) > 0');
  v_definition := replace(v_definition, 'lower(coalesce(r.home_club_name, '''')) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(coalesce(r.home_club_name, ''''))) > 0');
  v_definition := replace(v_definition, 'lower(coalesce(r.upline_name, '''')) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(coalesce(r.upline_name, ''''))) > 0');

  v_old := E'      SELECT jsonb_build_object(\n        ''id'', l.user_id,';
  v_new := E'      SELECT jsonb_build_object(\n'
    '        ''v'', 2,\n'
    '        ''club'', p_club_id,\n'
    '        ''actor'', coalesce(v_actor::text, ''service''),\n'
    '        ''search'', md5(v_search),\n'
    '        ''filter'', v_filter,\n'
    '        ''sort'', v_sort,\n'
    '        ''id'', l.user_id,';
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ca_club_members_page next cursor drifted';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$patch_page_contract$;

DO $patch_export_contract$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.ca_club_members_export(uuid,text,text,text,uuid[])'::regprocedure
  ) INTO v_definition;
  v_definition := replace(v_definition,
    'v_search text := lower(btrim(coalesce(p_search, '''')));',
    'v_search text := lower(left(btrim(coalesce(p_search, '''')), 120));');
  v_definition := replace(v_definition, E'BEGIN\n  IF v_scope IS NULL',
    E'BEGIN\n  IF v_filter NOT IN (''all'', ''mine'', ''seated'', ''online'', ''agents'', ''admins'',\n'
    '    ''inactive_30'', ''inactive_60'', ''inactive_90'', ''high_fees'') THEN v_filter := ''all''; END IF;\n'
    '  IF v_sort NOT IN (''hierarchy'', ''activity'', ''name'', ''downlines'', ''wallet'', ''fees'') THEN v_sort := ''hierarchy''; END IF;\n'
    '  IF coalesce(array_length(p_user_ids, 1), 0) > 5000 THEN\n'
    '    RAISE EXCEPTION USING ERRCODE = ''22023'', MESSAGE = ''Select No More Than 5,000 Players Per Export'';\n'
    '  END IF;\n\n  IF v_scope IS NULL');
  v_definition := replace(v_definition, 'lower(r.alias) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(r.alias)) > 0');
  v_definition := replace(v_definition, 'lower(r.username) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(r.username)) > 0');
  v_definition := replace(v_definition, 'lower(coalesce(r.player_number, '''')) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(coalesce(r.player_number, ''''))) > 0');
  v_definition := replace(v_definition, 'lower(coalesce(r.home_club_name, '''')) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(coalesce(r.home_club_name, ''''))) > 0');
  v_definition := replace(v_definition, 'lower(coalesce(r.upline_name, '''')) LIKE ''%'' || v_search || ''%''',
    'position(v_search in lower(coalesce(r.upline_name, ''''))) > 0');
  EXECUTE v_definition;
END
$patch_export_contract$;

CREATE OR REPLACE FUNCTION public.ca_club_member_notes_update(
  p_club_id uuid,
  p_target_user_id uuid,
  p_nickname text,
  p_remark text,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_access text;
  v_member_club uuid;
  v_before_nickname text;
  v_before_remark text;
  v_after_nickname text := nullif(btrim(left(coalesce(p_nickname, ''), 64)), '');
  v_after_remark text := nullif(btrim(left(coalesce(p_remark, ''), 240)), '');
  v_actor_role text;
  v_request_id text := nullif(left(btrim(coalesce(p_request_id, '')), 128), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Member Note Updates Require An Auditable Actor';
  END IF;

  v_access := public.ca_club_roster_access(p_club_id, p_target_user_id);
  IF v_access NOT IN ('staff', 'downline', 'service') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'You Do Not Have Permission To Edit These Notes';
  END IF;

  IF v_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.audit_trail a
     WHERE a.actor_id IS NOT DISTINCT FROM v_actor
       AND a.action = 'update_member_notes'
       AND a.target_id = p_target_user_id
       AND a.club_id = p_club_id
       AND a.request_id = v_request_id
  ) THEN
    SELECT cm.nickname, cm.notes
      INTO v_after_nickname, v_after_remark
      FROM public.club_members cm
     WHERE cm.user_id = p_target_user_id AND cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
     LIMIT 1;
    RETURN jsonb_build_object(
      'success', true, 'replayed', true,
      'nickname', v_after_nickname, 'remark', v_after_remark
    );
  END IF;

  SELECT cm.club_id, cm.nickname, cm.notes
    INTO v_member_club, v_before_nickname, v_before_remark
    FROM public.club_members cm
   WHERE cm.user_id = p_target_user_id AND cm.club_id = ANY(v_scope)
     AND coalesce(cm.status, 'approved') IN ('active', 'approved')
   ORDER BY public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
   LIMIT 1 FOR UPDATE;

  IF v_member_club IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Member Not Found');
  END IF;

  PERFORM set_config('app.club_notes_update', 'on', true);
  UPDATE public.club_members
     SET nickname = v_after_nickname, notes = v_after_remark, updated_at = now()
   WHERE club_id = v_member_club AND user_id = p_target_user_id;
  PERFORM set_config('app.club_notes_update', '', true);

  SELECT cm.role INTO v_actor_role FROM public.club_members cm
   WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
   ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;

  INSERT INTO public.audit_trail (
    actor_id, actor_role, action, target_type, target_id, club_id,
    before_state, after_state, reason, request_id
  ) VALUES (
    v_actor, coalesce(v_actor_role, 'service_role'), 'update_member_notes',
    'club_member', p_target_user_id, p_club_id,
    jsonb_build_object(
      'nickname_present', v_before_nickname IS NOT NULL,
      'remark_present', v_before_remark IS NOT NULL,
      'nickname_length', length(coalesce(v_before_nickname, '')),
      'remark_length', length(coalesce(v_before_remark, ''))
    ),
    jsonb_build_object(
      'nickname_present', v_after_nickname IS NOT NULL,
      'remark_present', v_after_remark IS NOT NULL,
      'nickname_length', length(coalesce(v_after_nickname, '')),
      'remark_length', length(coalesce(v_after_remark, ''))
    ),
    'Authorized Member Note Update', v_request_id
  );

  RETURN jsonb_build_object(
    'success', true, 'replayed', false,
    'nickname', v_after_nickname, 'remark', v_after_remark
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_member_notes_update(uuid, uuid, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_notes_update(uuid, uuid, text, text, text)
  TO authenticated, service_role;

DO $verify$
DECLARE
  v_rows text := pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure);
  v_page text := pg_get_functiondef(
    'public.ca_club_members_page(uuid,text,text,text,jsonb,integer)'::regprocedure
  );
  v_export text := pg_get_functiondef(
    'public.ca_club_members_export(uuid,text,text,text,uuid[])'::regprocedure
  );
BEGIN
  IF position('WHERE v_needs_hierarchy' IN v_rows) = 0
     OR position('JOIN access ac ON ac.uid = r.user_id AND ac.sensitive' IN v_rows) = 0 THEN
    RAISE EXCEPTION 'role-shaped roster work was not gated';
  END IF;
  IF position('coalesce(v_cursor->>''actor''' IN v_page) = 0
     OR position('position(v_search in lower(r.alias))' IN v_page) = 0 THEN
    RAISE EXCEPTION 'page cursor/search contract was not hardened';
  END IF;
  IF position('Select No More Than 5,000 Players Per Export' IN v_export) = 0 THEN
    RAISE EXCEPTION 'export bound was not installed';
  END IF;
END
$verify$;

COMMENT ON FUNCTION public.ca_club_members_page(uuid, text, text, text, jsonb, integer) IS
  'Role-shaped keyset roster. Cursor v2 is bound to viewer, club, normalized search, filter and sort; stale or hostile cursors restart safely.';
COMMENT ON FUNCTION public.ca_club_member_notes_update(uuid, uuid, text, text, text) IS
  'Audited, idempotent member-note writer. Replays return the complete persisted note response and never duplicate the audit row.';

