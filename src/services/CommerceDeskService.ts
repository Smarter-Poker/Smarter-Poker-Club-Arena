/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMERCE DESK - the platform staff doors onto club and union commerce
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), sections 4.4, 6.4 and 7.3.
 * Owners request refunds on the Diamond Costs page; platform staff decide them
 * here. Staff also run the catalog lifecycle (draft, validate, publish, retire),
 * mark a product supported or not, switch checkout and catalog visibility, and
 * record and verify competitor comparison evidence.
 *
 * Every door lives in SQL and checks staff itself (fn_is_platform_admin):
 *   20260922143541  fn_ca_commerce_catalog, fn_ca_commerce_product_support,
 *                   fn_ca_commerce_settings_set
 *   20260924102040  fn_ca_commerce_refund_queue, fn_ca_commerce_refund_decide,
 *                   fn_ca_commerce_price_draft / _validate / _publish / _retire,
 *                   fn_ca_commerce_comparison_record / _verify, and the two
 *                   staff reads fn_ca_commerce_price_versions and
 *                   fn_ca_commerce_comparison_list; fn_ca_commerce_product_support
 *                   is replaced there and now counts the open quotes it withdraws
 * The route guard (PlatformStaffGuard) is a courtesy; the doors are the lock.
 *
 * NOTHING IS DECIDED HERE. A refusal comes back as { success: false, error }
 * and is printed through DESK_REFUSAL_COPY. A transport failure (the RPC
 * itself erred) throws CommerceDeskTransportError after it is reported.
 *
 * THE CONTRACT IS PINNED. tests/unit/commerceDeskService.test.ts reads the
 * migrations and proves, both ways, that every RPC and `p_` key sent below
 * matches the latest signature and grant, and that every refusal code those
 * doors can return has Title Case copy here.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { enumToTitleCase, stripEmDashes } from '../utils/titleCase';

export type ScopeKind = 'club' | 'union';

/* ── Refund requests (fn_ca_commerce_refund_request_json) ─────────────────── */

export type RefundState = 'requested' | 'approved' | 'declined' | 'owed' | 'refunded' | 'failed';

/** The filter order staff work in: open work first, then the closed states. */
export const REFUND_STATES: readonly RefundState[] = [
  'requested',
  'approved',
  'owed',
  'refunded',
  'declined',
  'failed',
];

export const REFUND_STATE_LABEL: Readonly<Record<RefundState, string>> = {
  requested: 'Requested',
  approved: 'Approved',
  owed: 'Owed',
  refunded: 'Refunded',
  declined: 'Declined',
  failed: 'Failed',
};

export type RefundReason =
  | 'purchase_in_error'
  | 'scope_closed'
  | 'service_unavailable'
  | 'platform_defect';

export const REFUND_REASON_LABEL: Readonly<Record<RefundReason, string>> = {
  purchase_in_error: 'Purchase Made In Error',
  scope_closed: 'Club Or Union Closed',
  service_unavailable: 'Service Was Unavailable',
  platform_defect: 'Platform Defect',
};

export type RefundBasis = 'error_full' | 'pro_rata_unused_days';

export const REFUND_BASIS_LABEL: Readonly<Record<RefundBasis, string>> = {
  error_full: 'In Full, Purchase Made In Error Within 24 Hours',
  pro_rata_unused_days: 'Pro Rata, Unused Whole Days Of The Paid Period',
};

/** What fn_ca_commerce_refund_policy recorded when the request was made. */
export interface RefundPolicyDetail {
  line_net?: number;
  refundable?: number;
  purchased_at?: string;
  right_state?: string | null;
  right_starts_at?: string | null;
  right_ends_at?: string | null;
  right_started?: boolean;
  sponsored?: boolean;
  /** Pro rata only. */
  unused_days?: number;
  period_days?: number;
}

