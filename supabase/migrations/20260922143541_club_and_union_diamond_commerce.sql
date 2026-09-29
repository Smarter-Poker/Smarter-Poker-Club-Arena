-- 20260922143541_club_and_union_diamond_commerce.sql
-- Version reserved by scripts/new-migration.mjs (CLAUDE.md 4.5).
--
-- WHAT THIS CHANGES, AND WHY:
-- Assignment CA-DIAMOND-COMMERCE-2026-09-22 (Revision 2): club and union
-- operating capacity and specific services are sold for diamonds through a
-- versioned catalog, a server-authoritative quote, one atomic purchase with
-- strict accounting postconditions, scoped entitlements, optional diamond
-- renewals, union sponsorship budgets and exact-value refunds. Every eligible
-- operator's first thirty days are an operating-service fee waiver.
--
-- What this does NOT do: it does not change gameplay economics, chip minting,
-- Diamond Spins, VIP, player feature prices, rake or any settled record. It
-- does not debit anyone at install time. It publishes the R2 candidate
-- catalog as catalog version 1 with price_authority recorded as the
-- assignment itself and every comparison claim disabled (R2 section 4.4).
-- Report and artwork SKUs are installed as products but NOT supported for
-- sale yet: their fulfillment mapping is a later increment (R2 section 7.3,
-- "keep only that unsupported offering unavailable").
--
-- Accounting treatment (R2-A02, R2-A03, R2-A04, R2-A05):
--   * A paid purchase debits the payer through public.deduct_diamonds with
--     source 'club_commerce'. That journals a spend to revenue:club_commerce
--     and the journal-following register records the Mint retirement. This
--     function then PROVES the journal row, the exact linked ca_mint_ledger
--     row and the persisted purchased-lot deltas, and raises when any of them
--     is missing, so the debit, receipt, rights and follow-up roll back
--     together. No second burn, no platform wallet.
--   * A refund credits through public.add_diamonds_to_balance with the
--     exact-value type 'refund' (already in the multiplier exception list and
--     already classified refund/registered as a Mint issuance), proves the
--     journal and register rows, restores the operation-linked lot
--     provenance and reports gross, debt settled and net separately.
--   * A trial waiver has zero debit and no Mint movement.
--
-- Lock order at the new boundary (compatible with every existing wallet
-- writer, which lock profiles -> diamond_debts -> diamond_purchase_lots):
--   quote row -> scope advisory lock -> sponsorship row -> payer profiles row
--   (inside deduct_diamonds) -> lots. Nothing here takes a global economy
--   lock, and supply_after is left observational (R2-A09).
--
-- Wrap ALL DDL for one change in ONE transaction (CLAUDE.md section 2,
-- production DDL policy): every DDL statement makes PostgREST reload its
-- schema cache (~28s); one transaction coalesces the reloads.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. The orphaned club_creation price row (P2-F04, D29).
-- fn_purchase_feature_v2 sells any feature_pricing row, and club_creation was
-- a 'permanent' row at 100 diamonds that no creation path ever checked. A
-- client calling the personal feature door with 'club_creation' would have
-- been charged 100 diamonds for a row that grants nothing. Initial creation is
-- included in operating access (R2 section 3.6), so the price row is removed.
-- Historical feature_purchases rows, if any, are preserved untouched.
-- ---------------------------------------------------------------------------
DELETE FROM public.feature_pricing WHERE feature = 'club_creation';

-- ---------------------------------------------------------------------------
-- 1. Settings and rollout states (R2 section 10.2).
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  catalog_visible boolean NOT NULL DEFAULT true,
  checkout_enabled boolean NOT NULL DEFAULT true,
  admission_enforced_from timestamptz,
  launch_cohort_activated_at timestamptz,
  quote_ttl interval NOT NULL DEFAULT interval '15 minutes',
  trial_hours integer NOT NULL DEFAULT 720 CHECK (trial_hours > 0),
  renewal_lateness_hours integer NOT NULL DEFAULT 24 CHECK (renewal_lateness_hours >= 0),
  policy_version text NOT NULL DEFAULT 'commerce-v1',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ca_commerce_settings (id) VALUES (1);
ALTER TABLE public.ca_commerce_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_settings FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Products and immutable price versions (R2 section 1.1, 1.5, 7.3).
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_products (
  sku text PRIMARY KEY CHECK (sku ~ '^[a-z0-9_]{3,60}$'),
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('capacity','union_back_office','club_insurance_module','union_insurance_module','report','asset')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  term_kind text NOT NULL CHECK (term_kind IN ('period','report_interval','permanent')),
  term_hours integer CHECK (term_hours IS NULL OR term_hours > 0),
  report_days integer CHECK (report_days IS NULL OR report_days > 0),
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  quantity_unit text NOT NULL DEFAULT 'flat' CHECK (quantity_unit IN ('flat','covered_club')),
  capability_id text NOT NULL,
  supported boolean NOT NULL DEFAULT false,
  included_note text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((term_kind = 'period' AND term_hours IS NOT NULL) OR (term_kind = 'report_interval' AND report_days IS NOT NULL) OR (term_kind = 'permanent'))
);

CREATE TABLE public.ca_commerce_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL REFERENCES public.ca_commerce_products(sku),
  version integer NOT NULL CHECK (version > 0),
  diamonds integer NOT NULL CHECK (diamonds >= 0 AND diamonds <= 2147483647),
  price_rule text NOT NULL DEFAULT 'flat' CHECK (price_rule IN ('flat','per_unit','per_unit_capped')),
  cap_diamonds integer CHECK (cap_diamonds IS NULL OR cap_diamonds > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','published','retired')),
  effective_from timestamptz,
  effective_to timestamptz,
  price_authority text NOT NULL,
  comparison_verified boolean NOT NULL DEFAULT false,
  comparison_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  published_by uuid,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku, version),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
  CHECK (status <> 'published' OR effective_from IS NOT NULL)
);
CREATE INDEX ca_commerce_price_versions_published ON public.ca_commerce_price_versions (sku, effective_from) WHERE status = 'published';

-- An accepted price is never edited in place; a status only moves forward.
CREATE FUNCTION public.fn_ca_commerce_price_version_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A Price Version Is Never Deleted';
  END IF;
  IF OLD.status IN ('published','retired') AND (
       NEW.sku, NEW.version, NEW.diamonds, NEW.price_rule, NEW.cap_diamonds, NEW.effective_from,
       NEW.price_authority, NEW.published_by, NEW.published_at)
     IS DISTINCT FROM (
       OLD.sku, OLD.version, OLD.diamonds, OLD.price_rule, OLD.cap_diamonds, OLD.effective_from,
       OLD.price_authority, OLD.published_by, OLD.published_at) THEN
    RAISE EXCEPTION 'A Published Price Cannot Change In Place';
  END IF;
  IF (OLD.status = 'draft' AND NEW.status NOT IN ('draft','validated','retired'))
     OR (OLD.status = 'validated' AND NEW.status NOT IN ('validated','published','retired'))
     OR (OLD.status = 'published' AND NEW.status NOT IN ('published','retired'))
     OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
    RAISE EXCEPTION 'Invalid Price Version Transition';
  END IF;
  IF OLD.status <> 'published' AND NEW.status = 'published' THEN
    IF NEW.published_by IS NULL OR NEW.published_at IS NULL OR NEW.effective_from IS NULL THEN
      RAISE EXCEPTION 'A Published Price Names Its Publisher And Effective Date';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.ca_commerce_price_versions p
       WHERE p.sku = NEW.sku AND p.id <> NEW.id AND p.status = 'published'
         AND tstzrange(p.effective_from, p.effective_to, '[)') && tstzrange(NEW.effective_from, NEW.effective_to, '[)')
    ) THEN
      RAISE EXCEPTION 'Two Published Prices Cannot Overlap For One Product';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ca_commerce_price_versions_immutable BEFORE UPDATE OR DELETE ON public.ca_commerce_price_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_commerce_price_version_immutable();

ALTER TABLE public.ca_commerce_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_price_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_products, public.ca_commerce_price_versions FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Trials (R2 section 2). One initial operating trial per operator
-- identity; a scope enrolled later inherits the common end time.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_trials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL UNIQUE,
  trial_start timestamptz NOT NULL,
  trial_end timestamptz NOT NULL,
  policy_version text NOT NULL,
  cohort text NOT NULL CHECK (cohort IN ('new_operator','launch_cohort')),
  activated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (trial_end > trial_start)
);
CREATE TABLE public.ca_commerce_trial_scopes (
  trial_id uuid NOT NULL REFERENCES public.ca_commerce_trials(id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  enrolled_by uuid,
  reason text NOT NULL,
  PRIMARY KEY (scope_kind, scope_id)
);
CREATE INDEX ca_commerce_trial_scopes_trial ON public.ca_commerce_trial_scopes (trial_id);
ALTER TABLE public.ca_commerce_trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_trial_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_trials, public.ca_commerce_trial_scopes FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Sponsorship (R2 section 5.2): an explicit union payer mandate with a
-- budget. Affiliation alone never authorizes spending.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_sponsorships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  club_id uuid,
  total_budget integer NOT NULL CHECK (total_budget > 0),
  per_club_budget integer CHECK (per_club_budget IS NULL OR per_club_budget > 0),
  committed integer NOT NULL DEFAULT 0 CHECK (committed >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (committed <= total_budget),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX ca_commerce_sponsorships_union ON public.ca_commerce_sponsorships (union_id, state);
ALTER TABLE public.ca_commerce_sponsorships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_sponsorships FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Quotes, purchases, entitlements, mandates, refunds, fulfillment, notices.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  sponsorship_id uuid REFERENCES public.ca_commerce_sponsorships(id),
  lines jsonb NOT NULL,
  basket_hash text NOT NULL,
  context_hash text NOT NULL,
  catalog_version text NOT NULL,
  gross integer NOT NULL CHECK (gross >= 0),
  credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
  comparison_adjustment integer NOT NULL DEFAULT 0 CHECK (comparison_adjustment >= 0),
  trial_waiver integer NOT NULL DEFAULT 0 CHECK (trial_waiver >= 0),
  net integer NOT NULL CHECK (net >= 0),
  trial_id uuid REFERENCES public.ca_commerce_trials(id),
  renewal_max_diamonds integer CHECK (renewal_max_diamonds IS NULL OR renewal_max_diamonds >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','consumed','expired','withdrawn')),
  purchase_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (net = gross - credits - comparison_adjustment - trial_waiver),
  CHECK ((status = 'consumed') = (purchase_id IS NOT NULL))
);
CREATE INDEX ca_commerce_quotes_scope ON public.ca_commerce_quotes (scope_kind, scope_id, created_at DESC);
CREATE INDEX ca_commerce_quotes_actor_open ON public.ca_commerce_quotes (actor_id, created_at DESC) WHERE status = 'open';

CREATE TABLE public.ca_commerce_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES public.ca_commerce_quotes(id),
  actor_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  sponsorship_id uuid REFERENCES public.ca_commerce_sponsorships(id),
  kind text NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase','renewal','upgrade')),
  gross integer NOT NULL CHECK (gross >= 0),
  net integer NOT NULL CHECK (net >= 0),
  trial_waiver integer NOT NULL DEFAULT 0 CHECK (trial_waiver >= 0),
  lines jsonb NOT NULL,
  diamond_tx_id uuid UNIQUE,
  mint_op_id text,
  lot_allocation jsonb NOT NULL DEFAULT '[]'::jsonb,
  catalog_version text NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, request_key),
  CHECK ((net = 0) = (diamond_tx_id IS NULL))
);
CREATE INDEX ca_commerce_purchases_payer ON public.ca_commerce_purchases (payer_id, created_at DESC);
CREATE INDEX ca_commerce_purchases_scope ON public.ca_commerce_purchases (scope_kind, scope_id, created_at DESC);
CREATE INDEX ca_commerce_purchases_sponsorship ON public.ca_commerce_purchases (sponsorship_id, scope_id) WHERE sponsorship_id IS NOT NULL;
ALTER TABLE public.ca_commerce_quotes ADD CONSTRAINT ca_commerce_quotes_purchase_fk FOREIGN KEY (purchase_id) REFERENCES public.ca_commerce_purchases(id);

CREATE TABLE public.ca_commerce_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  sku text REFERENCES public.ca_commerce_products(sku),
  kind text NOT NULL,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  asset_id text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  data_start date,
  data_end date,
  report_tz text,
  source text NOT NULL CHECK (source IN ('purchase','trial','sponsor')),
  purchase_id uuid REFERENCES public.ca_commerce_purchases(id),
  line_index integer,
  trial_id uuid REFERENCES public.ca_commerce_trials(id),
  state text NOT NULL DEFAULT 'effective' CHECK (state IN ('effective','superseded','revoked')),
  revision integer NOT NULL DEFAULT 1,
  superseded_by uuid,
  net_paid integer NOT NULL DEFAULT 0 CHECK (net_paid >= 0),
  -- The value the holder has for [starts_at, ends_at): what this line paid
  -- plus the unused value credited in from the right it replaced. Upgrade
  -- proration reads this, never an undiscounted list price (R2 section 4.4).
  value_basis integer NOT NULL DEFAULT 0 CHECK (value_basis >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK ((source = 'trial') = (trial_id IS NOT NULL)),
  CHECK (source = 'trial' OR purchase_id IS NOT NULL),
  CHECK (source = 'trial' OR sku IS NOT NULL)
);
-- Business identity barrier (R2 section 3.2, third barrier): one effective
-- time-limited right per scope, kind and period start. Overlap is refused by
-- the purchase function under the scope advisory lock; this index refuses a
-- duplicate extension of the exact same period even without it.
CREATE UNIQUE INDEX ca_commerce_entitlements_period_identity ON public.ca_commerce_entitlements (scope_kind, scope_id, kind, starts_at)
  WHERE state = 'effective' AND ends_at IS NOT NULL;
