-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831081851; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE AGGRESSION FACTOR IS A POSTFLOP STATISTIC (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `horse_mind_stats.aggr / passive` counts EVERY street. The classic
-- Aggression Factor is postflop-only, and for a reason: preflop calling is
-- structurally normal (blinds, position, price), so folding it into the same
-- ratio drags a loose-preflop / hyper-aggressive-postflop player below the
-- 0.7 "passive" bar. `exploit()` then sets callDownMod = 0.85 — "passives get
-- respect" — and the horses fold MORE to the pot bets of the most aggressive
-- player at the table. Precisely backwards, and precisely the leak Dan found:
-- he could bet pot, pot, pot and take it down.
--
-- MEASURED, 58 live players with real samples (>=12 calls, >=8 postflop
-- calls), four hours of hands:
--     average AF as measured (all streets)   1.87
--     average AF postflop only               1.37
--     genuine maniacs read as normal            2
--     players mis-bucketed across a threshold   8   (10 of 58 = 17%)
--
-- Two additive counters. Nothing existing is rewritten, and the engine falls
-- back to the all-streets ratio until a player has >=10 postflop actions, so
-- a fresh opponent is never read from three hands of noise and the backfill
-- is simply "as the counters accumulate".
--
-- TIER 2: additive columns with defaults. No behaviour changes for any
-- existing row until the engine writes the new counters.

alter table public.horse_mind_stats
  add column if not exists post_aggr    integer not null default 0,
  add column if not exists post_passive integer not null default 0;

comment on column public.horse_mind_stats.post_aggr is
  'Bets/raises/full all-ins made POSTFLOP only. With post_passive this forms the true Aggression Factor; the all-streets aggr/passive pair misclassified 17% of sampled players across a decision threshold because preflop calling is structurally normal.';
comment on column public.horse_mind_stats.post_passive is
  'Calls made POSTFLOP only. Denominator of the true Aggression Factor.';

do $$
declare v_n integer;
begin
  select count(*) into v_n from information_schema.columns
   where table_schema='public' and table_name='horse_mind_stats'
     and column_name in ('post_aggr','post_passive');
  if v_n <> 2 then raise exception 'expected 2 new columns, found %', v_n; end if;

  -- additive only: every existing row must still be readable and defaulted
  select count(*) into v_n from public.horse_mind_stats
   where post_aggr is null or post_passive is null;
  if v_n <> 0 then raise exception '% rows have null counters', v_n; end if;
end $$;

-- ROLLBACK:
--   alter table public.horse_mind_stats
--     drop column if exists post_aggr, drop column if exists post_passive;
