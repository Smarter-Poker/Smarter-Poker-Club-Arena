-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260907193146; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260907193146   (the stamp IS the apply time, UTC: 2026-09-07 19:31:46)
--   name        rakeback_a_club_cannot_pay_is_somebody_told
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 7994 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260907193146 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_rakeback_shortfall_watch
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
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

-- RAKEBACK A CLUB CANNOT PAY IS SOMEBODY TOLD
-- =============================================================================
-- PHASE 5 of 8, part 6 - the last piece: making the shortfall loud.
--
-- The drain is fixed and 231,046.71 has been paid to 987 players. What is left
-- is 280,142.41 owed to 589 players at Midway Union, against a club treasury of
-- 0.50. That is not a bug any more, it is a fact, and the only thing wrong with
-- a fact like that is nobody being told it.
--
-- The old behaviour was a `warning` per period, per attempt:
-- fn_close_settlement_period filed 244 of them between 2026-08-24 and
-- 2026-08-29 and then stopped - not because anything improved, but because the
-- job began timing out earlier in its loop and never reached the code that
-- files them. A log that goes quiet because the writer died reads exactly like
-- a log that goes quiet because the problem went away.
--
-- So: ONE critical alert per club per day, naming the shortfall, the players
-- and the oldest period, raised from the hourly sweep that already runs. It
-- clears itself when the club can pay. Per-period warnings are gone; the reason
-- lives on the period now (rakeback_periods.deferred_reason), which is where it
-- can be counted rather than scrolled.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_rakeback_shortfall_watch()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r          record;
  v_raised   int := 0;
  v_cleared  int := 0;
  v_total    numeric := 0;
BEGIN
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR NOT public.fn_is_platform_admin()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR r IN
    SELECT o.club_id, c.name AS club_name, o.periods, o.players, o.owed,
           o.oldest, COALESCE(c.chip_treasury, 0) AS treasury,
           round(o.owed - COALESCE(c.chip_treasury, 0), 2) AS shortfall
      FROM (SELECT club_id, count(*) AS periods, count(DISTINCT user_id) AS players,
                   round(sum(COALESCE(rakeback_amount, rakeback_earned, 0)), 2) AS owed,
                   min(period_end) AS oldest
              FROM rakeback_periods
             WHERE status = 'pending' AND period_end < CURRENT_DATE
             GROUP BY club_id) o
      JOIN clubs c ON c.id = o.club_id
  LOOP
    IF r.treasury < r.owed THEN
      v_total := v_total + r.shortfall;
      -- One per club per day. A shortfall that persists is the same fact, not
      -- a new one, and an alarm repeated hourly is an alarm that gets muted.
      IF NOT EXISTS (
        SELECT 1 FROM financial_alerts a
         WHERE a.source = 'fn_rakeback_shortfall_watch'
           AND NOT a.resolved
           AND a.context->>'club_id' = r.club_id::text
           AND a.created_at > now() - interval '24 hours') THEN

        INSERT INTO financial_alerts (source, severity, message, context)
        VALUES ('fn_rakeback_shortfall_watch', 'critical',
                r.club_name || ' cannot pay its players'' rakeback: '
                || to_char(r.owed, 'FM999,999,999,990.00') || ' owed to '
                || r.players || ' players across ' || r.periods
                || ' periods, against a treasury of '
                || to_char(r.treasury, 'FM999,999,999,990.00') || '. Short by '
                || to_char(r.shortfall, 'FM999,999,999,990.00')
                || '. Oldest period ended ' || r.oldest || '.',
                jsonb_build_object('club_id', r.club_id, 'club_name', r.club_name,
                                   'periods', r.periods, 'players', r.players,
                                   'owed', r.owed, 'treasury', r.treasury,
                                   'shortfall', r.shortfall, 'oldest_period_end', r.oldest));
        v_raised := v_raised + 1;
      END IF;
    ELSE
      -- The club can pay now. Close its standing alert; the drain does the rest.
      UPDATE financial_alerts a
         SET resolved = true, resolved_at = now(),
             resolution = 'The club treasury covers what its players are owed again; the bounded drain settles it on its next pass.'
       WHERE a.source = 'fn_rakeback_shortfall_watch'
         AND NOT a.resolved
         AND a.context->>'club_id' = r.club_id::text;
      IF FOUND THEN v_cleared := v_cleared + 1; END IF;
    END IF;
  END LOOP;

  -- Nothing pending at all: nothing can be short.
  UPDATE financial_alerts a
     SET resolved = true, resolved_at = now(),
         resolution = 'No rakeback period is pending for this club any more.'
   WHERE a.source = 'fn_rakeback_shortfall_watch' AND NOT a.resolved
     AND NOT EXISTS (SELECT 1 FROM rakeback_periods rp
                      WHERE rp.club_id = (a.context->>'club_id')::uuid
                        AND rp.status='pending' AND rp.period_end < CURRENT_DATE);

  RETURN jsonb_build_object('raised', v_raised, 'cleared', v_cleared,
                            'total_shortfall', round(v_total, 2), 'ran_at', now());
