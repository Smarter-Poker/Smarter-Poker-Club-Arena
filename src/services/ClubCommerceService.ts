/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB AND UNION DIAMOND COSTS - the operator commerce service
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2). Operating capacity and
 * specific services are sold for diamonds through a versioned catalog, a
 * server quote and one atomic purchase (migration 20260922143541).
 *
 * NOTHING IS DECIDED HERE. The browser sends a selection and an idempotency
 * key; the server prices, places the period, checks the payer, debits once
 * and proves its own accounting before it answers. A replay of the same key
 * returns the original receipt with charged_this_attempt = 0, which is never
 * shown as "free": the original total travels beside it.
 *
 * THE CONTRACT IS PINNED. Every RPC name and every `p_` argument key sent
 * below is checked against the migration's own function signatures, and every
 * refusal code the migration can return is checked against REFUSAL_COPY, by
 * tests/unit/clubCommerceService.test.ts. Rename one side and that test fails.
 */

import { supabase } from '../lib/supabase';

export type ScopeKind = 'club' | 'union';
export type PurchaseKind = 'purchase' | 'upgrade';

export interface CatalogPrice {
  price_version_id: string;
  version: number;
  diamonds: number;
  price_rule: 'flat' | 'per_unit' | 'per_unit_capped';
  cap_diamonds: number | null;
  price_authority: string;
  comparison_verified: boolean;
  effective_from: string;
}

export interface CatalogProduct {
  sku: string;
  title: string;
  kind: string;
  scope_kind: ScopeKind;
  term_kind: 'period' | 'report_interval' | 'permanent';
  term_hours: number | null;
  report_days: number | null;
  capacity: number | null;
  quantity_unit: 'flat' | 'covered_club';
  supported: boolean;
  included_note: string;
  price: CatalogPrice | null;
}

export interface Catalog {
  catalog_version: string;
  catalog_visible: boolean;
  checkout_enabled: boolean;
  nominal_cents_per_diamond: number;
  products: CatalogProduct[];
}

export interface RenewalSummary {
  mandate_id: string;
  state: 'authorized' | 'cancelled' | 'needs_attention' | 'completed';
  max_diamonds: number;
  due_at: string;
  payer_id: string;
  /** The service the mandate will buy and for how many units. */
  sku?: string | null;
  quantity?: number;
  last_result: { reason?: string; outcome?: string; [key: string]: unknown } | null;
}

export interface Entitlement {
  id: string;
  sku: string | null;
  kind: string;
  capacity: number | null;
  quantity: number;
  starts_at: string;
  ends_at: string | null;
  source: 'purchase' | 'trial' | 'sponsor';
  purchase_id: string | null;
  net_paid: number;
  value_basis: number;
  revision: number;
  active: boolean;
  scheduled: boolean;
  renewal: RenewalSummary | null;
}

export interface Sponsorship {
  id: string;
  union_id?: string;
  club_id?: string | null;
  payer_id: string;
  total_budget?: number;
  per_club_budget: number | null;
  committed?: number;
  remaining?: number;
  effective_from?: string;
  effective_to: string | null;
  state?: 'active' | 'revoked';
  revision?: number;
}

export interface ScopeStatus {
  success: true;
  server_time: string;
  role: 'owner' | 'admin' | 'none';
  scope_kind: ScopeKind;
  scope_id: string;
  owner_id: string;
  policy_version: string;
  checkout_enabled: boolean;
  admission_enforced_from: string | null;
  roster_count: number | null;
  covered_club_count: number | null;
  trial: {
    trial_id: string;
    trial_start: string;
    trial_end: string;
    cohort: string;
    active: boolean;
  } | null;
  entitlements: Entitlement[];
  sponsorships: Sponsorship[];
  /** Union scope only: the clubs this union covers (its own shell excluded). */
  covered_clubs?: CoveredClub[];
  balance: number | null;
}

