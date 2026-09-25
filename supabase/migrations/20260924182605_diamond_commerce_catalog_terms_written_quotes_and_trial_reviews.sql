-- 20260924182605_diamond_commerce_catalog_terms_written_quotes_and_trial_reviews.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), the scope left after
-- 20260924102040 and 20260924102056 (both installed 2026-09-24):
--
-- 1. The Catalog Visible switch is honoured (R2 10.2 activation matrix). It
--    was stored and shown on the Commerce Desk, but nothing read it. While it
--    is off, owners read the catalog without prices and the quote door
--    refuses `catalog_not_visible`; staff and the service role (renewals)
--    are unaffected. The catalog also names the platform capability a
--    product sells and whether it is available (Prompt 1 contract 2).
-- 2. Service terms are versioned and recorded (R2 2.1 "Record eligibility
--    and accepted terms once", 2.3). A `service_terms` policy, version 1, and
--    the version in effect is stored on every trial and every purchase at
--    the moment it is accepted (column defaults, so no writer can forget it).
-- 3. The trial waiver is recorded (R2 2.2 "Record normal catalog price,
--    waiver reason/version, zero actual debit"). Every trial row stores the
--    reason, the catalog version and the published prices it waived.
-- 4. Quotes are rate limited per signed-in person: 120 in 10 minutes, then
--    `rate_limited`. A quote is the only way to a charge, so this bounds the
--    whole checkout path without touching the purchase boundary.
-- 5. A quote says when the payer has never had a free month
--    (`free_month_available`), so the page offers the free month before an
--    owner pays for the same service. It never refuses: paying is still the
--    owner's choice.
-- 6. Written quotes above 2,500 members (R2 3.1: "Above 2,500: a written
--    diamond quote with validated capacity. No invented unlimited price").
--    The owner asks with the capacity they need; platform staff offer a
--    capacity and price (or decline with a note). The offer is a private
--    capacity product for that club only, priced through the same draft,
--    validate and publish doors as every other price, so the quote, the
--    purchase, upgrades, renewals and refunds need no change at all. An
--    offer can be bought until it expires; a bought offer renews like any
--    capacity.
-- 7. A review path for a genuinely new independent operator (R2 2.4, 2.5).
--    An operator's later clubs inherit the first trial's end, so a club
--    enrolled after it gets no free days. The owner can ask for a review
--    with a statement; staff approve (a fresh 30-day trial for that one
--    scope, recorded as cohort `review_granted`, with its own reminders) or
--    decline with a note. The first-trial rule is otherwise unchanged: the
--    initial trial per operator stays unique.
--
-- Every function this migration replaces is pinned to its installed body
-- (md5 of prosrc), and the trial activation is amended by anchor insert. No
-- money path (quote implementation, purchase, renewal, refund) is changed.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- The database refuses DDL inside the hourly break window (:50 to :03 UTC).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. The installed baseline, exactly.
-- ---------------------------------------------------------------------------
DO $baseline$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('fn_ca_commerce_quote', '2b5999d225ad3d15b4cae4f15a5bac55'),
    ('fn_ca_commerce_catalog', '196868d0429c3d104e46da108ca14a4a'),
    ('fn_ca_commerce_activate_trial_impl', 'c1a16474b535583fbfe43654fdebd6ec')
  ) AS t(fn, md5) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'commerce baseline changed: % is not the live body this migration replaces', r.fn;
    END IF;
  END LOOP;
  IF to_regprocedure('public.fn_capability_available(text)') IS NULL
     OR to_regprocedure('public.fn_ca_commerce_price_publish(uuid,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.fn_ca_commerce_policy_version(text,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'this migration needs 20260924025555 and 20260924102040 installed first';
  END IF;
  IF to_regclass('public.ca_commerce_written_quotes') IS NOT NULL
     OR to_regclass('public.ca_commerce_trial_reviews') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ca_commerce_trials' AND column_name = 'terms_version')
     OR EXISTS (SELECT 1 FROM public.ca_commerce_policies WHERE kind = 'service_terms') THEN
    RAISE EXCEPTION 'commerce baseline changed: an object this migration adds already exists';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.ca_commerce_trials'::regclass
        AND conname IN ('ca_commerce_trials_operator_id_key', 'ca_commerce_trials_cohort_check')) <> 2
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.ca_commerce_policies'::regclass
        AND conname = 'ca_commerce_policies_kind_check') <> 1 THEN
    RAISE EXCEPTION 'commerce baseline changed: a constraint this migration replaces is not the installed one';
  END IF;
END $baseline$;

-- ---------------------------------------------------------------------------
-- 1. Service terms, version 1 (item 2).
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_commerce_policies DROP CONSTRAINT ca_commerce_policies_kind_check;
ALTER TABLE public.ca_commerce_policies ADD CONSTRAINT ca_commerce_policies_kind_check
  CHECK (kind IN ('refund','renewal_terms','renewal_ceiling','service_terms'));
INSERT INTO public.ca_commerce_policies (kind, version, title, body) VALUES
  ('service_terms', 1, 'Operating Service Terms',
   'Operating Services Are Software Services For Running A Club Or Union, Paid In Whole Diamonds From The Payer''s Own Balance. '
   || 'Each Service Runs For The Period Shown At Checkout, 720 Hours For A 30 Day Service, Starting When It Is Bought Or When The Current Period Ends. '
   || 'The Free Month Charges Nothing And Is Given Once Per Operator; A Later Club Of The Same Operator Shares Its End Time Unless Platform Staff Approve A Review. '
   || 'Nothing Renews Unless The Payer Authorizes It With A Maximum Price, And An Authorization Can Be Cancelled At Any Time Before It Runs. '
   || 'Ending Or Lapsing A Service Never Removes Members, Stops A Running Game Or Tournament, Or Holds Any Player''s Funds. Only New Operating Actions Need An Active Service. '
   || 'Purchased Diamonds Never Expire Because A Service Ends. Refunds Follow The Refund Policy In Effect When They Are Requested. '
   || 'Member Capacity Counts Approved Accounts, Each Once; It Is Not A Limit On Tables Or Seats Played At Once.');

ALTER TABLE public.ca_commerce_trials
  ADD COLUMN terms_version integer DEFAULT public.fn_ca_commerce_policy_version('service_terms'),
  ADD COLUMN waiver_reason text,
  ADD COLUMN waiver_catalog_version text,
  ADD COLUMN waiver_prices jsonb;
ALTER TABLE public.ca_commerce_purchases
  ADD COLUMN terms_version integer DEFAULT public.fn_ca_commerce_policy_version('service_terms');

-- ---------------------------------------------------------------------------
-- 2. The trial waiver, recorded at the moment the trial is created (item 3).
-- A BEFORE INSERT trigger on the commerce trial table, so every writer (the
-- owner's door, the launch cohort, a review approval) records it the same way.
-- It never blocks: an unreadable catalog records nulls, not a refusal.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_trial_waiver_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.waiver_reason := COALESCE(NEW.waiver_reason, CASE NEW.cohort
    WHEN 'launch_cohort' THEN 'Launch Cohort Free Operating Month'
    WHEN 'review_granted' THEN 'Free Operating Month Granted On Review'
    ELSE 'Free Operating Month For A New Operator' END);
  BEGIN
    NEW.waiver_catalog_version := COALESCE(NEW.waiver_catalog_version, public.fn_ca_commerce_catalog_version());
    NEW.waiver_prices := COALESCE(NEW.waiver_prices, (
      SELECT COALESCE(jsonb_object_agg(v.sku, v.diamonds ORDER BY v.sku), '{}'::jsonb)
        FROM public.ca_commerce_price_versions v JOIN public.ca_commerce_products p ON p.sku = v.sku
       WHERE v.status = 'published' AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now())
         AND p.supported AND p.term_kind = 'period' AND p.private_scope_id IS NULL));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ca_commerce trial waiver snapshot not recorded (%): %', SQLSTATE, SQLERRM;
  END;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Private capacity products for written quotes (item 6). Declared before
-- the trigger above is attached, because its query reads private_scope_id.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_commerce_products
  ADD COLUMN private_scope_kind text CHECK (private_scope_kind IS NULL OR private_scope_kind IN ('club','union')),
  ADD COLUMN private_scope_id uuid,
  ADD COLUMN written_quote_id uuid,
  ADD CONSTRAINT ca_commerce_products_private_scope_pair
    CHECK ((private_scope_kind IS NULL) = (private_scope_id IS NULL) AND (private_scope_id IS NULL) = (written_quote_id IS NULL));

CREATE TRIGGER ca_commerce_trials_waiver_snapshot BEFORE INSERT ON public.ca_commerce_trials
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_commerce_trial_waiver_snapshot();

-- ---------------------------------------------------------------------------
-- 4. One initial trial per operator; review grants are their own rows (item 7).
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_commerce_trials DROP CONSTRAINT ca_commerce_trials_operator_id_key;
CREATE UNIQUE INDEX ca_commerce_trials_one_initial_per_operator
  ON public.ca_commerce_trials (operator_id) WHERE cohort IN ('new_operator','launch_cohort');
ALTER TABLE public.ca_commerce_trials DROP CONSTRAINT ca_commerce_trials_cohort_check;
ALTER TABLE public.ca_commerce_trials ADD CONSTRAINT ca_commerce_trials_cohort_check
  CHECK (cohort IN ('new_operator','launch_cohort','review_granted'));

-- The operator's initial trial is the one a later scope inherits; a review
-- grant for one scope is never inherited by another.
DO $trial$
DECLARE
  v_oid oid := to_regprocedure('public.fn_ca_commerce_activate_trial_impl(text,uuid,uuid,text,timestamp with time zone)');
  v_before text;
  v_after text;
  v_acl_before aclitem[];
  v_acl_after aclitem[];
  v_anchor text := 'SELECT * INTO v_trial FROM public.ca_commerce_trials WHERE operator_id = v_owner;';
  v_new text := 'SELECT * INTO v_trial FROM public.ca_commerce_trials WHERE operator_id = v_owner AND cohort IN (''new_operator'',''launch_cohort'');';
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl INTO v_before, v_acl_before FROM pg_proc p WHERE p.oid = v_oid;
  IF (length(v_before) - length(replace(v_before, v_anchor, ''))) <> length(v_anchor) THEN
    RAISE EXCEPTION 'the trial activation''s operator lookup must occur exactly once';
  END IF;
  EXECUTE replace(v_before, v_anchor, v_new);
  SELECT pg_get_functiondef(p.oid), p.proacl INTO v_after, v_acl_after FROM pg_proc p WHERE p.oid = v_oid;
  IF replace(v_after, v_new, v_anchor) IS DISTINCT FROM v_before OR v_acl_after IS DISTINCT FROM v_acl_before THEN
    RAISE EXCEPTION 'the trial activation changed beyond its operator lookup';
  END IF;
END $trial$;

-- ---------------------------------------------------------------------------
-- 5. Written quotes (item 6).
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_written_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind = 'club'),
  scope_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_capacity integer NOT NULL CHECK (requested_capacity > 2500 AND requested_capacity <= 1000000),
  request_note text CHECK (request_note IS NULL OR (length(request_note) <= 2000 AND strpos(request_note, chr(8212)) = 0)),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','offered','declined','withdrawn')),
  offered_capacity integer CHECK (offered_capacity IS NULL OR offered_capacity > 2500),
  offered_diamonds integer CHECK (offered_diamonds IS NULL OR offered_diamonds > 0),
  sku text,
  price_version_id uuid,
  valid_until timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  staff_note text CHECK (staff_note IS NULL OR (length(staff_note) <= 2000 AND strpos(staff_note, chr(8212)) = 0)),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'offered') = (sku IS NOT NULL AND offered_capacity IS NOT NULL AND offered_diamonds IS NOT NULL AND valid_until IS NOT NULL)),
  CHECK (state <> 'declined' OR staff_note IS NOT NULL)
);
CREATE UNIQUE INDEX ca_commerce_written_quotes_one_open_per_scope
  ON public.ca_commerce_written_quotes (scope_kind, scope_id) WHERE state = 'requested';
