/**
 * DiamondService.getLifetimeStats asks the database for the sum
 * (fn_diamond_lifetime_totals, migration 20260913171905) and reports
 * "could not tell" as null, never as a zero.
 *
 * Until 2026-09-13 it read up to 5,000 rows into the browser, added them up
 * there, and returned { 0, 0 } on a failed read - a figure indistinguishable
 * from a brand-new account, presented as a lifetime. The wallet's Earn pane
 * now renders "Unavailable" with a Retry for null (PlayerWalletPage), and the
 * World Hub's /api/store/diamond-transactions reads the same RPC, so one
 * ledger cannot report two lifetimes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { DiamondService } = await import('../../src/services/DiamondService');

describe('DiamondService.getLifetimeStats', () => {
  beforeEach(() => rpc.mockReset());

  it('calls fn_diamond_lifetime_totals for the user and returns the SQL sums', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ lifetime_earned: '740908', lifetime_spent: 12, credits: 431, debits: 9 }],
      error: null,
    });
    const r = await DiamondService.getLifetimeStats('u-1');
    expect(rpc).toHaveBeenCalledWith('fn_diamond_lifetime_totals', { p_user_id: 'u-1' });
    expect(r).toEqual({ lifetimeEarned: 740908, lifetimeSpent: 12 });
  });

  it('accepts a single-object payload as well as a one-row array', async () => {
    rpc.mockResolvedValueOnce({ data: { lifetime_earned: 5, lifetime_spent: 0 }, error: null });
    expect(await DiamondService.getLifetimeStats('u-1')).toEqual({
      lifetimeEarned: 5,
      lifetimeSpent: 0,
    });
  });

  it('a failed read is null, never { 0, 0 } (10.86)', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await DiamondService.getLifetimeStats('u-1')).toBeNull();
  });

  it('an empty or non-numeric answer is null too', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await DiamondService.getLifetimeStats('u-1')).toBeNull();
    rpc.mockResolvedValueOnce({ data: [{ lifetime_earned: 'x', lifetime_spent: 1 }], error: null });
    expect(await DiamondService.getLifetimeStats('u-1')).toBeNull();
  });

  it('a thrown rpc is null', async () => {
    rpc.mockRejectedValueOnce(new Error('network'));
    expect(await DiamondService.getLifetimeStats('u-1')).toBeNull();
  });
});

describe('the wallet page honours the three outcomes', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/PlayerWalletPage.tsx'), 'utf8');

  it('distinguishes reading, failed and known, and offers a retry on failure', () => {
    expect(page).toContain('useState<DiamondLifetimeStats | null | undefined>(undefined)');
    expect(page).toMatch(/lifetime === null\s*\?\s*'Unavailable'/);
    expect(page).toContain('Your Lifetime Totals Could Not Be Read.');
    expect(page).toContain('onClick={() => void loadLifetime()}');
  });

  it('never prints a zero it did not read', () => {
    // The old shape: a zeroed object from the service rendered as a figure.
    expect(page).not.toMatch(/lifetimeEarned: 0,\s*lifetimeSpent: 0/);
  });

  it('reads the claim state from /api/rewards/progress instead of waiting for a click', () => {
    expect(page).toContain('if (data.loginClaimedToday === true) setClaimedToday(true);');
    expect(page).toContain('nextLoginReward: Number(data.nextLoginReward) || 0');
    expect(page).toContain('partial: Boolean(data.partial)');
  });

  it('checks the user before flipping the transfer busy flag', () => {
    const i = page.indexOf('if (!user?.id) return;\n    setIsTransferring(true);');
    expect(i).toBeGreaterThan(0);
  });
});

describe('storeFetch carries the idempotency key the money routes require', () => {
  const shared = readFileSync(
    resolve(process.cwd(), 'src/pages/marketplace/marketplaceShared.ts'),
    'utf8'
  );
  it('sends X-Idempotency-Key when given one', () => {
    expect(shared).toContain(
      "if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;"
    );
    expect(shared).toContain('idempotencyKey?: string;');
  });
});

describe('the ledger rows name the other player', () => {
  const hook = readFileSync(resolve(process.cwd(), 'src/hooks/useDiamondLedger.ts'), 'utf8');
  const page = readFileSync(resolve(process.cwd(), 'src/pages/PlayerWalletPage.tsx'), 'utf8');
  it('the hook reads metadata and surfaces counterpartyId by direction', () => {
    expect(hook).toContain(
      "'id, type, transaction_type, amount, description, created_at, metadata'"
    );
    expect(hook).toContain("direction === 'out' ? meta.recipient_id : meta.sender_id");
    expect(hook).toContain('counterpartyId: string | null;');
  });
  it('the page resolves it through the friend list on both panes', () => {
    expect(page).toContain("describeRow(row, 'Sent To')");
    expect(page).toContain("describeRow(row, 'Received From')");
    expect(page).toContain("(activeTab === 'send' || activeTab === 'receive') && friends === null");
  });
});
