-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826193102; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- LAYER WATCH v2 (2026-08-26). Repo: supabase/migrations/20260826193038_audit_layer_watch_v17_v18.sql

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
      'severity', 'critical',
      'category', 'schema',
      'code', 'telemetry_dark',
      'title', 'Brain telemetry recorded ' || v_decides || ' decisions for ' || p_day,
      'evidence', jsonb_build_object('decide_fires', v_decides),
      'recommendation', 'Either BrainTelemetryFlush is not running (check engine logs for the flush service), the deploy predates telemetry, or the fleet was down. Nothing about layer health can be known for this day.'
    ));
  end if;

  for feat in
    select * from (values
      ('preflop_v7',          'critical', 'the V7 preflop engine - every preflop decision should route through it'),
      ('v15_nut_status',      'critical', 'V15 Omaha nut awareness - fires on every made flush/straight in PLO'),
      ('banded_mc_omaha',     'critical', 'Omaha banded equity (the reservoir sampler feeds this path)'),
      ('banded_mc_nlh',       'critical', 'NLH banded equity'),
      ('icm_real',            'warn',     'V16 real ICM - fires on tournament decisions when the context carries stacks+payouts'),
      ('v16_hu_overlay',      'warn',     'V16 heads-up overlay - fires whenever a pot is two-handed postflop'),
      ('v15_eq_capped',       'warn',     'V15 equity cap - fires when dominated hands face aggression'),
      ('v16_reads_cbet',      'warn',     'deep-read c-bet scaling - needs 10+ observed c-bet opportunities per opponent'),
      ('v16_sizecond_bigbet', 'warn',     'size-conditioned sampling - fires when a 20bb+ bet is on the newest street'),
      ('v17_pos_behind',      'warn',     'V17 positional pressure - fires whenever a bluff-band decision has 0 or 2+ live players behind'),
      ('v17_river_probe',     'warn',     'V17 river delayed probe - fires when a checked-through turn reaches a short-handed river'),
      ('v17_catch_block',     'warn',     'V17 call-side blocker - fires on big river bets with a missed front-door suit in hand'),
      ('v17_short_deck',      'warn',     'V17 short-deck overlay - fires on every short-deck postflop decision'),
      ('v18_straddle',        'warn',     'V18 straddle fix - fires when a straddled pot is re-read as unopened (straddle tables only)'),
      ('v18_self_image',      'warn',     'V18 self-image - fires when a horse''s own recent line moves its bluff volume'),
      ('v18_exploit_size',    'warn',     'V18 exploit-sized river raises - fires when a river value raise resizes to the opponent')
    ) as t(feature, severity, why)
  loop
    if not exists (
      select 1 from horse_brain_telemetry
      where day = p_day and feature = feat.feature and fires > 0
    ) then
      f := jsonb_build_object(
        'severity', feat.severity,
        'category', 'logic',
        'code', 'layer_silent',
        'title', 'Deployed layer ' || feat.feature || ' fired ZERO times',
        'evidence', jsonb_build_object('feature', feat.feature, 'decide_fires', v_decides, 'expectation', feat.why),
        'recommendation', 'The code is deployed but never executes at live tables. Find the gate that turned it off - flag defaults, wiring, or an upstream condition that can no longer be true.'
      );
      v_findings := v_findings || f;
    end if;
  end loop;

  return v_findings;
end $$;
