import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { captureCashoutAccountGuard } from './CashoutService';
import { resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import { createGenerationCoordinator, type OperationReference, type PreparedOperation,
  type CapturedOperation, type AdmittedOperation } from '../lib/DurableOperationCoordinator';
import { creditUUID, exactObject, creditContractError, creditCents, creditIntentText, receiptIntent,
  parseCreditSnapshot, parseCreditEnvelope, type CreditReductionIntent, type CreditReductionEnvelope } from '../lib/CreditReductionContract';

const INDEX = 'smarter-poker:credit-reduction-pending:v1:';
const savedError = 'The Saved Credit Change Is Unavailable. Keep Its Browser Data And Check The Original Account.';
const scopeError = 'The Account Or Credit Form Changed. This Change May Have Committed; Check The Original Account.';
const generations = createGenerationCoordinator({
  historyPrefix:'smarter-poker:credit-reduction-generations:v1:',
  legacyPrefix:'smarter-poker:credit-reduction-identity:v1:', markerPrefix:'credit-reduction-generations:v1:',
  allowLegacyAdoption:false, identityError:savedError, storageError:'This Browser Cannot Safely Save A Credit Change', scopeError,
});
interface PendingRecord {
  lane: string; reference: OperationReference; state: 'initializing' | 'active' | 'settled';
}
interface PendingIndex { version: 1; records: PendingRecord[] }
interface Scope { actor: string; club: string; key: string; current: () => boolean }
interface Preparation extends Scope {
  intent: Readonly<CreditReductionIntent>; lane: string; operation: PreparedOperation; receiptCurrent: () => boolean;
}
interface Start extends Scope {
  intent?: Readonly<CreditReductionIntent>; lane: string; operation: CapturedOperation; receiptOnly: boolean;
  admitted?: AdmittedOperation; admission?: Promise<void>; acknowledged?: boolean;
  lookup?: Promise<Readonly<CreditReductionEnvelope>>; observed?: Readonly<CreditReductionEnvelope>;
  execution?: Promise<Readonly<CreditReductionEnvelope>>; retirement?: Promise<Readonly<CreditReductionEnvelope>>;
}
declare const preparedBrand: unique symbol;
declare const startBrand: unique symbol;
declare const pendingBrand: unique symbol;
export interface PreparedCreditReduction { readonly clubId: string; readonly [preparedBrand]: true }
export interface CreditReductionStart { readonly operationId: string; readonly [startBrand]: true }
export interface PendingCreditReduction { readonly operationId: string; readonly [pendingBrand]: true }
const preparations = new WeakMap<PreparedCreditReduction, Preparation>();
const starts = new WeakMap<CreditReductionStart, Start>();
const pending = new WeakMap<PendingCreditReduction, Scope & { record: PendingRecord; operation: PreparedOperation }>();
const applying = new Map<string, Promise<unknown>>();

function current(check: () => boolean): void { if (check() !== true) throw new Error(scopeError); }
function guard(actor: string, view: () => boolean): () => boolean {
  if (!creditUUID(actor) || typeof view !== 'function') throw new Error(scopeError);
  const account = captureCashoutAccountGuard(actor); let valid = true;
  return () => (valid = valid && account() && view());
}
function storage(): Storage {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues || typeof window === 'undefined' ||
      typeof navigator === 'undefined' || !navigator.locks) throw new Error(savedError);
  return window.localStorage;
}
async function hash(text: string, check: () => boolean): Promise<string> {
  storage(); current(check);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); current(check);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
}
function opaqueHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function referenceValid(value: unknown): value is OperationReference {
  return exactObject(value,['hash','historyId','generation','operationId','repeatable']) && opaqueHash(value.hash) &&
    creditUUID(value.historyId) && creditUUID(value.operationId) && Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0 && value.repeatable === true;
}
function readIndex(scope: Scope): PendingIndex {
  current(scope.current); const raw = storage().getItem(scope.key);
  if (raw === null) return { version:1, records:[] };
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error(savedError); }
  if (!exactObject(value,['version','records']) || value.version !== 1 || !Array.isArray(value.records)) throw new Error(savedError);
  const operations = new Set<string>(), unresolved = new Set<string>();
  for (const r of value.records) {
    if (!exactObject(r,['lane','reference','state']) || !opaqueHash(r.lane) || !referenceValid(r.reference) ||
        !['initializing','active','settled'].includes(r.state as string) || operations.has(r.reference.operationId) ||
        (r.state !== 'settled' && unresolved.has(r.lane))) throw new Error(savedError);
    operations.add(r.reference.operationId); if (r.state !== 'settled') unresolved.add(r.lane);
  }
  return value as unknown as PendingIndex;
}
function saveIndex(scope: Scope, value: PendingIndex): void {
  current(scope.current); const encoded = JSON.stringify(value), store = storage();
  store.setItem(scope.key, encoded); if (store.getItem(scope.key) !== encoded) throw new Error(savedError);
}
async function scopeFor(actor: string, clubInput: string, view: () => boolean): Promise<Scope> {
  const check = guard(actor,view); current(check);
  const club = await resolveClubUUIDStrict(clubInput); current(check);
  if (!creditUUID(club)) return creditContractError();
  const key = INDEX + await hash(JSON.stringify(['credit-reduction-index-v1',actor,club]),check);
  return { actor,club,key,current:check };
}
async function laneFor(intent: CreditReductionIntent, check: () => boolean): Promise<string> {
  // Target account survives agent-row replacement. The exact agent PK is separately in the full intent digest.
  return hash(JSON.stringify(['reduce-credit-lane-v1',intent.actor_user_id,intent.club_id,intent.target_user_id,intent.action]),check);
}
async function rpc(name: string, args: Record<string, unknown>, check: () => boolean): Promise<unknown> {
  current(check);
  let response;
  try { response = await supabase.rpc(name, args); } catch {
    current(check); throw new Error('The Credit Change Response Was Lost. Keep The Pending Change And Check Its Receipt.');
  }
  current(check);
  if (response.error) throw new Error('The Credit Change Is Unconfirmed. Check Its Receipt Or Cancel The Pending Change.');
  return response.data;
}

