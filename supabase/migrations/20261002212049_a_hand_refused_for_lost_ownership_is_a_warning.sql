-- ============================================================================
-- A HAND REFUSED FOR LOST OWNERSHIP IS A WARNING, NOT A CRITICAL
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-02 21:00-21:20 UTC.
--
-- WHAT KEEPS THE LAUNCH GATE RED
--
-- fn_ca_midway_burnin_gate needs 24 h with no new critical row in
-- ca_drift_incidents. Since 2026-10-01 15:25 every lease-loss burst has filed
-- one: 10-01 15:25, 16:09, 16:28, 17:10, 17:48, 22:49, 23:14; 10-02 05:22,
-- 05:25, 05:50, 19:37:28 (525ed81f) and 20:53:56 (b36dc53f). Each is the
-- mirror of a postHandTasks.hand_history_failed alert whose context.error is
--
--     atomic hand commit refused (lease_proof_expired)
--
-- (one, 10-02 05:50, carries "(hand_lease_stale)"). That is the SAME refusal
-- the engine reports a few milliseconds earlier as
-- ServerTableEngine.authoritative_hand_semantic_refusal, which this trigger
-- has exempted since 2026-09-09 ("a refused hand is a rate, not an
-- incident"). runStep re-reports it under its own source, the postHandTasks.%
-- branch below reads moves_chips = true from the context, and the duplicate
-- lands on the money board as critical.
--
-- WHAT THE REFUSAL IS
--
-- ServerTableEngineSettlement.logHandHistory throws "atomic hand commit
-- refused (lease_proof_expired)" when hasCurrentEngineLeaseAuthority() is
-- false - BEFORE commitAuthoritativeHand is called, and again from
-- assertLeaseAuthority inside it. The engine cannot prove it still owns the
-- table, so it does not write the hand, kills that generation
-- (killForRestart) and a successor generation takes the table. At 20:53:53-57
-- the engine's PostgREST traffic stalled for ~15 s (edge origin_time 5-15 s for
-- every request started 20:53:36-51; hand_atomic_commits shows no commit
-- 20:53:36 -> 20:54:03; heartbeat_table_leases_v4 sent at :31, next at :46),
-- the 20 s proof window ran out, and 182 cash_lease_proof_expired + 87
-- tournament_lease_lost watchdog rebuilds fired in one second. 19:37:26 is the
-- same shape (commits stop 19:37:04 -> 19:37:23; PostgREST "Thread killed by
-- timeout manager" from 19:37:07; club_wallets rake contention, fixed by
-- 20261002200408). Neither burst is an engine release: the 19:55 and 20:55
-- maintenance breaks began after them (engine_maintenance_break_log).
--
-- MONEY. Every postHandTasks.hand_history_failed lease_proof_expired alert
-- since 2026-10-01 12:00 UTC, 812 of them, joined to hand_atomic_commits:
--   741  the successor committed the EXACT original hand (same hand_id) and
--        completed its post-commit obligations, max lag 25 min;
--        fn_resolve_settled_financial_alerts closed each on that receipt
--        (hand_outcome_resolution_v1.kind = exact_original_post_commit_complete).
--    71  never committed under that hand_id or hand number: rolled back whole,
--        no rake_records row, no chip_ledger leg, later hands carried the
--        stacks (closed by 20261002171245 on that evidence).
-- Not one moved a chip. All 24 of 20:53:5x and all 113 of 19:37 are in the
-- first group.
--
-- THE CHANGE
--
-- This duplicate files on the drift board as WARNING, not critical:
--   - only source postHandTasks.hand_history_failed, and only an error that
--     begins with exactly "atomic hand commit refused (lease_proof_expired)"
--     or "atomic hand commit refused (hand_lease_stale)";
--   - the incident is still opened (dedupe and folding unchanged), still
--     notifies, and still closes only when the alert it mirrors closes on its
--     receipt (zz_ca_alert_resolution_reaches_the_incident);
--   - while open it is an unresolved non-info unknown, so the gate's
--     no_unresolved_unknowns check stays red until the hand is proved
--     committed or proved rolled back. A refused hand that is never recovered
--     therefore still blocks the gate; one that recovers does not leave a
--     24-hour critical behind;
--   - the rate net fn_ca_hand_commit_refusals (>= 25 in 24 h) is untouched,
--     so a storm is still reported as a storm;
--   - every other postHandTasks.* failure, every other refusal reason
--     (stack mismatch, duplicate, seat missing, deadlock ...) and every other
--     source keeps its current severity.
-- The financial_alerts rows themselves are unchanged and stay critical.
--
-- Not changed: any wallet, seat, hand or ledger row. No chips move here.
--
-- @live-proof: (SELECT position('A HAND REFUSED FOR LOST OWNERSHIP IS A WARNING' in pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_src text; v_new text; v_anchor text; v_ins text; v_n int;
BEGIN
  IF NOT (current_user IN ('postgres','service_role','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_financial_alert_to_incident';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_financial_alert_to_incident not found'; END IF;

  IF position('A HAND REFUSED FOR LOST OWNERSHIP IS A WARNING' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; skipping the function';
    RETURN;
  END IF;

  v_anchor := $a$      WHEN NEW.source LIKE 'postHandTasks.%'
        THEN CASE WHEN lower(COALESCE(NEW.context->>'moves_chips','true')) IN ('false','f','0')$a$;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the postHandTasks severity branch appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
  END IF;

  v_ins := $i$      /* A HAND REFUSED FOR LOST OWNERSHIP IS A WARNING (2026-10-02). runStep
         re-reports the engine's own lease refusal - the one exempted above as
         authoritative_hand_semantic_refusal - under postHandTasks.hand_history_failed.
         The engine refused before writing (it could not prove it owns the
         table), so nothing moved; the successor commits the exact hand or it
         was never played (812 of 812 since 2026-10-01). Warning, not critical:
         it still opens, still pages, and stays an open unknown until the alert
         closes on its receipt. Exact reasons only; every other refusal and
         every other post-hand step keeps the branch below. */
      WHEN NEW.source = 'postHandTasks.hand_history_failed'
           AND split_part(COALESCE(NEW.context->>'error', ''), ')', 1)
               IN ('atomic hand commit refused (lease_proof_expired',
                   'atomic hand commit refused (hand_lease_stale')
        THEN 'warning'
$i$;
  v_new := replace(v_src, v_anchor, v_ins || v_anchor);
  IF v_new = v_src THEN RAISE EXCEPTION 'substitution produced no change'; END IF;
  EXECUTE v_new;

  PERFORM public.fn_ca_declare_guard_redefinition(
    'fn_ca_financial_alert_to_incident',
    'migration 20261002212049_a_hand_refused_for_lost_ownership_is_a_warning'
  );
END
$mig$;

-- Prove the edit landed where it must and that the reason match selects
-- exactly the two ownership refusals. (Behaviour was also proved before apply
-- in a rolled-back probe on production that inserted three alerts through the
-- trigger: lease_proof_expired -> warning, hand_lease_stale -> warning,
-- stack_mismatch -> critical.)
DO $prove$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure) INTO v_def;
  IF position($p$WHEN NEW.source = 'postHandTasks.hand_history_failed'$p$ in v_def) = 0
     OR position($p$THEN 'warning'$p$ in v_def) = 0 THEN
    RAISE EXCEPTION 'the warning branch is not in the live function';
  END IF;
  IF position($p$WHEN NEW.source = 'postHandTasks.hand_history_failed'$p$ in v_def)
     > position($p$WHEN NEW.source LIKE 'postHandTasks.%'$p$ in v_def) THEN
    RAISE EXCEPTION 'the warning branch must precede the postHandTasks.%% branch';
  END IF;
  IF split_part('atomic hand commit refused (lease_proof_expired)', ')', 1)
       <> 'atomic hand commit refused (lease_proof_expired'
     OR split_part('atomic hand commit refused (hand_lease_stale): receipt_detail_redacted', ')', 1)
       <> 'atomic hand commit refused (hand_lease_stale'
     OR split_part('atomic hand commit refused (stack_mismatch)', ')', 1)
       IN ('atomic hand commit refused (lease_proof_expired', 'atomic hand commit refused (hand_lease_stale')
     OR split_part('[DB] authoritative hand commit failed for table x hand #1 after 13 identical attempts: canceling statement due to statement timeout', ')', 1)
       IN ('atomic hand commit refused (lease_proof_expired', 'atomic hand commit refused (hand_lease_stale') THEN
    RAISE EXCEPTION 'the refusal-reason match does not select exactly the two ownership refusals';
  END IF;
END
$prove$;

COMMIT;
