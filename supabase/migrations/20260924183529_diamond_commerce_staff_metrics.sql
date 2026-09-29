-- 20260924183529_diamond_commerce_staff_metrics.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2) section 7.5: "Measure payment
-- success/ambiguity, duplicate-suppressed attempts, pending fulfillment age,
-- due-renewal lag, refund age, sponsorship utilization and accounting
-- postcondition failures ... Keep actual net paid diamonds separate from
-- retries, waivers, proposed quotes and refunds."
--
-- ONE new staff-only read, fn_ca_commerce_metrics(p_days), printed on the
-- Commerce Desk's Metrics tab. No table, no write, no cron, no change to any
-- existing door. It reads only the commerce tables that already record these
-- facts, and reports only what they record:
--
--   quotes         priced in the window, and what became of them (consumed,
--                  still open, expired by status or by time, withdrawn). The
--                  diamonds they proposed are reported apart from what was paid.
--   purchases      committed in the window. Net paid diamonds count only
--                  receipts that charged (net > 0); zero-net receipts (a
--                  credit or waiver covered them) are counted, never summed as
--                  paid. The trial waiver on a receipt and sponsor-paid
--                  diamonds are reported separately, and so is each kind.
--   trial waivers  free-month rights granted in the window (entitlements with
--                  source 'trial'): scopes, distinct trials, and their paid
--                  diamonds, which the table pins at zero.
--   refunds        committed refunds in the window (gross, debt settled, added
--                  to balance), separate from purchases; refund requests by
--                  current state, with the oldest awaiting a decision and the
--                  oldest approved or owed awaiting execution (refund age and
--                  pending fulfillment age).
--   renewals       authorized mandates now due and the oldest overdue lag;
--                  mandates needing attention; renewal outcomes in the window.
--   sponsorships   active and in effect now: budget against committed.
--   notices        due but undelivered (not suppressed) and the oldest age;
--                  still scheduled; suppressed in the window.
--   duplicates     what is recorded: a refund execution the core answered as a
--                  replay (refund_request_executed, detail is_replay true) and
--                  a renewal debit refused as a reused reference. A purchase
--                  replay is answered from its receipt and writes nothing, so
--                  it is reported as not recorded, never estimated.
--   postconditions accounting postcondition failures the consumers record: a
--                  renewal needing attention for journal_unproved,
--                  register_unproved or lots_unproved, and a refund execution
--                  owed for refund_journal_unproved, refund_register_unproved
--                  or refund_not_exact. An owner's own purchase that fails a
--                  postcondition rolls back whole and records nothing.
--   retries        consumer claims beyond the first on refund requests made in
--                  the window and on mandates updated in it.
--
-- Staff only (service role or fn_is_platform_admin), refused as
-- staff_required, exactly like fn_ca_commerce_admission_report. The window is
-- clamped to 1 to 90 days. Ages are whole hours, floored.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- The database refuses DDL inside the hourly break window (:50 to :03 UTC).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. The baseline: every table and column read below exists, and the read
-- does not (a second apply refuses here and changes nothing).
-- ---------------------------------------------------------------------------
DO $baseline$
BEGIN
  IF to_regprocedure('public.fn_ca_commerce_metrics(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'commerce baseline changed: fn_ca_commerce_metrics already exists';
  END IF;
  IF to_regclass('public.ca_commerce_quotes') IS NULL
     OR to_regclass('public.ca_commerce_purchases') IS NULL
     OR to_regclass('public.ca_commerce_refunds') IS NULL
     OR to_regclass('public.ca_commerce_refund_requests') IS NULL
     OR to_regclass('public.ca_commerce_renewal_mandates') IS NULL
     OR to_regclass('public.ca_commerce_sponsorships') IS NULL
     OR to_regclass('public.ca_commerce_events') IS NULL
     OR to_regclass('public.ca_commerce_notices') IS NULL
     OR to_regclass('public.ca_commerce_entitlements') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ca_commerce_notices' AND column_name = 'suppressed_at')
     OR to_regprocedure('public.fn_is_platform_admin()') IS NULL THEN
    RAISE EXCEPTION 'commerce baseline changed: this read needs 20260922143541 through 20260924102040 installed first';
  END IF;
END $baseline$;

-- ---------------------------------------------------------------------------
-- 1. The read.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_metrics(p_days integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 90);
  v_now timestamptz := now();
  v_since timestamptz;
  v_quotes jsonb;
  v_purchases jsonb;
  v_trials jsonb;
  v_refunds jsonb;
  v_requests jsonb;
  v_renewals jsonb;
  v_sponsorships jsonb;
  v_notices jsonb;
  v_duplicates jsonb;
  v_postconditions jsonb;
  v_retries jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  v_since := v_now - make_interval(days => v_days);

  -- Quotes priced in the window. An open quote past its expiry is expired
  -- (the purchase door marks it so lazily); the diamonds are only proposed.
  SELECT jsonb_build_object(
           'priced', count(*),
           'proposed_diamonds', COALESCE(sum(q.net), 0),
           'consumed', count(*) FILTER (WHERE q.status = 'consumed'),
           'open', count(*) FILTER (WHERE q.status = 'open' AND q.expires_at > v_now),
           'expired', count(*) FILTER (WHERE q.status = 'expired' OR (q.status = 'open' AND q.expires_at <= v_now)),
           'withdrawn', count(*) FILTER (WHERE q.status = 'withdrawn'))
    INTO v_quotes
    FROM public.ca_commerce_quotes q
   WHERE q.created_at >= v_since;

  -- Receipts committed in the window. Paid is net > 0 only.
  SELECT jsonb_build_object(
           'committed', count(*),
           'paid', count(*) FILTER (WHERE p.net > 0),
           'zero_net', count(*) FILTER (WHERE p.net = 0),
           'net_paid_diamonds', COALESCE(sum(p.net) FILTER (WHERE p.net > 0), 0),
           'sponsored_net_diamonds', COALESCE(sum(p.net) FILTER (WHERE p.net > 0 AND p.sponsorship_id IS NOT NULL), 0),
           'trial_waiver_diamonds', COALESCE(sum(p.trial_waiver), 0),
           'by_kind', jsonb_build_object(
             'purchase', jsonb_build_object('committed', count(*) FILTER (WHERE p.kind = 'purchase'),
                                            'net_paid_diamonds', COALESCE(sum(p.net) FILTER (WHERE p.kind = 'purchase' AND p.net > 0), 0)),
             'upgrade', jsonb_build_object('committed', count(*) FILTER (WHERE p.kind = 'upgrade'),
                                           'net_paid_diamonds', COALESCE(sum(p.net) FILTER (WHERE p.kind = 'upgrade' AND p.net > 0), 0)),
             'renewal', jsonb_build_object('committed', count(*) FILTER (WHERE p.kind = 'renewal'),
                                           'net_paid_diamonds', COALESCE(sum(p.net) FILTER (WHERE p.kind = 'renewal' AND p.net > 0), 0))))
    INTO v_purchases
    FROM public.ca_commerce_purchases p
   WHERE p.created_at >= v_since;

  -- Free-month rights granted in the window: a waiver, never a payment.
  SELECT jsonb_build_object(
           'scopes', count(*),
           'trials', count(DISTINCT e.trial_id),
           'net_paid_diamonds', COALESCE(sum(e.net_paid), 0))
    INTO v_trials
    FROM public.ca_commerce_entitlements e
   WHERE e.source = 'trial' AND e.created_at >= v_since;

  SELECT jsonb_build_object(
           'committed', count(*),
           'gross_diamonds', COALESCE(sum(r.gross), 0),
           'debt_settled_diamonds', COALESCE(sum(r.debt_settled), 0),
           'added_to_balance_diamonds', COALESCE(sum(r.net_increase), 0))
    INTO v_refunds
    FROM public.ca_commerce_refunds r
   WHERE r.created_at >= v_since;

  -- Refund requests in their current state, all time: the queue staff own.
  SELECT jsonb_build_object(
           'by_state', jsonb_build_object(
             'requested', count(*) FILTER (WHERE r.state = 'requested'),
             'approved', count(*) FILTER (WHERE r.state = 'approved'),
             'owed', count(*) FILTER (WHERE r.state = 'owed'),
             'refunded', count(*) FILTER (WHERE r.state = 'refunded'),
             'declined', count(*) FILTER (WHERE r.state = 'declined'),
             'failed', count(*) FILTER (WHERE r.state = 'failed')),
           'awaiting_decision', count(*) FILTER (WHERE r.state = 'requested'),
           'oldest_awaiting_decision_at', min(r.created_at) FILTER (WHERE r.state = 'requested'),
           'oldest_awaiting_decision_hours', floor(extract(epoch FROM v_now - min(r.created_at) FILTER (WHERE r.state = 'requested')) / 3600)::integer,
           'awaiting_execution', count(*) FILTER (WHERE r.state IN ('approved','owed')),
           'awaiting_execution_diamonds', COALESCE(sum(r.approved_amount) FILTER (WHERE r.state IN ('approved','owed')), 0),
           'oldest_awaiting_execution_at', min(r.decided_at) FILTER (WHERE r.state IN ('approved','owed')),
           'oldest_awaiting_execution_hours', floor(extract(epoch FROM v_now - min(r.decided_at) FILTER (WHERE r.state IN ('approved','owed'))) / 3600)::integer)
    INTO v_requests
    FROM public.ca_commerce_refund_requests r;

  -- Standing authorizations now, and what the consumer did in the window.
  SELECT jsonb_build_object(
           'authorized', count(*) FILTER (WHERE m.state = 'authorized'),
           'due_now', count(*) FILTER (WHERE m.state = 'authorized' AND m.due_at <= v_now),
           'oldest_due_at', min(m.due_at) FILTER (WHERE m.state = 'authorized' AND m.due_at <= v_now),
           'oldest_overdue_hours', floor(extract(epoch FROM v_now - min(m.due_at) FILTER (WHERE m.state = 'authorized' AND m.due_at <= v_now)) / 3600)::integer,
           'needs_attention', count(*) FILTER (WHERE m.state = 'needs_attention'))
    INTO v_renewals
    FROM public.ca_commerce_renewal_mandates m;
  v_renewals := v_renewals || (
    SELECT jsonb_build_object(
             'renewed', count(*) FILTER (WHERE ev.kind = 'renewal_renewed'),
             'not_completed', count(*) FILTER (WHERE ev.kind = 'renewal_needs_attention'))
      FROM public.ca_commerce_events ev
     WHERE ev.occurred_at >= v_since AND ev.kind IN ('renewal_renewed','renewal_needs_attention'));

  SELECT jsonb_build_object(
           'active', count(*),
           'budget_diamonds', COALESCE(sum(s.total_budget), 0),
           'committed_diamonds', COALESCE(sum(s.committed), 0))
    INTO v_sponsorships
    FROM public.ca_commerce_sponsorships s
   WHERE s.state = 'active' AND s.effective_from <= v_now AND (s.effective_to IS NULL OR s.effective_to > v_now);

  SELECT jsonb_build_object(
           'undelivered_due', count(*) FILTER (WHERE n.delivered_at IS NULL AND n.suppressed_at IS NULL AND n.due_at <= v_now),
           'oldest_undelivered_due_at', min(n.due_at) FILTER (WHERE n.delivered_at IS NULL AND n.suppressed_at IS NULL AND n.due_at <= v_now),
           'oldest_undelivered_hours', floor(extract(epoch FROM v_now - min(n.due_at) FILTER (WHERE n.delivered_at IS NULL AND n.suppressed_at IS NULL AND n.due_at <= v_now)) / 3600)::integer,
           'scheduled', count(*) FILTER (WHERE n.delivered_at IS NULL AND n.suppressed_at IS NULL AND n.due_at > v_now),
           'suppressed', count(*) FILTER (WHERE n.suppressed_at >= v_since))
    INTO v_notices
    FROM public.ca_commerce_notices n
   WHERE n.delivered_at IS NULL OR n.suppressed_at >= v_since;

  SELECT jsonb_build_object(
           'refund_execution_replays', count(*) FILTER (WHERE ev.kind = 'refund_request_executed' AND ev.detail->>'is_replay' = 'true'),
           'renewal_debit_reference_reused', count(*) FILTER (WHERE ev.kind = 'renewal_needs_attention' AND ev.detail->>'reason' = 'debit_reference_reused'),
           'purchase_replays_recorded', false)
    INTO v_duplicates
    FROM public.ca_commerce_events ev
   WHERE ev.occurred_at >= v_since AND ev.kind IN ('refund_request_executed','renewal_needs_attention');

  SELECT jsonb_build_object(
           'renewal', count(*) FILTER (WHERE ev.kind = 'renewal_needs_attention'
                                        AND ev.detail->>'reason' IN ('journal_unproved','register_unproved','lots_unproved')),
           'refund', count(*) FILTER (WHERE ev.kind = 'refund_request_owed'
                                       AND ev.detail->>'error' IN ('refund_journal_unproved','refund_register_unproved','refund_not_exact')),
           'purchase_failures_recorded', false)
    INTO v_postconditions
    FROM public.ca_commerce_events ev
   WHERE ev.occurred_at >= v_since AND ev.kind IN ('renewal_needs_attention','refund_request_owed');

  SELECT jsonb_build_object(
           'refund_execution_retries', (SELECT COALESCE(sum(GREATEST(r.attempts - 1, 0)), 0) FROM public.ca_commerce_refund_requests r WHERE r.created_at >= v_since),
           'renewal_claim_retries', (SELECT COALESCE(sum(GREATEST(m.attempts - 1, 0)), 0) FROM public.ca_commerce_renewal_mandates m WHERE m.updated_at >= v_since))
    INTO v_retries;

  RETURN jsonb_build_object(
    'success', true,
    'days', v_days,
    'since', v_since,
    'as_of', v_now,
    'quotes', v_quotes,
    'purchases', v_purchases,
    'trial_waivers', v_trials,
    'refunds', v_refunds,
    'refund_requests', v_requests,
    'renewals', v_renewals,
    'sponsorships', v_sponsorships,
    'notices', v_notices,
    'duplicates', v_duplicates,
    'postconditions', v_postconditions,
    'retries', v_retries);
END $$;

-- ---------------------------------------------------------------------------
-- 2. Grants. A REVOKE names PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_ca_commerce_metrics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_commerce_metrics(integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_fn regprocedure := to_regprocedure('public.fn_ca_commerce_metrics(integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'fn_ca_commerce_metrics(integer) must exist';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0) THEN
    RAISE EXCEPTION 'fn_ca_commerce_metrics grants are not as declared';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn)
     OR (SELECT p.provolatile FROM pg_proc p WHERE p.oid = v_fn) <> 's' THEN
    RAISE EXCEPTION 'fn_ca_commerce_metrics must be a stable security definer read';
  END IF;
END $post$;

COMMIT;
