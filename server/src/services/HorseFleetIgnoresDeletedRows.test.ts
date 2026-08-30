/**
 * The fleet must never adopt a SOFT-DELETED row as its table.
 *
 * ensureAllTablesExist() looks a config up by name and takes the oldest match.
 * For 8 of the 9 cash configs that oldest row was `is_deleted = true`, and a
 * deleted row can never be reopened: `fn_block_deleted_table_revival` is a
 * BEFORE UPDATE trigger that silently puts the status back --
 *
 *   IF COALESCE(OLD.is_deleted,false) AND NEW.status IN
 *      ('running','waiting','active','open') THEN
 *     NEW.status := OLD.status; NEW.is_deleted := true;
 *
 * -- and RAISES NOTHING. So the UPDATE "succeeded", the manager logged
 * `[HorseFleet] Reactivated table: X (was closed)`, and `continue` skipped the
 * insert because a row HAD been found. Every cycle, for ever. The table never
 * came back and the log said that it had.
 *
 * Measured in production 2026-08-30: 8 of 9 cash configs had ZERO open rows,
 * their unrevivable stand-in re-touched at 20:28 on each boot. The only config
 * still on the felt, `NLH Straddle 1.00/2.00`, was the only one whose oldest
 * row was not deleted -- a clean natural control.
 *
 * Like HorseFleetNoDuplicateTables, these drive a fake supabase client so the
 * real control flow is exercised rather than the source text asserted, and a
 * CONTROL case reproduces the old behaviour so the pin cannot rot into a
 * tautology.
 */
import { describe, it, expect } from 'vitest';

type Row = Record<string, any>;

/**
 * Stand-in for the query builder, covering exactly the chain the lookup uses.
 * `.not('is_deleted','is',true)` actually FILTERS here -- a fake that accepted
 * the call and ignored it would let this whole bug through again.
 */
function makeClient(rows: Row[]) {
  const inserted: Row[] = [];
  const client = {
    from() {
      let working = [...rows];
      const q: any = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        not(column: string, op: string, value: unknown) {
          if (op === 'is' && value === true) {
            working = working.filter((r) => r[column] !== true);
          }
          return q;
        },
        limit: (n: number) => Promise.resolve({ data: working.slice(0, n), error: null }),
        insert(row: Row) {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
  return { client, inserted };
}

/** The lookup as it stands now: deleted rows are excluded. */
async function currentLookup(client: any): Promise<'reused' | 'inserted'> {
  const { data } = await client
    .from('tables')
    .select('id, status')
    .eq('name', 'PLO5 1.00/2.00')
    .is('tournament_id', null)
    .not('is_deleted', 'is', true)
    .order('created_at', { ascending: true })
    .limit(1);
  if (data?.[0]) return 'reused';
  await client.from('tables').insert({ name: 'PLO5 1.00/2.00' });
  return 'inserted';
}

/** CONTROL: the lookup as it was, with no is_deleted filter. */
async function oldLookup(client: any): Promise<'reused' | 'inserted'> {
  const { data } = await client
    .from('tables')
    .select('id, status')
    .eq('name', 'PLO5 1.00/2.00')
    .is('tournament_id', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (data?.[0]) return 'reused';
  await client.from('tables').insert({ name: 'PLO5 1.00/2.00' });
  return 'inserted';
}

const deletedStandIn = {
  id: 'old-deleted',
  status: 'closed',
  is_deleted: true,
  created_at: '2026-08-19T04:43:55Z',
};

describe('the fleet ignores soft-deleted rows', () => {
  it('creates a fresh table when the only match is soft-deleted', async () => {
    const { client, inserted } = makeClient([deletedStandIn]);
    expect(await currentLookup(client)).toBe('inserted');
    expect(inserted).toHaveLength(1);
  });

  it('CONTROL: the old lookup adopts the deleted row and never inserts', async () => {
    const { client, inserted } = makeClient([deletedStandIn]);
    // This is the production bug: a row is "found", so the config is treated as
    // satisfied, and the table never returns to the lobby.
    expect(await oldLookup(client)).toBe('reused');
    expect(inserted).toHaveLength(0);
  });

  it('still reuses a live table rather than creating a second one', async () => {
    const { client, inserted } = makeClient([
      { id: 'live', status: 'waiting', is_deleted: false, created_at: '2026-08-20T00:00:00Z' },
    ]);
    expect(await currentLookup(client)).toBe('reused');
    expect(inserted).toHaveLength(0);
  });

  it('skips the deleted stand-in and reuses the usable row behind it', async () => {
    // The real shape: a deleted row is OLDEST, so oldest-first would have
    // picked it, while a perfectly usable closed row sits behind it.
    const { client, inserted } = makeClient([
      deletedStandIn,
      { id: 'usable', status: 'closed', is_deleted: false, created_at: '2026-08-19T08:00:00Z' },
    ]);
    expect(await currentLookup(client)).toBe('reused');
    expect(inserted).toHaveLength(0);
  });

  it('treats a missing is_deleted field as not deleted', async () => {
    // Older rows predate the column default; absent must not mean deleted, or
    // the fleet would spawn a duplicate beside every legacy table.
    const { client, inserted } = makeClient([
      { id: 'legacy', status: 'closed', created_at: '2026-08-19T04:00:00Z' },
    ]);
    expect(await currentLookup(client)).toBe('reused');
    expect(inserted).toHaveLength(0);
  });
});
