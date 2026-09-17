import {
  assertChipAmount,
  prepareAgentCashoutOperation,
  captureAgentCashoutStart,
  captureAgentCashoutReceiptCheck,
  admitAgentCashoutStart,
  acknowledgeAgentCashoutStart,
  type AgentCashoutIntent,
  type PreparedAgentCashoutOperation,
  type CapturedAgentCashoutStart,
  type AdmittedAgentCashoutStart,
} from './AgentWalletIntent';
import { resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import { cashoutService, captureCashoutAccountGuard, type CashoutRequest } from './CashoutService';

export type CashoutKind = AgentCashoutIntent['kind'];
export interface CashoutOperationIntent<K extends CashoutKind = CashoutKind> {
  userId: string;
  clubId: string;
  targetId: string;
  /** Actual requester from the verified row; never infer it from the reviewing agent. */
  playerId: string;
  kind: K;
  amount: number;
  note?: string;
  /** Must retire on account, route/dialog, input or source-row revision changes. */
  isCurrent: () => boolean;
  /** Original account/view scope, independent of ordinary row refresh. */
  receiptViewCurrent?: () => boolean;
}
type CanonicalCashoutIntent = Readonly<Omit<CashoutOperationIntent, 'isCurrent' | 'receiptViewCurrent'>>;
declare const preparedBrand: unique symbol;
declare const startBrand: unique symbol;
export interface PreparedCashoutOperation<K extends CashoutKind = CashoutKind> {
  readonly kind: K;
  readonly clubId: string;
  readonly [preparedBrand]: true;
}
export interface CashoutStart<K extends CashoutKind = CashoutKind> {
  readonly kind: K;
  readonly clubId: string;
  readonly [startBrand]: true;
}
export type CashoutOperationResult<K extends CashoutKind> = K extends 'cashout_request' ? CashoutRequest : true;
export type CashoutRecoveryResult<K extends CashoutKind> =
  | { found: true; result: CashoutOperationResult<K> }
  | { found: false };
interface Preparation {
  intent: CanonicalCashoutIntent;
  operation: PreparedAgentCashoutOperation;
  receiptScope: () => boolean;
  isCurrent: () => boolean;
}
interface Start {
  intent: CanonicalCashoutIntent;
  operation: CapturedAgentCashoutStart;
  receiptScope: () => boolean;
  receiptOnly?: boolean;
  isCurrent: () => boolean;
  admitted?: AdmittedAgentCashoutStart;
  recovery?: Promise<CashoutRecoveryResult<CashoutKind>>;
  recovered?: CashoutRecoveryResult<CashoutKind>;
  confirmationObserved?: boolean;
  execution?: Promise<CashoutRequest | true>;
}
const preparations = new WeakMap<PreparedCashoutOperation, Preparation>();
const starts = new WeakMap<CashoutStart, Start>();
const submissions = new Map<string, {
  result: Promise<CashoutRequest | true>;
  isCurrent: () => boolean;
}>();

function canonicalUUID(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
      value === '00000000-0000-0000-0000-000000000000') {
    throw new Error('The Cashout Account Or Club Could Not Be Verified');
  }
  return value.toLowerCase();
}
function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new Error('The Account Or Cashout Changed. Refresh To Check Its Outcome.');
}
function accountAndViewGuard(userId: string, viewCurrent: () => boolean): () => boolean {
  if (typeof viewCurrent !== 'function') throw new Error('The Cashout View Could Not Be Verified');
  const accountCurrent = captureCashoutAccountGuard(userId);
  let valid = true;
  return () => (valid = valid && accountCurrent() && viewCurrent());
}

/**
 * Prepare while the form is idle. An unavailable or obsolete preparation cannot
 * become an accepted gesture after resolving an alias or hash. No money is sent.
 */
export async function prepareCashoutOperation<K extends CashoutKind>(
  input: CashoutOperationIntent<K>
): Promise<PreparedCashoutOperation<K>> {
  const captured = { ...input };
  const userId = canonicalUUID(captured.userId);
  const playerId = canonicalUUID(captured.playerId);
  const targetId = canonicalUUID(captured.targetId);
  const isCurrent = accountAndViewGuard(userId, captured.isCurrent);
  const receiptScope = captured.receiptViewCurrent
    ? accountAndViewGuard(userId, captured.receiptViewCurrent) : isCurrent;
  assertCurrent(isCurrent);
  assertCurrent(receiptScope);
  assertChipAmount(captured.amount);
  if (!['cashout_request', 'cashout_approve', 'cashout_decline', 'cashout_cancel'].includes(captured.kind) ||
      typeof captured.clubId !== 'string' || !captured.clubId.trim() ||
      (captured.note !== undefined && typeof captured.note !== 'string')) {
    throw new Error('The Cashout Intent Could Not Be Verified');
  }
  const note = (captured.note ?? '').trim();
  if ((captured.kind === 'cashout_request' && (userId !== playerId || targetId !== playerId)) ||
      (captured.kind === 'cashout_cancel' && (userId !== playerId || note !== '')) ||
      ((captured.kind === 'cashout_approve' || captured.kind === 'cashout_decline') && userId === playerId)) {
    throw new Error('The Cashout Action Does Not Match Its Original Player');
  }
  const clubId = canonicalUUID(await resolveClubUUIDStrict(captured.clubId));
  assertCurrent(isCurrent);
  const intent: CanonicalCashoutIntent = Object.freeze({ userId, playerId, targetId, clubId,
    kind: captured.kind, amount: captured.amount, note });
  const operation = await prepareAgentCashoutOperation(intent, isCurrent);
  assertCurrent(isCurrent);
  assertCurrent(receiptScope);
  const prepared = Object.freeze({ kind: captured.kind, clubId }) as PreparedCashoutOperation<K>;
  preparations.set(prepared, { intent, operation, isCurrent, receiptScope });
  return prepared;
}

