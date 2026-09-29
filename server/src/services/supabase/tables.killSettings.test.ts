/**
 * KILL POTS (kill-v1): THE ENGINE LOADS ITS TABLES WHETHER OR NOT THE DATABASE
 * HAS THE KILL COLUMNS YET.
 *
 * tables.kill_mode and tables.kill_threshold_bb arrive with migration
 * 20260924034010, which is a separate release from this engine. Named inside
 * loadTable's row read, a missing column would fail every table load (42703);
 * so they are read beside it, and only an undefined-column answer is taken
 * to mean "kill is off". Every other failure stays a failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  reads: [] as Array<{ table: string; columns: string; filters: Array<[string, unknown]> }>,
  row: { data: null as unknown, error: null as unknown },
  kill: { data: null as unknown, error: null as unknown },
}));

vi.mock('./client.js', () => ({
  supabase: {
    from(table: string) {
      const read = { table, columns: '', filters: [] as Array<[string, unknown]> };
      io.reads.push(read);
      const query = {
        select(columns: string) {
          read.columns = columns;
          return query;
        },
        eq(column: string, value: unknown) {
          read.filters.push([column, value]);
          return query;
        },
        async maybeSingle() {
          return read.columns === 'kill_mode, kill_threshold_bb' ? io.kill : io.row;
        },
      };
      return query;
    },
  },
}));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));

import {
  isUndefinedColumnError,
  loadKillSettings,
  loadTable,
  resetKillColumnsAbsentReportForTests,
} from './tables.js';

const chipRow = {
  id: 'table-a',
  club_id: 'club',
  union_id: null,
  arena: { id: 'club', asset: 'chips', is_platform: false, union_id: null },
  game_variant: 'flh',
  small_blind: 1,
  big_blind: 2,
  tournament_id: null,
  game_type: 'cash',
};
const UNDEFINED_COLUMN = {
  code: '42703',
  message: 'column tables.kill_mode does not exist',
  details: null,
  hint: null,
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  io.reads = [];
  io.row = { data: chipRow, error: null };
  io.kill = { data: { kill_mode: 'half', kill_threshold_bb: 12 }, error: null };
  resetKillColumnsAbsentReportForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('loadKillSettings', () => {
  it('returns the stored kill configuration of exactly that table', async () => {
    await expect(loadKillSettings('table-a')).resolves.toEqual({
      kill_mode: 'half',
      kill_threshold_bb: 12,
    });
    expect(io.reads).toEqual([
      { table: 'tables', columns: 'kill_mode, kill_threshold_bb', filters: [['id', 'table-a']] },
    ]);
  });

  it('reads a database without the columns as kill off, and says so once per process', async () => {
    io.kill = { data: null, error: UNDEFINED_COLUMN };
    await expect(loadKillSettings('table-a')).resolves.toEqual({
      kill_mode: 'off',
      kill_threshold_bb: null,
    });
    io.kill = {
      data: null,
      error: { code: 'PGRST204', message: "Could not find the 'kill_mode' column" },
    };
    await expect(loadKillSettings('table-b')).resolves.toEqual({
      kill_mode: 'off',
      kill_threshold_bb: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('20260924034010');
  });

  it('never reads any other failure as kill off', async () => {
    for (const error of [
      { code: '57014', message: 'canceling statement due to statement timeout' },
      { code: '42501', message: 'permission denied for table tables' },
      { message: 'fetch failed' },
      // A message that merely MENTIONS a missing column is not the code.
      { code: 'PGRST116', message: 'column kill_mode does not exist' },
    ]) {
      io.kill = { data: null, error };
      await expect(loadKillSettings('table-a')).rejects.toThrow('Failed to load kill settings');
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers null for a table that does not exist, and leaves the choice to the caller', async () => {
    io.kill = { data: null, error: null };
    await expect(loadKillSettings('gone')).resolves.toBeNull();
  });

  it('recognises exactly the two undefined-column codes', () => {
    expect(isUndefinedColumnError({ code: '42703' })).toBe(true);
    expect(isUndefinedColumnError({ code: 'PGRST204' })).toBe(true);
    for (const e of [null, undefined, {}, { code: '42P01' }, { code: 42703 }, 'x']) {
      expect(isUndefinedColumnError(e)).toBe(false);
    }
  });
});

describe('loadTable', () => {
  it('reads the row without the kill columns and merges them from their own read', async () => {
    const table = await loadTable('table-a');
    expect(table).toMatchObject({ id: 'table-a', kill_mode: 'half', kill_threshold_bb: 12 });
    const rowRead = io.reads.find((r) => r.columns !== 'kill_mode, kill_threshold_bb');
    expect(rowRead?.columns.split(/,\s*/)).not.toContain('kill_mode');
    expect(rowRead?.columns.split(/,\s*/)).not.toContain('kill_threshold_bb');
    expect(io.reads.map((r) => r.table)).toEqual(['tables', 'tables']);
  });

  it('loads every table on a database that does not have the kill columns yet', async () => {
    io.kill = { data: null, error: UNDEFINED_COLUMN };
    await expect(loadTable('table-a')).resolves.toMatchObject({
      id: 'table-a',
      game_variant: 'flh',
      kill_mode: 'off',
    });
  });

  it('fails the load when the kill read fails for any other reason', async () => {
    io.kill = { data: null, error: { code: '57014', message: 'statement timeout' } };
    await expect(loadTable('table-a')).rejects.toThrow('Failed to load kill settings');
  });

  it('reports the row read failure as before, with no unhandled kill read behind it', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      io.row = { data: null, error: { message: 'row read failed' } };
      io.kill = { data: null, error: { code: '57014', message: 'statement timeout' } };
      await expect(loadTable('table-a')).rejects.toThrow(
        'Failed to load table table-a: row read failed'
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
