-- 20260924102040_diamond_commerce_refunds_notices_and_catalog_lifecycle.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Assignment CA-DIAMOND-COMMERCE-2026-09-22 R2, the refunds, notices and
-- catalog-lifecycle increment. It builds on 20260922143541 (base) and
-- 20260924033509 (fixes) and replaces ten of their functions, each pinned to
-- its live body below. Every change is pinned by a check in
-- tests/sql/run-diamond-club-commerce-refunds.py that fails without it.
--
--  1. Refunds (R2 6.4, 4.5). Owners REQUEST, platform staff DECIDE, and the
--     engine's commerce consumer EXECUTES in service context through the
--     existing exact-value core fn_ca_commerce_refund (the spec's trusted
--     server route; the profile wallet guard is unchanged). A versioned policy
--     table carries refund policy v1; the request door computes the policy
--     amount server-side and records it; one open request per purchase line.
--     A refund the wallet cannot receive yet (the existing D64 refusal) stays
--     in a visible `owed` state with its reason and is attempted again on the
--     consumer's next wake. The request and its state are shown in receipts
--     and in the scope status. Notices on request, decision and execution.
--  2. Consumer heartbeat. fn_ca_commerce_claim_due_renewals stamps
--     ca_commerce_settings.consumer_heartbeat_at on every call, and the launch
--     cohort refuses to enrol anyone unless the consumer that will deliver
--     their reminders and renewals has woken in the last ten minutes. The
--     cohort now tells every enrolled owner about the free month.
--  3. Sponsored renewals. A sponsor may authorize the renewal of a right their
--     sponsorship paid for; the renewal is charged to the sponsor through the
--     same sponsorship checks and budget. The club owner still cannot spend
--     the sponsor's diamonds.
--  4. Notices. A higher published price is announced to every payer whose
--     standing renewal it affects, with their ceiling. Every authorized
--     renewal records a balance check due 72 hours before it; at delivery the
--     payer's balance is compared with the price in effect that day and the
--     notice is either delivered with the shortfall or suppressed on record.
--  5. Consent versioning. A mandate records the renewal terms version and the
--     ceiling text version the payer accepted (R2 5.4).
--  6. Catalog lifecycle (R2 7.3). Draft -> validated (checked) -> published ->
--     retired, each with an audit event; comparison evidence is recorded by
--     staff and a price version is marked comparison_verified only when a
--     second staff member verifies it (R2 4.4). No automatic badge.
--  7. Owner reads. The scope status adds the available / reserved / pending
--     balance breakdown and the open refund requests; receipts stay readable
--     by the person who paid after they lose their role on the scope, and
--     name only what that person paid for.
--  8. Withdrawing a product (fn_ca_commerce_product_support false) withdraws
--     every open quote that sells it in the same transaction, so a quote
--     taken before the withdrawal can no longer be bought (R2 D06). Staff
--     reads for the Commerce Desk list every price version and every piece
--     of comparison evidence.
--
-- Not a repair job (CLAUDE.md 10.12): nothing here sweeps, back-pays or
-- re-drives. The owed refund is the consumer's own obligation, executed by
-- its owner the moment the wallet can receive it; it was never paid by any
-- live path first.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- The installed baseline, exactly: every function this migration replaces
-- still carries the live body (read 2026-09-24), and nothing this migration
-- adds exists yet. Anything else means another change landed first; stop and
-- review rather than overwrite it.
DO $baseline$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('fn_ca_commerce_receipts', 'b464fc140bc6e1810196c0d7c3d2e1a3'),
    ('fn_ca_commerce_deliver_due_notices', 'b2bf4cbd2fffb49af9fcf9d785b57bad'),
    ('fn_ca_commerce_claim_due_renewals', '3ad3d520322e53adc2e8e376d7fca7c3'),
    ('fn_ca_commerce_execute_renewal', 'bee7299797762237aeab8a7d98c2d705'),
    ('fn_ca_commerce_set_renewal', 'fe596050bb7d22b42a1d38ac9dba8818'),
    ('fn_ca_commerce_scope_status', 'f57845b8fb87f1c1f32f94ee771c821f'),
    ('fn_ca_commerce_price_draft', '5c82a8ad9fcfc5791f6c3163d85e1ef6'),
    ('fn_ca_commerce_price_publish', '3a21220f50fe66cd21bcc9d542ce8527'),
    ('fn_ca_commerce_activate_launch_cohort', '87826fae6c5be1d47bb140faa261ada2'),
    ('fn_ca_commerce_product_support', '7294f3eb813de69ec155a9abac2b7c89'),
    ('fn_ca_commerce_quote_impl', '6db7a6ce5c84e09bddcf66fabcddf4b0')
  ) AS t(fn, md5) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'commerce baseline changed: % is not the live body this migration replaces', r.fn;
    END IF;
  END LOOP;
  IF to_regclass('public.ca_commerce_policies') IS NOT NULL
     OR to_regclass('public.ca_commerce_refund_requests') IS NOT NULL
     OR to_regclass('public.ca_commerce_comparison_evidence') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ca_commerce_settings' AND column_name = 'consumer_heartbeat_at')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ca_commerce_renewal_mandates' AND column_name = 'sponsorship_id')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ca_commerce_products' AND column_name = 'platform_capability_id') THEN
    RAISE EXCEPTION 'commerce baseline changed: an object this migration adds already exists';
  END IF;
  -- Prompt 1's capability registry (20260924025555), the one authority on
  -- whether a technical capability may be sold (CAPABILITY-CONTRACT.md 2, 3).
  IF to_regprocedure('public.fn_capability_available(text)') IS NULL THEN
    RAISE EXCEPTION 'the platform capability registry (20260924025555) must be installed first';
  END IF;
END $baseline$;

-- ---------------------------------------------------------------------------
-- 0b. Commerce sells only what the platform can do (Prompt 1's capability
-- contract, docs/handoffs/club-arena-product-completion/CAPABILITY-CONTRACT.md,
-- section 2: "Commerce MUST NOT sell, enable or advertise a capability that
-- is not available"). A product that sells a technical capability names it;
-- the quote (and so every purchase, upgrade and renewal, which all quote
-- first) refuses it while fn_capability_available says no, and staff cannot
-- mark it supported while it is unavailable. Both insurance modules sell
-- cash.insurance_ev_cashout (deployed today). Capacity, reports and assets
-- sell no technical capability of the registry.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_commerce_products ADD COLUMN platform_capability_id text
  CHECK (platform_capability_id IS NULL OR platform_capability_id ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$');
UPDATE public.ca_commerce_products SET platform_capability_id = 'cash.insurance_ev_cashout'
 WHERE sku IN ('club_insurance_module', 'union_insurance_module');

DO $capability$
DECLARE
  v_before text;
  v_after text;
  v_acl_before aclitem[];
  v_acl_after aclitem[];
  v_oid oid := to_regprocedure('public.fn_ca_commerce_quote_impl(uuid,uuid,text,uuid,jsonb,uuid,integer,text)');
  v_anchor text := $a$    IF NOT v_product.supported THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_not_available', 'sku', v_product.sku, 'line', v_i);
    END IF;
$a$;
  v_insert text := $n$    -- A product that sells a platform capability is not sold while the
    -- registry says the capability is unavailable (20260924102040).
    IF v_product.platform_capability_id IS NOT NULL
       AND NOT public.fn_capability_available(v_product.platform_capability_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_not_available', 'sku', v_product.sku, 'line', v_i,
        'capability', v_product.platform_capability_id);
    END IF;
$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl INTO v_before, v_acl_before FROM pg_proc p WHERE p.oid = v_oid;
  IF (length(v_before) - length(replace(v_before, v_anchor, ''))) <> length(v_anchor) THEN
    RAISE EXCEPTION 'the quote''s supported check must occur exactly once; review the live body';
  END IF;
  EXECUTE replace(v_before, v_anchor, v_anchor || v_insert);
  SELECT pg_get_functiondef(p.oid), p.proacl INTO v_after, v_acl_after FROM pg_proc p WHERE p.oid = v_oid;
  IF replace(v_after, v_anchor || v_insert, v_anchor) IS DISTINCT FROM v_before OR v_acl_after IS DISTINCT FROM v_acl_before THEN
    RAISE EXCEPTION 'the capability check changed the quote beyond its own lines';
  END IF;
END $capability$;

-- ---------------------------------------------------------------------------
-- 1. Versioned policy texts (R2 5.4, 6.4). A version is never edited: a new
-- text is a new version. Title Case, no em dashes: a person reads these.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('refund','renewal_terms','renewal_ceiling')),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  body text NOT NULL CHECK (strpos(body, chr(8212)) = 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);
ALTER TABLE public.ca_commerce_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_policies FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_ca_commerce_policy_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'A Policy Version Is Never Edited Or Deleted; Publish A New Version';
END $$;
CREATE TRIGGER ca_commerce_policies_immutable BEFORE UPDATE OR DELETE ON public.ca_commerce_policies
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_commerce_policy_immutable();

INSERT INTO public.ca_commerce_policies (kind, version, title, body) VALUES
  ('refund', 1, 'Refund Policy',
   'A Purchase Made In Error With No Rights Used Is Refunded In Full Within 24 Hours Of Purchase, Unless A Newer Purchase Has Replaced It. '
   || 'Otherwise The Unused Whole Days Of A Paid Period Are Refunded Pro Rata When The Club Or Union Closes, When The Service Was Unavailable, Or When Platform Staff Find A Platform Defect. '
   || 'The Free Month Is Never Charged, So There Is Nothing To Refund. '
   || 'A Sponsored Purchase Is Refunded To The Sponsor Who Paid For It. '
   || 'Platform Staff Review Every Request, And An Approved Refund Returns Diamonds To The Original Payer.'),
  ('renewal_terms', 1, 'Renewal Terms',
   'A Renewal Buys The Next Period At The Price Published On Its Due Date, And Only When That Price Is At Or Below Your Accepted Ceiling. '
   || 'A Higher Price Waits For Your Approval, And You Are Told Before It Takes Effect. '
   || 'Your Balance Is Checked 72 Hours Before Each Due Date, And You Are Told If It Falls Short. '
   || 'Cancelling Stops Future Renewals And Never Ends A Period Already Paid. '
   || 'Refunds Follow Refund Policy Version 1.'),
  ('renewal_ceiling', 1, 'Renewal Authorization',
   'I Authorize Club Arena To Renew {product} For Up To {ceiling} Diamonds Per Period, Paid From {payer}, Until I Cancel.');

-- The version of a policy kind in effect at a moment.
CREATE FUNCTION public.fn_ca_commerce_policy_version(p_kind text, p_at timestamptz DEFAULT now()) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT max(version) FROM public.ca_commerce_policies WHERE kind = p_kind AND effective_from <= p_at
$$;

-- The exact ceiling sentence a payer accepted, rebuilt from its immutable
-- template version and the mandate's own figures.
CREATE FUNCTION public.fn_ca_commerce_ceiling_text(p_version integer, p_sku text, p_quantity integer, p_max_diamonds integer, p_sponsored boolean) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT replace(replace(replace(pol.body,
           '{product}', COALESCE((SELECT p.title FROM public.ca_commerce_products p WHERE p.sku = p_sku), 'This Service')
                        || CASE WHEN COALESCE(p_quantity, 1) > 1 THEN ' For ' || p_quantity::text || ' Covered Clubs' ELSE '' END),
           '{ceiling}', to_char(p_max_diamonds, 'FM999,999,999,990')),
           '{payer}', CASE WHEN p_sponsored THEN 'My Diamond Balance Within My Sponsorship Budget' ELSE 'My Diamond Balance' END)
    FROM public.ca_commerce_policies pol
   WHERE pol.kind = 'renewal_ceiling' AND pol.version = p_version
$$;

-- ---------------------------------------------------------------------------
-- 2. New columns.
-- ---------------------------------------------------------------------------
-- The consumer's last wake. Stamped by the claim door on every call.
ALTER TABLE public.ca_commerce_settings ADD COLUMN consumer_heartbeat_at timestamptz;

-- A sponsor-paid renewal names its sponsorship; consent carries its versions.
-- Existing mandates keep NULL versions: they were accepted before versioned
-- texts existed, and a version they never saw is not written onto them.
ALTER TABLE public.ca_commerce_renewal_mandates
  ADD COLUMN sponsorship_id uuid REFERENCES public.ca_commerce_sponsorships(id),
  ADD COLUMN terms_version integer,
  ADD COLUMN ceiling_text_version integer;
-- New rows from any authorizing path (including the purchase boundary's
-- renewal-at-checkout) record the versions in effect when they were accepted.
ALTER TABLE public.ca_commerce_renewal_mandates
  ALTER COLUMN terms_version SET DEFAULT public.fn_ca_commerce_policy_version('renewal_terms'),
  ALTER COLUMN ceiling_text_version SET DEFAULT public.fn_ca_commerce_policy_version('renewal_ceiling');
CREATE INDEX ca_commerce_renewal_mandates_sku_authorized ON public.ca_commerce_renewal_mandates (sku) WHERE state = 'authorized';

-- A notice checked at delivery can be suppressed on record instead of sent.
ALTER TABLE public.ca_commerce_notices
  ADD COLUMN suppressed_at timestamptz,
  ADD COLUMN suppressed_reason text;
CREATE INDEX ca_commerce_notices_pending ON public.ca_commerce_notices (due_at) WHERE delivered_at IS NULL AND suppressed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Refund requests (R2 6.4). Owner requests, staff decides, the consumer
-- executes through the exact-value core. One open request per purchase line.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.ca_commerce_purchases(id),
  line_index integer NOT NULL CHECK (line_index >= 0),
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 8 AND 200),
  reason_code text NOT NULL CHECK (reason_code IN ('purchase_in_error','scope_closed','service_unavailable','platform_defect')),
  details text CHECK (details IS NULL OR length(details) <= 2000),
  policy_id uuid NOT NULL REFERENCES public.ca_commerce_policies(id),
  policy_version integer NOT NULL,
  policy_basis text NOT NULL CHECK (policy_basis IN ('error_full','pro_rata_unused_days')),
  policy_amount integer NOT NULL CHECK (policy_amount > 0),
  policy_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','approved','declined','owed','refunded','failed')),
  approved_amount integer CHECK (approved_amount IS NULL OR approved_amount > 0),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  owed_reason text,
  last_error text,
  refund_id uuid REFERENCES public.ca_commerce_refunds(id),
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requested_by, request_key),
  CHECK ((state IN ('approved','owed','refunded','failed')) = (approved_amount IS NOT NULL)),
  CHECK ((state = 'requested') = (decided_at IS NULL)),
  CHECK ((state = 'refunded') = (refund_id IS NOT NULL)),
  CHECK (state <> 'owed' OR owed_reason IS NOT NULL)
);
CREATE UNIQUE INDEX ca_commerce_refund_requests_one_open ON public.ca_commerce_refund_requests (purchase_id, line_index)
  WHERE state IN ('requested','approved','owed');