CREATE INDEX ca_commerce_written_quotes_scope ON public.ca_commerce_written_quotes (scope_kind, scope_id, created_at DESC);
ALTER TABLE public.ca_commerce_written_quotes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_written_quotes FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX ca_commerce_quotes_actor_recent ON public.ca_commerce_quotes (actor_id, created_at DESC);

CREATE FUNCTION public.fn_ca_commerce_written_quote_json(p_w public.ca_commerce_written_quotes) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'written_quote_id', p_w.id, 'scope_kind', p_w.scope_kind, 'scope_id', p_w.scope_id,
    'requested_by', p_w.requested_by, 'requested_capacity', p_w.requested_capacity, 'request_note', p_w.request_note,
    'state', CASE
      WHEN p_w.state = 'offered' AND EXISTS (
        SELECT 1 FROM public.ca_commerce_entitlements e WHERE e.scope_kind = p_w.scope_kind AND e.scope_id = p_w.scope_id AND e.sku = p_w.sku) THEN 'accepted'
      WHEN p_w.state = 'offered' AND p_w.valid_until <= now() THEN 'expired'
      ELSE p_w.state END,
    'offered_capacity', p_w.offered_capacity, 'offered_diamonds', p_w.offered_diamonds, 'sku', p_w.sku,
    'price_version_id', p_w.price_version_id, 'valid_until', p_w.valid_until,
    'decided_by', p_w.decided_by, 'decided_at', p_w.decided_at, 'staff_note', p_w.staff_note, 'created_at', p_w.created_at)
