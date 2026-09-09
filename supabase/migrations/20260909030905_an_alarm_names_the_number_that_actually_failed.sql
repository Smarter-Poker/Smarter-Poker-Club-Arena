-- 20260909030905_an_alarm_names_the_number_that_actually_failed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  AN ALARM MUST NAME THE NUMBER THAT ACTUALLY FAILED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_union_treasury_selftest` files a CRITICAL financial alert reading:
--
--     UNION TREASURY CONSERVATION BREACH:
--       [{"check":"bbj_pool_conservation_drift","drift_from_baseline":"70795.11"}]
--
-- 70,795.11 is not what failed, and it is not missing chips. It is a CLOSED
-- historical figure that `fn_bbj_conservation_check` explains in its own
-- payload: two ledgers with different start dates, `bbj_contributions` from
-- 2026-03-03 and `bbj_payouts` from 2026-07-22, with forty jackpots paid in
-- between (71,749.31) and 1,000.00 of opening seed. Its `lifetime_healthy` is
-- TRUE and both live signals - `paid_without_a_payout_row_since` and
-- `moved_since_resolution` - are 0.00.
--
-- What actually failed is the EPOCH check:
--
--     'healthy', v_epoch_at IS NOT NULL AND abs(v_epoch_unexp) <= v_tol
--
-- `unexplained_since_opening` is 3.15 against a tolerance of 1.00, measured
-- from the epoch opened 2026-09-04. That is a real 3.15-chip drift and it is
-- worth someone's attention - but nobody reading the alert would ever find it,
-- because the alert hands them a 70,795.11 phantom to chase instead.
--
-- This is CLAUDE.md 10.86: a signal that answers confidently with something it
-- was not asked. The check is right; the report is wrong. An alarm that names
-- the wrong number is worse than no alarm, because the first investigation
-- ends in "that figure is explained" and the next one is not opened.
--
-- The breach now carries the epoch numbers that decided it, and keeps the
-- lifetime drift beside them clearly labelled as context rather than cause.
--
-- HOW THIS EDITS THE FUNCTION. `fn_union_treasury_selftest` carries many
-- checks; retyping it to change one risks dropping another. This reads the LIVE
-- definition, does one literal replace, and refuses to proceed if the anchor is
-- absent or if any sibling check goes missing from the result - the pattern
-- 20260828041248_the_union_law_check_follows_the_money.sql established for this
-- class of edit. Anchor uniqueness was verified read-only first (exactly one).
--
-- ROLLBACK
--   Reverse the replace below; both halves are quoted in full.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_old CONSTANT text :=
'v_breaches := v_breaches || jsonb_build_object(''check'', ''bbj_pool_conservation_drift'',
      ''drift_from_baseline'', v_cons->>''drift_from_baseline'');';
  v_repl CONSTANT text :=
'v_breaches := v_breaches || jsonb_build_object(''check'', ''bbj_pool_conservation_drift'',
      -- The numbers that DECIDED this breach. `healthy` is
      -- `abs(unexplained_since_opening) <= tolerance`, so these two are the
      -- cause; the lifetime drift below is context and is explained in the
      -- check''s own `lifetime.note`.
      ''unexplained_since_opening'', v_cons->''epoch''->>''unexplained_since_opening'',
      ''tolerance'', v_cons->>''tolerance'',
      ''epoch_opened_at'', v_cons->''epoch''->>''opened_at'',
      ''lifetime_healthy'', v_cons->>''lifetime_healthy'',
      ''moved_since_resolution'', v_cons->''lifetime''->>''moved_since_resolution'',
      ''paid_without_a_payout_row_since'', v_cons->''lifetime''->>''paid_without_a_payout_row_since'',
      ''context_lifetime_drift_from_baseline'', v_cons->>''drift_from_baseline'');';
BEGIN
  v_src := pg_get_functiondef('public.fn_union_treasury_selftest()'::regprocedure);

  IF position(v_old in v_src) = 0 THEN
    RAISE EXCEPTION
      'the bbj_pool_conservation_drift breach is not in the live definition in the shape this migration expects; read it before re-running';
  END IF;

  v_new := replace(v_src, v_old, v_repl);

  IF position('unexplained_since_opening' in v_new) = 0
     OR position('context_lifetime_drift_from_baseline' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;

  -- Every sibling check must survive the edit.
  IF position('negative_bbj_pool_balance' in v_new) = 0
     OR position('rakeback_settler_lagging' in v_new) = 0
     OR position('retired_pools_hold_money' in v_new) = 0 THEN
    RAISE EXCEPTION 'a check went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

-- Grants restated, unchanged: postgres + service_role. This is the engine's own
-- treasury sentinel and no browser role has ever been able to call it. PUBLIC is
-- named alongside the browser roles on purpose - revoking a role while PUBLIC
-- still holds the grant reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_union_treasury_selftest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_treasury_selftest() TO service_role;

COMMIT;
