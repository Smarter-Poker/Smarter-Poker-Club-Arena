/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A POSITION STAT HAS A LIVE WRITER (2026-09-12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 405 `[PositionStats]` bug reports, 2026-03-17 to 2026-03-23, every one of
 * them the same sentence:
 *
 *     Could not find the function public.bulk_update_position_stats(payload)
 *     in the schema cache
 *
 * The RPC was never created in production. `supabase/migrations/
 * 20260312002_bulk_update_position_stats.sql` declares it, but that file
 * SHARES ITS VERSION with `20260312002_tournament_flights.sql`, and Supabase
 * keys `schema_migrations` on the version - so of two files holding one
 * version the second is silently never applied (CLAUDE.md 4.5). Nothing in
 * the repo noticed for six months: the Phase-H signoff still ticks the RPC as
 * shipped, and the April triage in `20260429e_x12_create_increment_union_
 * wallet.sql` chose to DEFER building it on the stated ground that "position_
 * stats table doesn't exist" - a check against the wrong name. The table is
 * `player_position_stats`, it exists, and it feeds the stats page.
 *
 * What actually saved the feature was a different path: the trigger
 * `hand_history_position_stats` on `hand_history` calls
 * `fn_process_hand_position_stats(players, actions, winners)`. Measured on
 * production 2026-09-12: 87 hands inserted in 52s produced 329 seat-hands of
 * position stats. So the caller of the phantom RPC was deleted rather than
 * repaired, and the bulk RPC is retired, not pending.
 *
 * That leaves two ways to lose position stats again, and this law pins both:
 *
 *   1. THE WRITER DISAPPEARS. The trigger function and the backfill function
 *      are the whole write path. If a migration retires either one - or
 *      tombstones it in a schema-manifest fragment - stats stop dead and
 *      nothing says so, because `trg_hand_history_position_stats` catches
 *      every exception and only RAISEs a WARNING.
 *   2. THE PHANTOM COMES BACK. A new caller of `bulk_update_position_stats`
 *      reproduces March exactly. `check-phantom-tables.mjs` would also catch
 *      it, but only while the live schema answers; this catches it offline
 *      and says why the name is forbidden rather than merely absent.
 *
 * The stranded migration keeps its RETIRED banner so the next reader does not
 * take it for a shipped object a third time.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MANIFEST = join(ROOT, 'scripts/ci/supabase-schema-manifest.json');
const FRAGMENTS = join(ROOT, 'scripts/ci/schema-manifest.d');
const RETIRED_RPC = 'bulk_update_position_stats';
const STRANDED_MIGRATION = 'supabase/migrations/20260312002_bulk_update_position_stats.sql';

/** Base snapshot UNION every declaration fragment, MINUS every tombstone -
 *  the same arithmetic scripts/ci/schema-manifest.mjs does for the CI gates.
 *  A tombstone must subtract here too: retiring the writer is exactly the
 *  regression this law exists to catch. */
function manifest(): { tables: Set<string>; functions: Set<string> } {
  const base = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const tables = new Set<string>(base.tables || []);
  const functions = new Set<string>(base.functions || []);
  if (existsSync(FRAGMENTS)) {
    for (const f of readdirSync(FRAGMENTS)) {
      if (!f.endsWith('.json')) continue;
      const frag = JSON.parse(readFileSync(join(FRAGMENTS, f), 'utf8'));
      for (const t of frag.tables || []) tables.add(t);
      for (const fn of frag.functions || []) functions.add(fn);
      for (const fn of frag.removedFunctions || []) functions.delete(fn);
      for (const t of frag.removedTables || []) tables.delete(t);
    }
  }
  return { tables, functions };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

describe('a position stat has a live writer', () => {
  it('keeps the table the stats page reads', () => {
    expect(
      manifest().tables.has('player_position_stats'),
      'player_position_stats is gone from the schema manifest. It is the table the ' +
        'stats page reads and the only thing the position-stats trigger writes.'
    ).toBe(true);
  });

  it.each(['fn_process_hand_position_stats', 'fn_backfill_position_stats'])(
    'keeps %s, without which position stats stop silently',
    (fn) => {
      expect(
        manifest().functions.has(fn),
        `${fn} is not in the schema manifest (or a fragment tombstones it).\n\n` +
          'fn_process_hand_position_stats IS the position-stats write path: the\n' +
          'hand_history_position_stats trigger calls it for every hand, and the\n' +
          'trigger swallows every exception with RAISE WARNING - so if this\n' +
          'function goes away, the stats page quietly freezes and no error is\n' +
          'ever reported. fn_backfill_position_stats is the only way to repair\n' +
          'a gap afterwards. Retiring either one needs a replacement writer\n' +
          'named in this law, not a green build.'
      ).toBe(true);
    }
  );

  it(`never lets ${RETIRED_RPC} come back as a caller`, () => {
    const callers: string[] = [];
    const rpc = new RegExp(`\\.rpc\\s*\\(\\s*['"\`]${RETIRED_RPC}['"\`]`);
    for (const dir of ['src', 'server/src']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const src = readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (rpc.test(line)) callers.push(`${file.replace(ROOT + '/', '')}:${i + 1}`);
        });
      }
    }
    expect(
      callers,
      `${RETIRED_RPC} is RETIRED and does not exist in production - calling it\n` +
        'is the 405-report failure of March 2026 verbatim (PGRST202, no rows, no\n' +
        'throw). Position stats are written by the hand_history_position_stats\n' +
        'trigger now. If you need a bulk path, build one and name it here.\n\n' +
        'Callers found:\n' +
        callers.join('\n')
    ).toEqual([]);
  });

  it('does not carry the retired RPC in the live schema manifest', () => {
    expect(
      manifest().functions.has(RETIRED_RPC),
      `${RETIRED_RPC} appears in the schema manifest. It has never existed in ` +
        'production; if that changed, this law and the RETIRED banner on the ' +
        'stranded migration both have to be rewritten deliberately.'
    ).toBe(false);
  });

  it('keeps the stranded migration marked RETIRED so it is not read as shipped', () => {
    const mig = readFileSync(join(ROOT, STRANDED_MIGRATION), 'utf8');
    expect(mig).toContain('RETIRED - NEVER APPLIED');
    expect(
      mig,
      'the banner must keep naming the version collision, which is the mechanism'
    ).toContain('20260312002_tournament_flights.sql');
  });

  it('keeps the stranded migration inert, so it cannot be applied by accident', () => {
    const live = readFileSync(join(ROOT, STRANDED_MIGRATION), 'utf8')
      .split('\n')
      .map((l, i) => [l, i + 1] as const)
      .filter(([l]) => l.trim() !== '' && !l.trimStart().startsWith('--'));
    expect(
      live.map(([l, n]) => `${n}: ${l.trim()}`),
      'The retired migration has executable SQL in it again. It declares a\n' +
        'SECURITY DEFINER writer that never consults auth.uid()/auth.role() and\n' +
        'never revokes EXECUTE from PUBLIC, anon or authenticated - applying it\n' +
        'would hand a browser an unguarded writer over player_position_stats, and\n' +
        'would add a second unsynchronised writer to counters the\n' +
        'hand_history_position_stats trigger already owns. Keep it commented.'
    ).toEqual([]);
  });
});
