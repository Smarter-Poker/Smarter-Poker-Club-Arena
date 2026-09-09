/**
 * THE PER-HAND RECOUNT MUST NOT WRITE A NUMBER THE ROW ALREADY HOLDS
 * ═══════════════════════════════════════════════════════════════════════════
 * `updateTableStatus` is the authoritative seat recount at the end of EVERY
 * hand (settlement step 15). It wrote unconditionally.
 *
 * `tables` is the widest published table on the platform - 154 columns - and
 * `realtime.apply_rls` costs roughly one dynamic cast plus one column-privilege
 * check per column, so a `tables` change is the single most expensive thing
 * Supabase Realtime decodes.
 *
 * Measured 2026-09-06 against live WAL with a temporary replication slot:
 *   - 28.4 ms of database time per `tables` change;
 *   - 221 changes per 15 seconds -> 6,277 ms, 27% of ALL realtime decoding;
 *   - the poller was spending 22.9 s of database time per 15 s of WAL, so it
 *     could never catch up, and a slot that is behind reads WAL from disk
 *     rather than memory and falls further behind.
 *
 * And it almost never had news. Measured the same day across all 472 open
 * tables: `current_players` already equalled the live seat count on 468 of
 * them, and 93.4% of recounts would have written nothing at all.
 *
 * THE DANGEROUS DIRECTION IS NOT "WRITES TOO OFTEN". It is a filter that fails
 * to match when a value HAS changed, which would drop a real recount and leave
 * the lobby showing a seat count that is not there. Every pin below aims at
 * that, and mirrors TimeBankWritesOnlyWhatChanged.test.ts, which guards the
 * same shape on `table_seats`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tableCountChangedFilter } from './tables.js';

/**
 * Resolved from THIS FILE, never from process.cwd(): the suite is run from the
 * repo root by `vitest run` and from `server/` by the pre-push hook's
 * `--root server`, and a cwd-relative path silently becomes
 * `server/server/src/...` under the second one.
 */
const readSrc = (p: string): string => readFileSync(join(__dirname, p), 'utf8');

describe('tableCountChangedFilter', () => {
  it('matches when the seat count differs', () => {
    expect(tableCountChangedFilter({ current_players: 6 })).toContain('current_players.neq.6');
  });

  it('matches when the status differs', () => {
    expect(tableCountChangedFilter({ status: 'running' })).toContain('status.neq."running"');
  });

  it('matches when EITHER column differs, never demanding both', () => {
    const f = tableCountChangedFilter({ current_players: 6, status: 'running' });
    // PostgREST `or=` is a disjunction: one differing column is enough.
    expect(f).toContain('current_players.neq.6');
    expect(f).toContain('status.neq."running"');
    expect(f.split(',').length).toBe(4);
  });

  it('carries an is.null arm for every column it filters on', () => {
    // PostgREST `neq` is SQL three-valued logic: a NULL column does NOT
    // satisfy `neq`, so without this arm a row whose count is NULL would be
    // filtered out and a genuinely needed write would be silently skipped.
    const f = tableCountChangedFilter({ current_players: 0, status: 'waiting' });
    expect(f).toContain('current_players.is.null');
    expect(f).toContain('status.is.null');
  });

  it('treats zero as a real value, not as absence', () => {
    // An empty table is current_players = 0. An `if (x)` test would drop the
    // guard for exactly the tables whose count is about to become non-zero.
    const f = tableCountChangedFilter({ current_players: 0 });
    expect(f).toContain('current_players.neq.0');
    expect(f).toContain('current_players.is.null');
  });

  it('never filters on a column it is not writing', () => {
    // Filtering on a column absent from the payload would compare the row
    // against a value nobody is setting, and could match nothing.
    expect(tableCountChangedFilter({ current_players: 4 })).not.toContain('status');
    expect(tableCountChangedFilter({ status: 'waiting' })).not.toContain('current_players');
  });

  it('applies no filter at all for an empty write', () => {
    expect(tableCountChangedFilter({})).toBe('');
  });

  it('quotes the status value so a reserved character cannot change the filter', () => {
    // An unquoted PostgREST filter value containing a comma or a dot would be
    // read as extra clauses rather than failing loudly.
    expect(tableCountChangedFilter({ status: 'waiting' })).toContain('status.neq."waiting"');
  });
});

describe('the recount call sites carry the guard', () => {
  it('updateTableStatus filters on both columns it writes', () => {
    const src = readSrc('tables.ts');
    expect(src).toContain('tableCountChangedFilter({ current_players: playerCount, status })');
  });

  it('processLeavePending cannot overwrite the atomic cashout count with an unlocked recount', () => {
    const src = readSrc('seats.ts');
    const pending = src.slice(src.indexOf('export async function processLeavePending('));
    expect(pending).toContain('await atomicCashout(');
    expect(pending).not.toMatch(/\.from\('tables'\)|current_players:\s*count/);
  });
});