/**
 * The accepted start is synchronous and pins the prepared generation. Call at
 * the gesture, BEFORE awaiting confirmation, settlement checks or anything else.
 * Do not prepare here on demand; a form without a current preparation must wait.
 */
export function captureCashoutStart<K extends CashoutKind>(
  prepared: PreparedCashoutOperation<K>
): CashoutStart<K> {
  const preparation = preparations.get(prepared);
  if (!preparation) throw new Error('Prepare This Cashout Before Starting It');
  assertCurrent(preparation.isCurrent);
  assertCurrent(preparation.receiptScope);
  const isCurrent = accountAndViewGuard(preparation.intent.userId, preparation.isCurrent);
  assertCurrent(isCurrent);
  const operation = captureAgentCashoutStart(preparation.operation, isCurrent);
  const start = Object.freeze({ kind: prepared.kind, clubId: prepared.clubId }) as CashoutStart<K>;
  starts.set(start, { intent: preparation.intent, operation, isCurrent, receiptScope: preparation.receiptScope });
  return start;
}

/**
 * Explicit receipt check for an in-view retained terminal intent. The original
 * account/view must still exist, even if its pending row has been refreshed.
 * This handle can never dispatch a payer, including after exact absence.
 */
export function captureCashoutReceiptCheck<K extends CashoutKind>(
  original: CashoutStart<K>, viewCurrent: () => boolean
): CashoutStart<K> {
  const prior = starts.get(original);
  if (!prior || prior.intent.kind === 'cashout_request' || typeof viewCurrent !== 'function') throw new Error('The Original Terminal Cashout Is Unavailable');
  assertCurrent(prior.receiptScope);
  const scope = accountAndViewGuard(prior.intent.userId, () => prior.receiptScope() && viewCurrent());
  assertCurrent(scope);
  const operation = captureAgentCashoutReceiptCheck(prior.operation, scope);
  const check = Object.freeze({ kind: original.kind, clubId: original.clubId }) as CashoutStart<K>;
  starts.set(check, { intent: prior.intent, operation, isCurrent: scope, receiptScope: scope, receiptOnly: true });
  return check;
}

/** Check the same accepted start after caller-owned preflight waits and before UI updates. */
export function assertCashoutStartCurrent(start: CashoutStart): void {
  const captured = starts.get(start);
  if (!captured) throw new Error('The Cashout Start Could Not Be Verified');
  assertCurrent(captured.isCurrent);
}

/**
 * Admit the exact accepted generation, then check its canonical past outcome
 * BEFORE caller-owned payment gates. Unknown is a refusal, never absence.
 * A second call on this start shares its original lookup, including a failure.
 */
export async function recoverCashoutOperation<K extends CashoutKind>(
  start: CashoutStart<K>
): Promise<CashoutRecoveryResult<K>> {
  const captured = starts.get(start);
  if (!captured) throw new Error('Prepare And Capture The Cashout Before Checking It');
  assertCurrent(captured.isCurrent);
  if (!captured.recovery) {
    captured.recovery = observeCashoutReceipt(captured);
  }
  const outcome = await captured.recovery;
  assertCurrent(captured.isCurrent);
  return outcome as CashoutRecoveryResult<K>;
}

async function observeCashoutReceipt(captured: Start): Promise<CashoutRecoveryResult<CashoutKind>> {
  const admitted = captured.admitted ?? await admitAgentCashoutStart(captured.operation);
  assertCurrent(captured.isCurrent);
  captured.admitted = admitted;
  const intent = captured.intent;
  const kind = intent.kind === 'cashout_request' ? 'hold' : intent.kind === 'cashout_approve' ? 'approval'
    : intent.kind === 'cashout_decline' ? 'decline' : 'cancellation';
  const lookup = await cashoutService.lookupCashoutOperation(intent.userId, admitted.operationId,
    { clubId: intent.clubId, amount: intent.amount, playerId: intent.playerId, isCurrent: captured.isCurrent },
    kind, kind === 'hold' ? undefined : intent.targetId, intent.note || undefined);
  assertCurrent(captured.isCurrent);
  const outcome: CashoutRecoveryResult<CashoutKind> = lookup.found
    ? { found: true, result: kind === 'hold' ? lookup.request : true } : { found: false };
  if (outcome.found) {
    await acknowledgeAgentCashoutStart(admitted);
    assertCurrent(captured.isCurrent);
  }
  captured.recovered = outcome;
  return outcome;
}

