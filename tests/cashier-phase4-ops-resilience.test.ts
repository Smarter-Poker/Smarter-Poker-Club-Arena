import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cashierReceiptText,
  clearCashierTransferRecovery,
  readCashierTransferRecovery,
  writeCashierTransferRecovery,
  type CashierTransferRecovery,
} from '../src/services/CashierResilience';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
const styles = readFileSync(resolve(root, 'src/pages/CashierTradePage.module.css'), 'utf8');

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
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

  it('round-trips the exact unresolved intent and original per-target retry keys', () => {
    const storage = new MemoryStorage();
    const now = recovery.createdAt + 1_000;

    expect(writeCashierTransferRecovery(recovery, storage, now)).toBe(true);
    expect(readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, now)).toEqual(
      recovery
    );

    clearCashierTransferRecovery(recovery.userId, recovery.clubId, storage);
    expect(readCashierTransferRecovery(recovery.userId, recovery.clubId, storage, now)).toBeNull();
  });

  it('rejects stale, cross-scope, and incomplete recovery payloads', () => {
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
    ).toBeNull();

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

  it('shows one reconciliation console with verified freshness evidence', () => {
    expect(page).toContain('data-cashier-recovery="true"');
    expect(page).toContain('Reconciliation Console');
    expect(page).toContain('Reconcile Now');
    expect(page).toContain('if (complete) setLastVerifiedAt(Date.now())');
    expect(page).toContain('Cashier Balances Reconciled');
    expect(page).toContain('if (floatRes.error) {');
    expect(page).toContain("reportError(floatRes.error, 'CashierTradePage.agentWallet')");
    expect(page).toContain('checks.every((complete) => complete === true)');
    expect(page).toContain("tab === 'record' ? loadRecords()");
    expect(page).toContain("tab === 'leaderboard' ? loadInvoices()");
    expect(page).toContain('Not Yet Verified');
  });

  it('preserves a partial batch as a visible retryable intent', () => {
    const transferBody = page.slice(
      page.indexOf('const runTransfers ='),
      page.indexOf('const loadReversible =')
    );
    expect(page).toContain('type CashierTransferRecovery');
    expect(page).toContain('setTransferRecovery(recovery)');
    expect(page).toContain('writeCashierTransferRecovery(recovery)');
    expect(page).toContain('writeCashierTransferRecovery(uncertainRecovery)');
    expect(transferBody.indexOf('writeCashierTransferRecovery(uncertainRecovery)')).toBeLessThan(
      transferBody.indexOf("supabase.rpc('fn_cashier_batch_transfer'")
    );
    expect(page).toContain('readCashierTransferRecovery(user.id, clubUuid)');
    expect(page).toContain('submissionId,');
    expect(page).toContain('opIds: Object.fromEntries(opIdsRef.current)');
    expect(page).toContain('Original Retry Keys Are Preserved');
    expect(page).toContain('Review And Retry');
    expect(page).toContain('setTransferFailures(saved.failures)');
    expect(page).toContain('opIdsRef.current = new Map()');
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
