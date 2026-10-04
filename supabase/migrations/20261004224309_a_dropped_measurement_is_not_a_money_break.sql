-- ===========================================================================
--  A DROPPED MEASUREMENT IS NOT A MONEY BREAK
-- ===========================================================================
--
-- CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and must
-- have its own name. Never fold it into pending, green, empty, zero or
-- silence. Rule 3: a guard must have a reader, and you must name them.
--
-- WHERE THIS ESTATE STILL FOLDED IT, read on production 2026-10-04:
--
--   1. fn_ca_diamond_trial_balance_watch ended with a blanket handler:
--        EXCEPTION WHEN OTHERS THEN
--          RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed: %', SQLERRM;
--          RETURN -1;
--      A pass that could not complete filed NOTHING. The hour had no row, and
--      a RAISE WARNING into the Postgres log has no reader in this estate. The
--      2026-10-01 00:20 UTC tick died with cron message `job startup timeout`
--      and left exactly that silence. This is the gap section 7 of
--      docs/audits/2026-10-04-diamond-clean-accounting-release-series.md
--      named: "nothing turns a dropped run into a named outcome", and "the
--      per-day count that anyone would compute from the rows reads 23 instead
--      of 24 with no flag".
--
--   2. The same function filed its hourly DR11:trial_balance_summary row even
--      when the read produced no account at all, so a hollow row counted as an
--      hour that measured the books.
--
--   3. fn_ca_diamond_health_watch already splits severity correctly since
--      20261003220245_a_missed_snapshot_is_retried_not_paged: a first unknown
--      files warning, a persistent one files critical. But BOTH filed under
--      the rule name 'DR0:health_critical', so the could-not-tell row asserted
--      a critical in its own name and only its severity column said otherwise.
--      That is rule 1 left one level up, which is rule 4.
--
-- WHAT THIS DOES NOT DO. It does not touch the 2026-10-03 severity split; it
-- completes it. It resolves, edits, backdates and deletes nothing: the 95
-- DR0:health_critical rows and the one incident of 2026-10-03 19:35 stay
-- exactly as they are (10.9). It adds no cron, sweep, backfill, reconciler or
-- healer (10.12). It makes nothing quieter: every path that reads a money
-- break keeps its severity, its threshold and its pager.
--
-- WHAT CHANGES:
--
--   1. fn_ca_diamond_trial_balance_watch files DR14:trial_balance_unreadable
--      at WARNING when its pass could not complete (reason
--      read_failed_<SQLSTATE>, carrying the message) or compared no account
--      (reason no_accounts_reported), and stamps every summary row with
--      reading_complete so a hollow row is no longer countable as a reading.
--      Warning, not critical: a measurement that did not happen is not a
--      claim that the money is wrong.
--
--   2. fn_ca_diamond_health gains a FIFTEENTH area, 'trial balance reading'.
--      The existing 'trial balance' area answers whether the books balance;
--      this one answers whether anybody read them. It reads the age of the
--      hourly DR11:trial_balance_summary series and returns 'unknown' - never
--      'critical' - once two or more consecutive ticks have produced nothing.
--
--      THE 95-MINUTE THRESHOLD IS THE MEASURED CADENCE, NOT A GUESS. Read
--      from ca_diamond_incidents on 2026-10-04: 719 DR11:trial_balance_summary
--      rows since 2026-09-04 23:20 UTC, 718 consecutive gaps. 715 gaps are at
--      most 65 minutes; 3 are a single missed tick (2026-09-30 23:20 to
--      2026-10-01 01:20, 2026-10-01 22:20 to 2026-10-02 00:20, 2026-10-03
--      19:20 to 21:20); and NOT ONE gap exceeds 2h00m01s in thirty days. The
--      health watch reads at :35 and the trial balance runs at :20, so a
--      healthy newest reading is 15 minutes old and the single missed tick the
--      series has actually produced shows as 75. 95 covers both with slack.
--      Past it, two or more consecutive hourly ticks produced no reading,
--      which has never happened.
--
--   3. fn_ca_diamond_health_watch files the un-paged outcome as
--      DR0:health_unknown, and its resolver reads both names so an unknown row
--      still cannot outlive its cause. Severities, thresholds and the pager
--      are untouched.
--
-- THE THREE OUTCOMES, AND WHO READS EACH:
--
--   a money break        DR11:trial_balance_break (critical over 1,000, ruling
--                        13) and the 'trial balance' area -> DR0:health_critical
--                        at critical on the FIRST tick. Reader: the trigger
--                        ca_diamond_incident_pages (WHEN severity='critical')
--                        -> fn_ca_raise_drift_incident -> ca_drift_incidents ->
--                        fn_ca_incident_notify, which gates on the SOURCE and
--                        not the rule, so the rename cannot mute it -> Dan's
--                        phone. Unchanged by this migration, and proved below.
--
--   the books are clean  DR11:trial_balance_summary, info, reading_complete
--                        true. Reader: the clean-day series, and
--                        fn_ca_diamond_staff_books('books').
--
--   nobody could tell    DR14:trial_balance_unreadable (warning) for a pass
--                        that could not run, and the 'trial balance reading'
--                        area -> DR0:health_unknown (warning) for a tick that
--                        never fired. Readers: fn_ca_diamond_health_watch at
--                        :35, which escalates it to DR0:health_critical at
--                        critical if the next hourly reading is still unknown;
--                        and fn_ca_diamond_staff_books('health'), which
--                        returns every area verbatim out of
--                        ca_diamond_health_reading.
--
-- SO THE DIRECTION OF FAILURE IS RIGHT. A single dropped tick never again
-- files a critical money incident, and books that genuinely stop being
-- measured still page: unknown at two missed ticks, critical at three, about
-- three and a quarter hours, against a measured worst case of one.
--
-- THE SCHEDULER ITSELF IS NOT TOUCHED and needs nothing from here. The
-- 2026-10-03 20:00 stall (268 cron runs against a normal ~830) was addressed
-- by 20261003223747_a_cluster_wake_does_not_queue_behind_the_pass and
-- 20261004003020_the_heavy_hourly_watches_do_not_start_together. Measured
-- 2026-10-04 22:50 UTC: every hour from 2026-10-04 01:00 onward ran 830-844
-- jobs with ZERO non-succeeded runs, 21 consecutive clean hours, and no
-- trial-balance tick has dropped since 2026-10-03 21:20.
--
-- HOW. Exact substitution through a pg_temp helper, the pattern of
-- 20261003025434 and 20261003220245: pinned preimages, each anchor proved to
-- occur exactly once by arithmetic, derived postimages computed read-only on
-- production with the reverse substitution proved to return the preimage
-- md5, owner/security/settings/grants asserted unmoved. None of the three is
-- on fn_ca_guard_watchlist(). No schedule, grant, index or table change.
-- Every postimage was rehearsed in pg_temp inside a transaction that ended in
-- RAISE EXCEPTION (CLAUDE.md 11.5, section 2 rule 3): a forced money break
-- still filed critical, a forced unreadable pass filed one warning and no
-- critical, and a first unknown filed warning while a second consecutive one
-- filed critical.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_diamond_health()'::regprocedure)) = 'c9d50ee9949726a8db879d31248f8ad3' AND md5(pg_get_functiondef('public.fn_ca_diamond_health_watch()'::regprocedure)) = 'fcc74eaf71e7cafcfc5361692c15f117' AND md5(pg_get_functiondef('public.fn_ca_diamond_trial_balance_watch()'::regprocedure)) = 'cc6abde0e69ff67e28147a113aa86575')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;


