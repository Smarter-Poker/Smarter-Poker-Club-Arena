/**
 * CLOSING A TABLE CLOSES ITS LIFECYCLE
 *
 * fn_close_managed_game('table', id) closed a cash table with
 * `SET status = 'closed', current_players = 0` and never wrote lifecycle, so
 * every table closed through the managed door stayed lifecycle = 'live': a
 * dead table its game still counted (census, join, seat offers and
 * idx_tables_cluster_open all select lifecycle <> 'closed') and a main table
 * that never released its main_index. Every other closer writes both
 * together. Measured 2026-10-24: 30 such tables, 21 settled by
 * 20261024230029 (the other 9 belong to a retired club, read-only by design).
 *
 * This pins the cause: the latest literal definition of the door writes
 * lifecycle = 'closed' in the same UPDATE that writes status = 'closed', and
 * every tracked closer that sets a cash table's status to 'closed' does the
 * same.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '..', 'supabase', 'migrations');
const FIX = '20261024230029_closing_a_table_closes_its_lifecycle.sql';

const sources = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, source: readFileSync(resolve(MIGRATIONS, file), 'utf8') }));

function latestDefinition(fn: string): { file: string; source: string } {
  const marker = `CREATE OR REPLACE FUNCTION public.${fn}(`;
  let latest: { file: string; source: string } | null = null;
  for (const { file, source } of sources) {
    const start = source.lastIndexOf(marker);
    if (start < 0) continue;
    const tail = source.slice(start);
    const opening = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(tail);
    if (!opening) continue;
    const bodyStart = opening.index + opening[0].length;
    const bodyEnd = tail.indexOf(opening[1], bodyStart);
    if (bodyEnd < 0) continue;
    latest = { file, source: tail.slice(0, bodyEnd + opening[1].length) };
  }
  if (!latest) throw new Error(`No migration defines ${fn}`);
  return latest;
}

/** Each UPDATE public.tables statement's SET clause that closes the status. */
function statusClosingSets(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/UPDATE\s+public\.tables\b[\s\S]*?\bSET\b([\s\S]*?)\bWHERE\b/gi)) {
    if (/\bstatus\s*=\s*'closed'/i.test(m[1])) out.push(m[1]);
  }
  return out;
}

describe('closing a table closes its lifecycle', () => {
  it('the managed close door writes lifecycle with status', () => {
    const door = latestDefinition('fn_close_managed_game');
    expect(door.file).toBe(FIX);
    const sets = statusClosingSets(door.source);
    expect(sets.length).toBe(1);
    expect(sets[0]).toMatch(/\blifecycle\s*=\s*'closed'/i);
  });

  it('the door keeps production lane lock, seat refusal and tournament receipt', () => {
    const door = latestDefinition('fn_close_managed_game').source;
    expect(door).toContain('PERFORM public.fn_ca_lock_settlement_lane_global();');
    expect(door).not.toContain("'ca:tournament-terminal-settlement:v1'");
    expect(door).toContain("'reason', 'players_seated'");
    expect(door).toContain('managed tournament close did not return its exact atomic cancellation receipt');
  });

  it('every other tracked cash closer already writes both', () => {
    for (const fn of ['fn_cash_cluster_tick', 'fn_poker_diamond_close_cash_table']) {
      let def: string;
      try {
        def = latestDefinition(fn).source;
      } catch {
        continue;
      }
      for (const set of statusClosingSets(def)) {
        expect(set, `${fn} closes a table without closing its lifecycle`).toMatch(
          /\blifecycle\s*=\s*'closed'/i
        );
      }
    }
  });

  it('the settlement leaves retired clubs alone and asserts nothing live is left', () => {
    const sql = readFileSync(resolve(MIGRATIONS, FIX), 'utf8');
    expect(sql).toContain("c.lifecycle_status IS DISTINCT FROM 'retired'");
    expect(sql).toContain('AND s.left_at IS NULL');
    expect(sql).toContain('POST-APPLY: a closed table of a switched-off game still reads lifecycle live');
    expect(sql).toMatch(/^-- @live-proof: NOT EXISTS/m);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.table_seats/i);
  });
});
