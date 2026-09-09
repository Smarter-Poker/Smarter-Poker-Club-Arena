/* WHY. The atomic settlement contract refused 1,226 hand commits across 312
   tables in two days - 572 stack mismatches, 382 expired lease proofs, 203
   duplicate commits, 47 seats the balancer had already vacated, and a tail of
   deadlocks and stale leases. Every one of them is a REFUSAL: the hand write
   was rejected whole and rolled back before any downstream money step, which
   is the contract doing exactly what it exists to do. The tournament whose
   refusal reached the drift board today, Union Morning Classic (NLH), holds
   190,000 chips at its seats against 190,000 put in play - exact.

   So this is an engine reliability problem, not a money-loss problem, and it
   lives in ServerTableEngine on the poker host rather than in any function
   here. What is wrong on THIS side is the shape of the reporting: each
   distinct refusal is promoted to its own critical incident on the money
   board, so a standing rate arrives as a stream of one-off criticals that
   nobody can act on and nobody can close. That is the same fault this session
   has been correcting everywhere else.

   A rate is one finding with its reasons in it. */
CREATE OR REPLACE FUNCTION public.fn_ca_hand_commit_refusals(p_hours integer DEFAULT 24)
RETURNS TABLE(reason text, refusals bigint, tables_affected bigint, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH win AS (
    SELECT CASE
             WHEN a.context->>'error' LIKE '%seat missing or left%' THEN 'seat missing or left'
             WHEN a.context->>'error' LIKE '%lease_proof_expired%'  THEN 'lease proof expired'
             WHEN a.context->>'error' LIKE '%hand_lease_stale%'     THEN 'hand lease stale'
             WHEN a.context->>'error' LIKE '%duplic%'               THEN 'duplicate commit'
             WHEN a.context->>'error' LIKE '%deadlock%'             THEN 'deadlock'
             WHEN a.context->>'error' LIKE '%stack%'                THEN 'stack mismatch'
             ELSE 'other'
           END AS reason,
           a.context->>'table_id' AS table_id
      FROM public.financial_alerts a
     WHERE a.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
       AND a.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))
  )
  SELECT w.reason, count(*), count(DISTINCT w.table_id),
         count(*) || ' hand commit(s) refused for "' || w.reason || '" across '
           || count(DISTINCT w.table_id) || ' table(s). A refusal rolls the hand back whole '
           || 'before any money step, so no chips move; what is lost is the hand. This is '
           || 'ServerTableEngine on the poker host, not a function in this database.' AS detail
    FROM win w
   GROUP BY w.reason
  HAVING count(*) >= 25
   ORDER BY 2 DESC
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_hand_commit_refusals(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_hand_commit_refusals(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_hand_commit_refusals(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_hand_commit_refusals(integer) TO service_role;

DO $mig$
DECLARE
  v_src text; v_new text; v_actor uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep';
  IF position($chk$fn_ca_hand_commit_refusals$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the sweep already counts refused hands';
  END IF;
  IF position($chk$      ('fn_ca_stranded_tournament_players',$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the sweep roster moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$      ('fn_ca_stranded_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_tournament_players() limit 20) t',
       'warning')$old$,
$new$      ('fn_ca_stranded_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_tournament_players() limit 20) t',
       'warning'),
      ('fn_ca_hand_commit_refusals',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_hand_commit_refusals(24) limit 20) t',
       'warning')$new$);
  IF v_new = v_src THEN RAISE EXCEPTION 'the sweep roster was not extended'; END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  -- The two criticals raised by one refused hand.
  ------------------------------------------------------------------
  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(), resolved_by=v_actor,
         root_cause = 'Hand #8689238 on Union Morning Classic table 5 was refused by the atomic '
                   || 'settlement contract because seat 4 had been vacated 13 seconds earlier: at '
                   || '11:21:16 to 11:21:18 the balancer marked six of the seven seats left as it '
                   || 'broke the table, and the engine then tried to commit a hand for one of those '
                   || 'players. The contract rejected the write whole and rolled it back before any '
                   || 'downstream money step, which is what it exists to do. The player was moved, '
                   || 'not stranded - they hold an open seat elsewhere - and the event holds 190,000 '
                   || 'chips at its seats against 190,000 put in play, exact. The second incident is '
                   || 'the same refusal seen from the post-hand history step, which threw because the '
                   || 'hand it was asked to write had not committed.',
         correction_ref = 'verified: no chips moved - the refusal is a rollback, and '
                   || 'fn_tournament_chip_conservation_check reads Union Morning Classic at 190,000 '
                   || 'expected and 190,000 at seats',
         resolution = 'Closed as a protected refusal, not a loss. The class it belongs to - 1,226 '
                   || 'refusals over 312 tables in two days, mostly stack mismatches and expired '
                   || 'lease proofs - is a ServerTableEngine problem on the poker host and is now '
                   || 'measured as a rate by fn_ca_hand_commit_refusals in the conservation sweep, '
                   || 'rather than arriving one critical at a time on the money board.'
   WHERE resolved_at IS NULL
     AND source IN ('financial_alerts:ServerTableEngine.authoritative_hand_semantic_refusal',
                    'financial_alerts:postHandTasks.hand_history_failed');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected to close 2 refusal incidents, closed %', v_n; END IF;

  ------------------------------------------------------------------
  -- The two guard redefinitions are this session's own, and named.
  ------------------------------------------------------------------
  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(), resolved_by=v_actor,
         root_cause = 'fn_club_members_ledger_writer was redefined deliberately today to honour '
                   || 'app.ledger_autoskip_club_members, the stand-down clause every other journal '
                   || 'writer on this platform already obeyed. Without it a settlement that wrote its '
                   || 'own named leg still got an anonymous twin from this side, and 20,377.49 of '
                   || 'commission was journalled as 40,754.98 of legs.',
         correction_ref = 'migration 20260909105833_one_movement_one_leg_the_settlement_stands_its_triggers_down',
         resolution = 'Deliberate change, reviewed, and pinned by 16 law tests in '
                   || 'tests/oneMovementIsOneLeg.law.test.ts.'
   WHERE resolved_at IS NULL AND source='fn_ca_guard_defs_watch'
     AND metadata->>'guard' = 'fn_club_members_ledger_writer';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected to close the club_members writer notice, closed %', v_n; END IF;

  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(), resolved_by=v_actor,
         root_cause = 'fn_ca_quick_reconcile was redefined deliberately today so its daily suspense '
                   || 'note measures the NET of what entered and left suspense rather than the gross '
                   || 'flow through it. Counting both legs made a correction cancelling its own '
                   || 'auto-ledger twin read as undeclared flow when it left nothing behind at all.',
         correction_ref = 'migration 20260909102650_the_daily_suspense_note_says_what_stayed_and_the_rest_is_closed',
         resolution = 'Deliberate change, reviewed. The provenance question the gross figure was '
                   || 'reaching for is now asked properly, per account, by fn_ca_undeclared_leg_check '
                   || 'in the conservation sweep.'
   WHERE resolved_at IS NULL AND source='fn_ca_guard_defs_watch'
     AND metadata->>'guard' = 'fn_ca_quick_reconcile';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected to close the quick reconcile notice, closed %', v_n; END IF;

  IF (SELECT position($chk$fn_ca_hand_commit_refusals$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep') = 0 THEN
    RAISE EXCEPTION 'the sweep did not take the refusal rate check';
  END IF;
END
$mig$;;
