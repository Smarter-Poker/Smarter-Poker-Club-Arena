-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906101306; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906101306   (the stamp IS the apply time, UTC: 2026-09-06 10:13:06)
--   name        a_behaviour_needs_a_stage_to_happen_on
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5376 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906101306 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_audit_behaviour_has_a_stage
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- A BEHAVIOUR NEEDS A STAGE TO HAPPEN ON (2026-09-06)
--
-- Dan, standing question: "there is absolutely no point to keep upgrading and
-- enhancing the logic of the horses, if nothing reads the tags."
--
-- The ledger closed the first half of that: every tag now has a named
-- consumer, and fn_audit_data_receipts reports a receipt that never fires.
-- This closes the OTHER half, which nothing was watching.
--
-- A receipt can be zero for two completely different reasons:
--
--   (a) the behaviour is broken or undeployed - fn_audit_data_receipts
--       already reports this as data_unread;
--   (b) THE SITUATION NEVER OCCURS. The code is correct, wired, deployed and
--       tested, and the world simply never presents the spot.
--
-- (b) found a live one the day this was written. V48's voluntary straddle
-- shipped 2026-09-05 - a horse had never posted one, the layer that reads a
-- straddled pot has existed since 2026-08-26, and the enrol is correct. It
-- has fired ZERO times, and it cannot fire, because:
--
--   2026-09-01   5,831 tables created,  94 with straddle_enabled
--   2026-09-02   9,461 tables created,   0
--   2026-09-03  16,768 tables created,   0
--   2026-09-04  14,336 tables created,   0
--   2026-09-05  14,672 tables created,   0   <- the straddle shipped here
--   2026-09-06   5,575 tables created,   0
--
-- The fleet stopped opening straddle tables on 2026-09-02, three days BEFORE
-- the behaviour shipped. Nothing anywhere connected those two facts, and
-- without this they would have stayed unconnected: the horse code would be
-- blamed, re-read, and found correct, over and over.
--
-- So: for each behaviour whose precondition is a TABLE SETTING, check that a
-- live table actually carries the setting. A behaviour with no stage is not a
-- horse bug and must not be reported as one.
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
        count(*)                                                          as tables_live,
        count(*) filter (where coalesce(straddle_enabled, false))         as straddle,
        count(*) filter (where coalesce(nit_game, false))                 as nit,
        count(*) filter (where game_variant = 'short_deck')               as short_deck,
        count(*) filter (where game_variant like 'plo%')                  as omaha,
        count(*) filter (where coalesce(run_it_twice_enabled, false))     as rit
      from tables where status in ('active', 'waiting')
    ),
    fired as (
      select feature, sum(fires) as fires
        from horse_brain_telemetry where day = p_day group by feature
    ),
    checks(behaviour, receipt, stage_name, stage_count) as (
      select 'the voluntary straddle (V48)', 'v48_straddle_enrolled',
             'a live table with straddle_enabled', (select straddle from live)
      union all
      select 'the VPIP floor read (Dan 2026-09-04)', 'vpip_floor',
             'a live table with nit_game', (select nit from live)
      union all
      select 'the short-deck hand classes (V46)', 'decide_short_deck',
             'a live short_deck table', (select short_deck from live)
      union all
      select 'the Omaha hand classes (V46)', 'v46_class_read',
             'a live PLO table', (select omaha from live)
    )
    select c.behaviour, c.receipt, c.stage_name, c.stage_count,
           coalesce(f.fires, 0) as fires
      from checks c left join fired f on f.feature = c.receipt
  loop
    if r.stage_count = 0 then
      v := v || jsonb_build_object('severity','warn','category','schema','code','behaviour_has_no_stage',
        'title', r.behaviour || ' cannot happen: there is no ' || r.stage_name,
        'evidence', jsonb_build_object('receipt', r.receipt, 'fires', r.fires,
                                       'stage', r.stage_name, 'stage_count', 0),
        'recommendation','The horse code is not the problem and must not be re-read for this. The FLEET is not opening a table this behaviour can happen at. Fix the table factory or the lobby mix; the receipt will start firing on its own. Do not tune, disable, or investigate the layer.');
    elsif r.fires = 0 then
      v := v || jsonb_build_object('severity','warn','category','logic','code','behaviour_has_a_stage_but_never_acts',
        'title', r.behaviour || ' has ' || r.stage_count || ' table(s) to happen at and fired 0 times on ' || p_day,
        'evidence', jsonb_build_object('receipt', r.receipt, 'fires', 0,
                                       'stage', r.stage_name, 'stage_count', r.stage_count),
        'recommendation','The stage exists and the behaviour did not happen, so this one IS the horse side: the layer is undeployed, gated off, or broken. Check the engine build against the commit that shipped it before reading the logic.');
    end if;
  end loop;

  return v;
end $function$;

revoke all on function public.fn_audit_behaviour_has_a_stage(date) from public, authenticated, anon;
grant execute on function public.fn_audit_behaviour_has_a_stage(date) to service_role;
