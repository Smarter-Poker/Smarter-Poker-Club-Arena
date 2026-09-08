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
  kind: 'self_stake' | 'agent_send';
  amount: number;
}

export interface AgentWalletOperation {
  key: string;
  operationId: string;
}

export async function reserveAgentWalletOperation(
  intent: AgentWalletIntent
): Promise<AgentWalletOperation> {
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

export async function completeAgentWalletOperation(operation: AgentWalletOperation): Promise<void> {
  // A cleanup failure must retain the original retry identity, never turn a
  // confirmed transaction into an apparent failure that invites another send.
  try {
    await navigator.locks.request(operation.key, { mode: 'exclusive' }, () => {
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
  assertChipAmount(intent.amount);
  const scope = JSON.stringify([
    intent.userId.toLowerCase(),
    intent.clubId.toLowerCase(),
    intent.targetId.toLowerCase(),
    intent.kind,
    intent.amount.toFixed(2),
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
  kind: AgentWalletIntent['kind']
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const balance = kind === 'self_stake' ? r.player_wallet_after : r.recipient_balance_after;
  return (
    r.success === true &&
    typeof r.transaction_id === 'string' &&
    UUID.test(r.transaction_id) &&
    r.amount === amount &&
    typeof r.agent_wallet_after === 'number' &&
    Number.isFinite(r.agent_wallet_after) &&
    r.agent_wallet_after >= 0 &&
    typeof balance === 'number' &&
    Number.isFinite(balance) &&
    balance >= 0 &&
    (kind === 'self_stake' || r.destination === 'player_wallet' || r.destination === 'agent_wallet')
  );
}
