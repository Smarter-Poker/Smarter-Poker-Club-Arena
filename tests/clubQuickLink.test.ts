/**
 * Club quick link resolution — the single rule behind the lobby Cashier and
 * Marketplace tiles, keyboard shortcuts 4/5, and the in-cashier switcher.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  eligibleQuickLinkClubs,
  resolveTargetClub,
  readLastClubId,
  rememberLastClub,
  clubParamToUuid,
} from '../src/utils/clubQuickLink';
import { STORAGE_KEYS } from '../src/lib/storage';

const A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alpha', club_id: 11111 };
const B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Bravo', club_id: 22222 };
const U = {
  id: 'cccccccc-0000-0000-0000-000000000003',
  name: 'Union',
  club_id: 55555,
  entity_type: 'union' as const,
};

beforeEach(() => {
  localStorage.clear();
});

describe('eligibleQuickLinkClubs', () => {
  it('excludes unions', () => {
    expect(eligibleQuickLinkClubs([A, U, B])).toEqual([A, B]);
  });

  it('returns empty for empty input', () => {
    expect(eligibleQuickLinkClubs([])).toEqual([]);
  });
});

describe('resolveTargetClub', () => {
  it('prefers the last-visited club when still a member', () => {
    expect(resolveTargetClub([A, B], B.id)).toEqual(B);
  });

  it('falls back to the first club when last-visited is gone', () => {
    expect(resolveTargetClub([A, B], 'dddddddd-0000-0000-0000-000000000009')).toEqual(A);
  });

  it('never resolves to a union, even as last-visited', () => {
    expect(resolveTargetClub([U, A], U.id)).toEqual(A);
  });

  it('returns null when the user has no eligible clubs', () => {
    expect(resolveTargetClub([], null)).toBeNull();
    expect(resolveTargetClub([U], U.id)).toBeNull();
  });

  it('reads stored LAST_CLUB when no override is given', () => {
    localStorage.setItem(STORAGE_KEYS.LAST_CLUB, B.id);
    expect(resolveTargetClub([A, B])).toEqual(B);
  });
});

describe('rememberLastClub / readLastClubId', () => {
  it('round-trips a UUID', () => {
    rememberLastClub(A.id);
    expect(readLastClubId()).toBe(A.id);
  });

  it('refuses non-UUID values', () => {
    rememberLastClub('11111');
    expect(readLastClubId()).toBeNull();
  });
});

describe('clubParamToUuid', () => {
  it('passes a UUID through', () => {
    expect(clubParamToUuid(A.id)).toBe(A.id);
  });

  it('resolves a numeric club code via the cached club list', () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    expect(clubParamToUuid('22222')).toBe(B.id);
  });

  it('drops numeric codes it cannot resolve', () => {
    expect(clubParamToUuid('99999')).toBeNull();
  });

  it('handles undefined and corrupt cache', () => {
    expect(clubParamToUuid(undefined)).toBeNull();
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, '{not json');
    expect(clubParamToUuid('22222')).toBeNull();
  });
});