CREATE INDEX ca_commerce_refund_requests_executable ON public.ca_commerce_refund_requests (decided_at, id) WHERE state IN ('approved','owed');
CREATE INDEX ca_commerce_refund_requests_payer ON public.ca_commerce_refund_requests (payer_id, created_at DESC);
CREATE INDEX ca_commerce_refund_requests_scope ON public.ca_commerce_refund_requests (scope_kind, scope_id, created_at DESC);
CREATE INDEX ca_commerce_refund_requests_queue ON public.ca_commerce_refund_requests (state, created_at);
ALTER TABLE public.ca_commerce_refund_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_refund_requests FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Competitor comparison evidence (R2 4, 7.3). Recorded by staff; a price
-- version is marked comparison_verified only by a second staff member.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_comparison_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL REFERENCES public.ca_commerce_products(sku),
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 2 AND 120),
  source_url text NOT NULL CHECK (source_url ~ '^https://[^\s]{4,}$' AND length(source_url) <= 1000),
  observed_price numeric NOT NULL CHECK (observed_price > 0),
  observed_unit text NOT NULL CHECK (length(observed_unit) BETWEEN 2 AND 120),
  observed_at timestamptz NOT NULL,
  conversion_note text NOT NULL CHECK (length(conversion_note) BETWEEN 10 AND 2000),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  price_version_id uuid REFERENCES public.ca_commerce_price_versions(id),
  verified_by uuid,
  verified_at timestamptz,
  CHECK ((verified_by IS NULL) = (verified_at IS NULL)),
  CHECK (verified_by IS NULL OR verified_by <> recorded_by),
  CHECK (verified_by IS NULL OR price_version_id IS NOT NULL)
);
CREATE INDEX ca_commerce_comparison_evidence_sku ON public.ca_commerce_comparison_evidence (sku, recorded_at DESC);
ALTER TABLE public.ca_commerce_comparison_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_comparison_evidence FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The 72-hour balance check (R2 4.3). Every time a mandate is authorized,
-- re-authorized, carried forward or moved to a new due date, one check is
-- recorded for 72 hours before that due date (or now, if that is already
-- past). It is decided at delivery by fn_ca_commerce_deliver_due_notices
-- against the price in effect that day, never at authorization. This records
-- the obligation at the moment it arises; it repairs nothing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_mandate_funds_notice() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.ca_commerce_notices (user_id, dedupe_key, kind, title, message, action_url, payload, due_at)
  VALUES (NEW.payer_id,
          'renewal-funds:' || NEW.id::text || ':' || floor(extract(epoch FROM NEW.due_at))::bigint::text
            || ':' || floor(extract(epoch FROM NEW.accepted_at) * 1000000)::bigint::text,
          'club_commerce_renewal_funds',
          'Renewal Balance Check',
          'Your Balance Is Checked Against The Renewal Price 72 Hours Before It Is Due.',
          '/hub/club-arena/' || NEW.scope_kind || 's/' || NEW.scope_id::text || '/diamond-costs',
          jsonb_build_object('mandate_id', NEW.id, 'due_at', NEW.due_at, 'accepted_at', NEW.accepted_at, 'sku', NEW.sku, 'quantity', NEW.quantity),
          GREATEST(NEW.due_at - interval '72 hours', now()))
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER ca_commerce_mandate_funds_notice
  AFTER INSERT OR UPDATE OF state, due_at, payer_id, accepted_at ON public.ca_commerce_renewal_mandates
  FOR EACH ROW WHEN (NEW.state = 'authorized')
  EXECUTE FUNCTION public.fn_ca_commerce_mandate_funds_notice();

-- ---------------------------------------------------------------------------
-- 6. Refund arithmetic, shared by the request, the decision and the reads.
-- ---------------------------------------------------------------------------
-- The unreturned part of one line: its net debit less what was refunded and
-- less unused value already credited into an upgrade that replaced its right.
-- This is exactly the remainder fn_ca_commerce_refund enforces.
CREATE FUNCTION public.fn_ca_commerce_refundable(p_purchase_id uuid, p_line_index integer) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT GREATEST(
    COALESCE((SELECT (l->>'net')::integer FROM public.ca_commerce_purchases p, jsonb_array_elements(p.lines) l
               WHERE p.id = p_purchase_id AND (l->>'index')::integer = p_line_index), 0)
    - COALESCE((SELECT SUM(r.gross) FROM public.ca_commerce_refunds r WHERE r.purchase_id = p_purchase_id AND r.line_index = p_line_index), 0)
    - COALESCE((SELECT SUM((l->>'credit')::integer)
                  FROM public.ca_commerce_entitlements e
                  JOIN public.ca_commerce_entitlements n ON n.id = e.superseded_by
                  JOIN public.ca_commerce_purchases u ON u.id = n.purchase_id
                  CROSS JOIN LATERAL jsonb_array_elements(u.lines) l
                 WHERE e.purchase_id = p_purchase_id AND e.line_index = p_line_index
                   AND l->>'replaces_entitlement_id' = e.id::text), 0),
    0)::integer
$$;

-- Refund policy v1 applied to one line at one moment. Returns the amount the
-- policy allows and how it was reached, or the reason it allows nothing.
CREATE FUNCTION public.fn_ca_commerce_refund_policy(p_purchase_id uuid, p_line_index integer, p_reason text, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_p public.ca_commerce_purchases;
  v_line jsonb;
  v_net integer;
  v_refundable integer;
  v_ent public.ca_commerce_entitlements;
  v_unused integer := 0;
  v_period_days numeric;
  v_amount integer;
  v_detail jsonb;
BEGIN
  SELECT * INTO v_p FROM public.ca_commerce_purchases WHERE id = p_purchase_id;
  IF v_p.id IS NULL THEN RETURN jsonb_build_object('eligible', false, 'error', 'purchase_not_found'); END IF;
  v_line := (SELECT l FROM jsonb_array_elements(v_p.lines) l WHERE (l->>'index')::integer = p_line_index);
  IF v_line IS NULL THEN RETURN jsonb_build_object('eligible', false, 'error', 'line_not_found'); END IF;
  v_net := (v_line->>'net')::integer;
  -- (c) The free month is never charged: a waived or zero line has no principal.
  IF COALESCE(v_net, 0) = 0 THEN RETURN jsonb_build_object('eligible', false, 'error', 'nothing_paid_on_this_line'); END IF;
  v_refundable := public.fn_ca_commerce_refundable(p_purchase_id, p_line_index);
  IF v_refundable <= 0 THEN
    RETURN jsonb_build_object('eligible', false, 'error', 'nothing_left_to_refund', 'line_net', v_net);
  END IF;
  SELECT * INTO v_ent FROM public.ca_commerce_entitlements e
   WHERE e.purchase_id = p_purchase_id AND e.line_index = p_line_index ORDER BY e.created_at LIMIT 1;
  v_detail := jsonb_build_object('line_net', v_net, 'refundable', v_refundable, 'purchased_at', v_p.created_at,
    'right_state', v_ent.state, 'right_starts_at', v_ent.starts_at, 'right_ends_at', v_ent.ends_at,
    'right_started', v_ent.starts_at IS NOT NULL AND v_ent.starts_at <= p_at, 'sponsored', v_p.sponsorship_id IS NOT NULL);

  IF p_reason = 'purchase_in_error' THEN
    -- (a) In full within 24 hours, if no newer purchase replaced it. Whether
    -- any right was used is the staff member's finding; the request carries
    -- right_started so they can see it.
    IF p_at >= v_p.created_at + interval '24 hours' THEN
      RETURN jsonb_build_object('eligible', false, 'error', 'error_window_passed', 'purchased_at', v_p.created_at);
    END IF;
    IF v_ent.superseded_by IS NOT NULL OR v_ent.state = 'superseded' THEN
      RETURN jsonb_build_object('eligible', false, 'error', 'replaced_by_newer_purchase');
    END IF;
    RETURN jsonb_build_object('eligible', true, 'basis', 'error_full', 'amount', v_refundable) || v_detail;
  END IF;

  -- (b) The unused whole days of a paid period, pro rata to what this line
  -- paid, when the scope closed, the service was unavailable or staff find a
  -- platform defect. A superseded right ended at its upgrade: its value was
  -- credited forward and it has no unused days of its own.
  IF v_ent.id IS NULL OR v_ent.ends_at IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'error', 'not_a_period_right');
  END IF;
  v_period_days := extract(epoch FROM (v_ent.ends_at - v_ent.starts_at)) / 86400.0;
  IF v_ent.state = 'effective' AND v_ent.ends_at > p_at THEN
    v_unused := floor(extract(epoch FROM (v_ent.ends_at - GREATEST(p_at, v_ent.starts_at))) / 86400.0)::integer;
  END IF;
  v_amount := LEAST(floor(v_net::numeric * v_unused / v_period_days)::integer, v_refundable);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('eligible', false, 'error', 'no_unused_whole_days', 'unused_days', v_unused);
  END IF;
  RETURN jsonb_build_object('eligible', true, 'basis', 'pro_rata_unused_days', 'amount', v_amount,
    'unused_days', v_unused, 'period_days', round(v_period_days, 4)) || v_detail;
END $$;

-- One request as the payer and staff read it.
CREATE FUNCTION public.fn_ca_commerce_refund_request_json(p_r public.ca_commerce_refund_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'request_id', p_r.id, 'purchase_id', p_r.purchase_id, 'line_index', p_r.line_index,
    'scope_kind', p_r.scope_kind, 'scope_id', p_r.scope_id, 'payer_id', p_r.payer_id, 'requested_by', p_r.requested_by,
    'reason_code', p_r.reason_code, 'details', p_r.details,
    'policy_version', p_r.policy_version, 'policy_basis', p_r.policy_basis, 'policy_amount', p_r.policy_amount, 'policy_detail', p_r.policy_detail,
    'state', p_r.state, 'approved_amount', p_r.approved_amount,
    'pending_amount', CASE WHEN p_r.state IN ('requested','approved','owed') THEN COALESCE(p_r.approved_amount, p_r.policy_amount) ELSE 0 END,
    'decided_at', p_r.decided_at, 'decision_note', p_r.decision_note,
    'owed_reason', p_r.owed_reason, 'last_error', p_r.last_error, 'attempts', p_r.attempts,
    'refund_id', p_r.refund_id, 'executed_at', p_r.executed_at,
    'created_at', p_r.created_at, 'updated_at', p_r.updated_at)
$$;

