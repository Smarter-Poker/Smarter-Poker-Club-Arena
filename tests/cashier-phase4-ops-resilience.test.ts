import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CASHIER_RECOVERY_PREFIX,
  cashierReceiptText,
  clearCashierChipRequestOperation,
  clearCashierTransferRecovery,
  readCashierTransferRecovery,
  readCashierTransferRecoveries,
  readCashierTransferRecoveryBySubmission,
  reserveCashierChipRequestOperation,
  writeCashierTransferRecovery,
  type CashierTransferRecovery,
} from '../src/services/CashierResilience';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
const styles = readFileSync(resolve(root, 'src/pages/CashierTradePage.module.css'), 'utf8');

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  entries() {
    return [...this.values.entries()];
  }
}

class RefusingStorage extends MemoryStorage {
  override setItem() {
    throw new Error('quota exceeded');
  }
}

const recovery: CashierTransferRecovery = {
  version: 1,
  userId: '11111111-1111-4111-8111-111111111111',
  clubId: '22222222-2222-4222-8222-222222222222',
  kind: 'send',
  amount: 125.5,
  targetIds: ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'],
  failures: [
    {
      userId: '44444444-4444-4444-8444-444444444444',
      name: 'Retry Player',
      message: 'Connection Closed',
    },
  ],
  submissionId: '55555555-5555-4555-8555-555555555555',
  opIds: {
    '33333333-3333-4333-8333-333333333333': '66666666-6666-4666-8666-666666666666',
    '44444444-4444-4444-8444-444444444444': '77777777-7777-4777-8777-777777777777',
  },
  createdAt: Date.UTC(2026, 7, 31, 15, 45),
};