export interface CoveredClub {
  club_id: string;
  name: string;
  roster_count: number;
  trial_active: boolean;
  capacity: {
    sku: string | null;
    capacity: number | null;
    ends_at: string | null;
    source: 'purchase' | 'trial' | 'sponsor';
  } | null;
}

export interface QuoteLine {
  index: number;
  sku: string;
  kind: string;
  title: string;
  price_version_id: string;
  price_version?: number;
  price_rule?: CatalogPrice['price_rule'];
  unit_diamonds: number;
  quantity: number;
  capacity: number | null;
  term_hours: number | null;
  starts_at: string;
  ends_at: string;
  gross: number;
  credit: number;
  comparison_adjustment: number;
  waiver: number;
  net: number;
  replaces_entitlement_id: string | null;
  included_note: string;
  comparison_verified: boolean;
  /** Present on a fresh purchase receipt's lines. */
  entitlement_id?: string;
  mandate_id?: string | null;
}

export interface Quote {
  success: true;
  quote_id: string;
  expires_at: string;
  catalog_version: string;
  payer_id: string;
  sponsorship_id: string | null;
  purchase_kind: PurchaseKind;
  lines: QuoteLine[];
  gross: number;
  credits: number;
  comparison_adjustment: number;
  trial_waiver: number;
  net: number;
  nominal_cents: number;
  trial_active: boolean;
  trial_end: string | null;
  available_balance: number;
  renewal_max_diamonds: number | null;
}

export interface Receipt {
  success: true;
  purchase_id: string;
  quote_id: string;
  is_replay: boolean;
  original_total_diamonds: number;
  original_gross_diamonds: number;
  trial_waiver: number;
  charged_this_attempt: number;
  payer_id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  kind: 'purchase' | 'renewal' | 'upgrade';
  diamond_tx_id: string | null;
  mint_op_id: string | null;
  catalog_version: string;
  delivery_status: string;
  entitlement_status: string;
  committed_at: string;
  lines: QuoteLine[];
  balance_after?: number | null;
  balance_observed_at?: string;
  /** Present when the server projects it: the sponsorship that paid. */
  sponsorship_id?: string | null;
  refunds?: Array<{
    id: string;
    line_index: number;
    gross: number;
    debt_settled: number;
    net_increase: number;
    reason: string;
    created_at: string;
  }>;
}

/** Every refusal the server returns: `success: false` and a snake_case code. */
export interface Refusal {
  success: false;
  error: string;
  detail?: string;
  requote?: boolean;
  balance?: string | number;
  remaining?: number;
  trial_end?: string;
  roster_count?: number;
  capacity?: number;
  [key: string]: unknown;
}

export interface TrialActivation {
  success: true;
  replay: boolean;
  trial_id: string;
  trial_start: string;
  trial_end: string;
  cohort: string;
  enrolled: boolean;
  created: boolean;
}

export interface RenewalChange {
  success: true;
  /** 'none' when there was nothing to cancel; 'completed' when already renewed. */
  state: 'authorized' | 'cancelled' | 'needs_attention' | 'completed' | 'none';
  mandate_id?: string;
  sku?: string;
  max_diamonds?: number;
  due_at?: string;
  note?: string;
}

export interface SponsorshipChange {
  success: true;
  sponsorship_id: string;
  state: 'active' | 'revoked';
  total_budget: number;
  committed: number;
  revision: number;
}

export interface Admission {
  allowed: boolean;
  would_allow?: boolean;
  enforced: boolean;
  reason: string;
  entitlement_id?: string | null;
  capacity?: number | null;
  roster_count?: number | null;
  trial?: boolean;
}

export type Selection = { sku: string; quantity?: number };

/** The server answered a well-formed refusal rather than a result. */
export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { success?: unknown }).success === false
  );
}

/**
 * One RPC. A transport or SQL error throws; an EMPTY answer throws too, so a
 * caller never reads `.success` off null and reports a missing response as a
 * refusal it was never given.
 */
async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message || `${fn} failed`);
  if (data === null || data === undefined) throw new Error(`${fn} returned no data`);
  return data as T;
}

