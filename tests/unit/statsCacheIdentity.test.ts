import { beforeEach, describe, expect, it } from 'vitest';
import {
  STATS_CACHE_CONTRACT_VERSION,
  clearStatsRangeMemo,
  readStatsPersistentCache,
  readStatsRangeMemo,
  statsCacheIdentityKey,
  statsCacheStorageKey,
  statsPayloadMatchesIdentity,
  writeStatsPersistentCache,
  writeStatsRangeMemo,
  type StatsCacheIdentity,
} from '../../src/lib/statsCache';

const identity = (overrides: Partial<StatsCacheIdentity> = {}): StatsCacheIdentity => ({
  contractVersion: STATS_CACHE_CONTRACT_VERSION,
  viewerId: 'viewer-1',
  targetUserId: 'viewer-1',
  clubId: 'club-1',
  asset: 'chips',
  rangeKey: '30d',
  rangeDays: 30,
  timezone: 'America/Chicago',
  visibility: 'owner',
  ...overrides,
});

const payload = (id = identity()) => ({
  contract_version: id.contractVersion,
  window_tz: id.timezone,
  scope: {
    target_user_id: id.targetUserId,
    club_id: id.clubId,
    asset: id.asset,
    range_days: id.rangeDays,
    visibility: id.visibility,
  },
  quality: {},
  coverage: {},
  overall: { total_hands: 12 },
});

describe('Stats cache identity', () => {
  beforeEach(() => {
    localStorage.clear();
    clearStatsRangeMemo();
  });

  it('keys every security and analytical scope dimension', () => {
    const base = identity();
    for (const changed of [
      identity({ viewerId: 'viewer-2' }),
      identity({ targetUserId: 'target-2' }),
      identity({ clubId: 'club-2' }),
      identity({ asset: 'diamonds' }),
      identity({ rangeKey: '7d', rangeDays: 7 }),
      identity({ timezone: 'UTC' }),
      identity({ visibility: 'shared_club' }),
    ]) {
      expect(statsCacheIdentityKey(changed)).not.toBe(statsCacheIdentityKey(base));
    }
  });

  it('rejects payload version, target, club, range, visibility and timezone drift', () => {
    const id = identity();
    expect(statsPayloadMatchesIdentity(payload(id), id)).toBe(true);
    expect(statsPayloadMatchesIdentity({ ...payload(id), contract_version: 1 }, id)).toBe(false);
    expect(
      statsPayloadMatchesIdentity(
        { ...payload(id), scope: { ...payload(id).scope, target_user_id: 'target-2' } },
        id
      )
    ).toBe(false);
    expect(
      statsPayloadMatchesIdentity(
        { ...payload(id), scope: { ...payload(id).scope, club_id: 'club-2' } },
        id
      )
    ).toBe(false);
    expect(
      statsPayloadMatchesIdentity(
        { ...payload(id), scope: { ...payload(id).scope, range_days: 7 } },
        id
      )
    ).toBe(false);
    expect(
      statsPayloadMatchesIdentity(
        { ...payload(id), scope: { ...payload(id).scope, visibility: 'shared_club' } },
        id
      )
    ).toBe(false);
    expect(statsPayloadMatchesIdentity({ ...payload(id), window_tz: 'UTC' }, id)).toBe(false);
  });

  it('never persists shared-club data', () => {
    const shared = identity({
      viewerId: 'viewer-1',
      targetUserId: 'target-2',
      visibility: 'shared_club',
    });
    expect(writeStatsPersistentCache(shared, payload(shared))).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(readStatsPersistentCache(shared, 60_000)).toBeNull();
  });

  it('reads only an exact owner envelope and discards mismatched memo payloads', () => {
    const id = identity();
    expect(writeStatsPersistentCache(id, payload(id))).toBe(true);
    expect(readStatsPersistentCache(id, 60_000)?.payload).toEqual(payload(id));
    expect(readStatsPersistentCache(identity({ timezone: 'UTC' }), 60_000)).toBeNull();

    const stored = JSON.parse(localStorage.getItem(statsCacheStorageKey(id))!);
    stored.identity.clubId = 'club-2';
    localStorage.setItem(statsCacheStorageKey(id), JSON.stringify(stored));
    expect(readStatsPersistentCache(id, 60_000)).toBeNull();

    expect(writeStatsRangeMemo(id, payload(id))).toBe(true);
    expect(readStatsRangeMemo(id)).toEqual(payload(id));
    expect(writeStatsRangeMemo(id, { ...payload(id), contract_version: 1 })).toBe(false);
  });
});
