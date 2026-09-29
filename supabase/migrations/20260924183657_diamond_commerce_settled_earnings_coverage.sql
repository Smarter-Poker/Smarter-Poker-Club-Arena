-- 20260924183657_diamond_commerce_settled_earnings_coverage.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2) 5.3 and 5.5: "Settled
-- Earnings Can Help Cover Operating Purchases", shown as a comparison and
-- nothing more. ONE new read, fn_ca_commerce_earnings_coverage, and no write.
--
-- WHERE THE EARNINGS COME FROM (the only traceable source there is):
--   An owner's settled diamond earnings are the Diamond Spins daily net
--   settlements (20260919152614, burn added by 20260921202834). Each closed
--   Chicago business day is one public.diamond_spin_days row per owner; once
--   status = 'settled', credited_net (settled_net less the platform burn) is
--   exactly what ONE wallet transaction moved: diamond_transactions.id =
--   wallet_transaction_id, reference_id 'diamond-spin-day:<owner>:<day>',
--   issuance_class 'transferred' (a deferred constraint trigger refuses a
--   settled day without that receipt). A negative day is a debit of the owner.
--   A positive credit may first settle an open diamond debt
--   (add_diamonds_to_balance writes a 'debt_settlement' row with reference
--   'debt-settlement:<credit transaction id>'); that part never became
--   spendable, so it is reported and taken out of the comparison.
--   Nothing else credits an owner "earnings" in diamonds: rakeback and club
--   settlement move chips, and a plain 'transfer' row carries no source.
--
-- WHAT IT DOES NOT CLAIM:
--   It never says which diamonds paid for anything. Purchases consume the
--   canonical balance under the recorded order (purchased lots first), and
--   this read neither changes nor restates that. It counts each settled day
--   once, each purchase once, and each refund once against its purchase. The
--   earnings are the owner's across everything they host (a day's burn is
--   applied to the whole day, so no per-host share is invented). Open days
--   are shown apart as not yet settled.
--
-- Access: the scope's owner, platform staff and the service role. Granted to
-- authenticated and service_role only.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- The database refuses DDL inside the hourly break window (:50 to :03 UTC).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. The installed baseline this read depends on.
-- ---------------------------------------------------------------------------
DO $baseline$
BEGIN
  IF to_regprocedure('public.fn_ca_commerce_earnings_coverage(text,uuid,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'commerce baseline changed: fn_ca_commerce_earnings_coverage already exists';
  END IF;
  IF to_regprocedure('public.fn_ca_commerce_scope_role(text,uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_commerce_scope_owner(text,uuid)') IS NULL
     OR to_regprocedure('public.fn_is_platform_admin()') IS NULL
     OR to_regclass('public.ca_commerce_purchases') IS NULL
     OR to_regclass('public.ca_commerce_refunds') IS NULL
     OR to_regclass('public.diamond_transactions') IS NULL THEN
    RAISE EXCEPTION 'this read needs the commerce migrations (20260922143541) installed first';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'diamond_spin_days'
         AND column_name IN ('owner_id','day','status','pending_diamonds','settled_net','credited_net','wallet_transaction_id','settled_at')) <> 8 THEN
    RAISE EXCEPTION 'this read needs the Diamond Spins daily settlement with its burn (20260919152614, 20260921202834) installed first';
  END IF;
END $baseline$;

