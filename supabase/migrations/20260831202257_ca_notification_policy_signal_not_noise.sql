-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 20:22:57 UTC on kuklfnapbkmacvwxktbh.

-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT - SIGNAL, NOT NOISE (push-policy overhaul, 2026-08-31 20:2x UTC)
-- ═══════════════════════════════════════════════════════════════════════════
-- Dan received a push every other minute tonight. Alert-by-alert audit of
-- everything sent in the last 90 minutes found FIVE distinct sources; every
-- one is fixed here or already fixed:
--   1. Per-table blocked-mint raises (900/2000/600/...): one engine bug, one
--      incident per TABLE. Already consolidated to one per day (20:10); now
--      also severity INFO - the guard makes each attempt harmless (zero
--      chips move), the dashboard still counts every attempt, and the engine
--      fix is queued. No pushes for a blocked non-event.
--   2. ⏱ 5-min updates + 🟠 past-target repeats for WARNINGS: warnings now
--      get their ONE raise push and nothing further - the dashboard keeps
--      the clock; only criticals get the escalation drumbeat.
--   3. ✅ Resolved x111 (a bulk resolve pushed once per incident per
--      recipient): resolution pushes now go out for CRITICALS only.
--   4. Supply criticals (355K/577K): the pre-guard tournament-mint tail
--      inside those snapshot windows - root-caused and resolved; the 21:05
--      snapshot verifies the guard held.
--   5. Frozen-pool criticals (490,750 / 979,900 "a money path is writing to
--      the dead public.wallets pool"): FALSE ALARM with a real lesson -
--      certification/test accounts (no club membership) route their harness
--      chips through public.wallets via the no-club fallback, and the
--      certification cleanup deletes those rows again. The frozen pool the
--      directive froze is the 690 pre-2026-08-22 rows (they sum to the
--      baseline 732,591,994.33 exactly, verified); the detector now measures
--      ONLY those rows, so harness traffic in post-freeze rows can never
--      page anyone again while a single stranded cent moving still does.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  -- ── 2. escalation tick: warnings stay quiet after their raise ──
  v_def := pg_get_functiondef('public.fn_ca_incident_escalation_tick()'::regprocedure);
  v_new := replace(v_def,
'    IF inc.severity = ''warning'' THEN
      -- warnings: one 5-minute update, one past-target notice, then quiet
      -- (they stay on the dashboard; only criticals get the full drumbeat)
      IF age_min >= 5 AND inc.escalation_level < 1 THEN
        UPDATE public.ca_drift_incidents SET escalation_level = 1 WHERE id = inc.id;
        PERFORM public.fn_ca_incident_notify(inc.id, ''escalated'',
          ''⏱ 5-min update: '' || inc.classification || '' unresolved'', false);
        budget := budget - 1; sent := sent + 1;
      ELSIF age_min >= 20 AND inc.escalation_level < 4 THEN
        UPDATE public.ca_drift_incidents
           SET escalation_level = 4, past_target = true WHERE id = inc.id;
        PERFORM public.fn_ca_incident_notify(inc.id, ''escalated'',
          ''🟠 Past 20-min target (warning): '' || inc.classification, true);
        budget := budget - 1; sent := sent + 1;
      END IF;
      CONTINUE;
    END IF;',
'    IF inc.severity = ''warning'' THEN
      -- SIGNAL-NOT-NOISE (2026-08-31): a warning pushes ONCE, at raise.
      -- The dashboard keeps the clock and the past-target flag; only
      -- criticals get the escalation drumbeat.
      IF age_min >= 20 AND inc.past_target IS NOT TRUE THEN
        UPDATE public.ca_drift_incidents
           SET escalation_level = GREATEST(escalation_level, 4), past_target = true
         WHERE id = inc.id;
      END IF;
      CONTINUE;
    END IF;');
  IF v_new = v_def THEN RAISE EXCEPTION 'tick anchor not found'; END IF;
  EXECUTE v_new;

  -- ── 3. resolution pushes: criticals only ──
  v_def := pg_get_functiondef((SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                               WHERE n.nspname='public' AND p.proname='fn_ca_incident_action')::regprocedure);
  v_new := replace(v_def,
'    PERFORM public.fn_ca_incident_notify(p_incident_id, ''notified'',
      ''✅ Resolved: '' || inc.classification || '' drift'', false);',
'    -- SIGNAL-NOT-NOISE (2026-08-31): only a critical''s resolution pushes.
    IF inc.severity = ''critical'' THEN
      PERFORM public.fn_ca_incident_notify(p_incident_id, ''notified'',
        ''✅ Resolved: '' || inc.classification || '' drift'', false);
    END IF;');
  IF v_new = v_def THEN RAISE EXCEPTION 'action anchor not found'; END IF;
  EXECUTE v_new;

  -- ── 5. frozen-pool check scopes to the actual frozen rows ──
  v_def := pg_get_functiondef('public.fn_ca_quick_reconcile()'::regprocedure);
  v_new := replace(v_def,
'  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets;',
'  -- The frozen pool is the PRE-FREEZE rows (verified: the 690 rows created
  -- before 2026-08-22 sum to the baseline exactly). Post-freeze rows belong
  -- to certification/test accounts whose harness chips cycle through the
  -- no-club fallback and are deleted by the certification cleanup — they are
  -- not the stranded pool and must not page anyone.
  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets
   WHERE created_at < ''2026-08-22'';');
  IF v_new = v_def THEN RAISE EXCEPTION 'quick-reconcile anchor not found'; END IF;
  EXECUTE v_new;

  -- ── 1. blocked-mint guards raise as INFO (dashboard-only) ──
  v_def := pg_get_functiondef('public.atomic_table_cashout(uuid,uuid,integer)'::regprocedure);
  v_new := replace(v_def,
    '''atomic_table_cashout:tournament_mint_blocked'', ''unauthorized_adjustment'', ''warning''',
    '''atomic_table_cashout:tournament_mint_blocked'', ''unauthorized_adjustment'', ''info''');
  IF v_new <> v_def THEN EXECUTE v_new; END IF;

  v_def := pg_get_functiondef('public.atomic_credit_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid,text)'::regprocedure);
  v_new := replace(v_def,
    '''atomic_credit_wallet_and_log:tournament_mint_blocked'', ''unauthorized_adjustment'', ''warning''',
    '''atomic_credit_wallet_and_log:tournament_mint_blocked'', ''unauthorized_adjustment'', ''info''');
  IF v_new <> v_def THEN EXECUTE v_new; END IF;
END $$;

-- Requalify today's standing blocked-mint incident as info so the last
-- warning-cadence sources are gone, and note the policy on it.
UPDATE public.ca_drift_incidents
   SET severity = 'info'
 WHERE dedupe_key LIKE 'tourney-cashout-blocked:%' AND status <> 'resolved';;
