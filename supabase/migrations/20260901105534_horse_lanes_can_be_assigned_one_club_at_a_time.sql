-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901105534; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_assign_horse_lanes() re-splits EVERY horse in the system. Deep Stack Society
-- needs its own 33 / 33 / 34 split without disturbing the horses in Club JAQK,
-- SHARK CLUB or Midway Union (Dan, binding: "do not touch anything for any horses
-- inside club jaqk, shark club or midway union").
--
-- Same construction as the global function -- exact by counting, ordered by
-- md5(id) so a horse keeps its lane across re-runs -- scoped to one club's bot
-- membership.
CREATE OR REPLACE FUNCTION public.fn_assign_horse_lanes_for_club(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare v_events int; v_cash int; v_total int; v_res jsonb;
begin
  if not fn_caller_is_engine() then
    raise exception 'fn_assign_horse_lanes_for_club is engine-only';
  end if;

  create temp table _lane_pool on commit drop as
    select p.id
      from profiles p
      join club_members cm on cm.user_id = p.id
     where cm.club_id = p_club_id
       and cm.is_bot
       and p.is_horse;

  select count(*) into v_total from _lane_pool;
  if v_total = 0 then
    return jsonb_build_object('club_id', p_club_id, 'total', 0, 'distribution', '{}'::jsonb);
  end if;

  v_events := floor(v_total * 0.33);
  v_cash   := floor(v_total * 0.33);

  with ordered as (
    select id, row_number() over (order by md5(id::text)) rn from _lane_pool
  ), lanes as (
    select id,
           case when rn <= v_events then 'events'
                when rn <= v_events + v_cash then 'cash'
                else 'both' end as lane
      from ordered
  )
  update profiles p
     set horse_profile = coalesce(p.horse_profile, '{}'::jsonb) || jsonb_build_object('lane', l.lane)
    from lanes l
   where p.id = l.id
     and coalesce(p.horse_profile->>'lane', '') is distinct from l.lane;

  select jsonb_object_agg(lane, n) into v_res from (
    select p.horse_profile->>'lane' lane, count(*) n
      from profiles p join _lane_pool lp on lp.id = p.id
     group by 1
  ) s;

  return jsonb_build_object('club_id', p_club_id, 'total', v_total, 'distribution', v_res);
end
$$;

REVOKE ALL ON FUNCTION public.fn_assign_horse_lanes_for_club(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_horse_lanes_for_club(uuid) TO service_role;
