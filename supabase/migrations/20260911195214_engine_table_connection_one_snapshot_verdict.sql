-- One indexed, stable database snapshot replaces repeated transport gate reads.
-- Existing scope semantics are retained. A lookup error cannot become a grant.
-- Service-role only: the engine supplies the identity from its verified JWT.
BEGIN;

CREATE FUNCTION public.fn_ca_engine_table_connection_access(p_table_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH facts AS MATERIALIZED (
    SELECT t.id, t.club_id, t.union_id, t.restrict_observers, t.ip_restriction,
      c.asset, c.is_platform, c.union_id AS club_union_id, c.is_union,
      COALESCE(t.union_id, t.club_id) AS scope_id,
      CASE
        WHEN t.club_id IS NULL AND t.union_id IS NOT NULL AND c.id IS NULL THEN true
        WHEN c.id = t.club_id AND c.asset = 'chips' AND c.is_platform = false THEN true
        WHEN c.id = t.club_id AND c.asset = 'diamonds' AND c.is_platform = true
          AND c.union_id IS NULL AND t.union_id IS NULL THEN true
        ELSE false
      END AS valid_arena,
      EXISTS (SELECT 1 FROM public.table_seats s
        WHERE s.table_id = t.id AND s.user_id = p_user_id AND s.left_at IS NULL) AS seated
    FROM public.tables t LEFT JOIN public.clubs c ON c.id = t.club_id
    WHERE t.id = p_table_id
  ), verdict AS (
    SELECT f.*,
      CASE
        WHEN p_user_id IS NULL OR NOT f.valid_arena OR f.scope_id IS NULL THEN 'check_failed'
        WHEN f.seated THEN 'seated'
        WHEN f.asset = 'diamonds' THEN
          CASE WHEN f.restrict_observers IS TRUE THEN 'observers_restricted' ELSE 'diamond_member' END
        WHEN EXISTS (SELECT 1 FROM public.club_members m
          WHERE m.user_id = p_user_id AND m.status IN ('active', 'approved')
            AND m.club_id = ANY(public.fn_club_scope_ids(f.scope_id))) THEN
          CASE WHEN f.restrict_observers IS TRUE THEN 'observers_restricted' ELSE 'club_member' END
        ELSE 'membership_required'
      END AS reason,
      EXISTS (SELECT 1 FROM public.blacklists b
        WHERE b.user_id = p_user_id AND (b.expires_at IS NULL OR b.expires_at > statement_timestamp())
          AND (b.club_id = f.club_id OR b.union_id IN
            (f.union_id, f.club_union_id, CASE WHEN f.is_union THEN f.club_id END))) AS banned
    FROM facts f
  )
  SELECT jsonb_build_object(
    'table_id', p_table_id, 'user_id', p_user_id,
    'allowed', COALESCE(v.reason IN ('seated', 'club_member', 'diamond_member'), false),
    'reason', COALESCE(v.reason, CASE WHEN p_table_id IS NULL OR p_user_id IS NULL
      THEN 'check_failed' ELSE 'table_not_found' END),
    'scope_id', v.scope_id, 'banned', COALESCE(v.banned, false),
    'ip_restricted', COALESCE(v.ip_restriction, false)
  ) FROM (VALUES (true)) AS one_row(present) LEFT JOIN verdict v ON true;
$function$;

ALTER FUNCTION public.fn_ca_engine_table_connection_access(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_engine_table_connection_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_table_connection_access(uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.fn_ca_engine_table_connection_access(uuid, uuid) IS
  'Engine-only, uncached connection verdict: arena, seat, scoped membership, observers, active bans and IP setting in one snapshot. No account or financial mutations.';
COMMIT;
