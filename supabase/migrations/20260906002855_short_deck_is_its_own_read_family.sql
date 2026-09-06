-- SHORT DECK IS ITS OWN FAMILY (2026-09-05, V45.1)
--
-- horse_mind_stats_scoped keyed the read on `holdem|omaha` x table size, and
-- filed short deck under hold em because both deal two cards. Every frequency
-- in 6+ is different: strip the deuces through fives and VPIP runs near 50%
-- where full-deck hold em sits at 25%, because everyone connects with
-- everything. So 205,562 short-deck seat-hands a week were polluting the same
-- player's NLH read - the exact defect the scope exists to remove, with a
-- different pair of games than the one the audit named.
--
-- `sixplus` rather than `short`, so the family token can never be confused
-- with the table-size token in the same key.
--
-- The rows already written under holdem:* keep their data. They are a small
-- over-count on a bucket that only outranks the pooled read at 40 hands, and
-- they stop growing the moment the engine boots on this build.

alter table public.horse_mind_stats_scoped
  drop constraint if exists horse_mind_stats_scoped_scope_check;

alter table public.horse_mind_stats_scoped
  add constraint horse_mind_stats_scoped_scope_check
  check (scope ~ '^(holdem|omaha|sixplus):(hu|short|full)$');

-- The RPC's own guard has to agree with the constraint, or a sixplus row is
-- silently skipped by the flush rather than refused by the table.

create or replace function public.upsert_horse_mind_stats_scoped(rows jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; r jsonb;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(rows) loop
    continue when r->>'user_id' is null or length(r->>'user_id') = 0 or length(r->>'user_id') > 128;
    continue when r->>'scope' is null or (r->>'scope') !~ '^(holdem|omaha|sixplus):(hu|short|full)$';
    insert into public.horse_mind_stats_scoped as t
      (user_id, scope, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       river_bet_opps, river_bet_folds, checks, post_aggr, post_passive,
       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong, updated_at)
    values
      (r->>'user_id', r->>'scope',
       coalesce((r->>'hands')::integer, 0),
       coalesce((r->>'vpip')::integer, 0),
       coalesce((r->>'pfr')::integer, 0),
       coalesce((r->>'three_bet')::integer, 0),
       coalesce((r->>'aggr')::integer, 0),
       coalesce((r->>'passive')::integer, 0),
       coalesce((r->>'folds')::integer, 0),
       coalesce((r->>'faced_aggr')::integer, 0),
       coalesce((r->>'cbet_opps')::integer, 0),
       coalesce((r->>'cbet_folds')::integer, 0),
       coalesce((r->>'f3b_opps')::integer, 0),
       coalesce((r->>'f3b_folds')::integer, 0),
       coalesce((r->>'bigbet_sd')::integer, 0),
       coalesce((r->>'bigbet_sd_strong')::integer, 0),
       coalesce((r->>'river_bet_opps')::integer, 0),
       coalesce((r->>'river_bet_folds')::integer, 0),
       coalesce((r->>'checks')::integer, 0),
       coalesce((r->>'post_aggr')::integer, 0),
       coalesce((r->>'post_passive')::integer, 0),
       coalesce((r->>'snap_bet_sd')::integer, 0),
       coalesce((r->>'snap_bet_sd_strong')::integer, 0),
       coalesce((r->>'tank_bet_sd')::integer, 0),
       coalesce((r->>'tank_bet_sd_strong')::integer, 0),
       now())
    on conflict (user_id, scope) do update set
      hands = greatest(t.hands, excluded.hands),
      vpip = greatest(t.vpip, excluded.vpip),
      pfr = greatest(t.pfr, excluded.pfr),
      three_bet = greatest(t.three_bet, excluded.three_bet),
      aggr = greatest(t.aggr, excluded.aggr),
      passive = greatest(t.passive, excluded.passive),
      folds = greatest(t.folds, excluded.folds),
      faced_aggr = greatest(t.faced_aggr, excluded.faced_aggr),
      cbet_opps = greatest(t.cbet_opps, excluded.cbet_opps),
      cbet_folds = greatest(t.cbet_folds, excluded.cbet_folds),
      f3b_opps = greatest(t.f3b_opps, excluded.f3b_opps),
      f3b_folds = greatest(t.f3b_folds, excluded.f3b_folds),
      bigbet_sd = greatest(t.bigbet_sd, excluded.bigbet_sd),
      bigbet_sd_strong = greatest(t.bigbet_sd_strong, excluded.bigbet_sd_strong),
      river_bet_opps = greatest(t.river_bet_opps, excluded.river_bet_opps),
      river_bet_folds = greatest(t.river_bet_folds, excluded.river_bet_folds),
      checks = greatest(t.checks, excluded.checks),
      post_aggr = greatest(t.post_aggr, excluded.post_aggr),
      post_passive = greatest(t.post_passive, excluded.post_passive),
      snap_bet_sd = greatest(t.snap_bet_sd, excluded.snap_bet_sd),
      snap_bet_sd_strong = greatest(t.snap_bet_sd_strong, excluded.snap_bet_sd_strong),
      tank_bet_sd = greatest(t.tank_bet_sd, excluded.tank_bet_sd),
      tank_bet_sd_strong = greatest(t.tank_bet_sd_strong, excluded.tank_bet_sd_strong),
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.upsert_horse_mind_stats_scoped(jsonb) from public, authenticated, anon;
grant execute on function public.upsert_horse_mind_stats_scoped(jsonb) to service_role;
