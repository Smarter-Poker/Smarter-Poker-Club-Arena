-- Exact body from World Hub20260903140000_ca_operator_approval_gate_is_exact.sql.
create or replace function public.fn_ca_operator_permissions(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_profile_role  text;
  v_is_legacy     boolean := false;
  v_enforce       boolean := false;
  v_legacy        text[]  := '{}';
  v_granted       text[]  := '{}';
  v_granted_roles text[]  := '{}';
  v_permissions   text[]  := '{}';
  v_roles         text[]  := '{}';
  v_source        text;
  v_floor         boolean := false;
begin
  if p_user_id is null then
    return jsonb_build_object(
      'role', null, 'roles', '[]'::jsonb, 'permissions', '[]'::jsonb,
      'source', 'none', 'admin_manage_floor', false
    );
  end if;

  select coalesce(pol.enforce_named_roles, false)
    into v_enforce
  from public.ca_operator_policy pol
  where pol.id
  limit 1;

  select p.role into v_profile_role
  from public.profiles as p
  where p.id = p_user_id
  limit 1;

  -- Only a role that exists in the table and is flagged legacy gets the
  -- automatic set. An unknown profiles.role contributes nothing.
  if v_profile_role is not null then
    select exists (
      select 1 from public.ca_operator_roles r
      where r.key = v_profile_role and r.is_legacy
    ) into v_is_legacy;

    select coalesce(array_agg(rp.permission order by rp.permission), '{}')
      into v_legacy
    from public.ca_operator_role_permissions rp
    join public.ca_operator_roles r on r.key = rp.role_key
    where r.key = v_profile_role
      and r.is_legacy;
  end if;

  select coalesce(array_agg(distinct rp.permission), '{}'),
         coalesce(array_agg(distinct g.role_key), '{}')
    into v_granted, v_granted_roles
  from public.ca_operator_grants g
  join public.ca_operator_role_permissions rp on rp.role_key = g.role_key
  where g.user_id = p_user_id
    and g.revoked_at is null;

  if v_enforce and array_length(v_granted_roles, 1) is not null then
    v_permissions := v_granted;
    v_roles       := v_granted_roles;
    v_source      := 'granted';
  else
    select coalesce(array_agg(distinct u.perm), '{}'::text[])
      into v_permissions
    from (
      select l.perm from unnest(v_legacy) as l(perm)
      union
      select g.perm from unnest(v_granted) as g(perm)
    ) u
    where u.perm is not null;

    select coalesce(array_agg(distinct y.role_key), '{}'::text[])
      into v_roles
    from (
      select v_profile_role as role_key
      where array_length(v_legacy, 1) is not null
      union
      select g.role_key from unnest(v_granted_roles) as g(role_key)
    ) y
    where y.role_key is not null;

    if array_length(v_legacy, 1) is not null and array_length(v_granted_roles, 1) is not null then
      v_source := 'both';
    elsif array_length(v_legacy, 1) is not null then
      v_source := 'legacy';
    elsif array_length(v_granted_roles, 1) is not null then
      v_source := 'granted';
    else
      v_source := 'none';
    end if;
  end if;

  -- THE RECOVERY HATCH (review finding H-4). An account whose
  -- profiles.role is a LEGACY role ALWAYS keeps admin.manage, whatever
  -- enforce_named_roles says and whatever grants it holds. Without this,
  -- granting a god `read_only` and flipping enforcement drops that god
  -- from 21 permissions to 6, admin.manage among the 15 lost, and
  -- admin.manage is the only permission that can flip enforcement back:
  -- the platform would be locked out of its own policy panel with direct
  -- SQL as the only way back in. This is purely ADDITIVE. It can widen a
  -- permission set and can never narrow one, so it cannot breach
  -- contract section 0, and it leaves `roles` and `source` describing
  -- exactly what was granted so the Staff tab still tells the truth.
  if v_is_legacy and not (coalesce(v_permissions, '{}'::text[]) @> array['admin.manage']) then
    v_permissions := coalesce(v_permissions, '{}'::text[]) || 'admin.manage'::text;
    v_floor := true;
  end if;

  -- NO AUDIT ROW IS WRITTEN HERE, DELIBERATELY. This is a READ, it runs
  -- on every console request behind a 30 second cache, and the route that
  -- called it already files one audit row for the request itself. See
  -- WHY PERMISSION RESOLUTION DOES NOT AUDIT ITSELF in 20260903120000.
  return jsonb_build_object(
    'role', v_profile_role,
    'roles', to_jsonb(coalesce(v_roles, '{}'::text[])),
    'permissions', to_jsonb(coalesce(v_permissions, '{}'::text[])),
    'source', v_source,
    -- Additive key. True when the line above put admin.manage back for a
    -- legacy account that enforcement would otherwise have stripped it
    -- from, so the console can say why it is there.
    'admin_manage_floor', v_floor
  );
end
$fn$;
