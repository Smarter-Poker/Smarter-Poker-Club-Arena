/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SEAT READ NAMES ITS PARENT (2026-09-11, must-move audit)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-09 at 17:23:50 and 17:25:29 UTC two migrations added composite
 * foreign keys from `table_seats` to `tables`. That gave the pair THREE
 * relationships, and PostgREST refuses an embedded resource when more than one
 * relationship could satisfy it: PGRST201, HTTP 300, "Could not embed because
 * more than one relationship was found".
 *
 * Every read shaped `.from('table_seats').select('... tables!inner(...)')`
 * started failing at once. `HorseSessionRotator.rotate()` is one of them and
 * its error handler was a bare `return`, so the fleet's entire departure side
 * stopped for THREE AND A HALF HOURS with nothing in the log: session ends,
 * the lone stand, tournament leaves, seat changes, top-ups, breaks, and the
 * human release rule that is the only thing which opens a seat for a person on
 * a waiting list. It was found from the felt - four cluster tables holding one
 * horse for 415, 129, 121 and 54 minutes against a ten-minute rule.
 *
 * The composite keys were later dropped, which is the only reason these reads
 * work today. That is not a fix, it is a reprieve: the next foreign key anybody
 * adds to `table_seats` takes them all down again, silently, everywhere at
 * once.
 *
 * So every seat read names the relationship it means:
 *
 *     tables!table_seats_table_id_fkey!inner(...)
 *
 * The hint costs nothing, it is what #3982 already applied to the lobby, and
 * it is proven equivalent against live PostgREST. A read that names its parent
 * cannot be broken from a distance by a constraint on another branch.
 *
 * This law is repo-wide on purpose. The nine call sites fixed on 2026-09-11
 * were spread over the tournament manager, the seat-claim door, the recurring
 * service, the felt, the blacklist page, the anti-cheat page and the integrity
 * service - seven surfaces in four programmes, none of which knew about the
 * others. A per-file pin would have caught none of them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCAN = ['src', 'server/src'];
const SKIP = new Set(['node_modules', 'dist', 'dist-native', 'coverage', '.git']);

/** Every source file under the scanned roots, tests excluded. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sources(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name) || /\.law\.test\./.test(name)) continue;
    out.push(full);
  }
  return out;
}

const files = SCAN.flatMap((d) => sources(join(ROOT, d)));

describe('LAW: a PostgREST seat read names the foreign key it embeds through', () => {
  it('scans a real population of source files', () => {
    // A scanner that silently finds nothing passes for ever (CLAUDE.md 10.86).
    expect(files.length).toBeGreaterThan(200);
  });

  it('no source file embeds `tables` from a seat read without naming the key', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // Comments and strings that merely DISCUSS the shape are not reads.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
      const re = /tables!(?!table_seats_table_id_fkey)[A-Za-z_]*!?inner\(/g;
      let hit: RegExpExecArray | null;
      while ((hit = re.exec(code))) {
        const line = code.slice(0, hit.index).split('\n').length;
        offenders.push(`${file.slice(ROOT.length + 1)}:${line} -> ${hit[0]}`);
      }
    }
    expect(
      offenders,
      'An embed of `tables` from `table_seats` must name its foreign key, ' +
        '`tables!table_seats_table_id_fkey!inner(...)`. An unqualified embed is ' +
        'refused with PGRST201 the moment a second relationship exists between ' +
        'the two tables, and on 2026-09-09 that took the horse fleet down for ' +
        '3h31m with no log line. Offenders:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });
});