/**
 * The words the operator reads for each server refusal. Title Case, no dashes.
 * Every code the migration can return is here (pinned by the unit test),
 * including the staff and renewal consumer codes, so a code that reaches this
 * page by any route never falls through to a generic line.
 */
export const REFUSAL_COPY: Record<string, string> = {
  /* Identity and scope */
  authentication_required: 'Sign In To Continue',
  owner_required: 'Only The Owner Can Do This',
  union_owner_required: 'Only The Union Owner Can Do This',
  access_denied: 'You Do Not Have Access To This Page',
  scope_not_found: 'This Club Or Union Was Not Found',
  invalid_scope: 'This Club Or Union Was Not Found',
  staff_required: 'Platform Staff Only',

  /* Quote */
  checkout_disabled: 'Diamond Checkout Is Paused Right Now',
  invalid_lines: 'Choose At Least One Service',
  invalid_purchase_kind: 'That Kind Of Order Is Not Available',
  purchase_kind_mismatch: 'This Quote Is For A Different Kind Of Order. Get A New Quote',
  refund_requires_service_route: 'Refunds Are Issued Through The Staff Service Route',
  basket_size: 'Choose Between One And Twelve Services',
  unknown_sku: 'That Service Is Not In The Catalog',
  sku_not_available: 'That Service Is Not Available Yet',
  sku_scope_mismatch: 'That Service Does Not Apply To This Scope',
  duplicate_line: 'Choose Each Kind Of Service Once',
  no_published_price: 'That Service Has No Published Price',
  quantity_not_allowed: 'That Service Is Sold As One Unit',
  quantity_out_of_range: 'Choose Between 1 And 500 Covered Clubs',
  term_not_supported_yet: 'That Term Is Not Available Yet',
  nothing_to_upgrade: 'There Is No Current Paid Capacity To Upgrade',
  same_capacity: 'That Is Already Your Current Capacity',
  downgrade_applies_at_next_period: 'A Smaller Capacity Applies From Your Next Period',
  roster_exceeds_capacity: 'Your Approved Roster Is Larger Than That Capacity',
  sponsor_payer_required: 'Only The Union Sponsor Can Quote A Sponsored Order',

  /* Purchase */
  request_key_required: 'This Order Needs A Fresh Order Key',
  request_key_reused: 'This Order Key Was Already Used For A Different Order',
  quote_not_found: 'That Quote Was Not Found',
  quote_belongs_to_another_actor: 'That Quote Belongs To Another Account',
  quote_expired: 'This Quote Has Expired. Get A New Quote',
  context_changed: 'Something Changed. Get A New Quote',
  payer_no_longer_owner: 'Ownership Changed. Get A New Quote',
  period_already_covered: 'That Period Is Already Covered',
  sponsor_route_required: 'Sponsored Purchases Are Made By The Sponsor',
  sponsorship_not_effective: 'That Sponsorship Does Not Cover This Club Right Now',
  sponsorship_budget_exceeded: 'The Sponsorship Budget Is Exhausted',
  sponsorship_club_budget_exceeded: 'This Club Has Used Its Sponsored Allowance',
  trial_active_authorize_instead:
    'Your Free Month Is Still Running. Authorize Your First Paid Period Instead',
  insufficient_diamonds: 'Not Enough Available Diamonds',
  reserved_diamonds: 'Those Diamonds Back Unsettled Obligations',
  debit_refused: 'The Wallet Refused The Charge',
  debit_reference_reused: 'The Charge Could Not Be Proven And Was Rolled Back',
  journal_unproved: 'The Charge Could Not Be Proven And Was Rolled Back',
  register_unproved: 'The Charge Could Not Be Proven And Was Rolled Back',
  lots_unproved: 'The Charge Could Not Be Proven And Was Rolled Back',
  upgrade_target_gone: 'Your Current Capacity Changed. Get A New Quote',

  /* Renewal control */
  entitlement_not_renewable: 'That Right Cannot Be Renewed',
  trial_rights_do_not_renew: 'Choose The Capacity To Buy After Your Free Month',
  payer_required: 'Only The Original Payer Can Change This Renewal',
  sku_required: 'Choose The Service To Buy After Your Free Month',
  max_diamonds_required: 'Set A Maximum Diamond Charge For Renewals',
  period_already_renewed: 'This Period Was Already Renewed',

  /* Renewal outcomes (the reason a renewal needs attention) */
  payer_no_longer_owner_or_right_changed: 'Ownership Or The Paid Right Changed Before Renewal',
  lapsed_beyond_lateness_policy: 'The Renewal Was Due Too Long Ago To Continue The Period',
  price_above_accepted_ceiling: 'The Price Was Above Your Renewal Ceiling',
  quote_failed: 'The Renewal Could Not Be Priced',
  purchase_failed: 'The Renewal Charge Did Not Complete',
  mandate_cancelled: 'This Renewal Was Cancelled',
  mandate_needs_attention: 'This Renewal Needs Your Attention',
  mandate_completed: 'This Period Was Already Renewed',
  lease_lost: 'The Renewal Is Being Processed. Check Back Shortly',
  unknown: 'Something Went Wrong',

  /* Sponsorship */
  budget_required: 'Enter A Sponsorship Budget In Diamonds',
  budget_below_committed: 'The Budget Cannot Be Lower Than What Is Already Committed',
  club_not_in_union: 'That Club Is Not In This Union',
  sponsorship_not_found: 'That Sponsorship Was Not Found',

  /* Refunds (staff route; the receipt shows the outcome) */
  amount_required: 'Enter A Refund Amount In Diamonds',
  purchase_not_found: 'That Order Was Not Found',
  line_not_found: 'That Order Line Was Not Found',
  nothing_paid_on_this_line: 'Nothing Was Paid On That Line',
  exceeds_refundable: 'That Is More Than Can Be Refunded',
  refund_refused: 'The Wallet Refused The Refund. Retry With The Same Request',
  refund_not_exact: 'The Refund Could Not Be Proven And Was Rolled Back',
  refund_journal_unproved: 'The Refund Could Not Be Proven And Was Rolled Back',
  refund_register_unproved: 'The Refund Could Not Be Proven And Was Rolled Back',
  wallet_cannot_receive_yet: 'The Wallet Cannot Receive This Refund Yet. Retry Later',

  /* Catalog administration and launch */
  cohort_must_be_prospective: 'The Launch Cohort Must Start Now Or Later',
  invalid_price: 'That Price Is Not Valid',
  not_validated: 'Only A Validated Price Can Be Published',
  price_changes_are_prospective: 'Price Changes Apply From Now Onward',
  publisher_required: 'A Price Is Published By A Named Staff Member',
};

