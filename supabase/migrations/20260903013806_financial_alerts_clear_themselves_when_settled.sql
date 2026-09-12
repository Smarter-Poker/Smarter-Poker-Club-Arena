-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260903013806; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260903013806   (the stamp IS the apply time, UTC: 2026-09-03 01:38:06)
--   name        financial_alerts_clear_themselves_when_settled
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 6901 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260903013806 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_resolve_settled_financial_alerts
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

-- ============================================================================
-- AN ALERT THAT CANNOT CLEAR ITSELF IS NOT AN ALERT
-- 2026-09-02
-- ============================================================================
--
-- WHAT WAS ACTUALLY WRONG
--
-- financial_alerts held 985 unresolved rows, 545 of them raised in a single
-- day. An audit earlier today read the 64 `earner_not_paid` alerts as 57
-- players owed 836.79 chips and nearly settled them. Checking each player
-- against wallet_transactions first showed the opposite:
--
--   all 64 alerts .................. player has since been credited
--   still genuinely short .......... 0 players, 0.00 chips
--   credited in total .............. 1,185.78 against 836.79 "owed"
--   paid AFTER the alert fired ..... 53 of 64, median 777 seconds later
--
-- `fn_payout_guarantee_check` runs at :18 and raises an alert for every place
-- not yet credited. `fn_tournament_payout_sweep` runs at :52 and pays them.
-- The check has no idea the sweep exists, so it accuses, the sweep settles
-- thirteen minutes later, and the accusation stands for ever. Paying those 64
-- would have been a 836.79-chip double-pay -- the exact hazard
-- fn_pay_backed_payout_shortfalls documents in its own comments.
--
-- The second class is different but has the same shape. 136 alerts from
-- fn_tournament_payout_reconcile carry only `overpaid` issues, whose own
-- context says "reported only; automatic clawback is deliberately not done" --
-- CLAUDE.md 10.6 rule 3 forbids taking it back. Nothing will EVER action them,
-- so they are unresolved for ever by construction.
--
-- Together those two classes are ~200 of the 985. They are noise that buries
-- signal: a real unpaid player today would arrive in a list of 985 criticals
-- and look exactly like the 64 that are already fine.
--
-- WHAT THIS DOES
--
-- Adds one resolver that closes an alert ONLY when the condition it was raised
-- about is provably no longer true, and wires it into the schedule that
-- already exists. It never resolves anything on a timer, an age or a guess --
-- every close is justified from rows, and the justification is written into
-- the alert's own context so it can be audited later.
--
-- NO NEW SCHEDULE. CLAUDE.md 11.3 forbids new pg_cron jobs. The existing
-- `ca-payout-guarantee-check-hourly` job is amended to run the resolver
-- immediately after the check it belongs to -- same job, same schedule.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_resolve_settled_financial_alerts(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_paid      integer := 0;
  v_overpaid  integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';
BEGIN
  -- ── CLASS 1: the player was accused of being unpaid and has since been paid.
  -- Proven per alert against wallet_transactions, not assumed from elapsed
  -- time. `short` is what the check said they were owed; `got` is what the
  -- prize path actually credited them for that same event.
  SELECT array_agg(id) INTO v_paid_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'fn_payout_guarantee_check'
       AND a.context->>'kind' = 'earner_not_paid'
       AND a.context->>'user_id' IS NOT NULL
       AND a.context->>'tournament_id' IS NOT NULL
       AND COALESCE((
             SELECT sum(w.amount) FROM public.wallet_transactions w
              WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                AND w.user_id           = (a.context->>'user_id')::uuid
                AND w.type = 'credit' AND w.category = 'prize'
           ), 0) >= COALESCE((a.context->>'short')::numeric, 0) - 0.01
     LIMIT p_limit
  ) s;
  v_paid := COALESCE(array_length(v_paid_ids, 1), 0);

  -- ── CLASS 2: every issue on the alert is an overpay, which 10.6 rule 3 says
  -- is absorbed and never clawed back. There is no action left to take, so
  -- "unresolved" is a false state. An alert carrying ANY other issue kind is
  -- deliberately left open.
  SELECT array_agg(id) INTO v_over_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'fn_tournament_payout_reconcile'
       AND jsonb_typeof(a.context->'issues') = 'array'
       AND jsonb_array_length(a.context->'issues') > 0
       AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(a.context->'issues') i
              WHERE i->>'issue' IS DISTINCT FROM 'overpaid')
     LIMIT p_limit
  ) s;
  v_overpaid := COALESCE(array_length(v_over_ids, 1), 0);

  IF p_apply THEN
    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'settled after the alert was raised; the prize path credited this player for this event',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now(),
             'credited', COALESCE((
               SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w
                WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                  AND w.user_id           = (a.context->>'user_id')::uuid
                  AND w.type = 'credit' AND w.category = 'prize'), 0))
     WHERE a.id = ANY(v_paid_ids);

    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'overpay only; absorbed by the house per CLAUDE.md 10.6 rule 3, never clawed back',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_over_ids);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', p_apply,
    'settled_after_alert', v_paid,
    'overpay_absorbed', v_overpaid,
    'total', v_paid + v_overpaid,
    'still_unresolved', (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)
  );
END;
$fn$;

COMMENT ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) IS
  'Closes financial_alerts whose condition is provably no longer true: an accused-unpaid player the prize path has since credited, and reconciler alerts carrying only overpay (10.6 rule 3, never clawed back). Never resolves on age or guess. Added 2026-09-02 after 64 stale alerts nearly caused an 836.79 chip double-pay.';

REVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) TO service_role;