$$;

-- The owner asks. One open request per club.
CREATE FUNCTION public.fn_ca_commerce_written_quote_request(p_scope_kind text, p_scope_id uuid, p_requested_capacity integer, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_w public.ca_commerce_written_quotes;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_scope_kind IS DISTINCT FROM 'club' OR p_scope_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_club_only');
  END IF;
  IF public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner_required');
  END IF;
  IF p_requested_capacity IS NULL OR p_requested_capacity <= 2500 OR p_requested_capacity > 1000000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_capacity_out_of_range');
  END IF;
  IF v_note IS NOT NULL AND (length(v_note) > 2000 OR strpos(v_note, chr(8212)) > 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || p_scope_kind || ':' || p_scope_id::text, 0));
  SELECT * INTO v_w FROM public.ca_commerce_written_quotes WHERE scope_kind = p_scope_kind AND scope_id = p_scope_id AND state = 'requested';
  IF v_w.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_already_requested', 'written_quote', public.fn_ca_commerce_written_quote_json(v_w));
  END IF;
  INSERT INTO public.ca_commerce_written_quotes (scope_kind, scope_id, requested_by, requested_capacity, request_note)
  VALUES (p_scope_kind, p_scope_id, v_actor, p_requested_capacity, v_note) RETURNING * INTO v_w;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('written_quote_requested', v_actor, p_scope_kind, p_scope_id, v_w.id, jsonb_build_object('requested_capacity', p_requested_capacity));
  RETURN jsonb_build_object('success', true, 'written_quote', public.fn_ca_commerce_written_quote_json(v_w));
END $$;

