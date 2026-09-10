/** Gated prospective ABI v2. This file does not provide or activate an endpoint.
 * All decimal values are canonical nonnegative base-10 strings. Cash has exactly
 * two decimal places; exact values have no exponent or insignificant trailing zero.
 * UUIDs are canonical lowercase. Duplicate identities are invalid responses. */
type UUID = string;
type Cash = string;
type Exact = string;
type UTCDate = string;
type Instant = string;
export interface CapturedScope {
  club_id: UUID;
  funding_union_id: UUID | null;
  funding_route: 'union_rake_wallet' | 'club_chip_treasury';
  contract_version: 1;
  payer_user_id: UUID;
}
export interface EarningWeek {
  week_start: UTCDate;
  week_end: UTCDate; // Monday + 6 days, inclusive.
  closed: boolean;
  entitlement_exact: Exact;
  consumed_exact: Exact;
  remaining_exact: Exact;
  source_count: number;
  funding_admitted_source_count: number;
}
export interface ScopeBalance {
  scope: CapturedScope;
  pool_id: UUID | null; // May be absent until actual bank admission creates the pool.
  closed_entitlement_exact: Exact;
  consumed_exact: Exact;
  unpaid_exact: Exact;
  pending_amount: Cash; // floor(closed entitlement * 100) / 100 - immutable paid cash.
  paid_amount: Cash; // Cash actually paid, independent of earning-week attribution.
  earning_weeks: EarningWeek[];
}
export interface EarningSlice {
  hand_id: UUID;
  contributor_id: UUID;
  week_start: UTCDate;
  amount_exact: Exact;
}
export interface CashPayment {
  payment_id: UUID;
  scope: CapturedScope;
  pool_id: UUID;
  beneficiary_user_id: UUID;
  amount: Cash;
  paid_at: Instant;
  earning_closed_through: UTCDate;
  earning_slices: EarningSlice[];
}
export interface UnresolvedEarnings {
  club_id: UUID;
  week_start: UTCDate;
  week_end: UTCDate;
  source_count: number;
  reasons: string[];
}
export interface CapturedRakebackReadV2 {
  schema_version: 2;
  source_active: boolean; // Coordinated release capability, never capture-only marker.
  beneficiary_user_id: UUID;
  earning_closed_through: UTCDate; // Current UTC Monday; upper bound is exclusive.
  pending_amount: Cash; // Sum of per-compatible-scope/payer pending cash.
  paid_amount: Cash; // Sum of actual payment receipts, not rounded weekly slices.
  closed_entitlement_exact: Exact;
  consumed_exact: Exact;
  unpaid_exact: Exact;
  balances: ScopeBalance[];
  cash_payments: CashPayment[];
  unresolved_earnings: UnresolvedEarnings[];
  source_final: false;
}
export interface ScopeClaimResult {
  scope: CapturedScope;
  pool_id: UUID | null;
  new_payout: Cash;
  payment_ids: UUID[];
  deferred: { reason: string }[];
}
export interface CapturedRakebackClaimV2 {
  schema_version: 2;
  success: true;
  request_id: UUID;
  beneficiary_user_id: UUID;
  club_id: UUID | null;
  earning_closed_through: UTCDate;
  new_payout: Cash;
  payment_count: number;
  payments: CashPayment[]; // Only new money committed by THIS immutable request.
  scopes: ScopeClaimResult[];
  source_final: false;
}
