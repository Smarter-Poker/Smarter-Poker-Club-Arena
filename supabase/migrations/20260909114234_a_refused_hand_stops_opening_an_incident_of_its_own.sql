DO $mig$
DECLARE
  v_src text; v_new text; v_actor uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid; v_n int;
BEGIN
  /* THE BOARD WAS STILL RE-FLOODING WHILE THIS SESSION WATCHED IT.

     Two criticals were closed at 11:32 with evidence, and two more of exactly
     the same shape were open again by 11:40. The dedupe key is built from the
     normalised message and error, but the echo-fold path also requires the
     suspected_cause to match byte for byte - and that text names the table and
     the hand number, which differ on every refusal. So each refused hand opens
     a fresh critical on the money board, forever. At 1,226 refusals in two
     days that is the flood, arriving faster than anyone can read it.

     A refusal is not a money incident. The atomic settlement contract rejects
     the hand write WHOLE and rolls it back before any downstream money step -
     that is what it exists to do, and the message says so in its own words.
     What is lost is a hand, not a chip. The engine problem behind it is real
     and it lives in ServerTableEngine on the poker host, where the fix belongs.

     Since 20260909113225 that question has an owner here:
     fn_ca_hand_commit_refusals reports the rate with its reasons in it, in the
     conservation sweep, and raises whenever a reason passes 25 in a day. So
     the per-hand promotion is now duplicate reporting that can only
     accumulate. The alert still lands in financial_alerts, where every one of
     them is kept and countable; it simply stops opening an incident of its own.

     NOTHING ELSE IS SILENCED. The test names the refusal specifically, not the
     post-hand reporter in general: a post-hand step that fails for any other
     reason still pages exactly as before. */
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_financial_alert_to_incident';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_financial_alert_to_incident is gone'; END IF;
  IF position($chk$authoritative_hand_semantic_refusal$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the promoter already defers refusals to the rate check';
  END IF;
  IF position($chk$  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the early returns moved; re-read them before editing';
  END IF;

  v_new := replace(v_src,
$old$  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;$old$,
$new$  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;

  /* A REFUSED HAND IS A RATE, NOT AN INCIDENT (2026-09-09). The atomic
     settlement contract rejects the hand write whole and rolls it back before
     any money step, so a refusal costs a hand and never a chip.
     fn_ca_hand_commit_refusals owns this question in the conservation sweep
     and raises when a reason passes 25 in a day; promoting each refused hand
     here as well only fills the money board faster than it can be read. The
     alert itself is still written to financial_alerts and still counted. */
  IF NEW.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
     OR COALESCE(NEW.context->>'error', '') LIKE '%authoritative_hand_semantic_refusal%' THEN
    RETURN NEW;
  END IF;$new$);

  IF v_new = v_src THEN RAISE EXCEPTION 'the promoter was not changed'; END IF;
  EXECUTE v_new;

  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(), resolved_by=v_actor,
         root_cause = 'A hand commit refused by the atomic settlement contract. The contract rejects '
                   || 'the write whole and rolls it back before every downstream money step, which is '
                   || 'what it exists to do, so a refusal costs a hand and never a chip. 1,226 of them '
                   || 'were refused across 312 tables in two days - 572 stack mismatches, 382 expired '
                   || 'lease proofs, 203 duplicate commits, 47 seats the balancer had already vacated - '
                   || 'and each one was opening a fresh critical here because the fold requires the '
                   || 'suspected cause to match byte for byte and that text names the table and the '
                   || 'hand. The engine problem is real and lives in ServerTableEngine on the poker '
                   || 'host; the reporting problem was here.',
         correction_ref = 'migration 20260909114102_a_refused_hand_stops_opening_an_incident_of_its_own',
         resolution = 'No chips moved to close these. fn_ca_hand_commit_refusals now reports the rate '
                   || 'with its reasons in the conservation sweep and raises when any reason passes 25 '
                   || 'in a day; the per-hand promotion is withdrawn. Every alert is still written to '
                   || 'financial_alerts and still counted, so nothing is hidden - it simply stops '
                   || 'opening an incident of its own.'
   WHERE resolved_at IS NULL
     AND source IN ('financial_alerts:ServerTableEngine.authoritative_hand_semantic_refusal',
                    'financial_alerts:postHandTasks.hand_history_failed');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n < 1 THEN RAISE EXCEPTION 'expected to close at least one refusal incident, closed %', v_n; END IF;

  IF (SELECT position($chk$A REFUSED HAND IS A RATE, NOT AN INCIDENT$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_financial_alert_to_incident') = 0 THEN
    RAISE EXCEPTION 'the promoter did not learn to defer refusals';
  END IF;
END
$mig$;;
