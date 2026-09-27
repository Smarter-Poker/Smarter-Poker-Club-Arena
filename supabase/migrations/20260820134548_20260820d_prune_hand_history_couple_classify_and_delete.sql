-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820134548 "20260820d_prune_hand_history_couple_classify_and_delete"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 afc96df8a98d308b5abaa2fe88f7d85a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════════
-- sp_prune_hand_history — classify and delete in ONE pass, no new index
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Supersedes 20260820c. Same policy (humans forever, horses 7 days, reported
-- hands never), fixed implementation.
--
-- THE BUG IN 20260820c: it classified a batch, then ran a SEPARATE delete
--
--     select id from hand_history
--      where has_human is false and created_at < now() - '7 days'
--        and reported is not true
--      order by created_at limit p_batch
--
-- `created_at` is an index condition but `has_human is false` is only a FILTER.
-- Whenever fewer than p_batch such rows exist — which is the normal state, since
-- the run that classifies them also deletes them — that scan walks the ENTIRE
-- remaining backlog looking for matches it will never find. Measured on the
-- live table: the first cron run took 24.2s (against 0.0-0.1s for the old
-- 90-day pruner), and the delete's SELECT alone did not finish inside 60s.
--
-- A partial index on (created_at) WHERE has_human IS FALSE would fix it, but
-- building one needs a full scan of a 10 GB table: CONCURRENTLY is the only
-- safe way and a cancelled client leaves an INVALID index behind (it did),
-- while a plain CREATE INDEX blocks hand_history inserts on a live room.
--
-- The index is not needed. The run that classifies a row is the run that should
-- delete it, so carry the ids straight through and delete BY PRIMARY KEY —
-- always fast, no scan, and nothing to maintain on the write path.
--
-- Two details that keep it correct across restarts:
--
--   * the candidate predicate is `has_human IS DISTINCT FROM true`, not
--     `IS NULL`. If a run ever dies between the update and the delete, the
--     orphaned has_human=false rows are the OLDEST rows in the table, so the
--     very next run picks them straight back up. There is no state that can be
--     stranded.
--   * `reported IS NOT TRUE` moved into the candidate predicate. A reported
--     hand is evidence and is never deleted, so it must also never be
--     classified — otherwise it would be re-updated every five minutes forever.
--
-- Human hands accumulate at the head of idx_hand_history_created and are
-- skipped by the filter. At the measured rate — 0.025% of hands have a human,
-- about 60 a day — that is ~22k rows a year to skip per run. Cheap, and if it
-- ever stops being cheap the fix is the partial index above, built properly.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_horse_window constant interval := interval '7 days';
  v_doomed uuid[];
  v_deleted int;
begin
  -- Classify the oldest unresolved rows and capture the horse-only ones.
  --
  -- A hand counts as human if ANY seat's userId is not a known horse,
  -- INCLUDING a userId with no profiles row at all. That direction is
  -- deliberate: anything we cannot positively identify as a horse is treated as
  -- a person, so this can only ever keep too much, never delete a player's
  -- history.
  with candidates as (
    select id, players
      from public.hand_history
     where has_human is distinct from true
       and reported is not true
       and created_at < now() - v_horse_window
     order by created_at
     limit p_batch
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
                        on p.id = nullif(e.value->>'userId','')::uuid
                where p.id is null            -- unknown account -> a person
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

  -- Primary-key deletes. No scan, no filter, no index to maintain.
  delete from public.hand_history where id = any(v_doomed);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

COMMENT ON FUNCTION public.sp_prune_hand_history(integer) IS
  'Retention for hand_history. A hand with any human seat is kept FOREVER; horse-only hands are deleted after 7 days; reported hands are never classified and never auto-deleted. One pass classifies the oldest unresolved batch and deletes the horse-only ones by primary key. Policy set by Dan 2026-08-20, replacing a flat 90 days that spent ~99.97% of its storage on horse-vs-horse hands while deleting real players history at 90 days.';
