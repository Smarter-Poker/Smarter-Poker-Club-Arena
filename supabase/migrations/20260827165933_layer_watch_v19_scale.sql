-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827165933; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- LAYER WATCH: the branches the bet-ratio scale bug had killed (2026-08-27).
-- v16_reads_tell and v17_catch_block fired ZERO times across 700k decisions
-- because their gates needed a three-times-pot bet. They are now on the
-- honest scale and MUST start firing; if they do not, the repair failed and
-- this watch says so. v19_* are new stamps proving the previously dead
-- overbet and river-big-bet branches now execute.

create or replace function public.fn_audit_layer_silence(p_day date)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_findings jsonb := '[]'::jsonb;
  v_decides bigint;
  f jsonb;
  feat record;
begin
  select coalesce(sum(fires), 0) into v_decides
  from horse_brain_telemetry where day = p_day and feature = 'decide';

  if v_decides < 1000 then
    return jsonb_build_array(jsonb_build_object(
      'severity','critical','category','schema','code','telemetry_dark',
      'title','Brain telemetry recorded ' || v_decides || ' decisions for ' || p_day,
      'evidence', jsonb_build_object('decide_fires', v_decides),
      'recommendation','Either BrainTelemetryFlush is not running, the deploy predates telemetry, or the fleet was down. Nothing about layer health can be known for this day.'
    ));
  end if;

  for feat in
    select * from (values
      ('preflop_v7',          'critical','the V7 preflop engine - every preflop decision should route through it'),
      ('v15_nut_status',      'critical','V15 Omaha nut awareness - fires on every made flush/straight in PLO'),
      ('banded_mc_omaha',     'critical','Omaha banded equity (the reservoir sampler feeds this path)'),
      ('banded_mc_nlh',       'critical','NLH banded equity'),
      ('icm_real',            'warn','V16 real ICM - tournament decisions with stacks+payouts in context'),
      ('v16_hu_overlay',      'warn','V16 heads-up overlay - any two-handed postflop pot'),
      ('v15_eq_capped',       'warn','V15 equity cap - dominated hands facing aggression'),
      ('v16_reads_cbet',      'warn','deep-read c-bet scaling - needs 10+ observed c-bet opportunities'),
      ('v16_sizecond_bigbet', 'warn','size-conditioned sampling - a 20bb+ bet on the newest street'),
      ('v16_reads_f3b',       'warn','deep-read fold-to-3-bet scaling of the bluff 3-bet mix'),
      ('v16_reads_tell',      'warn','big-river-bet sizing tell - WAS DEAD until the 2026-08-27 scale fix; zero here means the repair did not take'),
      ('v17_pos_behind',      'warn','V17 positional pressure - 0 or 2+ live players behind in a bluff-band spot'),
      ('v17_river_probe',     'warn','V17 river delayed probe - checked-through turn into a short-handed river'),
      ('v17_catch_block',     'warn','V17 call-side blocker - WAS DEAD until the 2026-08-27 scale fix; zero here means the repair did not take'),
      ('v17_short_deck',      'warn','V17 short-deck overlay - every short-deck postflop decision'),
      ('v18_straddle',        'warn','V18 straddle fix - straddled pots re-read as unopened (straddle tables only)'),
      ('v18_self_image',      'warn','V18 self-image - a horse''s own recent line moving its bluff volume'),
      ('v18_exploit_size',    'warn','V18 exploit-sized river value raises'),
      ('v19_overbet_polarity','warn','overbet polarity respect - unreachable before the scale fix'),
      ('v19_river_bigbet_cap','warn','V15 river big-bet equity cap - unreachable before the scale fix')
    ) as t(feature, severity, why)
  loop
    if not exists (
      select 1 from horse_brain_telemetry
      where day = p_day and feature = feat.feature and fires > 0
    ) then
      v_findings := v_findings || jsonb_build_object(
        'severity', feat.severity,'category','logic','code','layer_silent',
        'title','Deployed layer ' || feat.feature || ' fired ZERO times',
        'evidence', jsonb_build_object('feature', feat.feature,'decide_fires', v_decides,'expectation', feat.why),
        'recommendation','The code is deployed but never executes at live tables. Find the gate that turned it off - flag defaults, wiring, an upstream condition that can no longer be true, or a threshold on the wrong scale.'
      );
    end if;
  end loop;

  return v_findings;
end $$;
revoke all on function public.fn_audit_layer_silence(date) from public;
grant execute on function public.fn_audit_layer_silence(date) to service_role;
