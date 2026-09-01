export interface CashierReceiptFields {
  id: string;
  createdAt: string;
  type: string;
  amount: number;
  /** 'club' = the viewer is neither party; visible through their role
   *  (owner / co-owner / admin / super agent see everything, agents see
   *  their downline). Renders both names, no +/- sign. */
  direction: 'in' | 'out' | 'club';
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
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CASHIER_RECOVERY_PREFIX = 'smarter-poker:cashier-transfer-recovery:v1';
const CASHIER_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CASHIER_RECOVERY_FUTURE_SKEW_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const browserRecoveryStorage = (): CashierRecoveryStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const recoveryKey = (userId: string, clubId: string): string =>
  `${CASHIER_RECOVERY_PREFIX}:${userId}:${clubId}`;

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
    now - Number(row.createdAt) > CASHIER_RECOVERY_MAX_AGE_MS ||
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

/**
 * Keep one unresolved batch intent across a refresh without trusting arbitrary
 * localStorage input. Recovery is scoped to the signed-in user and club,
 * expires after 24 hours, and contains idempotency identifiers rather than
 * credentials or balances.
 */
export function readCashierTransferRecovery(
  userId: string,
  clubId: string,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): CashierTransferRecovery | null {
  if (!storage || !UUID_PATTERN.test(userId) || !UUID_PATTERN.test(clubId)) return null;
  const key = recoveryKey(userId, clubId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isValidRecovery(parsed, userId, clubId, now)) return parsed;
    storage.removeItem(key);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage can become unavailable between reads; in-memory recovery stays usable.
    }
  }
  return null;
}

export function writeCashierTransferRecovery(
  recovery: CashierTransferRecovery,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage(),
  now = Date.now()
): boolean {
  if (!storage || !isValidRecovery(recovery, recovery.userId, recovery.clubId, now)) return false;
  try {
    storage.setItem(recoveryKey(recovery.userId, recovery.clubId), JSON.stringify(recovery));
    return true;
  } catch {
    return false;
  }
}

export function clearCashierTransferRecovery(
  userId: string,
  clubId: string,
  storage: CashierRecoveryStorage | null = browserRecoveryStorage()
): void {
  if (!storage || !UUID_PATTERN.test(userId) || !UUID_PATTERN.test(clubId)) return;
  try {
    storage.removeItem(recoveryKey(userId, clubId));
  } catch {
    // Losing storage must never block a fresh server-authorized money intent.
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
    `${row.direction === 'in' ? 'From' : row.direction === 'out' ? 'To' : 'Between'}: ${row.counterparty}`,
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
