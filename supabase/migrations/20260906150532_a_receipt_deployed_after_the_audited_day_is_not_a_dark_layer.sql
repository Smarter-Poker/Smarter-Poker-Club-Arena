-- 20260906150532_a_receipt_deployed_after_the_audited_day_is_not_a_dark_layer.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_audit_data_receipts judges every ledger receipt against the day it is
-- auditing. A receipt with zero fires and no history was reported as a
-- CRITICAL dark layer ("stays critical" - the first-day rule excused only a
-- receipt that had fired). That rule has a hole the size of the deploy
-- cadence: the audit runs the morning AFTER the day, against the ledger the
-- CURRENT engine synced at its last boot. So a layer that merged late on the
-- audited day and booted into it after midnight - or, as on 2026-09-05, into
-- the frozen :55 window five minutes before midnight - is registered in the
-- ledger, has zero fires on that day, and is reported dead.
--
-- MEASURED. The 2026-09-05 audit reported, critical:
--   v44_second_look fired 0 times against 2,121,841 decide (0.000%, ledger
--   expects >= 0.100%)
-- V44 shipped in #3198, whose engine build cut over at 23:55:30 UTC on
-- 2026-09-05 - inside the maintenance freeze, so it dealt nothing before the
-- day ended. On 2026-09-06 the same receipt fired 39,132 times by 14:00 UTC
-- (3.1% of decide). The layer was never dark; it was not yet deployed. One
-- agent read the finding as written, opened a PR to diagnose "a layer that
-- has never run once in production" (#3249), and the diagnosis was of a
-- deploy timestamp.
--
-- THE RULE NOW: a zero-fire receipt whose first telemetry EVER is on a day
-- AFTER p_day was deployed after the audited day. It is reported as info
-- (`receipt_deployed_after_day`) so the panel still shows the fact, and it is
-- judged from its first full day like any other new layer. A receipt with no
-- telemetry on ANY day, before or after, is still the dark layer the rule was
-- written for and stays critical - "it has never fired" is the one claim a
-- later fire cannot contradict.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

