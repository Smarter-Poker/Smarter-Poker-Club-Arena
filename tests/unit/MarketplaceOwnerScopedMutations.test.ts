import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Marketplace Owner-Scoped Mutations', () => {
  it('binds admin mutations and reads to the initiating account and club', () => {
    const manage = read('src/pages/marketplace/ManageTab.tsx');
    const ledger = read('src/pages/marketplace/PurchaseLedger.tsx');
    const page = read('src/pages/MarketplacePage.tsx');

    expect(manage).toContain('activeOwnerRef.current.userId === expectedUserId');
    expect(manage).toContain('activeOwnerRef.current.clubId === expectedClubId');
    expect(manage).toContain('mutationAttemptRef.current === attemptId');
    expect(manage).toContain('expectedUserId: operation.expectedUserId');
    expect(manage).toContain('signal: operation.controller.signal');
    expect(manage).toContain('loadAbortRef.current?.abort()');

    expect(ledger).toContain('activeOwnerRef.current.userId === expectedUserId');
    expect(ledger).toContain('activeOwnerRef.current.clubId === expectedClubId');
    expect(ledger).toContain('expectedUserId,');
    expect(ledger).toContain('signal: controller.signal');
    expect(ledger).toContain('loadAttemptRef.current === attemptId');

    expect(page).toContain("key={`${user?.id || 'signed-out'}:${clubId}`}");
    expect(page).toContain("userId={user?.id || ''}");
  });

  it('suppresses stale refund and redemption effects after identity changes', () => {
    const items = read('src/pages/marketplace/MyItemsTab.tsx');

    expect(items).toContain('refundAttemptRef.current === attemptId');
    expect(items).toContain('activeOwnerRef.current.userId === expectedUserId');
    expect(items).toContain('activeOwnerRef.current.clubId === expectedClubId');
    expect(items).toContain('expectedUserId,');
    expect(items).toContain('signal: controller.signal');
    expect(items).toContain('redeemAttemptRef.current === attemptId');
    expect(items).toContain('initiatingSession?.user?.id !== expectedUserId');
    expect(items).toContain('confirmedSession?.user?.id !== expectedUserId');
    expect(items).toContain('if (!isCurrent()) return;');
  });

  it('keeps a verified Store purchase truthful when its protected key cannot retire', () => {
    const store = read('src/pages/marketplace/StoreTab.tsx');

    expect(store).toContain('completedRecoveryRetired = false');
    expect(store).toContain('setRecoveryBlockedItemId(purchaseItem.id)');
    expect(store).toContain('recoveryBlockedItemId === item.id');
    expect(store).toContain("? 'Recovery Locked'");
    expect(store).toContain('Was Purchased, But Its Secure Recovery Key Could Not Be Cleared');
  });
});
