import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { supabase } from '../services/supabase.js';
import { readCompletingBoard } from './completingBoard.js';
import { selectCompletingDue } from './completingDwell.js';

afterEach(() => vi.restoreAllMocks());

function board(count: number, fault?: 'error' | 'null' | 'throw' | 'stop') {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-9000-${index.toString(16).padStart(12, '0')}`,
    name: 'Completing event',
    status: 'COMPLETING',
  }));
  let active = true;
  const cursors: (string | null)[] = [];
  vi.spyOn(supabase, 'from').mockImplementation((() => {
    let cursor: string | null = null;
    let limit = 1000;
    const filters = new Map<string, unknown>();
    const chain: any = {
      select: () => chain,
      eq: (key: string, value: unknown) => {
        filters.set(key, value);
        return chain;
      },
      order: (key: string, options: unknown) => {
        expect(key).toBe('id');
        expect(options).toEqual({ ascending: true });
        return chain;
      },
      limit: (want: number) => {
        limit = want;
        return chain;
      },
      gt: (key: string, value: string) => {
        expect(key).toBe('id');
        cursor = value;
        return chain;
      },
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            cursors.push(cursor);
            expect(filters.get('status')).toBe('COMPLETING');
            if (cursor && fault === 'throw') throw new Error('page disconnected');
            if (cursor && fault === 'error')
              return { data: null, error: { message: 'page failed' } };
            if (cursor && fault === 'null') return { data: null, error: null };
            if (cursor && fault === 'stop') active = false;
            return {
              data: rows
                .filter(
                  (row) =>
                    (!cursor || row.id > cursor) &&
                    (!filters.has('id') || row.id === filters.get('id'))
                )
                .slice(0, Math.min(limit, 1000)),
              error: null,
            };
          })
          .then(resolve, reject),
    };
    return chain;
  }) as never);
  return { rows, cursors, active: () => active };
}

describe('a complete COMPLETING board owns the dwell update', () => {
  it.each([0, 1000, 1001, 9001])(
    'retains all %i events across the API row ceiling',
    async (count) => {
      const fixture = board(count);
      const result = await readCompletingBoard('id, name, status');
      expect(result).toEqual(fixture.rows);
      expect(fixture.cursors.length).toBe(Math.floor(count / 1000) + 1);
      const dwell = selectCompletingDue(
        result!.map((row) => String(row.id)),
        new Map(),
        100
      );
      expect(dwell.seenAt.size).toBe(count);
    }
  );

  it.each(['error', 'null', 'throw', 'stop'] as const)(
    'cannot forget clocks after later-page %s',
    async (fault) => {
      const fixture = board(1001, fault);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const previous = new Map([[fixture.rows[1000].id, 5]]);
      const result = await readCompletingBoard('id, name, status', {
        shouldContinue: fixture.active,
      });
      expect(result).toBeNull();
      const retained = result
        ? selectCompletingDue(
            result.map((row) => String(row.id)),
            previous,
            100
          ).seenAt
        : previous;
      expect(retained.get(fixture.rows[1000].id)).toBe(5);
      expect(fixture.cursors).toHaveLength(2);
    }
  );

  it('restricts explicit recovery to its requested event', async () => {
    const fixture = board(1001);
    expect(
      await readCompletingBoard('id, name, status', { tournamentId: fixture.rows[1000].id })
    ).toEqual([fixture.rows[1000]]);
  });

  it('the discovery consumer preserves dwell clocks on an incomplete board', () => {
    const source = readFileSync('src/GameServer.ts', 'utf8');
    const scan = source.slice(
      source.indexOf('// ── STUCK COMPLETING RECOVERY'),
      source.indexOf('A SPIN THAT IS OVER MUST END')
    );
    expect(scan).toContain('await readCompletingBoard<');
    expect(scan).toContain('shouldContinue: () => this.directAdmissionIsCurrent(generation)');
    expect(scan).toMatch(
      /if \(!stuckTournaments\) \{[\s\S]*?reportError\([\s\S]*?\} else \{\s*const dwell = selectCompletingDue/
    );
  });
});
