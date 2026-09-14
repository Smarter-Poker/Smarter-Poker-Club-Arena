-- Exact live definition observed 2026-09-14T07:12:56Z, MD5 0cdb26a288d0d570f184de7f97747e1a.
CREATE OR REPLACE FUNCTION public.fn_ca_fleet_seat_touch(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare n int := 0; r jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    update public.ca_horse_fleet_state s
       set last_action_at = greatest(coalesce(s.last_action_at, 'epoch'::timestamptz),
                                     coalesce(nullif(r->>'at','')::timestamptz, now())),
           hands_this_session = case
             when s.table_id is not null and nullif(r->>'table_id','')::uuid is not null
                  and s.table_id <> nullif(r->>'table_id','')::uuid
             then coalesce((r->>'hands')::int, 0)
             else coalesce(s.hands_this_session, 0) + coalesce((r->>'hands')::int, 0) end,
           session_started_at = case
             when s.table_id is not null and nullif(r->>'table_id','')::uuid is not null
                  and s.table_id <> nullif(r->>'table_id','')::uuid
             then coalesce(nullif(r->>'at','')::timestamptz, now())
             else coalesce(s.session_started_at, nullif(r->>'at','')::timestamptz, now()) end,
           updated_at = now()
     where s.horse_id = nullif(r->>'horse_id','')::uuid;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $function$;
