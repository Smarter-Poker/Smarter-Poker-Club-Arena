/**
 * QUICK JOIN RUN TOKEN AND LOBBY REMOUNT (2026-10-05)
 *
 * Three leftovers from the 2026-10-04 review of the "+" sheet:
 *
 *   1. A lobby page a Browse Full Lobby request landed on a tournament list
 *      now stays on its current page when reopened, per the owner's
 *      October 30 instruction. Explicit list navigation still remounts it.
 *   2. A "+" press whose reads finished after the sheet was dismissed, or
 *      after a newer press, still painted rows or took a lobby exit. Every
 *      press now carries a run number checked after each await.
 *   3. The spin read was the one read in the sheet without a timeout.
 *
 * Source pins are bounded by structures, never by a character count.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from '../helpers/sourceWindow';

const MULTI = readFileSync(resolve(__dirname, '../../src/pages/MultiTablePage.tsx'), 'utf8');

describe('a landed lobby page stays open on a plain lobby request', () => {
  const reuse = sliceBetween(
    MULTI,
    "useMasterBusSubscription('OPEN_LOBBY_TAB', () => {",
    'if (prev.length >= MAX_TABLES) {'
  );
  const open = sliceBetween(
    MULTI,
    'const openLobbyTabOn = useCallback(',
    'const consumeLobbyLanding = useCallback('
  );
  const consume = sliceBetween(
    MULTI,
    'const consumeLobbyLanding = useCallback(',
    'const handleAddTable = useCallback('
  );

  it('a landing marks the tab, and consuming the landing keeps the mark', () => {
    expect(open).toContain('lobbyLandedList: true');
    expect(consume).not.toContain('lobbyLandedList');
  });

  it('the reuse branch focuses the page without remounting or resetting it', () => {
    expect(reuse).toContain('setActiveIndex(existingLobby)');
    expect(reuse).not.toContain('setTables(');
    expect(reuse).not.toContain('++lobbyLandingNonceRef.current');
  });
});

describe('a stale "+" press writes nothing', () => {
  const handler = sliceBetween(
    MULTI,
    'const handleAddTable = useCallback(',
    'const handleQuickJoinPick'
  );
  const close = sliceBetween(MULTI, 'const closeQuickJoin = useCallback(', '}, []);');

  it('every press takes a run number and every close retires it', () => {
    expect(handler).toContain('const run = ++quickJoinRunRef.current;');
    expect(close).toContain('quickJoinRunRef.current += 1;');
  });

  it('every await in the handler is followed by the stale check', () => {
    const lines = handler.split('\n');
    const awaitEnds: number[] = [];
    lines.forEach((line, i) => {
      if (/\bawait\b/.test(line) && !/import\(/.test(line)) awaitEnds.push(i);
    });
    expect(awaitEnds.length).toBeGreaterThan(4);
    const checks = (handler.match(/if \(stale\(\)\) return;/g) || []).length;
    expect(checks).toBeGreaterThanOrEqual(6);
  });

  it('the failure catch checks before taking a lobby exit', () => {
    const tail = handler.slice(handler.lastIndexOf('} catch {'));
    expect(tail.indexOf('if (stale()) return;')).toBeGreaterThan(-1);
    expect(tail.indexOf('if (stale()) return;')).toBeLessThan(
      tail.indexOf("masterBus.emit('OPEN_LOBBY_TAB', {});")
    );
  });

  it('the spin read is timed', () => {
    expect(handler).toContain(
      'withTimeout(quickJoinSpinRows(scopeClubIds, activeTableId, openIds)).catch(() => null)'
    );
  });
});

const spinQueries = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: spinQueries.from } }));

function installSpinQueryFixture() {
  const boards = [
    {
      id: 'next-spin',
      club_id: 'club-a',
      variant: null,
      tournament_type: 'SPIN',
      status: 'REGISTERING',
      name: 'Next Spin',
      buy_in_amount: 100,
      max_players: 3,
    },
  ];
  const tables = [
    {
      id: 'next-table',
      tournament_id: 'next-spin',
      status: 'waiting',
      current_players: 1,
      max_players: 3,
    },
  ];
  const filters: Array<[string, string, unknown]> = [];
  const query = (kind: string) => {
    const local: Array<[string, string, unknown]> = [];
    const q: any = {
      select: () => q,
      eq: (key: string, value: unknown) => {
        local.push(['eq', key, value]);
        filters.push(['eq', key, value]);
        return q;
      },
      neq: (key: string, value: unknown) => {
        local.push(['neq', key, value]);
        return q;
      },
      in: (key: string, value: unknown) => {
        local.push(['in', key, value]);
        filters.push(['in', key, value]);
        return q;
      },
      or: (value: string) => {
        local.push(['or', '', value]);
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({
        data:
          kind === 'tables'
            ? { id: 'active-table', tournament_id: 'active-spin' }
            : {
                id: 'active-spin',
                club_id: 'club-a',
                variant: null,
                tournament_type: 'SPIN',
                buy_in_amount: 100,
              },
        error: null,
      }),
      then: (resolve: (value: unknown) => void) =>
        resolve({
          data: (kind === 'tournaments' ? boards : tables).filter((row: any) =>
            local.every(([op, key, value]) => {
              if (op === 'or')
                return String(value)
                  .split(',')
                  .some((term) => {
                    const [field, operator, expected] = term.split('.');
                    return operator === 'eq' && row[field] === expected;
                  });
              if (op === 'eq') return row[key] === value;
              if (op === 'neq') return row[key] !== value;
              return (value as unknown[]).includes(row[key]);
            })
          ),
          error: null,
        }),
    };
    return q;
  };
  spinQueries.from.mockImplementation(query);
  return filters;
}

describe('spin quick join preserves format and club scope', () => {
  it('offers a board identified by tournament_type when variant is absent', async () => {
    installSpinQueryFixture();
    const { quickJoinSpinRows } = await import('../../src/lib/quickJoinSpins');
    const rows = await quickJoinSpinRows(['club-a'], 'active-table', new Set());
    expect(rows?.map((row) => row.id)).toEqual(['next-table']);
  });
  it('never asks for unscoped candidate boards while the club context is loading', async () => {
    const filters = installSpinQueryFixture();
    const { quickJoinSpinRows } = await import('../../src/lib/quickJoinSpins');
    const rows = await quickJoinSpinRows([], 'active-table', new Set());
    expect(rows).toBeNull();
    expect(filters.some(([op, key]) => op === 'in' && key === 'status')).toBe(false);
  });
});
