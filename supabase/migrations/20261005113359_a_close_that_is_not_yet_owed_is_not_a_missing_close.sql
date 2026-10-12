-- ===========================================================================
--  A CLOSE THAT IS NOT YET OWED IS NOT A MISSING CLOSE
--  (and a locked Spin tier is not an advertising fault)
-- ===========================================================================
--
-- Three detectors answered "broken" about states the platform produces on
-- purpose. Each is fixed at the line that produced the false finding; none
-- loses its ability to report the real fault it exists for (CLAUDE.md 10.11,
-- 10.86 rule 1). Read on production 2026-10-05.
--
-- 1. fn_union_credit_risk_check, invariant union_eco_not_recorded (also read
--    by fn_union_governance_check). It asked for a union_eco_ledger row for
--    the week that ended at this week's boundary from the instant the week
--    ended. That row is written by the weekly close, which is due at
--    fn_union_accounting_run_at (04:00 Chicago, 09:00 UTC today) and this week
--    is held further by an accounting_close_gates row until 2026-10-06 13:00
--    UTC ("Close transactions over 5 minutes expire tournament leases during
--    play ... The close runs at the quiet hour", coordinator decision
--    2026-10-03). fn_ca_conservation_sweep filed two ledger_imbalance
--    incidents for it at 07:52 (33554dc5, 82e4c285) that no money explains.
--    Now the row is asked for once the close is owed: past its run time, no
--    gate holding its first attempt, and not running. A gated close whose
--    gate has passed without starting, an older week, and a finished close
--    with no row all still report.
--
-- 2. fn_union_treasury_selftest, check lapsed_week_unclosed. Same premise,
--    same fix, for the union_rakeback_log of the just-closed week only: a
--    week older than that still breaches at once. Its 2026-08-24 alert has
--    been held open ever since, and today's gated week reads as the same
--    breach.
--
-- 3. fn_spin_fairness_check, verdict tiers_locked. It warned that "the odds
--    sheet shown at buy-in advertises the full ladder with no availability
--    qualification". That sheet was removed on 2026-09-05 by Dan's ruling
--    ("HIDE THE MULTIPLIER ODDS ... NOBODY SHOULD EVER VISIBLY SEE THAT";
--    tests/unit/spinOddsOnBuyInSheet.test.ts keeps it out). The wheel draws a
--    locked tier as LOCKED with its unlock threshold and the lobby badge reads
--    v_spin_tier_availability. Measured 2026-10-05 over 7 days: 96,309 draws,
--    16,857 from a reduced ladder, chi-square 5.67 on 7 df (p01 18.48),
--    expectation 2.7550 against 2.7600 published, z -0.96, nothing off the
--    ladder. The verdict is still returned; it no longer raises. And the
--    branch no longer shadows distribution_warning, which is now read first.
--
-- No money moves, no row is written or deleted, no schedule changes (10.12).
-- The resolution of the alerts and incidents these produced is a separate,
-- later migration, 20261005113407, which asserts the corrected readings.
--
-- HOW: exact substitution through the pg_temp helper of 20261004224309,
-- preimage md5 pinned, each anchor proved to occur exactly once, postimage
-- md5 computed read-only on production, owner/security/settings/grants
-- asserted unmoved. The ECO predicate was evaluated read-only against the
-- live rows first: zero findings.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_credit_risk_check()'::regprocedure)) = '2084a5cb1b27c36df2b7512a168694db' AND md5(pg_get_functiondef('public.fn_union_treasury_selftest()'::regprocedure)) = '1f31f451e801a2d196c71822e97a13fe' AND md5(pg_get_functiondef('public.fn_spin_fairness_check(integer)'::regprocedure)) = '7020ab8e6d565b3aa1884a5252364e49')

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


-- 1. THE ECO INVARIANT ------------------------------------------------------

SELECT pg_temp.ca_audit_subst(
  'public.fn_union_credit_risk_check()',
  '7ce95babaa3a484d0ad37f6f46f05f8c', '2084a5cb1b27c36df2b7512a168694db',
  ARRAY[$o$                        AND l.period_start >= fn_union_week_start() - interval '7 days')
$o$],
  ARRAY[$n$                        AND l.period_start >= fn_union_week_start() - interval '7 days')
     -- A WEEK'S ECO ROW IS WRITTEN AT ITS CLOSE, SO IT IS ASKED FOR ONCE THE
     -- CLOSE IS OWED (2026-10-05). Before the close's run time
     -- (fn_union_accounting_run_at), while an accounting_close_gates row holds
     -- the first attempt for a quiet hour, and while the close is running, the
     -- row cannot exist yet. On 2026-10-05 this filed two ledger_imbalance
     -- incidents at 07:52 for a close gated until 2026-10-06 13:00 by the
     -- coordinator decision of 2026-10-03. A close that is owed and has not
     -- written the row - past its run time, no gate holding it, nothing
     -- running - is still found, and so is a finished close without one.
     -- Migration 20261005113359.
     AND NOT (now() < fn_union_accounting_run_at(fn_union_week_start())
              OR EXISTS (SELECT 1 FROM accounting_close_gates g
                          WHERE g.scope_kind = 'union' AND g.scope_id = un.id
                            AND g.period_end = fn_union_week_start()
                            AND g.gate_until > now()
                            AND NOT EXISTS (SELECT 1 FROM union_accounting_runs r
                                             WHERE r.scope_kind = 'union' AND r.scope_id = un.id
                                               AND r.period_start = g.period_start
                                               AND r.period_end = g.period_end))
              OR EXISTS (SELECT 1 FROM union_accounting_runs q
                          WHERE q.scope_kind = 'union' AND q.scope_id = un.id
                            AND q.period_end = fn_union_week_start()
                            AND q.status = 'running'))
