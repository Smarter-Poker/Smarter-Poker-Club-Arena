-- 20260919223032_the_health_watch_resolves_what_it_filed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (docs/DIAMOND-ACCOUNTING-ROADMAP.md phase 5 entry
-- condition; CLAUDE.md 10.86; docs/changelog/2026-09-19-the-health-watch-resolves-what-it-filed.md):
--
--   MEASURED IN PRODUCTION 2026-09-19. ca_diamond_incidents held 45 open rows with
--   severity 'critical', every one rule DR0:health_critical, written hourly by
--   fn_ca_diamond_health_watch between 2026-09-09 07:35 and 2026-09-11 15:35. Their
--   causes, read back from each row's detail: 36 rows name "rewards lost to expiry"
--   (horse rewards that expired unclaimed on 09-09 and 09-10), 9 name "trial balance",
--   8 name "money identity" (a -100 difference on 09-11) and 2 name "deploy gate". Every
--   one of those areas has read ok from fn_ca_diamond_health() since 09-11 16:35. Eight
--   DR11:trial_balance_break warnings from 09-11 (08:20 to 15:20, seven on register and
--   one on player_diamonds) were also still open with the trial balance at 0 on every
--   account since.
--
--   NOTHING RESOLVES A DR0 ROW. fn_ca_diamond_health_watch files and never writes
--   resolved_at; the only automatic resolution in the estate is the trial balance
--   watch's seven-day sweep, which touches info rows only. So a critical incident whose
--   cause cleared eight days ago reads, to every consumer, exactly like one whose cause
--   is still there. The programme's public-release condition is "no open critical
--   ca_diamond_incidents", the clean-day streak stands at eight, and these rows are the
--   only thing keeping the gate literally unmet. That is the 10.86 shape: a signal that
--   answers "critical" when what it knows is "was critical once".
--
--   THE FIX PUTS THE RESOLUTION WHERE THE FILING IS. The watch that files a row is the
--   watch that can say its cause has gone, because it is the one reading the source on
--   every tick. So:
--
--     1. ca_diamond_incidents gains a nullable `resolution` text column: the note that
--        says WHY a row was resolved and by what, so an automatic resolution is never
--        mistaken for a human ruling.
--     2. fn_ca_diamond_health_watch, after evaluating fn_ca_diamond_health() exactly as
--        it does today and filing exactly what it files today, resolves every open
--        DR0:health_critical row whose named areas are ALL no longer critical or unknown
--        on this tick, with a note naming each area and the status it read. A row with
--        any area still critical stays open. A row that names no area at all is left for
--        a person: nothing here can say what it was about.
--     3. fn_ca_diamond_trial_balance_watch, after filing exactly what it files today,
--        resolves every open DR11:trial_balance_break row whose account read difference
--        0 on this tick, and every open DR12:suspense_nonzero row when suspense reads 0.
--        An account that is still broken keeps its rows open.
--
--   NOTHING IS DELETED, NO OTHER RULE IS TOUCHED, AND THE CHIP ESTATE'S
--   financial_alerts IS NOT INVOLVED. The trial balance watch's existing housekeeping
--   (info rows resolved after seven days and removed after thirty) is reproduced
--   byte for byte; it is not widened to any other severity.
--
--   Both bodies are re-read from the live catalog first and their md5 pinned, so a
--   body another agent changed underneath stops this migration instead of being
--   overwritten. Neither function is on fn_ca_guard_watchlist() today; if either is by
--   the time this applies, its redefinition is declared through the estate's own door
--   so the guard watcher has nothing to say.
--
--   THE MIGRATION ENDS BY RUNNING ONE TICK OF EACH WATCH, so the 45 DR0 rows and the
--   8 DR11 rows are resolved by the deployed code with notes read from their own
--   detail, then asserts that no critical incident is left open. If an area IS critical
--   at apply time the tick files a fresh DR0 and the assertion refuses the migration,
--   which is the correct answer: the gate is not to be met by a migration.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. The bodies this migration starts from are the ones it read.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE v_hw text; v_tb text; v_type text;
BEGIN
  IF to_regprocedure('public.fn_ca_diamond_health_watch()') IS NULL
     OR to_regprocedure('public.fn_ca_diamond_trial_balance_watch()') IS NULL
     OR to_regprocedure('public.fn_ca_diamond_incident(text,text,uuid,numeric,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'a Diamond watch this migration redefines does not exist';
  END IF;
  v_hw := md5(pg_get_functiondef('public.fn_ca_diamond_health_watch()'::regprocedure));
  v_tb := md5(pg_get_functiondef('public.fn_ca_diamond_trial_balance_watch()'::regprocedure));
  IF v_hw <> '15a6122b49ba60123b73380da4b30e33' THEN
    RAISE EXCEPTION 'fn_ca_diamond_health_watch changed (md5 %); re-read it before redefining it', v_hw;
  END IF;
  IF v_tb <> 'b98e983f098449c22b26478657923b46' THEN
    RAISE EXCEPTION 'fn_ca_diamond_trial_balance_watch changed (md5 %); re-read it before redefining it', v_tb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ca_diamond_incidents' AND column_name = 'resolved_at') THEN
    RAISE EXCEPTION 'ca_diamond_incidents has no resolved_at column';
  END IF;
  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ca_diamond_incidents' AND column_name = 'resolution';
  IF v_type IS NOT NULL AND v_type <> 'text' THEN
    RAISE EXCEPTION 'ca_diamond_incidents.resolution exists with type %, not text', v_type;
  END IF;
END $preflight$;

-- ---------------------------------------------------------------------------
-- 1. The note. A resolved row says why and by what.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_diamond_incidents ADD COLUMN IF NOT EXISTS resolution text;
COMMENT ON COLUMN public.ca_diamond_incidents.resolution IS
  'Why the row was resolved and by what. An automatic resolution starts with "auto:" and names the cause it read; a human ruling says who ruled. NULL while the row is open.';

-- ---------------------------------------------------------------------------
-- 2. The health watch resolves what it filed once every named area has cleared.
--    Everything above the resolution is the body that was live, verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_health_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_bad integer; v_detail jsonb; v_read integer; v_bad_areas text[]; v_statuses jsonb; v_resolved integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_diamond_health_watch: service_role required';
  END IF;

  -- `unknown` counts as bad. An area that could not be read is not an area that is fine, and the
  -- whole point of giving health an `unknown` status was that somebody would act on it.
  -- The report is read ONCE; the same pass keeps every area's status for the resolution below.
  SELECT count(*) FILTER (WHERE h.status IN ('critical', 'unknown')),
         COALESCE(jsonb_agg(jsonb_build_object('area', h.area, 'status', h.status, 'detail', h.detail))
                    FILTER (WHERE h.status IN ('critical', 'unknown')), '[]'::jsonb),
         count(*),
         COALESCE(array_agg(h.area) FILTER (WHERE h.status IN ('critical', 'unknown')), ARRAY[]::text[]),
         COALESCE(jsonb_object_agg(h.area, h.status), '{}'::jsonb)
    INTO v_bad, v_detail, v_read, v_bad_areas, v_statuses
    FROM public.fn_ca_diamond_health() h;

  IF v_bad > 0 THEN
    PERFORM public.fn_ca_diamond_incident(
      'DR0:health_critical', 'critical', NULL, NULL, 'fn_ca_diamond_health_watch',
      jsonb_build_object('areas', v_bad, 'detail', v_detail));
  END IF;

  -- A DR0 ROW CANNOT OUTLIVE ITS CAUSE (2026-09-19). The row records the areas that were critical
  -- in detail->'detail'; once EVERY one of them reads something other than critical or unknown on
  -- this tick, the row is resolved with a note naming each area and what it read. One area still
  -- critical keeps the whole row open. A row naming no area is left for a person, and a report
  -- that came back with no rows at all clears nothing (CLAUDE.md 10.86: a report that vanished is
  -- not a report that read ok). Nothing is deleted and no other rule is touched: this is the
  -- watch closing its own filings, only.
  IF v_read = 0 THEN
    RETURN v_bad;
  END IF;
  UPDATE public.ca_diamond_incidents i
     SET resolved_at = now(),
         resolution = 'auto: ' || (
           SELECT string_agg(format('area %s read %s', d->>'area', COALESCE(v_statuses->>(d->>'area'), 'absent from the report')), '; ')
             FROM jsonb_array_elements(i.detail->'detail') d)
           || ' at ' || now()::text
   WHERE i.rule = 'DR0:health_critical' AND i.resolved_at IS NULL
     AND jsonb_typeof(i.detail->'detail') = 'array'
     AND jsonb_array_length(i.detail->'detail') > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.detail->'detail') d
                      WHERE d->>'area' = ANY (v_bad_areas));
  GET DIAGNOSTICS v_resolved = ROW_COUNT;
  IF v_resolved > 0 THEN
    RAISE NOTICE 'fn_ca_diamond_health_watch: resolved % DR0:health_critical row(s) whose areas have cleared', v_resolved;
  END IF;

  RETURN v_bad;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_health_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_health_watch() TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The trial balance watch resolves a break once its account reads 0 and a