END;
$function$;

COMMENT ON FUNCTION public.fn_rakeback_shortfall_watch() IS
  'Raises one critical alert per club per day when a club treasury cannot cover the player rakeback it owes, and clears it when the club can pay. Replaces the per-period warnings fn_close_settlement_period used to file - 244 of them in five days, which then stopped because the job died before reaching the line that wrote them. Runs hourly from fn_union_integrity_sweep_all.';

REVOKE ALL ON FUNCTION public.fn_rakeback_shortfall_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_shortfall_watch() TO service_role;

-- WIRING: it rides the hourly sweep, like Phase 4's ageing. No new pg_cron
-- (World Hub CLAUDE.md 11.3).

DO $migrate$
DECLARE v_def text; v_new text; v_a text; v_r text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc
   WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;

  v_a := E'    -- Age and chase what is past due, before enforcement reads it.';
  v_r := E'    -- A club that cannot pay its players'' rakeback says so, once a day.\n'
      || E'    BEGIN\n'
      || E'      PERFORM public.fn_rakeback_shortfall_watch();\n'
      || E'    EXCEPTION WHEN OTHERS THEN\n'
      || E'      INSERT INTO financial_alerts (source, severity, message, context)\n'
      || E'      VALUES (''fn_rakeback_shortfall_watch'', ''warning'',\n'
      || E'              ''The rakeback shortfall watch failed'',\n'
      || E'              jsonb_build_object(''error'', SQLERRM));\n'
      || E'    END;\n\n'
      || v_a;

  IF position(v_a in v_def) = 0 THEN
    RAISE EXCEPTION 'the Phase 4 ageing anchor is not in the sweep';
  END IF;
  v_new := replace(v_def, v_a, v_r);
  IF v_new = v_def THEN RAISE EXCEPTION 'the shortfall watch wiring did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

DO $assert$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_rakeback_shortfall_watch%' THEN
    RAISE EXCEPTION 'the sweep does not watch for a rakeback shortfall';
  END IF;
  -- Phases 1-4 must all still be in there.
  IF v_src NOT LIKE '%fn_union_age_invoices%'
     OR v_src NOT LIKE '%fn_union_enforce_stop_loss%'
     OR v_src NOT LIKE '%fn_close_due_settlement_periods%'
     OR v_src NOT LIKE '%fn_settlement_lock_hygiene%'
     OR v_src NOT LIKE '%expire_settlement_locks%'
     OR v_src NOT LIKE '%fn_union_integrity_sweep(%' THEN
    RAISE EXCEPTION 'the sweep lost one of its existing jobs';
  END IF;
  IF has_function_privilege('anon','public.fn_rakeback_shortfall_watch()'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated','public.fn_rakeback_shortfall_watch()'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'a browser can read every club treasury shortfall';
  END IF;
END
$assert$;

COMMIT;
