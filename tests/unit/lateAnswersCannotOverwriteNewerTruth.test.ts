/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A LATE ANSWER MUST NOT OVERWRITE A NEWER TRUTH (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three races on the table surface, all the same shape — something awaited
 * lands after the world moved on and writes anyway:
 *
 *  1. loadTableInfo's tail stopped checking `isMounted`. Its bootstrap is a
 *     5-attempt 1s/2s/4s/8s backoff ladder plus four more sequential round
 *     trips, so the tail can land 15+ seconds late and rebuild the seat map
 *     from a clean slate — wiping players seated in the interim and resetting
 *     heroSeat (the ref the duplicate-seat guard reads).
 *  2. `accountBalance` had six writers, three optimistic-relative and three
 *     awaited-absolute, with no fence: an absolute read issued BEFORE a
 *     buy-in debit could resolve after it and restore the pre-debit figure.
 *  3. usePlayerStats kept a per-instance map behind ONE global storage key,
 *     flushed on a per-instance 30s timer — with four tables mounted the last
 *     flush clobbered the other three tables' opponent counters.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

describe('loadTableInfo guards its late writes', () => {
  const src = read('pages/TablePage.tsx');

  it('re-checks isMounted before the wallet read, the seat rebuild and the tail', () => {
    const start = src.indexOf('const balanceRevision = readBalanceRevision();');
    expect(start).toBeGreaterThan(-1);
    const cleanup = src.indexOf('isMounted = false;', start);
    expect(cleanup).toBeGreaterThan(start);
    const tail = src.slice(start, cleanup);
    // At least three guards between the first late await and the cleanup:
    // the balance read, the cashout-restriction read, the seat rebuild.
    const guards = tail.match(/if \(!isMounted\) return;/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the balance write fence', () => {
  const src = read('pages/TablePage.tsx');

  it('exposes a revision fence with an optimistic and an absolute path', () => {
    expect(src).toContain('const balanceRevisionRef = useRef(0)');
    expect(src).toContain('const applyBalanceDelta');
    expect(src).toContain('const setBalanceIfCurrent');
    expect(src).toMatch(/if \(revisionAtIssue !== balanceRevisionRef\.current\) return;/);
  });

  it('routes every RELATIVE write through the fence-bumping helper', () => {
    // A raw relative setAccountBalance would not bump the revision, so a
    // stale absolute read could still undo it.
    expect(src).not.toMatch(/setAccountBalance\(\(prev\)/);
    expect((src.match(/applyBalanceDelta\(\(prev\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('captures the revision BEFORE each awaited read, not after', () => {
    expect(src).toContain('const balanceRevision = readBalanceRevision();');
    expect(src).toContain('const resyncRevision = readBalanceRevision();');
    expect(src).toContain('setBalanceIfCurrent(resyncRevision, rb.balance)');
  });
});

describe('the dead waitlist RPC is gone', () => {
  it('no client path CALLS promote_next_waitlisted_player (no such function exists)', () => {
    // The removal note names the RPC deliberately, so match the CALL rather
    // than the name: a future revival would reintroduce supabase.rpc(...).
    const src = read('services/TableService.ts');
    expect(src).not.toMatch(/rpc\(\s*'promote_next_waitlisted_player'/);
    expect(src).not.toMatch(/'promote_next_waitlisted_player',/);
  });

  it('and does not claim a player was seated when the engine only offers a seat', () => {
    expect(read('services/TableService.ts')).not.toContain('You Have Been Seated!');
  });
});

describe('opponent stats are one map, not four that clobber each other', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('two hook instances share one map', async () => {
    const { renderHook, act } = await import('@testing-library/react');
    const mod = await import('../../src/hooks/usePlayerStats');
    mod.__resetPlayerStatsForTests();

    const a = renderHook(() => mod.usePlayerStats());
    const b = renderHook(() => mod.usePlayerStats());

    act(() => {
      a.result.current.recordHandPlayed('villain-1');
      a.result.current.recordVPIP('villain-1');
      b.result.current.recordHandPlayed('villain-1');
    });

    // One shared map: the second table's hand is added to the first's, not
    // written into a private copy that later clobbers it.
    expect(a.result.current.getStats('villain-1')?.handsPlayed).toBe(2);
    expect(b.result.current.getStats('villain-1')?.handsPlayed).toBe(2);
    expect(b.result.current.getStats('villain-1')?.vpipCount).toBe(1);
  });

  it('the map is a module singleton read through useSyncExternalStore', () => {
    const src = read('hooks/usePlayerStats.ts');
    expect(src).toContain('useSyncExternalStore');
    expect(src).toContain('let statsMap: PlayerStatsMap');
    // One refcounted flush timer for the document, not one per table.
    expect(src).toContain('let holders = 0');
    expect(src).toMatch(/if \(holders === 1\)/);
  });
});
