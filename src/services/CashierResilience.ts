import { CASHIER_RECOVERY_PREFIX, CASHIER_REQUEST_RECOVERY_PREFIX } from '../utils/clearUserCaches';

export { CASHIER_RECOVERY_PREFIX, CASHIER_REQUEST_RECOVERY_PREFIX };

export interface CashierReceiptFields {
  id: string;
  createdAt: string;
  type: string;
  amount: number;
  direction: 'in' | 'out' | 'managed';
  counterparty: string;
}

export interface CashierTransferFailure {
  userId: string;
  name: string;
  message: string;
}

export interface CashierTransferRecovery {
  version: 1;
  userId: string;
  clubId: string;
  kind: 'send' | 'ticket';
  amount: number;
  targetIds: string[];
  failures: CashierTransferFailure[];
  submissionId: string;
  opIds: Record<string, string>;
  createdAt: number;
}

interface CashierRecoveryStorage {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CashierRecoveryEnvelope {
  version: 2;
  userId: string;
  clubId: string;
  recoveries: CashierTransferRecovery[];
}

/** Account-scoped financial intent; its prefix is shared with the sign-out purge. */
const CASHIER_RECOVERY_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CASHIER_RECOVERY_MAX_BATCHES = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const browserRecoveryStorage = (): CashierRecoveryStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const legacyRecoveryKey = (userId: string, clubId: string): string =>
  `${CASHIER_RECOVERY_PREFIX}:${userId}:${clubId}`;

const recoveryEntryPrefix = (userId: string, clubId: string): string =>
  `${legacyRecoveryKey(userId, clubId)}:`;

const recoveryEntryKey = (userId: string, clubId: string, submissionId: string): string =>
  `${recoveryEntryPrefix(userId, clubId)}${submissionId}`;

const isSafeRecoveryText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength;

const isValidRecovery = (
  value: unknown,
  userId: string,
  clubId: string,
  now: number
): value is CashierTransferRecovery => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CashierTransferRecovery>;
  if (
    row.version !== 1 ||
    row.userId !== userId ||
    row.clubId !== clubId ||
    !UUID_PATTERN.test(userId) ||
    !UUID_PATTERN.test(clubId) ||
    (row.kind !== 'send' && row.kind !== 'ticket') ||
    !Number.isFinite(row.amount) ||
    Number(row.amount) <= 0 ||
    Number(row.amount) > 1e9 ||
    Math.round(Number(row.amount) * 100) / 100 !== Number(row.amount) ||
    !UUID_PATTERN.test(String(row.submissionId || '')) ||
    !Number.isFinite(row.createdAt) ||
    Number(row.createdAt) > now + CASHIER_RECOVERY_FUTURE_SKEW_MS ||
    !Array.isArray(row.targetIds) ||
    row.targetIds.length === 0 ||
    row.targetIds.length > 10_000 ||
    !Array.isArray(row.failures) ||
    row.failures.length === 0 ||
    row.failures.length > row.targetIds.length ||
    !row.opIds ||
    typeof row.opIds !== 'object' ||
    Array.isArray(row.opIds)
  ) {
    return false;
  }

  const targets = new Set(row.targetIds);
  if (targets.size !== row.targetIds.length || row.targetIds.some((id) => !UUID_PATTERN.test(id))) {
    return false;
  }
  if (
    row.failures.some(
      (failure) =>
        !failure ||
        !targets.has(failure.userId) ||
        !isSafeRecoveryText(failure.name, 200) ||
        !isSafeRecoveryText(failure.message, 500)
    )
  ) {
    return false;
  }

  const opIds = row.opIds as Record<string, unknown>;
  if (
    Object.entries(opIds).some(
      ([targetId, opId]) => !targets.has(targetId) || !UUID_PATTERN.test(String(opId))
    )
  ) {
    return false;
  }
  return (
    row.kind !== 'send' ||
    row.targetIds.every((targetId) => UUID_PATTERN.test(String(opIds[targetId])))
  );
};

/** Read the former shared key so deployed v1/v2 journals remain recoverable. */
function readLegacyCashierRecoveries(
  userId: string,
  clubId: string,
  storage: CashierRecoveryStorage,
  now: number
): CashierTransferRecovery[] | null | undefined {
  const raw = storage.getItem(legacyRecoveryKey(userId, clubId));
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  let recoveries: CashierTransferRecovery[];
  if ((parsed as Partial<CashierTransferRecovery> | null)?.version === 1) {
    if (!isValidRecovery(parsed, userId, clubId, now)) return undefined;
    recoveries = [parsed];
  } else {
    const envelope = parsed as Partial<CashierRecoveryEnvelope> | null;
    if (
      !envelope ||
      envelope.version !== 2 ||
      envelope.userId !== userId ||
      envelope.clubId !== clubId ||
      !Array.isArray(envelope.recoveries) ||
      envelope.recoveries.length > CASHIER_RECOVERY_MAX_BATCHES ||
      envelope.recoveries.some((recovery) => !isValidRecovery(recovery, userId, clubId, now)) ||
      new Set(envelope.recoveries.map((recovery) => recovery.submissionId)).size !==
        envelope.recoveries.length
    ) {
      return undefined;
    }
    recoveries = envelope.recoveries;
  }

  return recoveries;
}

