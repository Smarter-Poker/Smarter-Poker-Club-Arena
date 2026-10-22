import { uuid } from '../utils/uuid';
import { UNION_WALLET_RECOVERY_PREFIX } from '../utils/clearUserCaches';
import { isEntityId } from '../utils/entityId';

export { UNION_WALLET_RECOVERY_PREFIX };

/**
 * One unresolved Union Wallet money intent. The operation id is durable so a
 * committed request whose response is lost can be retried with the SAME id,
 * including after a refresh. The record contains identifiers only -- never a
 * token, balance, or credential -- and is isolated by authenticated user.
 */
export type RecoverableUnionWalletKey = 'chips' | 'rake' | 'bbj' | 'promo' | 'spin_reserve';

export interface UnionWalletIntentScope {
  userId: string;
  unionId: string;
  walletKey: RecoverableUnionWalletKey;
  signature: string;
}

interface UnionWalletIntentRecord {
  version: 2;
  userId: string;
  unionId: string;
  walletKey: RecoverableUnionWalletKey;
  signature: string;
  operationId: string;
  createdAt: number;
}

export interface UnionWalletRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Account-scoped financial intent. The prefix is declared beside the sign-out
 * purge, which deliberately leaves it alone (clearUserCaches, S-05).
 *
 * NO AGE-BASED EVICTION (2026-10-09, audit S-10). A 24h MAX_AGE used to make
 * readRecord return null for an older record, so reserveUnionWalletOperation
 * minted a NEW operation id for the SAME unresolved intent: a union owner
 * retrying a lost-response send a day later paid twice. The server's op-claim
 * replay is the only authority that retires an intent; this mirrors
 * CashierResilience, which has never evicted by age. Only a future-dated
 * record (clock skew beyond FUTURE_SKEW_MS) is treated as malformed.
 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SIGNATURE_LENGTH = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WALLET_KEYS: ReadonlySet<RecoverableUnionWalletKey> = new Set([
  'chips',
  'rake',
  'bbj',
  'promo',
  'spin_reserve',
]);

const browserStorage = (): UnionWalletRecoveryStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/* One physical key per canonical intent prevents two browser tabs performing
   different wallet actions from overwriting one shared read/modify/write
   envelope. The complete scope remains inside the record and is revalidated
   on every read, so a key collision or hand-edited value fails closed. */
const storageKey = (scope: UnionWalletIntentScope) =>
  `${UNION_WALLET_RECOVERY_PREFIX}:${scope.userId}:${scope.unionId}:${scope.walletKey}:${encodeURIComponent(scope.signature)}`;

const isValidScope = (scope: UnionWalletIntentScope): boolean =>
  isEntityId(scope.userId) &&
  isEntityId(scope.unionId) &&
  WALLET_KEYS.has(scope.walletKey) &&
  scope.signature.length > 0 &&
  scope.signature.length <= MAX_SIGNATURE_LENGTH;

const validRecordShape = (
  value: unknown,
  scope: UnionWalletIntentScope,
  now: number
): value is UnionWalletIntentRecord => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<UnionWalletIntentRecord>;
  return (
    record.version === 2 &&
    record.userId === scope.userId &&
    record.unionId === scope.unionId &&
    record.walletKey === scope.walletKey &&
    record.signature === scope.signature &&
    typeof record.operationId === 'string' &&
    UUID_PATTERN.test(record.operationId) &&
    Number.isFinite(record.createdAt) &&
    Number(record.createdAt) <= now + FUTURE_SKEW_MS
  );
};

function readRecord(
  scope: UnionWalletIntentScope,
  storage: UnionWalletRecoveryStorage,
  now: number
): UnionWalletIntentRecord | null | undefined {
  const key = storageKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UnionWalletIntentRecord>;
    if (!validRecordShape(parsed, scope, now)) {
      /* A malformed record might be a partially persisted in-flight intent.
         Do not erase it and mint a different key: fail closed for this click. */
      return undefined;
    }
    // However old, the record stays until the server answers for its op id.
    return parsed as UnionWalletIntentRecord;
  } catch {
    // The caller treats an unreadable store as unavailable and fails closed.
    return undefined;
  }
}

/**
 * A canonical signature for fields that define one deliberate money action.
 * Display labels and notes are excluded: routes derive those, while the
 * wallet, mode, destination, currency and numeric amount decide the movement.
 */
