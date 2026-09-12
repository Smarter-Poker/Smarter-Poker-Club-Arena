-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906101611; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906101611   (the stamp IS the apply time, UTC: 2026-09-06 10:16:11)
--   name        the_stage_check_judges_only_the_stage
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4530 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906101611 IS ALREADY IN
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
-- THE STAGE CHECK JUDGES ONLY THE STAGE (2026-09-06)
--
-- Third and final cut, and the two failed ones are the point of the comment.
--
-- CUT 1 judged "stage exists but receipt is zero" as a horse bug. It reported
-- run-it-twice as broken. There is no receipt called v33_rit_decline - I
-- invented the name - so "fired 0 times" was true of something nothing has
-- ever written. An innocent layer, accused nightly, forever.
--
-- CUT 2 tried to defend against that by requiring the receipt to have fired
-- at least once in history. That immediately accused ITSELF over
-- v48_straddle_enrolled, which is a real registered receipt that has never
-- fired for the very reason this function exists to report: it has no stage.
-- A guard that cannot tell "fake name" from "real thing that never got a
-- chance" is not a guard.
--
-- The answer is that this function was doing two jobs. "Did the receipt fire"
-- is fn_audit_data_receipts' question, and that step reads the registry and
-- owns the expectation. THIS step owns exactly one question that nothing else
-- asks:
--
--     Is there a table in the world where this behaviour could happen at all?
--
-- If there is not, no amount of reading the horse code will help, and that is
-- the finding. If there is, this step says nothing and the receipt audit does
-- its own job. One question each.
--
-- The live one it exists for: the fleet stopped opening straddle tables on
-- 2026-09-02, three days BEFORE V48's voluntary straddle shipped on 09-05.
--
--   2026-09-01   5,831 tables created,  94 with straddle_enabled
--   2026-09-02   9,461 tables created,   0
--   ...
--   2026-09-06   5,575 tables created,   0
--
-- 278 live tables, none of them a stage for it.
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
