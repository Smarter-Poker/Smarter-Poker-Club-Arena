import type {
  CapturedScope,
  CashPayment,
  CapturedRakebackReadV2,
  CapturedRakebackClaimV2,
} from '../types/capturedRakeback';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXACT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const CASH = /^(?:0|[1-9][0-9]*)\.[0-9]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/;
function requireValue(ok: unknown): asserts ok {
  if (!ok) throw new Error('Rakeback Evidence Could Not Be Verified. Saved Claims Are Preserved.');
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  requireValue(Array.isArray(value));
  return value;
}
function uuid(value: unknown): string {
  requireValue(typeof value === 'string' && UUID.test(value));
  return value;
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function count(value: unknown): number {
  requireValue(Number.isSafeInteger(value) && Number(value) >= 0);
  return value as number;
}
function exact(value: unknown): string {
  requireValue(typeof value === 'string' && EXACT.test(value));
  return value;
}
function cash(value: unknown): string {
  requireValue(typeof value === 'string' && CASH.test(value));
  return value;
}
function decimal(value: string): { n: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.');
  return { n: BigInt(whole + fraction), scale: fraction.length };
}
function normalized(n: bigint, scale: number): string {
  requireValue(n >= 0n);
  if (scale === 0) return n.toString();
  const digits = n.toString().padStart(scale + 1, '0');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return digits.slice(0, -scale) + (fraction ? '.' + fraction : '');
}
export function sumExact(values: string[]): string {
  let total = 0n,
    scale = 0;
  for (const value of values) {
    const next = decimal(value),
      target = Math.max(scale, next.scale);
    total = total * 10n ** BigInt(target - scale) + next.n * 10n ** BigInt(target - next.scale);
    scale = target;
  }
  return normalized(total, scale);
}
function subtract(left: string, right: string): string {
  const a = decimal(left),
    b = decimal(right),
    scale = Math.max(a.scale, b.scale);
  return normalized(
    a.n * 10n ** BigInt(scale - a.scale) - b.n * 10n ** BigInt(scale - b.scale),
    scale
  );
}
function equals(left: string, right: string): boolean {
  return sumExact([left]) === sumExact([right]);
}
function cashFromCents(value: bigint): string {
  requireValue(value >= 0n);
  return (value / 100n).toString() + '.' + (value % 100n).toString().padStart(2, '0');
}
export function sumCash(values: string[]): string {
  return cashFromCents(
    values.reduce((total, value) => total + BigInt(cash(value).replace('.', '')), 0n)
  );
}
function floorCash(value: string): string {
  const part = decimal(value);
  return cashFromCents((part.n * 100n) / 10n ** BigInt(part.scale));
}
export function formatRakebackCash(value: string, locales?: string | string[]): string {
  const [whole, fraction] = cash(value).split('.');
  const decimalMark =
    new Intl.NumberFormat(locales).formatToParts(1.1).find((part) => part.type === 'decimal')
      ?.value ?? '.';
  return BigInt(whole).toLocaleString(locales) + decimalMark + fraction;
}

/** The legacy bus amount is optional and only a refresh hint. Never round an
 * unrepresentable payment into that numeric field; the authoritative UI stays exact. */
export function cashRefreshAmount(value: string): number | undefined {
  const cents = BigInt(cash(value).replace('.', ''));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const valueNumber = Number(cents) / 100;
  return BigInt(valueNumber.toFixed(2).replace('.', '')) === cents ? valueNumber : undefined;
}
function date(value: unknown, monday = false): string {
  requireValue(typeof value === 'string' && DATE.test(value));
  const parsed = new Date(value + 'T00:00:00Z');
  requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value);
  requireValue(!monday || parsed.getUTCDay() === 1);
  return value;
}
function week(start: unknown, end: unknown): string {
  const first = date(start, true),
    last = date(end);
  requireValue(Date.parse(last) - Date.parse(first) === 6 * 86400000);
  return first;
}
function scope(value: unknown): CapturedScope {
  const row = object(value);
  uuid(row.club_id);
  nullableUuid(row.funding_union_id);
  uuid(row.payer_user_id);
  requireValue(row.contract_version === 1);
  requireValue(
    row.funding_route === 'union_rake_wallet' || row.funding_route === 'club_chip_treasury'
  );
  requireValue((row.funding_route === 'union_rake_wallet') === (row.funding_union_id !== null));
  return row as unknown as CapturedScope;
}
export function capturedScopeKey(value: CapturedScope): string {
  return JSON.stringify([
    value.club_id,
    value.funding_union_id,
    value.funding_route,
    value.contract_version,
    value.payer_user_id,
  ]);
}
function poolScopeKey(value: CapturedScope): string {
  return JSON.stringify([
    value.club_id,
    value.funding_union_id,
    value.funding_route,
    value.contract_version,
  ]);
}
function pools() {
  const byPool = new Map<string, string>(),
    byScope = new Map<string, string | null>();
  return (value: CapturedScope, pool: string | null) => {
    const key = poolScopeKey(value);
    requireValue(!byScope.has(key) || byScope.get(key) === pool);
    byScope.set(key, pool);
    if (pool === null) return;
    requireValue(!byPool.has(pool) || byPool.get(pool) === key);
    byPool.set(pool, key);
  };
}

