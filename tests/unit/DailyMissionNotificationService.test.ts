import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ maybeSingle: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      upsert: () => ({
        select: () => ({ maybeSingle: (...args: unknown[]) => mocks.maybeSingle(...args) }),
      }),
    }),
  },
}));

const { setDailyMissionAlertPreference } =
  await import('../../src/services/DailyMissionNotificationService');

describe('Daily Mission alert preference receipts', () => {
  beforeEach(() => mocks.maybeSingle.mockReset());

  it('accepts the exact requested preference', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { daily_mission_reminders: true },
      error: null,
    });
    await expect(setDailyMissionAlertPreference('user', true)).resolves.toEqual({ enabled: true });
  });

  it('rejects a contradictory write receipt instead of announcing the requested state', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { daily_mission_reminders: false },
      error: null,
    });
    await expect(setDailyMissionAlertPreference('user', true)).rejects.toThrow(/contradictory/i);
  });
});