export function refusalCopy(
  code: string | undefined | null,
  fallback = 'Something Went Wrong'
): string {
  if (!code) return fallback;
  return Object.prototype.hasOwnProperty.call(REFUSAL_COPY, code) ? REFUSAL_COPY[code] : fallback;
}

/**
 * The published list price of one product for a quantity, by the same rule
 * the server's fn_ca_commerce_line_gross applies. For DISPLAY only (what a
 * renewal will take at today's price); every charge is priced by the server.
 */
export function listPrice(product: CatalogProduct | null | undefined, quantity = 1): number | null {
  const price = product?.price;
  if (!price) return null;
  const qty = Math.max(1, Math.floor(quantity));
  if (price.price_rule === 'flat') return price.diamonds;
  const perUnit = price.diamonds * qty;
  if (price.price_rule === 'per_unit_capped' && price.cap_diamonds !== null)
    return Math.min(perUnit, price.cap_diamonds);
  return perUnit;
}

const ClubCommerceService = {
  async catalog(scopeKind: ScopeKind): Promise<Catalog> {
    return call<Catalog>('fn_ca_commerce_catalog', { p_scope_kind: scopeKind });
  },

  async scopeStatus(scopeKind: ScopeKind, scopeId: string): Promise<ScopeStatus | Refusal> {
    return call<ScopeStatus | Refusal>('fn_ca_commerce_scope_status', {
      p_scope_kind: scopeKind,
      p_scope_id: scopeId,
    });
  },

  async activateTrial(scopeKind: ScopeKind, scopeId: string): Promise<TrialActivation | Refusal> {
    return call<TrialActivation | Refusal>('fn_ca_commerce_activate_trial', {
      p_scope_kind: scopeKind,
      p_scope_id: scopeId,
    });
  },

  async quote(
    scopeKind: ScopeKind,
    scopeId: string,
    lines: Selection[],
    options: {
      sponsorshipId?: string | null;
      renewalMaxDiamonds?: number | null;
      purchaseKind?: PurchaseKind;
    } = {}
  ): Promise<Quote | Refusal> {
    return call<Quote | Refusal>('fn_ca_commerce_quote', {
      p_scope_kind: scopeKind,
      p_scope_id: scopeId,
      p_lines: lines,
      p_sponsorship_id: options.sponsorshipId ?? null,
      p_renewal_max_diamonds: options.renewalMaxDiamonds ?? null,
      p_purchase_kind: options.purchaseKind ?? 'purchase',
    });
  },

  /**
   * One order key per quote. The same key on a retry of the SAME quote
   * returns the original receipt; a new quote gets a new key. The server
   * refuses a key reused for a different quote (request_key_reused).
   */
  async purchase(
    quoteId: string,
    requestKey: string,
    purchaseKind: PurchaseKind = 'purchase'
  ): Promise<Receipt | Refusal> {
    return call<Receipt | Refusal>('fn_ca_commerce_purchase', {
      p_quote_id: quoteId,
      p_request_key: requestKey,
      p_purchase_kind: purchaseKind,
    });
  },

  /**
   * Receipts where the caller is payer or actor, newest first. With both
   * scope arguments null it returns every such receipt (a sponsor's club
   * purchases included).
   */
  async receipts(scopeKind: ScopeKind | null, scopeId: string | null): Promise<Receipt[]> {
    const { data, error } = await supabase.rpc('fn_ca_commerce_receipts', {
      p_scope_kind: scopeKind,
      p_scope_id: scopeId,
    });
    if (error) throw new Error(error.message || 'fn_ca_commerce_receipts failed');
    return Array.isArray(data) ? (data as Receipt[]) : [];
  },

  async setRenewal(
    entitlementId: string,
    enabled: boolean,
    maxDiamonds: number | null,
    sku: string | null = null,
    quantity: number | null = null
  ): Promise<RenewalChange | Refusal> {
    return call<RenewalChange | Refusal>('fn_ca_commerce_set_renewal', {
      p_entitlement_id: entitlementId,
      p_enabled: enabled,
      p_max_diamonds: maxDiamonds,
      p_sku: sku,
      p_quantity: quantity,
    });
  },

  async setSponsorship(
    unionId: string,
    input: {
      sponsorshipId?: string | null;
      clubId?: string | null;
      totalBudget?: number | null;
      perClubBudget?: number | null;
      effectiveTo?: string | null;
      revoke?: boolean;
    }
  ): Promise<SponsorshipChange | Refusal> {
    return call<SponsorshipChange | Refusal>('fn_ca_commerce_sponsorship_set', {
      p_union_id: unionId,
      p_club_id: input.clubId ?? null,
      p_total_budget: input.totalBudget ?? null,
      p_per_club_budget: input.perClubBudget ?? null,
      p_effective_to: input.effectiveTo ?? null,
      p_sponsorship_id: input.sponsorshipId ?? null,
      p_revoke: input.revoke ?? false,
    });
  },

  async admission(scopeKind: ScopeKind, scopeId: string, action: string): Promise<Admission> {
    return call<Admission>('fn_ca_commerce_admission', {
      p_scope_kind: scopeKind,
      p_scope_id: scopeId,
      p_action: action,
    });
  },
};

export default ClubCommerceService;