-- ---------------------------------------------------------------------------
-- 7. The owner's door: request a refund. The payer only (the scope owner can
-- request for a purchase they paid; a sponsored purchase is the sponsor's).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_refund_request(p_purchase_id uuid, p_line_index integer, p_reason text, p_request_key text, p_details text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_p public.ca_commerce_purchases;
  v_existing public.ca_commerce_refund_requests;
  v_open public.ca_commerce_refund_requests;
  v_policy public.ca_commerce_policies;
  v_calc jsonb;
  v_r public.ca_commerce_refund_requests;
  v_title text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_request_key IS NULL OR length(p_request_key) < 8 OR length(p_request_key) > 200 THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_key_required');
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('purchase_in_error','scope_closed','service_unavailable','platform_defect') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_reason',
      'allowed', jsonb_build_array('purchase_in_error','scope_closed','service_unavailable','platform_defect'));
  END IF;
  IF p_details IS NOT NULL AND length(p_details) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'details_too_long');
  END IF;
  IF p_purchase_id IS NULL OR p_line_index IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found');
  END IF;
  -- Request identity: same key and payload replays; same key, other payload refuses.
  SELECT * INTO v_existing FROM public.ca_commerce_refund_requests WHERE requested_by = v_actor AND request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.purchase_id <> p_purchase_id OR v_existing.line_index <> p_line_index OR v_existing.reason_code <> p_reason THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN jsonb_build_object('success', true, 'is_replay', true, 'request', public.fn_ca_commerce_refund_request_json(v_existing));
  END IF;
  SELECT * INTO v_p FROM public.ca_commerce_purchases WHERE id = p_purchase_id;
  IF v_p.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found');
  END IF;
  -- Only the diamonds' owner asks for them back; a refund returns to the
  -- original payer, never to whoever holds the scope now (R2 5.2).
  IF v_p.payer_id <> v_actor THEN
    RETURN jsonb_build_object('success', false, 'error', 'payer_required');
  END IF;
  -- The same lock the refund core takes for this purchase: a request cannot
  -- interleave with a refund of the same purchase being executed.
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_refund:' || v_p.id::text, 0));
  SELECT * INTO v_existing FROM public.ca_commerce_refund_requests WHERE requested_by = v_actor AND request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.purchase_id <> p_purchase_id OR v_existing.line_index <> p_line_index OR v_existing.reason_code <> p_reason THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN jsonb_build_object('success', true, 'is_replay', true, 'request', public.fn_ca_commerce_refund_request_json(v_existing));
  END IF;
  SELECT * INTO v_open FROM public.ca_commerce_refund_requests
   WHERE purchase_id = p_purchase_id AND line_index = p_line_index AND state IN ('requested','approved','owed');
  IF v_open.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_already_open', 'request', public.fn_ca_commerce_refund_request_json(v_open));
  END IF;
  SELECT * INTO v_policy FROM public.ca_commerce_policies
   WHERE kind = 'refund' AND version = public.fn_ca_commerce_policy_version('refund');
  v_calc := public.fn_ca_commerce_refund_policy(p_purchase_id, p_line_index, p_reason, now());
  IF NOT COALESCE((v_calc->>'eligible')::boolean, false) THEN
    RETURN jsonb_build_object('success', false, 'error', v_calc->>'error', 'policy_version', v_policy.version) || (v_calc - 'eligible' - 'error');
  END IF;
  INSERT INTO public.ca_commerce_refund_requests (purchase_id, line_index, scope_kind, scope_id, payer_id, requested_by, request_key,
    reason_code, details, policy_id, policy_version, policy_basis, policy_amount, policy_detail)
  VALUES (v_p.id, p_line_index, v_p.scope_kind, v_p.scope_id, v_p.payer_id, v_actor, p_request_key,
    p_reason, NULLIF(btrim(p_details), ''), v_policy.id, v_policy.version, v_calc->>'basis', (v_calc->>'amount')::integer,
    v_calc - 'eligible' - 'basis' - 'amount')
  RETURNING * INTO v_r;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('refund_requested', v_actor, v_r.scope_kind, v_r.scope_id, v_r.id,
          jsonb_build_object('purchase_id', v_r.purchase_id, 'line_index', v_r.line_index, 'reason_code', v_r.reason_code,
                             'policy_version', v_r.policy_version, 'policy_amount', v_r.policy_amount, 'basis', v_r.policy_basis));
  v_title := COALESCE((SELECT l->>'title' FROM jsonb_array_elements(v_p.lines) l WHERE (l->>'index')::integer = p_line_index), 'This Service');
  PERFORM public.fn_ca_commerce_notice(v_r.payer_id, 'refund-request:' || v_r.id::text, 'club_commerce_refund_request',
    'Refund Request Received',
    'Your Refund Request For ' || v_title || ' Is With Platform Staff. Under Refund Policy Version ' || v_r.policy_version::text
      || ' The Amount Is ' || to_char(v_r.policy_amount, 'FM999,999,999,990') || ' Diamonds.',
    '/hub/club-arena/' || v_r.scope_kind || 's/' || v_r.scope_id::text || '/diamond-costs',
    jsonb_build_object('request_id', v_r.id, 'purchase_id', v_r.purchase_id, 'policy_amount', v_r.policy_amount));
  RETURN jsonb_build_object('success', true, 'is_replay', false, 'request', public.fn_ca_commerce_refund_request_json(v_r));
END $$;

-- ---------------------------------------------------------------------------
-- 8. The staff door: decide. A named platform admin, never the payer or the
-- requester; the amount may not exceed the refundable remainder.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_refund_decide(p_request_id uuid, p_approve boolean, p_amount integer DEFAULT NULL, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_r public.ca_commerce_refund_requests;
  v_amount integer;
  v_refundable integer;
  v_title text;
  v_url text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF p_approve IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'decision_required');
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  SELECT * INTO v_r FROM public.ca_commerce_refund_requests WHERE id = p_request_id FOR UPDATE;
  IF v_r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_found');
  END IF;
  IF v_r.requested_by = v_actor OR v_r.payer_id = v_actor THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot_decide_own_request');
  END IF;
  IF v_r.state <> 'requested' THEN
    IF (p_approve AND v_r.state IN ('approved','owed','refunded','failed')) OR (NOT p_approve AND v_r.state = 'declined') THEN
      RETURN jsonb_build_object('success', true, 'is_replay', true, 'request', public.fn_ca_commerce_refund_request_json(v_r));
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'already_decided', 'request', public.fn_ca_commerce_refund_request_json(v_r));
  END IF;
  v_title := COALESCE((SELECT l->>'title' FROM public.ca_commerce_purchases p, jsonb_array_elements(p.lines) l
                        WHERE p.id = v_r.purchase_id AND (l->>'index')::integer = v_r.line_index), 'This Service');
  v_url := '/hub/club-arena/' || v_r.scope_kind || 's/' || v_r.scope_id::text || '/diamond-costs';
  IF p_approve THEN
    v_amount := COALESCE(p_amount, v_r.policy_amount);
    IF v_amount IS NULL OR v_amount <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'amount_required');
    END IF;
    v_refundable := public.fn_ca_commerce_refundable(v_r.purchase_id, v_r.line_index);
    IF v_amount > v_refundable THEN
      RETURN jsonb_build_object('success', false, 'error', 'exceeds_refundable', 'refundable', v_refundable);
    END IF;
    UPDATE public.ca_commerce_refund_requests
       SET state = 'approved', approved_amount = v_amount, decided_by = v_actor, decided_at = now(), decision_note = NULLIF(btrim(p_note), ''), updated_at = now()
     WHERE id = v_r.id RETURNING * INTO v_r;
    PERFORM public.fn_ca_commerce_notice(v_r.payer_id, 'refund-decision:' || v_r.id::text, 'club_commerce_refund_decision',
      'Refund Approved',
      'Your Refund Of ' || to_char(v_amount, 'FM999,999,999,990') || ' Diamonds For ' || v_title || ' Was Approved And Is Being Returned To Your Diamond Balance.',
      v_url, jsonb_build_object('request_id', v_r.id, 'approved_amount', v_amount));
  ELSE
    IF p_note IS NULL OR length(btrim(p_note)) < 5 THEN
      RETURN jsonb_build_object('success', false, 'error', 'note_required');
    END IF;
    UPDATE public.ca_commerce_refund_requests
       SET state = 'declined', decided_by = v_actor, decided_at = now(), decision_note = btrim(p_note), updated_at = now()
     WHERE id = v_r.id RETURNING * INTO v_r;
    PERFORM public.fn_ca_commerce_notice(v_r.payer_id, 'refund-decision:' || v_r.id::text, 'club_commerce_refund_decision',
      'Refund Request Declined',
      'Your Refund Request For ' || v_title || ' Was Declined. Note From Platform Staff: '
        || initcap(rtrim(replace(btrim(p_note), chr(8212), '-'), '.')) || '.',
      v_url, jsonb_build_object('request_id', v_r.id));
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('refund_request_' || v_r.state, v_actor, v_r.scope_kind, v_r.scope_id, v_r.id,
          jsonb_build_object('purchase_id', v_r.purchase_id, 'line_index', v_r.line_index, 'approved_amount', v_r.approved_amount,
                             'policy_amount', v_r.policy_amount, 'note', v_r.decision_note));
  RETURN jsonb_build_object('success', true, 'is_replay', false, 'request', public.fn_ca_commerce_refund_request_json(v_r));
END $$;

-- Staff queue: every request in a state, oldest first.
CREATE FUNCTION public.fn_ca_commerce_refund_queue(p_state text DEFAULT NULL, p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  RETURN jsonb_build_object('success', true, 'requests', COALESCE((
    SELECT jsonb_agg(public.fn_ca_commerce_refund_request_json(q) ORDER BY q.created_at, q.id)
      FROM (SELECT * FROM public.ca_commerce_refund_requests r
             WHERE p_state IS NULL OR r.state = p_state
             ORDER BY r.created_at, r.id LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))) q), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 9. The consumer's door: execute approved refunds, exactly once each.
--
-- The engine's commerce consumer calls this on every wake, in service
-- context. It claims approved and owed requests (FOR UPDATE SKIP LOCKED, so
-- two consumers never take one request) and executes each through the exact
-- value core with the request id as its request key: a second execution of
-- the same request is the core's own replay, never a second credit.
--
-- A refund the wallet cannot receive yet (the core's D64 refusal: balance
-- headroom, a canonical reserve) is not lost and not paid partly: the request
-- goes to `owed` with the reason, the payer is told once, and the same owning
-- consumer attempts it again on its next wake. That is the owner of the
-- obligation executing it when it can be executed, not a repair job: no live
-- path ever owed this money first, and nothing else will pay it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_execute_approved_refunds(p_lease_token uuid, p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ids uuid[];
  v_id uuid;
  v_r public.ca_commerce_refund_requests;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_refunded integer := 0;
  v_owed integer := 0;
  v_failed integer := 0;
  v_title text;
  v_url text;
  v_reason_words text;
  v_owed_reason text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service Role Required';
  END IF;
  IF p_lease_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'lease_token_required');
  END IF;
  WITH due AS (
    SELECT r.id FROM public.ca_commerce_refund_requests r
     WHERE r.state IN ('approved','owed') AND (r.lease_until IS NULL OR r.lease_until <= clock_timestamp())
     ORDER BY r.decided_at, r.id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 50))
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.ca_commerce_refund_requests r
       SET lease_token = p_lease_token, lease_until = clock_timestamp() + interval '2 minutes', attempts = r.attempts + 1, updated_at = now()
      FROM due WHERE r.id = due.id
    RETURNING r.id, r.decided_at
  )
  SELECT array_agg(id ORDER BY decided_at, id) INTO v_ids FROM claimed;

  FOREACH v_id IN ARRAY COALESCE(v_ids, '{}'::uuid[]) LOOP
    SELECT * INTO v_r FROM public.ca_commerce_refund_requests WHERE id = v_id;
    v_title := COALESCE((SELECT l->>'title' FROM public.ca_commerce_purchases p, jsonb_array_elements(p.lines) l
                          WHERE p.id = v_r.purchase_id AND (l->>'index')::integer = v_r.line_index), 'This Service');
    v_url := '/hub/club-arena/' || v_r.scope_kind || 's/' || v_r.scope_id::text || '/diamond-costs';
    BEGIN
      v_res := public.fn_ca_commerce_refund(v_r.purchase_id, v_r.line_index, v_r.approved_amount,
        'Refund Request ' || v_r.id::text || ': ' || initcap(replace(v_r.reason_code, '_', ' ')), v_r.id::text);
    EXCEPTION WHEN OTHERS THEN
      -- The core maps its own refusals to JSON; anything else rolled back
      -- this request alone. It stays owed under its reason, visible.
      v_res := jsonb_build_object('success', false, 'error', 'unexpected_error', 'detail', SQLERRM, 'retry_same_request_key', true);
    END;
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      UPDATE public.ca_commerce_refund_requests
         SET state = 'refunded', refund_id = (v_res->>'refund_id')::uuid, executed_at = now(), owed_reason = NULL, last_error = NULL,
             lease_token = NULL, lease_until = NULL, updated_at = now()
       WHERE id = v_r.id;
      INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
      VALUES ('refund_request_executed', NULL, v_r.scope_kind, v_r.scope_id, v_r.id,
              jsonb_build_object('refund_id', v_res->>'refund_id', 'gross', v_res->'gross', 'is_replay', v_res->'is_replay', 'attempts', v_r.attempts));
      v_refunded := v_refunded + 1;
      v_results := v_results || jsonb_build_object('request_id', v_r.id, 'outcome', 'refunded', 'refund_id', v_res->>'refund_id');
    ELSIF COALESCE((v_res->>'retry_same_request_key')::boolean, false)
          OR v_res->>'error' IN ('staff_required', 'refund_requires_service_route') THEN
      -- The reason the wallet gave (for example diamond_balance_limit) is
      -- more useful to the payer than the core's wrapper code.
      v_owed_reason := CASE WHEN v_res->>'error' = 'refund_refused' AND COALESCE(v_res->>'detail', '') ~ '^[a-z_]{3,60}$'
                            THEN v_res->>'detail' ELSE COALESCE(v_res->>'error', 'unknown') END;
      v_reason_words := initcap(replace(v_owed_reason, '_', ' '));
      UPDATE public.ca_commerce_refund_requests
         SET state = 'owed', owed_reason = v_owed_reason, last_error = left(COALESCE(v_res->>'error', '') || ': ' || COALESCE(v_res->>'detail', ''), 500),
             lease_token = NULL, lease_until = NULL, updated_at = now()
       WHERE id = v_r.id;
      IF v_r.state <> 'owed' THEN
        INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
        VALUES ('refund_request_owed', NULL, v_r.scope_kind, v_r.scope_id, v_r.id, v_res);
        PERFORM public.fn_ca_commerce_notice(v_r.payer_id, 'refund-owed:' || v_r.id::text, 'club_commerce_refund_owed',
          'Refund Owed: ' || to_char(v_r.approved_amount, 'FM999,999,999,990') || ' Diamonds',
          'Your Approved Refund Of ' || to_char(v_r.approved_amount, 'FM999,999,999,990') || ' Diamonds For ' || v_title
            || ' Could Not Be Added To Your Balance Yet (' || v_reason_words || '). It Stays Owed To You And Is Paid As Soon As Your Balance Can Receive It.',
          v_url, jsonb_build_object('request_id', v_r.id, 'owed_reason', v_owed_reason));
      END IF;
      v_owed := v_owed + 1;
      v_results := v_results || jsonb_build_object('request_id', v_r.id, 'outcome', 'owed', 'reason', v_owed_reason);
    ELSE
      -- A refusal that retrying cannot change (the line has less left to
      -- return than was approved, for example after a direct staff refund).
      v_reason_words := initcap(replace(COALESCE(v_res->>'error', 'unknown'), '_', ' '));
      UPDATE public.ca_commerce_refund_requests
         SET state = 'failed', last_error = COALESCE(v_res->>'error', 'unknown'), owed_reason = NULL,
             lease_token = NULL, lease_until = NULL, updated_at = now()
       WHERE id = v_r.id;
      INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
      VALUES ('refund_request_failed', NULL, v_r.scope_kind, v_r.scope_id, v_r.id, v_res);
      PERFORM public.fn_ca_commerce_notice(v_r.payer_id, 'refund-failed:' || v_r.id::text, 'club_commerce_refund_failed',
        'Refund Could Not Be Completed',
        'Your Approved Refund For ' || v_title || ' Could Not Be Completed (' || v_reason_words || '). Platform Staff Can See This Request.',
        v_url, jsonb_build_object('request_id', v_r.id, 'error', v_res->>'error'));
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_object('request_id', v_r.id, 'outcome', 'failed', 'reason', v_res->>'error');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'claimed', COALESCE(array_length(v_ids, 1), 0),
    'refunded', v_refunded, 'owed', v_owed, 'failed', v_failed, 'results', v_results);