/** Preparation is idle work. No accepted start or mutation exists until capture/admission. */
export async function prepareCreditReduction(input: {
  actorId: string; clubId: string; targetUserId: string; amount: string; reason: string | null;
  isCurrent: () => boolean; receiptViewCurrent: () => boolean;
}): Promise<PreparedCreditReduction> {
  const captured = { ...input };
  creditCents(captured.amount,true);
  if (!creditUUID(captured.targetUserId) || (captured.reason !== null && typeof captured.reason !== 'string')) return creditContractError();
  const receiptCurrent = guard(captured.actorId,captured.receiptViewCurrent); current(receiptCurrent);
  const scope = await scopeFor(captured.actorId,captured.clubId,captured.isCurrent);
  const value = await rpc('fn_agent_credit_reduction_snapshot_v1', {
    p_expected_actor_id:scope.actor,p_club_id:scope.club,p_target_user_id:captured.targetUserId,
  },scope.current);
  const snapshot = parseCreditSnapshot(value,scope.actor,scope.club,captured.targetUserId);
  const intent: Readonly<CreditReductionIntent> = Object.freeze({ actor_user_id:scope.actor,club_id:scope.club,
    agent_id:snapshot.agent_id,target_user_id:snapshot.target_user_id,action:'reduce_credit_limit',
    requested_reduction:captured.amount,reason:captured.reason,before_limit:snapshot.credit_limit,
    credit_used:snapshot.credit_used,before_prepaid:snapshot.is_prepaid,before_revision:snapshot.control_revision });
  const digest = await hash(creditIntentText(intent),scope.current), lane = await laneFor(intent,scope.current);
  const operation = await navigator.locks.request(scope.key,{ mode:'exclusive' },async () => {
    current(scope.current); const index = readIndex(scope);
    const prior = index.records.find(r => r.lane === lane && r.state !== 'settled');
    if (prior) {
      if (prior.reference.hash !== digest) throw new Error('This Agent Has A Pending Credit Change. Check Or Cancel It Before Starting Another.');
      return generations.restore(prior.reference,scope.current);
    }
    return generations.prepare(digest,true,scope.current);
  });
  current(scope.current); current(receiptCurrent);
  const prepared = Object.freeze({ clubId:scope.club }) as PreparedCreditReduction;
  preparations.set(prepared,{ ...scope,intent,lane,operation,receiptCurrent }); return prepared;
}

