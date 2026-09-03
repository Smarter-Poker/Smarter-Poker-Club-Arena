/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FOUR TABLES MUST NOT MEAN FOUR OF EVERYTHING (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MultiTablePage keeps up to four TablePages mounted at once and never
 * unmounts itself, so anything a table does per-instance is silently
 * multiplied by four. Two fixes already landed on that theme (#1601's settings
 * read, #1623's button skin); these are the ones that were left.
 *
 *   - the user's THEME rows were read once per table — one query per mount,
 *     keyed on user_id alone, byte-identical across all four;
 *   - the SCREEN WAKE LOCK, a per-document resource, was requested once per
 *     table with its own visibilitychange listener, against the rule
 *     useTableEnvironment's own header states;
 *   - the turn-clock rAF loop and its 500ms watchdog ran for the life of every
 *     mounted table, including three tables where nobody was on the clock;
 *   - the hero hand-strength memo claimed to run "when the board changes" but
 *     depended on the players ARRAY (fresh identity every snapshot) and on its
 *     own output, so a combinatorial evaluator (150 scorings at PLO6) ran on
 *     every snapshot, on every table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

describe('the theme read is de-duplicated across simultaneous mounts', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('collapses a burst of identical reads into one in-flight promise', async () => {
    let calls = 0;
    vi.doMock('../../src/lib/supabase', () => ({
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => {
              calls += 1;
              // A PostgREST builder is a THENABLE, not a Promise — model that.
              return {
                then: (resolveFn: (v: unknown) => unknown) =>
                  Promise.resolve({ data: [], error: null }).then(resolveFn),
              };
            },
          }),
        }),
      },
    }));

    const mod = await import('../../src/hooks/useUserThemeSettings');
    const results = await Promise.all([
      mod.fetchUserThemeRows('user-1'),
      mod.fetchUserThemeRows('user-1'),
      mod.fetchUserThemeRows('user-1'),
      mod.fetchUserThemeRows('user-1'),
    ]);

    expect(calls).toBe(1);
    expect(results).toHaveLength(4);
    // The entry is dropped once it settles: nothing is retained, so a table
    // opened later still reads the database and a write is never served stale.
    expect(mod.__inFlightThemeReadCount()).toBe(0);
  });

  it('drops the entry on rejection so one blip cannot wedge every future mount', async () => {
    vi.doMock('../../src/lib/supabase', () => ({
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              then: (_r: unknown, reject: (e: unknown) => unknown) =>
                Promise.reject(new Error('network')).then(undefined, reject),
            }),
          }),
        }),
      },
    }));

    const mod = await import('../../src/hooks/useUserThemeSettings');
    await expect(mod.fetchUserThemeRows('user-1')).rejects.toThrow('network');
    expect(mod.__inFlightThemeReadCount()).toBe(0);
  });
});

describe('the wake lock is one per document, not one per table', () => {
  const src = read('hooks/useTableEnvironment.ts');

  it('is refcounted like the viewport tag beside it', () => {
    expect(src).toContain('let wakeLockHolders = 0');
    expect(src).toMatch(/if \(wakeLockHolders === 1\)/);
    // Last table out releases; closing one of four must not dim the screen.
    expect(src).toMatch(/if \(wakeLockHolders > 0\) return;/);
  });

  it('attaches ONE visibilitychange listener and collapses concurrent requests', () => {
    expect(src).toContain('let wakeLockRequestInFlight');
    expect(
      (src.match(/addEventListener\('visibilitychange', onWakeLockVisibilityChange\)/g) ?? [])
        .length
    ).toBe(1);
  });

  it('does not leak a sentinel that arrives after the last table closed', () => {
    expect(src).toMatch(/if \(wakeLockHolders === 0\) \{[\s\S]*?sentinel\.release\(\)/);
  });
});

describe('the hero hand-strength memo is keyed on the cards, not on array identity', () => {
  const src = read('pages/TablePage.tsx');

  it('no longer depends on the players array or on its own output', () => {
    const at = src.indexOf('const heroHandStrengthLive = useMemo');
    expect(at).toBeGreaterThan(-1);
    const deps = src.slice(src.indexOf('}, [', at), src.indexOf(');', src.indexOf('}, [', at)));
    expect(deps).toContain('heroHoleKey');
    expect(deps).toContain('heroBoardKey');
    expect(deps).not.toContain('tableState.players');
    expect(deps).not.toContain('cachedHandStrength');
  });

  it('holds the last strength after the hand OUTSIDE the memo', () => {
    expect(src).toContain(
      'const heroHandStrength = tableState.isHandInProgress ? heroHandStrengthLive : cachedHandStrength;'
    );
  });
});
