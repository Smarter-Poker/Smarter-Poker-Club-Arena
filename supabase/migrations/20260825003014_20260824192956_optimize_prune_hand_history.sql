-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825003014; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_horse_window constant interval := interval '7 days';
  v_doomed uuid[];
  v_deleted int;
begin
  with candidates as (
    select id, players
      from public.hand_history
     where has_human is distinct from true
       and reported is not true
       and created_at < now() - v_horse_window
     order by created_at
     limit p_batch
     for update skip locked
  ),
  upd as (
    update public.hand_history h
       set has_human = case
             -- Unreadable or empty player list: cannot prove it was horses
             -- only, so keep it.
             when jsonb_typeof(c.players) is distinct from 'array' then true
             when jsonb_array_length(c.players) = 0 then true
             else exists (
               select 1
                 from jsonb_array_elements(c.players) e
                 left join public.profiles p
                        -- Only cast what IS a uuid. A malformed id yields NULL,
                        -- the join misses, and `p.id is null` counts it as a
                        -- person — the same fail-safe as an unknown account.
                        on p.id = (
                             case when length(e.value->>'userId') = 36
                                  then (e.value->>'userId')::uuid end
                           )
                where p.id is null            -- unknown/unparseable -> a person
                   or p.is_horse is not true  -- known, and not a horse
             )
           end
      from candidates c
     where h.id = c.id
     returning h.id, h.has_human
  )
  select array_agg(id) filter (where has_human is false) into v_doomed from upd;

  if v_doomed is null or cardinality(v_doomed) = 0 then
    return 0;
  end if;

  delete from public.hand_history where id = any(v_doomed);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;