$n$]);

-- 2. THE TREASURY SELFTEST ------------------------------------------------

SELECT pg_temp.ca_audit_subst(
  'public.fn_union_treasury_selftest()',
  '612adc514addbb39e9015a094e68048e', '1f31f451e801a2d196c71822e97a13fe',
  ARRAY[$o$    IF COALESCE(v_lapsed_unclosed, false)
       AND EXISTS (SELECT 1 FROM union_wallet_transactions
$o$],
  ARRAY[$n$    IF COALESCE(v_lapsed_unclosed, false)
       /* THE JUST-CLOSED WEEK IS NOT LAPSED BEFORE ITS CLOSE IS OWED
          (2026-10-05). When the only week outstanding is the one that ended at
          this week's boundary, its close may not have run yet: before its run
          time (fn_union_accounting_run_at), while accounting_close_gates holds
          its first attempt for a quiet hour, or while it is running. An older
          week left open, or this week once its close is owed and has not
          happened, still breaches. Migration 20261005113359. */
       AND NOT ((SELECT MAX(period_end) FROM union_rakeback_log WHERE union_id = v_u.union_id)
                  >= public.fn_union_week_start(now()) - interval '7 days'
                AND (now() < public.fn_union_accounting_run_at(public.fn_union_week_start(now()))
                     OR EXISTS (SELECT 1 FROM public.accounting_close_gates g
                                 WHERE g.scope_kind = 'union' AND g.scope_id = v_u.union_id
                                   AND g.period_end = public.fn_union_week_start(now())
                                   AND g.gate_until > now()
                                   AND NOT EXISTS (SELECT 1 FROM public.union_accounting_runs r
                                                    WHERE r.scope_kind = 'union' AND r.scope_id = v_u.union_id
                                                      AND r.period_start = g.period_start
                                                      AND r.period_end = g.period_end))
                     OR EXISTS (SELECT 1 FROM public.union_accounting_runs q
                                 WHERE q.scope_kind = 'union' AND q.scope_id = v_u.union_id
                                   AND q.period_end = public.fn_union_week_start(now())
                                   AND q.status = 'running')))
       AND EXISTS (SELECT 1 FROM union_wallet_transactions
$n$]);

-- 3. THE SPIN FAIRNESS CHECK ----------------------------------------------

SELECT pg_temp.ca_audit_subst(
  'public.fn_spin_fairness_check(integer)',
  'd426f638c31989cbef1f5619d165b64e', '7020ab8e6d565b3aa1884a5252364e49',
  ARRAY[$o$  ELSIF v_locked > 0 THEN
    v_verdict  := 'tiers_locked';
    v_severity := 'warning';
    v_message  := format(
      '%s Spin(s) drew from a reduced ladder in the last %s day(s). The odds '
      'sheet shown at buy-in advertises the full ladder with no availability '
      'qualification.', v_locked, v_days);

  ELSIF v_n >= 2000 AND v_chi > v_crit_01 THEN
    v_verdict  := 'distribution_warning';
    v_severity := 'warning';
    v_message  := format(
      'Spin draw distribution is drifting from the published ladder: '
      'chi-square %s on %s df over %s draws (p < 0.01).',
      round(v_chi, 2), v_df, v_n::bigint);
$o$],
  ARRAY[$n$  ELSIF v_n >= 2000 AND v_chi > v_crit_01 THEN
    v_verdict  := 'distribution_warning';
    v_severity := 'warning';
    v_message  := format(
      'Spin draw distribution is drifting from the published ladder: '
      'chi-square %s on %s df over %s draws (p < 0.01).',
      round(v_chi, 2), v_df, v_n::bigint);

  ELSIF v_locked > 0 THEN
    /* A LOCKED TIER IS SHOWN WHERE IT IS DRAWN (2026-10-05). This branch
       warned that the odds sheet shown at buy-in advertised the full ladder
       with no availability qualification. That sheet was removed on
       2026-09-05 (Dan: nobody ever sees the odds; the buy-in sheet has no
       render path for them and tests/unit/spinOddsOnBuyInSheet.test.ts keeps
       it so). The wheel draws each locked tier as LOCKED with its unlock
       threshold, and the lobby badge reads v_spin_tier_availability, the
       draw's own arithmetic. A lock is the reserve gate working as designed
       (eligibleSpinTiers), so it is reported in the returned context and not
       raised. Every verdict that measures the money the player was promised -
       off_ladder, distribution_critical, expectation_drift and
       distribution_warning - keeps its severity, and distribution_warning is
       now read before this branch instead of being shadowed by it.
       Migration 20261005113359. */
    v_verdict  := 'tiers_locked';
$n$]);

COMMIT;
