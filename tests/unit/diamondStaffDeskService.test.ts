/**
 * THE DIAMOND STAFF DESK SERVICE SENDS EACH DOOR ITS OWN KEYS
 *
 * src/services/DiamondStaffDeskService.ts calls the fn_poker_diamond_* staff
 * doors and fn_ca_diamond_staff_books. PostgREST resolves an RPC by its name
 * AND its argument names, so a renamed `p_` key is a 404 the moment staff
 * press a button. This reads each door's latest definition in the migration
 * corpus (no database) and pins that every call sends exactly the door's
 * parameters, and that a refusal reaches staff in words, never as a raw name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrationCorpus } from '../helpers/migrationCorpus';

const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  next: null as null | { data: unknown; error: unknown },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpc.calls.push({ fn, args });
      return rpc.next ?? { data: { ok: true }, error: null };
    }),
  },
}));

import {
  cancelDiamondEvent,
  closeDiamondTable,
  editDiamondTable,
  openDiamondTable,
  readAdjustmentQueue,
  readDiamondBooks,
  readHealthReading,
  refusalWords,
  removeDiamondEntry,
  setDiamondBombPot,
  setDiamondRunItTwice,
  setDiamondStraddle,
} from '../../src/services/DiamondStaffDeskService';

/** The parameter names of a function's latest CREATE in the corpus. */
function params(fn: string): string[] {
  const head = new RegExp(
    `CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(([^)]*(?:\\([^)]*\\)[^)]*)*)\\)`,
    'g'
  );
  let list: string | null = null;
  for (const { sql } of migrationCorpus()) for (const m of sql.matchAll(head)) list = m[1];
  if (list === null) throw new Error(`${fn} is not defined in the corpus`);
  return list
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0])
    .filter(Boolean);
}

const stakes = {
  name: 'T',
  smallBlind: 1,
  bigBlind: 2,
  minBuyIn: 40,
  maxBuyIn: 200,
  maxPlayers: 6,
};

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.next = null;
});

describe('the Diamond staff desk service', () => {
  it('sends every door exactly its own parameters', async () => {
    await openDiamondTable(stakes, 'nlh');
    await editDiamondTable('t', stakes);
    await closeDiamondTable('t');
    await setDiamondStraddle('t', true, false);
    await setDiamondRunItTwice('t', true);
    await setDiamondBombPot('t', true, 2, 1);
    await cancelDiamondEvent('e');
    await removeDiamondEntry('e', 'u');
    await readAdjustmentQueue();
    await readHealthReading();
    await readDiamondBooks();
    expect(rpc.calls.map((c) => c.fn)).toEqual([
      'fn_poker_diamond_open_cash_table',
      'fn_poker_diamond_edit_cash_table',
      'fn_poker_diamond_close_cash_table',
      'fn_poker_diamond_set_table_straddle',
      'fn_poker_diamond_set_table_run_it_twice',
      'fn_poker_diamond_set_table_bomb_pot',
      'fn_poker_diamond_cancel_tournament',
      'fn_poker_diamond_remove_tournament_player',
      'fn_ca_diamond_staff_books',
      'fn_ca_diamond_staff_books',
      'fn_ca_diamond_staff_books',
    ]);
    for (const { fn, args } of rpc.calls) {
      expect(Object.keys(args).sort(), fn).toEqual(params(fn).sort());
      expect(Object.values(args).includes(undefined), fn).toBe(false);
    }
    expect(rpc.calls.slice(-3).map((c) => c.args.p_view)).toEqual([
      'adjustments',
      'health',
      'books',
    ]);
  });

  it('puts every refusal into words staff read', async () => {
    expect(refusalWords('diamond_table_must_be_empty_to_edit')).toBe(
      'Diamond Table Must Be Empty To Edit'
    );
    expect(refusalWords('Tournament is already cancelled')).toBe('Tournament Is Already Cancelled');
    expect(refusalWords('diamond_correction_source_not_authorized')).toMatch(
      /^Not Settled: What Pays For A Diamond Correction Has Not Been Authorized Yet/
    );
    expect(refusalWords('')).toBe('The Server Refused That');

    rpc.next = { data: null, error: { message: 'diamond_table_seat_holds_custody' } };
    await expect(closeDiamondTable('t')).rejects.toThrow('Diamond Table Seat Holds Custody');
    rpc.next = { data: { ok: false, reason: 'tournament_started' }, error: null };
    await expect(removeDiamondEntry('e', 'u')).rejects.toThrow('Tournament Started');
    rpc.next = { data: { ok: false, refused_reason: 'platform_staff_only' }, error: null };
    await expect(readDiamondBooks()).rejects.toThrow('Only Platform Staff Can Do That');
  });
});
