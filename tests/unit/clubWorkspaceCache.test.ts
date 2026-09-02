import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLUB_WORKSPACE_CACHE_TTL_MS,
  readClubWorkspaceCache,
  removeClubWorkspaceCache,
  writeClubWorkspaceCache,
} from '../../src/lib/clubWorkspaceCache';

const entry = {
  userId: 'owner-1',
  routeClubId: 'shark-club',
  clubUUID: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  clubRole: 'owner',
  membershipStatus: 'active',
  isPlatformStaff: false,
  verifiedAt: 1_000_000,
};

describe('club workspace access cache', () => {
  beforeEach(() => localStorage.clear());

  it('returns only the matching user and route inside the verification window', () => {
    writeClubWorkspaceCache(entry);

    expect(readClubWorkspaceCache('owner-1', 'shark-club', entry.verifiedAt + 1)).toEqual(entry);
    expect(readClubWorkspaceCache('someone-else', 'shark-club', entry.verifiedAt + 1)).toBeNull();
    expect(readClubWorkspaceCache('owner-1', 'another-club', entry.verifiedAt + 1)).toBeNull();
  });

  it('expires access and removes a confirmed stale membership', () => {
    writeClubWorkspaceCache(entry);

    expect(
      readClubWorkspaceCache(
        'owner-1',
        'shark-club',
        entry.verifiedAt + CLUB_WORKSPACE_CACHE_TTL_MS + 1
      )
    ).toBeNull();

    removeClubWorkspaceCache('owner-1', 'shark-club');
    expect(readClubWorkspaceCache('owner-1', 'shark-club', entry.verifiedAt + 1)).toBeNull();
  });
});