-- 1. THE WATCH NAMES ITS OWN DROPPED TICK -----------------------------------

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_trial_balance_watch()',
  'a8aa11f601f50b9a1bebbab66e777081', 'cc6abde0e69ff67e28147a113aa86575',
  ARRAY[$o$  v_clean text[] := ARRAY[]::text[]; v_suspense_zero boolean := false; v_resolved integer;
$o$, $o$  PERFORM public.fn_ca_diamond_incident('DR11:trial_balance_summary', 'info', NULL, NULL, 'fn_ca_diamond_trial_balance_watch',
    jsonb_build_object('accounts_reported', v_rows, 'incidents_filed', v_filed, 'accounts_broken', NULLIF(btrim(v_broken), ''),
                       'window_start', v_since, 'window_end', now()));
$o$, $o$EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
$o$],
  ARRAY[$n$  v_clean text[] := ARRAY[]::text[]; v_suspense_zero boolean := false; v_resolved integer;
  v_state text; v_emsg text;
$n$, $n$  /* A HOLLOW SUMMARY IS NOT A READING (2026-10-04). The release gate is read
     from this hourly series, so a row reporting zero accounts must not count
     as an hour that measured the books. reading_complete says which it was,
     and a pass that compared no reconciling account at all files its own
     named outcome below instead of leaving a row that looks like a reading.
     CLAUDE.md 10.86 rule 1: a report that vanished is not a report that read
     ok. */
  PERFORM public.fn_ca_diamond_incident('DR11:trial_balance_summary', 'info', NULL, NULL, 'fn_ca_diamond_trial_balance_watch',
    jsonb_build_object('accounts_reported', v_rows, 'incidents_filed', v_filed, 'accounts_broken', NULLIF(btrim(v_broken), ''),
                       'reading_complete', v_rows > 0,
                       'window_start', v_since, 'window_end', now()));
  IF v_rows = 0 THEN
    PERFORM public.fn_ca_diamond_incident('DR14:trial_balance_unreadable', 'warning', NULL, NULL,
      'fn_ca_diamond_trial_balance_watch',
      jsonb_build_object('reason', 'no_accounts_reported',
                         'message', 'the trial balance returned no rows, so no account was compared',
                         'accounts_reported', 0, 'window_start', v_since, 'tick_at', now()));
  END IF;
$n$, $n$EXCEPTION WHEN OTHERS THEN
  /* A TICK THAT COULD NOT RUN HAS ITS OWN NAME (2026-10-04). This handler used
     to raise a warning into the Postgres log and return -1, filing nothing: the
     hour simply had no row, which is the silence CLAUDE.md 10.86 rule 1 forbids
     and the gap section 7 of the 2026-10-04 clean-day-series audit named. A
     pass that could not complete now files DR14, at warning, into the same
     table the clean series is read from, carrying its SQLSTATE and message.
     Warning, not critical: a measurement that did not happen is not a claim
     that the money is wrong. The escalation lives in fn_ca_diamond_health's
     'trial balance reading' area, which reads the age of this series and goes
     unknown once two consecutive ticks have produced nothing; its readers are
     fn_ca_diamond_health_watch at :35 and the staff desk health view
     (fn_ca_diamond_staff_books('health')). */
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_emsg = MESSAGE_TEXT;
  PERFORM public.fn_ca_diamond_incident('DR14:trial_balance_unreadable', 'warning', NULL, NULL,
    'fn_ca_diamond_trial_balance_watch',
    jsonb_build_object('reason', 'read_failed_' || v_state, 'message', v_emsg,
                       'accounts_reported', v_rows, 'window_start', v_since, 'tick_at', now()));
  RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed (%): %', v_state, v_emsg;
  RETURN -1;
$n$]);