END $$;

-- ---------------------------------------------------------------------------
-- 10. Policy read for the owner page (the texts a payer accepts).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_policies(p_kind text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  RETURN jsonb_build_object('success', true, 'policies', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('policy_id', p.id, 'kind', p.kind, 'version', p.version, 'title', p.title, 'body', p.body,
             'effective_from', p.effective_from, 'current', p.version = public.fn_ca_commerce_policy_version(p.kind))
             ORDER BY p.kind, p.version)
      FROM public.ca_commerce_policies p WHERE p_kind IS NULL OR p.kind = p_kind), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 11. Replaced: the consumer's claim door now stamps its heartbeat on every
-- call, so the launch cohort can prove the consumer is running.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_claim_due_renewals(p_lease_token uuid, p_limit integer DEFAULT 10) RETURNS SETOF public.ca_commerce_renewal_mandates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service Role Required';
  END IF;
  -- Every wake of the named consumer passes here first, due work or not.
  UPDATE public.ca_commerce_settings SET consumer_heartbeat_at = clock_timestamp() WHERE id = 1;
  RETURN QUERY
  WITH due AS (
    SELECT m.id FROM public.ca_commerce_renewal_mandates m
     WHERE m.state = 'authorized' AND m.due_at <= now()
       AND (m.lease_until IS NULL OR m.lease_until <= clock_timestamp())
     ORDER BY m.due_at, m.id
     LIMIT GREATEST(1, LEAST(p_limit, 100))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ca_commerce_renewal_mandates m
     SET lease_token = p_lease_token, lease_until = clock_timestamp() + interval '2 minutes', attempts = m.attempts + 1, updated_at = now()
    FROM due WHERE m.id = due.id
  RETURNING m.*;
END $$;

-- ---------------------------------------------------------------------------
-- 12. Replaced: renewal mandate control. Unchanged for owners; a sponsor may
-- now authorize the renewal of a right their sponsorship paid for, charged to
-- them within that sponsorship. Consent records its versions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_set_renewal(p_entitlement_id uuid, p_enabled boolean, p_max_diamonds integer DEFAULT NULL, p_sku text DEFAULT NULL, p_quantity integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_ent public.ca_commerce_entitlements;
  v_mandate public.ca_commerce_renewal_mandates;
  v_purchase public.ca_commerce_purchases;
  v_product public.ca_commerce_products;
  v_sponsorship public.ca_commerce_sponsorships;
  v_sponsor_path boolean := false;
  v_sponsorship_id uuid;
  v_sku text;
  v_quantity integer;
  v_terms integer;
  v_ceiling integer;
BEGIN
  IF v_actor IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication_required'); END IF;
  SELECT * INTO v_ent FROM public.ca_commerce_entitlements WHERE id = p_entitlement_id FOR UPDATE;
  IF v_ent.id IS NULL OR v_ent.state <> 'effective' OR v_ent.ends_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'entitlement_not_renewable');
  END IF;
  -- A right a sponsorship paid for is renewed by that sponsor, from their own
  -- balance and within that sponsorship (R2 5.2). Nobody else can put the
  -- sponsor's diamonds behind a mandate, and the sponsor cannot reach any
  -- right their sponsorship did not pay for.
  IF v_ent.source = 'sponsor' THEN
    SELECT * INTO v_purchase FROM public.ca_commerce_purchases WHERE id = v_ent.purchase_id;
    v_sponsor_path := v_purchase.sponsorship_id IS NOT NULL AND v_purchase.payer_id = v_actor;
  END IF;
  IF v_sponsor_path THEN
    v_sponsorship_id := v_purchase.sponsorship_id;
    IF p_enabled THEN
      SELECT * INTO v_sponsorship FROM public.ca_commerce_sponsorships WHERE id = v_sponsorship_id;
      IF v_sponsorship.id IS NULL OR v_sponsorship.state <> 'active' OR v_sponsorship.payer_id <> v_actor
         OR v_sponsorship.effective_from > now() OR (v_sponsorship.effective_to IS NOT NULL AND v_sponsorship.effective_to <= now())
         OR (v_sponsorship.club_id IS NOT NULL AND v_sponsorship.club_id <> v_ent.scope_id)
         OR NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = v_ent.scope_id AND uc.union_id = v_sponsorship.union_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'sponsorship_not_effective');
      END IF;
    END IF;
    v_sku := COALESCE(p_sku, v_ent.sku);
    v_quantity := COALESCE(p_quantity, v_ent.quantity);
  ELSE
    IF public.fn_ca_commerce_scope_role(v_ent.scope_kind, v_ent.scope_id, v_actor) <> 'owner' THEN
      RETURN jsonb_build_object('success', false, 'error', 'owner_required');
    END IF;
    IF v_ent.source = 'trial' THEN
      -- A post-trial authorization: the owner names the product and ceiling;
      -- the consumer buys the first paid period at the trial end (R2 4.6).
      v_sku := p_sku;
      v_quantity := COALESCE(p_quantity, 1);
      -- Cancelling needs no product; the client cancels with a NULL sku.
      IF v_sku IS NULL AND p_enabled THEN RETURN jsonb_build_object('success', false, 'error', 'sku_required'); END IF;
    ELSE
      SELECT * INTO v_purchase FROM public.ca_commerce_purchases WHERE id = v_ent.purchase_id;
      -- Only the original payer authorizes their own diamonds; the club owner
      -- can never put a sponsor's diamonds behind a mandate.
      IF v_purchase.payer_id <> v_actor OR v_purchase.sponsorship_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'payer_required');
      END IF;
      v_sku := COALESCE(p_sku, v_ent.sku);
      v_quantity := COALESCE(p_quantity, v_ent.quantity);
    END IF;
  END IF;
  IF p_enabled THEN
    SELECT * INTO v_product FROM public.ca_commerce_products WHERE sku = v_sku;
    IF v_product.sku IS NULL OR NOT v_product.supported OR v_product.scope_kind <> v_ent.scope_kind OR v_product.term_kind <> 'period' THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_not_available');
    END IF;
    IF v_quantity < 1 OR v_quantity > 500 OR (v_product.quantity_unit = 'flat' AND v_quantity <> 1) THEN
      RETURN jsonb_build_object('success', false, 'error', 'quantity_out_of_range');
    END IF;
  END IF;
  -- The right's one mandate, whatever product it currently names.
  SELECT * INTO v_mandate FROM public.ca_commerce_renewal_mandates WHERE entitlement_id = v_ent.id FOR UPDATE;
  IF p_enabled THEN
    IF p_max_diamonds IS NULL OR p_max_diamonds < 0 OR p_max_diamonds > 2147483647 THEN
      RETURN jsonb_build_object('success', false, 'error', 'max_diamonds_required');
    END IF;
    -- Consent is recorded against the texts in effect as it is given (R2 5.4).
    v_terms := public.fn_ca_commerce_policy_version('renewal_terms');
    v_ceiling := public.fn_ca_commerce_policy_version('renewal_ceiling');
    IF v_mandate.id IS NULL THEN
      INSERT INTO public.ca_commerce_renewal_mandates (entitlement_id, scope_kind, scope_id, payer_id, sku, quantity, max_diamonds, due_at, accepted_by,
        sponsorship_id, terms_version, ceiling_text_version)
      VALUES (v_ent.id, v_ent.scope_kind, v_ent.scope_id, v_actor, v_sku, v_quantity, p_max_diamonds, v_ent.ends_at, v_actor,
        v_sponsorship_id, v_terms, v_ceiling)
      RETURNING * INTO v_mandate;
    ELSIF v_mandate.state = 'completed' THEN
      RETURN jsonb_build_object('success', false, 'error', 'period_already_renewed');
    ELSE
      UPDATE public.ca_commerce_renewal_mandates
         SET state = 'authorized', sku = v_sku, max_diamonds = p_max_diamonds, quantity = v_quantity, payer_id = v_actor, accepted_by = v_actor, accepted_at = now(),
             cancelled_at = NULL, cancelled_by = NULL, updated_at = now(),
             sponsorship_id = v_sponsorship_id, terms_version = v_terms, ceiling_text_version = v_ceiling
       WHERE id = v_mandate.id RETURNING * INTO v_mandate;
    END IF;
  ELSE
    IF v_mandate.id IS NULL THEN
      RETURN jsonb_build_object('success', true, 'state', 'none');
    END IF;
    IF v_mandate.state = 'completed' THEN
      RETURN jsonb_build_object('success', true, 'state', 'completed', 'note', 'This Period Was Already Renewed; Cancel The New Period Instead');
    END IF;
    UPDATE public.ca_commerce_renewal_mandates SET state = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, updated_at = now()
     WHERE id = v_mandate.id RETURNING * INTO v_mandate;
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('renewal_mandate_' || v_mandate.state, v_actor, v_ent.scope_kind, v_ent.scope_id, v_mandate.id,
          jsonb_build_object('sku', v_mandate.sku, 'max_diamonds', v_mandate.max_diamonds, 'due_at', v_mandate.due_at,
                             'sponsorship_id', v_mandate.sponsorship_id, 'terms_version', v_mandate.terms_version,
                             'ceiling_text_version', v_mandate.ceiling_text_version));
  RETURN jsonb_build_object('success', true, 'mandate_id', v_mandate.id, 'state', v_mandate.state, 'sku', v_mandate.sku,
    'max_diamonds', v_mandate.max_diamonds, 'due_at', v_mandate.due_at, 'payer_id', v_mandate.payer_id,
    'sponsorship_id', v_mandate.sponsorship_id, 'terms_version', v_mandate.terms_version, 'ceiling_text_version', v_mandate.ceiling_text_version,
    'accepted_ceiling_text', CASE WHEN v_mandate.ceiling_text_version IS NULL THEN NULL ELSE public.fn_ca_commerce_ceiling_text(
       v_mandate.ceiling_text_version, v_mandate.sku, v_mandate.quantity, v_mandate.max_diamonds, v_mandate.sponsorship_id IS NOT NULL) END);
END $$;