export interface RefundRequest {
  request_id: string;
  purchase_id: string;
  line_index: number;
  scope_kind: ScopeKind;
  scope_id: string;
  payer_id: string;
  requested_by: string;
  reason_code: RefundReason;
  details: string | null;
  policy_version: number;
  policy_basis: RefundBasis;
  policy_amount: number;
  policy_detail: RefundPolicyDetail;
  state: RefundState;
  approved_amount: number | null;
  pending_amount: number;
  decided_at: string | null;
  decision_note: string | null;
  owed_reason: string | null;
  last_error: string | null;
  attempts: number;
  refund_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

/* ── Catalog (fn_ca_commerce_catalog) ─────────────────────────────────────── */

export type PriceRule = 'flat' | 'per_unit' | 'per_unit_capped';
export type PriceStatus = 'draft' | 'validated' | 'published' | 'retired';

export const PRICE_RULE_LABEL: Readonly<Record<PriceRule, string>> = {
  flat: 'Flat Price',
  per_unit: 'Per Covered Club',
  per_unit_capped: 'Per Covered Club, With A Cap',
};

export const PRICE_STATUS_LABEL: Readonly<Record<PriceStatus, string>> = {
  draft: 'Draft',
  validated: 'Validated',
  published: 'Published',
  retired: 'Retired',
};

export interface DeskCatalogPrice {
  price_version_id: string;
  version: number;
  diamonds: number;
  price_rule: PriceRule;
  cap_diamonds: number | null;
  price_authority: string;
  comparison_verified: boolean;
  effective_from: string;
}

export interface DeskCatalogProduct {
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
  price: DeskCatalogPrice | null;
}

export interface DeskCatalog {
  catalog_version: string;
  catalog_visible: boolean;
  checkout_enabled: boolean;
  nominal_cents_per_diamond: number;
  products: DeskCatalogProduct[];
}

/**
 * The price rules fn_ca_commerce_price_validate accepts for a product: a flat
 * product takes a flat price, a per covered club product takes either per
 * unit rule. A draft can be written with any rule; validation refuses the
 * rest, so the form only offers what can pass.
 */
export function priceRulesFor(quantityUnit: DeskCatalogProduct['quantity_unit']): PriceRule[] {
  return quantityUnit === 'covered_club' ? ['per_unit', 'per_unit_capped'] : ['flat'];
}

/* ── Staff reads (fn_ca_commerce_price_versions / _comparison_list) ─────── */

/** One price version as fn_ca_commerce_price_versions returns it, newest first. */
export interface DeskPriceVersion {
  price_version_id: string;
  sku: string;
  version: number;
  status: PriceStatus;
  diamonds: number;
  price_rule: PriceRule;
  cap_diamonds: number | null;
  price_authority: string;
  effective_from: string | null;
  effective_to: string | null;
  created_by: string | null;
  published_by: string | null;
  published_at: string | null;
  comparison_verified: boolean;
  comparison_evidence: Record<string, unknown>;
  /** Published, started and not yet ended: the price a quote uses now. */
  in_effect: boolean;
  created_at: string;
}

/** One piece of evidence as fn_ca_commerce_comparison_list returns it, newest first. */
export interface DeskEvidence {
  evidence_id: string;
  sku: string;
  source_name: string;
  source_url: string;
  observed_price: number;
  observed_unit: string;
  observed_at: string;
  conversion_note: string;
  price_version_id: string | null;
  recorded_by: string;
  recorded_by_name: string | null;
  recorded_at: string;
  verified_by: string | null;
  verified_by_name: string | null;
  verified_at: string | null;
  verified: boolean;
}

/**
 * The one lifecycle step each status is ready for (R2 7.3): a draft is
 * validated, a validated version is published, a published version is
 * retired. A draft or validated version can also be withdrawn (the retire
 * door retires it outright); a retired version takes no step.
 */
export function nextPriceStep(status: PriceStatus): 'validate' | 'publish' | 'retire' | null {
  if (status === 'draft') return 'validate';
  if (status === 'validated') return 'publish';
  if (status === 'published') return 'retire';
  return null;
}

/* ── Admission shadow report (fn_ca_commerce_admission_report) ───────────── */

export interface AdmissionDoorRow {
  action: string;
  door: string;
  decisions: number;
  would_deny: number;
  refused: number;
  undecided: number;
  scopes_would_deny: number;
  last_at: string | null;
}

export interface AdmissionScopeRow {
  scope_kind: ScopeKind;
  scope_id: string;
  would_deny: number;
  refused: number;
  reasons: string[];
  last_at: string | null;
}

export interface AdmissionReport {
  days: number;
  since: string;
  enforced_from: string | null;
  enforced: boolean;
  doors: AdmissionDoorRow[];
  scopes: AdmissionScopeRow[];
}

/** What each admission action is, in the words staff read. */
export const ADMISSION_ACTION_LABEL: Readonly<Record<string, string>> = {
  approve_member: 'Approve Or Add A Member',
  join_member: 'Member Joins Without Review',
  open_table: 'Open A New Table',
  create_tournament: 'Create A Tournament Or Schedule',
  club_insurance: 'Offer Club Insurance',
  union_tools: 'Union Back Office',
  union_insurance: 'Offer Union Insurance',
};

/** Which door recorded the decision, in the words staff read. */
export const ADMISSION_DOOR_LABEL: Readonly<Record<string, string>> = {
  fn_review_join_request: 'Owner Approves A Join Request',
  fn_join_club: 'Player Joins A Club That Admits Automatically',
  fn_redeem_club_invite_code: 'Invite Link Admits A Pending Member',
  fn_agent_attach_player: 'Agent Or Staff Adds A Player',
  fn_cash_game_create: 'Owner Opens A Cash Game',
  fn_create_tournament: 'Owner Creates A Tournament',
  fn_upsert_tournament_schedule: 'Owner Creates A Recurring Schedule',
};

/** Why a decision would refuse (or allowed), in the words staff read. */
export const ADMISSION_REASON_LABEL: Readonly<Record<string, string>> = {
  no_effective_entitlement: 'No Operating Access',
  capacity_reached: 'Member Capacity Reached',
  within_capacity: 'Within Capacity',
  entitled: 'Operating Access Active',
  trial: 'Free Month',
  platform_scope: 'Platform Club',
  unpriced_action: 'Not A Priced Action',
  decision_unavailable: 'Decision Unavailable',
};

export function admissionWords(table: Readonly<Record<string, string>>, code: string): string {
  return hasOwn(table, code) ? table[code] : enumToTitleCase(code);
}

/* ── Door answers ─────────────────────────────────────────────────────────── */

export interface Refusal {
  success: false;
  error: string;
  [key: string]: unknown;
}

export type DeskAnswer<T> = (T & { success: true }) | Refusal;

export function isRefusal(res: unknown): res is Refusal {
  return !!res && typeof res === 'object' && (res as { success?: unknown }).success === false;
}

export class CommerceDeskTransportError extends Error {
  constructor(where: string) {
    super(`The Server Could Not Be Reached To ${where}. Check Your Connection And Try Again.`);
    this.name = 'CommerceDeskTransportError';
  }
}

async function call<T>(fn: string, args: Record<string, unknown>, where: string): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    reportError(error, `CommerceDeskService.${fn}`);
    throw new CommerceDeskTransportError(where);
  }
  if (data === null || data === undefined) {
    reportError(new Error(`${fn} returned no data`), `CommerceDeskService.${fn}`);
    throw new CommerceDeskTransportError(where);
  }
  return data as T;
}

