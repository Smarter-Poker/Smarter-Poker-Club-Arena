/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — WaitlistService (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      // 2026-08-15: this suite-local mock omitted `auth`, so the module-private
      // currentUserId() helper (WaitlistService.ts:86-90) blew up with
      // "Cannot read properties of undefined (reading 'getUser')" before the
      // service could run any query. Returning a real signed-in user keeps the
      // authenticated path under test instead of short-circuiting on null.
      auth: {
        getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null })),
        getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      },
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { waitlistService } from '../../src/services/WaitlistService';

describe('WaitlistService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getTableWaitlist', () => {
    it('should return empty array when no entries', async () => {
      const result = await waitlistService.getTableWaitlist('table-1');
      expect(result).toEqual([]);
    });

    it('should accept any tableId', async () => {
      const result = await waitlistService.getTableWaitlist('nonexistent');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getPosition', () => {
    it('should return null when not on waitlist', async () => {
      // 2026-08-15: getPosition takes ONLY tableId (WaitlistService.ts:193) —
      // the user is derived from the session, never passed in. Dropped the
      // stale second 'user-1' argument. With a signed-in user and no active
      // row, the maybeSingle() lookup yields null and the method returns null.
      const pos = await waitlistService.getPosition('table-1');
      expect(pos).toBeNull();
    });
  });

  // 2026-08-15: the old `getUserWaitlistEntry` describe called a method that
  // does not exist on the service. The single-entry read for the signed-in user
  // IS getPosition (it returns entryId/status/position); the player's own list
  // is myWaitlists(). Retargeted at the real method rather than dropped.
  describe('myWaitlists', () => {
    it('should return empty array when the signed-in user has no active rows', async () => {
      const result = await waitlistService.myWaitlists();
      expect(result).toEqual([]);
    });
  });

  describe('getUserWaitlists', () => {
    it('should return empty array when user has no waitlists', async () => {
      const result = await waitlistService.getUserWaitlists('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('export shape', () => {
    it('should export waitlistService singleton with all methods', () => {
      // 2026-08-15: pinned to the surface the module actually exports
      // (WaitlistService.ts:92-371). The join/leave pair is joinWaitlist /
      // leaveWaitlist, with leave() as the boolean wrapper WaitlistPage uses.
      expect(typeof waitlistService.joinWaitlist).toBe('function');
      expect(typeof waitlistService.leaveWaitlist).toBe('function');
      expect(typeof waitlistService.leave).toBe('function');
      expect(typeof waitlistService.getPosition).toBe('function');
      expect(typeof waitlistService.myWaitlists).toBe('function');
      expect(typeof waitlistService.getUserWaitlists).toBe('function');
      expect(typeof waitlistService.getTableWaitlist).toBe('function');
    });

    it('should NOT expose engine-owned seat-offer transitions', () => {
      // 2026-08-15: the old test demanded notifyNextPlayer / markSeated on the
      // client service. Claiming the oldest 'waiting' row, flipping it to
      // 'notified' and inserting the waitlist_seat_open notification is the
      // ENGINE's job (server/src/services/supabase/seats.ts:243
      // notifyWaitlistSeatOpen), as the service header documents. Asserting
      // their absence keeps that authority boundary from drifting back.
      const surface = waitlistService as unknown as Record<string, unknown>;
      expect(surface.notifyNextPlayer).toBeUndefined();
      expect(surface.markSeated).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ONE TABLE, NOT TWO
// ═══════════════════════════════════════════════════════════════════════════
//
// `table_waitlist` (singular) and `table_waitlists` (plural) both existed and
// the readers were split between them: the clients wrote one, and the ENGINE's
// seat-offer path watched the other. Nothing was ever offered a seat, and both
// tables sat at zero rows all-time because the loop could not close.
//
// The duplicate was dropped on 2026-08-21. This scans source rather than
// mocking a client, because the failure mode is a plausible-looking string in
// a `.from(...)` call that no unit test would otherwise execute.
describe('waitlist table name', () => {
  const ROOTS = ['src', 'server/src'];

  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  }

  it('never queries the retired plural table', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf8');
        // Only real query targets, not prose in a comment explaining the history.
        const re = /\.from\(\s*['"`]table_waitlists['"`]/g;
        if (re.test(src)) offenders.push(file);
      }
    }
    expect(
      offenders,
      `these query public.table_waitlists, which was dropped: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('the engine seat-offer path uses the canonical table', () => {
    /* The rule is unchanged: if the offer path ever points at a different
       table, joining a queue silently stops leading to a seat offer — which is
       the exact bug this replaced (the engine read `table_waitlists` while
       every client wrote `table_waitlist`, so no offer could ever fire).

       WHERE it is enforced moved on 2026-08-30. The whole sequence became
       `fn_offer_open_seat` — one transaction, so the queue-head claim stops
       racing a concurrent opener and losing the seat in silence — and the
       engine no longer names any table at all. So the assertion follows it
       into the migration rather than being deleted. */
    const ts = readFileSync('server/src/services/supabase/seats.ts', 'utf8');
    expect(ts).toContain("rpc('fn_offer_open_seat'");

    const dir = 'supabase/migrations';
    const file = readdirSync(dir).find((f) => f.includes('offer_open_seat'));
    expect(file, 'the offer migration is missing').toBeTruthy();
    const sql = readFileSync(`${dir}/${file}`, 'utf8');
    expect(sql).toMatch(/FROM public\.table_waitlist w/);
    expect(sql).not.toMatch(/table_waitlists\b/);
  });
});
