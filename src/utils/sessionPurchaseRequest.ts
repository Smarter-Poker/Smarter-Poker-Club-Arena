/**
 * Browser-session persistence for mutation request identities.
 *
 * A database transaction can commit before its HTTP response is lost. Keeping
 * the UUID only in a component ref or service instance makes a tab reload turn
 * the user's retry into a second debit/grant. The scope must include the exact
 * account and SKU/quantity; callers clear it only after an authoritative RPC
 * response, never after an ambiguous transport failure.
 */

const STORAGE_PREFIX = 'sp:purchase-request:v2:';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const memoryFallback = new Map<string, string>();

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}`;
}

function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = (Math.random() * 16) | 0;
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

export function readOrCreateSessionPurchaseRequestId(scope: string): string {
  const key = storageKey(scope);
  try {
    const stored = globalThis.sessionStorage?.getItem(key);
    if (stored && UUID_V4.test(stored)) {
      memoryFallback.set(key, stored);
      return stored;
    }
  } catch {
    // The in-memory fallback still gives one mounted runtime stable retries.
  }

  const remembered = memoryFallback.get(key);
  if (remembered) return remembered;

  const requestId = newRequestId();
  memoryFallback.set(key, requestId);
  try {
    globalThis.sessionStorage?.setItem(key, requestId);
  } catch {
    // Storage can be blocked; the fallback remains valid for this runtime.
  }
  return requestId;
}

export function clearSessionPurchaseRequestId(scope: string): void {
  const key = storageKey(scope);
  memoryFallback.delete(key);
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Clearing browser storage is best-effort after an authoritative response.
  }
}
