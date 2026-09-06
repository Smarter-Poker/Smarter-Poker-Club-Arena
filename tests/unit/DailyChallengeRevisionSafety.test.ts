import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: (...args: unknown[]) => mocks.maybeSingle(...args) }),
      }),
    }),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => mocks.reportError(...args),
}));

vi.mock('../../src/utils/retryFetch', () => ({
  retryFetch: (operation: () => Promise<unknown>) => operation(),
}));

const { dailyChallengeService } = await import('../../src/services/DailyChallengeService');
const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('Daily Challenge revision cursor safety', () => {
  beforeEach(() => {
    mocks.maybeSingle.mockReset();
    mocks.reportError.mockReset();
  });

  it('uses zero only when the player legitimately has no cursor row', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(dailyChallengeService.getDashboardRevision(USER_ID)).resolves.toBe(0);
  });

  it.each([{ revision: '7' }, { revision: 7.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }])(
    'rejects a malformed present cursor %#',
    async (data) => {
      mocks.maybeSingle.mockResolvedValue({ data, error: null });
      await expect(dailyChallengeService.getDashboardRevision(USER_ID)).rejects.toThrow(/invalid/i);
      expect(mocks.reportError).toHaveBeenCalled();
    }
  );

  it('accepts a positive safe-integer cursor', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { revision: 7 }, error: null });
    await expect(dailyChallengeService.getDashboardRevision(USER_ID)).resolves.toBe(7);
  });
});
