import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mock.from } }));
import { throwableService } from '../../src/services/ThrowableService';
function data(
  profile: Record<string, unknown>,
  count: number | null = 0,
  error: unknown = null,
  packs: unknown[] = []
) {
  const gte = vi.fn().mockResolvedValue({ count, error });
  mock.from.mockImplementation((table: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: profile, error: null }),
      gte,
      then: (resolve: any) => Promise.resolve({ data: packs, error: null }).then(resolve),
    };
    return chain;
  });
  return gte;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-01T01:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('throwable allowance matches the live server rules', () => {
  it('uses UTC month boundaries and reports the remaining 500-use allowance', async () => {
    const gte = data({ is_vip: true, vip_expires_at: '2026-10-01T00:00:00Z' }, 499);
    expect(await throwableService.getThrowAllowance('user')).toMatchObject({
      isVip: true,
      freeThrowsRemaining: 1,
      diamondCost: 0,
    });
    expect(gte).toHaveBeenCalledWith('created_at', '2026-09-01T00:00:00.000Z');
  });
  it('does not promise monthly free throws to an expired VIP', async () => {
    data({ is_vip: true, vip_expires_at: '2026-08-31T00:00:00Z' });
    expect(await throwableService.getThrowAllowance('user')).toMatchObject({
      isVip: false,
      freeThrowsRemaining: 0,
      diamondCost: 1,
    });
  });
  it('shows lifetime membership as unlimited even with an old expiry field', async () => {
    data({ is_vip: true, vip_tier: 'lifetime', vip_expires_at: '2020-01-01T00:00:00Z' }, 700);
    expect(await throwableService.getThrowAllowance('user')).toMatchObject({
      unlimited: true,
      diamondCost: 0,
    });
  });
  it('uses only positive unexpired pack credits after monthly allowance is exhausted', async () => {
    data({ is_vip: true }, 500, null, [
      { uses_remaining: 3, expires_at: null },
      { uses_remaining: 9, expires_at: '2026-08-01' },
      { uses_remaining: -1, expires_at: null },
    ]);
    expect(await throwableService.getThrowAllowance('user')).toMatchObject({
      freeThrowsRemaining: 0,
      packThrowsRemaining: 3,
      diamondCost: 0,
    });
  });
  it('does not turn a failed usage count into a fresh allowance of 500', async () => {
    data({ is_vip: true }, null, { message: 'unavailable' });
    expect(await throwableService.getThrowAllowance('user')).toMatchObject({
      unavailable: true,
      freeThrowsRemaining: 0,
    });
  });
});