function persistLegacyCashierRecoveries(
  envelope: CashierRecoveryEnvelope,
  storage: CashierRecoveryStorage
): void {
  const key = legacyRecoveryKey(envelope.userId, envelope.clubId);
  if (envelope.recoveries.length === 0) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(envelope));
}

const sameRecoveryIntent = (
  left: CashierTransferRecovery,
  right: CashierTransferRecovery
): boolean =>
  left.kind === right.kind &&
  left.amount === right.amount &&
  JSON.stringify(left.targetIds) === JSON.stringify(right.targetIds) &&
  JSON.stringify(left.opIds) === JSON.stringify(right.opIds);

interface CashierRecoveryCollection {
  recoveries: CashierTransferRecovery[];
  malformed: boolean;
}

/**
 * Enumerate one account + club without a shared read-modify-write document.
 * A browser tab owns exactly one `...:<submissionId>` key, so tab A can never
 * overwrite tab B's unresolved batch. The former base-key v1/v2 record is read
 * alongside the entries until each legacy intent is definitively cleared.
 */
function collectCashierTransferRecoveries(
  userId: string,
  clubId: string,
  storage: CashierRecoveryStorage,
  now: number,
  removeInvalid: boolean
): CashierRecoveryCollection {
  const bySubmission = new Map<string, CashierTransferRecovery>();
  let malformed = false;
  const baseKey = legacyRecoveryKey(userId, clubId);
  const legacy = readLegacyCashierRecoveries(userId, clubId, storage, now);
  if (legacy === undefined) {
    malformed = true;
    if (removeInvalid) storage.removeItem(baseKey);
  } else {
    for (const recovery of legacy || []) {
      bySubmission.set(recovery.submissionId, recovery);
    }
  }

  // Snapshot first: removeItem() reindexes localStorage.
  const prefix = recoveryEntryPrefix(userId, clubId);
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }

  for (const key of keys) {
    const raw = storage.getItem(key);
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const submissionId = key.slice(prefix.length);
    if (!isValidRecovery(parsed, userId, clubId, now) || parsed.submissionId !== submissionId) {
      malformed = true;
      if (removeInvalid) storage.removeItem(key);
      continue;
    }
    // A per-submission entry is the current form and supersedes its legacy
    // copy. Immutable-intent validation still happens before every write.
    bySubmission.set(parsed.submissionId, parsed);
  }

  return {
    recoveries: [...bySubmission.values()].sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.submissionId.localeCompare(right.submissionId)
    ),
    malformed,
  };
}

export function readCashierTransferRecoveries(
  userId: string,
  clubId: string,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): CashierTransferRecovery[] {
  if (!storage || !UUID_PATTERN.test(userId) || !UUID_PATTERN.test(clubId)) return [];
  try {
    // Never erase an unreadable financial journal during a read. A malformed
    // entry may be the only surviving evidence of a request whose response was
    // lost; leaving it in place makes the next write fail closed instead of
    // silently minting a fresh operation identity.
    return collectCashierTransferRecoveries(userId, clubId, storage, now, false).recoveries;
  } catch {
    return [];
  }
}

/**
 * Keep one unresolved batch intent across a refresh without trusting arbitrary
 * localStorage input. Recovery is scoped to the signed-in user and club,
 * retains unresolved intents until explicitly cleared, and contains idempotency identifiers rather than
 * credentials or balances.
 */
export function readCashierTransferRecovery(
  userId: string,
  clubId: string,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): CashierTransferRecovery | null {
  return readCashierTransferRecoveries(userId, clubId, storage, now)[0] ?? null;
}

/** Read the exact batch displayed by this tab, even when another tab is older. */
export function readCashierTransferRecoveryBySubmission(
  userId: string,
  clubId: string,
  submissionId: string,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): CashierTransferRecovery | null {
  if (!UUID_PATTERN.test(submissionId)) return null;
  return (
    readCashierTransferRecoveries(userId, clubId, storage, now).find(
      (recovery) => recovery.submissionId === submissionId
    ) ?? null
  );
}

