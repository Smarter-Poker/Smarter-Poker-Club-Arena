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
 */

import { supabase } from '../lib/supabase';

export type ScopeKind = 'club' | 'union';

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
  last_result: Record<string, unknown> | null;
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
  success: boolean;
  error?: string;
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
  balance: number | null;
}

export interface QuoteLine {
  index: number;
  sku: string;
  kind: string;
  title: string;
  price_version_id: string;
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
}

export interface Quote {
  success: boolean;
  error?: string;
  quote_id: string;
  expires_at: string;
  catalog_version: string;
  payer_id: string;
  sponsorship_id: string | null;
  purchase_kind: 'purchase' | 'upgrade';
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
  success: boolean;
  error?: string;
  detail?: string;
  requote?: boolean;
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

export interface Refusal {
  success: false;
  error: string;
  [key: string]: unknown;
}

type Selection = { sku: string; quantity?: number };

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** The words the operator reads for each server refusal. Title Case, no dashes. */
export const REFUSAL_COPY: Record<string, string> = {
  authentication_required: 'Sign In To Continue',
  owner_required: 'Only The Owner Can Do This',
  union_owner_required: 'Only The Union Owner Can Do This',
  access_denied: 'You Do Not Have Access To This Page',
  scope_not_found: 'This Club Or Union Was Not Found',
  checkout_disabled: 'Diamond Checkout Is Paused Right Now',
  invalid_lines: 'Choose At Least One Service',
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
  journal_unproved: 'The Charge Could Not Be Proven And Was Rolled Back',
  register_unproved: 'The Charge Could Not Be Proven And Was Rolled Back',
  lots_unproved: 'The Charge Could Not Be Proven And Was Rolled Back',
  entitlement_not_renewable: 'That Right Cannot Be Renewed',
  trial_rights_do_not_renew: 'Choose The Capacity To Buy After Your Free Month',
  payer_required: 'Only The Original Payer Can Change This Renewal',
  sku_required: 'Choose The Service To Buy After Your Free Month',
  max_diamonds_required: 'Set A Maximum Diamond Charge For Renewals',
  period_already_renewed: 'This Period Was Already Renewed',
  budget_required: 'Enter A Sponsorship Budget In Diamonds',
  budget_below_committed: 'The Budget Cannot Be Lower Than What Is Already Committed',
  club_not_in_union: 'That Club Is Not In This Union',
  sponsorship_not_found: 'That Sponsorship Was Not Found',
  staff_required: 'Platform Staff Only',
};

export function refusalCopy(code: string | undefined, fallback = 'Something Went Wrong'): string {
  if (!code) return fallback;
  return REFUSAL_COPY[code] ?? fallback;
}

const ClubCommerceService = {
  async catalog(scopeKind: ScopeKind): Promise<Catalog> {
    return call<Catalog>('fn_ca_commerce_catalog', { p_scope_kind: scopeKind });
  },

  async scopeStatus(scopeKind: ScopeKind, scopeId: string): Promise<ScopeStatus> {
    return call<ScopeStatus>('fn_ca_commerce_scope_status', {
      p_scope_kind: scopeKind,
      p_scope_id: scopeId,
    });
  },

  async activateTrial(scopeKind: ScopeKind, scopeId: string) {
    return call<{
      success: boolean;
      error?: string;
      replay?: boolean;
      trial_end?: string;
      created?: boolean;
    }>('fn_ca_commerce_activate_trial', { p_scope_kind: scopeKind, p_scope_id: scopeId });
  },

  async quote(
    scopeKind: ScopeKind,
    scopeId: string,
    lines: Selection[],
    options: {
      sponsorshipId?: string | null;
      renewalMaxDiamonds?: number | null;
      purchaseKind?: 'purchase' | 'upgrade';
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
   * One order key per confirmed order. The same key on a retry returns the
   * original receipt; the browser never mints a second key for the same order.
   */
  async purchase(
    quoteId: string,
    requestKey: string,
    purchaseKind: 'purchase' | 'upgrade' = 'purchase'
  ): Promise<Receipt | Refusal> {
    return call<Receipt | Refusal>('fn_ca_commerce_purchase', {
      p_quote_id: quoteId,
      p_request_key: requestKey,
      p_purchase_kind: purchaseKind,
    });
  },

  async receipts(scopeKind: ScopeKind, scopeId: string): Promise<Receipt[]> {
    const rows = await call<Receipt[] | null>('fn_ca_commerce_receipts', {
      p_scope_kind: scopeKind,
      p_scope_id: scopeId,
    });
    return rows ?? [];
  },

  async setRenewal(
    entitlementId: string,
    enabled: boolean,
    maxDiamonds: number | null,
    sku: string | null = null,
    quantity: number | null = null
  ) {
    return call<{
      success: boolean;
      error?: string;
      state?: string;
      mandate_id?: string;
      max_diamonds?: number;
      due_at?: string;
    }>('fn_ca_commerce_set_renewal', {
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
  ) {
    return call<{ success: boolean; error?: string; sponsorship_id?: string; state?: string }>(
      'fn_ca_commerce_sponsorship_set',
      {
        p_union_id: unionId,
        p_club_id: input.clubId ?? null,
        p_total_budget: input.totalBudget ?? null,
        p_per_club_budget: input.perClubBudget ?? null,
        p_effective_to: input.effectiveTo ?? null,
        p_sponsorship_id: input.sponsorshipId ?? null,
        p_revoke: input.revoke ?? false,
      }
    );
  },

  async admission(scopeKind: ScopeKind, scopeId: string, action: string) {
    return call<{
      allowed: boolean;
      would_allow: boolean;
      enforced: boolean;
      reason: string;
      capacity: number | null;
      roster_count: number | null;
    }>('fn_ca_commerce_admission', {
      p_scope_kind: scopeKind,
      p_scope_id: scopeId,
      p_action: action,
    });
  },
};

export default ClubCommerceService;
