-- ═══════════════════════════════════════════════════════════════════════════
-- A BEHAVIOUR NEEDS A STAGE TO HAPPEN ON (2026-09-06, third and final cut)
--
-- Dan, standing question: "there is absolutely no point to keep upgrading and
-- enhancing the logic of the horses, if nothing reads the tags."
--
-- The ledger closed the first half of that: every tag has a named consumer,
-- and fn_audit_data_receipts reports a receipt that never fires. This closes
-- the other half, which nothing was watching. A receipt can be zero for two
-- completely different reasons:
--
--   (a) the behaviour is broken or undeployed - already reported;
--   (b) THE SITUATION NEVER OCCURS. The code is correct, wired, deployed and
--       tested, and the world never presents the spot.
--
-- (b) found a live one the day this was written. V48's voluntary straddle
-- shipped 2026-09-05. The fleet stopped opening straddle tables on 09-02:
--
--   2026-09-01   5,831 tables created,  94 with straddle_enabled
--   2026-09-02   9,461 tables created,   0
--   2026-09-03  16,768 tables created,   0
--   2026-09-04  14,336 tables created,   0
--   2026-09-05  14,672 tables created,   0   <- the straddle shipped here
--   2026-09-06   5,575 tables created,   0
--
-- Three days BEFORE the behaviour shipped, and nothing connected those facts.
-- Without this the horse code would be blamed, re-read and found correct,
-- over and over.
--
-- TWO FAILED CUTS, and they are the point of this comment.
--
-- CUT 1 judged both "is there a stage" and "did the receipt fire". It accused
-- run-it-twice of being broken over a receipt name (v33_rit_decline) that I
-- invented and nothing has ever emitted - an innocent layer, accused nightly,
-- forever.
--
-- CUT 2 defended against that by requiring the receipt to have fired at least
-- once in history, and immediately accused ITSELF over v48_straddle_enrolled:
-- a real registered receipt that has never fired for exactly the reason this
-- function exists to report. A guard that cannot tell a fake name from a real
-- thing that never got a chance is not a guard.
--
-- The answer is that the function was doing two jobs. "Did the receipt fire"
-- belongs to fn_audit_data_receipts, which reads the registry and owns the
-- expectation. This step owns one question nothing else asks: is there a
-- table in the world where this could happen at all? If not, no amount of
-- reading the horse code will help. If so, this step says nothing.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_audit_behaviour_has_a_stage(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  r record;
begin
  for r in
    with live as (
      select
        count(*)                                                      as tables_live,
        count(*) filter (where coalesce(straddle_enabled, false))     as straddle,
        count(*) filter (where coalesce(nit_game, false))             as nit,
        count(*) filter (where game_variant = 'short_deck')           as short_deck,
        count(*) filter (where game_variant like 'plo%')              as omaha,
        count(*) filter (where coalesce(run_it_twice_enabled, false)) as rit
      from tables where status in ('active', 'waiting')
    ),
    checks(behaviour, stage_name, stage_count) as (
      select 'The voluntary straddle (V48)', 'live table with straddle_enabled', (select straddle from live)
      union all
      select 'The VPIP floor read (Dan 2026-09-04)', 'live table with nit_game', (select nit from live)
      union all
      select 'The short-deck hand classes (V46)', 'live short_deck table', (select short_deck from live)
      union all
      select 'The Omaha hand classes (V46)', 'live PLO table', (select omaha from live)
      union all
      select 'Declining run it twice', 'live table with run_it_twice_enabled', (select rit from live)
    )
    select c.behaviour, c.stage_name, c.stage_count, (select tables_live from live) as tables_live
      from checks c
     where c.stage_count = 0
  loop
    v := v || jsonb_build_object('severity','warn','category','schema','code','behaviour_has_no_stage',
      'title', r.behaviour || ' cannot happen: not one of ' || r.tables_live || ' live tables is a ' || r.stage_name,
      'evidence', jsonb_build_object('behaviour', r.behaviour, 'stage', r.stage_name,
                                     'stage_count', 0, 'tables_live', r.tables_live),
      'recommendation','The horse code is not the problem and must not be re-read for this. The FLEET is not opening a table this behaviour can happen at, so its receipt will read zero every night and every night it will look like a dead layer. Fix the table factory or the lobby mix and it starts firing on its own. Whether a behaviour that HAS a stage actually fires is fn_audit_data_receipts'' question, not this one.');
  end loop;

  return v;
end $function$;

revoke all on function public.fn_audit_behaviour_has_a_stage(date) from public, authenticated, anon;
grant execute on function public.fn_audit_behaviour_has_a_stage(date) to service_role;
