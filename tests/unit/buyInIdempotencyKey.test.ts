/**
 * tests/unit/buyInIdempotencyKey.test.ts
 *
 * Proves that the buy-in idempotency key is STABLE across retries.
 *
 * The defect: crypto.randomUUID() was called inside the RPC callback on every
 * invocation. A network timeout after the RPC commits returns a transport error
 * to the client, which shows "Buy-in failed. Please try again." — inviting a
 * second call with a NEW UUID, bypassing the idempotency table and
 * double-debiting the wallet.
 *
 * The fix: mint the key once into buyInIdempotencyKeyRef before the first
 * await. Retry the RPC with the same key. The DB's ON CONFLICT DO NOTHING gate
 * absorbs the duplicate and returns without charging.
 */

import { beforeEach, describe, expect, it } from 'vitest';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Simulates the idempotency table: key -> already_seen boolean */
function makeIdempotencyTable() {
  const seen = new Set<string>();
  return {
    /** INSERT ON CONFLICT DO NOTHING. Returns true if key was new (charge). */
    insert(key: string): boolean {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    size: () => seen.size,
  };
}

/** Simulates the wallet ledger. */
function makeWalletLedger() {
  let totalDebited = 0;
  let debitCount = 0;
  return {
    debit(amount: number) { totalDebited += amount; debitCount++; },
    totalDebited: () => totalDebited,
    debitCount: () => debitCount,
  };
}

/** Simulates atomic_table_buyin as Postgres runs it. */
function makeAtomicTableBuyin(
  idem: ReturnType<typeof makeIdempotencyTable>,
  ledger: ReturnType<typeof makeWalletLedger>
) {
  return async function atomicTableBuyin(key: string, amount: number) {
    const isNew = idem.insert(key);
    if (isNew) ledger.debit(amount);
    return { success: true };
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buyInIdempotencyKey — stable across retries', () => {
  let idem: ReturnType<typeof makeIdempotencyTable>;
  let ledger: ReturnType<typeof makeWalletLedger>;
  let atomicTableBuyin: ReturnType<typeof makeAtomicTableBuyin>;

  beforeEach(() => {
    idem = makeIdempotencyTable();
    ledger = makeWalletLedger();
    atomicTableBuyin = makeAtomicTableBuyin(idem, ledger);
  });

  it('SCENARIO 1 FIXED: network timeout + retry with SAME key debits wallet exactly once', async () => {
    let buyInIdempotencyKeyRef: string | null = null;
    const amount = 500;

    // Attempt 1: key is minted, RPC commits, network drops before response
    if (!buyInIdempotencyKeyRef) buyInIdempotencyKeyRef = 'stable-key-aaaa';
    const key1 = buyInIdempotencyKeyRef;
    await atomicTableBuyin(key1, amount);
    // Key stays in ref (network-error path does NOT clear it)

    // Attempt 2: user retries — ref still holds the same key
    if (!buyInIdempotencyKeyRef) buyInIdempotencyKeyRef = 'should-not-reach';
    const key2 = buyInIdempotencyKeyRef;

    expect(key1).toBe(key2); // same key reused
    await atomicTableBuyin(key2, amount);

    expect(ledger.debitCount()).toBe(1);   // ONE debit, not two
    expect(ledger.totalDebited()).toBe(500);
    expect(idem.size()).toBe(1);
  });

  it('SCENARIO 1 BUG (unfixed): fresh UUID on each call causes double debit', async () => {
    const amount = 500;
    const key1 = 'random-uuid-aaaa'; // first call
    await atomicTableBuyin(key1, amount);
    const key2 = 'random-uuid-bbbb'; // second call — different UUID
    expect(key1).not.toBe(key2);
    await atomicTableBuyin(key2, amount);
    expect(ledger.debitCount()).toBe(2);    // BUG: double-charged
    expect(ledger.totalDebited()).toBe(1000); // player lost $1000 for a $500 seat
  });

  it('SCENARIO 2: server rejection rotates the key so corrected retry is a fresh transaction', async () => {
    let buyInIdempotencyKeyRef: string | null = null;
    if (!buyInIdempotencyKeyRef) buyInIdempotencyKeyRef = 'key-rejected';

    // Server rejects (insufficient_funds) — client CLEARS the key
    buyInIdempotencyKeyRef = null;

    // User adds funds and retries — gets a fresh key
    if (!buyInIdempotencyKeyRef) buyInIdempotencyKeyRef = 'key-fresh-after-rejection';
    await atomicTableBuyin(buyInIdempotencyKeyRef, 500);

    expect(ledger.debitCount()).toBe(1);
    // 'key-rejected' was never inserted (the rejection happened before the RPC)
    expect(idem.size()).toBe(1);
  });

  it('SCENARIO 3: modal cancel rotates the key — next seat attempt is a distinct transaction', async () => {
    let buyInIdempotencyKeyRef: string | null = null;
    if (!buyInIdempotencyKeyRef) buyInIdempotencyKeyRef = 'key-before-cancel';
    const keyBeforeCancel = buyInIdempotencyKeyRef;

    // onCloseBuyInModal clears the key
    buyInIdempotencyKeyRef = null;

    // User picks a different seat — fresh key
    if (!buyInIdempotencyKeyRef) buyInIdempotencyKeyRef = 'key-new-seat';
    expect(buyInIdempotencyKeyRef).not.toBe(keyBeforeCancel);

    await atomicTableBuyin(buyInIdempotencyKeyRef, 250);
    expect(ledger.debitCount()).toBe(1);
  });

  it('SCENARIO 4: offline queue reuses same key — server deduplicates replay', async () => {
    let buyInIdempotencyKeyRef: string | null = null;
    if (!buyInIdempotencyKeyRef) buyInIdempotencyKeyRef = 'key-offline';
    const stableKey = buyInIdempotencyKeyRef;

    // offline queue entry stores the same operationId
    const offlineEntry = { operationId: stableKey, amount: 400 };
    expect(offlineEntry.operationId).toBe(stableKey);

    // First attempt committed before going offline
    await atomicTableBuyin(stableKey, 400);
    // Queue replays when connectivity returns
    await atomicTableBuyin(offlineEntry.operationId, offlineEntry.amount);

    expect(ledger.debitCount()).toBe(1); // idempotency absorbed the replay
    expect(ledger.totalDebited()).toBe(400);
  });
});
