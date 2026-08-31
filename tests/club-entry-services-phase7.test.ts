import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  emit: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../src/services/ClubEntryTrustService', () => ({
  ClubEntryTrustService: { track: mocks.track },
}));

import { ClubJoinService } from '../src/services/ClubJoinService';
import { PlayerSearchService } from '../src/services/PlayerSearchService';

describe('Phase 7 Club Entry service interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('normalizes every supported Join entry shape', () => {
    expect(ClubJoinService.parseInput(' 25450 ')).toEqual({
      identifier: '25450',
      referralCode: null,
    });
    expect(ClubJoinService.parseInput('/invite/river-room?ref=ACE42')).toEqual({
      identifier: 'river-room',
      referralCode: 'ACE42',
    });
    expect(ClubJoinService.isValidIdentifier('river-room')).toBe(true);
    expect(ClubJoinService.isValidIdentifier('25450')).toBe(true);
    expect(ClubJoinService.parseInput('/invite/not%2Fa%2Fclub')).toBeNull();
    expect(ClubJoinService.parseInput('/?c=77777&ref=VIP9')).toEqual({
      identifier: '77777',
      referralCode: 'VIP9',
    });
    expect(ClubJoinService.parseInput('not a club')).toBeNull();
  });

  it('passes one stable Join request to the RPC, clears recovery, and emits once', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'active',
        club: { id: 'club-uuid', club_id: 25450, name: 'River Room' },
      },
      error: null,
    });
    const result = await ClubJoinService.join({
      identifier: '25450',
      referralCode: 'ACE42',
      requestId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result.success).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_join_club_atomic', {
      p_identifier: '25450',
      p_request_id: '11111111-1111-4111-8111-111111111111',
      p_referral_code: 'ACE42',
    });
    expect(window.localStorage.getItem('club-arena:pending-join:v1')).toBeNull();
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it('keeps the original Join request available after an ambiguous failure', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Network unavailable' } });
    await expect(
      ClubJoinService.join({
        identifier: '77777',
        requestId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toThrow('Network unavailable');
    expect(window.localStorage.getItem('club-arena:pending-join:v1')).toContain(
      '22222222-2222-4222-8222-222222222222'
    );
  });

  it('maps the authoritative Find response and forwards all filters', async () => {
    const response = Promise.resolve({
      data: {
        items: [{ id: 'player-1', username: 'river', tables: [] }],
        total: 21,
        has_more: true,
        offset: 20,
        limit: 20,
      },
      error: null,
    });
    mocks.rpc.mockReturnValueOnce(response);
    const result = await PlayerSearchService.search({
      query: ' river ',
      offset: 20,
      scope: 'clubs',
      presence: 'playing',
      sort: 'name',
    });

    expect(mocks.rpc).toHaveBeenCalledWith('fn_search_players', {
      p_query: 'river',
      p_limit: 20,
      p_offset: 20,
      p_scope: 'clubs',
      p_presence: 'playing',
      p_sort: 'name',
    });
    expect(result).toMatchObject({ total: 21, hasMore: true, offset: 20, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});
