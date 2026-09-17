import {
  createGenerationCoordinator,
  type PreparedOperation,
  type CapturedOperation,
  type AdmittedOperation,
} from '../lib/DurableOperationCoordinator';
import { uuid } from '../utils/uuid';

// No payload or account data is persisted: only a SHA-256 scope and operation UUID.
// Keep uncertain identities across logout/reload; never expire an unknown outcome.
const PREFIX = 'smarter-poker:agent-wallet-operation:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertChipAmount(amount: number): void {
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1e9 ||
    Math.round(amount * 100) / 100 !== amount
  ) {
    throw new Error('Enter A Positive Chip Amount With At Most Two Decimal Places');
  }
}

export interface AgentWalletIntent {
  userId: string;
  clubId: string;
  targetId: string;
  kind:
    | 'self_stake'
    | 'agent_send'
    | 'club_bank_send'
    | 'cashout_request'
    | 'cashout_approve'
    | 'cashout_decline'
    | 'cashout_cancel';
  amount: number;
  destination?: 'player_wallet' | 'agent_wallet';
  note?: string;
}

export interface AgentWalletOperation {
  key: string;
  operationId: string;
}

export async function reserveAgentWalletOperation(
  intent: AgentWalletIntent
): Promise<AgentWalletOperation> {
  if (intent.kind.startsWith('cashout_')) {
    throw new Error('Prepare The Cashout Before Starting It');
  }
  assertChipAmount(intent.amount);
  if (![intent.userId, intent.clubId, intent.targetId].every((id) => UUID.test(id))) {
    throw new Error('The Transfer Account Could Not Be Verified');
  }
  if (!globalThis.crypto?.subtle || typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This Browser Cannot Safely Save The Transfer Request');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        intent.userId.toLowerCase(),
        intent.clubId.toLowerCase(),
        intent.targetId.toLowerCase(),
        intent.kind,
        'club_chips',
        intent.amount.toFixed(2),
        // Preserve existing player-wallet reservations across this upgrade.
        ...(intent.destination === 'agent_wallet' ? ['agent_wallet'] : []),
        ...(intent.kind.startsWith('cashout_') ? [(intent.note ?? '').trim()] : []),
      ])
    )
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const key = PREFIX + hash;
  return navigator.locks.request(key, { mode: 'exclusive' }, () => {
    const storage = window.localStorage;
    // A different tab may acknowledge and remove the shared reservation while
    // this tab still has an uncertain response. Its own durable identity wins.
    const session = window.sessionStorage;
    const prior = session.getItem(key) ?? storage.getItem(key);
    if (prior !== null) {
      if (!UUID.test(prior)) throw new Error('The Saved Transfer Request Could Not Be Verified');
      session.setItem(key, prior);
      if (session.getItem(key) !== prior) {
        throw new Error('The Transfer Request Could Not Be Saved');
      }
      return { key, operationId: prior };
    }
    const operationId = uuid();
    if (!UUID.test(operationId)) throw new Error('The Transfer Request Could Not Be Created');
    storage.setItem(key, operationId);
    if (storage.getItem(key) !== operationId) {
      throw new Error('The Transfer Request Could Not Be Saved');
    }
    session.setItem(key, operationId);
    if (session.getItem(key) !== operationId) {
      throw new Error('The Transfer Request Could Not Be Saved');
    }
    return { key, operationId };
  });
}

export async function completeAgentWalletOperation(
  operation: AgentWalletOperation,
  isCurrent: () => boolean = () => true
): Promise<void> {
  // A cleanup failure must retain the original retry identity, never turn a
  // confirmed transaction into an apparent failure that invites another send.
  try {
    await navigator.locks.request(operation.key, { mode: 'exclusive' }, () => {
      if (!isCurrent()) return;
      if (window.sessionStorage.getItem(operation.key) === operation.operationId) {
        window.sessionStorage.removeItem(operation.key);
      }
      if (window.localStorage.getItem(operation.key) === operation.operationId) {
        window.localStorage.removeItem(operation.key);
      }
    });
  } catch {
    // The next submission safely replays the confirmed server receipt.
  }
}

// Coalesce the complete request, not only storage reservation. Otherwise a fast
// acknowledgement can clear the ID before another overlapping digest resolves.
const submissions = new Map<string, Promise<true>>();

