import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cashierReceiptText } from '../src/services/CashierResilience';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
const styles = readFileSync(resolve(root, 'src/pages/CashierTradePage.module.css'), 'utf8');

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
    expect(page).toContain('Not Yet Verified');
  });

  it('preserves a partial batch as a visible retryable intent', () => {
    expect(page).toContain('interface TransferRecovery');
    expect(page).toContain('setTransferRecovery({');
    expect(page).toContain('Original Retry Keys Are Preserved');
    expect(page).toContain('Review And Retry');
    expect(page).toContain('setTransferFailures(transferRecovery.failures)');
    expect(page).toContain('opIdsRef.current = new Map()');
  });

  it('opens ledger rows as accessible, copyable receipts on desktop and mobile', () => {
    expect(page).toContain('Transaction Receipt');
    expect(page).toContain('Immutable Ledger Entry');
    expect(page).toContain('Copy Receipt');
    expect(page).toContain('cashierReceiptText(receipt');
    expect(page).toContain('aria-label={`Open receipt for');
    expect(styles).toContain('.receiptRow');
    expect(styles).toContain('.receiptFacts');
    expect(styles).toMatch(/@media \(max-width: 560px\)[\s\S]+\.recoveryGrid/);
  });
});