CREATE UNIQUE INDEX ca_commerce_entitlements_asset_identity ON public.ca_commerce_entitlements (scope_kind, scope_id, sku, asset_id)
  WHERE state = 'effective' AND ends_at IS NULL AND asset_id IS NOT NULL;
CREATE INDEX ca_commerce_entitlements_scope_effective ON public.ca_commerce_entitlements (scope_kind, scope_id, kind, ends_at) WHERE state = 'effective';
CREATE INDEX ca_commerce_entitlements_purchase ON public.ca_commerce_entitlements (purchase_id) WHERE purchase_id IS NOT NULL;

CREATE TABLE public.ca_commerce_renewal_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES public.ca_commerce_entitlements(id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  sku text NOT NULL REFERENCES public.ca_commerce_products(sku),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  max_diamonds integer NOT NULL CHECK (max_diamonds >= 0),
  state text NOT NULL DEFAULT 'authorized' CHECK (state IN ('authorized','cancelled','needs_attention','completed')),
  due_at timestamptz NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_result jsonb,
  renewal_purchase_id uuid REFERENCES public.ca_commerce_purchases(id),
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entitlement_id, sku)
);
CREATE INDEX ca_commerce_renewal_mandates_due ON public.ca_commerce_renewal_mandates (due_at) WHERE state = 'authorized';
CREATE INDEX ca_commerce_renewal_mandates_scope ON public.ca_commerce_renewal_mandates (scope_kind, scope_id);

CREATE TABLE public.ca_commerce_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.ca_commerce_purchases(id),
  line_index integer NOT NULL CHECK (line_index >= 0),
  request_key text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 200),
  requested_by uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) >= 10),
  payer_id uuid NOT NULL,
  gross integer NOT NULL CHECK (gross > 0),
  debt_settled integer NOT NULL DEFAULT 0 CHECK (debt_settled >= 0),
  net_increase integer NOT NULL CHECK (net_increase >= 0),
  diamond_tx_id uuid NOT NULL UNIQUE,
  mint_op_id text NOT NULL,
  lot_restoration jsonb NOT NULL DEFAULT '[]'::jsonb,
  revoked_entitlement boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (net_increase + debt_settled = gross)
);
CREATE INDEX ca_commerce_refunds_purchase ON public.ca_commerce_refunds (purchase_id, line_index);

CREATE TABLE public.ca_commerce_fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.ca_commerce_purchases(id),
  line_index integer NOT NULL,
  entitlement_id uuid REFERENCES public.ca_commerce_entitlements(id),
  kind text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','delivered','failed','cancelled')),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_id, line_index)
);

CREATE TABLE public.ca_commerce_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  action_url text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at timestamptz NOT NULL DEFAULT now(),
  notification_id uuid,
  delivered_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ca_commerce_notices_due ON public.ca_commerce_notices (due_at) WHERE delivered_at IS NULL;

CREATE TABLE public.ca_commerce_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL,
  actor_id uuid,
  scope_kind text,
  scope_id uuid,
  reference_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ca_commerce_events_scope ON public.ca_commerce_events (scope_kind, scope_id, occurred_at DESC);

ALTER TABLE public.ca_commerce_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_renewal_mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_fulfillments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_commerce_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_quotes, public.ca_commerce_purchases, public.ca_commerce_entitlements,
  public.ca_commerce_renewal_mandates, public.ca_commerce_refunds, public.ca_commerce_fulfillments,
  public.ca_commerce_notices, public.ca_commerce_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ca_commerce_events_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- Receipts and refunds are transaction evidence: append only.
CREATE FUNCTION public.fn_ca_commerce_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Commerce Receipts And Refunds Are Permanent';
END $$;
CREATE TRIGGER ca_commerce_purchases_append_only BEFORE UPDATE OR DELETE ON public.ca_commerce_purchases
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_commerce_append_only();
CREATE TRIGGER ca_commerce_refunds_append_only BEFORE UPDATE OR DELETE ON public.ca_commerce_refunds
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_commerce_append_only();
CREATE TRIGGER ca_commerce_events_append_only BEFORE UPDATE OR DELETE ON public.ca_commerce_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_commerce_append_only();

-- ---------------------------------------------------------------------------
-- 6. Catalog version 1: the R2 candidate schedule (section 3), published with
-- its authority named and every comparison claim disabled.
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_commerce_products (sku, title, kind, scope_kind, term_kind, term_hours, report_days, capacity, quantity_unit, capability_id, supported, included_note, sort_order) VALUES
  ('capacity_60',   'Up To 60 Approved Members',    'capacity', 'club', 'period', 720, NULL, 60,   'flat', 'club.capacity', true, 'Ordinary Administration, Roster And Role Management, Dashboards, Table And Tournament Creation And Scheduling', 10),
  ('capacity_100',  'Up To 100 Approved Members',   'capacity', 'club', 'period', 720, NULL, 100,  'flat', 'club.capacity', true, 'Ordinary Administration, Roster And Role Management, Dashboards, Table And Tournament Creation And Scheduling', 20),
  ('capacity_250',  'Up To 250 Approved Members',   'capacity', 'club', 'period', 720, NULL, 250,  'flat', 'club.capacity', true, 'Ordinary Administration, Roster And Role Management, Dashboards, Table And Tournament Creation And Scheduling', 30),
  ('capacity_500',  'Up To 500 Approved Members',   'capacity', 'club', 'period', 720, NULL, 500,  'flat', 'club.capacity', true, 'Ordinary Administration, Roster And Role Management, Dashboards, Table And Tournament Creation And Scheduling', 40),
  ('capacity_1000', 'Up To 1,000 Approved Members', 'capacity', 'club', 'period', 720, NULL, 1000, 'flat', 'club.capacity', true, 'Ordinary Administration, Roster And Role Management, Dashboards, Table And Tournament Creation And Scheduling', 50),
  ('capacity_2500', 'Up To 2,500 Approved Members', 'capacity', 'club', 'period', 720, NULL, 2500, 'flat', 'club.capacity', true, 'Ordinary Administration, Roster And Role Management, Dashboards, Table And Tournament Creation And Scheduling', 60),
  ('union_back_office', 'Union Back Office', 'union_back_office', 'union', 'period', 720, NULL, NULL, 'covered_club', 'union.back_office', true, 'Union-Wide Oversight, Permissions, Cross-Club Coordination, Settlement Management Tools And Consolidated Reports For Covered Clubs', 100),
  ('club_insurance_module', 'Club Insurance Software Module', 'club_insurance_module', 'club', 'period', 720, NULL, NULL, 'flat', 'club.insurance_module', true, 'Insurance Software Access For One Club; Premiums, Odds And Accepted Payouts Are Unchanged', 200),
  ('union_insurance_module', 'Union Insurance Software Module', 'union_insurance_module', 'union', 'period', 720, NULL, NULL, 'covered_club', 'union.insurance_module', true, 'Insurance Software Access Across Covered Clubs; No Duplicate Club Charge', 210),
  ('report_export_7d', 'Detailed Club Export', 'report', 'club', 'report_interval', NULL, 7, NULL, 'flat', 'club.report_export', false, 'One Seven-Day Reporting Interval For One Club', 300),
  ('report_pack_30d', 'Club Reporting Pack', 'report', 'club', 'report_interval', NULL, 30, NULL, 'flat', 'club.report_pack', false, 'Thirty-Day Reporting Interval Including Regenerated Exports', 310),
  ('asset_club_cover', 'Custom Premium Club Cover', 'asset', 'club', 'permanent', NULL, NULL, NULL, 'flat', 'club.asset.cover', false, 'One Saved Customization', 400),
  ('asset_table_background', 'Premium Table Background', 'asset', 'club', 'permanent', NULL, NULL, NULL, 'flat', 'club.asset.background', false, 'One Selected Asset', 410),
  ('asset_table_felt', 'Premium Table Design', 'asset', 'club', 'permanent', NULL, NULL, NULL, 'flat', 'club.asset.felt', false, 'One Selected Asset', 420),
  ('asset_theme_bundle', 'Complete Coordinated Theme', 'asset', 'club', 'permanent', NULL, NULL, NULL, 'flat', 'club.asset.theme', false, 'One Bundle With Explicit Component Ids', 430),
  ('asset_club_card_back', 'Club-Branded Card Back', 'asset', 'club', 'permanent', NULL, NULL, NULL, 'flat', 'club.asset.card_back', false, 'One Club-Branded Design Entitlement', 440);