-- 2. THE HEALTH REPORT ANSWERS WHETHER ANYBODY READ THE BOOKS ---------------

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_health()',
  '64b94d13476dd74cf8573de193cc14e2', 'c9d50ee9949726a8db879d31248f8ad3',
  ARRAY[$o$  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'trial balance'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;
$o$],
  ARRAY[$n$  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'trial balance'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    /* A DROPPED TICK IS NOT A CLEAN HOUR (2026-10-04). The clean-accounting
       release gate is read from the hourly DR11:trial_balance_summary series,
       and a tick that never fired leaves no row at all - silence, which
       CLAUDE.md 10.86 rule 1 forbids as an answer, and the gap section 7 of
       the 2026-10-04 clean-day-series audit named: "nothing turns a dropped
       run into a named outcome". The area above answers whether the books
       balance. THIS area answers whether anybody read them.

       The threshold is the measured cadence, not a guess. Read from
       ca_diamond_incidents on 2026-10-04: 719 DR11:trial_balance_summary rows
       since 2026-09-04 23:20 UTC, 718 consecutive gaps - 715 of them at most
       65 minutes, 3 of them one missed tick, and NOT ONE gap longer than
       2h00m01s in thirty days. fn_ca_diamond_health_watch reads this at :35
       and the trial balance runs at :20, so a healthy newest reading is 15
       minutes old and the single missed tick the series has actually produced
       shows as 75. 95 minutes covers both with slack; past it, two or more
       consecutive hourly ticks produced no reading, which has never happened.

       That reads 'unknown', the estate's name for "I could not tell", and
       never 'critical': an hour nobody measured is not a claim that the money
       is wrong. fn_ca_diamond_health_watch files a first unknown at warning
       and a second consecutive one at critical, so books that genuinely stop
       being measured still page, after about three hours, while a single
       dropped tick never again files a critical money incident. The readers
       are that watch and the staff desk health view,
       fn_ca_diamond_staff_books('health'), which returns every area verbatim. */
    SELECT max(i.occurred_at)::text,
           floor(extract(epoch FROM now() - max(i.occurred_at)) / 60)::bigint
      INTO v_t, v_n
      FROM public.ca_diamond_incidents i
     WHERE i.rule = 'DR11:trial_balance_summary';
    RETURN QUERY SELECT 'trial balance reading'::text,
      CASE WHEN v_t IS NULL OR v_n IS NULL OR v_n > 95 THEN 'unknown' ELSE 'ok' END,
      CASE WHEN v_t IS NULL OR v_n IS NULL
             THEN 'No trial-balance reading has ever been filed. Nothing has measured these books.'
           WHEN v_n > 95
             THEN 'The newest trial-balance reading is from ' || v_t || ', ' || v_n
                  || ' minutes old, so two or more hourly ticks produced no reading at all. '
                  || 'The books are not broken; they are unmeasured.'
           ELSE 'The hourly trial balance last read at ' || v_t || ', ' || v_n
                || ' minute(s) ago.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'trial balance reading'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;
$n$]);