export function writeCashierTransferRecovery(
  recovery: CashierTransferRecovery,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): boolean {
  if (!storage || !isValidRecovery(recovery, recovery.userId, recovery.clubId, now)) return false;
  try {
    // The operation and target ids are required to retry the exact server
    // intent. Recipient names and raw server messages are not: they are PII
    // and can carry backend detail. Rehydrate names from the authorized live
    // roster after reload and retain only a bounded, user-safe status here.
    const persisted: CashierTransferRecovery = {
      ...recovery,
      failures: recovery.failures.map((failure) => ({
        userId: failure.userId,
        name: 'Cashier Recipient',
        message: 'Outcome Needs Verification',
      })),
    };
    const existing = collectCashierTransferRecoveries(
      recovery.userId,
      recovery.clubId,
      storage,
      now,
      false
    );
    if (existing.malformed) return false;
    const prior = existing.recoveries.find(
      (candidate) => candidate.submissionId === persisted.submissionId
    );
    if (prior && !sameRecoveryIntent(prior, persisted)) return false;
    if (!prior && existing.recoveries.length >= CASHIER_RECOVERY_MAX_BATCHES) return false;

    const key = recoveryEntryKey(recovery.userId, recovery.clubId, recovery.submissionId);
    storage.setItem(key, JSON.stringify(persisted));
    const verifiedRaw = storage.getItem(key);
    const verified = verifiedRaw ? (JSON.parse(verifiedRaw) as unknown) : null;
    return (
      isValidRecovery(verified, recovery.userId, recovery.clubId, now) &&
      sameRecoveryIntent(verified, persisted)
    );
  } catch {
    return false;
  }
}

export function clearCashierTransferRecovery(
  userId: string,
  clubId: string,
  submissionId: string,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): void {
  if (
    !storage ||
    !UUID_PATTERN.test(userId) ||
    !UUID_PATTERN.test(clubId) ||
    !UUID_PATTERN.test(submissionId)
  )
    return;
  try {
    // Disjoint key removal is the cross-tab guarantee: a stale tab can remove
    // only the submission it owns, never a newer tab's recovery journal.
    storage.removeItem(recoveryEntryKey(userId, clubId, submissionId));

    // Also retire the matching rollout-era base-key copy, if one exists.
    const legacy = readLegacyCashierRecoveries(userId, clubId, storage, now);
    if (!legacy) return;
    const recoveries = legacy.filter((recovery) => recovery.submissionId !== submissionId);
    if (recoveries.length === legacy.length) return;
    persistLegacyCashierRecoveries({ version: 2, userId, clubId, recoveries }, storage);
  } catch {
    // Losing storage must never block a fresh server-authorized money intent.
  }
}

export interface CashierChipRequestIntent {
  userId: string;
  clubId: string;
  amount: number;
  note: string | null;
}

export interface CashierChipRequestRecovery extends CashierChipRequestIntent {
  version: 1;
  intentHash: string;
  operationId: string;
  createdAt: number;
}

/** Account-scoped request retry ids; their prefix is shared with the sign-out purge. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const canonicalChipRequestNote = (note: string | null): string | null => {
  const trimmed = (note || '').trim();
  return trimmed || null;
};

async function chipRequestIntentHash(intent: CashierChipRequestIntent): Promise<string | null> {
  const note = canonicalChipRequestNote(intent.note);
  if (
    !UUID_PATTERN.test(intent.userId) ||
    !UUID_PATTERN.test(intent.clubId) ||
    !Number.isFinite(intent.amount) ||
    intent.amount <= 0 ||
    intent.amount > 1e9 ||
    Math.round(intent.amount * 100) / 100 !== intent.amount ||
    (note?.length || 0) > 500
  ) {
    return null;
  }

  try {
    // The note can contain private context. Persist a SHA-256 intent digest,
    // never the note itself or an encoding that can be read back from storage.
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle) return null;
    const bytes = new TextEncoder().encode(JSON.stringify([intent.amount.toFixed(2), note]));
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

const chipRequestRecoveryKey = (userId: string, clubId: string, intentHash: string): string =>
  `${CASHIER_REQUEST_RECOVERY_PREFIX}:${userId}:${clubId}:${intentHash}`;

const isValidChipRequestRecovery = (
  value: unknown,
  intent: CashierChipRequestIntent,
  intentHash: string,
  now: number
): value is CashierChipRequestRecovery => {
  if (!value || typeof value !== 'object') return false;
  const recovery = value as Partial<CashierChipRequestRecovery>;
  return (
    recovery.version === 1 &&
    recovery.userId === intent.userId &&
    recovery.clubId === intent.clubId &&
    recovery.amount === intent.amount &&
    recovery.note === null &&
    recovery.intentHash === intentHash &&
    SHA256_PATTERN.test(intentHash) &&
    UUID_PATTERN.test(String(recovery.operationId || '')) &&
    Number.isFinite(recovery.createdAt) &&
    Number(recovery.createdAt) <= now + CASHIER_RECOVERY_FUTURE_SKEW_MS
  );
};

/**
 * Durably reserve (or recover) the retry id for one canonical chip request.
 * The record is verified before the RPC is allowed to run. It deliberately has
 * no age-based eviction: an unknown committed outcome remains unsafe to mint
 * again until the server definitively accepts or refuses that same intent.
 */
