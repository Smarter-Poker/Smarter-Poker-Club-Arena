import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({ supabase: mocks }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../../src/services/UnionApiService', () => ({ unionApi: {} }));
vi.mock('../../src/utils/clubIdResolver', () => ({
  isUUID: vi.fn(),
  resolveClubUUID: vi.fn(),
}));
vi.mock('../../src/lib/constants', () => ({ QUERY_LIMITS: {} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import UnionService from '../../src/services/UnionService';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');

describe('appointed union operator authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the authoritative operator RPC without membership-scoped table reads', async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });

    await expect(UnionService.isUnionAdmin('union-id', 'appointed-admin-id')).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_is_union_operator', {
      p_union_id: 'union-id',
      p_user_id: 'appointed-admin-id',
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('fails closed by surfacing an authority RPC error', async () => {
    const refusal = new Error('authority unavailable');
    mocks.rpc.mockResolvedValue({ data: null, error: refusal });

    await expect(UnionService.isUnionAdmin('union-id', 'appointed-admin-id')).rejects.toBe(refusal);
  });

  it('keeps every union Table Management entry surface on the shared authority service', () => {
    expect(read('src/pages/GameManagementPage.tsx')).toContain(
      'unionService.isUnionAdmin(unionId, user.id)'
    );
    const hamburger = read('src/components/navigation/HamburgerMenu.tsx');
    expect(hamburger).toContain('unionService.isUnionAdmin(access.unionId, user.id)');
    expect(hamburger).toContain("reportError(error, 'HamburgerMenu.game_management_authority')");
    expect(hamburger).toContain('setUnionManageId(null)');
    expect(read('src/pages/UnionGamesPage.tsx')).toContain(
      'unionService.isUnionAdmin(targetUnion, user.id)'
    );
    expect(read('src/pages/UnionDetailPage.tsx')).toContain('.isUnionAdmin(union.id, user.id)');
  });

  it('exits Union Games loading with a visible fail-closed authority error', () => {
    const page = read('src/pages/UnionGamesPage.tsx');
    expect(page).toContain("reportError(error, 'UnionGamesPage.management_authority')");
    expect(page).toContain('setCanManageGames(false)');
    expect(page).toContain('setLoading(false)');
    expect(page).toContain('if (authorityError)');
    expect(page).toContain('<div role="alert">{authorityError}</div>');
  });
});