/** Synchronous gesture fence. Never prepare on demand inside a submit handler. */
export function captureCreditReduction(prepared: PreparedCreditReduction): CreditReductionStart {
  const p = preparations.get(prepared); if (!p) throw new Error('Prepare The Credit Change Before Starting It');
  current(p.current); current(p.receiptCurrent);
  const operation = generations.capture(p.operation,p.current);
  const start = Object.freeze({ operationId:generations.reference(operation).operationId }) as CreditReductionStart;
  starts.set(start,{ ...p,operation,receiptOnly:false }); return start;
}
export function assertCreditReductionCurrent(start: CreditReductionStart): void {
  const s = starts.get(start); if (!s) throw new Error(savedError); current(s.current);
}

async function admit(s: Start): Promise<void> {
  if (!s.admission) s.admission = navigator.locks.request(s.key,{ mode:'exclusive' },async () => {
    current(s.current); const index = readIndex(s), reference = generations.reference(s.operation);
    let record = index.records.find(r => r.reference.operationId === reference.operationId);
    if (record && (record.lane !== s.lane || JSON.stringify(record.reference) !== JSON.stringify(reference))) throw new Error(savedError);
    if (!record) {
      if (s.receiptOnly) throw new Error(savedError);
      if (index.records.some(r => r.lane === s.lane && r.state !== 'settled')) {
        throw new Error('This Agent Has A Pending Credit Change. Check Or Cancel It First.');
      }
      record = { lane:s.lane,reference,state:'initializing' }; index.records.push(record);
      // First stage the discoverable opaque identity. A crash now is recoverable
      // only as this operation, including if durable start admission never finished.
      saveIndex(s,index);
    }
    s.admitted = await generations.admit(s.operation); current(s.current);
    s.acknowledged = record.state === 'settled' || await generations.wasAcknowledged(s.admitted);
    current(s.current);
    if (record.state === 'initializing') { record.state = 'active'; saveIndex(s,index); }
  });
  await s.admission; current(s.current);
}
async function validateResult(s: Start, value: unknown, mode: 'lookup'|'apply'|'retire'): Promise<Readonly<CreditReductionEnvelope>> {
  const ref = generations.reference(s.operation);
  const result = parseCreditEnvelope(value,{ actor:s.actor,club:s.club,operation:ref.operationId },mode,s.intent);
  if (result.state === 'recorded') {
    const original = receiptIntent(result.receipt);
    if (await hash(creditIntentText(original),s.current) !== ref.hash || await laneFor(original,s.current) !== s.lane) return creditContractError();
  }
  current(s.current);
  if (result.state !== 'absent') {
    // Failure to acknowledge preserves both the verified result and the blocked
    // lane. Neither a UI timeout nor an RPC error can settle this record.
    try {
      await navigator.locks.request(s.key,{ mode:'exclusive' },async () => {
        current(s.current); const index = readIndex(s);
        const record = index.records.find(r => r.reference.operationId === ref.operationId);
        if (!record || record.lane !== s.lane || JSON.stringify(record.reference) !== JSON.stringify(ref)) throw new Error(savedError);
        if (!s.admitted || !(await generations.acknowledge(s.admitted))) return;
        current(s.current); record.state = 'settled'; saveIndex(s,index);
      });
    } catch { /* Keep known server result; pending identity remains for recovery. */ }
    current(s.current);
    if (result.state === 'recorded') masterBus.emit('CREDIT_UPDATED',{ clubId:s.club,userId:result.receipt.target_user_id });
  }
  return result;
}
function identityArgs(s: Start): Record<string, unknown> {
  return { p_expected_actor_id:s.actor,p_operation_id:generations.reference(s.operation).operationId,p_club_id:s.club };
}
export async function recoverCreditReduction(start: CreditReductionStart): Promise<Readonly<CreditReductionEnvelope>> {
  const s = starts.get(start); if (!s) throw new Error(savedError); current(s.current);
  if (!s.lookup) s.lookup = (async () => {
    await admit(s);
    const result = await validateResult(s,await rpc('fn_agent_credit_reduction_receipt_v1',identityArgs(s),s.current),'lookup');
    if (result.state === 'absent' && s.acknowledged) return creditContractError();
    s.observed = result; return result;
  })();
  const result = await s.lookup; current(s.current); return result;
}
export async function runCreditReduction(start: CreditReductionStart): Promise<Readonly<CreditReductionEnvelope>> {
  const s = starts.get(start); if (!s) throw new Error(savedError); current(s.current);
  const observation = await recoverCreditReduction(start); current(s.current);
  if (observation.state !== 'absent') return observation;
  if (s.receiptOnly || !s.intent || s.acknowledged || s.retirement) throw new Error('This Pending Change Can Only Be Checked Or Cancelled');
  if (!s.execution) {
    const key = `${s.key}:${start.operationId}`;
    let transport = applying.get(key);
    if (!transport) {
      const i = s.intent;
      transport = rpc('fn_reduce_agent_credit_v1',{
        ...identityArgs(s),p_agent_id:i.agent_id,p_target_user_id:i.target_user_id,p_requested_reduction:i.requested_reduction,
        p_expected_credit_limit:i.before_limit,p_expected_credit_used:i.credit_used,p_expected_is_prepaid:i.before_prepaid,
        p_expected_revision:i.before_revision,p_reason:i.reason,
      },s.current);
      applying.set(key,transport);
      const original = transport;
      void original.finally(() => { if (applying.get(key) === original) applying.delete(key); }).catch(() => undefined);
    }
    // Each accepted start validates and acknowledges its own pointer even when
    // the physical transport is shared. An older acknowledgment cannot consume it.
    const shared = transport;
    s.execution = (async () => validateResult(s,await shared,'apply'))();
  }
  const result = await s.execution; current(s.current); return result;
}
/** Explicit server retirement is the only way to abandon an absent/unknown operation. */
export async function retireCreditReduction(start: CreditReductionStart): Promise<Readonly<CreditReductionEnvelope>> {
  const s = starts.get(start); if (!s) throw new Error(savedError); current(s.current);
  if (!s.retirement) s.retirement = (async () => {
    await admit(s);
    return validateResult(s,await rpc('fn_retire_agent_credit_reduction_v1',identityArgs(s),s.current),'retire');
  })();
  const result = await s.retirement; current(s.current); return result;
}

