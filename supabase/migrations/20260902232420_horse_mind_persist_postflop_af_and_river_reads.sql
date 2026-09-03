-- ═══════════════════════════════════════════════════════════════════════════
-- THE POSTFLOP AGGRESSION FACTOR WAS NEVER SAVED (2026-09-02, horse brain audit)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260831081851 added `post_aggr` / `post_passive` to horse_mind_stats and
-- the engine has flushed them every five minutes since. But the flush goes
-- through `upsert_horse_mind_stats(rows jsonb)`, and that function was never
-- taught the two columns: its INSERT column list stops at bigbet_sd_strong,
-- so the values arrived in the payload and were dropped on the floor.
-- Verified before this migration: 0 of 996 rows carry a non-zero postflop
-- counter, while the newest row was written seconds ago.
--
-- The consequence is the one the 08-31 migration was written to remove.
-- HorseMind.exploit() reads the postflop ratio only once a player has >= 10
-- postflop actions and falls back to the all-streets ratio below that. The
-- engine restarts on every server deploy (several a day), the hydrate reads
-- zero, and every opponent starts over from the mis-classifying ratio - the
-- same "give the maniac's pot bets more respect" leak, restored at each boot.
--
-- Two more reads were memory-only BY DESIGN ("persistence can follow once the
-- league proves the read pays"): the V23 fold-to-river-bet frequency and the
-- V28 check counters behind the V18 self-image. Both have been live since
-- 2026-08-28/29; both reset to nothing on each deploy for exactly the players
-- the reads exist for (humans, who play a few hundred hands, not the fleet).
-- They are persisted here under the same GREATEST-monotonic merge.
--
-- TIER 2: additive columns with defaults + CREATE OR REPLACE of one function.
-- One transaction, one PostgREST schema reload (Production DDL policy).

begin;

alter table public.horse_mind_stats
  add column if not exists river_bet_opps  integer not null default 0,
  add column if not exists river_bet_folds integer not null default 0,
  add column if not exists checks          integer not null default 0,
  add column if not exists r_checks        real    not null default 0;

comment on column public.horse_mind_stats.river_bet_opps is
  'V23 river read: times this player faced a river bet or raise. Prices river bluffs and thin value against them.';
comment on column public.horse_mind_stats.river_bet_folds is
  'V23 river read: ... and folded to it.';
comment on column public.horse_mind_stats.checks is
  'V28: lifetime checks. Denominator of the V18 self-image (aggression over every action the table SAW).';
comment on column public.horse_mind_stats.r_checks is
  'V28: checks inside the exponentially-decayed recency window (half-life ~24 hands).';

create or replace function public.upsert_horse_mind_stats(rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  n integer := 0;
  r jsonb;
BEGIN
  IF rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
    CONTINUE WHEN r->>'user_id' IS NULL OR length(r->>'user_id') = 0 OR length(r->>'user_id') > 128;
    INSERT INTO public.horse_mind_stats AS t
      (user_id, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       post_aggr, post_passive, river_bet_opps, river_bet_folds, checks,
       r_hands, r_folds, r_faced_aggr, r_aggr, r_passive, r_checks, updated_at)
    VALUES
      (r->>'user_id',
       COALESCE((r->>'hands')::integer, 0),
       COALESCE((r->>'vpip')::integer, 0),
       COALESCE((r->>'pfr')::integer, 0),
       COALESCE((r->>'three_bet')::integer, 0),
       COALESCE((r->>'aggr')::integer, 0),
       COALESCE((r->>'passive')::integer, 0),
       COALESCE((r->>'folds')::integer, 0),
       COALESCE((r->>'faced_aggr')::integer, 0),
       COALESCE((r->>'cbet_opps')::integer, 0),
       COALESCE((r->>'cbet_folds')::integer, 0),
       COALESCE((r->>'f3b_opps')::integer, 0),
       COALESCE((r->>'f3b_folds')::integer, 0),
       COALESCE((r->>'bigbet_sd')::integer, 0),
       COALESCE((r->>'bigbet_sd_strong')::integer, 0),
       COALESCE((r->>'post_aggr')::integer, 0),
       COALESCE((r->>'post_passive')::integer, 0),
       COALESCE((r->>'river_bet_opps')::integer, 0),
       COALESCE((r->>'river_bet_folds')::integer, 0),
       COALESCE((r->>'checks')::integer, 0),
       COALESCE((r->>'r_hands')::real, 0),
       COALESCE((r->>'r_folds')::real, 0),
       COALESCE((r->>'r_faced_aggr')::real, 0),
       COALESCE((r->>'r_aggr')::real, 0),
       COALESCE((r->>'r_passive')::real, 0),
       COALESCE((r->>'r_checks')::real, 0),
       now())
    ON CONFLICT (user_id) DO UPDATE SET
      hands            = GREATEST(t.hands, EXCLUDED.hands),
      vpip             = GREATEST(t.vpip, EXCLUDED.vpip),
      pfr              = GREATEST(t.pfr, EXCLUDED.pfr),
      three_bet        = GREATEST(t.three_bet, EXCLUDED.three_bet),
      aggr             = GREATEST(t.aggr, EXCLUDED.aggr),
      passive          = GREATEST(t.passive, EXCLUDED.passive),
      folds            = GREATEST(t.folds, EXCLUDED.folds),
      faced_aggr       = GREATEST(t.faced_aggr, EXCLUDED.faced_aggr),
      cbet_opps        = GREATEST(t.cbet_opps, EXCLUDED.cbet_opps),
      cbet_folds       = GREATEST(t.cbet_folds, EXCLUDED.cbet_folds),
      f3b_opps         = GREATEST(t.f3b_opps, EXCLUDED.f3b_opps),
      f3b_folds        = GREATEST(t.f3b_folds, EXCLUDED.f3b_folds),
      bigbet_sd        = GREATEST(t.bigbet_sd, EXCLUDED.bigbet_sd),
      bigbet_sd_strong = GREATEST(t.bigbet_sd_strong, EXCLUDED.bigbet_sd_strong),
      post_aggr        = GREATEST(t.post_aggr, EXCLUDED.post_aggr),
      post_passive     = GREATEST(t.post_passive, EXCLUDED.post_passive),
      river_bet_opps   = GREATEST(t.river_bet_opps, EXCLUDED.river_bet_opps),
      river_bet_folds  = GREATEST(t.river_bet_folds, EXCLUDED.river_bet_folds),
      checks           = GREATEST(t.checks, EXCLUDED.checks),
      r_hands      = EXCLUDED.r_hands,
      r_folds      = EXCLUDED.r_folds,
      r_faced_aggr = EXCLUDED.r_faced_aggr,
      r_aggr       = EXCLUDED.r_aggr,
      r_passive    = EXCLUDED.r_passive,
      r_checks     = EXCLUDED.r_checks,
      updated_at   = now();
    n := n + 1;
  END LOOP;
  RETURN n;
END
$function$;

do $$
declare v_n integer;
begin
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'horse_mind_stats'
     and column_name in ('river_bet_opps', 'river_bet_folds', 'checks', 'r_checks');
  if v_n <> 4 then raise exception 'expected 4 new columns, found %', v_n; end if;

  -- the merge must now carry every persisted counter
  select count(*) into v_n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'upsert_horse_mind_stats'
     and pg_get_functiondef(p.oid) like '%post_aggr        = GREATEST%'
     and pg_get_functiondef(p.oid) like '%river_bet_folds  = GREATEST%';
  if v_n <> 1 then raise exception 'upsert_horse_mind_stats does not merge the new counters'; end if;
end $$;

commit;

-- ROLLBACK:
--   re-create upsert_horse_mind_stats from 20260822 horse_mind_stats_persistence
--   (the columns can stay; defaults keep every reader valid), then
--   alter table public.horse_mind_stats
--     drop column if exists river_bet_opps, drop column if exists river_bet_folds,
--     drop column if exists checks, drop column if exists r_checks;