function payments(
  value: unknown,
  beneficiary: string,
  cutoff: string,
  bindPool: ReturnType<typeof pools>
): CashPayment[] {
  const ids = new Set<string>();
  const sourceOwners = new Map<string, string>();
  return list(value).map((item) => {
    const row = object(item),
      id = uuid(row.payment_id),
      captured = scope(row.scope),
      pool = uuid(row.pool_id);
    requireValue(!ids.has(id));
    ids.add(id);
    requireValue(uuid(row.beneficiary_user_id) === beneficiary);
    requireValue(captured.payer_user_id !== beneficiary);
    bindPool(captured, pool);
    const amount = cash(row.amount),
      through = date(row.earning_closed_through, true);
    requireValue(amount !== '0.00' && through <= cutoff);
    requireValue(typeof row.paid_at === 'string' && INSTANT.test(row.paid_at));
    date(row.paid_at.slice(0, 10));
    requireValue(Number.isFinite(Date.parse(row.paid_at)) && row.paid_at.slice(0, 10) >= through);
    const seen = new Set<string>();
    const amounts = list(row.earning_slices).map((entry) => {
      const slice = object(entry),
        hand = uuid(slice.hand_id),
        contributor = uuid(slice.contributor_id);
      requireValue(contributor === beneficiary);
      const key = hand + ':' + contributor;
      requireValue(!seen.has(key));
      seen.add(key);
      const start = date(slice.week_start, true);
      requireValue(start < through);
      const owner = JSON.stringify([capturedScopeKey(captured), pool, start]);
      requireValue(!sourceOwners.has(key) || sourceOwners.get(key) === owner);
      sourceOwners.set(key, owner);
      const value = exact(slice.amount_exact);
      requireValue(value !== '0');
      return value;
    });
    requireValue(equals(sumExact(amounts), amount));
    return row as unknown as CashPayment;
  });
}
export function parseCapturedRakeback(
  value: unknown,
  expectedUserId: string
): CapturedRakebackReadV2 {
  const data = object(value),
    beneficiary = uuid(data.beneficiary_user_id);
  requireValue(
    beneficiary === uuid(expectedUserId) && data.schema_version === 2 && data.source_final === false
  );
  requireValue(typeof data.source_active === 'boolean');
  const cutoff = date(data.earning_closed_through, true),
    bindPool = pools();
  const cashPayments = payments(data.cash_payments, beneficiary, cutoff, bindPool);
  const paymentWeeks = new Map<string, string[]>();
  for (const payment of cashPayments)
    for (const slice of payment.earning_slices) {
      const key = capturedScopeKey(payment.scope) + ':' + slice.week_start;
      paymentWeeks.set(key, [...(paymentWeeks.get(key) ?? []), slice.amount_exact]);
    }
  const seen = new Set<string>();
  const balances = list(data.balances).map((item) => {
    const row = object(item),
      captured = scope(row.scope),
      key = capturedScopeKey(captured),
      pool = nullableUuid(row.pool_id);
    requireValue(!seen.has(key));
    seen.add(key);
    bindPool(captured, pool);
    requireValue(captured.payer_user_id !== beneficiary);
    const closed = exact(row.closed_entitlement_exact),
      consumed = exact(row.consumed_exact),
      unpaid = exact(row.unpaid_exact);
    const pending = cash(row.pending_amount),
      paid = cash(row.paid_amount);
    requireValue(equals(consumed, paid) && equals(subtract(closed, consumed), unpaid));
    requireValue(equals(subtract(floorCash(closed), paid), pending));
    const matching = cashPayments.filter((payment) => capturedScopeKey(payment.scope) === key);
    requireValue(matching.every((payment) => payment.pool_id === pool));
    requireValue(sumCash(matching.map((payment) => payment.amount)) === paid);
    const weeks = new Set<string>(),
      closedAmounts: string[] = [],
      consumedAmounts: string[] = [];
    for (const item of list(row.earning_weeks)) {
      const earning = object(item),
        start = week(earning.week_start, earning.week_end);
      requireValue(!weeks.has(start));
      weeks.add(start);
      requireValue(typeof earning.closed === 'boolean' && earning.closed === start < cutoff);
      const entitled = exact(earning.entitlement_exact),
        used = exact(earning.consumed_exact);
      requireValue(equals(subtract(entitled, used), exact(earning.remaining_exact)));
      requireValue(count(earning.funding_admitted_source_count) <= count(earning.source_count));
      requireValue(earning.closed || used === '0');
      requireValue(equals(sumExact(paymentWeeks.get(key + ':' + start) ?? []), used));
      if (earning.closed) closedAmounts.push(entitled);
      consumedAmounts.push(used);
    }
    requireValue(
      matching.every((payment) =>
        payment.earning_slices.every((slice) => weeks.has(slice.week_start))
      )
    );
    requireValue(
      equals(sumExact(closedAmounts), closed) && equals(sumExact(consumedAmounts), consumed)
    );
    return row as unknown as CapturedRakebackReadV2['balances'][number];
  });
  requireValue(cashPayments.every((payment) => seen.has(capturedScopeKey(payment.scope))));
  const unresolved = new Set<string>();
  for (const item of list(data.unresolved_earnings)) {
    const row = object(item),
      key = uuid(row.club_id) + ':' + week(row.week_start, row.week_end);
    requireValue(!unresolved.has(key));
    unresolved.add(key);
    count(row.source_count);
    const reasons = list(row.reasons);
    requireValue(
      reasons.length > 0 &&
        reasons.every((reason) => typeof reason === 'string' && reason.trim().length > 0)
    );
    requireValue(new Set(reasons).size === reasons.length);
  }
  requireValue(cash(data.pending_amount) === sumCash(balances.map((row) => row.pending_amount)));
  requireValue(cash(data.paid_amount) === sumCash(cashPayments.map((row) => row.amount)));
  for (const field of ['closed_entitlement_exact', 'consumed_exact', 'unpaid_exact'] as const)
    requireValue(equals(exact(data[field]), sumExact(balances.map((row) => row[field]))));
  if (!data.source_active) {
    requireValue(balances.length === 0 && cashPayments.length === 0 && unresolved.size === 0);
    requireValue(data.pending_amount === '0.00' && data.paid_amount === '0.00');
    requireValue(
      data.closed_entitlement_exact === '0' &&
        data.consumed_exact === '0' &&
        data.unpaid_exact === '0'
    );
  }
  return data as unknown as CapturedRakebackReadV2;
}
export function parseCapturedRakebackClaim(
  value: unknown,
  request: { requestId: string; expectedUserId: string; clubId: string | null }
): CapturedRakebackClaimV2 {
  const data = object(value),
    beneficiary = uuid(data.beneficiary_user_id),
    cutoff = date(data.earning_closed_through, true);
  requireValue(data.schema_version === 2 && data.success === true && data.source_final === false);
  requireValue(
    uuid(data.request_id) === request.requestId && beneficiary === request.expectedUserId
  );
  requireValue(nullableUuid(data.club_id) === request.clubId);
  const bindPool = pools(),
    paid = payments(data.payments, beneficiary, cutoff, bindPool);
  requireValue(
    count(data.payment_count) === paid.length &&
      cash(data.new_payout) === sumCash(paid.map((payment) => payment.amount))
  );
  const byId = new Map(paid.map((payment) => [payment.payment_id, payment]));
  const used = new Set<string>(),
    scopes = new Set<string>();
  for (const item of list(data.scopes)) {
    const row = object(item),
      captured = scope(row.scope),
      key = capturedScopeKey(captured),
      pool = nullableUuid(row.pool_id);
    requireValue(!scopes.has(key));
    scopes.add(key);
    bindPool(captured, pool);
    requireValue(captured.payer_user_id !== beneficiary);
    requireValue(request.clubId === null || captured.club_id === request.clubId);
    const amounts = list(row.payment_ids).map((value) => {
      const id = uuid(value),
        payment = byId.get(id);
      requireValue(payment && !used.has(id));
      used.add(id);
      requireValue(capturedScopeKey(payment.scope) === key && payment.pool_id === pool);
      return payment.amount;
    });
    requireValue(cash(row.new_payout) === sumCash(amounts));
    for (const value of list(row.deferred)) {
      const reason = object(value).reason;
      requireValue(typeof reason === 'string' && reason.trim().length > 0);
    }
  }
  requireValue(used.size === paid.length);
  return data as unknown as CapturedRakebackClaimV2;
}
