import { CASHIER_WALLET_RECOVERY_PREFIX } from '../lib/financialJournalKeys';
import { uuid } from '../utils/uuid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set([
  'fn_club_bank_send',
  'fn_club_bank_claim_back',
  'fn_agent_wallet_send',
  'fn_agent_wallet_claim_back',
  'fn_club_bank_reverse',
  'fn_promo_wallet_send',
  'fn_club_promo_wallet_send',
]);
export interface CashierWalletOperation {
  version: 1;
  userId: string;
  clubId: string;
  action: string;
  digest: string;
  operationId: string;
  createdAt: number;
}
interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const keyFor = (row: CashierWalletOperation) =>
  `${CASHIER_WALLET_RECOVERY_PREFIX}:${row.userId}:${row.clubId}:${row.action}:${row.digest}`;

/** Exact RPC intent, including its reason, without persisting personal text. */
export async function reserveCashierWalletOperation(
  userId: string,
  clubId: string,
  action: string,
  args: Record<string, unknown>,
  createId = uuid,
  storage?: Storage
): Promise<CashierWalletOperation | null> {
  if (!UUID.test(userId) || !UUID.test(clubId) || !ACTIONS.has(action)) return null;
  try {
    const store = storage ?? window.localStorage;
    const canonical = JSON.stringify(
      Object.keys(args)
        .filter((key) => key !== 'p_op_id')
        .sort()
        .map((key) => [key, args[key]])
    );
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const digest = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const base = { version: 1 as const, userId, clubId, action, digest };
    const key = keyFor({ ...base, operationId: '', createdAt: 0 });
    const reserve = () => {
      const raw = store.getItem(key);
      if (raw) {
        const row = JSON.parse(raw) as CashierWalletOperation;
        return row.version === 1 &&
          row.userId === userId &&
          row.clubId === clubId &&
          row.action === action &&
          row.digest === digest &&
          UUID.test(row.operationId) &&
          Number.isFinite(row.createdAt)
          ? row
          : null;
      }
      const operationId = createId();
      if (!UUID.test(operationId)) return null;
      const row = { ...base, operationId, createdAt: Date.now() };
      const serialized = JSON.stringify(row);
      store.setItem(key, serialized);
      if (typeof window !== 'undefined')
        window.dispatchEvent(new Event('cashier-wallet-journal-changed'));
      return store.getItem(key) === serialized ? row : null;
    };
    // Modern browser Web Locks prevent two tabs allocating different IDs for
    // one intent. Without exclusion, fail before any new financial request.
    if (typeof navigator !== 'undefined' && navigator.locks)
      return await navigator.locks.request(key, { mode: 'exclusive' }, reserve);
    return storage ? reserve() : null;
  } catch {
    // No journal means no safe financial request. Never rotate an unreadable id.
    return null;
  }
}

/** Only an authoritative receipt retires this exact identity. */
export function clearCashierWalletOperation(row: CashierWalletOperation, storage?: Storage): void {
  try {
    const store = storage ?? window.localStorage;
    const key = keyFor(row);
    const raw = store.getItem(key);
    if (raw && (JSON.parse(raw) as CashierWalletOperation).operationId === row.operationId)
      store.removeItem(key);
    if (typeof window !== 'undefined')
      window.dispatchEvent(new Event('cashier-wallet-journal-changed'));
  } catch {
    // A retained identity can only replay its original server result.
  }
}

export function readCashierWalletRecoveryState(
  userId: string,
  clubId: string
): {
  operations: CashierWalletOperation[];
  unreadable: boolean;
} {
  const rows: CashierWalletOperation[] = [];
  if (!UUID.test(userId) || !UUID.test(clubId)) return { operations: rows, unreadable: false };
  let unreadable = false;
  try {
    const prefix = `${CASHIER_WALLET_RECOVERY_PREFIX}:${userId}:${clubId}:`;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const row = JSON.parse(
          localStorage.getItem(key) || 'null'
        ) as CashierWalletOperation | null;
        if (
          row?.version === 1 &&
          row.userId === userId &&
          row.clubId === clubId &&
          ACTIONS.has(row.action) &&
          /^[0-9a-f]{64}$/.test(row.digest) &&
          UUID.test(row.operationId) &&
          Number.isFinite(row.createdAt) &&
          keyFor(row) === key
        )
          rows.push(row);
        else unreadable = true;
      } catch {
        unreadable = true;
      }
    }
  } catch {
    unreadable = true;
  }
  return { operations: rows.sort((a, b) => a.createdAt - b.createdAt), unreadable };
}
export function readCashierWalletOperations(
  userId: string,
  clubId: string
): CashierWalletOperation[] {
  return readCashierWalletRecoveryState(userId, clubId).operations;
}