const concurrentRecovery: CashierTransferRecovery = {
  ...recovery,
  targetIds: ['88888888-8888-4888-8888-888888888888'],
  failures: [
    {
      userId: '88888888-8888-4888-8888-888888888888',
      name: 'Other Tab Player',
      message: 'Connection Closed',
    },
  ],
  submissionId: '99999999-9999-4999-8999-999999999999',
  opIds: {
    '88888888-8888-4888-8888-888888888888': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  createdAt: recovery.createdAt + 1,
};

describe('cashier Phase 4 operational resilience', () => {
  it('builds a portable receipt around the immutable transaction reference', () => {
    const receipt = cashierReceiptText(
      {
        id: '11111111-2222-4333-8444-555555555555',
        createdAt: '2026-08-31T15:45:00.000Z',
        type: 'peer_transfer',
        amount: 125.5,
        direction: 'out',
        counterparty: 'Shark Player',
      },
      'Shark Club'
    );

    expect(receipt).toContain('Smarter Poker Cashier Receipt');
    expect(receipt).toContain('Club: Shark Club');
    expect(receipt).toContain('Reference: 11111111-2222-4333-8444-555555555555');
    expect(receipt).toContain('Entry: Peer Transfer');
    expect(receipt).toContain('To: Shark Player');
    expect(receipt).toContain('Amount: -125.50 Chips');
    expect(receipt).toContain('Status: Recorded In Ledger');
  });

  it('keeps malformed historical timestamps from crashing receipt copy', () => {
    expect(
      cashierReceiptText(
        {
          id: 'bad-date-row',
          createdAt: 'not-a-date',
          type: 'transfer',
          amount: 1,
          direction: 'in',
          counterparty: 'Club',
        },
        'Shark Club'
      )
    ).toContain('Recorded: Unavailable');
  });

  it('round-trips retry keys without persisting recipient names or raw errors', () => {
    const storage = new MemoryStorage();
    const now = recovery.createdAt + 1_000;

    expect(writeCashierTransferRecovery(recovery, storage, now)).toBe(true);
    expect(readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, now)).toEqual({
      ...recovery,
      failures: [
        {
          userId: '44444444-4444-4444-8444-444444444444',
          name: 'Cashier Recipient',
          message: 'Outcome Needs Verification',
        },
      ],
    });

    clearCashierTransferRecovery(
      recovery.userId,
      recovery.clubId,
      recovery.submissionId,
      storage,
      now
    );
    expect(readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, now)).toBeNull();
  });

  it('isolates concurrent browser-tab batches and conditionally clears only the confirmed one', () => {
    const storage = new MemoryStorage();
    const now = recovery.createdAt + 1_000;

    expect(writeCashierTransferRecovery(recovery, storage, now)).toBe(true);
    expect(writeCashierTransferRecovery(concurrentRecovery, storage, now)).toBe(true);
    // One physical key per submission is the property that survives an actual
    // A-read/B-read/A-write/B-write interleave. A shared array envelope would
    // still have length 1 and its last writer could erase the other batch.
    expect(storage.length).toBe(2);
    expect(
      readCashierTransferRecoveries(recovery.userId, recovery.clubId, storage, now).map(
        (entry) => entry.submissionId
      )
    ).toEqual([recovery.submissionId, concurrentRecovery.submissionId]);
    expect(
      readCashierTransferRecoveryBySubmission(
        recovery.userId,
        recovery.clubId,
        concurrentRecovery.submissionId,
        storage,
        now
      )?.targetIds
    ).toEqual(concurrentRecovery.targetIds);

    clearCashierTransferRecovery(
      recovery.userId,
      recovery.clubId,
      recovery.submissionId,
      storage,
      now
    );
    expect(
      readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, now)?.submissionId
    ).toBe(concurrentRecovery.submissionId);

    // A stale tab cannot erase the remaining tab's journal with its own id.
    clearCashierTransferRecovery(
      recovery.userId,
      recovery.clubId,
      recovery.submissionId,
      storage,
      now
    );
    expect(
      readCashierTransferRecoveries(recovery.userId, recovery.clubId, storage, now)
    ).toHaveLength(1);
  });

  it('survives another tab writing between this tab preflighting and persisting', () => {
    const now = recovery.createdAt + 1_000;
    class InterleavingStorage extends MemoryStorage {
      private injected = false;

      override setItem(key: string, value: string) {
        if (!this.injected) {
          this.injected = true;
          const otherKey = key.replace(recovery.submissionId, concurrentRecovery.submissionId);
          super.setItem(
            otherKey,
            JSON.stringify({
              ...concurrentRecovery,
              failures: [
                {
                  userId: concurrentRecovery.targetIds[0],
                  name: 'Cashier Recipient',
                  message: 'Outcome Needs Verification',
                },
              ],
            })
          );
        }
        super.setItem(key, value);
      }
    }

    const storage = new InterleavingStorage();
    expect(writeCashierTransferRecovery(recovery, storage, now)).toBe(true);
    expect(
      readCashierTransferRecoveries(recovery.userId, recovery.clubId, storage, now).map(
        (entry) => entry.submissionId
      )
    ).toEqual([recovery.submissionId, concurrentRecovery.submissionId]);
  });

  it('still recovers and conditionally clears a rollout-era shared-key record', () => {
    const storage = new MemoryStorage();
    const now = recovery.createdAt + 1_000;
    storage.setItem(
      `${CASHIER_RECOVERY_PREFIX}:${recovery.userId}:${recovery.clubId}`,
      JSON.stringify(recovery)
    );

    expect(
      readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, now)?.submissionId
    ).toBe(recovery.submissionId);
    clearCashierTransferRecovery(
      recovery.userId,
      recovery.clubId,
      recovery.submissionId,
      storage,
      now
    );
    expect(readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, now)).toBeNull();
  });

  it('retains a malformed financial journal and blocks a replacement operation', () => {
    const storage = new MemoryStorage();
    const now = recovery.createdAt + 1_000;
    const key = `${CASHIER_RECOVERY_PREFIX}:${recovery.userId}:${recovery.clubId}:${recovery.submissionId}`;
    storage.setItem(key, '{"version":1,"truncated":');

    expect(readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, now)).toBeNull();
    expect(storage.getItem(key)).toBe('{"version":1,"truncated":');
    expect(writeCashierTransferRecovery(concurrentRecovery, storage, now)).toBe(false);
    expect(storage.getItem(key)).toBe('{"version":1,"truncated":');
    expect(storage.length).toBe(1);
  });

  it('reuses a chip-request operation after a lost response and simulated remount', async () => {
    const storage = new MemoryStorage();
    const intent = {
      userId: recovery.userId,
      clubId: recovery.clubId,
      amount: 75,
      note: '  Table Seven  ',
    };
    const firstId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const accidentalSecondId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const firstMount = await reserveCashierChipRequestOperation(
      intent,
      () => firstId,
      storage,
      recovery.createdAt
    );
    // The RPC may have committed here and lost its response. A remounted page
    // has no ref state, so only the durable canonical intent can recover it.
    const remount = await reserveCashierChipRequestOperation(
      { ...intent, note: 'Table Seven' },
      () => accidentalSecondId,
      storage,
      recovery.createdAt + 1
    );

    expect(firstMount?.operationId).toBe(firstId);
    expect(remount?.operationId).toBe(firstId);
    expect(
      storage
        .entries()
        .map(([, value]) => value)
        .join('')
    ).not.toContain('Table Seven');

    expect(clearCashierChipRequestOperation(remount!, storage, recovery.createdAt + 2)).toBe(true);
    const freshIntent = await reserveCashierChipRequestOperation(
      intent,
      () => accidentalSecondId,
      storage,
      recovery.createdAt + 3
    );
    expect(freshIntent?.operationId).toBe(accidentalSecondId);
  });

  it('fails chip requests closed when their retry journal cannot be written', async () => {
    const reserved = await reserveCashierChipRequestOperation(
      { userId: recovery.userId, clubId: recovery.clubId, amount: 75, note: null },
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      new RefusingStorage(),
      recovery.createdAt
    );
    expect(reserved).toBeNull();
  });

  it('reports a refused recovery write instead of pretending the intent is durable', () => {
    expect(
      writeCashierTransferRecovery(recovery, new RefusingStorage(), recovery.createdAt + 1_000)
    ).toBe(false);
  });

  it('retains old unresolved intents and rejects cross-scope and incomplete payloads', () => {
    const storage = new MemoryStorage();
    const now = recovery.createdAt + 1_000;
    expect(writeCashierTransferRecovery(recovery, storage, now)).toBe(true);
    expect(
      readCashierTransferRecovery(
        '88888888-8888-4888-8888-888888888888',
        recovery.clubId,
        storage,
        now
      )
    ).toBeNull();
    expect(
      readCashierTransferRecovery(
        recovery.userId,
        recovery.clubId,
        storage,
        recovery.createdAt + 24 * 60 * 60 * 1000 + 1
      )
    ).toEqual(expect.objectContaining({ submissionId: recovery.submissionId }));

    const incomplete = { ...recovery, opIds: {} };
    expect(writeCashierTransferRecovery(incomplete, storage, now)).toBe(false);
  });

  it('locks every money path behind the browser connection guard', () => {
    expect(page).toContain("window.addEventListener('online', handleOnline)");
    expect(page).toContain("window.addEventListener('offline', handleOffline)");
    expect(page).toContain('Cashier Is Offline. Reconnect Before Moving Chips');
    expect(page).toMatch(/const actOnTicket[\s\S]+?if \(!requireOnline\(\)\) return/);
    expect(page).toMatch(/const respondToRequest[\s\S]+?if \(!requireOnline\(\)\) return/);
    expect(page).toMatch(/const askForChips[\s\S]+?if \(!requireOnline\(\)\) return/);
    expect(page).toMatch(/const runTransfers[\s\S]+?if \(!requireOnline\(\)\) return/);
    expect(page).toMatch(/const claimBack[\s\S]+?if \(!requireOnline\(\)\) return/);
    expect(page).toContain('if (!isOnline) setActiveCashier(null)');
  });

  it('journals a chip request before its RPC and retains unknown outcomes', () => {
    const requestBody = page.slice(
      page.indexOf('const askForChips ='),
      page.indexOf('// ── Settlement invoices')
    );
    expect(requestBody.indexOf('reserveCashierChipRequestOperation(')).toBeLessThan(
      requestBody.indexOf("supabase.rpc('fn_request_chips'")
    );
    expect(requestBody).toMatch(
      /if \(!recovery\) \{[\s\S]+Cashier Safety Storage Is Unavailable[\s\S]+return;/
    );
    expect(requestBody).toContain("throw new Error('Request Outcome Needs Verification')");
    expect(requestBody).toMatch(
      /if \(!res\.success\) \{[\s\S]+clearCashierChipRequestOperation\(recovery\)/
    );
    expect(requestBody.match(/clearCashierChipRequestOperation\(recovery\)/g)).toHaveLength(2);
    expect(requestBody).toContain("toast?.success?.('Chip Request Sent')");
  });

  it('shows one reconciliation console with verified freshness evidence', () => {
    expect(page).toContain('data-cashier-recovery="true"');
    expect(page).toContain('Reconciliation Console');
    expect(
      readFileSync(resolve(root, 'src/components/wallet/CashierConservationReport.tsx'), 'utf8')
    ).toContain('Reconcile Now');
    expect(page).toContain('if (complete) setLastVerifiedAt(Date.now())');
    expect(page).not.toContain('Cashier Balances Reconciled');
    expect(page).toContain('CashierConservationReport');
    expect(page).toContain('onRefresh={reconcileCashier}');
    expect(page).toContain('if (floatRes.error) {');
    expect(page).toContain("reportError(floatRes.error, 'CashierTradePage.agentWallet')");
    expect(page).toContain('checks.every((complete) => complete === true)');
    expect(page).toContain("tab === 'record' ? loadRecords()");
    expect(page).toContain("tab === 'leaderboard' ? loadInvoices()");
    expect(page).toContain('Not Yet Refreshed');
  });

  it('preserves a partial batch as a visible retryable intent', () => {
    const transferBody = page.slice(
      page.indexOf('const runTransfers ='),
      page.indexOf('const loadReversible =')
    );
    expect(page).toContain('type CashierTransferRecovery');
    expect(page).toContain('setTransferRecovery(recovery)');
    expect(transferBody).toContain('await updateDurableCashierTransfer(recovery)');
    const reservation = transferBody.indexOf(
      'uncertainRecovery = await reserveDurableCashierTransfer(uncertainRecovery)'
    );
    expect(reservation).toBeGreaterThan(0);
    expect(transferBody.indexOf('busyRef.current = true')).toBeLessThan(reservation);
    expect(reservation).toBeLessThan(
      transferBody.indexOf("supabase.rpc('fn_cashier_batch_transfer'")
    );
    expect(transferBody).toContain('submissionId = uncertainRecovery.submissionId');
    expect(transferBody).toContain(
      'opIdsRef.current = new Map(Object.entries(uncertainRecovery.opIds))'
    );
    expect(transferBody).toContain('await clearDurableCashierTransfer(uncertainRecovery)');
    expect(transferBody).toContain('Cashier Recovery Is Unavailable. Try Again');
    expect(transferBody).not.toContain('if (!writeCashierTransferRecovery(uncertainRecovery))');
    expect(page).toContain('readCashierTransferRecovery(user.id, clubUuid)');
    expect(page).toContain('submissionId,');
    expect(page).toContain('opIds: Object.fromEntries(opIdsRef.current)');
    expect(page).toContain('Original Retry Keys Are Preserved');
    expect(page).toContain('Review And Retry');
    expect(page).toContain('saved.failures');
    expect(page).toContain('.filter((failure) => !confirmedTargets.has(failure.userId))');
    expect(page).toContain("supabase.rpc('fn_cashier_recovery_receipts'");
    expect(page).toContain('opIdsRef.current = new Map()');
    expect(page).not.toContain('`${entry.userId}:${entry.message}`');
  });

  it('opens ledger rows as accessible, copyable receipts on desktop and mobile', () => {
    expect(page).toContain('Transaction Receipt');
    expect(page).toContain('Immutable Ledger Entry');
    expect(page).toContain('Copy Receipt');
    expect(page).toContain('cashierReceiptText(receipt');
    expect(page).toContain('aria-label={`Open Receipt For');
    expect(styles).toContain('.receiptRow');
    expect(styles).toContain('.receiptFacts');
    expect(styles).toMatch(/@media \(max-width: 560px\)[\s\S]+\.recoveryGrid/);
  });
});

