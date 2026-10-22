import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  applied: vi.fn(),
  welcome: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) },
}));
vi.mock('../../src/services/ClubOpeningSetupService', () => ({
  clubOpeningSetupService: {
    getState: mocks.state,
    getAppliedState: mocks.applied,
    complete: mocks.complete,
  },
}));
vi.mock('../../src/services/ClubWelcomePackageService', () => ({
  clubWelcomePackageService: { get: mocks.welcome },
}));
import {
  completeDefaultClubOpening,
  defaultClubOpeningInput,
} from '../../src/services/ClubQuickStartService';
import { supabase } from '../../src/lib/supabase';
import type { ClubWelcomePackageState } from '../../src/services/ClubWelcomePackageService';
const welcome = {
  status: 'provisioned',
  economics: { bbjEnabled: true, bbjSeed: 100, spinsEnabled: true, spinSeed: 200, spinMaxStake: 1 },
} as ClubWelcomePackageState;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);
  mocks.state.mockResolvedValue(null);
  mocks.applied.mockResolvedValue({ tagline: '' });
  mocks.welcome.mockResolvedValue(welcome);
  mocks.complete.mockResolvedValue({ success: true });
});
describe('club default opening', () => {
  it('reuses funded principals and never opts into new transfers or paid programs', () => {
    expect(defaultClubOpeningInput('club', '', welcome)).toMatchObject({
      tagline: 'Good Friends. Great Poker.',
      rakePercent: -1,
      rakeCapBB: -1,
      bbjEnabled: true,
      bbjSeed: 100,
      spinsEnabled: true,
      spinSeed: 200,
      promoEnabled: false,
      promoBudget: 0,
      leaderboardRewardsEnabled: false,
      leaderboardPrizeBudget: 0,
      leaderboardOverlayEnabled: false,
    });
  });
  it('preserves a saved tagline and treats an unprovisioned package as unfunded', () => {
    expect(
      defaultClubOpeningInput('club', 'My Room', { ...welcome, status: 'not_eligible' })
    ).toMatchObject({
      tagline: 'My Room',
      bbjEnabled: false,
      bbjSeed: 0,
      spinsEnabled: false,
      spinSeed: 0,
    });
  });
  it('reads durable setup before retry and leaves an earlier completed setup alone', async () => {
    mocks.state.mockResolvedValue({ completed_at: '2026-10-22' });
    await completeDefaultClubOpening('club', 'operation');
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.welcome).not.toHaveBeenCalled();
  });
  it('holds the original operation identity across an unknown outcome', async () => {
    mocks.complete
      .mockRejectedValueOnce(new Error('Connection Lost'))
      .mockResolvedValueOnce({ success: true });
    await expect(completeDefaultClubOpening('club', 'operation')).rejects.toThrow(
      'Connection Lost'
    );
    await completeDefaultClubOpening('club', 'operation');
    expect(mocks.complete.mock.calls.map((c) => c[1])).toEqual(['operation', 'operation']);
  });
  it('does not write defaults when the package or club cannot be confirmed', async () => {
    mocks.welcome.mockResolvedValue({ ...welcome, status: 'ready' });
    await expect(completeDefaultClubOpening('club', 'operation')).rejects.toThrow('Starter Games');
    expect(mocks.complete).not.toHaveBeenCalled();
    mocks.welcome.mockRejectedValue(new Error('No Access'));
    await expect(completeDefaultClubOpening('club', 'operation')).rejects.toThrow('No Access');
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('refuses automatic setup before the database prerequisite is installed', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { message: 'Function Missing' },
    } as never);
    await expect(completeDefaultClubOpening('club', 'operation')).rejects.toThrow(
      'Not Available Yet'
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
