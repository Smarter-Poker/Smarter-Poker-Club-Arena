-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830211753; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-08-30 storage pass: ca_hand_player_idx never pruned - 18.6M rows,
-- 3.4GB, oldest 2026-05-21. Sampled 2,000 rows older than 14 days: ZERO still
-- point at an existing hand_history row. sp_prune_hand_history deletes
-- rake_attributions alongside each pruned hand but was never taught about
-- this index table, so every pruned hand strands its per-player index rows
-- forever.
--
-- Two changes:
--   1. sp_prune_hand_history now deletes ca_hand_player_idx rows for the
--      hands it prunes (same knob, same pass - identical to the
--      rake_attributions treatment).
--   2. sp_sweep_ca_hand_player_idx_orphans() drains the existing 12.5M-row
--      backlog in time-budgeted batches; safe to call repeatedly. It deletes
--      ONLY rows whose hand no longer exists, so nothing readable is lost -
--      these rows index nothing.
-- No horse/human distinction anywhere: rows die only because their hand is
-- already gone via the sanctioned retention policy.
-- ═══════════════════════════════════════════════════════════════════════════

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
         -- A HAND THAT HIT THE JACKPOT IS NEVER A CANDIDATE.
         -- bbj_payouts links to it only by (table_id, hand_number) and
         -- bbj_payouts.hand_id is always NULL, so a deleted hand is
         -- unrecoverable and fn_bbj_hand_detail goes dark for that winner
         -- permanently. See the header.
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
        from classified_src c
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
      -- WEIGHTED CONTRIBUTED RAKE (2026-08-29): the per-player rake ledger of
      -- a pruned horse-only hand goes with the hand. Same knob, same pass.
      delete from public.rake_attributions where hand_id = any(v_doomed);
      -- 2026-08-30: the per-player hand index goes with the hand too. This
      -- was missing, and 12.5M orphaned rows (3.4GB) accumulated since May.
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

-- Backlog sweeper: drains rows whose hand is already gone. Time-budgeted,
-- safe to call repeatedly from any maintenance context.
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