--    suspense row once suspense reads 0. Everything else is the live body,
--    verbatim, including the seven-day and thirty-day info housekeeping. The
--    search_path gains pg_temp, which every SECURITY DEFINER in this estate pins.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_since timestamptz := now() - interval '1 hour';
  v_filed integer := 0; v_rows integer := 0; v_broken text := '';
  v_clean text[] := ARRAY[]::text[]; v_suspense_zero boolean := false; v_resolved integer;
BEGIN
  FOR r IN SELECT * FROM public.fn_ca_diamond_trial_balance(v_since) LOOP
    v_rows := v_rows + 1;
    IF r.account IN ('player_diamonds', 'diamond_house', 'register') AND r.difference IS NOT NULL AND abs(r.difference) > 0 THEN
      -- Ruling 13 (docs/DIAMOND-RULINGS.md): a break over 1,000 diamonds in one hour is critical and
      -- pages; opening the diamond_issuance freeze stays a human act.
      PERFORM public.fn_ca_diamond_incident('DR11:trial_balance_break',
        CASE WHEN abs(r.difference) > 1000 THEN 'critical' ELSE 'warning' END, NULL, r.difference, r.account,
        jsonb_build_object('account', r.account, 'balance_now', r.balance_now, 'balance_delta', r.balance_delta,
                           'journal_net', r.journal_net, 'mint_net', r.mint_net, 'difference', r.difference,
                           'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1; v_broken := v_broken || r.account || ' ';
    END IF;
    -- An account that reads difference 0 on this tick has no open break: remember it. NULL is
    -- "could not be read" and clears nothing (CLAUDE.md 10.86).
    IF r.difference IS NOT NULL AND r.difference = 0 THEN
      v_clean := v_clean || r.account;
    END IF;
    IF r.account = 'fixture_accounts' AND r.difference IS NOT NULL AND abs(r.difference) > 0 THEN
      PERFORM public.fn_ca_diamond_incident('DR6:fixture_harness_unregistered_movement', 'info', NULL, r.difference,
        'fn_ca_diamond_trial_balance_watch',
        jsonb_build_object('balance_delta', r.balance_delta, 'mint_net', r.mint_net, 'window_start', v_since, 'note', r.note));
    END IF;
    IF r.account = 'suspense' AND COALESCE(r.balance_now, 0) <> 0 THEN
      PERFORM public.fn_ca_diamond_incident('DR12:suspense_nonzero', 'info', NULL, r.balance_now, 'fn_ca_diamond_trial_balance_watch',
        jsonb_build_object('suspense', r.balance_now, 'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1;
    END IF;
    IF r.account = 'suspense' AND r.balance_now IS NOT NULL AND r.balance_now = 0 THEN
      v_suspense_zero := true;
    END IF;
  END LOOP;

  PERFORM public.fn_ca_diamond_incident('DR11:trial_balance_summary', 'info', NULL, NULL, 'fn_ca_diamond_trial_balance_watch',
    jsonb_build_object('accounts_reported', v_rows, 'incidents_filed', v_filed, 'accounts_broken', NULLIF(btrim(v_broken), ''),
                       'window_start', v_since, 'window_end', now()));

  -- A BREAK CANNOT OUTLIVE ITS CAUSE (2026-09-19). An open DR11:trial_balance_break row names its
  -- account; when that account read difference 0 on this tick the row is resolved with a note
  -- saying so. An open DR12:suspense_nonzero row is resolved when suspense read 0. Nothing is
  -- deleted here and no other rule is touched.
  UPDATE public.ca_diamond_incidents i
     SET resolved_at = now(),
         resolution = format('auto: account %s read difference 0 at %s', i.detail->>'account', now()::text)
   WHERE i.rule = 'DR11:trial_balance_break' AND i.resolved_at IS NULL
     AND i.detail->>'account' = ANY (v_clean);
  GET DIAGNOSTICS v_resolved = ROW_COUNT;
  IF v_resolved > 0 THEN
    RAISE NOTICE 'fn_ca_diamond_trial_balance_watch: resolved % DR11:trial_balance_break row(s) whose account reads 0', v_resolved;
  END IF;
  IF v_suspense_zero THEN
    UPDATE public.ca_diamond_incidents i
       SET resolved_at = now(),
           resolution = format('auto: suspense read 0 at %s', now()::text)
     WHERE i.rule = 'DR12:suspense_nonzero' AND i.resolved_at IS NULL;
    GET DIAGNOSTICS v_resolved = ROW_COUNT;
    IF v_resolved > 0 THEN
      RAISE NOTICE 'fn_ca_diamond_trial_balance_watch: resolved % DR12:suspense_nonzero row(s); suspense reads 0', v_resolved;
    END IF;
  END IF;

  UPDATE public.ca_diamond_incidents SET resolved_at = now()
   WHERE resolved_at IS NULL AND severity = 'info' AND occurred_at < now() - interval '7 days';
  DELETE FROM public.ca_diamond_incidents
   WHERE severity = 'info' AND resolved_at IS NOT NULL AND occurred_at < now() - interval '30 days';
  RETURN v_filed;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance_watch() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. If either watch is on the guard watchlist, its new text is declared through
--    the estate's own door so the hourly hash watcher has nothing to report.
-- ---------------------------------------------------------------------------
DO $declare$
DECLARE v_name text;
BEGIN
  IF to_regprocedure('public.fn_ca_guard_watchlist()') IS NULL THEN
    RAISE NOTICE 'no guard watchlist in this database; nothing to declare';
    RETURN;
  END IF;
  FOREACH v_name IN ARRAY ARRAY['fn_ca_diamond_health_watch', 'fn_ca_diamond_trial_balance_watch'] LOOP
    IF v_name = ANY (public.fn_ca_guard_watchlist()) THEN
      PERFORM public.fn_ca_declare_guard_redefinition(v_name,
        'migration 20260919223032_the_health_watch_resolves_what_it_filed');
      RAISE NOTICE 'guard baseline declared for %', v_name;
    END IF;
  END LOOP;
END $declare$;

-- ---------------------------------------------------------------------------
-- 5. WHAT WAS INSTALLED IS WHAT WAS WRITTEN HERE, and neither watch is callable
--    without an account.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE v_hw text; v_tb text;
BEGIN
  v_hw := pg_get_functiondef('public.fn_ca_diamond_health_watch()'::regprocedure);
  v_tb := pg_get_functiondef('public.fn_ca_diamond_trial_balance_watch()'::regprocedure);
  IF position('''DR0:health_critical'', ''critical'', NULL, NULL, ''fn_ca_diamond_health_watch''' in v_hw) = 0 THEN
    RAISE EXCEPTION 'the health watch stopped filing DR0';
  END IF;
  IF position('i.rule = ''DR0:health_critical'' AND i.resolved_at IS NULL' in v_hw) = 0
     OR position('d->>''area'' = ANY (v_bad_areas)' in v_hw) = 0 THEN
    RAISE EXCEPTION 'the health watch does not resolve DR0 rows by area';
  END IF;
  IF position('DELETE' in v_hw) > 0 THEN
    RAISE EXCEPTION 'the health watch must never delete an incident';
  END IF;
  IF position('''DR11:trial_balance_break''' in v_tb) = 0 OR position('''DR12:suspense_nonzero''' in v_tb) = 0
     OR position('''DR11:trial_balance_summary''' in v_tb) = 0
     OR position('''DR6:fixture_harness_unregistered_movement''' in v_tb) = 0 THEN
    RAISE EXCEPTION 'the trial balance watch stopped filing what it filed';
  END IF;
  IF position('i.rule = ''DR11:trial_balance_break'' AND i.resolved_at IS NULL' in v_tb) = 0
     OR position('i.detail->>''account'' = ANY (v_clean)' in v_tb) = 0
     OR position('i.rule = ''DR12:suspense_nonzero'' AND i.resolved_at IS NULL' in v_tb) = 0 THEN
    RAISE EXCEPTION 'the trial balance watch does not resolve DR11 and DR12 rows by account';
  END IF;
  -- The one DELETE it has always had, unchanged: resolved info rows older than thirty days.
  IF (length(v_tb) - length(replace(v_tb, 'DELETE FROM public.ca_diamond_incidents', ''))) / length('DELETE FROM public.ca_diamond_incidents') <> 1
     OR position('WHERE severity = ''info'' AND resolved_at IS NOT NULL AND occurred_at < now() - interval ''30 days''' in v_tb) = 0 THEN
    RAISE EXCEPTION 'the trial balance watch''s housekeeping DELETE changed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_diamond_health_watch()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_diamond_health_watch()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_diamond_trial_balance_watch()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_diamond_trial_balance_watch()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a Diamond watch became executable by anon or authenticated';
  END IF;
END $verify$;

-- ---------------------------------------------------------------------------
-- 6. ONE TICK OF EACH WATCH, BY THE DEPLOYED CODE, then the gate is read.
-- ---------------------------------------------------------------------------
DO $one_tick$
DECLARE
  v_crit_before bigint; v_crit_after bigint;
  v_dr0_before bigint; v_dr0_after bigint;
  v_dr11_before bigint; v_dr11_after bigint;
  v_dr12_before bigint; v_dr12_after bigint;
  v_other_before bigint; v_other_after bigint;
  v_bad integer; v_filed integer; v_sample text; v_stale bigint; v_other_ids bigint[]; v_touched bigint;
BEGIN
  -- "Other rules" are counted at warning and critical only: the trial balance watch's own
  -- seven-day sweep resolves info rows on every tick and that is live behaviour, not this change.
  SELECT count(*) FILTER (WHERE severity = 'critical'),
         count(*) FILTER (WHERE rule = 'DR0:health_critical'),
         count(*) FILTER (WHERE rule = 'DR11:trial_balance_break'),
         count(*) FILTER (WHERE rule = 'DR12:suspense_nonzero'),
         count(*) FILTER (WHERE severity <> 'info'
                            AND rule NOT IN ('DR0:health_critical', 'DR11:trial_balance_break', 'DR12:suspense_nonzero'))
    INTO v_crit_before, v_dr0_before, v_dr11_before, v_dr12_before, v_other_before
    FROM public.ca_diamond_incidents WHERE resolved_at IS NULL;
  RAISE NOTICE 'before the tick: % open critical, % open DR0, % open DR11 break, % open DR12, % open non-info under other rules',
    v_crit_before, v_dr0_before, v_dr11_before, v_dr12_before, v_other_before;
  SELECT COALESCE(array_agg(id), ARRAY[]::bigint[]) INTO v_other_ids
    FROM public.ca_diamond_incidents
   WHERE resolved_at IS NULL AND severity <> 'info'
     AND rule NOT IN ('DR0:health_critical', 'DR11:trial_balance_break', 'DR12:suspense_nonzero');

  v_bad := public.fn_ca_diamond_health_watch();
  v_filed := public.fn_ca_diamond_trial_balance_watch();
  RAISE NOTICE 'the tick: health watch read % critical/unknown area(s); trial balance watch filed % (negative means it failed and warned)', v_bad, v_filed;
  IF v_filed < 0 THEN
    RAISE EXCEPTION 'fn_ca_diamond_trial_balance_watch failed during the tick; see its warning';
  END IF;

  SELECT count(*) FILTER (WHERE severity = 'critical'),
         count(*) FILTER (WHERE rule = 'DR0:health_critical'),
         count(*) FILTER (WHERE rule = 'DR11:trial_balance_break'),
         count(*) FILTER (WHERE rule = 'DR12:suspense_nonzero'),
         count(*) FILTER (WHERE severity <> 'info'
                            AND rule NOT IN ('DR0:health_critical', 'DR11:trial_balance_break', 'DR12:suspense_nonzero'))
    INTO v_crit_after, v_dr0_after, v_dr11_after, v_dr12_after, v_other_after
    FROM public.ca_diamond_incidents WHERE resolved_at IS NULL;
  RAISE NOTICE 'after the tick: % open critical, % open DR0, % open DR11 break, % open DR12, % open non-info under other rules',
    v_crit_after, v_dr0_after, v_dr11_after, v_dr12_after, v_other_after;

  SELECT resolution INTO v_sample FROM public.ca_diamond_incidents
   WHERE rule = 'DR0:health_critical' AND resolution LIKE 'auto:%' ORDER BY occurred_at LIMIT 1;
  RAISE NOTICE 'oldest DR0 resolution note: %', COALESCE(v_sample, '(none)');

  -- No open warning or critical row under any other rule was resolved by the tick. Counted by
  -- id, not by total: a trigger elsewhere may commit a fresh DR7 row while this runs.
  SELECT count(*) INTO v_touched FROM public.ca_diamond_incidents
   WHERE id = ANY (v_other_ids) AND resolved_at IS NOT NULL;
  IF v_touched > 0 THEN
    RAISE EXCEPTION 'the tick resolved % row(s) under rules it must not touch', v_touched;
  END IF;
  -- A DR11 break whose account reads 0 cannot still be open.
  SELECT count(*) INTO v_stale
    FROM public.ca_diamond_incidents i
   WHERE i.rule = 'DR11:trial_balance_break' AND i.resolved_at IS NULL
     AND EXISTS (SELECT 1 FROM public.fn_ca_diamond_trial_balance(now() - interval '1 hour') t
                  WHERE t.account = i.detail->>'account' AND t.difference = 0);
  IF v_stale > 0 THEN
    RAISE EXCEPTION '% DR11:trial_balance_break row(s) stayed open although their account reads 0', v_stale;
  END IF;
  -- THE GATE. The programme reads "no open critical ca_diamond_incidents".
  IF v_crit_after <> 0 THEN
    RAISE EXCEPTION '% critical incident(s) remain open after the tick; a critical cause is still present and this migration will not paper over it', v_crit_after;
  END IF;
END $one_tick$;

COMMIT;