INSERT INTO public.ca_commerce_price_versions (sku, version, diamonds, price_rule, cap_diamonds, status, effective_from, price_authority, comparison_verified, comparison_evidence, published_by, published_at) VALUES
  ('capacity_60',   1, 500,  'flat', NULL, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.1 candidate schedule', false, '{"status":"Proposed","note":"Below the recorded arithmetic ceilings; not a certified equivalent offer."}', NULL, now()),
  ('capacity_100',  1, 700,  'flat', NULL, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.1 candidate schedule', false, '{"status":"Proposed"}', NULL, now()),
  ('capacity_250',  1, 1500, 'flat', NULL, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.1 candidate schedule', false, '{"status":"Proposed","note":"Known pricing cliff between 100 and 250 members; not an approved optimum."}', NULL, now()),
  ('capacity_500',  1, 2500, 'flat', NULL, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.1 candidate schedule', false, '{"status":"Proposed"}', NULL, now()),
  ('capacity_1000', 1, 4000, 'flat', NULL, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.1 candidate schedule', false, '{"status":"Proposed"}', NULL, now()),
  ('capacity_2500', 1, 7500, 'flat', NULL, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.1 candidate schedule', false, '{"status":"Proposed"}', NULL, now()),
  ('union_back_office', 1, 1000, 'per_unit', NULL, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.2 candidate rate', false, '{"status":"Proposed"}', NULL, now()),
  ('club_insurance_module', 1, 200, 'flat', NULL, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.3 candidate software-access price', false, '{"status":"Proposed"}', NULL, now()),
  ('union_insurance_module', 1, 200, 'per_unit_capped', 1000, 'published', now(), 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.3 candidate software-access price', false, '{"status":"Proposed"}', NULL, now()),
  ('report_export_7d', 1, 200, 'flat', NULL, 'validated', NULL, 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.3 candidate price; fulfillment mapping pending', false, '{"status":"Proposed"}', NULL, NULL),
  ('report_pack_30d', 1, 700, 'flat', NULL, 'validated', NULL, 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.3 candidate price; fulfillment mapping pending', false, '{"status":"Proposed"}', NULL, NULL),
  ('asset_club_cover', 1, 100, 'flat', NULL, 'validated', NULL, 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.4 candidate price; asset mapping pending', false, '{"status":"Proposed"}', NULL, NULL),
  ('asset_table_background', 1, 250, 'flat', NULL, 'validated', NULL, 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.4 candidate price; asset mapping pending', false, '{"status":"Proposed"}', NULL, NULL),
  ('asset_table_felt', 1, 350, 'flat', NULL, 'validated', NULL, 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.4 candidate price; asset mapping pending', false, '{"status":"Proposed"}', NULL, NULL),
  ('asset_theme_bundle', 1, 600, 'flat', NULL, 'validated', NULL, 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.4 candidate price; asset mapping pending', false, '{"status":"Proposed"}', NULL, NULL),
  ('asset_club_card_back', 1, 250, 'flat', NULL, 'validated', NULL, 'CA-DIAMOND-COMMERCE-2026-09-22 R2 section 3.4 candidate price; asset mapping pending', false, '{"status":"Proposed"}', NULL, NULL);

-- ---------------------------------------------------------------------------
-- 7. Internal helpers (service-only, never browser-executable).
-- ---------------------------------------------------------------------------

-- The operator identity of a scope is its current owner.
CREATE FUNCTION public.fn_ca_commerce_scope_owner(p_scope_kind text, p_scope_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE p_scope_kind
    WHEN 'club' THEN (SELECT c.owner_id FROM public.clubs c WHERE c.id = p_scope_id)
    WHEN 'union' THEN (SELECT u.owner_id FROM public.unions u WHERE u.id = p_scope_id)
  END
$$;

-- 'owner' may spend and authorize; 'admin' may read; 'none' may not.
CREATE FUNCTION public.fn_ca_commerce_scope_role(p_scope_kind text, p_scope_id uuid, p_user_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN 'none'; END IF;
  v_owner := public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id);
  IF v_owner IS NULL THEN RETURN 'none'; END IF;
  IF v_owner = p_user_id THEN RETURN 'owner'; END IF;
  IF p_scope_kind = 'club' AND EXISTS (
       SELECT 1 FROM public.club_members m
        WHERE m.club_id = p_scope_id AND m.user_id = p_user_id
          AND COALESCE(m.status, 'active') IN ('active','approved') AND COALESCE(m.membership_lifecycle_status, 'active') = 'active'
          AND m.role IN ('owner','co_owner','admin')) THEN
    RETURN 'admin';
  END IF;
  IF p_scope_kind = 'union' AND EXISTS (
       SELECT 1 FROM public.union_admins a WHERE a.union_id = p_scope_id AND a.user_id = p_user_id) THEN
    RETURN 'admin';
  END IF;
  RETURN 'none';
END $$;

-- Approved roster: each approved account counted once (R2 section 3.1).
CREATE FUNCTION public.fn_ca_commerce_roster_count(p_club_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COUNT(DISTINCT m.user_id)::integer FROM public.club_members m
   WHERE m.club_id = p_club_id AND COALESCE(m.status, 'active') IN ('active','approved')
     AND COALESCE(m.membership_lifecycle_status, 'active') = 'active'
$$;

CREATE FUNCTION public.fn_ca_commerce_covered_club_count(p_union_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COUNT(*)::integer FROM public.union_clubs uc
   JOIN public.clubs c ON c.id = uc.club_id
   WHERE uc.union_id = p_union_id AND COALESCE(c.lifecycle_status, 'active') <> 'retired'
$$;

CREATE FUNCTION public.fn_ca_commerce_scope_trial(p_scope_kind text, p_scope_id uuid) RETURNS public.ca_commerce_trials
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.* FROM public.ca_commerce_trial_scopes s JOIN public.ca_commerce_trials t ON t.id = s.trial_id
   WHERE s.scope_kind = p_scope_kind AND s.scope_id = p_scope_id
$$;

CREATE FUNCTION public.fn_ca_commerce_in_trial(p_scope_kind text, p_scope_id uuid, p_at timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT p_at >= t.trial_start AND p_at < t.trial_end
                     FROM public.fn_ca_commerce_scope_trial(p_scope_kind, p_scope_id) t), false)
$$;

CREATE FUNCTION public.fn_ca_commerce_catalog_version() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 'catalog:' || COALESCE(to_char(max(published_at) AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS'), 'none')
    FROM public.ca_commerce_price_versions WHERE status = 'published'
$$;

-- The price of one line: unit price, rule and cap, whole diamonds only.
CREATE FUNCTION public.fn_ca_commerce_line_gross(p_price public.ca_commerce_price_versions, p_quantity integer) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 10000 THEN
    RAISE EXCEPTION 'Quantity Must Be Between 1 And 10,000';
  END IF;
  RETURN CASE p_price.price_rule
    WHEN 'flat' THEN p_price.diamonds
    WHEN 'per_unit' THEN p_price.diamonds * p_quantity
    WHEN 'per_unit_capped' THEN LEAST(p_price.diamonds * p_quantity, COALESCE(p_price.cap_diamonds, p_price.diamonds * p_quantity))
  END;
END $$;

-- Deterministic whole-diamond allocation of a basket-level reduction across
-- lines: proportional, largest remainder, stable tie-break by line order
-- (R2 section 3.1). Returns one integer per line whose sum is p_reduction.
CREATE FUNCTION public.fn_ca_commerce_allocate(p_weights integer[], p_reduction integer) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_total bigint := 0;
  v_out integer[] := '{}';
  v_rem numeric[] := '{}';
  v_i integer;
  v_share numeric;
  v_floor integer;
  v_assigned bigint := 0;
  v_left integer;
  v_best integer;
  v_best_val numeric;
BEGIN
  IF p_reduction < 0 THEN RAISE EXCEPTION 'A Reduction Cannot Be Negative'; END IF;
  FOR v_i IN 1 .. COALESCE(array_length(p_weights, 1), 0) LOOP
    v_total := v_total + GREATEST(p_weights[v_i], 0);
  END LOOP;
  IF p_reduction > v_total THEN RAISE EXCEPTION 'A Reduction Cannot Exceed The Basket'; END IF;
  FOR v_i IN 1 .. COALESCE(array_length(p_weights, 1), 0) LOOP
    IF v_total = 0 THEN
      v_out := v_out || 0; v_rem := v_rem || 0::numeric;
    ELSE
      v_share := (p_reduction::numeric * GREATEST(p_weights[v_i], 0)::numeric) / v_total::numeric;
      v_floor := floor(v_share)::integer;
      v_out := v_out || v_floor;
      v_rem := v_rem || (v_share - v_floor);
      v_assigned := v_assigned + v_floor;
    END IF;
  END LOOP;
  v_left := p_reduction - v_assigned;
  WHILE v_left > 0 LOOP
    v_best := NULL; v_best_val := -1;
    FOR v_i IN 1 .. array_length(v_out, 1) LOOP
      IF v_rem[v_i] > v_best_val AND v_out[v_i] < p_weights[v_i] THEN
        v_best := v_i; v_best_val := v_rem[v_i];
      END IF;
    END LOOP;
    EXIT WHEN v_best IS NULL;
    v_out[v_best] := v_out[v_best] + 1;
    v_rem[v_best] := -1;
    v_left := v_left - 1;
  END LOOP;
  RETURN v_out;
END $$;

-- Persisted purchased-lot view for one payer: the operation-linked before or
-- after snapshot (R2-A03). Only open, unfrozen lots can be consumed.
CREATE FUNCTION public.fn_ca_commerce_lot_snapshot(p_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lot_id', l.id, 'consumed', l.consumed,
           'available', l.issued - l.consumed - l.refunded - COALESCE(l.arena_reserved, 0))
           ORDER BY l.created_at, l.id), '[]'::jsonb)
    FROM public.diamond_purchase_lots l
   WHERE l.user_id = p_user_id AND l.frozen_at IS NULL
$$;

CREATE FUNCTION public.fn_ca_commerce_notice(p_user_id uuid, p_dedupe_key text, p_kind text, p_title text, p_message text, p_action_url text, p_payload jsonb, p_due_at timestamptz DEFAULT now()) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_notification uuid;
BEGIN
  INSERT INTO public.ca_commerce_notices (user_id, dedupe_key, kind, title, message, action_url, payload, due_at)
  VALUES (p_user_id, p_dedupe_key, p_kind, p_title, p_message, p_action_url, p_payload, p_due_at)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN (SELECT id FROM public.ca_commerce_notices WHERE dedupe_key = p_dedupe_key);
  END IF;
  IF p_due_at <= now() THEN
    INSERT INTO public.notifications (user_id, type, title, message, data, action_url, read)
    VALUES (p_user_id, p_kind, p_title, p_message, p_payload, p_action_url, false)
    RETURNING id INTO v_notification;
    UPDATE public.ca_commerce_notices SET notification_id = v_notification, delivered_at = now() WHERE id = v_id;
  END IF;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Trial activation (R2 section 2.1, 2.4, 2.5).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_activate_trial_impl(p_scope_kind text, p_scope_id uuid, p_actor uuid, p_cohort text, p_start timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner uuid;
  v_settings public.ca_commerce_settings;
  v_trial public.ca_commerce_trials;
  v_existing public.ca_commerce_trials;
  v_created boolean := false;
  v_enrolled boolean := false;
  v_reason text;
BEGIN
  IF p_scope_kind NOT IN ('club','union') OR p_scope_id IS NULL THEN
    RAISE EXCEPTION 'A Trial Needs A Club Or Union Scope';
  END IF;
  v_owner := public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'scope_not_found');
  END IF;
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;

  -- Serialize per operator so a double activation returns one grant (D01).
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_trial:' || v_owner::text, 0));

  SELECT * INTO v_existing FROM public.fn_ca_commerce_scope_trial(p_scope_kind, p_scope_id);
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'replay', true, 'trial_id', v_existing.id,
      'trial_start', v_existing.trial_start, 'trial_end', v_existing.trial_end, 'cohort', v_existing.cohort,
      'enrolled', false, 'created', false);
  END IF;

  SELECT * INTO v_trial FROM public.ca_commerce_trials WHERE operator_id = v_owner;
  IF v_trial.id IS NULL THEN
    INSERT INTO public.ca_commerce_trials (operator_id, trial_start, trial_end, policy_version, cohort, activated_by)
    VALUES (v_owner, p_start, p_start + make_interval(hours => v_settings.trial_hours), v_settings.policy_version, p_cohort, p_actor)
    RETURNING * INTO v_trial;
    v_created := true;
    v_reason := 'Initial Operating Trial For This Operator';
  ELSE
    -- A later scope of the same operator inherits the common end time (D47).
    v_reason := 'Scope Enrolled Under The Operator''s Existing Trial; End Time Unchanged';
  END IF;

  INSERT INTO public.ca_commerce_trial_scopes (trial_id, scope_kind, scope_id, enrolled_by, reason)
  VALUES (v_trial.id, p_scope_kind, p_scope_id, p_actor, v_reason);
  v_enrolled := true;
  -- The trial right itself: every included operating service, zero debit,
  -- no Mint movement, ending at the operator's common trial end. A post-trial
  -- renewal authorization attaches to this row (R2 section 4.6).
  INSERT INTO public.ca_commerce_entitlements (scope_kind, scope_id, sku, kind, starts_at, ends_at, source, trial_id, net_paid)
  VALUES (p_scope_kind, p_scope_id, NULL, 'trial_operating', v_trial.trial_start, v_trial.trial_end, 'trial', v_trial.id, 0);

  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('trial_enrolled', p_actor, p_scope_kind, p_scope_id, v_trial.id,
          jsonb_build_object('created', v_created, 'cohort', p_cohort, 'trial_end', v_trial.trial_end, 'reason', v_reason));

  IF v_created THEN
    PERFORM public.fn_ca_commerce_notice(v_owner, 'trial-reminder-21:' || v_trial.id::text, 'club_commerce_trial_reminder',
      'Your Operating Trial Ends In 9 Days',
      'Your Free Operating Month Ends On ' || to_char(v_trial.trial_end AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') || ' Central. Review Diamond Prices Before Then.',
      '/hub/club-arena/' || p_scope_kind || 's/' || p_scope_id::text || '/diamond-costs',
      jsonb_build_object('trial_id', v_trial.id, 'trial_end', v_trial.trial_end), v_trial.trial_start + interval '21 days');
    PERFORM public.fn_ca_commerce_notice(v_owner, 'trial-reminder-27:' || v_trial.id::text, 'club_commerce_trial_reminder',
      'Your Operating Trial Ends In 3 Days',
      'Your Free Operating Month Ends On ' || to_char(v_trial.trial_end AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY HH12:MI AM') || ' Central. Choose Your Capacity To Continue Without Interruption.',
      '/hub/club-arena/' || p_scope_kind || 's/' || p_scope_id::text || '/diamond-costs',
      jsonb_build_object('trial_id', v_trial.id, 'trial_end', v_trial.trial_end), v_trial.trial_start + interval '27 days');
  END IF;

  RETURN jsonb_build_object('success', true, 'replay', false, 'trial_id', v_trial.id,
    'trial_start', v_trial.trial_start, 'trial_end', v_trial.trial_end, 'cohort', v_trial.cohort,
    'enrolled', v_enrolled, 'created', v_created);
END $$;

-- Browser door: the scope owner activates their own trial.
CREATE FUNCTION public.fn_ca_commerce_activate_trial(p_scope_kind text, p_scope_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner_required');
  END IF;
  RETURN public.fn_ca_commerce_activate_trial_impl(p_scope_kind, p_scope_id, v_actor, 'new_operator', now());
END $$;

-- The launch cohort: every existing operator receives the same prospective
-- offer from one recorded effective event (R2 section 10.2). Staff only.
CREATE FUNCTION public.fn_ca_commerce_activate_launch_cohort(p_effective_at timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row record;
  v_enrolled integer := 0;
  v_created integer := 0;
  v_result jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF p_effective_at < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cohort_must_be_prospective');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_launch_cohort', 0));
  UPDATE public.ca_commerce_settings SET launch_cohort_activated_at = COALESCE(launch_cohort_activated_at, p_effective_at), updated_at = now() WHERE id = 1;
  FOR v_row IN
    SELECT 'club'::text AS scope_kind, c.id AS scope_id FROM public.clubs c
     WHERE c.owner_id IS NOT NULL AND COALESCE(c.lifecycle_status, 'active') <> 'retired' AND COALESCE(c.is_platform, false) = false
    UNION ALL
    SELECT 'union', u.id FROM public.unions u WHERE u.owner_id IS NOT NULL
  LOOP
    v_result := public.fn_ca_commerce_activate_trial_impl(v_row.scope_kind, v_row.scope_id, v_actor, 'launch_cohort', p_effective_at);
    IF (v_result->>'enrolled')::boolean THEN v_enrolled := v_enrolled + 1; END IF;
    IF (v_result->>'created')::boolean THEN v_created := v_created + 1; END IF;
  END LOOP;
  INSERT INTO public.ca_commerce_events (kind, actor_id, detail)
  VALUES ('launch_cohort_activated', v_actor, jsonb_build_object('effective_at', p_effective_at, 'scopes_enrolled', v_enrolled, 'trials_created', v_created));
  RETURN jsonb_build_object('success', true, 'effective_at', p_effective_at, 'scopes_enrolled', v_enrolled, 'trials_created', v_created);
END $$;

-- ---------------------------------------------------------------------------
-- 9. Catalog and scope status reads.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_catalog(p_scope_kind text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'catalog_version', public.fn_ca_commerce_catalog_version(),
    'catalog_visible', (SELECT catalog_visible FROM public.ca_commerce_settings WHERE id = 1),
    'checkout_enabled', (SELECT checkout_enabled FROM public.ca_commerce_settings WHERE id = 1),
    'nominal_cents_per_diamond', 1,
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'sku', p.sku, 'title', p.title, 'kind', p.kind, 'scope_kind', p.scope_kind,
        'term_kind', p.term_kind, 'term_hours', p.term_hours, 'report_days', p.report_days,
        'capacity', p.capacity, 'quantity_unit', p.quantity_unit, 'supported', p.supported,
        'included_note', p.included_note,
        'price', CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object(
          'price_version_id', v.id, 'version', v.version, 'diamonds', v.diamonds, 'price_rule', v.price_rule,
          'cap_diamonds', v.cap_diamonds, 'price_authority', v.price_authority,
          'comparison_verified', v.comparison_verified, 'effective_from', v.effective_from) END
      ) ORDER BY p.sort_order, p.sku)
      FROM public.ca_commerce_products p
      LEFT JOIN public.ca_commerce_price_versions v
        ON v.sku = p.sku AND v.status = 'published' AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now())
      WHERE p_scope_kind IS NULL OR p.scope_kind = p_scope_kind
    ), '[]'::jsonb)
  )
$$;

CREATE FUNCTION public.fn_ca_commerce_scope_status(p_scope_kind text, p_scope_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_trial public.ca_commerce_trials;
  v_owner uuid;
  v_settings public.ca_commerce_settings;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  v_role := public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor);
  IF v_role = 'none' AND NOT public.fn_is_platform_admin() THEN
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
        'renewal', (SELECT jsonb_build_object('mandate_id', m.id, 'state', m.state, 'max_diamonds', m.max_diamonds,
                       'due_at', m.due_at, 'payer_id', m.payer_id, 'last_result', m.last_result)
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
      JOIN public.clubs c ON c.id = p_scope_id AND c.union_id = s.union_id
      WHERE s.state = 'active' AND (s.club_id IS NULL OR s.club_id = p_scope_id)
        AND s.effective_from <= now() AND (s.effective_to IS NULL OR s.effective_to > now())), '[]'::jsonb) END,
    'balance', CASE WHEN v_role = 'owner' THEN (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = v_actor) END
  );
END $$;

-- ---------------------------------------------------------------------------
-- 10. Quote (R2 section 3.1). The browser sends selection; the server prices.
-- Lines: [{"sku":"capacity_100","quantity":1,"starts_at":null}]
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_quote_impl(p_actor uuid, p_payer uuid, p_scope_kind text, p_scope_id uuid, p_lines jsonb, p_sponsorship_id uuid, p_renewal_max integer, p_purchase_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings public.ca_commerce_settings;
  v_line jsonb;
  v_product public.ca_commerce_products;
  v_price public.ca_commerce_price_versions;
  v_quantity integer;
  v_gross integer;
  v_credit integer;
  v_starts timestamptz;
  v_ends timestamptz;
  v_out jsonb := '[]'::jsonb;
  v_weights integer[] := '{}';
  v_grosses integer[] := '{}';
  v_credits integer[] := '{}';
  v_waivers integer[];
  v_total_gross integer := 0;
  v_total_credit integer := 0;
  v_total_waiver integer := 0;
  v_in_trial boolean;
  v_trial public.ca_commerce_trials;
  v_replaces uuid;
  v_old public.ca_commerce_entitlements;
  v_quote public.ca_commerce_quotes;
  v_i integer := 0;
  v_ctx text;
  v_basket text;
  v_now timestamptz := now();
  v_line_count integer;
  v_seen_kinds text[] := '{}';
  v_roster integer;
  v_sponsorship public.ca_commerce_sponsorships;
  v_upgrade_seen boolean := false;
BEGIN
  IF p_scope_kind NOT IN ('club','union') OR p_scope_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_scope');
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;
  v_line_count := jsonb_array_length(p_lines);
  IF v_line_count < 1 OR v_line_count > 12 THEN
    RETURN jsonb_build_object('success', false, 'error', 'basket_size');
  END IF;
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  IF NOT v_settings.checkout_enabled THEN
    RETURN jsonb_build_object('success', false, 'error', 'checkout_disabled');
  END IF;
  IF public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'scope_not_found');
  END IF;
  IF p_sponsorship_id IS NOT NULL THEN
    SELECT * INTO v_sponsorship FROM public.ca_commerce_sponsorships WHERE id = p_sponsorship_id;
    IF v_sponsorship.id IS NULL OR v_sponsorship.state <> 'active' OR v_sponsorship.payer_id <> p_payer
       OR v_sponsorship.effective_from > v_now OR (v_sponsorship.effective_to IS NOT NULL AND v_sponsorship.effective_to <= v_now)
       OR p_scope_kind <> 'club' OR (v_sponsorship.club_id IS NOT NULL AND v_sponsorship.club_id <> p_scope_id)
       OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_scope_id AND c.union_id = v_sponsorship.union_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'sponsorship_not_effective');
    END IF;
  END IF;

  SELECT * INTO v_trial FROM public.fn_ca_commerce_scope_trial(p_scope_kind, p_scope_id);
  v_in_trial := v_trial.id IS NOT NULL AND v_now >= v_trial.trial_start AND v_now < v_trial.trial_end;
  IF p_scope_kind = 'club' THEN v_roster := public.fn_ca_commerce_roster_count(p_scope_id); END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_i := v_i + 1;
    v_old := NULL;
    SELECT * INTO v_product FROM public.ca_commerce_products WHERE sku = v_line->>'sku';
    IF v_product.sku IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_sku', 'line', v_i);
    END IF;
    IF NOT v_product.supported THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_not_available', 'sku', v_product.sku, 'line', v_i);
    END IF;
    IF v_product.scope_kind <> p_scope_kind THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_scope_mismatch', 'sku', v_product.sku, 'line', v_i);
    END IF;
    IF v_product.kind = ANY (v_seen_kinds) THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_line', 'sku', v_product.sku, 'line', v_i);
    END IF;
    v_seen_kinds := v_seen_kinds || v_product.kind;
    SELECT * INTO v_price FROM public.ca_commerce_price_versions v
     WHERE v.sku = v_product.sku AND v.status = 'published' AND v.effective_from <= v_now AND (v.effective_to IS NULL OR v.effective_to > v_now);
    IF v_price.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_published_price', 'sku', v_product.sku, 'line', v_i);
    END IF;

    v_quantity := COALESCE((v_line->>'quantity')::integer, 1);
    IF v_product.quantity_unit = 'flat' AND v_quantity <> 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'quantity_not_allowed', 'sku', v_product.sku, 'line', v_i);
    END IF;
    IF v_product.quantity_unit = 'covered_club' THEN
      IF v_quantity < 1 OR v_quantity > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'quantity_out_of_range', 'sku', v_product.sku, 'line', v_i);
      END IF;
    END IF;
    IF v_product.term_kind <> 'period' THEN
      RETURN jsonb_build_object('success', false, 'error', 'term_not_supported_yet', 'sku', v_product.sku, 'line', v_i);
    END IF;

    v_gross := public.fn_ca_commerce_line_gross(v_price, v_quantity);
    v_credit := 0;
    v_replaces := NULL;

    -- Period placement: a renewal or first purchase begins at the later of
    -- now, the trial end and the end of the current effective right of the
    -- same kind. An upgrade replaces the current right from now and credits
    -- its unused whole-diamond remainder (R2 section 4.4).
    SELECT * INTO v_old FROM public.ca_commerce_entitlements e
     WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.kind = v_product.kind
       AND e.state = 'effective' AND e.ends_at IS NOT NULL AND e.ends_at > v_now
     ORDER BY e.ends_at DESC LIMIT 1;

    IF p_purchase_kind = 'upgrade' THEN
      IF v_old.id IS NULL OR v_old.starts_at > v_now THEN
        RETURN jsonb_build_object('success', false, 'error', 'nothing_to_upgrade', 'sku', v_product.sku, 'line', v_i);
      END IF;
      IF v_old.sku = v_product.sku AND v_old.quantity = v_quantity THEN
        RETURN jsonb_build_object('success', false, 'error', 'same_capacity', 'sku', v_product.sku, 'line', v_i);
      END IF;
      IF v_product.kind = 'capacity' AND v_product.capacity < v_old.capacity THEN
        RETURN jsonb_build_object('success', false, 'error', 'downgrade_applies_at_next_period', 'sku', v_product.sku, 'line', v_i);
      END IF;
      v_replaces := v_old.id;
      v_starts := v_now;
      v_ends := v_old.ends_at;
      -- Unused remainder of the actual net paid right, exact rational time,
      -- floored to whole diamonds so residues never manufacture value.
      v_credit := floor((v_old.value_basis::numeric * extract(epoch FROM (v_old.ends_at - v_now))) / extract(epoch FROM (v_old.ends_at - v_old.starts_at)))::integer;
      -- The new line covers only the remaining time of a full term: the new
      -- list price prorated over the product's own term length, ceiling so a
      -- rounding residue is never free capacity.
      v_gross := ceil((v_gross::numeric * extract(epoch FROM (v_old.ends_at - v_now))) / (v_product.term_hours * 3600)::numeric)::integer;
      v_credit := LEAST(v_credit, v_gross);
      v_upgrade_seen := true;
    ELSE
      -- A first purchase starts now (or at the trial end while the trial is
      -- running). A renewal starts exactly where the current right ends, and
      -- a renewal inside the accepted lateness window keeps the period
      -- continuous (D51: no gap). Beyond that window a new period starts now.
      v_starts := v_now;
      IF v_in_trial THEN v_starts := v_trial.trial_end; END IF;
      -- Continuity is the renewal consumer's contract: an automatic renewal
      -- executed inside the accepted lateness window starts exactly where the
      -- trial or the previous period ended. A manual purchase after a lapse
      -- starts now; nobody pays for hours already gone.
      IF p_purchase_kind = 'renewal' AND v_trial.id IS NOT NULL AND v_trial.trial_end <= v_now
         AND v_trial.trial_end > v_now - make_interval(hours => v_settings.renewal_lateness_hours) THEN
        v_starts := v_trial.trial_end;
      END IF;
      IF v_old.id IS NOT NULL THEN v_starts := GREATEST(v_starts, v_old.ends_at); END IF;
      IF v_old.id IS NULL AND p_purchase_kind = 'renewal' THEN
        SELECT * INTO v_old FROM public.ca_commerce_entitlements e
         WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.kind = v_product.kind
           AND e.state = 'effective' AND e.ends_at IS NOT NULL AND e.ends_at <= v_now
           AND e.ends_at > v_now - make_interval(hours => v_settings.renewal_lateness_hours)
         ORDER BY e.ends_at DESC LIMIT 1;
        IF v_old.id IS NOT NULL AND NOT v_in_trial THEN v_starts := v_old.ends_at; END IF;
        v_old := NULL;
      END IF;
      v_ends := v_starts + make_interval(hours => v_product.term_hours);
    END IF;

    IF v_product.kind = 'capacity' AND v_roster IS NOT NULL AND v_roster > v_product.capacity THEN
      RETURN jsonb_build_object('success', false, 'error', 'roster_exceeds_capacity', 'sku', v_product.sku, 'line', v_i,
        'roster_count', v_roster, 'capacity', v_product.capacity);
    END IF;

    v_grosses := v_grosses || v_gross;
    v_credits := v_credits || v_credit;
    v_weights := v_weights || (v_gross - v_credit);
    v_total_gross := v_total_gross + v_gross;
    v_total_credit := v_total_credit + v_credit;
    v_out := v_out || jsonb_build_object(
      'index', v_i - 1, 'sku', v_product.sku, 'kind', v_product.kind, 'title', v_product.title,
      'price_version_id', v_price.id, 'price_version', v_price.version, 'unit_diamonds', v_price.diamonds,
      'price_rule', v_price.price_rule, 'quantity', v_quantity, 'capacity', v_product.capacity,
      'term_hours', v_product.term_hours, 'starts_at', v_starts, 'ends_at', v_ends,
      'gross', v_gross, 'credit', v_credit, 'comparison_adjustment', 0, 'waiver', 0, 'net', v_gross - v_credit,
      'replaces_entitlement_id', v_replaces, 'included_note', v_product.included_note,
      'comparison_verified', v_price.comparison_verified);
  END LOOP;

  -- Trial waiver: under the recommended contract every included operating
  -- service is usable during the trial without a purchase (the admission
  -- policy answers 'trial'), and a paid period begins no earlier than the
  -- trial end. A purchase made inside the trial is therefore scheduled at
  -- the trial end with nothing waived; the waiver columns stay at zero and
  -- exist so a future waived line is recorded, never silently discounted.
  v_waivers := array_fill(0, ARRAY[v_line_count]);
  FOR v_i IN 1 .. v_line_count LOOP
    v_out := jsonb_set(v_out, ARRAY[(v_i - 1)::text, 'waiver'], to_jsonb(v_waivers[v_i]));
    v_out := jsonb_set(v_out, ARRAY[(v_i - 1)::text, 'net'], to_jsonb(v_grosses[v_i] - v_credits[v_i] - v_waivers[v_i]));
  END LOOP;

  v_basket := md5(p_scope_kind || ':' || p_scope_id::text || ':' || p_payer::text || ':' || COALESCE(p_sponsorship_id::text, '') || ':' || p_purchase_kind || ':' || v_out::text);
  v_ctx := md5(COALESCE(public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id)::text, '') || ':' || public.fn_ca_commerce_catalog_version()
              || ':' || COALESCE(v_trial.trial_end::text, '') || ':' || COALESCE((SELECT string_agg(e.id::text, ',' ORDER BY e.id) FROM public.ca_commerce_entitlements e WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.state = 'effective' AND (e.ends_at IS NULL OR e.ends_at > v_now)), ''));

  INSERT INTO public.ca_commerce_quotes (actor_id, payer_id, scope_kind, scope_id, sponsorship_id, lines, basket_hash, context_hash, catalog_version,
    gross, credits, comparison_adjustment, trial_waiver, net, trial_id, renewal_max_diamonds, expires_at)
  VALUES (p_actor, p_payer, p_scope_kind, p_scope_id, p_sponsorship_id, v_out, v_basket, v_ctx, public.fn_ca_commerce_catalog_version(),
    v_total_gross, v_total_credit, 0, v_total_waiver, v_total_gross - v_total_credit - v_total_waiver, v_trial.id, p_renewal_max, v_now + v_settings.quote_ttl)
  RETURNING * INTO v_quote;

  RETURN jsonb_build_object('success', true, 'quote_id', v_quote.id, 'expires_at', v_quote.expires_at,
    'catalog_version', v_quote.catalog_version, 'payer_id', p_payer, 'sponsorship_id', p_sponsorship_id,
    'purchase_kind', p_purchase_kind, 'lines', v_out,
    'gross', v_quote.gross, 'credits', v_quote.credits, 'comparison_adjustment', 0, 'trial_waiver', v_quote.trial_waiver, 'net', v_quote.net,
    'nominal_cents', v_quote.net, 'trial_active', v_in_trial, 'trial_end', v_trial.trial_end,
    'available_balance', (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = p_payer),
    'renewal_max_diamonds', p_renewal_max);
END $$;

-- Browser door: the actor quotes for a scope they own (payer = self) or, as
-- the union owner, for a covered club under their own sponsorship.
CREATE FUNCTION public.fn_ca_commerce_quote(p_scope_kind text, p_scope_id uuid, p_lines jsonb, p_sponsorship_id uuid DEFAULT NULL, p_renewal_max_diamonds integer DEFAULT NULL, p_purchase_kind text DEFAULT 'purchase') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
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
  RETURN public.fn_ca_commerce_quote_impl(v_actor, v_actor, p_scope_kind, p_scope_id, p_lines, p_sponsorship_id, p_renewal_max_diamonds, p_purchase_kind);
END $$;

-- ---------------------------------------------------------------------------
-- 11. Atomic purchase with strict accounting postconditions (R2 sections 1.3,
-- 3.2, 3.3). Three independent duplicate barriers: request identity
-- (actor, request_key), quote consumption (quotes.purchase_id / purchases.
-- quote_id UNIQUE) and business identity (entitlement period identity index
-- plus the overlap check under the scope advisory lock).
-- ---------------------------------------------------------------------------
-- Receipt contract (R2 section 3.3): original total and the debit of this
-- attempt are separate; a replay charges zero and never labels the original
-- purchase free.
CREATE FUNCTION public.fn_ca_commerce_receipt_json(p_purchase public.ca_commerce_purchases, p_replay boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'success', true,
    'purchase_id', p_purchase.id,
    'quote_id', p_purchase.quote_id,
    'is_replay', p_replay,
    'original_total_diamonds', p_purchase.net,
    'original_gross_diamonds', p_purchase.gross,
    'trial_waiver', p_purchase.trial_waiver,
    'charged_this_attempt', CASE WHEN p_replay THEN 0 ELSE p_purchase.net END,
    'payer_id', p_purchase.payer_id,
    'scope_kind', p_purchase.scope_kind, 'scope_id', p_purchase.scope_id,
    'kind', p_purchase.kind,
    'diamond_tx_id', p_purchase.diamond_tx_id,
    'mint_op_id', p_purchase.mint_op_id,
    'catalog_version', p_purchase.catalog_version,
    'delivery_status', 'delivered',
    'entitlement_status', 'effective',
    'committed_at', p_purchase.created_at,
    'lines', p_purchase.lines
  )
$$;

CREATE FUNCTION public.fn_ca_commerce_purchase_impl(p_actor uuid, p_quote_id uuid, p_request_key text, p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings public.ca_commerce_settings;
  v_quote public.ca_commerce_quotes;
  v_existing public.ca_commerce_purchases;
  v_purchase public.ca_commerce_purchases;
  v_purchase_id uuid := gen_random_uuid();
  v_request_hash text;
  v_now timestamptz := now();
  v_trial public.ca_commerce_trials;
  v_ctx text;
  v_line jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_ent public.ca_commerce_entitlements;
  v_old public.ca_commerce_entitlements;
  v_before jsonb;
  v_after jsonb;
  v_expected_purchased integer;
  v_actual_purchased integer;
  v_available_purchased integer;
  v_balance integer;
  v_deduct jsonb;
  v_tx public.diamond_transactions;
  v_mint public.ca_mint_ledger;
  v_alloc jsonb := '[]'::jsonb;
  v_sponsorship public.ca_commerce_sponsorships;
  v_club_committed integer;
  v_ref text;
  v_owner uuid;
  v_mandate_id uuid;
  v_receipt_url text;
BEGIN
  IF p_request_key IS NULL OR length(p_request_key) < 8 OR length(p_request_key) > 200 THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_key_required');
  END IF;
  v_request_hash := md5(COALESCE(p_quote_id::text, '') || ':' || p_kind);

  -- Barrier 1: request identity. Same key and payload replays the receipt;
  -- same key with a different payload refuses (D04, D05).
  SELECT * INTO v_existing FROM public.ca_commerce_purchases WHERE actor_id = p_actor AND request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.request_hash <> v_request_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN public.fn_ca_commerce_receipt_json(v_existing, true);
  END IF;

  SELECT * INTO v_quote FROM public.ca_commerce_quotes WHERE id = p_quote_id FOR UPDATE;
  IF v_quote.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_not_found');
  END IF;
  IF v_quote.actor_id <> p_actor THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_belongs_to_another_actor');
  END IF;
  -- Barrier 2: quote consumption. A consumed quote returns its purchase only
  -- to the same actor and never charges again (D31).
  IF v_quote.status = 'consumed' THEN
    SELECT * INTO v_existing FROM public.ca_commerce_purchases WHERE id = v_quote.purchase_id;
    RETURN public.fn_ca_commerce_receipt_json(v_existing, true);
  END IF;
  IF v_quote.status <> 'open' OR v_quote.expires_at <= v_now THEN
    IF v_quote.status = 'open' THEN
      UPDATE public.ca_commerce_quotes SET status = 'expired' WHERE id = v_quote.id;
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'quote_expired', 'requote', true);
  END IF;

  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  IF NOT v_settings.checkout_enabled THEN
    RETURN jsonb_build_object('success', false, 'error', 'checkout_disabled');
  END IF;

  -- Serialize every commerce writer for this scope (barrier 3; the overlap
  -- predicate below is only valid under this lock).
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || v_quote.scope_kind || ':' || v_quote.scope_id::text, 0));

  -- Recheck material context: owner, catalog, trial end and effective rights.
  v_owner := public.fn_ca_commerce_scope_owner(v_quote.scope_kind, v_quote.scope_id);
  SELECT * INTO v_trial FROM public.fn_ca_commerce_scope_trial(v_quote.scope_kind, v_quote.scope_id);
  v_ctx := md5(COALESCE(v_owner::text, '') || ':' || public.fn_ca_commerce_catalog_version()
              || ':' || COALESCE(v_trial.trial_end::text, '') || ':' || COALESCE((SELECT string_agg(e.id::text, ',' ORDER BY e.id) FROM public.ca_commerce_entitlements e WHERE e.scope_kind = v_quote.scope_kind AND e.scope_id = v_quote.scope_id AND e.state = 'effective' AND (e.ends_at IS NULL OR e.ends_at > v_now)), ''));
  IF v_ctx <> v_quote.context_hash THEN
    UPDATE public.ca_commerce_quotes SET status = 'withdrawn' WHERE id = v_quote.id;
    RETURN jsonb_build_object('success', false, 'error', 'context_changed', 'requote', true);
  END IF;
  IF v_quote.sponsorship_id IS NULL AND v_owner <> v_quote.payer_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'payer_no_longer_owner', 'requote', true);
  END IF;
  -- No operator-service debit before its paid period begins (R2 section
  -- 4.6): inside the trial the owner records a post-trial authorization
  -- instead, and the renewal consumer buys the first period at trial end.
  IF v_quote.net > 0 AND v_trial.id IS NOT NULL AND v_now >= v_trial.trial_start AND v_now < v_trial.trial_end THEN
    RETURN jsonb_build_object('success', false, 'error', 'trial_active_authorize_instead', 'trial_end', v_trial.trial_end);
  END IF;
  -- The canonical self-payer guard inside deduct_diamonds needs the payer's
  -- own session or the trusted service route. Say so before any write.
  IF v_quote.net > 0 AND COALESCE(auth.role(), '') <> 'service_role' AND auth.uid() IS DISTINCT FROM v_quote.payer_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'sponsor_route_required');
  END IF;

  -- Sponsorship budget under its row lock (D43, D44).
  IF v_quote.sponsorship_id IS NOT NULL THEN
    SELECT * INTO v_sponsorship FROM public.ca_commerce_sponsorships WHERE id = v_quote.sponsorship_id FOR UPDATE;
    IF v_sponsorship.state <> 'active' OR v_sponsorship.payer_id <> v_quote.payer_id
       OR v_sponsorship.effective_from > v_now OR (v_sponsorship.effective_to IS NOT NULL AND v_sponsorship.effective_to <= v_now)
       OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_quote.scope_id AND c.union_id = v_sponsorship.union_id)
       OR (v_sponsorship.club_id IS NOT NULL AND v_sponsorship.club_id <> v_quote.scope_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'sponsorship_not_effective');
    END IF;
    IF v_sponsorship.committed + v_quote.net > v_sponsorship.total_budget THEN
      RETURN jsonb_build_object('success', false, 'error', 'sponsorship_budget_exceeded', 'remaining', v_sponsorship.total_budget - v_sponsorship.committed);
    END IF;
    IF v_sponsorship.per_club_budget IS NOT NULL THEN
      SELECT COALESCE(SUM(p.net), 0)::integer INTO v_club_committed FROM public.ca_commerce_purchases p
       WHERE p.sponsorship_id = v_sponsorship.id AND p.scope_id = v_quote.scope_id;
      IF v_club_committed + v_quote.net > v_sponsorship.per_club_budget THEN
        RETURN jsonb_build_object('success', false, 'error', 'sponsorship_club_budget_exceeded', 'remaining', v_sponsorship.per_club_budget - v_club_committed);
      END IF;
    END IF;
  END IF;

  -- Business identity: no overlapping effective right of the same kind
  -- except the one an upgrade replaces (D32).
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_quote.lines) LOOP
    IF EXISTS (
      SELECT 1 FROM public.ca_commerce_entitlements e
       WHERE e.scope_kind = v_quote.scope_kind AND e.scope_id = v_quote.scope_id AND e.kind = v_line->>'kind'
         AND e.state = 'effective' AND e.ends_at IS NOT NULL
         AND e.id IS DISTINCT FROM NULLIF(v_line->>'replaces_entitlement_id', '')::uuid
         AND tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange((v_line->>'starts_at')::timestamptz, (v_line->>'ends_at')::timestamptz, '[)')
    ) THEN
      UPDATE public.ca_commerce_quotes SET status = 'withdrawn' WHERE id = v_quote.id;
      RETURN jsonb_build_object('success', false, 'error', 'period_already_covered', 'requote', true);
    END IF;
  END LOOP;

  IF v_quote.net > 0 THEN
    v_ref := 'ca-commerce:' || v_purchase_id::text;
    -- The payer's wallet row is the lock every canonical writer takes first;
    -- holding it here makes the before/after lot snapshots this operation's
    -- own evidence (R2-A03) and places it after the scope and sponsorship
    -- locks in the documented order.
    PERFORM 1 FROM public.profiles p WHERE p.id = v_quote.payer_id FOR UPDATE;
    v_before := public.fn_ca_commerce_lot_snapshot(v_quote.payer_id);
    SELECT COALESCE(SUM((l->>'available')::bigint), 0)::integer INTO v_available_purchased FROM jsonb_array_elements(v_before) l;
    v_expected_purchased := LEAST(v_quote.net, GREATEST(v_available_purchased, 0));

    v_deduct := public.deduct_diamonds(v_quote.payer_id, v_quote.net,
      'Club And Union Diamond Costs: ' || v_quote.scope_kind || ' ' || v_quote.scope_id::text,
      'club_commerce', 'club_commerce',
      jsonb_build_object('purchase_id', v_purchase_id, 'quote_id', v_quote.id, 'scope_kind', v_quote.scope_kind, 'scope_id', v_quote.scope_id, 'kind', p_kind),
      v_ref, 0);
    IF NOT COALESCE((v_deduct->>'success')::boolean, false) THEN
      IF v_deduct->>'error' = 'Insufficient diamonds' THEN
        RAISE EXCEPTION 'CA_COMMERCE_INSUFFICIENT_DIAMONDS' USING DETAIL = COALESCE(v_deduct->>'balance', '0');
      END IF;
      RAISE EXCEPTION 'CA_COMMERCE_DEBIT_REFUSED' USING DETAIL = COALESCE(v_deduct->>'error', 'unknown');
    END IF;
    IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
      RAISE EXCEPTION 'CA_COMMERCE_DEBIT_REFERENCE_REUSED' USING DETAIL = v_ref;
    END IF;

    -- Postcondition 1: the journal row for this operation, exact amount and class.
    SELECT * INTO v_tx FROM public.diamond_transactions t WHERE t.user_id = v_quote.payer_id AND t.reference_id = v_ref;
    IF v_tx.id IS NULL OR v_tx.amount <> -v_quote.net OR v_tx.issuance_class <> 'spend' OR v_tx.counterparty <> 'revenue:club_commerce' THEN
      RAISE EXCEPTION 'CA_COMMERCE_JOURNAL_UNPROVED' USING DETAIL = v_ref;
    END IF;
    -- Postcondition 2: the exact linked Mint retirement (R2-A04). The helper
    -- can swallow its own failure; the row is what counts.
    SELECT * INTO v_mint FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = v_tx.id;
    IF v_mint.id IS NULL OR v_mint.action <> 'burn' OR v_mint.asset <> 'diamonds' OR v_mint.amount <> v_quote.net
       OR v_mint.holder_id IS DISTINCT FROM v_quote.payer_id THEN
      RAISE EXCEPTION 'CA_COMMERCE_REGISTER_UNPROVED' USING DETAIL = v_ref;
    END IF;
    -- Postcondition 3: persisted purchased-lot deltas equal the expected
    -- split (R2-A03). The helper's accumulator is not evidence.
    v_after := public.fn_ca_commerce_lot_snapshot(v_quote.payer_id);
    SELECT COALESCE(SUM((a->>'consumed')::bigint - (b->>'consumed')::bigint), 0)::integer,
           COALESCE(jsonb_agg(jsonb_build_object('lot_id', a->>'lot_id', 'consumed_delta', (a->>'consumed')::bigint - (b->>'consumed')::bigint)) FILTER (WHERE (a->>'consumed')::bigint <> (b->>'consumed')::bigint), '[]'::jsonb)
      INTO v_actual_purchased, v_alloc
      FROM jsonb_array_elements(v_after) a JOIN jsonb_array_elements(v_before) b ON a->>'lot_id' = b->>'lot_id';
    IF v_actual_purchased <> v_expected_purchased THEN
      RAISE EXCEPTION 'CA_COMMERCE_LOTS_UNPROVED' USING DETAIL = format('expected %s consumed %s', v_expected_purchased, v_actual_purchased);
    END IF;
    v_balance := (v_deduct->>'balance')::integer;

    IF v_quote.sponsorship_id IS NOT NULL THEN
      UPDATE public.ca_commerce_sponsorships SET committed = committed + v_quote.net WHERE id = v_quote.sponsorship_id;
    END IF;
  END IF;

  -- The receipt, written once with its proven accounting identities.
  INSERT INTO public.ca_commerce_purchases (id, quote_id, actor_id, payer_id, request_key, request_hash, scope_kind, scope_id, sponsorship_id, kind,
    gross, net, trial_waiver, lines, diamond_tx_id, mint_op_id, lot_allocation, catalog_version, policy_version)
  VALUES (v_purchase_id, v_quote.id, p_actor, v_quote.payer_id, p_request_key, v_request_hash, v_quote.scope_kind, v_quote.scope_id, v_quote.sponsorship_id, p_kind,
    v_quote.gross, v_quote.net, v_quote.trial_waiver, v_quote.lines, v_tx.id, v_mint.op_id, v_alloc, v_quote.catalog_version, v_settings.policy_version)
  RETURNING * INTO v_purchase;

  -- Rights.
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_quote.lines) LOOP
    v_old := NULL;
    v_mandate_id := NULL;
    IF NULLIF(v_line->>'replaces_entitlement_id', '') IS NOT NULL THEN
      SELECT * INTO v_old FROM public.ca_commerce_entitlements WHERE id = (v_line->>'replaces_entitlement_id')::uuid FOR UPDATE;
      IF v_old.id IS NULL OR v_old.state <> 'effective' THEN
        RAISE EXCEPTION 'CA_COMMERCE_UPGRADE_TARGET_GONE';
      END IF;
    END IF;
    INSERT INTO public.ca_commerce_entitlements (scope_kind, scope_id, sku, kind, capacity, quantity, starts_at, ends_at, source, purchase_id, line_index, net_paid, value_basis, revision)
    VALUES (v_quote.scope_kind, v_quote.scope_id, v_line->>'sku', v_line->>'kind', NULLIF(v_line->>'capacity', '')::integer,
            COALESCE((v_line->>'quantity')::integer, 1), (v_line->>'starts_at')::timestamptz, (v_line->>'ends_at')::timestamptz,
            CASE WHEN v_quote.sponsorship_id IS NULL THEN 'purchase' ELSE 'sponsor' END, v_purchase.id, (v_line->>'index')::integer,
            (v_line->>'net')::integer, (v_line->>'net')::integer + (v_line->>'credit')::integer,
            CASE WHEN v_old.id IS NULL THEN 1 ELSE v_old.revision + 1 END)
    RETURNING * INTO v_ent;
    IF v_old.id IS NOT NULL THEN
      -- The replaced right ends at the quoted switch instant so the two
      -- periods abut exactly: no overlap, no gap, no double coverage.
      UPDATE public.ca_commerce_entitlements SET state = 'superseded', superseded_by = v_ent.id, ends_at = v_ent.starts_at, updated_at = v_now WHERE id = v_old.id;
      -- A mandate on the replaced right follows the replacement at the same ceiling.
      UPDATE public.ca_commerce_renewal_mandates SET entitlement_id = v_ent.id, sku = v_ent.sku, quantity = v_ent.quantity, due_at = v_ent.ends_at, updated_at = v_now
       WHERE entitlement_id = v_old.id AND state = 'authorized';
    END IF;
    IF v_quote.renewal_max_diamonds IS NOT NULL AND v_quote.sponsorship_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.ca_commerce_renewal_mandates m WHERE m.entitlement_id = v_ent.id) THEN
      INSERT INTO public.ca_commerce_renewal_mandates (entitlement_id, scope_kind, scope_id, payer_id, sku, quantity, max_diamonds, due_at, accepted_by)
      VALUES (v_ent.id, v_quote.scope_kind, v_quote.scope_id, v_quote.payer_id, v_ent.sku, v_ent.quantity, v_quote.renewal_max_diamonds, v_ent.ends_at, p_actor)
      RETURNING id INTO v_mandate_id;
    END IF;
    v_lines := v_lines || (v_line || jsonb_build_object('entitlement_id', v_ent.id, 'mandate_id', v_mandate_id));
  END LOOP;

  UPDATE public.ca_commerce_quotes SET status = 'consumed', purchase_id = v_purchase.id WHERE id = v_quote.id;

  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('purchase_committed', p_actor, v_quote.scope_kind, v_quote.scope_id, v_purchase.id,
          jsonb_build_object('net', v_quote.net, 'gross', v_quote.gross, 'kind', p_kind, 'payer_id', v_quote.payer_id, 'diamond_tx_id', v_purchase.diamond_tx_id));

  v_receipt_url := '/hub/club-arena/' || v_quote.scope_kind || 's/' || v_quote.scope_id::text || '/diamond-costs';
  PERFORM public.fn_ca_commerce_notice(v_quote.payer_id, 'receipt:' || v_purchase.id::text, 'club_commerce_receipt',
    'Diamond Receipt: ' || v_quote.net::text || ' Diamonds',
    CASE WHEN v_quote.net = 0 THEN 'No Diamonds Were Charged For This Order.' ELSE v_quote.net::text || ' Diamonds Were Charged For Club And Union Services.' END,
    v_receipt_url, jsonb_build_object('purchase_id', v_purchase.id, 'net', v_quote.net));

  RETURN public.fn_ca_commerce_receipt_json(v_purchase, false) || jsonb_build_object('lines', v_lines, 'balance_after', v_balance, 'balance_observed_at', v_now);