/**
 * One additional observation for an explicit hold-confirmation gesture. Another
 * tab may have completed this same operation while its dialog was open. Revoke
 * the earlier absence BEFORE awaiting anything; unknown cannot authorize pay.
 * The original admitted start, intent and generation remain unchanged.
 */
export async function confirmCashoutOperation(
  start: CashoutStart<'cashout_request'>
): Promise<CashoutRecoveryResult<'cashout_request'>> {
  const captured = starts.get(start);
  if (!captured || captured.intent.kind !== 'cashout_request' || captured.receiptOnly || !captured.admitted || captured.execution) {
    throw new Error('The Original Cashout Confirmation Could Not Be Verified');
  }
  assertCurrent(captured.isCurrent);
  if (!captured.confirmationObserved) {
    if (!captured.recovered || captured.recovered.found) throw new Error('Check The Original Cashout Before Confirming It');
    captured.confirmationObserved = true;
    captured.recovered = undefined;
    captured.recovery = observeCashoutReceipt(captured);
  }
  const outcome = await captured.recovery;
  assertCurrent(captured.isCurrent);
  return outcome as CashoutRecoveryResult<'cashout_request'>;
}

async function submitCashout(start: Start, operationId: string): Promise<CashoutRequest | true> {
  const intent = start.intent;
  assertCurrent(start.isCurrent);
  if (intent.kind === 'cashout_request') {
    return cashoutService.requestCashout(intent.playerId, intent.clubId, intent.amount,
      intent.note || undefined, operationId, start.isCurrent);
  }
  const context = { clubId: intent.clubId, amount: intent.amount, playerId: intent.playerId,
    isCurrent: start.isCurrent };
  // This transport selection contains no financial rules. The existing service
  // and database still own eligibility, exact receipt validation and all writes.
  const result = intent.kind === 'cashout_cancel'
    ? await cashoutService.cancelCashout(intent.targetId, intent.userId, operationId, context)
    : intent.kind === 'cashout_approve'
      ? await cashoutService.approveCashout(intent.targetId, intent.userId, intent.note || undefined, operationId, context)
      : await cashoutService.rejectCashout(intent.targetId, intent.userId, intent.note || undefined, operationId, context);
  if (result !== true) throw new Error('The Cashout Receipt Was Not Confirmed');
  return true;
}

/**
 * Only a captured start with an exact completed lookup can dispatch after its
 * caller's new-payment gates. A found result is the actual canonical receipt.
 * Overlapping starts may share the service call; no durable receipt cache exists.
 */
export async function runCashoutOperation<K extends CashoutKind>(
  start: CashoutStart<K>
): Promise<CashoutOperationResult<K>> {
  const captured = starts.get(start);
  if (!captured) throw new Error('Prepare And Capture The Cashout Before Starting It');
  assertCurrent(captured.isCurrent);
  if (captured.receiptOnly) throw new Error('This Action Can Only Check The Original Cashout Receipt');
  if (!captured.admitted || !captured.recovered) throw new Error('Check The Exact Cashout Outcome Before New Payment Checks');
  if (captured.recovered.found) return captured.recovered.result as CashoutOperationResult<K>;
  if (!captured.execution) {
    captured.execution = (async () => {
      const admitted = captured.admitted!;
      assertCurrent(captured.isCurrent);
      const intent = captured.intent;
      const key = JSON.stringify([admitted.operationId, intent.userId, intent.clubId, intent.targetId,
        intent.playerId, intent.kind, intent.amount.toFixed(2), intent.note]);
      let submission = submissions.get(key);
      if (!submission || !submission.isCurrent()) {
        // A reopened view can explicitly recover the same operation while an
        // old response is still in flight. It must not inherit a retired guard.
        const current = submitCashout(captured, admitted.operationId).finally(() => {
          if (submissions.get(key)?.result === current) submissions.delete(key);
        });
        submission = { result: current, isCurrent: captured.isCurrent };
        submissions.set(key, submission);
      }
      const result = await submission.result;
      assertCurrent(captured.isCurrent);
      // This acknowledges operation coordination only. The service returned the
      // canonical financial outcome; a storage failure must not erase that fact.
      await acknowledgeAgentCashoutStart(admitted);
      assertCurrent(captured.isCurrent);
      return result;
    })();
  }
  const result = await captured.execution;
  assertCurrent(captured.isCurrent);
  return result as CashoutOperationResult<K>;
}
