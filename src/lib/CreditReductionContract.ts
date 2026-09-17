// Exact v1 control receipts. These are not payments, chip movements or amounts due.
export interface CreditReductionSnapshot {
  contract_version: 1;
  actor_user_id: string;
  club_id: string;
  agent_id: string;
  target_user_id: string;
  credit_limit: string;
  credit_used: string;
  is_prepaid: boolean;
  control_revision: string;
  captured_at: string;
}
export interface CreditReductionIntent {
  actor_user_id: string;
  club_id: string;
  agent_id: string;
  target_user_id: string;
  action: 'reduce_credit_limit';
  requested_reduction: string;
  reason: string | null;
  before_limit: string;
  credit_used: string;
  before_prepaid: boolean;
  before_revision: string;
}
export interface CreditReductionReceipt extends CreditReductionIntent {
  contract_version: 1;
  receipt_id: string;
  operation_id: string;
  assignment_reason: string;
  after_limit: string;
  after_prepaid: boolean;
  after_revision: string;
  applied_reduction: string;
  assignment_id: string | null;
  document_id: string | null;
  invoice_id: string | null;
  recorded_at: string;
  outcome: 'applied' | 'no_change';
  payment_proven: false;
  chip_movement_claimed: false;
  amount_due_claimed: false;
}
export interface CreditReductionRetirement {
  contract_version: 1;
  retirement_id: string;
  actor_user_id: string;
  operation_id: string;
  club_id: string;
  state: 'retired';
  retired_at: string;
}
interface EnvelopeIdentity {
  contract_version: 1;
  actor_user_id: string;
  operation_id: string;
  club_id: string;
  replayed: boolean;
}
export type CreditReductionEnvelope = EnvelopeIdentity &
  (
    | { state: 'recorded'; receipt: Readonly<CreditReductionReceipt>; retirement: null }
    | { state: 'retired'; receipt: null; retirement: Readonly<CreditReductionRetirement> }
    | { state: 'absent'; receipt: null; retirement: null }
  );