END $$;

CREATE FUNCTION public.fn_ca_commerce_purchase(p_quote_id uuid, p_request_key text, p_purchase_kind text DEFAULT 'purchase') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_detail text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_purchase_kind NOT IN ('purchase','upgrade') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_purchase_kind');
  END IF;
  RETURN public.fn_ca_commerce_purchase_impl(v_actor, p_quote_id, p_request_key, p_purchase_kind);
EXCEPTION
  WHEN OTHERS THEN
    -- Every write above rolled back with this exception. Map the boundary's
    -- own refusals to readable copy; anything else stays a raised error.
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM = 'CA_COMMERCE_INSUFFICIENT_DIAMONDS' THEN
      RETURN jsonb_build_object('success', false, 'error', 'insufficient_diamonds', 'balance', v_detail);
    END IF;
    IF SQLERRM LIKE 'CA_COMMERCE_%' THEN
      RETURN jsonb_build_object('success', false, 'error', lower(replace(SQLERRM, 'CA_COMMERCE_', '')), 'detail', v_detail);
    END IF;
    -- A canonical wallet reserve (unsettled Diamond Spin obligations, balance
    -- headroom) refused the debit: the purchase fails whole, the obligation
    -- stands (D07, D08).
    IF SQLSTATE = '23514' THEN
      RETURN jsonb_build_object('success', false, 'error', 'reserved_diamonds', 'detail', SQLERRM);
    END IF;
    RAISE;
