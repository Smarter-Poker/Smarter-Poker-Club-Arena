/**
 * Browser-session persistence for mutation request identities.
 *
 * A database transaction can commit before its HTTP response is lost. The
 * request UUID and the exact payload it protects therefore live in one
 * sessionStorage record. A component ref, an in-memory fallback, or two
 * separately written keys cannot prove a reload will replay the same command.
 */

import { uuid } from './uuid';

const STORAGE_PREFIX = 'sp:purchase-request:v3:';
const LEGACY_ID_STORAGE_PREFIX = 'sp:purchase-request:v2:';
const LEGACY_PAYLOAD_STORAGE_PREFIX = 'sp:purchase-request-payload:v1:';
const RECORD_VERSION = 3;
const SCOPE_ONLY_PAYLOAD = 'scope-bound-request:v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StoredPurchaseRequest {
  version: typeof RECORD_VERSION;
  requestId: string;
  payloadKey: string;
}

interface BlockedPurchaseRequest {
  version: typeof RECORD_VERSION;
  blocked: true;
  reason: 'incomplete_legacy_binding';
}

export interface SessionPurchaseRequest {
  requestId: string;
  /** Stable, non-secret description of the exact payload bound to this key. */
  payloadKey: string;
  resumed: boolean;
}

export interface LocatedSessionPurchaseRequest extends SessionPurchaseRequest {
  scope: string;
}

export class SessionPurchaseRequestStorageError extends Error {
  constructor(message = 'Protected Purchase Storage Is Unavailable') {
    super(message);
    this.name = 'SessionPurchaseRequestStorageError';
  }
}

function normalizedScope(scope: string): string {
  const value = String(scope || '').trim();
  if (!value || value.length > 512) {
    throw new SessionPurchaseRequestStorageError('Protected Purchase Scope Is Invalid');
  }
  return value;
}

