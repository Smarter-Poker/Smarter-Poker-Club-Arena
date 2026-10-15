import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FREE_BUY_AUDIT_SOURCE,
  closeFreeBuyBoardAlert,
  freeBuyAuditClearedResolution,
  type FreeBuyAlertStore,
} from './freeBuyAuditAlert.js';

/** Records the exact query the helper builds and answers with `result`. */
function fakeStore(result: { data: Array<{ id: string }> | null; error: { message: string } | null }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const store: FreeBuyAlertStore = {
    from(table: 'financial_alerts') {
      calls.push(['from', table]);
      return {
        update(values: Record<string, unknown>) {
          calls.push(['update', values]);
          return {
            eq(c1: string, v1: unknown) {
              calls.push(['eq', c1, v1]);
              return {
                eq(c2: string, v2: unknown) {
                  calls.push(['eq', c2, v2]);
                  return {
                    select(cols: string) {
                      calls.push(['select', cols]);
                      return Promise.resolve(result);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { store, calls };
}

describe('the Free Buy watch closes its own alert', () => {
  it('a clean audit resolves every open row of its own source, and only those', async () => {
    const { store, calls } = fakeStore({ data: [{ id: 'f2c43ab2' }], error: null });
    const now = Date.parse('2026-10-15T10:00:00.000Z');
    const closed = await closeFreeBuyBoardAlert(store, 4, now);
    expect(closed).toBe(1);
    expect(calls[0]).toEqual(['from', 'financial_alerts']);
    expect(calls[1]).toEqual([
      'update',
      {
        resolved: true,
        resolved_at: '2026-10-15T10:00:00.000Z',
        resolution: freeBuyAuditClearedResolution(4, '2026-10-15T10:00:00.000Z'),
      },
    ]);
    expect(calls[2]).toEqual(['eq', 'source', FREE_BUY_AUDIT_SOURCE]);
    expect(calls[3]).toEqual(['eq', 'resolved', false]);
    expect(calls[4]).toEqual(['select', 'id']);
  });

  it('nothing open is nothing closed', async () => {
    const { store } = fakeStore({ data: [], error: null });
    expect(await closeFreeBuyBoardAlert(store, 4, Date.now())).toBe(0);
  });

  it('a database error is thrown, never read as closed', async () => {
    const { store } = fakeStore({ data: null, error: { message: 'timeout' } });
    await expect(closeFreeBuyBoardAlert(store, 4, Date.now())).rejects.toThrow(
      'free_buy_audit_close_failed: timeout'
    );
  });

  it('the source is the one the watch raises', () => {
    expect(FREE_BUY_AUDIT_SOURCE).toBe('TournamentRecurring.freeBuyAudit');
  });

  it('the watch calls the close on every clean audit, not only after a raise in the same process', () => {
    // 2026-10-13: f2c43ab2 stayed open after the board was right again because a
    // clean read only logged, and only when this process had raised it.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'TournamentRecurringService.ts'), 'utf8');
    const start = src.indexOf('private async auditFreeBuyBoardOnce');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('// TOURNAMENT CHECK', start));
    const clean = body.slice(body.indexOf('if (problems.length === 0)'));
    const cleanBranch = clean.slice(0, clean.indexOf('return;'));
    expect(cleanBranch).toContain('closeFreeBuyBoardAlert(supabase');
    expect(cleanBranch.indexOf('closeFreeBuyBoardAlert')).toBeLessThan(
      cleanBranch.indexOf('if (this.lastFreeBuyAuditProblems > 0)')
    );
  });
});