END $$;

-- Receipt recovery: the payer or the actor of a committed purchase reads its
-- original receipt, whatever their present club role (D06, D68).
CREATE FUNCTION public.fn_ca_commerce_receipts(p_scope_kind text DEFAULT NULL, p_scope_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(public.fn_ca_commerce_receipt_json(p, true) || jsonb_build_object(
           'refunds', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'line_index', r.line_index, 'gross', r.gross,
                        'debt_settled', r.debt_settled, 'net_increase', r.net_increase, 'reason', r.reason, 'created_at', r.created_at))
                        FROM public.ca_commerce_refunds r WHERE r.purchase_id = p.id), '[]'::jsonb))
           ORDER BY p.created_at DESC), '[]'::jsonb)
    FROM public.ca_commerce_purchases p
   WHERE (p.payer_id = auth.uid() OR p.actor_id = auth.uid())
     AND (p_scope_kind IS NULL OR (p.scope_kind = p_scope_kind AND p.scope_id = p_scope_id))
$$;

-- ---------------------------------------------------------------------------
-- 12. Renewal mandate control (R2 section 4.1, 4.5).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_set_renewal(p_entitlement_id uuid, p_enabled boolean, p_max_diamonds integer DEFAULT NULL, p_sku text DEFAULT NULL, p_quantity integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_ent public.ca_commerce_entitlements;
  v_mandate public.ca_commerce_renewal_mandates;
  v_purchase public.ca_commerce_purchases;
  v_product public.ca_commerce_products;
  v_sku text;
  v_quantity integer;
BEGIN
  IF v_actor IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication_required'); END IF;
  SELECT * INTO v_ent FROM public.ca_commerce_entitlements WHERE id = p_entitlement_id FOR UPDATE;
  IF v_ent.id IS NULL OR v_ent.state <> 'effective' OR v_ent.ends_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'entitlement_not_renewable');
  END IF;
  IF public.fn_ca_commerce_scope_role(v_ent.scope_kind, v_ent.scope_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner_required');
  END IF;
  IF v_ent.source = 'trial' THEN
    -- A post-trial authorization: the owner names the product and ceiling;
    -- the consumer buys the first paid period at the trial end (R2 4.6).
    v_sku := p_sku;
    v_quantity := COALESCE(p_quantity, 1);
    IF v_sku IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'sku_required'); END IF;
  ELSE
    SELECT * INTO v_purchase FROM public.ca_commerce_purchases WHERE id = v_ent.purchase_id;
    -- Only the original payer authorizes their own diamonds; a sponsored
    -- right renews through a new sponsor purchase, never a mandate.
    IF v_purchase.payer_id <> v_actor OR v_purchase.sponsorship_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'payer_required');
    END IF;
    v_sku := COALESCE(p_sku, v_ent.sku);
    v_quantity := COALESCE(p_quantity, v_ent.quantity);
  END IF;
  SELECT * INTO v_product FROM public.ca_commerce_products WHERE sku = v_sku;
  IF v_product.sku IS NULL OR NOT v_product.supported OR v_product.scope_kind <> v_ent.scope_kind OR v_product.term_kind <> 'period' THEN
    RETURN jsonb_build_object('success', false, 'error', 'sku_not_available');
  END IF;
  IF v_quantity < 1 OR v_quantity > 500 OR (v_product.quantity_unit = 'flat' AND v_quantity <> 1) THEN
    RETURN jsonb_build_object('success', false, 'error', 'quantity_out_of_range');
  END IF;
  SELECT * INTO v_mandate FROM public.ca_commerce_renewal_mandates WHERE entitlement_id = v_ent.id AND sku = v_sku FOR UPDATE;
  IF p_enabled THEN
    IF p_max_diamonds IS NULL OR p_max_diamonds < 0 OR p_max_diamonds > 2147483647 THEN
      RETURN jsonb_build_object('success', false, 'error', 'max_diamonds_required');
    END IF;
    IF v_mandate.id IS NULL THEN
      INSERT INTO public.ca_commerce_renewal_mandates (entitlement_id, scope_kind, scope_id, payer_id, sku, quantity, max_diamonds, due_at, accepted_by)
      VALUES (v_ent.id, v_ent.scope_kind, v_ent.scope_id, v_actor, v_sku, v_quantity, p_max_diamonds, v_ent.ends_at, v_actor)
      RETURNING * INTO v_mandate;
    ELSIF v_mandate.state = 'completed' THEN
      RETURN jsonb_build_object('success', false, 'error', 'period_already_renewed');
    ELSE
      UPDATE public.ca_commerce_renewal_mandates
         SET state = 'authorized', max_diamonds = p_max_diamonds, quantity = v_quantity, payer_id = v_actor, accepted_by = v_actor, accepted_at = now(),
             cancelled_at = NULL, cancelled_by = NULL, updated_at = now()
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
  VALUES ('renewal_mandate_' || v_mandate.state, v_actor, v_ent.scope_kind, v_ent.scope_id, v_mandate.id, jsonb_build_object('sku', v_mandate.sku, 'max_diamonds', v_mandate.max_diamonds, 'due_at', v_mandate.due_at));
  RETURN jsonb_build_object('success', true, 'mandate_id', v_mandate.id, 'state', v_mandate.state, 'sku', v_mandate.sku, 'max_diamonds', v_mandate.max_diamonds, 'due_at', v_mandate.due_at);
