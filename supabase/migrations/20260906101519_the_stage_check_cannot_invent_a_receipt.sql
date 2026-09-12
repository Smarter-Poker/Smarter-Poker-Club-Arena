-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906101519; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906101519   (the stamp IS the apply time, UTC: 2026-09-06 10:15:19)
--   name        the_stage_check_cannot_invent_a_receipt
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5741 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906101519 IS ALREADY IN
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
-- THE STAGE CHECK CANNOT INVENT A RECEIPT (2026-09-06)
--
-- On its first run the previous version reported:
--
--   "Run it twice (a horse may decline) has 53 table(s) to happen at and
--    fired 0 times on 2026-09-06"
--
-- which is a false alarm, and the cause is worth writing down because it is
-- the same class of mistake the whole detector exists to prevent. I added
-- that row naming a receipt `v33_rit_decline`. There is no such receipt. The
-- behaviour is real and tested (HorsesCanDeclineRunItTwice.test.ts) but it
-- emits no telemetry at all, so "fired 0 times" was true of a name nothing
-- has ever written.
--
-- A check that names a receipt nothing emits will report a horse bug every
-- single night, forever, and the horse will be innocent every single night.
-- So the check now verifies the NAME before it judges the count: a receipt
-- that has never appeared in horse_brain_telemetry in all of history is a
-- fault in THIS FUNCTION, and it says so, pointed at itself.
--
-- The run-it-twice row is removed rather than fixed, because the honest
-- finding underneath it is different and belongs in the backlog: a horse may
-- decline run it twice, and nothing anywhere records when it does.
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
        count(*) filter (where coalesce(straddle_enabled, false))     as straddle,
        count(*) filter (where coalesce(nit_game, false))             as nit,
        count(*) filter (where game_variant = 'short_deck')           as short_deck,
        count(*) filter (where game_variant like 'plo%')              as omaha
      from tables where status in ('active', 'waiting')
    ),
    fired as (
      select feature, sum(fires) as fires
        from horse_brain_telemetry where day = p_day group by feature
    ),
    -- Every receipt this estate has ever written, so a check cannot judge a
    -- name that nothing emits.
    known as (
      select distinct feature from horse_brain_telemetry
    ),
    checks(behaviour, receipt, stage_name, stage_count) as (
      select 'The voluntary straddle (V48)', 'v48_straddle_enrolled',
             'live table with straddle_enabled', (select straddle from live)
      union all
      select 'The VPIP floor read (Dan 2026-09-04)', 'vpip_floor',
             'live table with nit_game', (select nit from live)
      union all
      select 'The short-deck hand classes (V46)', 'decide_short_deck',
             'live short_deck table', (select short_deck from live)
      union all
      select 'The Omaha hand classes (V46)', 'v46_class_read',
             'live PLO table', (select omaha from live)
    )
    select c.behaviour, c.receipt, c.stage_name, c.stage_count,
           coalesce(f.fires, 0)                        as fires,
           (k.feature is not null)                     as receipt_is_real
      from checks c
      left join fired f on f.feature = c.receipt
      left join known k on k.feature = c.receipt
  loop
    if not r.receipt_is_real then
      -- Pointed at THIS FUNCTION, not at the horse.
      v := v || jsonb_build_object('severity','info','category','schema','code','stage_check_names_an_unknown_receipt',
        'title', 'The stage check names ' || r.receipt || ', which nothing has ever emitted',
        'evidence', jsonb_build_object('receipt', r.receipt, 'behaviour', r.behaviour),
        'recommendation','This is a fault in fn_audit_behaviour_has_a_stage, not in the brain. Either the behaviour emits no telemetry at all - in which case give it a receipt and register it in HorseDataLedger - or the name in this function is wrong. Until then it would report an innocent layer as broken every night.');
    elsif r.stage_count = 0 then
      v := v || jsonb_build_object('severity','warn','category','schema','code','behaviour_has_no_stage',
        'title', r.behaviour || ' cannot happen: there is no ' || r.stage_name,
        'evidence', jsonb_build_object('receipt', r.receipt, 'fires', r.fires,
                                       'stage', r.stage_name, 'stage_count', 0),
        'recommendation','The horse code is not the problem and must not be re-read for this. The FLEET is not opening a table this behaviour can happen at. Fix the table factory or the lobby mix and the receipt starts firing on its own. Do not tune, disable, or investigate the layer.');
    elsif r.fires = 0 then
      v := v || jsonb_build_object('severity','warn','category','logic','code','behaviour_has_a_stage_but_never_acts',
        'title', r.behaviour || ' has ' || r.stage_count || ' table(s) to happen at and fired 0 times on ' || p_day,
        'evidence', jsonb_build_object('receipt', r.receipt, 'fires', 0,
                                       'stage', r.stage_name, 'stage_count', r.stage_count),
        'recommendation','The stage exists and the behaviour did not happen, so this one IS the horse side: the layer is undeployed, gated off, or broken. Check the engine build against the commit that shipped it BEFORE reading the logic - on 2026-09-05 v44_second_look reported zero fires against 2.1M decisions and the cause was deploy lag, not a closed gate.');
    end if;
  end loop;

  return v;
end $function$;

revoke all on function public.fn_audit_behaviour_has_a_stage(date) from public, authenticated, anon;
grant execute on function public.fn_audit_behaviour_has_a_stage(date) to service_role;
