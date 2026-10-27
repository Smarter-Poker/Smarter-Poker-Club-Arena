-- Captured production reader, source_md5 f4e69158a9d91027f0c6acc9f7aa3d1d.
-- Isolated fixture only; no production data.
CREATE OR REPLACE FUNCTION public.ca_club_data_export_page(p_export_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
    v_authorized := public.ca_can_view_whole_club_report(v_job.club_id);
  ELSIF v_job.kind = 'rake' AND v_job.scope_type = 'club' THEN
    v_authorized := public.ca_can_read_whole_club_production(v_job.club_id);
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