END $$;

-- Durable due-work claim for the engine's renewal consumer (R2 section 4.2).
CREATE FUNCTION public.fn_ca_commerce_claim_due_renewals(p_lease_token uuid, p_limit integer DEFAULT 10) RETURNS SETOF public.ca_commerce_renewal_mandates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service Role Required';
  END IF;
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

-- One renewal execution under the lease: revalidate authority, price, funds
-- and lateness; extend once or leave a visible attention state (D09, D10,
-- D49, D50).
CREATE FUNCTION public.fn_ca_commerce_execute_renewal(p_mandate_id uuid, p_lease_token uuid) RETURNS jsonb
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

  -- Attention states: ownership moved, the right was revoked or superseded,
  -- or the due period lapsed beyond the accepted lateness treatment.
  IF v_ent.id IS NULL OR v_ent.state <> 'effective' OR v_owner IS DISTINCT FROM v_m.payer_id THEN
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
        -- purchase boundary with the mandate as its request identity.
        v_quote := public.fn_ca_commerce_quote_impl(v_m.payer_id, v_m.payer_id, v_m.scope_kind, v_m.scope_id,
          jsonb_build_array(jsonb_build_object('sku', v_m.sku, 'quantity', v_m.quantity)), NULL, v_m.max_diamonds, 'renewal');
        IF NOT COALESCE((v_quote->>'success')::boolean, false) THEN
          v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', COALESCE(v_quote->>'error', 'quote_failed'), 'at', v_now);
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
    -- ceiling, so a standing renewal keeps standing until cancelled (D09).
    INSERT INTO public.ca_commerce_renewal_mandates (entitlement_id, scope_kind, scope_id, payer_id, sku, quantity, max_diamonds, due_at, accepted_by, accepted_at)
    SELECT e.id, e.scope_kind, e.scope_id, v_m.payer_id, v_m.sku, v_m.quantity, v_m.max_diamonds, e.ends_at, v_m.accepted_by, v_m.accepted_at
      FROM public.ca_commerce_entitlements e
     WHERE e.purchase_id = (v_result->>'purchase_id')::uuid AND e.sku = v_m.sku AND e.state = 'effective'
    ON CONFLICT (entitlement_id, sku) DO NOTHING;
  ELSE
    UPDATE public.ca_commerce_renewal_mandates SET state = 'needs_attention', last_result = v_result, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = v_m.id;
    PERFORM public.fn_ca_commerce_notice(v_m.payer_id, 'renewal-attention:' || v_m.id::text, 'club_commerce_renewal_attention',
      'Renewal Not Completed',
      'Your Diamond Renewal For ' || v_m.sku || ' Was Not Completed (' || replace(COALESCE(v_result->>'reason', 'unknown'), '_', ' ') || '). Current Paid Access Is Unchanged.',
      v_receipt_url, v_result);
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('renewal_' || (v_result->>'outcome'), NULL, v_m.scope_kind, v_m.scope_id, v_m.id, v_result);
  RETURN jsonb_build_object('success', true) || v_result;