-- ---------------------------------------------------------------------------
-- 13. Replaced: one renewal execution. Unchanged except (a) a sponsor-paid
-- mandate is quoted with its sponsorship, so the existing sponsorship checks
-- and budget apply and the sponsor is charged, and (b) the carried-forward
-- authorization keeps the consent it was given (sponsorship, accepted_by,
-- accepted_at and the accepted text versions) instead of being re-created
-- by the purchase boundary as a fresh acceptance.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_execute_renewal(p_mandate_id uuid, p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_m public.ca_commerce_renewal_mandates;
  v_ent public.ca_commerce_entitlements;
  v_settings public.ca_commerce_settings;
  v_price public.ca_commerce_price_versions;
  v_product public.ca_commerce_products;
  v_gross integer;
  v_quote jsonb;
  v_result jsonb;
  v_now timestamptz := now();
  v_owner uuid;
  v_receipt_url text;
  v_detail text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service Role Required';
  END IF;
  -- Lock order is scope, then mandate, on every path: purchase (upgrade) and
  -- refund take the scope lock before they touch a mandate row, so taking the
  -- mandate first here could deadlock against them. A mandate's scope never
  -- changes (an upgrade moves its right, not its scope), so the unlocked read
  -- that names the scope is exact.
  SELECT * INTO v_m FROM public.ca_commerce_renewal_mandates WHERE id = p_mandate_id;
  IF v_m.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'lease_lost');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || v_m.scope_kind || ':' || v_m.scope_id::text, 0));
  SELECT * INTO v_m FROM public.ca_commerce_renewal_mandates WHERE id = p_mandate_id FOR UPDATE;
  IF v_m.id IS NULL OR v_m.lease_token IS DISTINCT FROM p_lease_token OR v_m.lease_until < clock_timestamp() THEN
    RETURN jsonb_build_object('success', false, 'error', 'lease_lost');
  END IF;
  IF v_m.state <> 'authorized' THEN
    RETURN jsonb_build_object('success', false, 'error', 'mandate_' || v_m.state);
  END IF;
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  SELECT * INTO v_ent FROM public.ca_commerce_entitlements WHERE id = v_m.entitlement_id;
  v_owner := public.fn_ca_commerce_scope_owner(v_m.scope_kind, v_m.scope_id);
  v_receipt_url := '/hub/club-arena/' || v_m.scope_kind || 's/' || v_m.scope_id::text || '/diamond-costs';

  -- Attention states: ownership moved (for an owner-paid mandate; a sponsor
  -- is not the owner and its authority is the sponsorship, rechecked by the
  -- quote), the right was revoked or superseded, or the due period lapsed
  -- beyond the accepted lateness treatment.
  IF v_ent.id IS NULL OR v_ent.state <> 'effective' OR (v_m.sponsorship_id IS NULL AND v_owner IS DISTINCT FROM v_m.payer_id) THEN
    v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'payer_no_longer_owner_or_right_changed', 'at', v_now);
  ELSIF v_now > v_m.due_at + make_interval(hours => v_settings.renewal_lateness_hours) THEN
    v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'lapsed_beyond_lateness_policy', 'due_at', v_m.due_at, 'at', v_now);
  ELSE
    SELECT * INTO v_product FROM public.ca_commerce_products WHERE sku = v_m.sku;
    SELECT * INTO v_price FROM public.ca_commerce_price_versions v
     WHERE v.sku = v_m.sku AND v.status = 'published' AND v.effective_from <= v_now AND (v.effective_to IS NULL OR v.effective_to > v_now);
    IF v_price.id IS NULL OR NOT v_product.supported THEN
      v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'no_published_price', 'at', v_now);
    ELSE
      v_gross := public.fn_ca_commerce_line_gross(v_price, v_m.quantity);
      IF v_gross > v_m.max_diamonds THEN
        v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'price_above_accepted_ceiling', 'price', v_gross, 'max_diamonds', v_m.max_diamonds, 'at', v_now);
      ELSE
        -- A system quote for exactly the due period, then the same atomic
        -- purchase boundary with the mandate as its request identity. A
        -- sponsored mandate quotes through its sponsorship: effectiveness,
        -- coverage and budget are the boundary's own checks.
        v_quote := public.fn_ca_commerce_quote_impl(v_m.payer_id, v_m.payer_id, v_m.scope_kind, v_m.scope_id,
          jsonb_build_array(jsonb_build_object('sku', v_m.sku, 'quantity', v_m.quantity)), v_m.sponsorship_id, NULL, 'renewal');
        IF NOT COALESCE((v_quote->>'success')::boolean, false) THEN
          v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', COALESCE(v_quote->>'error', 'quote_failed'), 'at', v_now);
        ELSIF (v_quote->'lines'->0->>'starts_at')::timestamptz IS DISTINCT FROM v_ent.ends_at THEN
          -- The mandate authorizes exactly the period that begins where its
          -- right ends. When another right already covers that instant (a
          -- manual prepaid period, or a second standing mandate), the quote
          -- lands on a later period: charging now would bill a period that
          -- has not begun and was never the one authorized.
          UPDATE public.ca_commerce_quotes SET status = 'withdrawn' WHERE id = (v_quote->>'quote_id')::uuid AND status = 'open';
          v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'period_already_covered',
            'due_period_start', v_ent.ends_at, 'quoted_start', v_quote->'lines'->0->'starts_at', 'at', v_now);
        ELSE
          BEGIN
            v_result := public.fn_ca_commerce_purchase_impl(v_m.payer_id, (v_quote->>'quote_id')::uuid, 'renewal:' || v_m.id::text || ':' || v_m.due_at::text, 'renewal');
          EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
            IF SQLERRM = 'CA_COMMERCE_INSUFFICIENT_DIAMONDS' THEN
              v_result := jsonb_build_object('success', false, 'error', 'insufficient_diamonds', 'balance', v_detail);
            ELSIF SQLERRM LIKE 'CA_COMMERCE_%' THEN
              v_result := jsonb_build_object('success', false, 'error', lower(replace(SQLERRM, 'CA_COMMERCE_', '')), 'detail', v_detail);
            ELSIF SQLSTATE = '23514' THEN
              v_result := jsonb_build_object('success', false, 'error', 'reserved_diamonds', 'detail', SQLERRM);
            ELSE
              RAISE;
            END IF;
          END;
          UPDATE public.ca_commerce_quotes SET status = 'withdrawn' WHERE id = (v_quote->>'quote_id')::uuid AND status = 'open';
          IF COALESCE((v_result->>'success')::boolean, false) THEN
            v_result := jsonb_build_object('outcome', 'renewed', 'purchase_id', v_result->>'purchase_id', 'charged', v_result->>'charged_this_attempt', 'at', v_now);
          ELSE
            v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', COALESCE(v_result->>'error', 'purchase_failed'), 'detail', v_result->>'balance', 'at', v_now);
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_result->>'outcome' = 'renewed' THEN
    UPDATE public.ca_commerce_renewal_mandates SET state = 'completed', renewal_purchase_id = (v_result->>'purchase_id')::uuid, last_result = v_result, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = v_m.id;
    -- The authorization carries forward to the new period at the same
    -- ceiling, with the same payer, sponsorship and accepted consent, so a
    -- standing renewal keeps standing until cancelled (D09).
    INSERT INTO public.ca_commerce_renewal_mandates (entitlement_id, scope_kind, scope_id, payer_id, sku, quantity, max_diamonds, due_at, accepted_by, accepted_at,
      sponsorship_id, terms_version, ceiling_text_version)
    SELECT e.id, e.scope_kind, e.scope_id, v_m.payer_id, v_m.sku, v_m.quantity, v_m.max_diamonds, e.ends_at, v_m.accepted_by, v_m.accepted_at,
      v_m.sponsorship_id, v_m.terms_version, v_m.ceiling_text_version
      FROM public.ca_commerce_entitlements e
     WHERE e.purchase_id = (v_result->>'purchase_id')::uuid AND e.sku = v_m.sku AND e.state = 'effective'
    ON CONFLICT (entitlement_id) DO NOTHING;
  ELSE
    UPDATE public.ca_commerce_renewal_mandates SET state = 'needs_attention', last_result = v_result, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = v_m.id;
    -- One notice per failed attempt (attempts counts claims), so a mandate
    -- re-authorized after an earlier failure is still told when it fails again.
    PERFORM public.fn_ca_commerce_notice(v_m.payer_id, 'renewal-attention:' || v_m.id::text || ':' || v_m.attempts::text, 'club_commerce_renewal_attention',
      'Renewal Not Completed',
      'Your Diamond Renewal For ' || COALESCE((SELECT p.title FROM public.ca_commerce_products p WHERE p.sku = v_m.sku), 'This Service')
        || ' Was Not Completed (' || initcap(replace(COALESCE(v_result->>'reason', 'unknown'), '_', ' ')) || '). Current Paid Access Is Unchanged.',
      v_receipt_url, v_result);
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('renewal_' || (v_result->>'outcome'), NULL, v_m.scope_kind, v_m.scope_id, v_m.id, v_result);
  RETURN jsonb_build_object('success', true) || v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 14. Replaced: due notice delivery. Unchanged for every existing kind. A
