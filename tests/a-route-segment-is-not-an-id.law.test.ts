/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A ROUTE SEGMENT IS NOT AN ID - LAW (2026-09-12, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A URL path is typed by whoever typed it. A uuid column is typed by Postgres.
 * Between the two there has to be a check, and when there is not, the database
 * does the checking and answers 22P02 - which is an ERROR, a long way from the
 * boundary, wearing the name of whichever component happened to be holding it.
 *
 * WHAT HAPPENED. TournamentStartingTicker matched the path twice:
 *
 *     const clubMatch  = location.pathname.match(/^\/clubs\/([^/]+)/);
 *     const tableMatch = location.pathname.match(/^\/table\/([^/]+)/);
 *
 * and then sent `tableMatch[1]` straight into `.eq('id', ...)` on a uuid
 * column. `/table/demo` and `/table/nonexistent-table-id` - two routes the
 * post-deploy E2E suite visits against PRODUCTION on every single deploy -
 * therefore raised Postgres 22P02 every thirty seconds for as long as the page
 * was open. The catch reported it, HorseBugReporter's console.error hook filed
 * it, and `horse_bug_reports` took 243 unresolved rows between 2026-09-02 and
 * 2026-09-12, all of them one defect, none of them looked at.
 *
 * The club branch was not safer for being routed through a resolver. Its own
 * documented contract is "Fallback: return as-is (will fail downstream, but
 * that's the existing behavior)", so an unknown slug comes back OUT of
 * resolveClubUUID as a slug and lands in the same `.eq('id', ...)`. A resolver
 * is not a guard unless you check what it gave you.
 *
 * THE LAW. A value taken from the URL may not be used as an id filter until
 * something has said it is an id. `isUUID` (src/utils/clubIdResolver.ts) is
 * that something, and the check has to dominate the use - not merely exist
 * somewhere in the file.
 *
 * If a pin below is red, do not widen the pin. Add the guard. The whole cost
 * of the guard is one comparison; the cost of not having it was 243 rows, a
 * misfiled "tournament" incident and ten days of nobody being able to see any
 * other client bug in that table.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', 'src');

/** Columns that are uuid (or an id) in Postgres and cannot take a slug. */
const ID_COLUMNS = ['id', 'table_id', 'club_id', 'union_id', 'tournament_id'];

/** How far back a guard may sit and still be said to dominate the use. */
const GUARD_WINDOW = 600;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
};

const rel = (file: string) => 'src' + file.slice(SRC_ROOT.length).replace(/\\/g, '/');

interface Use {
  file: string;
  line: number;
  column: string;
  arg: string;
  guarded: boolean;
}

