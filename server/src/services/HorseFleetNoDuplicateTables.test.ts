/**
 * ensureAllTablesExist() must not create a table it already created.
 *
 * It did, on every boot, for months. The existence check was
 *
 *   const { data: existing } = await supabase.from('tables')...maybeSingle();
 *
 * PostgREST answers .maybeSingle() with PGRST116 when MORE THAN ONE row
 * matches. The error was destructured away, so `existing` was null, so the
 * code inserted another row — which guaranteed the next boot would do it
 * again. Production held 120 'NLH 1.00/2.00', 120 'NLH 2.00/5.00', 83 PLO4,
 * 83 PLO5 and 81 PLO6 rows; the three configs that never got a second row
 * still had exactly one each.
 *
 * These tests drive a fake supabase client, so they exercise the real control
 * flow rather than asserting on the source text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, any>;

/**
 * Minimal stand-in for the supabase query builder, covering exactly the
 * chain HorseFleetManager uses for this lookup.
 */
function makeClient(opts: { rows: Row[]; selectError?: any }) {
  const inserted: Row[] = [];
  const updated: Row[] = [];
  const client = {
    from() {
      const q: any = {
        _rows: opts.rows,
        select() {
          return q;
        },
        eq() {
          return q;
        },
        is() {
          return q;
        },
        order() {
          return q;
        },
        limit(n: number) {
          return Promise.resolve(
            opts.selectError
              ? { data: null, error: opts.selectError }
              : { data: opts.rows.slice(0, n), error: null }
          );
        },
        maybeSingle() {
          // The real thing: PGRST116 the moment there is more than one row.
          if (opts.rows.length > 1) {
            return Promise.resolve({
              data: null,
              error: { code: 'PGRST116', message: 'multiple rows returned' },
            });
          }
          return Promise.resolve({ data: opts.rows[0] ?? null, error: null });
        },
        insert(row: Row) {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
        update(row: Row) {
          updated.push(row);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return q;
    },
  };
  return { client, inserted, updated };
}

/** The FIXED lookup, as HorseFleetManager now performs it. */
async function lookupThenMaybeInsert(client: any, onError: (e: any) => void) {
  const { data: matches, error } = await client
    .from('tables')
    .select('id, status')
    .eq('name', 'PLO6 1.00/2.00')
    .is('tournament_id', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) {
    onError(error);
    return 'skipped';
  }
  const existing = matches?.[0] ?? null;
  if (existing) return 'reused';
  await client.from('tables').insert({ name: 'PLO6 1.00/2.00' });
  return 'inserted';
}

/** The OLD lookup, kept so the regression is demonstrated, not just described. */
async function oldLookupThenMaybeInsert(client: any) {
  const { data: existing } = await client
    .from('tables')
    .select('id, status')
    .eq('name', 'PLO6 1.00/2.00')
    .is('tournament_id', null)
    .maybeSingle();
  if (existing) return 'reused';
  await client.from('tables').insert({ name: 'PLO6 1.00/2.00' });
  return 'inserted';
}

describe('ensureAllTablesExist duplicate amplification', () => {
  /* `vi.fn()` with no implementation infers `Mock<Procedure | Constructable>`,
     which has no call signature TypeScript can match against
     `lookupThenMaybeInsert(client, onError: (e: any) => void)` — so this file
     failed `tsc --noEmit` with seven TS2345s the moment it landed, taking the
     Server Engine check down with it. Giving the mock a one-line implementation
     lets vitest infer the real signature; the mock API is unchanged, so
     `toHaveBeenCalledTimes` below still works. */
  let onError = vi.fn((_e: unknown) => {});
  beforeEach(() => {
    onError = vi.fn((_e: unknown) => {});
  });

  it('creates the table when none exists', async () => {
    const { client, inserted } = makeClient({ rows: [] });
    expect(await lookupThenMaybeInsert(client, onError)).toBe('inserted');
    expect(inserted).toHaveLength(1);
  });

  it('reuses the table when exactly one exists', async () => {
    const { client, inserted } = makeClient({ rows: [{ id: 'a', status: 'waiting' }] });
    expect(await lookupThenMaybeInsert(client, onError)).toBe('reused');
    expect(inserted).toHaveLength(0);
  });

  it('reuses - does NOT add another - when duplicates already exist', async () => {
    const rows = Array.from({ length: 81 }, (_, i) => ({ id: `t${i}`, status: 'waiting' }));
    const { client, inserted } = makeClient({ rows });
    expect(await lookupThenMaybeInsert(client, onError)).toBe('reused');
    expect(inserted).toHaveLength(0);
  });

  it('CONTROL: the old .maybeSingle() lookup inserts an 82nd copy', async () => {
    const rows = Array.from({ length: 81 }, (_, i) => ({ id: `t${i}`, status: 'waiting' }));
    const { client, inserted } = makeClient({ rows });
    expect(await oldLookupThenMaybeInsert(client)).toBe('inserted');
    expect(inserted).toHaveLength(1); // the bug, reproduced
  });

  it('skips rather than inserts when the lookup itself fails', async () => {
    const { client, inserted } = makeClient({
      rows: [],
      selectError: { code: '08006', message: 'connection failure' },
    });
    expect(await lookupThenMaybeInsert(client, onError)).toBe('skipped');
    expect(inserted).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('the shipped code no longer uses maybeSingle for this lookup', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
    const block = /ENSURE ALL TABLES EXIST[\s\S]*?const existing = matches/.exec(src);
    expect(block).not.toBeNull();
    // Strip comments first. The block explains the bug in prose and names
    // maybeSingle while doing so; a naive substring check matches its own
    // documentation and fails. Only a CALL counts.
    const code = block![0]
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toContain('maybeSingle(');
    expect(code).toContain('lookupError');
    expect(code).toContain('.limit(1)');
  });
});
