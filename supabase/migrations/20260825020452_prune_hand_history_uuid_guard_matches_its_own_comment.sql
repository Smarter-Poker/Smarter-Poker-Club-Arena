-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825020452; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-25  sp_prune_hand_history: make the fail-safe actually fail safe.
--
-- The function documents its intent explicitly:
--
--     "Only cast what IS a uuid. A malformed id yields NULL, the join misses,
--      and `p.id is null` counts it as a person - the same fail-safe as an
--      unknown account."
--
-- The code did not do that. The guard was `length(e.value->>'userId') = 36`,
-- and a 36-character string that is not a UUID passes it and then throws
-- 22P02 on the ::uuid cast. Verified in production:
--
--     length('not-a-uuid-but-exactly-36-chars-long') = 36  ->  true
--     'not-a-uuid-but-exactly-36-chars-long'::uuid         ->  22P02
--
-- So instead of "yields NULL -> treated as a person -> hand is kept", a single
-- malformed 36-character id would abort the entire prune batch and take the
-- 10-minute cron job down with it, silently, until someone noticed
-- hand_history growing without bound.
--
-- Adding the regex behind the cheap length pre-filter makes the documented
-- behaviour the actual behaviour: malformed -> NULL -> join misses ->
-- p.id is null -> counted as a person -> the hand is KEPT, never deleted.
-- Erring toward keeping a hand is the correct direction for a destructive job.
--
-- Nothing else changes: same batch semantics, same FOR UPDATE SKIP LOCKED,
-- same return value.

CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
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
                        -- Only cast what IS a uuid. length() alone is NOT that
                        -- test - a 36-char non-uuid passes it and then throws
                        -- 22P02, killing the whole batch. length() stays as the
                        -- cheap pre-filter; the regex is what makes the cast
                        -- safe. A malformed id now genuinely yields NULL, the
                        -- join misses, and `p.id is null` counts it as a
                        -- person - the same fail-safe as an unknown account.
                        on p.id = (
                             case when length(e.value->>'userId') = 36
                                   and (e.value->>'userId') ~
                                       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
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
$fn$;