describe('unresolved transfer identities do not expire', () => {
  it.each([1, 2, 3])('retains journal version %i after thirty days', (version) => {
    const storage = new MemoryStorage();
    const base = `${CASHIER_RECOVERY_PREFIX}:${recovery.userId}:${recovery.clubId}`;
    if (version === 1) storage.setItem(base, JSON.stringify(recovery));
    else if (version === 2)
      storage.setItem(
        base,
        JSON.stringify({
          version: 2,
          userId: recovery.userId,
          clubId: recovery.clubId,
          recoveries: [recovery],
        })
      );
    else expect(writeCashierTransferRecovery(recovery, storage, recovery.createdAt)).toBe(true);
    const later = recovery.createdAt + 30 * 24 * 60 * 60 * 1000;
    const restored = readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, later);
    expect(restored?.opIds).toEqual(recovery.opIds);
    expect(restored?.submissionId).toBe(recovery.submissionId);
    expect(writeCashierTransferRecovery(recovery, storage, later)).toBe(true);
    expect(
      writeCashierTransferRecovery({ ...recovery, amount: recovery.amount + 1 }, storage, later)
    ).toBe(false);
    clearCashierTransferRecovery(
      recovery.userId,
      recovery.clubId,
      recovery.submissionId,
      storage,
      later
    );
    expect(readCashierTransferRecoveries(recovery.userId, recovery.clubId, storage, later)).toEqual(
      []
    );
  });
});