/** Discover only this account/club's unresolved opaque records, even after reload or agent deletion. */
export async function listPendingCreditReductions(actor: string, club: string, view: () => boolean): Promise<PendingCreditReduction[]> {
  const scope = await scopeFor(actor,club,view);
  return navigator.locks.request(scope.key,{ mode:'exclusive' },async () => {
    const index = readIndex(scope); const rows: PendingCreditReduction[] = [];
    for (const record of index.records.filter(r => r.state !== 'settled')) {
      const operation = await generations.restore(record.reference,scope.current); current(scope.current);
      const handle = Object.freeze({ operationId:record.reference.operationId }) as PendingCreditReduction;
      pending.set(handle,{ ...scope,record,operation }); rows.push(handle);
    }
    current(scope.current); return rows;
  });
}
/** Fresh receipt-only gesture: never reconstruct dispatch authority from a reloaded index. */
export function capturePendingCreditReduction(handle: PendingCreditReduction): CreditReductionStart {
  const p = pending.get(handle); if (!p) throw new Error(savedError); current(p.current);
  const operation = generations.capture(p.operation,p.current);
  const start = Object.freeze({ operationId:handle.operationId }) as CreditReductionStart;
  starts.set(start,{ ...p,lane:p.record.lane,operation,receiptOnly:true }); return start;
}