-- 72-hour balance check is decided now, against the price in effect today:
-- delivered with the shortfall and deadline, or suppressed on record.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_deliver_due_notices(p_limit integer DEFAULT 50) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_n public.ca_commerce_notices;
  v_count integer := 0;
  v_notification uuid;
  v_m public.ca_commerce_renewal_mandates;
  v_price public.ca_commerce_price_versions;
  v_amount integer;
  v_balance integer;
  v_title text;
  v_message text;
  v_suppress text;
  v_trial_end timestamptz;
  v_days integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service Role Required';
  END IF;
  FOR v_n IN
    SELECT * FROM public.ca_commerce_notices n WHERE n.delivered_at IS NULL AND n.suppressed_at IS NULL AND n.due_at <= now()
     ORDER BY n.due_at LIMIT GREATEST(1, LEAST(p_limit, 500)) FOR UPDATE SKIP LOCKED
  LOOP
    v_title := v_n.title;
    v_message := v_n.message;
    v_suppress := NULL;
    v_amount := NULL;
    v_balance := NULL;
    IF v_n.kind = 'club_commerce_renewal_funds' THEN
      SELECT * INTO v_m FROM public.ca_commerce_renewal_mandates WHERE id = (v_n.payload->>'mandate_id')::uuid;
      -- The check belongs to one authorization of one due date: a cancelled,
      -- completed, moved or re-authorized mandate has its own newer check.
      IF v_m.id IS NULL OR v_m.state <> 'authorized' OR v_m.due_at IS DISTINCT FROM (v_n.payload->>'due_at')::timestamptz
         OR v_m.payer_id IS DISTINCT FROM v_n.user_id OR v_m.accepted_at IS DISTINCT FROM (v_n.payload->>'accepted_at')::timestamptz THEN
        v_suppress := 'mandate_no_longer_due';
      ELSE
        SELECT * INTO v_price FROM public.ca_commerce_price_versions v
         WHERE v.sku = v_m.sku AND v.status = 'published' AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now());
        IF v_price.id IS NULL THEN
          v_suppress := 'no_published_price';
        ELSE
          v_amount := public.fn_ca_commerce_line_gross(v_price, v_m.quantity);
          v_balance := COALESCE((SELECT p.diamonds FROM public.profiles p WHERE p.id = v_m.payer_id), 0);
          IF v_balance >= v_amount THEN
            v_suppress := 'funds_sufficient';
          ELSE
            v_title := 'Add Diamonds Before Your Renewal';
            v_message := 'Your Renewal Of ' || COALESCE((SELECT p.title FROM public.ca_commerce_products p WHERE p.sku = v_m.sku), 'This Service')
              || ' Is Due ' || to_char(v_m.due_at AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') || ' Central And Costs '
              || to_char(v_amount, 'FM999,999,999,990') || ' Diamonds. Your Balance Is ' || to_char(v_balance, 'FM999,999,999,990')
              || ' Diamonds, So Add At Least ' || to_char(v_amount - v_balance, 'FM999,999,999,990') || ' Diamonds Before Then. Current Paid Access Is Unchanged.';
          END IF;
        END IF;
      END IF;
      IF v_suppress IS NOT NULL THEN
        UPDATE public.ca_commerce_notices
           SET suppressed_at = now(), suppressed_reason = v_suppress,
               payload = v_n.payload || jsonb_build_object('checked_price', v_amount, 'checked_balance', v_balance, 'checked_at', now())
         WHERE id = v_n.id;
        CONTINUE;
      END IF;
      v_n.payload := v_n.payload || jsonb_build_object('price', v_amount, 'balance', v_balance, 'shortfall', v_amount - v_balance, 'checked_at', now());
    END IF;
    -- A trial reminder says how long is left NOW, from the trial row, not the
    -- day count it was written with: the consumer can deliver late (the
    -- reminders wait for it), and "Ends In 9 Days" after the trial ended is
    -- false. An ended trial's reminder is suppressed, not sent.
    IF v_n.kind = 'club_commerce_trial_reminder' THEN
      SELECT t.trial_end INTO v_trial_end FROM public.ca_commerce_trials t WHERE t.id = NULLIF(v_n.payload->>'trial_id', '')::uuid;
      IF v_trial_end IS NULL OR v_trial_end <= now() THEN
        UPDATE public.ca_commerce_notices
           SET suppressed_at = now(), suppressed_reason = 'trial_already_ended',
               payload = v_n.payload || jsonb_build_object('checked_at', now(), 'trial_end', v_trial_end)
         WHERE id = v_n.id;
        CONTINUE;
      END IF;
      v_days := CEIL(EXTRACT(EPOCH FROM (v_trial_end - now())) / 86400.0)::integer;
      v_title := 'Your Operating Trial Ends In ' || v_days::text || CASE WHEN v_days = 1 THEN ' Day' ELSE ' Days' END;
      v_n.payload := v_n.payload || jsonb_build_object('days_left', v_days, 'checked_at', now());
    END IF;
    INSERT INTO public.notifications (user_id, type, title, message, data, action_url, read)
    VALUES (v_n.user_id, v_n.kind, v_title, v_message, v_n.payload, v_n.action_url, false)
    RETURNING id INTO v_notification;
    UPDATE public.ca_commerce_notices SET notification_id = v_notification, delivered_at = now(), title = v_title, message = v_message, payload = v_n.payload WHERE id = v_n.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------------------
-- 15. Replaced: the launch cohort. Existing guards unchanged; it now refuses
-- unless the consumer that owns the reminders and renewals is running, and
-- tells every owner it enrols about the free month in the same transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_activate_launch_cohort(p_effective_at timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row record;
  v_enrolled integer := 0;
  v_created integer := 0;
  v_notified integer := 0;
  v_result jsonb;
  v_heartbeat timestamptz;
  v_owner uuid;
  v_name text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF p_effective_at < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cohort_must_be_prospective');
  END IF;
  -- Enrolment creates reminders and, later, renewals that only the engine's
  -- commerce consumer delivers and executes. Without a recent wake nobody
  -- owns them, so nobody is enrolled.
  SELECT consumer_heartbeat_at INTO v_heartbeat FROM public.ca_commerce_settings WHERE id = 1;
  IF v_heartbeat IS NULL OR v_heartbeat < now() - interval '10 minutes' THEN
    RETURN jsonb_build_object('success', false, 'error', 'consumer_not_running', 'consumer_heartbeat_at', v_heartbeat);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_launch_cohort', 0));
  UPDATE public.ca_commerce_settings SET launch_cohort_activated_at = COALESCE(launch_cohort_activated_at, p_effective_at), updated_at = now() WHERE id = 1;
  FOR v_row IN
    SELECT 'club'::text AS scope_kind, c.id AS scope_id, c.name AS scope_name FROM public.clubs c
     WHERE c.owner_id IS NOT NULL AND COALESCE(c.lifecycle_status, 'active') <> 'retired' AND COALESCE(c.is_platform, false) = false
    UNION ALL
    SELECT 'union', u.id, u.name FROM public.unions u WHERE u.owner_id IS NOT NULL
  LOOP
    v_result := public.fn_ca_commerce_activate_trial_impl(v_row.scope_kind, v_row.scope_id, v_actor, 'launch_cohort', p_effective_at);
    IF (v_result->>'enrolled')::boolean THEN
      v_enrolled := v_enrolled + 1;
      -- The owner learns what was enrolled, until when it is free, that
      -- nothing is charged without their authorization, and where to manage
      -- it, in the same transaction as the enrolment itself.
      v_owner := public.fn_ca_commerce_scope_owner(v_row.scope_kind, v_row.scope_id);
      v_name := COALESCE(NULLIF(btrim(v_row.scope_name), ''), CASE v_row.scope_kind WHEN 'club' THEN 'Your Club' ELSE 'Your Union' END);
      PERFORM public.fn_ca_commerce_notice(v_owner, 'launch-cohort:' || v_row.scope_kind || ':' || v_row.scope_id::text, 'club_commerce_launch',
        'Your Free Operating Month Is Ready',
        'Club Arena Operating Software For ' || replace(v_name, chr(8212), '-') || ' Is Free Until '
          || to_char((v_result->>'trial_end')::timestamptz AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM')
          || ' Central. Nothing Is Charged Unless You Authorize A Purchase Or Renewal. Manage It In Club And Union Diamond Costs.',
        '/hub/club-arena/' || v_row.scope_kind || 's/' || v_row.scope_id::text || '/diamond-costs',
        jsonb_build_object('trial_id', v_result->>'trial_id', 'trial_start', v_result->>'trial_start', 'trial_end', v_result->>'trial_end',
                           'scope_kind', v_row.scope_kind, 'scope_id', v_row.scope_id));
      v_notified := v_notified + 1;
    END IF;
    IF (v_result->>'created')::boolean THEN v_created := v_created + 1; END IF;
  END LOOP;
  INSERT INTO public.ca_commerce_events (kind, actor_id, detail)
  VALUES ('launch_cohort_activated', v_actor, jsonb_build_object('effective_at', p_effective_at, 'scopes_enrolled', v_enrolled, 'trials_created', v_created,
          'owners_notified', v_notified, 'consumer_heartbeat_at', v_heartbeat));
  RETURN jsonb_build_object('success', true, 'effective_at', p_effective_at, 'scopes_enrolled', v_enrolled, 'trials_created', v_created,
    'notices_recorded', v_notified);
END $$;

-- ---------------------------------------------------------------------------
-- 16. Replaced: catalog administration. A draft is a draft (R2 7.3):
-- validate, then publish, then retire, each checked and audited.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_price_draft(p_sku text, p_diamonds integer, p_price_rule text, p_cap_diamonds integer, p_price_authority text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_version integer;
  v_id uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_commerce_products WHERE sku = p_sku) THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown_sku');
  END IF;
  IF p_diamonds IS NULL OR p_diamonds < 0 OR p_diamonds > 2147483647 OR p_price_rule NOT IN ('flat','per_unit','per_unit_capped') OR length(COALESCE(p_price_authority, '')) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_price');
  END IF;
  -- Two staff drafting the same product at once must not collide on a version.
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_price_draft:' || p_sku, 0));
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM public.ca_commerce_price_versions WHERE sku = p_sku;
  INSERT INTO public.ca_commerce_price_versions (sku, version, diamonds, price_rule, cap_diamonds, status, price_authority, created_by)
  VALUES (p_sku, v_version, p_diamonds, p_price_rule, p_cap_diamonds, 'draft', p_price_authority, v_actor) RETURNING id INTO v_id;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail) VALUES ('price_drafted', v_actor, v_id, jsonb_build_object('sku', p_sku, 'version', v_version, 'diamonds', p_diamonds));
  RETURN jsonb_build_object('success', true, 'price_version_id', v_id, 'version', v_version, 'status', 'draft');
END $$;

CREATE FUNCTION public.fn_ca_commerce_price_validate(p_price_version_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_v public.ca_commerce_price_versions;
  v_product public.ca_commerce_products;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  SELECT * INTO v_v FROM public.ca_commerce_price_versions WHERE id = p_price_version_id FOR UPDATE;
  IF v_v.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_version_not_found');
  END IF;
  IF v_v.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_draft', 'status', v_v.status);
  END IF;
  SELECT * INTO v_product FROM public.ca_commerce_products WHERE sku = v_v.sku;
  -- Checks (R2 1.7, 7.3): a positive whole-diamond price (no free tier), a
  -- price rule that fits how the product is counted, a cap that is a real
  -- ceiling, and a term the catalog can sell.
  IF v_v.diamonds <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'zero_price_not_allowed');
  END IF;
  IF (v_product.quantity_unit = 'flat' AND v_v.price_rule <> 'flat')
     OR (v_product.quantity_unit = 'covered_club' AND v_v.price_rule NOT IN ('per_unit','per_unit_capped')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_rule_does_not_fit_product', 'quantity_unit', v_product.quantity_unit, 'price_rule', v_v.price_rule);
  END IF;
  IF v_v.price_rule = 'per_unit_capped' AND v_v.cap_diamonds IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cap_required');
  END IF;
  IF v_v.price_rule <> 'per_unit_capped' AND v_v.cap_diamonds IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cap_not_allowed');
  END IF;
  IF v_v.price_rule = 'per_unit_capped' AND v_v.cap_diamonds < v_v.diamonds THEN
    RETURN jsonb_build_object('success', false, 'error', 'cap_below_unit_price');
  END IF;
  IF (v_product.term_kind = 'period' AND v_product.term_hours IS NULL)
     OR (v_product.term_kind = 'report_interval' AND v_product.report_days IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'product_term_undefined');
  END IF;
  UPDATE public.ca_commerce_price_versions SET status = 'validated' WHERE id = v_v.id;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail)
  VALUES ('price_validated', v_actor, v_v.id, jsonb_build_object('sku', v_v.sku, 'version', v_v.version, 'diamonds', v_v.diamonds, 'price_rule', v_v.price_rule));
  RETURN jsonb_build_object('success', true, 'price_version_id', v_v.id, 'version', v_v.version, 'status', 'validated');
END $$;

-- Publication: unchanged, and a higher price is now announced to every payer
-- whose standing renewal it affects, naming both prices, the date and their
-- ceiling (R2 4.1: prospective notice of a material price increase).
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_price_publish(p_price_version_id uuid, p_effective_from timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_v public.ca_commerce_price_versions;
  v_from timestamptz := COALESCE(p_effective_from, now());
  v_old public.ca_commerce_price_versions;
  v_m public.ca_commerce_renewal_mandates;
  v_old_gross integer;
  v_new_gross integer;
  v_title text;
  v_notified integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- A published price names its publisher (the version trigger refuses a
  -- NULL one); a service-role call carries no person, so say so in JSON.
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'publisher_required');
  END IF;
  SELECT * INTO v_v FROM public.ca_commerce_price_versions WHERE id = p_price_version_id FOR UPDATE;
  IF v_v.id IS NULL OR v_v.status <> 'validated' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_validated');
  END IF;
  IF v_from < now() - interval '1 minute' THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_changes_are_prospective');
  END IF;
  -- The price a standing renewal would pay today, read before it changes.
  SELECT * INTO v_old FROM public.ca_commerce_price_versions p
   WHERE p.sku = v_v.sku AND p.status = 'published' AND p.effective_from <= now() AND (p.effective_to IS NULL OR p.effective_to > now());
  -- The current published price retires at the new effective date; accepted
  -- purchases keep their price version (D74). A prospective publication
  -- leaves the current price published and in effect until v_from (no gap
  -- with no price); a published version that would only have started at or
  -- after v_from never takes effect and retires whole.
  UPDATE public.ca_commerce_price_versions
     SET status = CASE WHEN v_from <= now() OR effective_from >= v_from THEN 'retired' ELSE status END,
         effective_to = CASE WHEN effective_from >= v_from THEN effective_to ELSE v_from END
   WHERE sku = v_v.sku AND status = 'published' AND (effective_to IS NULL OR effective_to > v_from);
  UPDATE public.ca_commerce_price_versions SET status = 'published', effective_from = v_from, published_by = v_actor, published_at = now() WHERE id = v_v.id;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail) VALUES ('price_published', v_actor, v_v.id, jsonb_build_object('sku', v_v.sku, 'version', v_v.version, 'effective_from', v_from));
  IF v_old.id IS NOT NULL THEN
    v_title := (SELECT p.title FROM public.ca_commerce_products p WHERE p.sku = v_v.sku);
    FOR v_m IN SELECT * FROM public.ca_commerce_renewal_mandates m WHERE m.sku = v_v.sku AND m.state = 'authorized' ORDER BY m.id LOOP
      v_old_gross := public.fn_ca_commerce_line_gross(v_old, v_m.quantity);
      v_new_gross := public.fn_ca_commerce_line_gross(v_v, v_m.quantity);
      CONTINUE WHEN v_new_gross <= v_old_gross;
      PERFORM public.fn_ca_commerce_notice(v_m.payer_id, 'price-change:' || v_v.id::text || ':' || v_m.id::text, 'club_commerce_price_change',
        'Price Change: ' || v_title,
        'The Price Of ' || v_title || ' Rises From ' || to_char(v_old_gross, 'FM999,999,999,990') || ' To ' || to_char(v_new_gross, 'FM999,999,999,990')
          || ' Diamonds On ' || to_char(v_from AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') || ' Central. Your Accepted Renewal Ceiling Is '
          || to_char(v_m.max_diamonds, 'FM999,999,999,990') || ' Diamonds, '
          || CASE WHEN v_new_gross > v_m.max_diamonds
                  THEN 'So Your Next Renewal Waits For Your Approval Instead Of Charging The Higher Price.'
                  ELSE 'So Renewals Continue At The New Price Unless You Cancel Or Lower Your Ceiling.' END,
        '/hub/club-arena/' || v_m.scope_kind || 's/' || v_m.scope_id::text || '/diamond-costs',
        jsonb_build_object('sku', v_v.sku, 'mandate_id', v_m.id, 'price_version_id', v_v.id, 'old_price', v_old_gross, 'new_price', v_new_gross,
                           'effective_from', v_from, 'max_diamonds', v_m.max_diamonds, 'above_ceiling', v_new_gross > v_m.max_diamonds));
      v_notified := v_notified + 1;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('success', true, 'price_version_id', v_v.id, 'effective_from', v_from, 'price_change_notices', v_notified);
END $$;

-- Retirement: prospective. A published version stops at p_effective_to (now
-- when omitted); a draft or validated version is withdrawn. A supported
-- product is never left with no price: publish its successor, or mark it
-- unsupported, first.
CREATE FUNCTION public.fn_ca_commerce_price_retire(p_price_version_id uuid, p_effective_to timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_v public.ca_commerce_price_versions;
  v_to timestamptz := COALESCE(p_effective_to, now());
  v_supported boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  SELECT * INTO v_v FROM public.ca_commerce_price_versions WHERE id = p_price_version_id FOR UPDATE;
  IF v_v.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_version_not_found');
  END IF;
  IF v_v.status = 'retired' THEN
    RETURN jsonb_build_object('success', true, 'is_replay', true, 'price_version_id', v_v.id, 'status', 'retired', 'effective_to', v_v.effective_to);
  END IF;
  IF v_to < now() - interval '1 minute' THEN
    RETURN jsonb_build_object('success', false, 'error', 'retirement_is_prospective');
  END IF;
  IF v_v.status = 'published' THEN
    SELECT supported INTO v_supported FROM public.ca_commerce_products WHERE sku = v_v.sku;
    IF v_supported AND NOT EXISTS (
      SELECT 1 FROM public.ca_commerce_price_versions p
       WHERE p.sku = v_v.sku AND p.id <> v_v.id AND p.status = 'published' AND p.effective_to IS NULL
         AND p.effective_from <= GREATEST(v_to, v_v.effective_from)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'supported_product_needs_a_price');
    END IF;
    IF v_to > now() AND v_to > v_v.effective_from THEN
      -- Still in effect until v_to, then no longer.
      UPDATE public.ca_commerce_price_versions SET effective_to = LEAST(COALESCE(effective_to, v_to), v_to) WHERE id = v_v.id RETURNING * INTO v_v;
    ELSE
      UPDATE public.ca_commerce_price_versions
         SET status = 'retired',
             effective_to = CASE WHEN v_v.effective_from < v_to THEN LEAST(COALESCE(effective_to, v_to), v_to) ELSE effective_to END
       WHERE id = v_v.id RETURNING * INTO v_v;
    END IF;
  ELSE
    UPDATE public.ca_commerce_price_versions SET status = 'retired' WHERE id = v_v.id RETURNING * INTO v_v;
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail)
  VALUES ('price_retired', v_actor, v_v.id, jsonb_build_object('sku', v_v.sku, 'version', v_v.version, 'status', v_v.status, 'effective_to', v_v.effective_to));
  RETURN jsonb_build_object('success', true, 'is_replay', false, 'price_version_id', v_v.id, 'status', v_v.status, 'effective_to', v_v.effective_to);
END $$;

-- ---------------------------------------------------------------------------
-- 17. Comparison evidence (R2 4.3, 4.4, 7.3). A named staff member records;
-- a different named staff member verifies, and only that sets the badge.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_comparison_record(p_sku text, p_source_name text, p_source_url text, p_observed_price numeric, p_observed_unit text, p_observed_at timestamptz, p_conversion_note text, p_price_version_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_commerce_products WHERE sku = p_sku) THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown_sku');
  END IF;
  IF p_source_name IS NULL OR length(btrim(p_source_name)) NOT BETWEEN 2 AND 120 THEN
    RETURN jsonb_build_object('success', false, 'error', 'source_name_required');
  END IF;
  IF p_source_url IS NULL OR p_source_url !~ '^https://[^\s]{4,}$' OR length(p_source_url) > 1000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_source_url');
  END IF;
  IF p_observed_price IS NULL OR p_observed_price <= 0 OR p_observed_price > 1e12 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_observed_price');
  END IF;
  IF p_observed_unit IS NULL OR length(btrim(p_observed_unit)) NOT BETWEEN 2 AND 120 THEN
    RETURN jsonb_build_object('success', false, 'error', 'observed_unit_required');
  END IF;
  IF p_observed_at IS NULL OR p_observed_at > now() + interval '5 minutes' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_observed_at');
  END IF;
  IF p_conversion_note IS NULL OR length(btrim(p_conversion_note)) NOT BETWEEN 10 AND 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'conversion_note_required');
  END IF;
  IF p_price_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ca_commerce_price_versions v WHERE v.id = p_price_version_id AND v.sku = p_sku) THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_version_not_for_sku');
  END IF;
  INSERT INTO public.ca_commerce_comparison_evidence (sku, source_name, source_url, observed_price, observed_unit, observed_at, conversion_note, recorded_by, price_version_id)
  VALUES (p_sku, btrim(p_source_name), p_source_url, p_observed_price, btrim(p_observed_unit), p_observed_at, btrim(p_conversion_note), v_actor, p_price_version_id)
  RETURNING id INTO v_id;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail)
  VALUES ('comparison_evidence_recorded', v_actor, v_id, jsonb_build_object('sku', p_sku, 'source_name', p_source_name, 'observed_price', p_observed_price, 'observed_unit', p_observed_unit));
  RETURN jsonb_build_object('success', true, 'evidence_id', v_id, 'verified', false);
