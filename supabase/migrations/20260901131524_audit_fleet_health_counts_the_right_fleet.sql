-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901131524; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ===========================================================================
-- THE FLEET IS THE HORSES THAT ARE SUPPOSED TO PLAY (2026-09-01)
--
-- fn_audit_fleet_health counted `profiles where is_horse = true` as the fleet
-- and reported everyone who dealt no hands as idle. On 2026-08-31 that was
-- "417 of 1000 horses dealt no hands", severity CRITICAL, with a
-- recommendation to go and check the seeding cycles and the overlay guard.
--
-- MEASURED, splitting that 417 by horse_status:
--
--   available / both     200 horses    0 idle
--   available / cash     192 horses    0 idle
--   available / events   192 horses    1 idle
--   disabled  / both     142 horses  142 idle
--   disabled  / cash     137 horses  137 idle
--   disabled  / events   137 horses  137 idle
--
-- 416 of the 417 are DISABLED. They are idle because they are switched off,
-- which is the intended behaviour, and the finding was sending every reader
-- to investigate a seeder that is in fact doing its job: 583 of 584 available
-- horses dealt hands that day.
--
-- The open-seat check had the opposite failure. It compares raw open seats
-- against a fixed 150, so its meaning drifts with the size of the floor: at
-- 97 cash tables the threshold is nearly meaningless. Measured while writing
-- this, the real state was far worse than the number suggested - 97 tables,
-- 767 seats, 88 filled, ELEVEN PERCENT occupancy - and the finding still read
-- as a mild "156 open seats" warning. An occupancy ratio says the same thing
-- in a way that does not move when the table count does, and the evidence now
-- carries the supply arithmetic so the reader can see whether the constraint
-- is seeding or simply too few enabled horses for too many tables.
--
-- TIER 3. Rollback pasted at the foot. One transaction, per the production
-- DDL policy.
-- ===========================================================================
do $fix$
declare
  v_def text;
  v_old_fleet constant text :=
    'select count(*) into v_fleet from profiles where is_horse = true;';
  v_new_fleet constant text :=
    'select count(*) into v_fleet from profiles'
    || E'\n    where is_horse = true'
    || E'\n      and coalesce(horse_status, ''available'') <> ''disabled'';';
  v_old_seat constant text := 'if v_open_seats > 150 then';
  v_new_seat constant text :=
    'if v_seat_total > 0 and v_open_seats::numeric / v_seat_total > 0.45 then';
  v_old_decl constant text := '  v_open_seats int;';
  v_new_decl constant text :=
    '  v_open_seats int;'
    || E'\n  v_seat_total int;'
    || E'\n  v_seat_filled int;'
    || E'\n  v_avail_horses int;';
  v_old_calc constant text :=
    'select coalesce(sum(t.max_players) - sum(coalesce(s.n, 0)), 0) into v_open_seats';
  v_new_calc constant text :=
    'select coalesce(sum(t.max_players), 0), coalesce(sum(coalesce(s.n, 0)), 0),'
    || E'\n         coalesce(sum(t.max_players) - sum(coalesce(s.n, 0)), 0)'
    || E'\n    into v_seat_total, v_seat_filled, v_open_seats';
  v_old_ev constant text :=
    'jsonb_build_object(''open_seats'', v_open_seats)';
  v_new_ev constant text :=
    'jsonb_build_object(''open_seats'', v_open_seats, ''seats'', v_seat_total,'
    || E'\n        ''filled'', v_seat_filled,'
    || E'\n        ''pct_full'', round(100.0 * v_seat_filled / nullif(v_seat_total, 0), 1),'
    || E'\n        ''available_horses'', v_avail_horses)';
  v_old_title constant text :=
    'v_open_seats || '' open cash seats across the fleet''';
  v_new_title constant text :=
    'v_open_seats || '' of '' || v_seat_total || '' cash seats are empty ('' ||'
    || E'\n        round(100.0 * v_seat_filled / nullif(v_seat_total, 0), 1) || ''% full)''';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_audit_fleet_health';
  if v_def is null then
    raise exception 'fn_audit_fleet_health does not exist';
  end if;

  if position('coalesce(horse_status' in v_def) > 0 then
    raise notice 'fleet-health fixes already applied';
    return;
  end if;

  -- Every anchor must appear exactly once, or the function has drifted from
  -- what this migration was written against and a blind replace would be a
  -- guess. Refuse rather than guess.
  if position(v_old_fleet in v_def) = 0 then raise exception 'anchor missing: fleet count'; end if;
  if position(v_old_seat  in v_def) = 0 then raise exception 'anchor missing: seat threshold'; end if;
  if position(v_old_decl  in v_def) = 0 then raise exception 'anchor missing: declarations'; end if;
  if position(v_old_calc  in v_def) = 0 then raise exception 'anchor missing: seat calc'; end if;
  if position(v_old_ev    in v_def) = 0 then raise exception 'anchor missing: seat evidence'; end if;
  if position(v_old_title in v_def) = 0 then raise exception 'anchor missing: seat title'; end if;

  v_def := replace(v_def, v_old_decl,  v_new_decl);
  v_def := replace(v_def, v_old_fleet, v_new_fleet);
  v_def := replace(v_def, v_old_calc,  v_new_calc);
  v_def := replace(v_def, v_old_seat,  v_new_seat);
  v_def := replace(v_def, v_old_ev,    v_new_ev);
  v_def := replace(v_def, v_old_title, v_new_title);

  -- The available-horse count is read next to the seat arithmetic so the two
  -- numbers in the evidence come from the same instant.
  v_def := replace(
    v_def,
    v_new_calc,
    'select count(*) into v_avail_horses from profiles'
      || E'\n    where is_horse = true'
      || E'\n      and coalesce(horse_status, ''available'') <> ''disabled'';'
      || E'\n  ' || v_new_calc
  );

  execute v_def;
end
$fix$;

revoke all on function public.fn_audit_fleet_health(date) from public, anon, authenticated;
grant execute on function public.fn_audit_fleet_health(date) to service_role;

do $assert$
declare
  v_def text;
  v_findings jsonb;
  v_idle jsonb;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_audit_fleet_health';
  if position('coalesce(horse_status' in v_def) = 0 then
    raise exception 'POST-APPLY: the fleet count still includes disabled horses';
  end if;
  if position('v_seat_total' in v_def) = 0 then
    raise exception 'POST-APPLY: the seat occupancy ratio was not applied';
  end if;

  -- Behavioural assertion: on the day that produced the false alarm, the
  -- idle finding must now either be absent or count only enabled horses.
  v_findings := fn_audit_fleet_health('2026-08-31'::date);
  select f into v_idle
    from jsonb_array_elements(v_findings) f
   where f->>'code' = 'fleet_idle_share';
  if v_idle is not null and (v_idle->'evidence'->>'fleet')::int > 700 then
    raise exception
      'POST-APPLY: fleet still counted as % - disabled horses are still included',
      v_idle->'evidence'->>'fleet';
  end if;
end
$assert$;

-- ===========================================================================
-- ROLLBACK
-- ===========================================================================
-- The previous definition is the one created by the migration that last
-- touched fn_audit_fleet_health before 2026-09-01 (20260828f_wire_fleet_health
-- and its successors). To revert, re-run that migration's
-- CREATE OR REPLACE FUNCTION public.fn_audit_fleet_health(date) body verbatim,
-- then:
--   revoke all on function public.fn_audit_fleet_health(date)
--     from public, anon, authenticated;
--   grant execute on function public.fn_audit_fleet_health(date) to service_role;
-- No data is written by this function, so a revert loses nothing but the two
-- corrections above.
