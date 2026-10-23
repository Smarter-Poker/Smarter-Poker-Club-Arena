-- 20261023214601_midway_tables_fill_full_for_the_lightning_test.sql
--
-- Dan 2026-10-23 16:35 CT: "make sure horses are added". The 50 + 50 fill
-- horses of 20261023213842 were eligible but the running fleet (74c1ff91)
-- held each Midway table at its drifting occupancy target, so Main 1 of the
-- two Lightning test games never filled and no feeder opened (the tick opens
-- one only when every open chair is taken). A club-scope occupancy bias of
-- 2.0 lifts every Midway table's target to full; who may sit is unchanged
-- (the 45-horse roster, and the fill horses only at their own game, by the
-- seat guard), so the rest of Midway fills fuller tables rather than more of
-- them (Dan: full tables). Every other policy field is left at its default.
-- The engine of 04:00 fills a Lightning fill game on its own; the bias row
-- can be removed after that release.

BEGIN;
set local lock_timeout = '5s';
insert into public.ca_horse_fleet_policy (scope, scope_id, occupancy_bias, notes, updated_by)
values ('club', 'fade0000-0000-0000-0000-000000000001', 2.0,
        'Dan 2026-10-23: Midway tables fill full so the Lightning test games (NLH and PLO4 0.25/0.50 Madness) reach their 50 horses',
        '47965354-0e56-43ef-931c-ddaab82af765')
on conflict (scope, scope_key) do update
   set occupancy_bias = excluded.occupancy_bias, notes = excluded.notes,
       updated_by = excluded.updated_by, updated_at = now();
do $chk$
begin
  if (public.fn_ca_fleet_policy_effective('fade0000-0000-0000-0000-000000000001')->>'occupancy_bias')::numeric <> 2.0 then
    raise exception 'Midway occupancy bias readback is not 2.0';
  end if;
end
$chk$;
COMMIT;