function normalizedPayloadKey(payloadKey: string): string {
  const value = String(payloadKey || '').trim();
  if (!value || value.length > 256) {
    throw new SessionPurchaseRequestStorageError('Protected Purchase Terms Are Invalid');
  }
  return value;
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(normalizedScope(scope))}`;
}

function legacyIdStorageKey(scope: string): string {
  return `${LEGACY_ID_STORAGE_PREFIX}${encodeURIComponent(normalizedScope(scope))}`;
}

function legacyPayloadStorageKey(scope: string): string {
  return `${LEGACY_PAYLOAD_STORAGE_PREFIX}${encodeURIComponent(normalizedScope(scope))}`;
}

function protectedStorage(): Storage {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) throw new Error('missing sessionStorage');
    return storage;
  } catch {
    throw new SessionPurchaseRequestStorageError();
  }
}

function isStoredPurchaseRequest(value: unknown): value is StoredPurchaseRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredPurchaseRequest>;
  return (
    record.version === RECORD_VERSION &&
    typeof record.requestId === 'string' &&
    UUID_V4.test(record.requestId) &&
    typeof record.payloadKey === 'string' &&
    record.payloadKey.length > 0 &&
    record.payloadKey.length <= 256 &&
    record.payloadKey === record.payloadKey.trim()
  );
}

function isBlockedPurchaseRequest(value: unknown): value is BlockedPurchaseRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<BlockedPurchaseRequest>;
  return (
    record.version === RECORD_VERSION &&
    record.blocked === true &&
    record.reason === 'incomplete_legacy_binding'
  );
}

function parseStoredRecord(raw: string): StoredPurchaseRequest | BlockedPurchaseRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionPurchaseRequestStorageError('Protected Purchase Record Is Invalid');
  }
  if (isStoredPurchaseRequest(parsed) || isBlockedPurchaseRequest(parsed)) return parsed;
  throw new SessionPurchaseRequestStorageError('Protected Purchase Record Is Invalid');
}

function writeWithReadback(
  key: string,
  value: StoredPurchaseRequest | BlockedPurchaseRequest
): void {
  const storage = protectedStorage();
  const serialized = JSON.stringify(value);
  try {
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error('readback mismatch');
  } catch {
    throw new SessionPurchaseRequestStorageError();
  }
}

function removeWithReadback(keys: string[]): void {
  const storage = protectedStorage();
  try {
    for (const key of keys) storage.removeItem(key);
    if (keys.some((key) => storage.getItem(key) !== null))
      throw new Error('clear readback mismatch');
  } catch {
    throw new SessionPurchaseRequestStorageError('Protected Purchase Storage Could Not Be Cleared');
  }
}

function clearLegacyRecords(scope: string): void {
  removeWithReadback([legacyIdStorageKey(scope), legacyPayloadStorageKey(scope)]);
}

/**
 * Read the v3 record or migrate one complete legacy pair. `legacyIdPayload`
 * is supplied only by the historical ID-only API, whose scope is itself the
 * full server-priced command identity. A split Store purchase may never infer
 * today's price for an orphaned legacy UUID.
 */
function readStoredOrLegacy(scope: string, legacyIdPayload?: string): StoredPurchaseRequest | null {
  const storage = protectedStorage();
  const key = storageKey(scope);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw new SessionPurchaseRequestStorageError();
  }

  if (raw !== null) {
    const record = parseStoredRecord(raw);
    if (isBlockedPurchaseRequest(record)) {
      throw new SessionPurchaseRequestStorageError(
        'An Earlier Purchase Could Not Be Safely Recovered. Start A New Browser Session Before Trying Again.'
      );
    }
    // Old split keys are redundant only after this complete atomic record is
    // readable. Clear them with readback before allowing another mutation.
    clearLegacyRecords(scope);
    return record;
  }

  const legacyIdKey = legacyIdStorageKey(scope);
  const legacyPayloadKey = legacyPayloadStorageKey(scope);
  let legacyId: string | null;
  let legacyPayload: string | null;
  try {
    legacyId = storage.getItem(legacyIdKey);
    legacyPayload = storage.getItem(legacyPayloadKey);
  } catch {
    throw new SessionPurchaseRequestStorageError();
  }
  if (legacyId === null && legacyPayload === null) return null;

  const payload = legacyPayload ?? legacyIdPayload ?? null;
  let normalizedLegacyPayload: string | null = null;
  try {
    if (payload) normalizedLegacyPayload = normalizedPayloadKey(payload);
  } catch {
    // A malformed legacy payload is handled by the durable blocker below.
  }
  if (legacyId && UUID_V4.test(legacyId) && normalizedLegacyPayload) {
    const migrated: StoredPurchaseRequest = {
      version: RECORD_VERSION,
      requestId: legacyId,
      payloadKey: normalizedLegacyPayload,
    };
    writeWithReadback(key, migrated);
    clearLegacyRecords(scope);
    return migrated;
  }

  // Preserve the unsafe state as one durable blocker before deleting the
  // partial keys. Otherwise the next click could mint a second charge identity
  // for a legacy request that may already have committed.
  writeWithReadback(key, {
    version: RECORD_VERSION,
    blocked: true,
    reason: 'incomplete_legacy_binding',
  });
  clearLegacyRecords(scope);
  throw new SessionPurchaseRequestStorageError(
    'An Earlier Purchase Could Not Be Safely Recovered. Start A New Browser Session Before Trying Again.'
  );
}

function createStoredRequest(scope: string, payloadKey: string): StoredPurchaseRequest {
  const record: StoredPurchaseRequest = {
    version: RECORD_VERSION,
    requestId: uuid(),
    payloadKey: normalizedPayloadKey(payloadKey),
  };
  writeWithReadback(storageKey(scope), record);
  return record;
}

function storedRequestEntries(): Array<{
  scope: string;
  key: string;
  record: StoredPurchaseRequest;
}> {
  const storage = protectedStorage();
  const entries: Array<{ scope: string; key: string; record: StoredPurchaseRequest }> = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const parsed = parseStoredRecord(raw);
      if (isBlockedPurchaseRequest(parsed)) continue;
      const scope = decodeURIComponent(key.slice(STORAGE_PREFIX.length));
      normalizedScope(scope);
      entries.push({ scope, key, record: parsed });
    }
  } catch (error) {
    if (error instanceof SessionPurchaseRequestStorageError) throw error;
    throw new SessionPurchaseRequestStorageError('Protected Purchase Storage Could Not Be Read');
  }
  return entries;
}

/** Locate an already-submitted request without guessing its offer scope. */
export function readSessionPurchaseRequestById(
  requestId: string
): LocatedSessionPurchaseRequest | null {
  if (!UUID_V4.test(String(requestId || ''))) {
    throw new SessionPurchaseRequestStorageError('Protected Purchase Request Is Invalid');
  }
  const matches = storedRequestEntries().filter((entry) => entry.record.requestId === requestId);
  if (matches.length > 1) {
    throw new SessionPurchaseRequestStorageError('Protected Purchase Request Is Ambiguous');
  }
  const match = matches[0];
  return match
    ? {
        scope: match.scope,
        requestId: match.record.requestId,
        payloadKey: match.record.payloadKey,
        resumed: true,
      }
    : null;
}

/** Retire exactly one verified terminal request, with storage readback. */
export function clearSessionPurchaseRequestById(requestId: string): boolean {
  const located = readSessionPurchaseRequestById(requestId);
  if (!located) return false;
  removeWithReadback([
    storageKey(located.scope),
    legacyIdStorageKey(located.scope),
    legacyPayloadStorageKey(located.scope),
  ]);
  return true;
}

/**
 * Retire only the request currently bound to this exact operation scope.
 * This compare-and-swap boundary prevents a delayed completion from clearing
 * a replacement request and prevents an ID collision/corruption in another
 * scope from being mistaken for the operation being settled.
 */
export function clearSessionPurchaseRequestIfMatches(
  scope: string,
  expectedRequestId: string
): boolean {
  if (!UUID_V4.test(String(expectedRequestId || ''))) {
    throw new SessionPurchaseRequestStorageError('Protected Purchase Request Is Invalid');
  }
  const current = readStoredOrLegacy(scope);
  if (!current || current.requestId !== expectedRequestId) return false;
  removeWithReadback([
    storageKey(scope),
    legacyIdStorageKey(scope),
    legacyPayloadStorageKey(scope),
  ]);
  return true;
}

/**
 * Compatibility API for server-priced commands whose complete identity is in
 * `scope`. It still persists an atomic ID + scope binding and refuses to issue
 * a mutation when durable browser-session storage cannot be proven.
 */
export function readOrCreateSessionPurchaseRequestId(scope: string): string {
  const existing = readStoredOrLegacy(scope, SCOPE_ONLY_PAYLOAD);
  return (existing ?? createStoredRequest(scope, SCOPE_ONLY_PAYLOAD)).requestId;
}

/** Read a previously submitted request without creating one. */
export function readSessionPurchaseRequest(scope: string): SessionPurchaseRequest | null {
  const existing = readStoredOrLegacy(scope);
  return existing
    ? { requestId: existing.requestId, payloadKey: existing.payloadKey, resumed: true }
    : null;
}

export function readOrCreateSessionPurchaseRequest(
  scope: string,
  payloadKey: string
): SessionPurchaseRequest {
  const normalizedPayload = normalizedPayloadKey(payloadKey);
  const existing = readStoredOrLegacy(scope);
  if (existing) {
    return { requestId: existing.requestId, payloadKey: existing.payloadKey, resumed: true };
  }

  const created = createStoredRequest(scope, normalizedPayload);
  return { requestId: created.requestId, payloadKey: created.payloadKey, resumed: false };
}

/**
 * Retire a key only after an authoritative result. Removal is verified so a
 * caller never claims it started a new intent while an old durable key remains.
 */
export function clearSessionPurchaseRequestId(scope: string): void {
  removeWithReadback([
    storageKey(scope),
    legacyIdStorageKey(scope),
    legacyPayloadStorageKey(scope),
  ]);
}
