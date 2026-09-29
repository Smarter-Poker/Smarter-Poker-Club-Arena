-- Only the observed table may contribute to its current horse session.
DO $guard$
BEGIN
  IF to_regprocedure('public.fn_ca_fleet_seat_touch(jsonb)') IS NULL
     OR md5(pg_get_functiondef('public.fn_ca_fleet_seat_touch(jsonb)'::regprocedure))
        NOT IN ('0cdb26a288d0d570f184de7f97747e1a','81166657f0d13fe290b449037726dfb4') THEN
    RAISE EXCEPTION 'horse seat touch changed; requalify its current definition';
  END IF;
END $guard$;

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
           hands_this_session = coalesce(s.hands_this_session, 0) + coalesce((r->>'hands')::int, 0),
           session_started_at = coalesce(s.session_started_at, nullif(r->>'at','')::timestamptz, now()),
           updated_at = now()
     where s.horse_id = nullif(r->>'horse_id','')::uuid
       -- The fleet manager owns table identity. Delayed touches for a prior
       -- table cannot reset or add hands to the currently observed session.
       and s.table_id = nullif(r->>'table_id','')::uuid;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $function$;
REVOKE ALL ON FUNCTION public.fn_ca_fleet_seat_touch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_fleet_seat_touch(jsonb) TO service_role;