END $$;

CREATE FUNCTION public.fn_ca_commerce_comparison_verify(p_evidence_id uuid, p_price_version_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_e public.ca_commerce_comparison_evidence;
  v_v public.ca_commerce_price_versions;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  SELECT * INTO v_e FROM public.ca_commerce_comparison_evidence WHERE id = p_evidence_id FOR UPDATE;
  IF v_e.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'evidence_not_found');
  END IF;
  IF v_e.recorded_by = v_actor THEN
    RETURN jsonb_build_object('success', false, 'error', 'second_staff_member_required');
  END IF;
  SELECT * INTO v_v FROM public.ca_commerce_price_versions WHERE id = COALESCE(p_price_version_id, v_e.price_version_id) FOR UPDATE;
  IF v_v.id IS NULL OR v_v.sku <> v_e.sku THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_version_not_for_sku');
  END IF;
  IF v_v.status NOT IN ('validated','published') THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_version_not_current', 'status', v_v.status);
  END IF;
  IF v_e.verified_by IS NOT NULL THEN
    IF v_e.price_version_id = v_v.id THEN
      RETURN jsonb_build_object('success', true, 'is_replay', true, 'evidence_id', v_e.id, 'price_version_id', v_v.id, 'comparison_verified', v_v.comparison_verified);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'evidence_already_verified');
  END IF;
  UPDATE public.ca_commerce_comparison_evidence SET verified_by = v_actor, verified_at = now(), price_version_id = v_v.id WHERE id = v_e.id RETURNING * INTO v_e;
  UPDATE public.ca_commerce_price_versions
     SET comparison_verified = true,
         comparison_evidence = jsonb_build_object('status', 'Verified', 'evidence_id', v_e.id, 'source_name', v_e.source_name, 'source_url', v_e.source_url,
           'observed_price', v_e.observed_price, 'observed_unit', v_e.observed_unit, 'observed_at', v_e.observed_at,
           'conversion_note', v_e.conversion_note, 'recorded_by', v_e.recorded_by, 'verified_by', v_e.verified_by, 'verified_at', v_e.verified_at)
   WHERE id = v_v.id;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail)
  VALUES ('comparison_verified', v_actor, v_v.id, jsonb_build_object('sku', v_v.sku, 'version', v_v.version, 'evidence_id', v_e.id, 'recorded_by', v_e.recorded_by));
  RETURN jsonb_build_object('success', true, 'is_replay', false, 'evidence_id', v_e.id, 'price_version_id', v_v.id, 'comparison_verified', true);
END $$;

-- ---------------------------------------------------------------------------
-- 18. Replaced: owner reads.
-- ---------------------------------------------------------------------------
-- Receipt recovery: unchanged selection (the payer or the actor, whatever
-- their present role). Each receipt adds its refund requests and the present
-- state of the rights it bought; a renewal is shown only when the reader is
-- its payer. Nothing about the scope beyond what the reader paid for.
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_receipts(p_scope_kind text DEFAULT NULL, p_scope_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(public.fn_ca_commerce_receipt_json(p, true) || jsonb_build_object(
           'refunds', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'line_index', r.line_index, 'gross', r.gross,
                        'debt_settled', r.debt_settled, 'net_increase', r.net_increase, 'reason', r.reason, 'created_at', r.created_at))
                        FROM public.ca_commerce_refunds r WHERE r.purchase_id = p.id), '[]'::jsonb),
           'refund_requests', COALESCE((SELECT jsonb_agg(public.fn_ca_commerce_refund_request_json(q) ORDER BY q.created_at, q.id)
                        FROM public.ca_commerce_refund_requests q
                        WHERE q.purchase_id = p.id AND (q.payer_id = auth.uid() OR q.requested_by = auth.uid())), '[]'::jsonb),
           'rights', COALESCE((SELECT jsonb_agg(jsonb_build_object('entitlement_id', e.id, 'line_index', e.line_index, 'sku', e.sku,
                        'state', e.state, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
                        'refundable', public.fn_ca_commerce_refundable(p.id, e.line_index),
                        'renewal', (SELECT jsonb_build_object('mandate_id', m.id, 'state', m.state, 'sku', m.sku, 'quantity', m.quantity,
                                       'max_diamonds', m.max_diamonds, 'due_at', m.due_at, 'sponsorship_id', m.sponsorship_id)
                                      FROM public.ca_commerce_renewal_mandates m WHERE m.entitlement_id = e.id AND m.payer_id = auth.uid()))
                        ORDER BY e.line_index, e.created_at)
                        FROM public.ca_commerce_entitlements e WHERE e.purchase_id = p.id), '[]'::jsonb))
           ORDER BY p.created_at DESC), '[]'::jsonb)
    FROM public.ca_commerce_purchases p
   WHERE (p.payer_id = auth.uid() OR p.actor_id = auth.uid())
     AND (p_scope_kind IS NULL OR (p.scope_kind = p_scope_kind AND p.scope_id = p_scope_id))
$$;

-- Scope status: unchanged, plus the reader's balance breakdown (available,
-- reserved, pending refunds), their refund requests on this scope (every
-- request for staff), the accepted consent of each renewal, and the right a
-- sponsor would renew on each covered club.
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_scope_status(p_scope_kind text, p_scope_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_trial public.ca_commerce_trials;
  v_owner uuid;
  v_settings public.ca_commerce_settings;
  v_staff boolean;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  v_role := public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor);
  v_staff := public.fn_is_platform_admin();
  IF v_role = 'none' AND NOT v_staff THEN
    RETURN jsonb_build_object('success', false, 'error', 'access_denied');
  END IF;
  v_owner := public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id);
  SELECT * INTO v_trial FROM public.fn_ca_commerce_scope_trial(p_scope_kind, p_scope_id);
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  RETURN jsonb_build_object(
    'success', true,
    'server_time', now(),
    'role', v_role,
    'scope_kind', p_scope_kind, 'scope_id', p_scope_id,
    'owner_id', v_owner,
    'policy_version', v_settings.policy_version,
    'checkout_enabled', v_settings.checkout_enabled,
    'admission_enforced_from', v_settings.admission_enforced_from,
    'roster_count', CASE WHEN p_scope_kind = 'club' THEN public.fn_ca_commerce_roster_count(p_scope_id) END,
    'covered_club_count', CASE WHEN p_scope_kind = 'union' THEN public.fn_ca_commerce_covered_club_count(p_scope_id) END,
    -- The clubs this union covers, so a sponsor can see which need capacity
    -- and buy it for them (R2 section 5). Same membership rule as the count.
    'covered_clubs', CASE WHEN p_scope_kind = 'union' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'club_id', c.id, 'name', c.name,
        'roster_count', public.fn_ca_commerce_roster_count(c.id),
        'trial_active', public.fn_ca_commerce_in_trial('club', c.id),
        'capacity', (SELECT jsonb_build_object('entitlement_id', e.id, 'sku', e.sku, 'capacity', e.capacity, 'ends_at', e.ends_at, 'source', e.source,
                                               'renewal', (SELECT jsonb_build_object('mandate_id', m.id, 'state', m.state, 'max_diamonds', m.max_diamonds, 'due_at', m.due_at)
                                                             FROM public.ca_commerce_renewal_mandates m WHERE m.entitlement_id = e.id AND m.payer_id = v_actor))
                       FROM public.ca_commerce_entitlements e
                      WHERE e.scope_kind = 'club' AND e.scope_id = c.id AND e.kind = 'capacity' AND e.state = 'effective'
                        AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())
                      ORDER BY e.capacity DESC NULLS LAST, e.ends_at DESC NULLS FIRST LIMIT 1)
      ) ORDER BY c.name, c.id)
      FROM public.union_clubs uc JOIN public.clubs c ON c.id = uc.club_id
      WHERE uc.union_id = p_scope_id AND COALESCE(c.lifecycle_status, 'active') <> 'retired'), '[]'::jsonb) END,
    'trial', CASE WHEN v_trial.id IS NULL THEN NULL ELSE jsonb_build_object(
      'trial_id', v_trial.id, 'trial_start', v_trial.trial_start, 'trial_end', v_trial.trial_end,
      'cohort', v_trial.cohort, 'active', now() >= v_trial.trial_start AND now() < v_trial.trial_end) END,
    'entitlements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'sku', e.sku, 'kind', e.kind, 'capacity', e.capacity, 'quantity', e.quantity,
        'starts_at', e.starts_at, 'ends_at', e.ends_at, 'source', e.source, 'purchase_id', e.purchase_id,
        'net_paid', e.net_paid, 'value_basis', e.value_basis, 'revision', e.revision,
        'active', now() >= e.starts_at AND (e.ends_at IS NULL OR now() < e.ends_at),
        'scheduled', now() < e.starts_at,
        'renewal', (SELECT jsonb_build_object('mandate_id', m.id, 'state', m.state, 'sku', m.sku, 'quantity', m.quantity, 'max_diamonds', m.max_diamonds,
                       'due_at', m.due_at, 'payer_id', m.payer_id, 'last_result', m.last_result,
                       'sponsorship_id', m.sponsorship_id, 'terms_version', m.terms_version, 'ceiling_text_version', m.ceiling_text_version,
                       'accepted_ceiling_text', CASE WHEN m.ceiling_text_version IS NULL THEN NULL ELSE public.fn_ca_commerce_ceiling_text(
                          m.ceiling_text_version, m.sku, m.quantity, m.max_diamonds, m.sponsorship_id IS NOT NULL) END)
                      FROM public.ca_commerce_renewal_mandates m WHERE m.entitlement_id = e.id)
      ) ORDER BY e.starts_at DESC)
      FROM public.ca_commerce_entitlements e
      WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.state = 'effective'
        AND (e.ends_at IS NULL OR e.ends_at > now() - interval '30 days')
    ), '[]'::jsonb),
    'sponsorships', CASE WHEN p_scope_kind = 'union' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'club_id', s.club_id, 'payer_id', s.payer_id,
        'total_budget', s.total_budget, 'per_club_budget', s.per_club_budget, 'committed', s.committed,
        'effective_from', s.effective_from, 'effective_to', s.effective_to, 'state', s.state, 'revision', s.revision)
        ORDER BY s.created_at DESC)
      FROM public.ca_commerce_sponsorships s WHERE s.union_id = p_scope_id), '[]'::jsonb)
    ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'union_id', s.union_id, 'payer_id', s.payer_id,
        'remaining', s.total_budget - s.committed, 'per_club_budget', s.per_club_budget, 'effective_to', s.effective_to))
      FROM public.ca_commerce_sponsorships s
      JOIN public.union_clubs uc ON uc.club_id = p_scope_id AND uc.union_id = s.union_id
      WHERE s.state = 'active' AND (s.club_id IS NULL OR s.club_id = p_scope_id)
        AND s.effective_from <= now() AND (s.effective_to IS NULL OR s.effective_to > now())), '[]'::jsonb) END,
    'balance', CASE WHEN v_role = 'owner' THEN (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = v_actor) END,
    -- The reader's own wallet, in three distinct figures (R2 5.5, 7.2):
    -- available is the canonical spendable balance; reserved is what open
    -- purchased lots hold for Diamond Arena custody; pending is refunds asked
    -- for, approved or owed and not yet in the balance. Never added together.
    'balance_breakdown', CASE WHEN v_role = 'owner' THEN jsonb_build_object(
      'available', (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = v_actor),
      'reserved', (SELECT COALESCE(SUM(COALESCE(l.arena_reserved, 0)), 0)::bigint FROM public.diamond_purchase_lots l
                    WHERE l.user_id = v_actor AND l.frozen_at IS NULL),
      'pending_refunds', (SELECT COALESCE(SUM(COALESCE(q.approved_amount, q.policy_amount)), 0)::bigint FROM public.ca_commerce_refund_requests q
                           WHERE q.payer_id = v_actor AND q.state IN ('requested','approved','owed')),
      'pending_requested', (SELECT COALESCE(SUM(q.policy_amount), 0)::bigint FROM public.ca_commerce_refund_requests q
                             WHERE q.payer_id = v_actor AND q.state = 'requested'),
      'pending_approved', (SELECT COALESCE(SUM(q.approved_amount), 0)::bigint FROM public.ca_commerce_refund_requests q
                            WHERE q.payer_id = v_actor AND q.state = 'approved'),
      'owed_refunds', (SELECT COALESCE(SUM(q.approved_amount), 0)::bigint FROM public.ca_commerce_refund_requests q
                        WHERE q.payer_id = v_actor AND q.state = 'owed'),
      'observed_at', now()) END,
    'refund_requests', COALESCE((
      SELECT jsonb_agg(public.fn_ca_commerce_refund_request_json(q) ORDER BY q.created_at DESC, q.id)
        FROM public.ca_commerce_refund_requests q
       WHERE q.scope_kind = p_scope_kind AND q.scope_id = p_scope_id
         AND (v_staff OR q.payer_id = v_actor OR q.requested_by = v_actor)), '[]'::jsonb)
  );
