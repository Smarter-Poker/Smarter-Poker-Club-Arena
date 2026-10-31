import { durableRecovery } from './CashierDurableRecovery';
import { CASHIER_WALLET_RECOVERY_PREFIX } from '../lib/financialJournalKeys';
import { uuid } from '../utils/uuid';

const ENTITY_UUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set([
  'fn_club_bank_send',
  'fn_club_bank_claim_back',
  'fn_club_wallet_claim_back',
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
  if (!ENTITY_UUID.test(userId) || !ENTITY_UUID.test(clubId) || !ACTIONS.has(action)) return null;
  try {
    const store =
      storage ??
      (() => {
        try {
          return window.localStorage;
        } catch {
          return undefined;
        }
      })();
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
    if (!storage) {
      let legacy: CashierWalletOperation | undefined;
      let legacyRaw: string | null = null;
      try {
        legacyRaw = store?.getItem(key) ?? null;
      } catch {
        /* Browser storage may be disabled; use the authoritative server journal. */
      }
      try {
        legacy = legacyRaw ? JSON.parse(legacyRaw) : undefined;
      } catch {
        return null;
      }
      if (
        legacy &&
        !(
          legacy.version === 1 &&
          legacy.userId === userId &&
          legacy.clubId === clubId &&
          legacy.action === action &&
          legacy.digest === digest &&
          UUID.test(legacy.operationId) &&
          Number.isFinite(legacy.createdAt)
        )
      )
        return null;
      const draft = legacy ?? { ...base, operationId: createId(), createdAt: Date.now() };
      const row = (await durableRecovery(
        'reserve',
        userId,
        clubId,
        'wallet',
        `${action}:${digest}`,
        draft
      )) as CashierWalletOperation;
      if (legacy && row?.operationId !== legacy.operationId) return null;
      if (
        !row ||
        row.userId !== userId ||
        row.clubId !== clubId ||
        row.action !== action ||
        row.digest !== digest ||
        !UUID.test(row.operationId)
      )
        return null;
      try {
        store?.setItem(key, JSON.stringify(row));
      } catch {
        /* Server journal is authoritative. */
      }
      if (typeof window !== 'undefined')
        window.dispatchEvent(new Event('cashier-wallet-journal-changed'));
      return row;
    }
    const reserve = () => {
      const raw = store!.getItem(key);
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
      store!.setItem(key, serialized);
      if (typeof window !== 'undefined')
        window.dispatchEvent(new Event('cashier-wallet-journal-changed'));
      return store!.getItem(key) === serialized ? row : null;
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
export async function clearCashierWalletOperation(
  row: CashierWalletOperation,
  storage?: Storage
): Promise<void> {
  if (!storage) {
    try {
      const acknowledged = await durableRecovery(
        'ack',
        row.userId,
        row.clubId,
        'wallet',
        `${row.action}:${row.digest}`,
        undefined,
        row.operationId
      );
      if (typeof acknowledged !== 'boolean') return;
    } catch {
      return;
    }
  }
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
  if (!ENTITY_UUID.test(userId) || !ENTITY_UUID.test(clubId))
    return { operations: rows, unreadable: false };
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

/** Reads durable identities even when the browser cannot write its optional mirror. */
export async function readDurableCashierWalletOperations(
  userId: string,
  clubId: string
): Promise<CashierWalletOperation[]> {
  const rows = await durableRecovery('read', userId, clubId, 'wallet');
  if (!Array.isArray(rows)) throw new Error('Cashier Recovery Response Missing');
  return rows.filter(
    (row): row is CashierWalletOperation =>
      row?.userId === userId &&
      row.clubId === clubId &&
      row.version === 1 &&
      ACTIONS.has(row.action) &&
      UUID.test(row.operationId) &&
      /^[0-9a-f]{64}$/.test(row.digest)
  );
}
