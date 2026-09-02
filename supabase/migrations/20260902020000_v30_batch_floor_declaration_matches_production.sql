-- ===========================================================================
--  THE REPO SAID 200. PRODUCTION SAYS 25. THE REPO WAS WRONG.
-- ===========================================================================
--
-- `origin/main` has been RED on server/src/services/GtoAggregationFloor.test.ts
-- since 2026-08-30, and it is red for a true reason:
--
--   the newest migration DECLARING the aggregator's batch clamp is
--   20260830053917_v30_revert_lateral_optimization_it_was_slower.sql, and it
--   declares `greatest(200, ...)` while GtoAggregationDriver sends 100.
--
-- That is exactly the clobber #1855 wrote the guard for. The lateral
-- optimization revert restored the whole function body from a copy predating
-- #1849 and carried the old floor back in with it. A floor above what the
-- driver sends silently rounds every call up to 200, which is the measured
-- timeout cliff: about 8 seconds, one call in three cancelled with 57014.
--
-- BUT PRODUCTION IS ALREADY CORRECT. Read live on 2026-09-02:
--
--   v_batch integer := greatest(25, least(5000, coalesce(p_batch, 1500)));
--
-- Somebody patched the live function surgically - reading `prosrc` and
-- replacing the text, which the guard's own comment calls the safe way to
-- touch this function while other agents are shipping to it - and never
-- recorded a declaration. So the database has been right and the repository
-- has been lying about it for three days, with the guard correctly shouting
-- about the lie and every server test run red because of it.
--
-- This migration is the repository catching up. The body below is
-- `pg_get_functiondef` of the LIVE function, byte for byte, so it is a no-op
-- against production: same signature, same body, same 25.
--
-- IT HAS DELIBERATELY NOT BEEN APPLIED BY HAND. There is nothing to change,
-- and the only effect would be a PostgREST schema reload - about 28 seconds on
-- this database, which 503s live traffic (CLAUDE.md's DDL policy, written
-- after the 2026-08-31 PGRST002 outage). It applies harmlessly on the next
-- migration push. What it fixes today is the record, and the guard.
--
-- If you are here because the guard is red again: check the LIVE function
-- first. The bug is only real if production disagrees with 25.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_aggregate_gto_street_next(p_street text, p_batch integer DEFAULT 1500)
 RETURNS TABLE(processed integer, new_last_id uuid, street_done boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
declare
  v_cur record;
  v_batch integer := greatest(25, least(5000, coalesce(p_batch, 1500)));
  v_max_id uuid;
  v_processed integer := 0;
begin
  if p_street not in ('turn', 'river') then
    raise exception 'fn_aggregate_gto_street_next handles turn/river only (got %)', p_street;
  end if;

  select * into v_cur from public.gto_agg_progress where street = p_street for update;
  if not found then
    raise exception 'no gto_agg_progress row for %', p_street;
  end if;
  if v_cur.done then
    return query select 0, v_cur.last_id, true;
    return;
  end if;

  create temp table if not exists tmp_agg30 (like public.gto_postflop_compact including all) on commit drop;
  -- TRUNCATE, not DELETE: PostgREST roles run with the safe-update guard,
  -- which refuses an unqualified DELETE (error 21000).
  truncate table tmp_agg30;

  with batch as (
    select s.id, s.game_type, s.stack_depth, s.scenario_hash, s.strategy_matrix
    from public.solved_spots_gold s
    where s.street = p_street
      and (v_cur.last_id is null or s.id > v_cur.last_id)
    order by s.id
    limit v_batch
  ),
  marked as (
    select (select b2.id from batch b2 order by b2.id desc limit 1) as max_id,
           (select count(*) from batch) as n
  ),
  src as (
    select
      b.id,
      case
        when b.game_type like '%cash%' then 'cash'
        when b.game_type like '%icm%' then 'tourney_icm'
        when b.game_type like 'spin%' then 'spin'
        else 'tourney_ev' end as fam,
      substring(b.scenario_hash from '_(UTG|MP|CO|BTN|SB|BB)_') as pos,
      case
        when b.stack_depth <= 12 then 10
        when b.stack_depth <= 30 then 20
        when b.stack_depth <= 60 then 40
        when b.stack_depth <= 110 then 80
        else 150 end as depth_bucket,
      public.fn_gto_texture_class_any(substring(b.scenario_hash from 'bb_(.*)$')) as tex,
      b.strategy_matrix->'frequencies' as freqs,
      b.strategy_matrix->'tree_lines' as tree_lines
    from batch b
    where b.strategy_matrix ? 'frequencies'
      and b.strategy_matrix ? 'tree_lines'
  ),
  roots as (
    select s.id, replace(l.line, 'r:0:', '') as act
    from src s, jsonb_array_elements_text(s.tree_lines) l(line)
    where l.line ~ '^r:0:[^:]+$'
    group by 1, 2
  ),
  rootbets as (
    select id,
           count(*) as nb,
           max((nullif(substr(act, 2), ''))::numeric) as mx
    from roots where act like 'b%' and substr(act, 2) ~ '^[0-9]+$'
    group by id
  ),
  handvals as (
    select s.id, s.fam, s.pos, s.depth_bucket, s.tex, r.act,
           h.key as hand, (h.value)::numeric as v
    from src s
    join roots r on r.id = s.id
    cross join lateral jsonb_each_text(s.freqs -> r.act) h
    where s.pos is not null and s.tex is not null
      and h.value ~ '^-?[0-9.eE+]+$'
  ),
  validated as (
    select id, hand, sum(v) as tot
    from handvals
    group by 1, 2
    having bool_and(v >= 0 and v <= 1.001)
       and sum(v) between 0.95 and 1.05
  ),
  normed as (
    select hv.id, hv.fam, hv.pos, hv.depth_bucket, hv.tex, hv.hand,
      case
        when hv.act = 'c' then 'check'
        when coalesce(rb.nb, 0) = 1 then
          case when (nullif(substr(hv.act, 2), ''))::numeric >= 100
            then 'bet_big' else 'bet_small' end
        when (nullif(substr(hv.act, 2), ''))::numeric >= rb.mx then 'bet_big'
        else 'bet_small'
      end as bucket,
      hv.v / va.tot as freq
    from handvals hv
    join validated va on va.id = hv.id and va.hand = hv.hand
    left join rootbets rb on rb.id = hv.id
  ),
  perhand as (
    select id, fam, pos, depth_bucket, tex, hand, bucket, sum(freq) as f
    from normed group by 1, 2, 3, 4, 5, 6, 7
  ),
  rowcounts as (
    select fam, pos, depth_bucket, tex, count(distinct id) as nrows
    from perhand group by 1, 2, 3, 4
  ),
  cellhand as (
    select fam, pos, depth_bucket, tex, hand, bucket, avg(f) as f
    from perhand group by 1, 2, 3, 4, 5, 6
  ),
  cells as (
    select c.fam, c.pos, c.depth_bucket, c.tex,
           jsonb_object_agg(c.hand, c.per_hand) as matrix,
           max(r.nrows)::integer as source_rows
    from (
      select fam, pos, depth_bucket, tex, hand,
             jsonb_object_agg(bucket, round(f, 4)) as per_hand
      from cellhand group by 1, 2, 3, 4, 5
    ) c
    join rowcounts r using (fam, pos, depth_bucket, tex)
    group by 1, 2, 3, 4
  ),
  ins as (
    insert into tmp_agg30 (street, game_family, position, depth_bucket, texture_class, facing,
                           hand_matrix, source_rows)
    select p_street, fam, pos, depth_bucket, tex, 'open', matrix, source_rows from cells
    returning 1
  )
  select coalesce((select max_id from marked), v_cur.last_id),
         coalesce((select n from marked), 0)
    into v_max_id, v_processed;

  insert into public.gto_postflop_compact as g
    (street, game_family, position, depth_bucket, texture_class, facing, hand_matrix, source_rows)
  select street, game_family, position, depth_bucket, texture_class, facing, hand_matrix, source_rows
  from tmp_agg30
  on conflict (street, game_family, position, depth_bucket, texture_class, facing) do update
     set hand_matrix = (
           select jsonb_object_agg(hand, merged) from (
             select coalesce(a.key, b.key) as hand,
               case
                 when a.value is null then b.value
                 when b.value is null then a.value
                 else (
                   select jsonb_object_agg(bk, round(
                     (coalesce((a.value->>bk)::numeric, 0) * g.source_rows
                      + coalesce((b.value->>bk)::numeric, 0) * excluded.source_rows)
                     / nullif(g.source_rows + excluded.source_rows, 0), 4))
                   from (
                     select distinct k as bk from (
                       select jsonb_object_keys(a.value) k
                       union select jsonb_object_keys(b.value) k
                     ) kk
                   ) bks
                 )
               end as merged
             from jsonb_each(g.hand_matrix) a
             full outer join jsonb_each(excluded.hand_matrix) b on a.key = b.key
           ) m
         ),
         source_rows = g.source_rows + excluded.source_rows,
         built_at = now();

  update public.gto_agg_progress
     set last_id = v_max_id,
         rows_done = rows_done + v_processed,
         done = (v_processed < v_batch),
         updated_at = now()
   where street = p_street;

  return query select v_processed, v_max_id, (v_processed < v_batch);
end;
$function$;

-- ===========================================================================
--  AND IT STAYS OUT OF REACH OF A BROWSER
-- ===========================================================================
--
-- The pre-push definer-authorization guard blocked this migration, correctly:
-- `fn_aggregate_gto_street_next` is SECURITY DEFINER, it writes
-- (`gto_postflop_compact`, `gto_agg_progress`), and it never calls auth.uid(),
-- auth.role() or auth.jwt() - so it cannot know who is asking.
--
-- Option 1 of the guard's three is the right one here. This is a batch
-- aggregation pass driven by `GtoAggregationDriver` on the server. Nobody in a
-- browser should ever call it.
--
-- Checked live on 2026-09-02 before writing this: anon FALSE, authenticated
-- FALSE, PUBLIC FALSE, service_role TRUE. Production is already correct, so
-- these two statements change nothing today.
--
-- They are here because CREATE OR REPLACE keeps whatever grants the function
-- already had, and a plain CREATE on a fresh database grants EXECUTE to PUBLIC
-- by default. Without them this migration is safe on the database it was
-- written against and opens the function to every browser on the next one that
-- replays it from empty. PUBLIC is named as well as the roles: revoking a role
-- while PUBLIC still holds the grant reads as a fix and does nothing.
--
-- GRANT/REVOKE are not in pgrst_ddl_watch's list, so neither line costs a
-- schema reload.
REVOKE ALL ON FUNCTION public.fn_aggregate_gto_street_next(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_aggregate_gto_street_next(text, integer)
  TO service_role;