export async function reserveCashierChipRequestOperation(
  intent: CashierChipRequestIntent,
  createOperationId: () => string,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): Promise<CashierChipRequestRecovery | null> {
  if (!storage) return null;
  const canonicalIntent: CashierChipRequestIntent = {
    ...intent,
    note: canonicalChipRequestNote(intent.note),
  };
  const intentHash = await chipRequestIntentHash(canonicalIntent);
  if (!intentHash) return null;
  const key = chipRequestRecoveryKey(intent.userId, intent.clubId, intentHash);

  const reserve = (): CashierChipRequestRecovery | null => {
    try {
      const raw = storage.getItem(key);
      if (raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return null;
        }
        return isValidChipRequestRecovery(parsed, canonicalIntent, intentHash, now) ? parsed : null;
      }

      const operationId = createOperationId();
      if (!UUID_PATTERN.test(operationId)) return null;
      // Only the digest survives. `note: null` is an explicit privacy sentinel,
      // not the canonical note used by the RPC.
      const recovery: CashierChipRequestRecovery = {
        ...canonicalIntent,
        note: null,
        version: 1,
        intentHash,
        operationId,
        createdAt: now,
      };
      storage.setItem(key, JSON.stringify(recovery));
      const verifiedRaw = storage.getItem(key);
      const verified = verifiedRaw ? (JSON.parse(verifiedRaw) as unknown) : null;
      return isValidChipRequestRecovery(verified, canonicalIntent, intentHash, now) &&
        verified.operationId === operationId
        ? verified
        : null;
    } catch {
      return null;
    }
  };

  try {
    // Web Locks makes same-intent creation atomic across browser tabs. The
    // storage key itself isolates different amount/note intents.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request(
        `cashier-chip-request:${intent.userId}:${intent.clubId}:${intentHash}`,
        { mode: 'exclusive' },
        reserve
      );
    }
    return reserve();
  } catch {
    return null;
  }
}

/** Clear only the exact journal entry whose server result is definitive. */
export function clearCashierChipRequestOperation(
  recovery: CashierChipRequestRecovery,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): boolean {
  if (!storage || !SHA256_PATTERN.test(recovery.intentHash)) return false;
  const intent: CashierChipRequestIntent = {
    userId: recovery.userId,
    clubId: recovery.clubId,
    amount: recovery.amount,
    note: null,
  };
  const key = chipRequestRecoveryKey(recovery.userId, recovery.clubId, recovery.intentHash);
  try {
    const raw = storage.getItem(key);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isValidChipRequestRecovery(parsed, intent, recovery.intentHash, now) ||
      parsed.operationId !== recovery.operationId
    ) {
      return false;
    }
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

const receiptLabel = (value: string): string =>
  value
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/**
 * Produce a plain-text receipt that remains useful outside the application.
 * The transaction id is deliberately included in full: it is the immutable
 * reference support and the ledger use to identify the exact movement.
 */
export function cashierReceiptText(row: CashierReceiptFields, clubName: string): string {
  const signedAmount = `${row.direction === 'in' ? '+' : row.direction === 'out' ? '-' : ''}${row.amount.toFixed(2)}`;
  const recordedAt = new Date(row.createdAt);
  const recordedLabel = Number.isNaN(recordedAt.getTime())
    ? 'Unavailable'
    : recordedAt.toISOString();
  return [
    'Smarter Poker Cashier Receipt',
    `Club: ${clubName || 'Club Cashier'}`,
    `Reference: ${row.id}`,
    `Recorded: ${recordedLabel}`,
    `Entry: ${receiptLabel(row.type) || 'Transfer'}`,
    `${row.direction === 'managed' ? 'Transfer' : row.direction === 'in' ? 'From' : 'To'}: ${row.counterparty}`,
    `Amount: ${signedAmount} Chips`,
    'Status: Recorded In Ledger',
  ].join('\n');
}

/** Browser online state is advisory; the server still authorizes every move. */
export function readCashierOnlineState(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export async function copyCashierText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  } catch {
    return false;
  }
}