/**
 * The doors, one method each. Every argument key is the migration's own `p_`
 * name, and every key is always sent (never undefined): PostgREST picks a
 * function by the names it receives, so a dropped key is a different call.
 */
const CommerceDeskService = {
  catalog(): Promise<DeskCatalog> {
    return call<DeskCatalog>('fn_ca_commerce_catalog', { p_scope_kind: null }, 'Read The Catalog');
  },

  /** What enforcement would refuse, from the recorded shadow decisions. Staff only. */
  admissionReport(days = 30): Promise<DeskAnswer<AdmissionReport>> {
    return call('fn_ca_commerce_admission_report', { p_days: days }, 'Read The Admission Report');
  },

  refundQueue(
    state: RefundState | null,
    limit = 200
  ): Promise<DeskAnswer<{ requests: RefundRequest[] }>> {
    return call('fn_ca_commerce_refund_queue', { p_state: state, p_limit: limit }, 'Read Refunds');
  },

  decideRefund(
    requestId: string,
    approve: boolean,
    amount: number | null,
    note: string | null
  ): Promise<DeskAnswer<{ is_replay: boolean; request: RefundRequest }>> {
    return call(
      'fn_ca_commerce_refund_decide',
      { p_request_id: requestId, p_approve: approve, p_amount: amount, p_note: note },
      'Decide The Refund'
    );
  },

  draftPrice(
    sku: string,
    diamonds: number,
    rule: PriceRule,
    capDiamonds: number | null,
    priceAuthority: string
  ): Promise<DeskAnswer<{ price_version_id: string; version: number; status: 'draft' }>> {
    return call(
      'fn_ca_commerce_price_draft',
      {
        p_sku: sku,
        p_diamonds: diamonds,
        p_price_rule: rule,
        p_cap_diamonds: capDiamonds,
        p_price_authority: priceAuthority,
      },
      'Draft The Price'
    );
  },

  validatePrice(
    priceVersionId: string
  ): Promise<DeskAnswer<{ price_version_id: string; version: number; status: 'validated' }>> {
    return call(
      'fn_ca_commerce_price_validate',
      { p_price_version_id: priceVersionId },
      'Validate The Price'
    );
  },

  publishPrice(
    priceVersionId: string,
    effectiveFrom: string | null
  ): Promise<
    DeskAnswer<{ price_version_id: string; effective_from: string; price_change_notices?: number }>
  > {
    return call(
      'fn_ca_commerce_price_publish',
      { p_price_version_id: priceVersionId, p_effective_from: effectiveFrom },
      'Publish The Price'
    );
  },

  retirePrice(
    priceVersionId: string,
    effectiveTo: string | null
  ): Promise<
    DeskAnswer<{
      is_replay: boolean;
      price_version_id: string;
      status: PriceStatus;
      effective_to: string | null;
    }>
  > {
    return call(
      'fn_ca_commerce_price_retire',
      { p_price_version_id: priceVersionId, p_effective_to: effectiveTo },
      'Retire The Price'
    );
  },

  /** Every price version, or one product's, newest first. Staff only. */
  priceVersions(sku: string | null): Promise<DeskAnswer<{ price_versions: DeskPriceVersion[] }>> {
    return call('fn_ca_commerce_price_versions', { p_sku: sku }, 'Read Price Versions');
  },

  /** Every piece of comparison evidence, or one product's, newest first. Staff only. */
  comparisonList(sku: string | null): Promise<DeskAnswer<{ evidence: DeskEvidence[] }>> {
    return call('fn_ca_commerce_comparison_list', { p_sku: sku }, 'Read Comparison Evidence');
  },

  /**
   * Withdrawing a product (supported false) also withdraws every open quote
   * that sells it, in the same transaction; the answer counts them.
   */
  setProductSupport(
    sku: string,
    supported: boolean
  ): Promise<DeskAnswer<{ sku: string; supported: boolean; quotes_withdrawn: number }>> {
    return call(
      'fn_ca_commerce_product_support',
      { p_sku: sku, p_supported: supported },
      'Change Product Support'
    );
  },

  /**
   * Checkout and catalog visibility only. Admission enforcement is a separate,
   * recorded staff event and is never switched from this desk, so its two
   * arguments are always sent as "leave it as it is".
   */
  setSettings(change: { checkoutEnabled: boolean | null; catalogVisible: boolean | null }): Promise<
    DeskAnswer<{
      checkout_enabled: boolean;
      catalog_visible: boolean;
      admission_enforced_from: string | null;
    }>
  > {
    return call(
      'fn_ca_commerce_settings_set',
      {
        p_checkout_enabled: change.checkoutEnabled,
        p_catalog_visible: change.catalogVisible,
        p_admission_enforced_from: null,
        p_clear_admission: false,
      },
      'Change The Settings'
    );
  },

  recordComparison(evidence: {
    sku: string;
    sourceName: string;
    sourceUrl: string;
    observedPrice: number;
    observedUnit: string;
    observedAt: string;
    conversionNote: string;
    priceVersionId: string | null;
  }): Promise<DeskAnswer<{ evidence_id: string; verified: false }>> {
    return call(
      'fn_ca_commerce_comparison_record',
      {
        p_sku: evidence.sku,
        p_source_name: evidence.sourceName,
        p_source_url: evidence.sourceUrl,
        p_observed_price: evidence.observedPrice,
        p_observed_unit: evidence.observedUnit,
        p_observed_at: evidence.observedAt,
        p_conversion_note: evidence.conversionNote,
        p_price_version_id: evidence.priceVersionId,
      },
      'Record The Evidence'
    );
  },

  verifyComparison(
    evidenceId: string,
    priceVersionId: string | null
  ): Promise<
    DeskAnswer<{
      is_replay: boolean;
      evidence_id: string;
      price_version_id: string;
      comparison_verified: boolean;
    }>
  > {
    return call(
      'fn_ca_commerce_comparison_verify',
      { p_evidence_id: evidenceId, p_price_version_id: priceVersionId },
      'Verify The Evidence'
    );
  },
};

