import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchesClubParam } from '../../src/utils/clubScopedPath';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';
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
  defaultClubOpeningOperationId,
} from '../../src/services/ClubQuickStartService';
import { supabase } from '../../src/lib/supabase';
import type { ClubWelcomePackageState } from '../../src/services/ClubWelcomePackageService';
const welcome = {
  status: 'provisioned',
  economics: { bbjEnabled: true, bbjSeed: 100, spinsEnabled: true, spinSeed: 200, spinMaxStake: 1 },
} as ClubWelcomePackageState;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.clearAllMocks();
  vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);
  mocks.state.mockResolvedValue(null);
  mocks.applied.mockResolvedValue({ tagline: '' });
  mocks.welcome.mockResolvedValue(welcome);
  mocks.complete.mockResolvedValue({ success: true });
});
afterEach(() => vi.unstubAllGlobals());
describe('club default opening', () => {
  it.each([
    'src/services/ClubQuickStartService.ts',
    'src/services/ClubOpeningSetupService.ts',
    'src/services/ClubWelcomePackageService.ts',
    'scripts/ci/test-quick-club-opening.py',
    'tests/unit/clubQuickStart.test.ts',
  ])('requires the hosted native accounting proof when %s changes', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
  });
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
    const key = await defaultClubOpeningOperationId('club', 'operation');
    expect(key).not.toBe('operation');
    expect(mocks.complete.mock.calls.map((c) => c[1])).toEqual([key, key]);
  });
  it('separates welcome publication and opening keys while binding the exact club and request', async () => {
    const club = '22222222-2222-4222-8222-222222222222';
    const request = '33333333-3333-4333-8333-333333333333';
    const key = await defaultClubOpeningOperationId(club, request);
    expect(key).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(key).not.toBe(request);
    expect(await defaultClubOpeningOperationId(club.toUpperCase(), request)).toBe(key);
    expect(await defaultClubOpeningOperationId('another-club', request)).not.toBe(key);
    expect(await defaultClubOpeningOperationId(club, 'another-request')).not.toBe(key);
    expect(
      await defaultClubOpeningOperationId(
        '66666666-6666-4666-8666-666666666666',
        '77777777-7777-4777-8777-777777777777'
      )
    ).toBe('9f8de0d8-45e3-8855-a11a-fb81e3796f04');
    mocks.complete.mockImplementation((_input, operation) => {
      if (operation === request) throw new Error('Leaderboard Publication Retry Key Was Reused');
      return { success: true };
    });
    await expect(completeDefaultClubOpening(club, request)).resolves.toMatchObject({
      success: true,
    });
  });
  it('accepts the canonical slug only for the loaded club and retains owner/embed guards', () => {
    const club = { id: '22222222-2222-4222-8222-222222222222', slug: 'my-new-club' };
    expect(matchesClubParam(club, club.id)).toBe(true);
    expect(matchesClubParam(club, club.slug)).toBe(true);
    expect(matchesClubParam(club, 'a-different-club')).toBe(false);
    const source = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');
    const guard = source.slice(
      source.indexOf("searchParams.get('invite') !== '1'"),
      source.indexOf('setQuickStartInvite(true)')
    );
    expect(guard).toContain('!matchesClubParam(club, clubId)');
    expect(guard).toContain('!isOwner');
    expect(source).toContain("clubIdOverride ||\n      searchParams.get('invite')");
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
