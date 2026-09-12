-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906095757; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906095757   (the stamp IS the apply time, UTC: 2026-09-06 09:57:57)
--   name        a_breather_that_never_ends_is_a_stranded_seat
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5274 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906095757 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_audit_breather_returns, public.fn_audit_seat_clock
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
-- A BREATHER THAT NEVER ENDS IS A STRANDED SEAT (2026-09-06)
--
-- V48's last behaviour: a horse that loses 100bb+ in one hand takes an orbit
-- off, through the same public sitOut() a human's button calls.
--
-- The failure mode is not the sit-out, it is the sit-back-in. That happens on
-- a setTimeout 75 seconds later, and a timeout does not survive a container
-- replacement - server/** merges deploy, so replacements are routine. A horse
-- whose breather started 30 seconds before a deploy sits out forever: the
-- seat is held, the table is a seat short, and NOTHING says so. That is the
-- shape this estate keeps finding, so it gets a detector on the day the
-- behaviour ships rather than the week after somebody notices.
--
-- v48_sit_back_in must track v48_sit_out_after_loss. A gap between them is a
-- horse stranded sitting out.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_audit_breather_returns(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  v_out bigint; v_in bigint; v_gap bigint; v_share numeric;
begin
  select coalesce(sum(fires) filter (where feature = 'v48_sit_out_after_loss'), 0),
         coalesce(sum(fires) filter (where feature = 'v48_sit_back_in'), 0)
    into v_out, v_in
    from horse_brain_telemetry where day = p_day;

  if v_out = 0 then
    -- Not a finding on its own: most horses are grinders by persona, and the
    -- fleet default is 0. fn_audit_data_receipts already reports a receipt
    -- that never fires against its declared expectation.
    return v;
  end if;

  v_gap := v_out - v_in;
  v_share := round(v_gap::numeric / v_out, 3);

  if v_share > 0.10 then
    v := v || jsonb_build_object(
      'severity', case when v_share > 0.25 then 'critical' else 'warn' end,
      'category', 'logic', 'code', 'breather_never_returned',
      'title', v_gap || ' of ' || v_out || ' horse breathers did not book the seat back in',
      'evidence', jsonb_build_object('day', p_day, 'sat_out', v_out, 'came_back', v_in,
                                     'gap', v_gap, 'share', v_share),
      'recommendation', 'The return is a 75-second setTimeout in ServerTableEngineSettlement.horsesTakeABreather, and a timeout does not survive a container replacement. A horse whose breather started just before a deploy holds its seat sitting out forever. Check the day''s engine deploys against the gap; if they line up, the return needs to be driven by the table loop rather than by a timer. A seat held by a horse that will never act is worse than a seat it never took.');
  else
    v := v || jsonb_build_object('severity','info','category','logic','code','breather_returns',
      'title', v_in || ' of ' || v_out || ' horse breathers ended and the seat came back',
      'evidence', jsonb_build_object('day', p_day, 'sat_out', v_out, 'came_back', v_in, 'gap', v_gap),
      'recommendation','A horse that loses a buy-in in one hand takes an orbit off, like a person. The pair must track; a gap is a stranded seat.');
  end if;
  return v;
end $function$;

revoke all on function public.fn_audit_breather_returns(date) from public, authenticated, anon;
grant execute on function public.fn_audit_breather_returns(date) to service_role;

-- Wired into the seat-clock step, which is where a reader already goes to ask
-- "is every horse seat actually doing something".
create or replace function public.fn_audit_seat_clock(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  v_seated int; v_fresh int;
begin
  select count(*), count(*) filter (where last_action_at > now() - interval '30 minutes')
    into v_seated, v_fresh
    from table_seats ts
    join profiles p on p.id = ts.user_id
   where p.is_horse = true and ts.user_id is not null;

  if v_seated > 50 and v_fresh::numeric / nullif(v_seated, 0) < 0.5 then
    v := v || jsonb_build_object('severity','warn','category','logic','code','seat_clock_stale',
      'title', (v_seated - v_fresh) || ' of ' || v_seated || ' seated horses have not acted in 30 minutes',
      'evidence', jsonb_build_object('seated', v_seated, 'fresh', v_fresh),
      'recommendation','last_action_at is stamped at settlement by HorseHandReview.touchHorseSeats. A seated horse that is not acting is either at a table that is not dealing or stranded sitting out - see the breather findings.');
  else
    v := v || jsonb_build_object('severity','info','category','logic','code','seat_clock',
      'title', v_fresh || ' of ' || v_seated || ' seated horses acted inside 30 minutes',
      'evidence', jsonb_build_object('seated', v_seated, 'fresh', v_fresh),
      'recommendation','The fleet is awake.');
  end if;

  -- A breather that never ends holds a seat, so it belongs to the same
  -- question a reader is already asking here.
  v := v || fn_audit_breather_returns(p_day);
  return v;
end $function$;

revoke all on function public.fn_audit_seat_clock(date) from public, authenticated, anon;
grant execute on function public.fn_audit_seat_clock(date) to service_role;