/** Every `.eq('<id column>', X)` / `.in('<id column>', X)` in src/. */
function idFilterUses(): Use[] {
  const uses: Use[] = [];
  for (const file of walk(SRC_ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const column of ID_COLUMNS) {
      const re = new RegExp(`\\.(?:eq|in)\\(\\s*'${column}'\\s*,\\s*([^)\\n]+)\\)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const arg = m[1].trim();
        const before = src.slice(Math.max(0, m.index - GUARD_WINDOW), m.index);
        uses.push({
          file: rel(file),
          line: src.slice(0, m.index).split('\n').length,
          column,
          arg,
          // The guard must name the SAME expression, and must sit above the use.
          guarded: before.includes(`isUUID(${arg})`),
        });
      }
    }
  }
  return uses;
}

/**
 * `somethingMatch[1]` - a path match, subscripted, with nothing in between.
 *
 * NO \b BEFORE `Match`. The first draft of this line read /\bMatch\[\d\]/ and
 * matched NOTHING: there is no word boundary between the "e" and the "M" of
 * `tableMatch`, so the rule below stayed green while the guard it guards was
 * deleted. Found by deliberately removing the guard and watching the law pass.
 * A law is not written until you have seen it fail.
 */
const PATH_MATCH_SUBSCRIPT = /\w*Match(?:\?)?\.?\[\d\]|\bmatch\(/;

describe('a route segment is not an id', () => {
  const uses = idFilterUses();

  it('finds id filters to check at all (the scanner still works)', () => {
    // A scanner that silently matches nothing is a law that cannot fail.
    expect(uses.length).toBeGreaterThan(20);
  });

  it('no raw path-match subscript reaches an id filter unguarded', () => {
    const offenders = uses
      .filter((u) => PATH_MATCH_SUBSCRIPT.test(u.arg) && !u.guarded)
      .map((u) => `${u.file}:${u.line}  .eq('${u.column}', ${u.arg})`);
    expect(
      offenders,
      'A URL segment was put straight into an id column. Guard it with ' +
        'isUUID(...) from src/utils/clubIdResolver, immediately above the query, ' +
        'and fall back rather than querying when it fails.'
    ).toEqual([]);
  });

  /**
   * The two branches this law was written from, pinned by name so that
   * deleting the guard is a visible red rather than a quiet 22P02.
   */
  it('the ticker guards BOTH branches, the resolved one included', () => {
    const ticker = readFileSync(
      join(SRC_ROOT, 'components', 'tournament', 'TournamentStartingTicker.tsx'),
      'utf8'
    );
    expect(ticker).toContain(
      "import { isUUID, resolveClubUUID } from '../../utils/clubIdResolver'"
    );
    // The table branch: a segment that cannot be a uuid is not queried at all.
    expect(ticker).toMatch(/if \(isUUID\(tableMatch\[1\]\)\) \{/);
    // The club branch: the RESOLVER'S ANSWER is checked, not merely called.
    // resolveClubUUID returns its input when it cannot resolve one.
    expect(ticker).toMatch(/const resolved = await resolveClubUUID\(clubMatch\[1\]\);/);
    expect(ticker).toMatch(/if \(isUUID\(resolved\)\) \{/);
    // And the shape that shipped the defect is gone: the resolver's answer
    // was assigned straight to the value the query then filtered on.
    expect(ticker).not.toMatch(/clubUuid = await resolveClubUUID\(/);
  });

  it('a scope it cannot resolve is reported, not silently defaulted', () => {
    const ticker = readFileSync(
      join(SRC_ROOT, 'components', 'tournament', 'TournamentStartingTicker.tsx'),
      'utf8'
    );
    // A well-formed uuid with no readable row returns {data: null, error: null}
    // from .maybeSingle(): no row, no error, and until this law no report.
    expect(ticker).toContain('warnOnce');
    expect(ticker).toContain("'TournamentStartingTicker.unscopedTicker'");
    // Once per mount per scope. A report on a 30-second poll is the next flood.
    expect(ticker).toContain('warnedScopesRef');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RATCHET: useParams() straight into an id filter
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same shape, one step less obvious: a route param destructured from
 * useParams() and handed to `.eq('id', param)`. ELEVEN of these existed when
 * this law was written. They are inherited debt, not endorsement - most are on
 * surfaces only reachable with a real id, which is why they have not bitten -
 * and a law that went red on all eleven today would be a law somebody deleted
 * tomorrow (CLAUDE.md 10.83: a check nobody can satisfy is a check nobody
 * keeps).
 *
 * So: frozen where they are, and the ratchet only turns one way.
 *   - a file OVER its baseline fails: guard the new one.
 *   - a file NOT in the baseline with any occurrence fails: new code guards.
 *   - a file UNDER its baseline passes; tighten the number in the same commit.
 */
const USEPARAMS_BASELINE: Record<string, number> = {
  'src/hooks/useFinancialAdminScope.ts': 1,
  'src/pages/AntiCheatPage.tsx': 1,
  'src/pages/TablePage.tsx': 7,
  'src/pages/club/TableBombSettingsPage.tsx': 1,
};

function useParamsIdFilterCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walk(SRC_ROOT)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('useParams')) continue;
    let n = 0;
    for (const column of ID_COLUMNS) {
      const re = new RegExp(`\\.(?:eq|in)\\(\\s*'${column}'\\s*,\\s*([^)\\n]+)\\)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const arg = m[1].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(arg)) continue;
        const destructured = new RegExp(
          `const\\s*\\{[^}]*\\b${arg}\\b[^}]*\\}\\s*=\\s*useParams`,
          's'
        ).test(src);
        const nearParams = new RegExp(`useParams[^;]{0,200}\\b${arg}\\b`, 's').test(src);
        if (!destructured && !nearParams) continue;
        const before = src.slice(Math.max(0, m.index - GUARD_WINDOW), m.index);
        if (before.includes(`isUUID(${arg})`)) continue;
        n++;
      }
    }
    if (n > 0) counts.set(rel(file), n);
  }
  return counts;
}

describe('the useParams ratchet only turns one way', () => {
  const counts = useParamsIdFilterCounts();

  it('no file exceeds its frozen baseline', () => {
    const over: string[] = [];
    for (const [file, n] of counts) {
      const baseline = USEPARAMS_BASELINE[file];
      if (baseline === undefined) {
        over.push(`${file}: ${n} (NEW FILE - guard it with isUUID before the query)`);
      } else if (n > baseline) {
        over.push(`${file}: ${n} > baseline ${baseline}`);
      }
    }
    expect(over, 'A route param reached an id column unguarded.').toEqual([]);
  });

  it('a baseline that has been paid down is tightened here, not left slack', () => {
    const slack: string[] = [];
    for (const [file, baseline] of Object.entries(USEPARAMS_BASELINE)) {
      const n = counts.get(file) ?? 0;
      if (n < baseline) slack.push(`${file}: now ${n}, baseline still ${baseline}`);
    }
    expect(slack, 'Lower the baseline in the same commit that fixed these.').toEqual([]);
  });
});