describe('Phase 5 durable individual batch amounts', () => {
  it('round-trips exact amounts without changing legacy uniform journals', () => {
    const storage = new MemoryStorage();
    const custom = {
      ...recovery,
      targetAmounts: {
        [recovery.targetIds[0]]: 0.1,
        [recovery.targetIds[1]]: 21.05,
      },
    };
    expect(writeCashierTransferRecovery(custom, storage, recovery.createdAt)).toBe(true);
    expect(
      readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, recovery.createdAt)
        ?.targetAmounts
    ).toEqual(custom.targetAmounts);
    expect(
      writeCashierTransferRecovery(
        { ...custom, targetAmounts: { ...custom.targetAmounts, [recovery.targetIds[1]]: 22 } },
        storage,
        recovery.createdAt
      )
    ).toBe(false);
    expect(
      readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, recovery.createdAt)
        ?.targetAmounts
    ).toEqual(custom.targetAmounts);
  });
  it.each([0, -1, 10.005, 1_000_000_001, NaN, Infinity])(
    'refuses invalid retained recipient value %s',
    (value) => {
      const storage = new MemoryStorage();
      expect(
        writeCashierTransferRecovery(
          {
            ...recovery,
            targetAmounts: {
              [recovery.targetIds[0]]: value,
              [recovery.targetIds[1]]: 1,
            },
          },
          storage,
          recovery.createdAt
        )
      ).toBe(false);
      expect(storage.length).toBe(0);
    }
  );
  it('refuses missing or extra amounts before a retry can change the original intent', () => {
    const storage = new MemoryStorage();
    expect(
      writeCashierTransferRecovery(
        { ...recovery, targetAmounts: { [recovery.targetIds[0]]: 1 } },
        storage,
        recovery.createdAt
      )
    ).toBe(false);
    expect(
      writeCashierTransferRecovery(
        {
          ...recovery,
          targetAmounts: {
            [recovery.targetIds[0]]: 1,
            [recovery.targetIds[1]]: 2,
            '88888888-8888-4888-8888-888888888888': 3,
          },
        },
        storage,
        recovery.createdAt
      )
    ).toBe(false);
  });
});

