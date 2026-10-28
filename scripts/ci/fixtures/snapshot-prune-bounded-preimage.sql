CREATE OR REPLACE FUNCTION public.sp_prune_hand_state_snapshots(p_batch integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- A time budget, like sp_prune_hand_history: the cron gives this call a 30s
  -- statement_timeout, and a single 10,000-row delete measured 19-30s under
  -- load (2026-09-07). One over-budget statement rolls back WHOLE and deletes
  -- nothing, so the backlog would never drain. Rounds of 2,000 (~4-6s each)
  -- until 20s have passed keep the WHOLE call inside the cron's 30s, so it
  -- is never cut off - the rounds share one transaction; the budget is what
  -- protects it.
  v_budget   constant interval := interval '20 seconds';
  v_round    constant integer  := 250;
  v_deadline timestamptz := clock_timestamp() + v_budget;
  v_deleted  int := 0;
  v_n        int;
begin
  loop
    with doomed as (
      select s.id from smarter_private.horse_adaptive_disposal_certificates c
       join public.hand_state_snapshots s on s.table_id=c.table_id and s.hand_number=c.hand_number
       -- THE AGE BOUND IS READ BEFORE THE FUNCTION (2026-10-16).
       -- horse_snapshot_disposable refuses every snapshot created or updated
       -- in the last eight days, but as the only filter it ran once per
       -- snapshot row, every two minutes, across the whole table (2.8M rows,
       -- none old enough): 40 to 120 s a run, zero deletes, and the 2 min
       -- role timeout killed a third of the runs (PgCronFailuresElevated).
       -- The same bound, written where the planner can use
       -- idx_hand_state_snapshots_created_at, visits only rows the function
       -- could accept. Same clock (statement_timestamp), same answer.
       where s.created_at < statement_timestamp() - interval '8 days'
         and s.updated_at < statement_timestamp() - interval '8 days'
         and smarter_private.horse_snapshot_disposable(s.id)
         -- A completed snapshot can still be the only original witness for an
         -- interrupted hand. Its permit, not the age/completion bit, proves
         -- whether the owning hand transition has resolved that custody.
         and not exists (
           select 1 from smarter_private.f06_hand_permits p
            where p.table_id = s.table_id and p.hand_number = s.hand_number
              and p.state = 'reserved')
       order by created_at
       limit least(v_round, greatest(p_batch, 1))
    )
    delete from public.hand_state_snapshots h using doomed d where h.id = d.id AND smarter_private.horse_snapshot_disposable(h.id);
    get diagnostics v_n = row_count;
    v_deleted := v_deleted + v_n;
    exit when v_n = 0 or clock_timestamp() >= v_deadline;
  end loop;
  return v_deleted;
end
$function$;