END $$;

-- Due notices (trial reminders) delivered by the same consumer.
CREATE FUNCTION public.fn_ca_commerce_deliver_due_notices(p_limit integer DEFAULT 50) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_n public.ca_commerce_notices;
  v_count integer := 0;
  v_notification uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service Role Required';
  END IF;
  FOR v_n IN
    SELECT * FROM public.ca_commerce_notices n WHERE n.delivered_at IS NULL AND n.due_at <= now()
     ORDER BY n.due_at LIMIT GREATEST(1, LEAST(p_limit, 500)) FOR UPDATE SKIP LOCKED
  LOOP
    -- A reminder for a trial that already converted is still true; a
    -- reminder for a cancelled or superseded subject is skipped by its kind.
    INSERT INTO public.notifications (user_id, type, title, message, data, action_url, read)
    VALUES (v_n.user_id, v_n.kind, v_n.title, v_n.message, v_n.payload, v_n.action_url, false)
    RETURNING id INTO v_notification;
    UPDATE public.ca_commerce_notices SET notification_id = v_notification, delivered_at = now() WHERE id = v_n.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------------------
-- 13. Sponsorship control (R2 section 5.2). Union owner only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_sponsorship_set(p_union_id uuid, p_club_id uuid, p_total_budget integer, p_per_club_budget integer, p_effective_to timestamptz, p_sponsorship_id uuid DEFAULT NULL, p_revoke boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_s public.ca_commerce_sponsorships;
BEGIN
  IF v_actor IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication_required'); END IF;
  IF public.fn_ca_commerce_scope_role('union', p_union_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'union_owner_required');
  END IF;
  IF p_club_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.union_id = p_union_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club_not_in_union');
  END IF;
  IF p_sponsorship_id IS NOT NULL THEN
    SELECT * INTO v_s FROM public.ca_commerce_sponsorships WHERE id = p_sponsorship_id AND union_id = p_union_id FOR UPDATE;
    IF v_s.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'sponsorship_not_found'); END IF;
    IF p_revoke THEN
      UPDATE public.ca_commerce_sponsorships SET state = 'revoked', revoked_at = now(), revision = revision + 1 WHERE id = v_s.id RETURNING * INTO v_s;
    ELSE
      IF p_total_budget IS NULL OR p_total_budget < v_s.committed OR p_total_budget > 2147483647 THEN
        RETURN jsonb_build_object('success', false, 'error', 'budget_below_committed', 'committed', v_s.committed);
      END IF;
      UPDATE public.ca_commerce_sponsorships
         SET total_budget = p_total_budget, per_club_budget = p_per_club_budget, effective_to = p_effective_to, revision = revision + 1
       WHERE id = v_s.id RETURNING * INTO v_s;
    END IF;
  ELSE
    IF p_total_budget IS NULL OR p_total_budget <= 0 OR p_total_budget > 2147483647 THEN
      RETURN jsonb_build_object('success', false, 'error', 'budget_required');
    END IF;
    INSERT INTO public.ca_commerce_sponsorships (union_id, payer_id, club_id, total_budget, per_club_budget, effective_to, created_by)
    VALUES (p_union_id, v_actor, p_club_id, p_total_budget, p_per_club_budget, p_effective_to, v_actor)
    RETURNING * INTO v_s;
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('sponsorship_' || v_s.state, v_actor, 'union', p_union_id, v_s.id, jsonb_build_object('club_id', v_s.club_id, 'total_budget', v_s.total_budget, 'per_club_budget', v_s.per_club_budget, 'revision', v_s.revision));
  RETURN jsonb_build_object('success', true, 'sponsorship_id', v_s.id, 'state', v_s.state, 'total_budget', v_s.total_budget, 'committed', v_s.committed, 'revision', v_s.revision);
END $$;

-- ---------------------------------------------------------------------------
-- 14. Exact-value service refund (R2 section 6.4, R2-A05, R2-A06). Staff or
-- service route; returns the authorized unreturned part of one line's net
-- debit to the original payer through the canonical exact-value 'refund'
-- door, proves the journal and register rows, restores operation-linked lot
-- provenance and reports gross, debt settled and net separately.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_refund(p_purchase_id uuid, p_line_index integer, p_amount integer, p_reason text, p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_p public.ca_commerce_purchases;
  v_line jsonb;
  v_line_net integer;
  v_returned integer;
  v_existing public.ca_commerce_refunds;
  v_ref text;
  v_credit jsonb;
  v_tx public.diamond_transactions;
  v_mint public.ca_mint_ledger;
  v_refund public.ca_commerce_refunds;
  v_refund_id uuid;
  v_detail text;
  v_ent public.ca_commerce_entitlements;
  v_restore jsonb := '[]'::jsonb;
  v_left integer;
  v_lot record;
  v_take integer;
  v_debt integer;
  v_full boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF p_request_key IS NULL OR length(p_request_key) < 8 THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_key_required');
  END IF;
  SELECT * INTO v_existing FROM public.ca_commerce_refunds WHERE request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.purchase_id <> p_purchase_id OR v_existing.line_index <> p_line_index OR v_existing.gross <> p_amount THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN jsonb_build_object('success', true, 'is_replay', true, 'refund_id', v_existing.id, 'gross', v_existing.gross,
      'debt_settled', v_existing.debt_settled, 'net_increase', v_existing.net_increase, 'charged_this_attempt', 0);
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount_required');
  END IF;
  SELECT * INTO v_p FROM public.ca_commerce_purchases WHERE id = p_purchase_id;
  IF v_p.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;
  -- Serialize by original purchase (D40).
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_refund:' || v_p.id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || v_p.scope_kind || ':' || v_p.scope_id::text, 0));
  v_line := (SELECT l FROM jsonb_array_elements(v_p.lines) l WHERE (l->>'index')::integer = p_line_index);
  IF v_line IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'line_not_found'); END IF;
  v_line_net := (v_line->>'net')::integer;
  SELECT COALESCE(SUM(r.gross), 0)::integer INTO v_returned FROM public.ca_commerce_refunds r WHERE r.purchase_id = v_p.id AND r.line_index = p_line_index;
  IF v_line_net = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'nothing_paid_on_this_line');
  END IF;
  IF p_amount > v_line_net - v_returned THEN
    RETURN jsonb_build_object('success', false, 'error', 'exceeds_refundable', 'refundable', v_line_net - v_returned);
  END IF;
  v_full := (v_returned + p_amount = v_line_net);
  v_refund_id := gen_random_uuid();
  v_ref := 'ca-commerce-refund:' || v_refund_id::text;
  -- The payer's wallet row first, as every canonical writer does.
  PERFORM 1 FROM public.profiles p WHERE p.id = v_p.payer_id FOR UPDATE;

  -- Exact-value door: 'refund' is in the multiplier exception list, is
  -- classified refund and registered as issuance by the existing origin rule.
  v_credit := public.add_diamonds_to_balance(v_p.payer_id, p_amount, 'refund',
    'Club And Union Diamond Costs Refund: ' || left(p_reason, 120), v_ref);
  IF NOT COALESCE((v_credit->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_REFUSED' USING DETAIL = COALESCE(v_credit->>'error', 'unknown');
  END IF;
  IF COALESCE((v_credit->>'amount')::integer, -1) <> p_amount THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_NOT_EXACT' USING DETAIL = COALESCE(v_credit->>'amount', 'null');
  END IF;
  SELECT * INTO v_tx FROM public.diamond_transactions t WHERE t.user_id = v_p.payer_id AND t.reference_id = v_ref;
  IF v_tx.id IS NULL OR v_tx.amount <> p_amount OR v_tx.issuance_class <> 'refund' THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_JOURNAL_UNPROVED' USING DETAIL = v_ref;
  END IF;
  SELECT * INTO v_mint FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = v_tx.id;
  IF v_mint.id IS NULL OR v_mint.action <> 'mint' OR v_mint.asset <> 'diamonds' OR v_mint.amount <> p_amount THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_REGISTER_UNPROVED' USING DETAIL = v_ref;
  END IF;
  v_debt := COALESCE((v_credit->>'debt_settled')::integer, 0);

  -- Restore operation-linked lot provenance, bounded by what this purchase
  -- consumed and by each lot's present consumed figure (D39, D65).
  v_left := p_amount;
  FOR v_lot IN SELECT (a->>'lot_id')::uuid AS lot_id, (a->>'consumed_delta')::integer AS delta FROM jsonb_array_elements(v_p.lot_allocation) a ORDER BY 1 LOOP
    EXIT WHEN v_left <= 0;
    SELECT LEAST(v_left, v_lot.delta - COALESCE((SELECT SUM((x->>'restored')::integer) FROM public.ca_commerce_refunds r, jsonb_array_elements(r.lot_restoration) x WHERE r.purchase_id = v_p.id AND x->>'lot_id' = v_lot.lot_id::text), 0), l.consumed)
      INTO v_take FROM public.diamond_purchase_lots l WHERE l.id = v_lot.lot_id FOR UPDATE;
    IF v_take IS NULL OR v_take <= 0 THEN CONTINUE; END IF;
    UPDATE public.diamond_purchase_lots SET consumed = consumed - v_take WHERE id = v_lot.lot_id;
    v_restore := v_restore || jsonb_build_object('lot_id', v_lot.lot_id, 'restored', v_take);
    v_left := v_left - v_take;
  END LOOP;

  INSERT INTO public.ca_commerce_refunds (id, purchase_id, line_index, request_key, requested_by, reason, payer_id, gross, debt_settled, net_increase, diamond_tx_id, mint_op_id, lot_restoration, revoked_entitlement)
  VALUES (v_refund_id, v_p.id, p_line_index, p_request_key, COALESCE(v_actor, v_p.payer_id), p_reason, v_p.payer_id, p_amount, v_debt, p_amount - v_debt, v_tx.id, v_mint.op_id, v_restore, v_full)
  RETURNING * INTO v_refund;

  IF v_full THEN
    UPDATE public.ca_commerce_entitlements SET state = 'revoked', updated_at = now() WHERE purchase_id = v_p.id AND line_index = p_line_index AND state = 'effective' RETURNING * INTO v_ent;
    UPDATE public.ca_commerce_renewal_mandates SET state = 'cancelled', cancelled_at = now(), updated_at = now() WHERE entitlement_id = v_ent.id AND state = 'authorized';
  END IF;
  IF v_p.sponsorship_id IS NOT NULL THEN
    UPDATE public.ca_commerce_sponsorships SET committed = GREATEST(committed - p_amount, 0) WHERE id = v_p.sponsorship_id;
  END IF;

  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('refund_committed', v_actor, v_p.scope_kind, v_p.scope_id, v_refund.id, jsonb_build_object('purchase_id', v_p.id, 'line_index', p_line_index, 'gross', p_amount, 'debt_settled', v_debt, 'net_increase', p_amount - v_debt, 'full', v_full));
  PERFORM public.fn_ca_commerce_notice(v_p.payer_id, 'refund:' || v_refund.id::text, 'club_commerce_refund',
    'Refund: ' || p_amount::text || ' Diamonds',
    'Refund: ' || p_amount::text || ' Diamonds; Applied To Existing Debt: ' || v_debt::text || '; Added To Available Balance: ' || (p_amount - v_debt)::text || '.',
    '/hub/club-arena/' || v_p.scope_kind || 's/' || v_p.scope_id::text || '/diamond-costs', jsonb_build_object('refund_id', v_refund.id));

  RETURN jsonb_build_object('success', true, 'is_replay', false, 'refund_id', v_refund.id, 'gross', p_amount, 'debt_settled', v_debt,
    'net_increase', p_amount - v_debt, 'diamond_tx_id', v_tx.id, 'mint_op_id', v_mint.op_id, 'lot_restoration', v_restore, 'entitlement_revoked', v_full);
EXCEPTION
  WHEN OTHERS THEN
    -- Every write above rolled back, so nothing was credited and nothing is
    -- credited twice on a retry. A refund the wallet cannot receive yet
    -- (balance headroom, D64) is refused whole; the same request key can be
    -- retried once the wallet has room. The owed amount remains provable
    -- from the original receipt and the absence of a refund row.
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM LIKE 'CA_COMMERCE_%' THEN
      RETURN jsonb_build_object('success', false, 'error', lower(replace(SQLERRM, 'CA_COMMERCE_', '')), 'detail', v_detail, 'retry_same_request_key', true);
    END IF;
    IF SQLSTATE = '23514' THEN
      RETURN jsonb_build_object('success', false, 'error', 'wallet_cannot_receive_yet', 'detail', SQLERRM, 'retry_same_request_key', true);
    END IF;
    RAISE;
END $$;

-- ---------------------------------------------------------------------------
-- 15. Admission policy read (R2 section 4.3, D22). Answers whether a scope
-- may admit a new discretionary paid operation. Enforcement is shadow until
-- ca_commerce_settings.admission_enforced_from is set and reached; the
-- callers that consult it are wired in their own migration.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_admission(p_scope_kind text, p_scope_id uuid, p_action text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings public.ca_commerce_settings;
  v_enforced boolean;
  v_in_trial boolean;
  v_ent public.ca_commerce_entitlements;
  v_kind text;
  v_allowed boolean;
  v_reason text;
  v_roster integer;
BEGIN
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  v_enforced := v_settings.admission_enforced_from IS NOT NULL AND v_settings.admission_enforced_from <= now();
  IF p_scope_kind = 'club' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_scope_id AND COALESCE(c.is_platform, false)) THEN
    RETURN jsonb_build_object('allowed', true, 'enforced', v_enforced, 'reason', 'platform_scope');
  END IF;
  v_in_trial := public.fn_ca_commerce_in_trial(p_scope_kind, p_scope_id);
  v_kind := CASE p_action
    WHEN 'approve_member' THEN 'capacity'
    WHEN 'open_table' THEN 'capacity'
    WHEN 'create_tournament' THEN 'capacity'
    WHEN 'union_tools' THEN 'union_back_office'
    WHEN 'club_insurance' THEN 'club_insurance_module'
    WHEN 'union_insurance' THEN 'union_insurance_module'
    ELSE NULL END;
  IF v_kind IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'enforced', v_enforced, 'reason', 'unpriced_action');
  END IF;
  SELECT * INTO v_ent FROM public.ca_commerce_entitlements e
   WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.kind = v_kind AND e.state = 'effective'
     AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())
   ORDER BY e.ends_at DESC NULLS FIRST LIMIT 1;
  IF v_in_trial THEN
    v_allowed := true; v_reason := 'trial';
  ELSIF v_ent.id IS NULL THEN
    v_allowed := false; v_reason := 'no_effective_entitlement';
  ELSIF p_action = 'approve_member' THEN
    v_roster := public.fn_ca_commerce_roster_count(p_scope_id);
    v_allowed := v_roster < v_ent.capacity;
    v_reason := CASE WHEN v_allowed THEN 'within_capacity' ELSE 'capacity_reached' END;
  ELSE
    v_allowed := true; v_reason := 'entitled';
  END IF;
  RETURN jsonb_build_object('allowed', v_allowed OR NOT v_enforced, 'would_allow', v_allowed, 'enforced', v_enforced,
    'reason', v_reason, 'entitlement_id', v_ent.id, 'capacity', v_ent.capacity, 'roster_count', v_roster, 'trial', v_in_trial);