it('persists and restores a batch for an existing non-RFC PostgreSQL club UUID', () => {
  const storage = new MemoryStorage();
  const row = { ...recovery, clubId: 'a0000000-0000-0000-0000-000000000001' };
  expect(writeCashierTransferRecovery(row, storage, row.createdAt)).toBe(true);
  expect(readCashierTransferRecovery(row.userId, row.clubId, storage, row.createdAt)).toEqual({
    ...row,
    failures: row.failures.map((failure) => ({
      ...failure,
      name: 'Cashier Recipient',
      message: 'Outcome Needs Verification',
    })),
  });
});

it('retains one source and exact recipient wallets through a reload and refuses mutation of a retained intent', () => {
  const storage = new MemoryStorage();
  const row: CashierTransferRecovery = {
    ...recovery,
    source: 'club_promo_wallet',
    destinations: Object.fromEntries(recovery.targetIds.map((id) => [id, 'promo_wallet'])),
  };
  expect(writeCashierTransferRecovery(row, storage, row.createdAt)).toBe(true);
  expect(readCashierTransferRecovery(row.userId, row.clubId, storage, row.createdAt)).toEqual(
    expect.objectContaining({ source: 'club_promo_wallet', destinations: row.destinations })
  );
  expect(
    writeCashierTransferRecovery({ ...row, source: 'club_bank' }, storage, row.createdAt)
  ).toBe(false);
  expect(
    writeCashierTransferRecovery(
      { ...row, destinations: Object.fromEntries(row.targetIds.map((id) => [id, 'agent_wallet'])) },
      storage,
      row.createdAt
    )
  ).toBe(false);
});
