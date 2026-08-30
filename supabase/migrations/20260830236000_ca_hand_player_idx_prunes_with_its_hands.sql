-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-08-30 storage pass: ca_hand_player_idx never pruned - 18.6M rows,
-- 3.4GB, oldest row 2026-05-21. Sampled 2,000 rows older than 14 days: ZERO
-- still pointed at an existing hand_history row. sp_prune_hand_history
-- deletes rake_attributions alongside each pruned hand but was never taught
-- about this index table, so every pruned hand stranded its per-player index
-- rows forever.
--
-- APPLIED TO PRODUCTION 2026-08-30 via the Supabase MCP as three migrations:
--   drop_duplicate_tournament_tickets_index   (advisor duplicate_index)
--   ca_hand_player_idx_hand_id_index          (delete-by-hand needs an index)
--   fix_prune_hand_history_cte_name_v2        (the function below; a first
--     version carried a CTE-name typo that plpgsql does not catch at CREATE
--     time - v2 includes a DO-block smoke run precisely so a function that
--     cannot execute cannot be applied)
-- The 12.5M-row orphan backlog was then drained with date-sliced deletes
-- guarded by NOT EXISTS(hand_history); 1,173 old rows remain and every one
-- of them points at a hand that still exists. This file records the final
-- state for the repo per RULE 2.
-- ═══════════════════════════════════════════════════════════════════════════

drop index if exists public.tournament_tickets_holder_idx;

create index if not exists idx_ca_hand_player_idx_hand_id
  on public.ca_hand_player_idx (hand_id);

create or replace function public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 returns integer
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_budget    constant interval := interval '20 seconds';
  v_deadline  timestamptz := clock_timestamp() + v_budget;
  v_days      integer;
  v_window    interval;
  v_doomed    uuid[];
  v_keepers   uuid[];
  v_deleted   integer := 0;
  v_round     integer;
begin
  select greatest(coalesce(horse_retention_days, 7), 1)
    into v_days
    from public.hand_history_retention_policy
   limit 1;

  if v_days is null then
    v_days := 7;
  end if;
  v_window := make_interval(days => v_days);

  loop
    v_doomed  := null;
    v_keepers := null;

    with candidates as (
      select hh.id, hh.players
        from public.hand_history hh
       where hh.has_human is distinct from true
         and hh.reported is not true
         and hh.created_at < now() - v_window
         and not exists (
               select 1
                 from public.bbj_payouts bp
                where bp.table_id = hh.table_id
                  and bp.hand_number = hh.hand_number
             )
       order by hh.created_at
       limit p_batch
       for update skip locked
    ),
    classified as (
      select c.id,
             case
               when jsonb_typeof(c.players) is distinct from 'array' then true
               when jsonb_array_length(c.players) = 0 then true
               else exists (
                 select 1
                   from jsonb_array_elements(c.players) e
                   left join public.profiles p
                          on p.id = (
                               case when length(e.value->>'userId') = 36
                                     and (e.value->>'userId') ~
                                         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                    then (e.value->>'userId')::uuid end
                             )
                  where p.id is null
                     or p.is_horse is not true
               )
             end as is_human
        from candidates c
    )
    select array_agg(id) filter (where is_human is false),
           array_agg(id) filter (where is_human is distinct from false)
      into v_doomed, v_keepers
      from classified;

    exit when v_doomed is null and v_keepers is null;

    if v_keepers is not null and cardinality(v_keepers) > 0 then
      update public.hand_history
         set has_human = true
       where id = any(v_keepers);
    end if;

    if v_doomed is not null and cardinality(v_doomed) > 0 then
      delete from public.rake_attributions where hand_id = any(v_doomed);
      -- 2026-08-30: the per-player hand index goes with the hand.
      delete from public.ca_hand_player_idx where hand_id = any(v_doomed);
      delete from public.hand_history where id = any(v_doomed);
      get diagnostics v_round = row_count;
      v_deleted := v_deleted + v_round;
    end if;

    exit when clock_timestamp() >= v_deadline;
  end loop;

  return v_deleted;
end
$function$;

-- Backlog sweeper for any orphans that reappear. Time-budgeted, deletes ONLY
-- rows whose hand no longer exists.
create or replace function public.sp_sweep_ca_hand_player_idx_orphans(p_batch integer default 50000)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_budget   constant interval := interval '25 seconds';
  v_deadline timestamptz := clock_timestamp() + v_budget;
  v_deleted  integer := 0;
  v_round    integer;
begin
  loop
    with doomed as (
      select i.ctid
        from public.ca_hand_player_idx i
       where i.created_at < now() - interval '14 days'
         and not exists (select 1 from public.hand_history h where h.id = i.hand_id)
       limit p_batch
    )
    delete from public.ca_hand_player_idx i using doomed d where i.ctid = d.ctid;
    get diagnostics v_round = row_count;
    v_deleted := v_deleted + v_round;
    exit when v_round = 0 or clock_timestamp() >= v_deadline;
  end loop;
  return v_deleted;
end
$function$;

revoke all on function public.sp_sweep_ca_hand_player_idx_orphans(integer) from public, anon, authenticated;
grant execute on function public.sp_sweep_ca_hand_player_idx_orphans(integer) to service_role;

-- POST-APPLY ASSERTION: the pruner must execute cleanly end-to-end.
do $$
declare r integer;
begin
  select public.sp_prune_hand_history(10) into r;
  raise notice 'sp_prune_hand_history smoke run deleted % rows', r;
end $$;