-- ---------------------------------------------------------------------------
-- 1. The read.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_earnings_coverage(p_scope_kind text, p_scope_id uuid, p_days integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_staff boolean := COALESCE(auth.role(), '') = 'service_role' OR public.fn_is_platform_admin();
  v_owner uuid;
  v_until timestamptz := now();
  v_since timestamptz;
  v_days integer := 0;
  v_credited bigint := 0;
  v_debited bigint := 0;
  v_to_debt bigint := 0;
  v_unmatched integer := 0;
  v_pending bigint := 0;
  v_paid bigint := 0;
  v_refunded bigint := 0;
  v_purchases integer := 0;
  v_others bigint := 0;
  v_all_paid bigint := 0;
  v_all_refunded bigint := 0;
  v_earnings bigint;
  v_operating bigint;
BEGIN
  IF v_actor IS NULL AND NOT v_staff THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_scope_kind IS NULL OR p_scope_kind NOT IN ('club','union') OR p_scope_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_scope');
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_window');
  END IF;
  IF NOT v_staff AND public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner_required');
  END IF;
  v_owner := public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'scope_not_found');
  END IF;
  v_since := v_until - make_interval(days => p_days);

  -- Settled Diamond Spins days in the window, each with its one wallet receipt.
  WITH days AS (
    SELECT d.day, d.credited_net, t.id AS tx_id
      FROM public.diamond_spin_days d
      LEFT JOIN public.diamond_transactions t
        ON t.id = d.wallet_transaction_id AND t.user_id = d.owner_id AND t.amount = d.credited_net
       AND t.reference_id = 'diamond-spin-day:' || d.owner_id::text || ':' || d.day::text
       AND t.issuance_class = 'transferred'
     WHERE d.owner_id = v_owner AND d.status = 'settled'
       AND d.settled_at >= v_since AND d.settled_at < v_until
       AND d.credited_net <> 0
  )
  SELECT count(*) FILTER (WHERE tx_id IS NOT NULL),
         COALESCE(sum(credited_net) FILTER (WHERE tx_id IS NOT NULL AND credited_net > 0), 0),
         COALESCE(-sum(credited_net) FILTER (WHERE tx_id IS NOT NULL AND credited_net < 0), 0),
         count(*) FILTER (WHERE tx_id IS NULL),
         COALESCE((SELECT -sum(s.amount) FROM public.diamond_transactions s
                    WHERE s.user_id = v_owner AND s.type = 'debt_settlement'
                      AND s.reference_id IN (SELECT 'debt-settlement:' || x.tx_id::text FROM days x
                                              WHERE x.tx_id IS NOT NULL AND x.credited_net > 0)), 0)
    INTO v_days, v_credited, v_debited, v_unmatched, v_to_debt
    FROM days;

  SELECT COALESCE(sum(d.pending_diamonds), 0) INTO v_pending
    FROM public.diamond_spin_days d WHERE d.owner_id = v_owner AND d.status = 'open';

  -- Operating purchases for this scope in the window, paid by its owner; each
  -- purchase's refunds are counted once against it, whenever they happened.
  SELECT count(*), COALESCE(sum(p.net), 0),
         COALESCE(sum((SELECT COALESCE(sum(r.gross), 0) FROM public.ca_commerce_refunds r WHERE r.purchase_id = p.id)), 0)
    INTO v_purchases, v_paid, v_refunded
    FROM public.ca_commerce_purchases p
   WHERE p.scope_kind = p_scope_kind AND p.scope_id = p_scope_id AND p.payer_id = v_owner
     AND p.net > 0 AND p.created_at >= v_since AND p.created_at < v_until;

  -- Paid for this scope by someone else (a union sponsor): not the owner's cost.
  SELECT COALESCE(sum(p.net), 0) INTO v_others
    FROM public.ca_commerce_purchases p
   WHERE p.scope_kind = p_scope_kind AND p.scope_id = p_scope_id AND p.payer_id <> v_owner
     AND p.net > 0 AND p.created_at >= v_since AND p.created_at < v_until;

  -- Everything the owner paid for operating services in the window, any scope.
  SELECT COALESCE(sum(p.net), 0),
         COALESCE(sum((SELECT COALESCE(sum(r.gross), 0) FROM public.ca_commerce_refunds r WHERE r.purchase_id = p.id)), 0)
    INTO v_all_paid, v_all_refunded
    FROM public.ca_commerce_purchases p
   WHERE p.payer_id = v_owner AND p.net > 0 AND p.created_at >= v_since AND p.created_at < v_until;

  v_earnings := GREATEST(v_credited - v_debited - v_to_debt, 0);
  v_operating := GREATEST(v_paid - v_refunded, 0);

  RETURN jsonb_build_object(
    'success', true,
    'scope_kind', p_scope_kind,
    'scope_id', p_scope_id,
    'owner_id', v_owner,
    'days', p_days,
    'window_start', v_since,
    'window_end', v_until,
    'earnings', jsonb_build_object(
      'source', 'diamond_spins_daily_settlement',
      'settled_days', v_days,
      'credited', v_credited,
      'debited', v_debited,
      'applied_to_debt', v_to_debt,
      'net_settled', v_earnings,
      'unmatched_days', v_unmatched,
      'pending_unsettled', v_pending,
      'scope', 'owner_all_hosts'),
    'operating', jsonb_build_object(
      'purchases', v_purchases,
      'paid', v_paid,
      'refunded', v_refunded,
      'net_paid', v_operating,
      'paid_by_others', v_others,
      'owner_all_scopes_net_paid', GREATEST(v_all_paid - v_all_refunded, 0)),
    'comparison_covered', LEAST(v_earnings, v_operating),
    'lot_provenance', false,
    'basis', 'A Comparison Of Settled Diamond Spins Earnings With Operating Purchases In The Same Window. It Does Not Say Which Diamonds Paid For Anything.');
END $$;

-- ---------------------------------------------------------------------------
-- 2. Grants. A REVOKE names PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_ca_commerce_earnings_coverage(text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_commerce_earnings_coverage(text, uuid, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_proc regprocedure := to_regprocedure('public.fn_ca_commerce_earnings_coverage(text,uuid,integer)');
BEGIN
  IF v_proc IS NULL THEN
    RAISE EXCEPTION 'fn_ca_commerce_earnings_coverage must exist';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = v_proc) <> 's' OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_proc) THEN
    RAISE EXCEPTION 'the earnings coverage read must be a STABLE security definer (it writes nothing)';
  END IF;
  IF has_function_privilege('anon', v_proc, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_proc, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'earnings coverage grants are not as declared';
  END IF;
END $post$;

COMMIT;