export default CommerceDeskService;

/* ── Names for the queue (best effort, never blocking) ───────────────────── */

export interface DeskNames {
  people: Record<string, string>;
  clubs: Record<string, string>;
  unions: Record<string, string>;
}

/**
 * The queue carries ids only. Staff read names: the payer's and requester's
 * poker handle (alias, then username; never a real name), and the club or
 * union name. A lookup that fails is reported and
 * the row prints the short id instead; it never hides a request.
 */
/**
 * Poker handles (alias, then username; never a real name) for staff ids on
 * price versions. Best effort: a failed read is reported and the id prints.
 */
export async function lookupHandles(
  ids: ReadonlyArray<string | null>
): Promise<Record<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out: Record<string, string> = {};
  if (!want.length) return out;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, alias')
    .in('id', want);
  if (error) reportError(error, 'CommerceDeskService.lookupHandles');
  for (const row of (data ?? []) as Array<{
    id: string;
    username: string | null;
    alias?: string | null;
  }>) {
    const handle = (row.alias ?? '').trim() || (row.username ?? '').trim();
    if (handle) out[row.id] = handle;
  }
  return out;
}

export async function lookupDeskNames(requests: readonly RefundRequest[]): Promise<DeskNames> {
  const people = [...new Set(requests.flatMap((r) => [r.payer_id, r.requested_by]))];
  const clubs = [
    ...new Set(requests.filter((r) => r.scope_kind === 'club').map((r) => r.scope_id)),
  ];
  const unions = [
    ...new Set(requests.filter((r) => r.scope_kind === 'union').map((r) => r.scope_id)),
  ];
  const out: DeskNames = { people: {}, clubs: {}, unions: {} };
  const [p, c, u] = await Promise.all([
    people.length
      ? supabase.from('profiles').select('id, username, alias').in('id', people)
      : Promise.resolve({ data: [], error: null }),
    clubs.length
      ? supabase.from('clubs').select('id, name').in('id', clubs)
      : Promise.resolve({ data: [], error: null }),
    unions.length
      ? supabase.from('unions').select('id, name').in('id', unions)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (p.error) reportError(p.error, 'CommerceDeskService.lookupDeskNames.profiles');
  if (c.error) reportError(c.error, 'CommerceDeskService.lookupDeskNames.clubs');
  if (u.error) reportError(u.error, 'CommerceDeskService.lookupDeskNames.unions');
  // The poker handle (alias, then username), never a real name.
  for (const row of (p.data ?? []) as Array<{
    id: string;
    username: string | null;
    alias?: string | null;
  }>) {
    const handle = (row.alias ?? '').trim() || (row.username ?? '').trim();
    if (handle) out.people[row.id] = handle;
  }
  for (const row of (c.data ?? []) as Array<{ id: string; name: string | null }>)
    if (row.name) out.clubs[row.id] = row.name;
  for (const row of (u.data ?? []) as Array<{ id: string; name: string | null }>)
    if (row.name) out.unions[row.id] = row.name;
  return out;
}

/** Club and union names for a list of scopes (the admission report). Best effort. */
export async function lookupScopeNames(
  scopes: ReadonlyArray<{ scope_kind: ScopeKind; scope_id: string }>
): Promise<DeskNames> {
  const clubs = [...new Set(scopes.filter((x) => x.scope_kind === 'club').map((x) => x.scope_id))];
  const unions = [
    ...new Set(scopes.filter((x) => x.scope_kind === 'union').map((x) => x.scope_id)),
  ];
  const out: DeskNames = { people: {}, clubs: {}, unions: {} };
  const [c, u] = await Promise.all([
    clubs.length
      ? supabase.from('clubs').select('id, name').in('id', clubs)
      : Promise.resolve({ data: [], error: null }),
    unions.length
      ? supabase.from('unions').select('id, name').in('id', unions)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (c.error) reportError(c.error, 'CommerceDeskService.lookupScopeNames.clubs');
  if (u.error) reportError(u.error, 'CommerceDeskService.lookupScopeNames.unions');
  for (const row of (c.data ?? []) as Array<{ id: string; name: string | null }>)
    if (row.name) out.clubs[row.id] = row.name;
  for (const row of (u.data ?? []) as Array<{ id: string; name: string | null }>)
    if (row.name) out.unions[row.id] = row.name;
  return out;
}

/* ── Refusal copy ─────────────────────────────────────────────────────────── */

/**
 * Every code the desk's doors can return, in the words staff read. Title Case,
 * no em dashes. Pinned against the migrations by
 * tests/unit/commerceDeskService.test.ts: a code added in SQL without a line
 * here fails that test.
 */
export const DESK_REFUSAL_COPY: Readonly<Record<string, string>> = {
  // Every door
  authentication_required: 'Sign In Again To Use The Commerce Desk',
  staff_required: 'Only Platform Staff Can Use The Commerce Desk',

  // fn_ca_commerce_refund_decide
  decision_required: 'Choose Approve Or Decline',
  note_too_long: 'The Note Is Too Long. Keep It Under 2,000 Characters',
  request_not_found: 'That Refund Request No Longer Exists. Refresh The Queue',
  cannot_decide_own_request:
    'You Cannot Decide A Refund You Requested Or Paid For. Another Staff Member Decides It',
  already_decided: 'Another Staff Member Already Decided This Request. Refresh The Queue',
  amount_required: 'Enter A Whole Diamond Amount Greater Than 0',
  exceeds_refundable: 'That Is More Than Is Left To Refund On This Purchase Line',
  note_required: 'A Decline Needs A Note Of At Least 5 Characters For The Payer',

  // fn_ca_commerce_price_draft
  unknown_sku: 'That Product Is Not In The Catalog',
  capability_unavailable:
    'This Product Sells A Platform Capability That Is Not Available Yet. The Capability Registry Must Show It Deployed First',
  invalid_price:
    'The Price Is Not Valid. Use A Whole Number Of Diamonds, A Listed Price Rule And A Price Authority Of At Least 10 Characters',

  // fn_ca_commerce_price_validate
  price_version_not_found: 'That Price Version Does Not Exist',
  not_draft: 'Only A Draft Can Be Validated',
  zero_price_not_allowed: 'A Price Must Be At Least 1 Diamond. There Is No Free Tier',
  price_rule_does_not_fit_product:
    'That Price Rule Does Not Fit How This Product Is Counted. Draft It Again With A Rule The Product Allows',
  cap_required: 'A Capped Price Needs A Cap',
  cap_not_allowed: 'Only A Capped Per Club Price Takes A Cap. Draft It Again Without One',
  cap_below_unit_price: 'The Cap Cannot Be Lower Than The Price Per Covered Club',
  product_term_undefined: 'This Product Has No Term The Catalog Can Sell',

  // fn_ca_commerce_price_publish
  publisher_required: 'A Published Price Must Name The Staff Member Who Published It',
  not_validated: 'Only A Validated Price Can Be Published. Validate It First',
  price_changes_are_prospective: 'A Price Can Only Take Effect Now Or Later, Never In The Past',

  // fn_ca_commerce_price_retire
  retirement_is_prospective: 'A Price Can Only Be Retired Now Or Later, Never In The Past',
  supported_product_needs_a_price:
    'A Supported Product Always Needs A Price. Publish Its Successor Or Mark It Unsupported First',

  // fn_ca_commerce_comparison_record
  source_name_required: 'Name The Source In 2 To 120 Characters',
  invalid_source_url: 'The Source Link Must Be A Full Https Address',
  invalid_observed_price: 'The Observed Price Must Be Greater Than 0',
  observed_unit_required: 'Say What The Observed Price Buys, In 2 To 120 Characters',
  invalid_observed_at: 'The Observed Date Cannot Be In The Future',
  conversion_note_required:
    'Explain How The Observed Price Converts To Diamonds, In 10 To 2,000 Characters',
  price_version_not_for_sku: 'That Price Version Belongs To Another Product',

  // fn_ca_commerce_comparison_verify
  evidence_not_found: 'That Evidence Does Not Exist',
  second_staff_member_required: 'You Recorded This Evidence. A Second Staff Member Must Verify It',
  price_version_not_current: 'Evidence Can Only Verify A Validated Or Published Price',
  evidence_already_verified: 'This Evidence Already Verified Another Price Version',
};

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The staff sentence for a refusal code, never the raw code. */
export function deskRefusalCopy(
  code: string | null | undefined,
  fallback = 'The Server Refused That Change'
): string {
  if (code && hasOwn(DESK_REFUSAL_COPY, code)) return DESK_REFUSAL_COPY[code];
  return fallback;
}

/**
 * An owed or failed refund carries the wallet's own reason (for example
 * diamond_balance_limit) as a machine word. Known codes read as desk copy;
 * anything else is printed as its words, Title Cased, never raw.
 */
export function refundReasonWords(code: string | null | undefined): string {
  if (!code) return '';
  const bare = code.split(':')[0].trim();
  if (hasOwn(DESK_REFUSAL_COPY, bare)) return DESK_REFUSAL_COPY[bare];
  return enumToTitleCase(bare);
}

/* ── Admission refusals on the owner doors (20260924102056) ──────────────── */

/**
 * An enforced commerce admission refuses a NEW owner action with a finished
 * Title Case sentence from fn_ca_commerce_admission_message, in one of three
 * shapes:
 *   fn_review_join_request        { success: false, error: <sentence>, code: 'operating_access_required', reason }
 *   fn_create_tournament          { success: false, error: 'operating_access_required', message: <sentence>, reason }
 *   fn_upsert_tournament_schedule { error: 'operating_access_required', message: <sentence>, reason }
 * This returns the sentence for any of them, and null for anything else.
 */
export const OPERATING_ACCESS_REQUIRED = 'operating_access_required';

/** fn_ca_commerce_admission_message's own ELSE sentence, for an answer with none. */
export const OPERATING_ACCESS_FALLBACK =
  'Operating Access Is Required For This New Action. Existing Games And Members Are Not Affected.';

export function operatingAccessRefusal(res: unknown): string | null {
  if (!res || typeof res !== 'object') return null;
  const r = res as { error?: unknown; code?: unknown; message?: unknown };
  const clean = (v: unknown) =>
    typeof v === 'string' && v.trim() && v.trim() !== OPERATING_ACCESS_REQUIRED
      ? stripEmDashes(v.trim())
      : null;
  if (r.code === OPERATING_ACCESS_REQUIRED)
    return clean(r.error) ?? clean(r.message) ?? OPERATING_ACCESS_FALLBACK;
  if (r.error === OPERATING_ACCESS_REQUIRED) return clean(r.message) ?? OPERATING_ACCESS_FALLBACK;
  return null;
}
