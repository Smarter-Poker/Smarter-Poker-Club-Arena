import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A HORSE IS NEVER NAMED (Dan, 2026-09-14, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY."
 *
 * CLAUDE.md 10.5 made horses players in every respect but left one thing on
 * the client: `is_horse` could still be surfaced "as DATA (a badge, a
 * column, a roster field)". This ruling closes that. From today, no surface
 * in the web client - player-facing or operator-facing - may show, label,
 * filter by, export, or otherwise let a person infer which players are
 * horses. Removed on 2026-09-14: the "Hide Horses" toggle and its
 * "(Horses Hidden)" / "People Only" relabelling on the club dashboard and
 * the club data page, the "H" / "Horse" badges on both leaderboards, the
 * "(Horse)" role suffix in the cashier trade roster and the blacklist
 * member picker, and the `is_horse` CSV columns on every export those pages
 * offered. See docs/changelog/2026-09-14-a-horse-is-never-named.md.
 *
 * WHAT THIS DOES NOT REACH, ON PURPOSE
 *
 * `is_horse` / `isHorse` stay legitimate as plumbing:
 *   - a type member (`is_horse: boolean;`) describing what an RPC returns,
 *     never painted;
 *   - a plain (non-JSX) object-literal mapping, e.g. `isHorse: !!p.is_horse,`
 *     building a row that nothing downstream renders or filters on;
 *   - a Supabase `.select(...)` / `.eq(...)` / `.rpc(...)` / `.from(...)`
 *     call reading or writing the column server-side;
 *   - a comment.
 * This law does not walk the type graph to prove a kept field truly never
 * reaches a screen - that judgement call is made once, by a person, at the
 * point of removal (see the changelog). What it CAN check by grep, on every
 * commit, forever, is the shape a reveal actually takes: a literal phrase a
 * player or operator would read, or the flag driving a JSX condition or
 * attribute or sitting in a CSV header row. Every reveal found on
 * 2026-09-14 took one of exactly those shapes.
 *
 * WHAT IS BANNED, PRECISELY
 *
 *   1. The literal phrases 'Hide Horses', 'Horses Hidden', 'People Only',
 *      'title="Horse"', '(Horse)' - copy a person would read.
 *   2. The identifier `hideHorses` anywhere - it never had a legitimate use
 *      other than the retired toggle, so its reappearance IS the regression.
 *   3. `is_horse` or `isHorse` quoted as a bare array element (a CSV header
 *      cell), e.g. `'is_horse',` - never `is_horse: value` (a key) or a
 *      multi-field select string.
 *   4. `is_horse` or `isHorse` reached via a dot (`.is_horse`, `.isHorse`)
 *      inside a same-line `{...}` - a JSX condition, ternary or attribute
 *      value. A same-line inline TYPE literal (`{ is_horse?: boolean }`)
 *      never matches this: nothing there is reached via a dot.
 */

const ROOTS = ['src/pages', 'src/components'];
const ROOT = join(__dirname, '..');

function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFilesUnder(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((root) => tsxFilesUnder(join(ROOT, root)));

/** Service-call plumbing: a line reading or writing the column server-side. */
const SERVICE_CALL = /\.(select|eq|rpc|from)\(/;

/** A bare quoted `'is_horse'` / `"isHorse"` token - never `key: value`. */
const CSV_HEADER_TOKEN = /(['"])(?:is_horse|isHorse)\1(?!\s*:)/;

/** `.is_horse` / `.isHorse` reached inside a same-line `{...}` span. */
const JSX_BRACE_SPAN = /\{[^{}\n]*\.(?:is_horse|isHorse)\b/;

interface Hit {
  file: string;
  line: number;
  text: string;
  rule: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of FILES) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, idx) => {
      const line = idx + 1;
      const t = raw.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // comments never run

      if (raw.includes('Hide Horses'))
        hits.push({ file: rel, line, text: t, rule: "'Hide Horses'" });
      if (raw.includes('Horses Hidden'))
        hits.push({ file: rel, line, text: t, rule: "'Horses Hidden'" });
      if (raw.includes('People Only'))
        hits.push({ file: rel, line, text: t, rule: "'People Only'" });
      if (raw.includes('title="Horse"'))
        hits.push({ file: rel, line, text: t, rule: 'title="Horse"' });
      if (raw.includes('(Horse)')) hits.push({ file: rel, line, text: t, rule: "'(Horse)'" });
      if (/\bhideHorses\b/.test(raw))
        hits.push({ file: rel, line, text: t, rule: 'identifier hideHorses' });

      if (SERVICE_CALL.test(raw)) return; // a query string naming the column is plumbing

      if (CSV_HEADER_TOKEN.test(raw))
        hits.push({ file: rel, line, text: t, rule: 'is_horse/isHorse as a CSV header cell' });
      if (JSX_BRACE_SPAN.test(raw))
        hits.push({ file: rel, line, text: t, rule: 'is_horse/isHorse driving a JSX expression' });
    });
  }
  return hits;
}

describe('a horse is never named (Dan 2026-09-14, binding)', () => {
  it('scanned at least src/pages and src/components, so an empty result means something', () => {
    // A walker that silently found zero files would make every assertion
    // below vacuously true. Both roots exist and hold plenty of .tsx.
    expect(FILES.length).toBeGreaterThan(50);
  });

  const hits = scan();
  const byRule = new Map<string, Hit[]>();
  for (const h of hits) byRule.set(h.rule, [...(byRule.get(h.rule) ?? []), h]);

  const RULES = [
    "'Hide Horses'",
    "'Horses Hidden'",
    "'People Only'",
    'title="Horse"',
    "'(Horse)'",
    'identifier hideHorses',
    'is_horse/isHorse as a CSV header cell',
    'is_horse/isHorse driving a JSX expression',
  ];

  it.each(RULES)('no file under src/pages or src/components reveals a horse via: %s', (rule) => {
    const found = byRule.get(rule) ?? [];
    expect(
      found.map((h) => `${h.file}:${h.line}: ${h.text}`),
      found.length > 0
        ? `Dan, 2026-09-14 (binding): "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY."`
        : undefined
    ).toEqual([]);
  });
});