create or replace function public.fn_audit_data_receipts(p_day date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_findings jsonb := '[]'::jsonb;
  r record;
  v_fires bigint;
  v_denom bigint;
  v_ratio numeric;
  v_ledger_rows bigint;
  v_ledger_age interval;
  v_fresh boolean;
  v_table_exists boolean;
  v_prior_days bigint;
  v_first_later_day date;
begin
  select count(*), now() - max(updated_at) into v_ledger_rows, v_ledger_age
    from horse_data_ledger;

  -- The ledger itself is a datum. No rows = the engine never synced it;
  -- an old sync = the running brain is not the one the ledger describes.
  if v_ledger_rows = 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'critical', 'category', 'schema', 'code', 'data_ledger_missing',
      'title', 'horse_data_ledger is empty - the engine has not synced its contract',
      'evidence', jsonb_build_object('rows', 0),
      'recommendation', 'HorseDataLedgerSync runs at engine boot. Either the engine has not restarted since the ledger shipped or the sync is failing (horse_error_log / container logs, context HorseDataLedgerSync).');
    return v_findings;
  end if;

  -- ── receipts: did each layer fire its expected share? ────────────────
  for r in
    select l.key, split_part(l.key, ':', 2) as feature, l.consumer, l.ratio_of, l.min_ratio, l.note, l.since
      from horse_data_ledger l
     where l.kind = 'receipt'
     order by l.key
  loop
    v_fires := fn_ledger_fires(p_day, r.feature);
    if r.ratio_of is null then
      -- table-mix dependent: only a zero against a big day is worth a line
      continue;
    end if;
    v_denom := fn_ledger_fires(p_day, r.ratio_of);
    if v_denom < 1000 then
      continue; -- the denominator itself is too small to judge anything
    end if;
    v_ratio := v_fires::numeric / v_denom;
    -- ── A LAYER'S FIRST DAY IS A PARTIAL DAY (2026-09-05) ──
    -- V40 merged at 17:51 UTC on 2026-09-04 and this check reported
    -- v40_made_* at 4.982% of decide_omaha against a 5% floor: six hours of
    -- numerator over twenty-four hours of denominator. A receipt that has
    -- fired today and has NO telemetry row on any earlier day is on its first
    -- (partial) day and cannot be judged by a whole-day ratio; it is reported
    -- as info and judged tomorrow. Zero fires with no history is NOT excused:
    -- that is a layer that has never executed, and stays critical.
    if r.min_ratio is not null and v_ratio < r.min_ratio and v_fires > 0 then
      select count(distinct t.day) into v_prior_days
        from horse_brain_telemetry t
       where t.day < p_day and t.fires > 0
         and case when right(r.feature, 1) = '*'
                  then t.feature like replace(left(r.feature, length(r.feature) - 1), '_', '\_') || '%'
                  else t.feature = r.feature end;
      if v_prior_days = 0 then
        v_findings := v_findings || jsonb_build_object(
          'severity', 'info', 'category', 'logic', 'code', 'receipt_first_day',
          'title', r.feature || ' fired ' || v_fires || ' times on its first (partial) day - ratio not judged',
          'evidence', jsonb_build_object(
            'feature', r.feature, 'fires', v_fires, 'ratio_of', r.ratio_of, 'denominator', v_denom,
            'ratio', round(v_ratio, 6), 'min_ratio', r.min_ratio, 'consumer', r.consumer, 'since', r.since),
          'recommendation', 'The layer deployed during this day, so its fires cover part of the day and the denominator covers all of it. The ratio is judged from its first full day.');
        continue;
      end if;
    end if;
    -- ── A LAYER DEPLOYED AFTER THE AUDITED DAY IS NOT DARK (2026-09-06) ──
    -- Zero fires on p_day, no fires before it, but fires on a LATER day: the
    -- ledger row belongs to a build that cut over after this day closed (the
    -- audit reads the ledger the current engine synced, not the one that ran
    -- on p_day). v44_second_look, 2026-09-05: 0 fires, deployed 23:55:30 UTC
    -- into the freeze, 39,132 fires the next day. Info, and judged from its
    -- first full day. No telemetry on ANY day stays critical below.
    if r.min_ratio is not null and v_fires = 0 then
      select min(t.day) into v_first_later_day
        from horse_brain_telemetry t
       where t.day > p_day and t.fires > 0
         and case when right(r.feature, 1) = '*'
                  then t.feature like replace(left(r.feature, length(r.feature) - 1), '_', '\_') || '%'
                  else t.feature = r.feature end;
      if v_first_later_day is not null and not exists (
        select 1 from horse_brain_telemetry t
         where t.day <= p_day and t.fires > 0
           and case when right(r.feature, 1) = '*'
                    then t.feature like replace(left(r.feature, length(r.feature) - 1), '_', '\_') || '%'
                    else t.feature = r.feature end
      ) then
        v_findings := v_findings || jsonb_build_object(
          'severity', 'info', 'category', 'logic', 'code', 'receipt_deployed_after_day',
          'title', r.feature || ' fired 0 times on ' || p_day || ' - its first fire is ' || v_first_later_day || ', so it deployed after this day',
          'evidence', jsonb_build_object(
            'feature', r.feature, 'fires', 0, 'ratio_of', r.ratio_of, 'denominator', v_denom,
            'min_ratio', r.min_ratio, 'consumer', r.consumer, 'since', r.since,
            'first_fire_day', v_first_later_day),
          'recommendation', 'The ledger the audit read was synced by an engine that booted after this day ended. Nothing was dark on ' || p_day || '; the layer did not exist yet. It is judged from its first full day (' || v_first_later_day || ' is its partial first day).');
        continue;
      end if;
    end if;
    if r.min_ratio is not null and v_ratio < r.min_ratio then
      v_findings := v_findings || jsonb_build_object(
        'severity', case when v_fires = 0 then 'critical' else 'warn' end,
        'category', 'logic',
        'code', 'data_unread',
        'title', r.feature || ' fired ' || v_fires || ' times against ' || v_denom || ' ' || r.ratio_of ||
                 ' (' || round(v_ratio * 100, 3) || '%, ledger expects >= ' || round(r.min_ratio * 100, 3) || '%)',
        'evidence', jsonb_build_object(
          'feature', r.feature, 'fires', v_fires, 'ratio_of', r.ratio_of, 'denominator', v_denom,
          'ratio', round(v_ratio, 6), 'min_ratio', r.min_ratio, 'consumer', r.consumer, 'since', r.since),
        'recommendation', case when v_fires = 0
          then 'A registered consumer produced no receipt all day: the gate in front of ' || r.consumer || ' is closed (flag default, upstream condition, or the layer was removed without retiring its ledger row). Trace the gate in the source before touching the ratio.'
          else 'The consumer runs but far below the share the ledger expects. Either the fleet mix changed (then lower min_ratio in HorseDataLedger.ts with the evidence) or an upstream condition narrowed. ' || r.note end);
    end if;
  end loop;

  -- ── tables: is each nightly/boot source fresh? ───────────────────────
  for r in
    select l.key, split_part(l.key, ':', 2) as tbl, l.cadence, l.consumer, l.day_column, l.freshness_days
      from horse_data_ledger l
     where l.kind = 'table' and l.day_column is not null and l.freshness_days is not null
     order by l.key
  loop
    select exists (
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = r.tbl
    ) into v_table_exists;
    if not v_table_exists then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'critical', 'category', 'schema', 'code', 'data_stale',
        'title', 'Ledger table ' || r.tbl || ' does not exist',
        'evidence', jsonb_build_object('table', r.tbl),
        'recommendation', 'The ledger names a table the schema does not have. Either the migration was never applied or the ledger row is wrong.');
      continue;
    end if;
    -- freshness: any row whose day column is within freshness_days of p_day
    -- (timestamps and dates both cast to date).
    execute format(
      'select exists (select 1 from public.%I where (%I)::date >= %L::date - %s)',
      r.tbl, r.day_column, p_day, r.freshness_days
    ) into v_fresh;
    if not v_fresh then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'critical', 'category', 'schema', 'code', 'data_stale',
        'title', r.tbl || ' has no row within ' || r.freshness_days || ' day(s) of ' || p_day,
        'evidence', jsonb_build_object('table', r.tbl, 'day_column', r.day_column,
                                       'freshness_days', r.freshness_days, 'consumer', r.consumer, 'cadence', r.cadence),
        'recommendation', 'A source the brain or its compilers depend on stopped being written. ' || r.consumer || ' is reading stale memory. Find the writer (the ledger names the cadence) and its error log.');
    end if;
  end loop;

  return v_findings;
end
$function$;

-- Engine / audit telemetry, never a browser surface. CREATE OR REPLACE keeps
-- the ACL the 2026-09-04 migration set (postgres + service_role only); this
-- restates it so the file says what production has and the definer check can
-- read it. GRANT/REVOKE do not fire the schema-cache reload.
revoke all on function public.fn_audit_data_receipts(date) from public, anon, authenticated;
grant execute on function public.fn_audit_data_receipts(date) to service_role;

COMMIT;