export function unionWalletIntentSignature(input: {
  mode: 'send' | 'pull';
  targetType: 'member' | 'club';
  targetId: string;
  kind: 'chips' | 'diamonds' | 'promo';
  amount: number;
  sourceWallet: string;
}): string {
  return JSON.stringify([
    input.mode,
    input.targetType,
    input.targetId,
    input.kind,
    String(input.amount),
    input.sourceWallet,
  ]);
}

/**
 * Return the existing operation id for this exact unresolved intent, or
 * durably reserve a new one. A write is verified by reading it back: storage
 * shims that silently discard writes are not safe enough for a money request.
 */
export function reserveUnionWalletOperation(
  scope: UnionWalletIntentScope,
  storage: UnionWalletRecoveryStorage | null = browserStorage(),
  now = Date.now(),
  createOperationId: () => string = uuid
): string | null {
  if (!storage || !isValidScope(scope)) return null;
  const existing = readRecord(scope, storage, now);
  if (existing === undefined) return null;
  if (existing) return existing.operationId;

  const operationId = createOperationId();
  if (!UUID_PATTERN.test(operationId)) return null;
  const next: UnionWalletIntentRecord = {
    version: 2,
    userId: scope.userId,
    unionId: scope.unionId,
    walletKey: scope.walletKey,
    signature: scope.signature,
    operationId,
    createdAt: now,
  };

  try {
    storage.setItem(storageKey(scope), JSON.stringify(next));
    const verified = readRecord(scope, storage, now);
    return verified?.operationId === operationId ? operationId : null;
  } catch {
    return null;
  }
}

/** Clear only the operation that the server has confirmed, never a newer tab's record. */
export function clearUnionWalletOperation(
  scope: UnionWalletIntentScope,
  operationId: string,
  storage: UnionWalletRecoveryStorage | null = browserStorage(),
  now = Date.now()
): void {
  if (!storage || !isValidScope(scope) || !UUID_PATTERN.test(operationId)) return;
  const record = readRecord(scope, storage, now);
  if (!record || record.operationId !== operationId) return;
  try {
    storage.removeItem(storageKey(scope));
  } catch {
    // The committed server result remains authoritative. A stale key can only
    // replay that result; it cannot apply the movement a second time.
  }
}

/** The server owns recovery even when browser storage is full or disabled.
 * Carry a readable legacy intent forward so deployment never changes its key.
 * The RPC is injected for isolated tests and loaded by the mounted cashier. */
export async function reserveDurableUnionWalletOperation(
  scope: UnionWalletIntentScope,
  rpc: (
    name: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: unknown }>,
  storage: UnionWalletRecoveryStorage | null = browserStorage()
): Promise<string> {
  if (!isValidScope(scope)) throw new Error('Invalid Union Wallet Intent');
  let legacy: UnionWalletIntentRecord | null = null;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(storageKey(scope)) ?? null;
  } catch {
    /* Server recovery remains available. */
  }
  if (stored && storage) {
    const record = readRecord(scope, storage, Date.now());
    if (!record) throw new Error('Previous Union Wallet Operation Needs Recovery');
    legacy = record;
  }
  const { data, error } = await rpc('fn_union_wallet_reserve_intent', {
    p_union_id: scope.unionId,
    p_wallet_key: scope.walletKey,
    p_signature: scope.signature,
    p_legacy_operation_id: legacy?.operationId ?? null,
    p_actor_id: scope.userId,
  });
  if (error && (error as { code?: string }).code === 'PGRST202') {
    // Protected client publication and the independent migration installer can
    // overlap. Only a pre-execution missing-function response may use the
    // previous durable client protocol; transport ambiguity never may.
    const previous = reserveUnionWalletOperation(scope, storage);
    if (previous) return previous;
  }
  if (error) throw error;
  if (typeof data !== 'string' || !UUID_PATTERN.test(data))
    throw new Error('Union Wallet Recovery Could Not Be Confirmed');
  return data;
}

export async function acknowledgeDurableUnionWalletOperation(
  scope: UnionWalletIntentScope,
  operationId: string,
  rpc: (
    name: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: unknown }>
): Promise<void> {
  const { error } = await rpc('fn_union_wallet_acknowledge_intent', {
    p_union_id: scope.unionId,
    p_wallet_key: scope.walletKey,
    p_signature: scope.signature,
    p_operation_id: operationId,
  });
  if (error && (error as { code?: string }).code !== 'PGRST202') throw error;
  clearUnionWalletOperation(scope, operationId);
}