-- 3. THE UN-PAGED OUTCOME GETS ITS OWN RULE NAME ----------------------------

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_health_watch()',
  'e5101ef5acb368d1ff88bbf7a0b67cf1', 'fcc74eaf71e7cafcfc5361692c15f117',
  ARRAY[$o$    PERFORM public.fn_ca_diamond_incident(
      'DR0:health_critical', CASE WHEN v_persistent > 0 THEN 'critical' ELSE 'warning' END,
$o$, $o$   WHERE i.rule = 'DR0:health_critical' AND i.resolved_at IS NULL
$o$],
  ARRAY[$n$    /* AND THE UN-PAGED OUTCOME GETS ITS OWN NAME (2026-10-04). The severity
       split above is right and is kept exactly; the rule name was not. Both
       outcomes filed under 'DR0:health_critical', so the could-not-tell row
       asserted a critical in its own name and only its severity column said
       otherwise - CLAUDE.md 10.86 rule 1 ("I could not tell is a distinct
       outcome and must have its own name"), left one level up, which is rule
       4. Anyone reading this series by rule, as the 2026-10-04 clean-day
       audit does, now sees DR0:health_critical for findings only and
       DR0:health_unknown for hours nobody could measure. Severities,
       thresholds and the pager are untouched: the trigger
       fn_ca_diamond_incident_pages fires on severity = 'critical', so a
       finding still pages at once and an unknown still does not, and
       fn_ca_incident_notify gates on the source, not the rule. The resolver
       below reads both names so an unknown row still cannot outlive its
       cause. */
    PERFORM public.fn_ca_diamond_incident(
      CASE WHEN v_persistent > 0 THEN 'DR0:health_critical' ELSE 'DR0:health_unknown' END,
      CASE WHEN v_persistent > 0 THEN 'critical' ELSE 'warning' END,
$n$, $n$   WHERE i.rule IN ('DR0:health_critical', 'DR0:health_unknown') AND i.resolved_at IS NULL
$n$]);

-- pg_temp.ca_audit_subst is a temporary object and ends with this session.

COMMIT;