-- Staff offer a capacity and price. The offer becomes a private capacity
-- product for that club, priced through the ordinary draft, validate and
-- publish doors, so every downstream path is the one already qualified.
CREATE FUNCTION public.fn_ca_commerce_written_quote_offer(p_written_quote_id uuid, p_capacity integer, p_diamonds integer, p_valid_days integer DEFAULT 14, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_w public.ca_commerce_written_quotes;
  v_sku text;
  v_step jsonb;
  v_pv uuid;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_owner uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  SELECT * INTO v_w FROM public.ca_commerce_written_quotes WHERE id = p_written_quote_id FOR UPDATE;
  IF v_w.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_not_found');
  END IF;
  IF v_w.state <> 'requested' THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_already_decided', 'written_quote', public.fn_ca_commerce_written_quote_json(v_w));
  END IF;
  IF p_capacity IS NULL OR p_capacity <= 2500 OR p_capacity > 1000000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_capacity_out_of_range');
  END IF;
  IF p_diamonds IS NULL OR p_diamonds <= 0 OR p_diamonds > 100000000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_price');
  END IF;
  IF p_valid_days IS NULL OR p_valid_days < 1 OR p_valid_days > 30 THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_validity_out_of_range');
  END IF;
  IF v_note IS NOT NULL AND (length(v_note) > 2000 OR strpos(v_note, chr(8212)) > 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  v_sku := 'capacity_wq_' || replace(v_w.id::text, '-', '');
  INSERT INTO public.ca_commerce_products (sku, title, kind, scope_kind, term_kind, term_hours, capacity, quantity_unit,
                                           capability_id, supported, included_note, sort_order,
                                           private_scope_kind, private_scope_id, written_quote_id)
  VALUES (v_sku, 'Up To ' || to_char(p_capacity, 'FM999,999,999') || ' Approved Members (Written Quote)', 'capacity', 'club', 'period', 720,
          p_capacity, 'flat', 'club.capacity', true,
          'Ordinary Administration, Roster And Role Management, Dashboards, Table And Tournament Creation And Scheduling', 900,
          v_w.scope_kind, v_w.scope_id, v_w.id);
  v_step := public.fn_ca_commerce_price_draft(v_sku, p_diamonds, 'flat', NULL, 'Written Quote ' || v_w.id::text || ' For ' || to_char(p_capacity, 'FM999999999') || ' Members');
  IF NOT COALESCE((v_step->>'success')::boolean, false) THEN RAISE EXCEPTION 'written quote price draft refused: %', v_step; END IF;
  v_pv := (v_step->>'price_version_id')::uuid;
  v_step := public.fn_ca_commerce_price_validate(v_pv);
  IF NOT COALESCE((v_step->>'success')::boolean, false) THEN RAISE EXCEPTION 'written quote price validation refused: %', v_step; END IF;
  v_step := public.fn_ca_commerce_price_publish(v_pv, NULL);
  IF NOT COALESCE((v_step->>'success')::boolean, false) THEN RAISE EXCEPTION 'written quote price publication refused: %', v_step; END IF;
  UPDATE public.ca_commerce_written_quotes
     SET state = 'offered', offered_capacity = p_capacity, offered_diamonds = p_diamonds, sku = v_sku, price_version_id = v_pv,
         valid_until = now() + make_interval(days => p_valid_days), decided_by = v_actor, decided_at = now(), staff_note = v_note
   WHERE id = v_w.id RETURNING * INTO v_w;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('written_quote_offered', v_actor, v_w.scope_kind, v_w.scope_id, v_w.id,
          jsonb_build_object('sku', v_sku, 'capacity', p_capacity, 'diamonds', p_diamonds, 'valid_until', v_w.valid_until));
  v_owner := public.fn_ca_commerce_scope_owner(v_w.scope_kind, v_w.scope_id);
  IF v_owner IS NOT NULL THEN
    PERFORM public.fn_ca_commerce_notice(v_owner, 'written-quote-offered:' || v_w.id::text, 'club_commerce_written_quote',
      'Your Written Quote Is Ready',
      'Capacity For Up To ' || to_char(p_capacity, 'FM999,999,999') || ' Approved Members Costs ' || to_char(p_diamonds, 'FM999,999,999') ||
      ' Diamonds For 30 Days. The Offer Can Be Accepted Until ' || to_char(v_w.valid_until AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') || ' Central.',
      '/hub/club-arena/clubs/' || v_w.scope_id::text || '/diamond-costs',
      jsonb_build_object('written_quote_id', v_w.id, 'sku', v_sku), now());
  END IF;
  RETURN jsonb_build_object('success', true, 'written_quote', public.fn_ca_commerce_written_quote_json(v_w));
END $$;

CREATE FUNCTION public.fn_ca_commerce_written_quote_decline(p_written_quote_id uuid, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_w public.ca_commerce_written_quotes;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_owner uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF v_note IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_required');
  END IF;
  IF length(v_note) > 2000 OR strpos(v_note, chr(8212)) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  SELECT * INTO v_w FROM public.ca_commerce_written_quotes WHERE id = p_written_quote_id FOR UPDATE;
  IF v_w.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_not_found');
  END IF;
  IF v_w.state <> 'requested' THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_already_decided', 'written_quote', public.fn_ca_commerce_written_quote_json(v_w));
  END IF;
  UPDATE public.ca_commerce_written_quotes SET state = 'declined', decided_by = v_actor, decided_at = now(), staff_note = v_note
   WHERE id = v_w.id RETURNING * INTO v_w;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('written_quote_declined', v_actor, v_w.scope_kind, v_w.scope_id, v_w.id, '{}'::jsonb);
  v_owner := public.fn_ca_commerce_scope_owner(v_w.scope_kind, v_w.scope_id);
  IF v_owner IS NOT NULL THEN
    PERFORM public.fn_ca_commerce_notice(v_owner, 'written-quote-declined:' || v_w.id::text, 'club_commerce_written_quote',
      'Your Written Quote Request Was Declined', 'Platform Staff Wrote: ' || v_note,
      '/hub/club-arena/clubs/' || v_w.scope_id::text || '/diamond-costs', jsonb_build_object('written_quote_id', v_w.id), now());
  END IF;
  RETURN jsonb_build_object('success', true, 'written_quote', public.fn_ca_commerce_written_quote_json(v_w));
END $$;

-- The owner withdraws an open request.
CREATE FUNCTION public.fn_ca_commerce_written_quote_withdraw(p_written_quote_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_w public.ca_commerce_written_quotes;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  SELECT * INTO v_w FROM public.ca_commerce_written_quotes WHERE id = p_written_quote_id FOR UPDATE;
  IF v_w.id IS NULL OR public.fn_ca_commerce_scope_role(v_w.scope_kind, v_w.scope_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_not_found');
  END IF;
  IF v_w.state <> 'requested' THEN
    RETURN jsonb_build_object('success', false, 'error', 'written_quote_already_decided', 'written_quote', public.fn_ca_commerce_written_quote_json(v_w));
  END IF;
  UPDATE public.ca_commerce_written_quotes SET state = 'withdrawn', decided_by = v_actor, decided_at = now()
   WHERE id = v_w.id RETURNING * INTO v_w;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('written_quote_withdrawn', v_actor, v_w.scope_kind, v_w.scope_id, v_w.id, '{}'::jsonb);
  RETURN jsonb_build_object('success', true, 'written_quote', public.fn_ca_commerce_written_quote_json(v_w));
END $$;

-- Reads: a scope's owner or administrator reads its own; staff read one scope
-- or, with no scope, the open queue first.
CREATE FUNCTION public.fn_ca_commerce_written_quotes(p_scope_kind text DEFAULT NULL, p_scope_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_staff boolean := COALESCE(auth.role(), '') = 'service_role' OR public.fn_is_platform_admin();
BEGIN
  IF v_actor IS NULL AND NOT v_staff THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_scope_id IS NULL THEN
    IF NOT v_staff THEN RETURN jsonb_build_object('success', false, 'error', 'staff_required'); END IF;
  ELSIF NOT v_staff AND public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor) = 'none' THEN
    RETURN jsonb_build_object('success', false, 'error', 'access_denied');
  END IF;
  RETURN jsonb_build_object('success', true, 'written_quotes', COALESCE((
    SELECT jsonb_agg(public.fn_ca_commerce_written_quote_json(w) ORDER BY (w.state = 'requested') DESC, w.created_at DESC)
      FROM public.ca_commerce_written_quotes w
     WHERE p_scope_id IS NULL OR (w.scope_kind = p_scope_kind AND w.scope_id = p_scope_id)), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 6. Trial reviews (item 7).
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_trial_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  statement text NOT NULL CHECK (length(statement) BETWEEN 20 AND 2000 AND strpos(statement, chr(8212)) = 0),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','approved','declined')),
  decided_by uuid,
  decided_at timestamptz,
  staff_note text CHECK (staff_note IS NULL OR (length(staff_note) <= 2000 AND strpos(staff_note, chr(8212)) = 0)),
  granted_trial_id uuid REFERENCES public.ca_commerce_trials(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'approved') = (granted_trial_id IS NOT NULL)),
  CHECK (state <> 'declined' OR staff_note IS NOT NULL)
);
CREATE UNIQUE INDEX ca_commerce_trial_reviews_one_open_per_scope
  ON public.ca_commerce_trial_reviews (scope_kind, scope_id) WHERE state = 'requested';
CREATE UNIQUE INDEX ca_commerce_trial_reviews_one_grant_per_scope
  ON public.ca_commerce_trial_reviews (scope_kind, scope_id) WHERE state = 'approved';
ALTER TABLE public.ca_commerce_trial_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_trial_reviews FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_ca_commerce_trial_review_json(p_r public.ca_commerce_trial_reviews) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('review_id', p_r.id, 'scope_kind', p_r.scope_kind, 'scope_id', p_r.scope_id,
    'operator_id', p_r.operator_id, 'requested_by', p_r.requested_by, 'statement', p_r.statement, 'state', p_r.state,
    'decided_by', p_r.decided_by, 'decided_at', p_r.decided_at, 'staff_note', p_r.staff_note,
    'granted_trial_id', p_r.granted_trial_id,
    'granted_trial_end', (SELECT t.trial_end FROM public.ca_commerce_trials t WHERE t.id = p_r.granted_trial_id),
    'created_at', p_r.created_at)
$$;

-- The owner asks, only when this scope has no free time left of its own:
-- it inherited an ended trial, or its operator's trial ended before it
-- enrolled. One open request per scope, and one grant per scope ever.
CREATE FUNCTION public.fn_ca_commerce_trial_review_request(p_scope_kind text, p_scope_id uuid, p_statement text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_owner uuid;
  v_statement text := btrim(COALESCE(p_statement, ''));
  v_scope_trial public.ca_commerce_trials;
  v_initial public.ca_commerce_trials;
  v_r public.ca_commerce_trial_reviews;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_scope_kind NOT IN ('club','union') OR p_scope_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_scope');
  END IF;
  IF public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner_required');
  END IF;
  IF length(v_statement) < 20 THEN
    RETURN jsonb_build_object('success', false, 'error', 'statement_too_short');
  END IF;
  IF length(v_statement) > 2000 OR strpos(v_statement, chr(8212)) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  v_owner := public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_trial:' || v_owner::text, 0));
  SELECT * INTO v_scope_trial FROM public.fn_ca_commerce_scope_trial(p_scope_kind, p_scope_id);
  SELECT * INTO v_initial FROM public.ca_commerce_trials WHERE operator_id = v_owner AND cohort IN ('new_operator','launch_cohort');
  IF v_scope_trial.id IS NOT NULL AND v_scope_trial.trial_end > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'trial_still_running', 'trial_end', v_scope_trial.trial_end);
  END IF;
  IF v_scope_trial.id IS NULL AND (v_initial.id IS NULL OR v_initial.trial_end > now()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'free_month_available');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_commerce_trial_reviews WHERE scope_kind = p_scope_kind AND scope_id = p_scope_id AND state = 'approved') THEN
    RETURN jsonb_build_object('success', false, 'error', 'trial_review_already_granted');
  END IF;
  SELECT * INTO v_r FROM public.ca_commerce_trial_reviews WHERE scope_kind = p_scope_kind AND scope_id = p_scope_id AND state = 'requested';
  IF v_r.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'trial_review_already_requested', 'review', public.fn_ca_commerce_trial_review_json(v_r));
  END IF;
  INSERT INTO public.ca_commerce_trial_reviews (scope_kind, scope_id, operator_id, requested_by, statement)
  VALUES (p_scope_kind, p_scope_id, v_owner, v_actor, v_statement) RETURNING * INTO v_r;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('trial_review_requested', v_actor, p_scope_kind, p_scope_id, v_r.id, '{}'::jsonb);
  RETURN jsonb_build_object('success', true, 'review', public.fn_ca_commerce_trial_review_json(v_r));
END $$;

-- Staff decide. An approval grants this one scope a fresh 30-day trial,
-- recorded with its reason; a decline says why. Staff never decide a review
-- of a scope they own.
CREATE FUNCTION public.fn_ca_commerce_trial_review_decide(p_review_id uuid, p_approve boolean, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_r public.ca_commerce_trial_reviews;
  v_settings public.ca_commerce_settings;
  v_trial public.ca_commerce_trials;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_url text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF p_approve IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'decision_required');
  END IF;
  IF v_note IS NOT NULL AND (length(v_note) > 2000 OR strpos(v_note, chr(8212)) > 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  IF NOT p_approve AND v_note IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_required');
  END IF;
  SELECT * INTO v_r FROM public.ca_commerce_trial_reviews WHERE id = p_review_id FOR UPDATE;
  IF v_r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'trial_review_not_found');
  END IF;
  IF v_actor IS NOT NULL AND v_actor = v_r.operator_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'own_request');
  END IF;
  IF v_r.state <> 'requested' THEN
    RETURN jsonb_build_object('success', false, 'error', 'trial_review_already_decided', 'review', public.fn_ca_commerce_trial_review_json(v_r));
  END IF;
  v_url := '/hub/club-arena/' || v_r.scope_kind || 's/' || v_r.scope_id::text || '/diamond-costs';
  IF NOT p_approve THEN
    UPDATE public.ca_commerce_trial_reviews SET state = 'declined', decided_by = v_actor, decided_at = now(), staff_note = v_note
     WHERE id = v_r.id RETURNING * INTO v_r;
    INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
    VALUES ('trial_review_declined', v_actor, v_r.scope_kind, v_r.scope_id, v_r.id, '{}'::jsonb);
    PERFORM public.fn_ca_commerce_notice(v_r.operator_id, 'trial-review-declined:' || v_r.id::text, 'club_commerce_trial_review',
      'Your Free Month Review Was Declined', 'Platform Staff Wrote: ' || v_note, v_url, jsonb_build_object('review_id', v_r.id), now());
    RETURN jsonb_build_object('success', true, 'review', public.fn_ca_commerce_trial_review_json(v_r));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_trial:' || v_r.operator_id::text, 0));
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  INSERT INTO public.ca_commerce_trials (operator_id, trial_start, trial_end, policy_version, cohort, activated_by, waiver_reason)
  VALUES (v_r.operator_id, now(), now() + make_interval(hours => v_settings.trial_hours), v_settings.policy_version, 'review_granted', v_actor,
          'Free Operating Month Granted On Review ' || v_r.id::text)
  RETURNING * INTO v_trial;
  INSERT INTO public.ca_commerce_trial_scopes (trial_id, scope_kind, scope_id, enrolled_by, reason)
  VALUES (v_trial.id, v_r.scope_kind, v_r.scope_id, v_actor, 'Free Month Granted On Review: A New Independent Operation')
  ON CONFLICT (scope_kind, scope_id) DO UPDATE
    SET trial_id = EXCLUDED.trial_id, enrolled_at = now(), enrolled_by = EXCLUDED.enrolled_by, reason = EXCLUDED.reason;
  INSERT INTO public.ca_commerce_entitlements (scope_kind, scope_id, sku, kind, starts_at, ends_at, source, trial_id, net_paid)
  VALUES (v_r.scope_kind, v_r.scope_id, NULL, 'trial_operating', v_trial.trial_start, v_trial.trial_end, 'trial', v_trial.id, 0);
  UPDATE public.ca_commerce_trial_reviews SET state = 'approved', decided_by = v_actor, decided_at = now(), staff_note = v_note, granted_trial_id = v_trial.id
   WHERE id = v_r.id RETURNING * INTO v_r;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('trial_review_approved', v_actor, v_r.scope_kind, v_r.scope_id, v_r.id,
          jsonb_build_object('trial_id', v_trial.id, 'trial_end', v_trial.trial_end));
  PERFORM public.fn_ca_commerce_notice(v_r.operator_id, 'trial-review-approved:' || v_r.id::text, 'club_commerce_trial_review',
    'Your Free Month Was Approved',
    'Your Free Operating Month For This ' || initcap(v_r.scope_kind) || ' Ends On ' || to_char(v_trial.trial_end AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') || ' Central.',
    v_url, jsonb_build_object('review_id', v_r.id, 'trial_id', v_trial.id), now());
  PERFORM public.fn_ca_commerce_notice(v_r.operator_id, 'trial-reminder-21:' || v_trial.id::text, 'club_commerce_trial_reminder',
    'Your Operating Trial Ends In 9 Days',
    'Your Free Operating Month Ends On ' || to_char(v_trial.trial_end AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') || ' Central. Review Diamond Prices Before Then.',
    v_url, jsonb_build_object('trial_id', v_trial.id, 'trial_end', v_trial.trial_end), v_trial.trial_start + interval '21 days');
  PERFORM public.fn_ca_commerce_notice(v_r.operator_id, 'trial-reminder-27:' || v_trial.id::text, 'club_commerce_trial_reminder',
    'Your Operating Trial Ends In 3 Days',
    'Your Free Operating Month Ends On ' || to_char(v_trial.trial_end AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') || ' Central. Choose Your Capacity To Continue Without Interruption.',
    v_url, jsonb_build_object('trial_id', v_trial.id, 'trial_end', v_trial.trial_end), v_trial.trial_start + interval '27 days');
  RETURN jsonb_build_object('success', true, 'review', public.fn_ca_commerce_trial_review_json(v_r));
END $$;

CREATE FUNCTION public.fn_ca_commerce_trial_reviews(p_scope_kind text DEFAULT NULL, p_scope_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_staff boolean := COALESCE(auth.role(), '') = 'service_role' OR public.fn_is_platform_admin();
BEGIN
  IF v_actor IS NULL AND NOT v_staff THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_scope_id IS NULL THEN
    IF NOT v_staff THEN RETURN jsonb_build_object('success', false, 'error', 'staff_required'); END IF;
  ELSIF NOT v_staff AND public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor) = 'none' THEN
    RETURN jsonb_build_object('success', false, 'error', 'access_denied');
  END IF;
  RETURN jsonb_build_object('success', true, 'reviews', COALESCE((
    SELECT jsonb_agg(public.fn_ca_commerce_trial_review_json(r) ORDER BY (r.state = 'requested') DESC, r.created_at DESC)
      FROM public.ca_commerce_trial_reviews r
     WHERE p_scope_id IS NULL OR (r.scope_kind = p_scope_kind AND r.scope_id = p_scope_id)), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 7. Replaced: the catalog (items 1 and 6). Staff and the service role read
-- everything, private offers included and flagged. Everyone else reads the
-- public catalog; while it is not visible, without prices. Each product says
-- which platform capability it sells and whether that is available now.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_catalog(p_scope_kind text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings public.ca_commerce_settings;
  v_staff boolean := COALESCE(auth.role(), '') = 'service_role' OR public.fn_is_platform_admin();
  v_show_prices boolean;
BEGIN
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  v_show_prices := v_staff OR v_settings.catalog_visible;
  RETURN jsonb_build_object(
    'catalog_version', public.fn_ca_commerce_catalog_version(),
    'catalog_visible', v_settings.catalog_visible,
    'checkout_enabled', v_settings.checkout_enabled,
    'nominal_cents_per_diamond', 1,
    'service_terms_version', public.fn_ca_commerce_policy_version('service_terms'),
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'sku', p.sku, 'title', p.title, 'kind', p.kind, 'scope_kind', p.scope_kind,
        'term_kind', p.term_kind, 'term_hours', p.term_hours, 'report_days', p.report_days,
        'capacity', p.capacity, 'quantity_unit', p.quantity_unit, 'supported', p.supported,
        'included_note', p.included_note,
        'platform_capability_id', p.platform_capability_id,
        'platform_available', CASE WHEN p.platform_capability_id IS NULL THEN NULL ELSE public.fn_capability_available(p.platform_capability_id) END,
        'private_scope_id', CASE WHEN v_staff THEN p.private_scope_id ELSE NULL END,
        'written_quote_id', CASE WHEN v_staff THEN p.written_quote_id ELSE NULL END,
        'price', CASE WHEN v.id IS NULL OR NOT v_show_prices THEN NULL ELSE jsonb_build_object(
          'price_version_id', v.id, 'version', v.version, 'diamonds', v.diamonds, 'price_rule', v.price_rule,
          'cap_diamonds', v.cap_diamonds, 'price_authority', v.price_authority,
          'comparison_verified', v.comparison_verified, 'effective_from', v.effective_from) END
      ) ORDER BY p.sort_order, p.sku)
      FROM public.ca_commerce_products p
      LEFT JOIN public.ca_commerce_price_versions v
        ON v.sku = p.sku AND v.status = 'published' AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now())
      WHERE (p_scope_kind IS NULL OR p.scope_kind = p_scope_kind)
        AND (v_staff OR p.private_scope_id IS NULL)
    ), '[]'::jsonb)
  );
END $$;

-- ---------------------------------------------------------------------------
-- 8. Replaced: the quote door (items 1, 4, 5 and 6). Everything it did
-- before is kept in order; the new checks come before the implementation,
-- which is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_quote(p_scope_kind text, p_scope_id uuid, p_lines jsonb, p_sponsorship_id uuid DEFAULT NULL, p_renewal_max_diamonds integer DEFAULT NULL, p_purchase_kind text DEFAULT 'purchase') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_settings public.ca_commerce_settings;
  v_line jsonb;
  v_private public.ca_commerce_products;
  v_w public.ca_commerce_written_quotes;
  v_recent integer;
  v_result jsonb;
  v_owner uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_purchase_kind NOT IN ('purchase','upgrade') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_purchase_kind');
  END IF;
  v_role := public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor);
  IF p_sponsorship_id IS NULL THEN
    IF v_role <> 'owner' THEN
      RETURN jsonb_build_object('success', false, 'error', 'owner_required');
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.ca_commerce_sponsorships s WHERE s.id = p_sponsorship_id AND s.payer_id = v_actor) THEN
      RETURN jsonb_build_object('success', false, 'error', 'sponsor_payer_required');
    END IF;
  END IF;
  -- The catalog switch: while it is off, only staff can price anything.
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  IF NOT v_settings.catalog_visible AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'catalog_not_visible');
  END IF;
  -- A person prices at most 120 baskets in 10 minutes.
  SELECT count(*) INTO v_recent FROM public.ca_commerce_quotes q
   WHERE q.actor_id = v_actor AND q.created_at > now() - interval '10 minutes';
  IF v_recent >= 120 THEN
    RETURN jsonb_build_object('success', false, 'error', 'rate_limited', 'retry_after_seconds', 600);
  END IF;
  -- A written-quote offer is priced only for its own club, and only until it
  -- expires, unless that club already bought it (then it renews and upgrades
  -- like any capacity).
  IF jsonb_typeof(p_lines) = 'array' THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      SELECT * INTO v_private FROM public.ca_commerce_products p
       WHERE p.sku = v_line->>'sku' AND p.private_scope_id IS NOT NULL;
      IF v_private.sku IS NOT NULL THEN
        IF v_private.private_scope_kind <> p_scope_kind OR v_private.private_scope_id <> p_scope_id THEN
          RETURN jsonb_build_object('success', false, 'error', 'unknown_sku', 'sku', v_line->>'sku');
        END IF;
        SELECT * INTO v_w FROM public.ca_commerce_written_quotes WHERE id = v_private.written_quote_id;
        IF v_w.valid_until <= now() AND NOT EXISTS (
             SELECT 1 FROM public.ca_commerce_entitlements e
              WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.sku = v_private.sku) THEN
          RETURN jsonb_build_object('success', false, 'error', 'written_quote_expired', 'sku', v_private.sku);
        END IF;
      END IF;
    END LOOP;
  END IF;
  v_result := public.fn_ca_commerce_quote_impl(v_actor, v_actor, p_scope_kind, p_scope_id, p_lines, p_sponsorship_id, p_renewal_max_diamonds, p_purchase_kind);
  -- The owner who has never had a free month is told before paying for it.
  IF COALESCE((v_result->>'success')::boolean, false) AND p_sponsorship_id IS NULL AND p_purchase_kind = 'purchase' THEN
    v_owner := public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id);
    v_result := v_result || jsonb_build_object('free_month_available',
      (SELECT t.id FROM public.fn_ca_commerce_scope_trial(p_scope_kind, p_scope_id) t) IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.ca_commerce_trials t WHERE t.operator_id = v_owner AND t.cohort IN ('new_operator','launch_cohort')));
  END IF;
  RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Grants, restated. A REVOKE names PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.fn_ca_commerce_catalog(text),
  public.fn_ca_commerce_quote(text, uuid, jsonb, uuid, integer, text),
  public.fn_ca_commerce_written_quote_request(text, uuid, integer, text),
  public.fn_ca_commerce_written_quote_offer(uuid, integer, integer, integer, text),
  public.fn_ca_commerce_written_quote_decline(uuid, text),
  public.fn_ca_commerce_written_quote_withdraw(uuid),
  public.fn_ca_commerce_written_quotes(text, uuid),
  public.fn_ca_commerce_trial_review_request(text, uuid, text),
  public.fn_ca_commerce_trial_review_decide(uuid, boolean, text),
  public.fn_ca_commerce_trial_reviews(text, uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.fn_ca_commerce_catalog(text),
  public.fn_ca_commerce_quote(text, uuid, jsonb, uuid, integer, text),
  public.fn_ca_commerce_written_quote_request(text, uuid, integer, text),
  public.fn_ca_commerce_written_quote_offer(uuid, integer, integer, integer, text),
  public.fn_ca_commerce_written_quote_decline(uuid, text),
  public.fn_ca_commerce_written_quote_withdraw(uuid),
  public.fn_ca_commerce_written_quotes(text, uuid),
  public.fn_ca_commerce_trial_review_request(text, uuid, text),
  public.fn_ca_commerce_trial_review_decide(uuid, boolean, text),
  public.fn_ca_commerce_trial_reviews(text, uuid)
TO authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.fn_ca_commerce_trial_waiver_snapshot(),
  public.fn_ca_commerce_written_quote_json(public.ca_commerce_written_quotes),
  public.fn_ca_commerce_trial_review_json(public.ca_commerce_trial_reviews)
FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. Post-conditions.
-- ---------------------------------------------------------------------------
DO $post$
BEGIN
  IF public.fn_ca_commerce_policy_version('service_terms') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'service terms version 1 must be in effect';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_commerce_quote(text,uuid,jsonb,uuid,integer,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_ca_commerce_quote(text,uuid,jsonb,uuid,integer,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_commerce_written_quote_offer(uuid,integer,integer,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_commerce_written_quote_json(public.ca_commerce_written_quotes)', 'EXECUTE') THEN
    RAISE EXCEPTION 'commerce grants are not as declared';
  END IF;
  IF has_table_privilege('authenticated', 'public.ca_commerce_written_quotes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ca_commerce_trial_reviews', 'SELECT') THEN
    RAISE EXCEPTION 'written quotes and trial reviews are read only through their doors';
  END IF;
  IF strpos(pg_get_functiondef('public.fn_ca_commerce_activate_trial_impl(text,uuid,uuid,text,timestamp with time zone)'::regprocedure),
            'cohort IN (''new_operator'',''launch_cohort'')') = 0 THEN
    RAISE EXCEPTION 'the trial activation must inherit only the operator''s initial trial';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_commerce_products WHERE private_scope_id IS NOT NULL) THEN
    RAISE EXCEPTION 'installation must not create a private offer';
  END IF;
END $post$;

COMMIT;
