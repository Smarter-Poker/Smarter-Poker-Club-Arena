/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ProfileService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - VIP_THRESHOLDS constant integrity
 * - getProfile: returns null for missing user
 * - getProfileByUsername: returns null for missing user
 * - getPublicProfile: returns null for missing user
 * - updateProfile: emits PROFILE_UPDATED on success
 * - hasTOSAccepted: returns false for missing data
 * - acceptTOS: emits PROFILE_UPDATED
 * - getLeaderboard: returns empty array for no data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

// 2026-08-15: single-row reads are now overridable per test so hasTOSAccepted
// can be exercised on a profile row that actually exists (see below). Defaults
// to the previous behaviour, `{ data: null, error: null }`.
const rowState = vi.hoisted(() => ({
  single: { data: null as any, error: null as any },
}));

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve(rowState.single);
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { profileService } from '../../src/services/ProfileService';
import { masterBus } from '../../src/core/MasterBus';

describe('ProfileService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rowState.single = { data: null, error: null };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QUERY METHODS — null/empty returns
  // ─────────────────────────────────────────────────────────────────────────

  describe('getProfile', () => {
    it('should return null when no data', async () => {
      const result = await profileService.getProfile('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getProfileByUsername', () => {
    it('should return null when no data', async () => {
      const result = await profileService.getProfileByUsername('nobody');
      expect(result).toBeNull();
    });
  });

  describe('getPublicProfile', () => {
    it('should return null when no data', async () => {
      const result = await profileService.getPublicProfile('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UPDATE — bus emission
  // ─────────────────────────────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('should emit PROFILE_UPDATED on success (error=null)', async () => {
      const result = await profileService.updateProfile('user-1', { bio: 'test' });
      expect(result).toBe(true);
      expect(masterBus.emit).toHaveBeenCalledWith('PROFILE_UPDATED', {
        userId: 'user-1',
        updates: { bio: 'test' },
      });
    });
  });

  describe('acceptTOS', () => {
    it('should emit PROFILE_UPDATED on success (error=null)', async () => {
      const result = await profileService.acceptTOS('user-1');
      expect(result).toBe(true);
      expect(masterBus.emit).toHaveBeenCalledWith('PROFILE_UPDATED', {
        userId: 'user-1',
        updates: { tosAccepted: true },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // hasTOSAccepted / getLeaderboard
  // ─────────────────────────────────────────────────────────────────────────

  describe('hasTOSAccepted', () => {
    // 2026-08-16: this now FAILS CLOSED, and reads the canonical
    // `profiles.club_arena_tos_accepted_at` column rather than a private
    // `preferences` flag that nothing else in the platform could see.
    //
    // The previous version returned true on a missing row AND on a query
    // error — "default to accepted to avoid blocking" — so an RLS change or a
    // dropped connection silently waved every user past a legal consent gate.
    // A consent check is the one place a convenient default is unavailable.
    it('returns false when there is no acceptance on file', async () => {
      rowState.single = { data: { club_arena_tos_accepted_at: null }, error: null };
      expect(await profileService.hasTOSAccepted('user-1')).toBe(false);
    });

    it('returns false when the profile row is missing entirely', async () => {
      expect(await profileService.hasTOSAccepted('user-1')).toBe(false);
    });

    it('FAILS CLOSED when the query errors — a blip is not consent', async () => {
      rowState.single = { data: null, error: { message: 'boom' } };
      expect(await profileService.hasTOSAccepted('user-1')).toBe(false);
    });

    it('returns true only for a recorded acceptance timestamp', async () => {
      rowState.single = {
        data: { club_arena_tos_accepted_at: '2026-08-16T01:00:00.000Z' },
        error: null,
      };
      expect(await profileService.hasTOSAccepted('user-1')).toBe(true);
    });
  });

  describe('getTOSStatus', () => {
    // The tri-state exists so callers can tell "they have not accepted" from
    // "we could not find out". Collapsing those two is what produced the
    // fail-open bug above.
    it('distinguishes not_accepted from unknown', async () => {
      rowState.single = { data: { club_arena_tos_accepted_at: null }, error: null };
      expect(await profileService.getTOSStatus('user-1')).toBe('not_accepted');

      rowState.single = { data: null, error: { message: 'network' } };
      expect(await profileService.getTOSStatus('user-1')).toBe('unknown');
    });

    it('reports accepted for a stamped profile', async () => {
      rowState.single = {
        data: { club_arena_tos_accepted_at: '2026-08-16T01:00:00.000Z' },
        error: null,
      };
      expect(await profileService.getTOSStatus('user-1')).toBe('accepted');
    });
  });

  describe('getLeaderboard', () => {
    it('should return empty array when no data', async () => {
      const result = await profileService.getLeaderboard('winnings');
      expect(result).toEqual([]);
    });
  });
});