END $$;

-- ---------------------------------------------------------------------------
-- 16. Authorized catalog administration (R2 section 7.3). Platform staff.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_price_draft(p_sku text, p_diamonds integer, p_price_rule text, p_cap_diamonds integer, p_price_authority text) RETURNS jsonb
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
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM public.ca_commerce_price_versions WHERE sku = p_sku;
  INSERT INTO public.ca_commerce_price_versions (sku, version, diamonds, price_rule, cap_diamonds, status, price_authority, created_by)
  VALUES (p_sku, v_version, p_diamonds, p_price_rule, p_cap_diamonds, 'validated', p_price_authority, v_actor) RETURNING id INTO v_id;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail) VALUES ('price_drafted', v_actor, v_id, jsonb_build_object('sku', p_sku, 'version', v_version, 'diamonds', p_diamonds));
  RETURN jsonb_build_object('success', true, 'price_version_id', v_id, 'version', v_version, 'status', 'validated');
END $$;

CREATE FUNCTION public.fn_ca_commerce_price_publish(p_price_version_id uuid, p_effective_from timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_v public.ca_commerce_price_versions;
  v_from timestamptz := COALESCE(p_effective_from, now());
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  SELECT * INTO v_v FROM public.ca_commerce_price_versions WHERE id = p_price_version_id FOR UPDATE;
  IF v_v.id IS NULL OR v_v.status <> 'validated' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_validated');
  END IF;
  IF v_from < now() - interval '1 minute' THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_changes_are_prospective');
  END IF;
  -- The current published price retires at the new effective date; accepted
  -- purchases keep their price version (D74).
  UPDATE public.ca_commerce_price_versions SET status = 'retired', effective_to = v_from
   WHERE sku = v_v.sku AND status = 'published' AND (effective_to IS NULL OR effective_to > v_from);
  UPDATE public.ca_commerce_price_versions SET status = 'published', effective_from = v_from, published_by = v_actor, published_at = now() WHERE id = v_v.id;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail) VALUES ('price_published', v_actor, v_v.id, jsonb_build_object('sku', v_v.sku, 'version', v_v.version, 'effective_from', v_from));
  RETURN jsonb_build_object('success', true, 'price_version_id', v_v.id, 'effective_from', v_from);
END $$;

CREATE FUNCTION public.fn_ca_commerce_product_support(p_sku text, p_supported boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  UPDATE public.ca_commerce_products SET supported = p_supported WHERE sku = p_sku;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'unknown_sku'); END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, detail) VALUES ('product_support_changed', v_actor, jsonb_build_object('sku', p_sku, 'supported', p_supported));
  RETURN jsonb_build_object('success', true);
END $$;

CREATE FUNCTION public.fn_ca_commerce_settings_set(p_checkout_enabled boolean DEFAULT NULL, p_catalog_visible boolean DEFAULT NULL, p_admission_enforced_from timestamptz DEFAULT NULL, p_clear_admission boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_s public.ca_commerce_settings;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  UPDATE public.ca_commerce_settings
     SET checkout_enabled = COALESCE(p_checkout_enabled, checkout_enabled),
         catalog_visible = COALESCE(p_catalog_visible, catalog_visible),
         admission_enforced_from = CASE WHEN p_clear_admission THEN NULL ELSE COALESCE(p_admission_enforced_from, admission_enforced_from) END,
         updated_at = now()
   WHERE id = 1 RETURNING * INTO v_s;
  INSERT INTO public.ca_commerce_events (kind, actor_id, detail) VALUES ('settings_changed', v_actor, to_jsonb(v_s));
  RETURN jsonb_build_object('success', true, 'checkout_enabled', v_s.checkout_enabled, 'catalog_visible', v_s.catalog_visible, 'admission_enforced_from', v_s.admission_enforced_from);
END $$;

-- ---------------------------------------------------------------------------
-- 17. Grants. Browser doors check auth.uid() themselves; internal helpers and
-- the service consumer doors are service-only. A REVOKE names PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.fn_ca_commerce_price_version_immutable(), public.fn_ca_commerce_append_only(),
  public.fn_ca_commerce_scope_owner(text, uuid), public.fn_ca_commerce_scope_role(text, uuid, uuid),
  public.fn_ca_commerce_roster_count(uuid), public.fn_ca_commerce_covered_club_count(uuid),
  public.fn_ca_commerce_scope_trial(text, uuid), public.fn_ca_commerce_in_trial(text, uuid, timestamptz),
  public.fn_ca_commerce_catalog_version(), public.fn_ca_commerce_line_gross(public.ca_commerce_price_versions, integer),
  public.fn_ca_commerce_allocate(integer[], integer), public.fn_ca_commerce_lot_snapshot(uuid),
  public.fn_ca_commerce_notice(uuid, text, text, text, text, text, jsonb, timestamptz),
  public.fn_ca_commerce_activate_trial_impl(text, uuid, uuid, text, timestamptz),
  public.fn_ca_commerce_quote_impl(uuid, uuid, text, uuid, jsonb, uuid, integer, text),
  public.fn_ca_commerce_purchase_impl(uuid, uuid, text, text),
  public.fn_ca_commerce_receipt_json(public.ca_commerce_purchases, boolean),
  public.fn_ca_commerce_claim_due_renewals(uuid, integer), public.fn_ca_commerce_execute_renewal(uuid, uuid),
  public.fn_ca_commerce_deliver_due_notices(integer),
  public.fn_ca_commerce_activate_trial(text, uuid), public.fn_ca_commerce_activate_launch_cohort(timestamptz),
  public.fn_ca_commerce_catalog(text), public.fn_ca_commerce_scope_status(text, uuid),
  public.fn_ca_commerce_quote(text, uuid, jsonb, uuid, integer, text), public.fn_ca_commerce_purchase(uuid, text, text),
  public.fn_ca_commerce_receipts(text, uuid), public.fn_ca_commerce_set_renewal(uuid, boolean, integer, text, integer),
  public.fn_ca_commerce_sponsorship_set(uuid, uuid, integer, integer, timestamptz, uuid, boolean),
  public.fn_ca_commerce_refund(uuid, integer, integer, text, text), public.fn_ca_commerce_admission(text, uuid, text),
  public.fn_ca_commerce_price_draft(text, integer, text, integer, text), public.fn_ca_commerce_price_publish(uuid, timestamptz),
  public.fn_ca_commerce_product_support(text, boolean), public.fn_ca_commerce_settings_set(boolean, boolean, timestamptz, boolean)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.fn_ca_commerce_activate_trial(text, uuid), public.fn_ca_commerce_catalog(text), public.fn_ca_commerce_scope_status(text, uuid),
  public.fn_ca_commerce_quote(text, uuid, jsonb, uuid, integer, text), public.fn_ca_commerce_purchase(uuid, text, text),
  public.fn_ca_commerce_receipts(text, uuid), public.fn_ca_commerce_set_renewal(uuid, boolean, integer, text, integer),
  public.fn_ca_commerce_sponsorship_set(uuid, uuid, integer, integer, timestamptz, uuid, boolean),
  public.fn_ca_commerce_refund(uuid, integer, integer, text, text), public.fn_ca_commerce_admission(text, uuid, text),
  public.fn_ca_commerce_price_draft(text, integer, text, integer, text), public.fn_ca_commerce_price_publish(uuid, timestamptz),
  public.fn_ca_commerce_product_support(text, boolean), public.fn_ca_commerce_settings_set(boolean, boolean, timestamptz, boolean),
  public.fn_ca_commerce_activate_launch_cohort(timestamptz)
TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.fn_ca_commerce_claim_due_renewals(uuid, integer), public.fn_ca_commerce_execute_renewal(uuid, uuid),
  public.fn_ca_commerce_deliver_due_notices(integer), public.fn_ca_commerce_admission(text, uuid, text),
  public.fn_ca_commerce_in_trial(text, uuid, timestamptz), public.fn_ca_commerce_scope_role(text, uuid, uuid)
TO service_role;

-- ---------------------------------------------------------------------------
-- 18. Install-time assertions: no debit, no Mint movement, the catalog is
-- whole, and the orphaned club_creation row is gone.
-- ---------------------------------------------------------------------------
DO $assertions$
DECLARE
  v_count integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_pricing WHERE feature = 'club_creation') THEN
    RAISE EXCEPTION 'club_creation must not remain sellable through the personal feature door';
  END IF;
  SELECT COUNT(*) INTO v_count FROM public.ca_commerce_price_versions WHERE status = 'published';
  IF v_count <> 9 THEN
    RAISE EXCEPTION 'catalog v1 publishes nine supported prices, found %', v_count;
  END IF;
  SELECT COUNT(*) INTO v_count FROM public.ca_commerce_products WHERE supported AND NOT EXISTS (
    SELECT 1 FROM public.ca_commerce_price_versions v WHERE v.sku = ca_commerce_products.sku AND v.status = 'published');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'every supported product has a published price';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_commerce_purchases) OR EXISTS (SELECT 1 FROM public.ca_commerce_trials) THEN
    RAISE EXCEPTION 'installation must not create purchases or trials';
  END IF;
END $assertions$;

COMMIT;
