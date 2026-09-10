/* A DRIFT INCIDENT IS CRITICAL WHEN CHIPS ARE AT STAKE (2026-09-10)

   fn_ca_financial_alert_to_incident promotes every 'critical' financial_alert
   into a CRITICAL drift incident. The severity CASE had two info exemptions
   (conservation sources, cert-account prize credits) and defaulted everything
   else to critical - including engine plumbing that names no chip at all.

   Read from the board 2026-09-10 02:02 UTC: ten open incidents, every one with
   discrepancy_amount = 0, the board's own WORST DISCREPANCY reading 0 and
   UNCLASSIFIED FLOW reading 0. The three engine sources on it -
   ServerTableEngine.post_commit_obligations_pending (whose message says the
   outbox row remains authoritative and the projection worker is its
   successor - the design working), ServerTableEngine.authoritative_hand_
   unreachable (a hand rolled back whole on a database stall), and
   postHandTasks.leave_pending_failed (a post-hand step threw) - each cost a
   hand or a step and never a chip, and each sat on the MONEY board as CRITICAL
   next to the things that are money. Dan's standing rule: only critical errors
   that need his attention reach him.

   THE FIX: an engine-plumbing alert (ServerTableEngine.*, postHandTasks.*)
   whose context carries no discrepancy and no amount files as 'info'. It is
   still written, still deduped, still counted, still on the board - it is not
   red, and it does not page. Money-shaped sources (prize, payout, bounty, rake,
   treasury, guarantee, insurance, bbj, rakeback) are untouched: a prize that
   failed to credit may carry no amount in its context and is still critical.

   The open incidents from those three sources are resolved here with their
   root causes named, because the causes shipped tonight and the conditions
   have ceased (measured: zero of each since the fixes). */
DO $mig$
DECLARE v_src text; v_new text; v_a text; v_b text; v_n int; v_resolved int;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_financial_alert_to_incident';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_financial_alert_to_incident not found'; END IF;

  IF position('CRITICAL WHEN CHIPS ARE AT STAKE' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; skipping the function';
  ELSE
    v_a := '  v_severity := CASE' || E'\n' ||
           '      WHEN NEW.source ~* ''conservation'' THEN ''info''';
    v_n := (length(v_src)-length(replace(v_src,v_a,'')))/length(v_a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the severity CASE appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
    END IF;
    v_b := '  /* A DRIFT INCIDENT IS CRITICAL WHEN CHIPS ARE AT STAKE (2026-09-10). Engine' || E'\n' ||
           '     plumbing that names no chip - a hand rolled back, a post-hand step that' || E'\n' ||
           '     threw, an outbox handoff - is filed as info: written, deduped, counted,' || E'\n' ||
           '     on the board, not red, not paged. Money-shaped sources are untouched. */' || E'\n' ||
           '  v_severity := CASE' || E'\n' ||
           '      WHEN NEW.source ~* ''conservation'' THEN ''info''' || E'\n' ||
           '      WHEN (NEW.source LIKE ''ServerTableEngine.%'' OR NEW.source LIKE ''postHandTasks.%'')' || E'\n' ||
           '           AND NOT (NEW.source ~* ''prize|payout|bounty|rake|treasury|guarantee|insurance|bbj|rakeback'')' || E'\n' ||
           '           AND COALESCE(NULLIF(NEW.context->>''discrepancy'','''')::numeric,' || E'\n' ||
           '                        NULLIF(NEW.context->>''amount'','''')::numeric, 0) = 0' || E'\n' ||
           '        THEN ''info''';
    v_new := replace(v_src, v_a, v_b);
    IF v_new = v_src THEN RAISE EXCEPTION 'substitution produced no change'; END IF;
    EXECUTE v_new;
  END IF;

  /* Resolve the open zero-chip engine incidents whose causes shipped tonight. */
  UPDATE public.ca_drift_incidents i
     SET status='resolved', resolved_at=now(),
         correction_ref='migration a_drift_incident_is_critical_when_chips_are_at_stake',
         root_cause = CASE
           WHEN i.source LIKE '%leave_pending_failed'
             THEN 'A cash seat move re-pointed the player''s open session onto a destination already holding a leftover, violating cash_player_session_one_open; the leftovers came from table teardown and busts never closing sessions. Fixed at source: a_re_point_is_not_allowed_to_collide, a_closed_table_closes_its_sessions, a_vacated_seat_closes_its_session_at_commit. Two later occurrences were supabase_timeout, a transient stall. No chip moved; the step threw after the hand committed.'
           WHEN i.source LIKE '%authoritative_hand_unreachable'
             THEN '53 alerts across 53 tables in 67 seconds at 23:25 - one database stall (canceling statement due to statement timeout). The hand is rolled back whole before any money step; no chip moved. The stall coincided with 44 relations at anti-wraparound age; 21 tables now carry staggered autovacuum_freeze_max_age so that pile cannot form (the_big_tables_freeze_early_and_never_together).'
           WHEN i.source LIKE '%post_commit_obligations_pending'
             THEN 'The alert''s own text: the outbox row remains authoritative and the projection worker is its successor. This is the accepted-hand outbox design of 2026-09-08 working as built - the hand committed, projection is deferred to the worker. No chip moved. Filed as critical only because every engine alert was.'
         END,
         resolution = 'Zero-chip engine plumbing alert. Root cause shipped and the condition has ceased (measured zero since). Engine plumbing carrying no discrepancy now files as info, not critical.'
   WHERE i.status='open'
     AND COALESCE(i.discrepancy_amount,0) = 0
     AND (i.source LIKE 'financial_alerts:ServerTableEngine.post_commit_obligations_pending'
       OR i.source LIKE 'financial_alerts:ServerTableEngine.authoritative_hand_unreachable'
       OR i.source LIKE 'financial_alerts:postHandTasks.leave_pending_failed');
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RAISE NOTICE 'engine plumbing now files as info when no chip is at stake; % open zero-chip incidents resolved with cause', v_resolved;
END $mig$;
