-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902055158; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

with tiers(sb, bb, label) as (
  values (0.01::numeric, 0.02::numeric, '0.01/0.02'),
         (0.02, 0.05, '0.02/0.05'),
         (0.05, 0.10, '0.05/0.10'),
         (0.10, 0.25, '0.10/0.25'),
         (0.25, 0.50, '0.25/0.50')
),
variants(variant, disp, seats) as (
  values ('nlh','NLH',9),
         ('plo4','PLO4',8),
         ('plo5','PLO5',7),
         ('plo6','PLO6',6),
         ('plo8','PLO8',8),
         ('pineapple','Pineapple',8),
         ('short_deck','Short Deck',8),
         ('flh','FLH',9),
         ('flo8','FLO8',8)
)
insert into tables (
  club_id, union_id, name, game_type, game_variant, game_mode, stakes,
  small_blind, big_blind, min_buy_in, max_buy_in,
  max_players, current_players, status, is_private, is_template, is_deleted,
  rake_percent, rake_cap_bb, bbj_percent,
  ante, ante_bb, ante_enabled,
  straddle_enabled, enable_straddle, run_it_twice_enabled, insurance_enabled,
  wait_for_big_blind, restrict_device, gps_restriction,
  action_time_seconds, auto_start_players, game_length_hours,
  short_description
)
select
  'fade0000-0000-0000-0000-000000000001'::uuid,
  'fade0000-0000-0000-0000-000000000001'::uuid,
  v.disp || ' ' || t.label,
  'cash', v.variant, 'regular', t.label,
  t.sb, t.bb, round(t.bb * 40, 2), round(t.bb * 200, 2),
  v.seats, 0, 'waiting', false, false, false,
  -1, -1, 100,
  0, 0, false,
  false, true, false, true,
  true, true, true,
  15, 2, 12,
  ''
from tiers t cross join variants v
where not exists (
  select 1 from tables x
   where x.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
     and x.game_type = 'cash'
     and x.game_variant = v.variant
     and x.small_blind = t.sb and x.big_blind = t.bb
     and coalesce(x.is_deleted,false) = false
     and x.status in ('waiting','running')
);