export function creditContractError(): never {
  throw new Error(
    'The Credit Change Receipt Is Unconfirmed. Keep The Pending Change And Check Again.'
  );
}
export function creditUUID(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
    value !== '00000000-0000-0000-0000-000000000000'
  );
}
export function exactObject(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
export function creditCents(value: unknown, positive = false): bigint {
  if (typeof value !== 'string' || value.length > 16 || !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value))
    return creditContractError();
  const cents = BigInt(value.replace('.', ''));
  if (cents > 999999999999999n || (positive && (cents === 0n || cents > 100000000000n)))
    return creditContractError();
  return cents;
}
function revision(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value))
    return creditContractError();
  const number = BigInt(value);
  if (number > 9223372036854775807n) return creditContractError();
  return number;
}
function timestamp(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) ||
    value.startsWith('0000')
  )
    return creditContractError();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.slice(0, 23) + 'Z')
    return creditContractError();
}
function funding(limit: bigint, used: bigint, prepaid: unknown): void {
  if (
    typeof prepaid !== 'boolean' ||
    used > limit ||
    (prepaid ? limit !== 0n || used !== 0n : limit === 0n)
  )
    return creditContractError();
}
export function validateCreditIntent(
  value: CreditReductionIntent
): Readonly<CreditReductionIntent> {
  if (
    ![value.actor_user_id, value.club_id, value.agent_id, value.target_user_id].every(creditUUID) ||
    value.action !== 'reduce_credit_limit' ||
    (value.reason !== null && typeof value.reason !== 'string')
  )
    return creditContractError();
  creditCents(value.requested_reduction, true);
  revision(value.before_revision);
  funding(creditCents(value.before_limit), creditCents(value.credit_used), value.before_prepaid);
  return Object.freeze({ ...value });
}
export function parseCreditSnapshot(
  value: unknown,
  actor: string,
  club: string,
  target: string
): Readonly<CreditReductionSnapshot> {
  if (
    !exactObject(value, [
      'contract_version',
      'actor_user_id',
      'club_id',
      'agent_id',
      'target_user_id',
      'credit_limit',
      'credit_used',
      'is_prepaid',
      'control_revision',
      'captured_at',
    ]) ||
    value.contract_version !== 1 ||
    value.actor_user_id !== actor ||
    value.club_id !== club ||
    value.target_user_id !== target ||
    ![actor, club, target, value.agent_id].every(creditUUID)
  )
    return creditContractError();
  funding(creditCents(value.credit_limit), creditCents(value.credit_used), value.is_prepaid);
  revision(value.control_revision);
  timestamp(value.captured_at);
  return Object.freeze({ ...value }) as unknown as Readonly<CreditReductionSnapshot>;
}
export function receiptIntent(r: CreditReductionReceipt): Readonly<CreditReductionIntent> {
  return validateCreditIntent({
    actor_user_id: r.actor_user_id,
    club_id: r.club_id,
    agent_id: r.agent_id,
    target_user_id: r.target_user_id,
    action: r.action,
    requested_reduction: r.requested_reduction,
    reason: r.reason,
    before_limit: r.before_limit,
    credit_used: r.credit_used,
    before_prepaid: r.before_prepaid,
    before_revision: r.before_revision,
  });
}
export function creditIntentText(i: CreditReductionIntent): string {
  validateCreditIntent(i);
  return JSON.stringify([
    i.action,
    i.actor_user_id,
    i.club_id,
    i.agent_id,
    i.target_user_id,
    i.requested_reduction,
    i.before_limit,
    i.credit_used,
    i.before_prepaid,
    i.before_revision,
    i.reason,
  ]);
}
export function parseCreditEnvelope(
  value: unknown,
  expected: { actor: string; club: string; operation: string },
  mode: 'lookup' | 'apply' | 'retire',
  intent?: CreditReductionIntent
): Readonly<CreditReductionEnvelope> {
  const keys = [
    'contract_version',
    'state',
    'actor_user_id',
    'operation_id',
    'club_id',
    'replayed',
    'receipt',
    'retirement',
  ];
  if (
    !exactObject(value, keys) ||
    value.contract_version !== 1 ||
    value.actor_user_id !== expected.actor ||
    value.club_id !== expected.club ||
    value.operation_id !== expected.operation ||
    typeof value.replayed !== 'boolean' ||
    ![expected.actor, expected.club, expected.operation].every(creditUUID)
  )
    return creditContractError();
  if (value.state === 'absent') {
    if (
      mode !== 'lookup' ||
      value.replayed !== false ||
      value.receipt !== null ||
      value.retirement !== null
    )
      return creditContractError();
  } else if (value.state === 'retired') {
    const r = value.retirement;
    if (
      mode === 'apply' ||
      value.receipt !== null ||
      (mode === 'lookup' && value.replayed !== true) ||
      !exactObject(r, [
        'contract_version',
        'retirement_id',
        'actor_user_id',
        'operation_id',
        'club_id',
        'state',
        'retired_at',
      ]) ||
      r.contract_version !== 1 ||
      !creditUUID(r.retirement_id) ||
      r.actor_user_id !== expected.actor ||
      r.operation_id !== expected.operation ||
      r.club_id !== expected.club ||
      r.state !== 'retired'
    )
      return creditContractError();
    timestamp(r.retired_at);
    value = { ...value, retirement: Object.freeze({ ...r }) };
  } else if (value.state === 'recorded') {
    const r = value.receipt;
    if (
      value.retirement !== null ||
      (mode !== 'apply' && value.replayed !== true) ||
      !exactObject(r, [
        'contract_version',
        'receipt_id',
        'actor_user_id',
        'operation_id',
        'club_id',
        'agent_id',
        'target_user_id',
        'action',
        'requested_reduction',
        'reason',
        'assignment_reason',
        'before_limit',
        'after_limit',
        'credit_used',
        'before_prepaid',
        'after_prepaid',
        'before_revision',
        'after_revision',
        'applied_reduction',
        'assignment_id',
        'document_id',
        'invoice_id',
        'recorded_at',
        'outcome',
        'payment_proven',
        'chip_movement_claimed',
        'amount_due_claimed',
      ]) ||
      r.contract_version !== 1 ||
      !creditUUID(r.receipt_id) ||
      r.actor_user_id !== expected.actor ||
      r.club_id !== expected.club ||
      r.operation_id !== expected.operation ||
      r.payment_proven !== false ||
      r.chip_movement_claimed !== false ||
      r.amount_due_claimed !== false
    )
      return creditContractError();
    const original = receiptIntent(r as unknown as CreditReductionReceipt);
    if (intent && creditIntentText(original) !== creditIntentText(intent))
      return creditContractError();
    if (
      r.assignment_reason !==
      (original.reason === null || original.reason === '' ? 'Credit line reduced' : original.reason)
    )
      return creditContractError();
    const before = creditCents(r.before_limit),
      after = creditCents(r.after_limit),
      applied = creditCents(r.applied_reduction);
    const requested = creditCents(r.requested_reduction, true),
      used = creditCents(r.credit_used);
    if (applied !== (requested < before ? requested : before) || after !== before - applied)
      return creditContractError();
    funding(after, used, r.after_prepaid);
    timestamp(r.recorded_at);
    const nextRevision = revision(r.after_revision),
      oldRevision = revision(r.before_revision);
    const docs = [r.assignment_id, r.document_id, r.invoice_id];
    if (applied > 0n) {
      if (
        r.outcome !== 'applied' ||
        nextRevision !== oldRevision + 1n ||
        !docs.every(creditUUID) ||
        new Set(docs).size !== 3
      )
        return creditContractError();
    } else if (
      r.outcome !== 'no_change' ||
      before !== 0n ||
      after !== 0n ||
      used !== 0n ||
      r.before_prepaid !== true ||
      r.after_prepaid !== true ||
      nextRevision !== oldRevision ||
      docs.some((id) => id !== null)
    )
      return creditContractError();
    value = { ...value, receipt: Object.freeze({ ...r }) };
  } else return creditContractError();
  return Object.freeze({ ...(value as CreditReductionEnvelope) });
}

/** UI normalization happens once, before preparation. The service never rounds amounts. */
export function creditReductionAmount(input: string): string {
  if (
    typeof input !== 'string' ||
    input.length > 32 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(input)
  ) {
    throw new Error('Enter A Positive Credit Reduction With At Most Two Decimal Places');
  }
  const [whole, fraction = ''] = input.split('.');
  const text = `${whole}.${fraction.padEnd(2, '0')}`;
  creditCents(text, true);
  return text;
}