export function runAgentWalletOperation(
  intent: AgentWalletIntent,
  submit: (operation: AgentWalletOperation) => Promise<void>
): Promise<true> {
  if (intent.kind.startsWith('cashout_')) {
    throw new Error('Prepare The Cashout Before Starting It');
  }
  assertChipAmount(intent.amount);
  const scope = JSON.stringify([
    intent.userId.toLowerCase(),
    intent.clubId.toLowerCase(),
    intent.targetId.toLowerCase(),
    intent.kind,
    intent.amount.toFixed(2),
    ...(intent.destination === 'agent_wallet' ? ['agent_wallet'] : []),
    ...(intent.kind.startsWith('cashout_') ? [(intent.note ?? '').trim()] : []),
  ]);
  const pending = submissions.get(scope);
  if (pending) return pending;
  const request = (async () => {
    const operation = await reserveAgentWalletOperation(intent);
    await submit(operation);
    await completeAgentWalletOperation(operation);
    return true as const;
  })().finally(() => {
    if (submissions.get(scope) === request) submissions.delete(scope);
  });
  submissions.set(scope, request);
  return request;
}

export function confirmedAgentWalletReceipt(
  value: unknown,
  amount: number,
  kind: AgentWalletIntent['kind'],
  destination: 'player_wallet' | 'agent_wallet' = 'player_wallet'
): boolean {
  // Cashout receipts have a separate strict event/document contract in CashoutService.
  if (kind.startsWith('cashout_')) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const balance = kind === 'self_stake' ? r.player_wallet_after : r.recipient_balance_after;
  const sourceBalance = kind === 'club_bank_send' ? r.bank_after : r.agent_wallet_after;
  return (
    r.success === true &&
    typeof r.transaction_id === 'string' &&
    UUID.test(r.transaction_id) &&
    r.amount === amount &&
    typeof sourceBalance === 'number' &&
    Number.isFinite(sourceBalance) &&
    sourceBalance >= 0 &&
    typeof balance === 'number' &&
    Number.isFinite(balance) &&
    balance >= 0 &&
    (kind === 'self_stake' || r.destination === destination)
  );
}

// Cashouts retain their exact original storage namespaces, migration and digest.
// Only the durable generation mechanics are shared with other operation adapters.
type CashoutKind = Extract<AgentWalletIntent['kind'], `cashout_${string}`>;
export interface AgentCashoutIntent {
  userId: string;
  clubId: string;
  targetId: string;
  kind: CashoutKind;
  amount: number;
  note?: string;
}
export type PreparedAgentCashoutOperation = PreparedOperation;
export type CapturedAgentCashoutStart = CapturedOperation;
export type AdmittedAgentCashoutStart = AdmittedOperation;
const cashoutGenerations = createGenerationCoordinator({
  historyPrefix: 'smarter-poker:cashout-generations:v2:',
  legacyPrefix: PREFIX,
  markerPrefix: 'cashout-generations:v2:',
  allowLegacyAdoption: true,
  identityError:
    'The Saved Cashout Identity Could Not Be Verified. Keep This Request And Refresh Its Outcome.',
  storageError: 'This Browser Cannot Safely Save The Cashout Request',
  scopeError: 'The Account Or Cashout Changed. Refresh To Check Its Outcome.',
});
export async function prepareAgentCashoutOperation(
  intent: AgentCashoutIntent,
  isCurrent: () => boolean
): Promise<PreparedAgentCashoutOperation> {
  if (
    !globalThis.crypto?.subtle ||
    !globalThis.crypto?.getRandomValues ||
    typeof window === 'undefined' ||
    typeof navigator === 'undefined' ||
    !navigator.locks
  )
    throw new Error('This Browser Cannot Safely Save The Cashout Request');
  void window.localStorage;
  void window.sessionStorage;
  if (!isCurrent())
    throw new Error('The Account Or Cashout Changed. Refresh To Check Its Outcome.');
  assertChipAmount(intent.amount);
  if (
    ![intent.userId, intent.clubId, intent.targetId].every(
      (id) =>
        typeof id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) &&
        id !== '00000000-0000-0000-0000-000000000000'
    ) ||
    !['cashout_request', 'cashout_approve', 'cashout_decline', 'cashout_cancel'].includes(
      intent.kind
    ) ||
    (intent.note !== undefined && typeof intent.note !== 'string')
  ) {
    throw new Error(
      'The Saved Cashout Identity Could Not Be Verified. Keep This Request And Refresh Its Outcome.'
    );
  }
  const repeatable = intent.kind === 'cashout_request';
  // Exactly the old digest: playerId is intentionally not added to its schema.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        intent.userId,
        intent.clubId,
        intent.targetId,
        intent.kind,
        'club_chips',
        intent.amount.toFixed(2),
        (intent.note ?? '').trim(),
      ])
    )
  );
  if (!isCurrent())
    throw new Error('The Account Or Cashout Changed. Refresh To Check Its Outcome.');
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return cashoutGenerations.prepare(hash, repeatable, isCurrent);
}
export const captureAgentCashoutStart = cashoutGenerations.capture;
export const captureAgentCashoutReceiptCheck = cashoutGenerations.recapture;
export const admitAgentCashoutStart = cashoutGenerations.admit;
export const acknowledgeAgentCashoutStart = cashoutGenerations.acknowledge;
