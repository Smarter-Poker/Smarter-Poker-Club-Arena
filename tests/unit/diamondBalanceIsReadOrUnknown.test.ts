/**
 * AN UNREAD DIAMOND BALANCE IS NOT A BALANCE OF ZERO (2026-10-07).
 *
 * DiamondService.getBalance reported a failed owner-door read and then RESOLVED
 * `{ balance: 0 }`, so useWalletStore's catch - the one that keeps the last
 * known figure when a fetch fails - never ran, and the wallet painted 0 for
 * money that was still there. CLAUDE.md 10.86 rules 1 and 2: "could not tell"
 * has its own outcome, and an unreadable answer is never coerced into an empty
 * one. These pin the outcomes: read, read as zero, refused, and no row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const maybeSingle = vi.fn();
vi.mock('../../src/lib/ownProfile', () => ({
  ownProfile: () => ({ select: () => ({ maybeSingle: () => maybeSingle() }) }),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { DiamondService } = await import('../../src/services/DiamondService');

beforeEach(() => maybeSingle.mockReset());

describe('DiamondService.getBalance reads the balance or says it could not', () => {
  it('returns the balance it read', async () => {
    maybeSingle.mockResolvedValue({ data: { diamonds: 1250 }, error: null });
    await expect(DiamondService.getBalance('u1')).resolves.toEqual({ balance: 1250 });
  });

  it('returns a real zero when the player holds zero', async () => {
    maybeSingle.mockResolvedValue({ data: { diamonds: 0 }, error: null });
    await expect(DiamondService.getBalance('u1')).resolves.toEqual({ balance: 0 });
  });

  it('throws, rather than answering 0, when the read is refused', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'denied' } });
    await expect(DiamondService.getBalance('u1')).rejects.toBeTruthy();
  });

  it('throws, rather than answering 0, when the owner door returns no row', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(DiamondService.getBalance('u1')).rejects.toThrow('diamond_balance_unread');
  });

  it('the profile page keeps its last figure when the balance cannot be read', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/pages/ProfilePage.tsx'), 'utf8');
    const call = page.slice(page.indexOf('DiamondService.getBalance(requestedUserId)'));
    expect(call.slice(0, 400)).toContain('.catch(');
    expect(call.slice(0, 400)).not.toContain('dw.balance || 0');
  });
});