END $$;

-- ---------------------------------------------------------------------------
-- 18b. Replaced: product support. Unchanged, except that withdrawing a
-- product also withdraws every open quote that sells it, in the same
-- transaction (R2 D06): a quote taken before the withdrawal is refused by
-- the purchase boundary exactly as any other non-open quote is, and nothing
-- is charged for a product no longer on sale. A purchase already holding
-- the quote row commits first and this waits for it; one that arrives after
-- reads the withdrawn row. Accepted purchases and their rights are untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_product_support(p_sku text, p_supported boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_withdrawn integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- A product that sells a platform capability cannot be marked supported
  -- while the registry says the capability is unavailable (section 0b).
  IF p_supported IS TRUE AND EXISTS (
       SELECT 1 FROM public.ca_commerce_products p
        WHERE p.sku = p_sku AND p.platform_capability_id IS NOT NULL
          AND NOT public.fn_capability_available(p.platform_capability_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'capability_unavailable', 'sku', p_sku);
  END IF;
  UPDATE public.ca_commerce_products SET supported = p_supported WHERE sku = p_sku;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'unknown_sku'); END IF;
  IF p_supported IS NOT TRUE THEN
    UPDATE public.ca_commerce_quotes q SET status = 'withdrawn'
     WHERE q.status = 'open'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(q.lines) l WHERE l->>'sku' = p_sku);
    GET DIAGNOSTICS v_withdrawn = ROW_COUNT;
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, detail) VALUES ('product_support_changed', v_actor,
    jsonb_build_object('sku', p_sku, 'supported', p_supported, 'quotes_withdrawn', v_withdrawn));
  RETURN jsonb_build_object('success', true, 'sku', p_sku, 'supported', p_supported, 'quotes_withdrawn', v_withdrawn);
END $$;

-- ---------------------------------------------------------------------------
-- 18c. Staff reads for the Commerce Desk. Platform staff or the service role.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_price_versions(p_sku text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  RETURN jsonb_build_object('success', true, 'price_versions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'price_version_id', v.id, 'sku', v.sku, 'version', v.version, 'status', v.status,
             'diamonds', v.diamonds, 'price_rule', v.price_rule, 'cap_diamonds', v.cap_diamonds,
             'price_authority', v.price_authority, 'effective_from', v.effective_from, 'effective_to', v.effective_to,
             'created_by', v.created_by, 'published_by', v.published_by, 'published_at', v.published_at,
             'comparison_verified', v.comparison_verified, 'comparison_evidence', v.comparison_evidence,
             'in_effect', v.status = 'published' AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now()),
             'created_at', v.created_at)
             ORDER BY v.created_at DESC, v.sku, v.version DESC)
      FROM public.ca_commerce_price_versions v
     WHERE p_sku IS NULL OR v.sku = p_sku), '[]'::jsonb));
END $$;

CREATE FUNCTION public.fn_ca_commerce_comparison_list(p_sku text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  RETURN jsonb_build_object('success', true, 'evidence', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'evidence_id', e.id, 'sku', e.sku, 'source_name', e.source_name, 'source_url', e.source_url,
             'observed_price', e.observed_price, 'observed_unit', e.observed_unit, 'observed_at', e.observed_at,
             'conversion_note', e.conversion_note, 'price_version_id', e.price_version_id,
             'recorded_by', e.recorded_by, 'recorded_by_name', (SELECT p.username FROM public.profiles p WHERE p.id = e.recorded_by),
             'recorded_at', e.recorded_at,
             'verified_by', e.verified_by, 'verified_by_name', (SELECT p.username FROM public.profiles p WHERE p.id = e.verified_by),
             'verified_at', e.verified_at, 'verified', e.verified_by IS NOT NULL)
             ORDER BY e.recorded_at DESC, e.id)
      FROM public.ca_commerce_comparison_evidence e
     WHERE p_sku IS NULL OR e.sku = p_sku), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 19. Grants, restated for every function this migration creates or
-- replaces. Browser doors ask auth themselves; internal helpers and the
-- consumer doors are private. A REVOKE names every role.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.fn_ca_commerce_policy_immutable(), public.fn_ca_commerce_mandate_funds_notice(),
  public.fn_ca_commerce_policy_version(text, timestamptz),
  public.fn_ca_commerce_ceiling_text(integer, text, integer, integer, boolean),
  public.fn_ca_commerce_refundable(uuid, integer),
  public.fn_ca_commerce_refund_policy(uuid, integer, text, timestamptz),
  public.fn_ca_commerce_refund_request_json(public.ca_commerce_refund_requests),
  public.fn_ca_commerce_refund_request(uuid, integer, text, text, text),
  public.fn_ca_commerce_refund_decide(uuid, boolean, integer, text),
  public.fn_ca_commerce_refund_queue(text, integer),
  public.fn_ca_commerce_execute_approved_refunds(uuid, integer),
  public.fn_ca_commerce_policies(text),
  public.fn_ca_commerce_claim_due_renewals(uuid, integer),
  public.fn_ca_commerce_set_renewal(uuid, boolean, integer, text, integer),
  public.fn_ca_commerce_execute_renewal(uuid, uuid),
  public.fn_ca_commerce_deliver_due_notices(integer),
  public.fn_ca_commerce_activate_launch_cohort(timestamptz),
  public.fn_ca_commerce_price_draft(text, integer, text, integer, text),
  public.fn_ca_commerce_price_validate(uuid),
  public.fn_ca_commerce_price_publish(uuid, timestamptz),
  public.fn_ca_commerce_price_retire(uuid, timestamptz),
  public.fn_ca_commerce_comparison_record(text, text, text, numeric, text, timestamptz, text, uuid),
  public.fn_ca_commerce_comparison_verify(uuid, uuid),
  public.fn_ca_commerce_receipts(text, uuid),
  public.fn_ca_commerce_scope_status(text, uuid),
  public.fn_ca_commerce_product_support(text, boolean),
  public.fn_ca_commerce_price_versions(text),
  public.fn_ca_commerce_comparison_list(text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.fn_ca_commerce_refund_request(uuid, integer, text, text, text),
  public.fn_ca_commerce_refund_decide(uuid, boolean, integer, text),
  public.fn_ca_commerce_refund_queue(text, integer),
  public.fn_ca_commerce_policies(text),
  public.fn_ca_commerce_set_renewal(uuid, boolean, integer, text, integer),
  public.fn_ca_commerce_activate_launch_cohort(timestamptz),
  public.fn_ca_commerce_price_draft(text, integer, text, integer, text),
  public.fn_ca_commerce_price_validate(uuid),
  public.fn_ca_commerce_price_publish(uuid, timestamptz),
  public.fn_ca_commerce_price_retire(uuid, timestamptz),
  public.fn_ca_commerce_comparison_record(text, text, text, numeric, text, timestamptz, text, uuid),
  public.fn_ca_commerce_comparison_verify(uuid, uuid),
  public.fn_ca_commerce_receipts(text, uuid),
  public.fn_ca_commerce_scope_status(text, uuid),
  public.fn_ca_commerce_product_support(text, boolean),
  public.fn_ca_commerce_price_versions(text),
  public.fn_ca_commerce_comparison_list(text)
TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.fn_ca_commerce_claim_due_renewals(uuid, integer),
  public.fn_ca_commerce_execute_renewal(uuid, uuid),
  public.fn_ca_commerce_deliver_due_notices(integer),
  public.fn_ca_commerce_execute_approved_refunds(uuid, integer)
TO service_role;

-- ---------------------------------------------------------------------------
-- 20. Post-conditions.
-- ---------------------------------------------------------------------------
DO $assertions$
DECLARE
  v_fn text;
BEGIN
  IF (SELECT count(*) FROM public.ca_commerce_policies WHERE version = 1) <> 3
     OR public.fn_ca_commerce_policy_version('refund') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'the three version 1 policy texts are not in effect';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_commerce_policies WHERE strpos(title || body, chr(8212)) > 0) THEN
    RAISE EXCEPTION 'a policy text carries an em dash';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ca_commerce_refund_requests_one_open') THEN
    RAISE EXCEPTION 'one open refund request per line is not enforced';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fn_ca_commerce_claim_due_renewals'), 'consumer_heartbeat_at') = 0 THEN
    RAISE EXCEPTION 'the claim door does not stamp the consumer heartbeat';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fn_ca_commerce_product_support'), 'withdrawn') = 0 THEN
    RAISE EXCEPTION 'withdrawing a product does not withdraw its open quotes';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fn_ca_commerce_price_draft'), '''draft''') = 0 THEN
    RAISE EXCEPTION 'a price draft is not created as a draft';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fn_ca_commerce_execute_renewal'), 'ca_commerce_scope:') = 0 THEN
    RAISE EXCEPTION 'renewal execution does not take the scope lock first';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['fn_ca_commerce_execute_approved_refunds(uuid,integer)', 'fn_ca_commerce_claim_due_renewals(uuid,integer)',
                               'fn_ca_commerce_execute_renewal(uuid,uuid)', 'fn_ca_commerce_deliver_due_notices(integer)',
                               'fn_ca_commerce_refundable(uuid,integer)', 'fn_ca_commerce_refund_policy(uuid,integer,text,timestamptz)',
                               'fn_ca_commerce_policy_version(text,timestamptz)'] LOOP
    IF has_function_privilege('authenticated', 'public.' || v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'commerce internal door % must stay private', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_commerce_execute_approved_refunds(uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the consumer cannot reach the refund execution door';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'fn_ca_commerce%'
              AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'no commerce function is reachable without an account';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'fn_ca_commerce%'
              AND proname ~* '(repair|backpay|redrive|catchup|backfill|heal|reconcile|sweep)') THEN
    RAISE EXCEPTION 'no band-aid: nothing in the commerce boundary repairs its outcomes later';
  END IF;
END $assertions$;

COMMIT;
