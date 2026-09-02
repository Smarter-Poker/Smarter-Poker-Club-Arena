/**
 * MEMBERSHIP STATUS IS TWO WORDS. ASK FOR BOTH.
 * ============================================================================
 * club_members.status carries two words for the same idea. Every membership
 * created before 2026-07-22 says 'approved'; everything since says 'active'.
 * In production 1,480 of 1,499 rows say 'approved'.
 *
 * A screen that asks for one of them shows a fraction of the club and gives no
 * hint that it is doing so. That is exactly what happened to the Trade cashier:
 * a 588-member club rendered 11 people, and an owner's assigned horses vanished
 * from the page whose whole job is moving chips to them.
 *
 * Normalising the 1,480 rows was considered and rejected: 108 database
 * functions reference 'approved', and sweeping live data to fix a client query
 * is the wrong end of the problem. The rule is that a membership read asks for
 * both words, which every other call site already does.
 *
 * Scoped to the query chain that begins at .from('club_members') and ends at
 * the statement's semicolon. A whole-file scan was tried first and produced
 * four false positives - HorseOrchestrator filters `tables` and `table_seats`
 * on status='active', which is correct and unrelated. Guards that cry wolf get
 * deleted, so this one only looks where it means to.
 *
 * Not guarded, because both are legitimate: `.update({ status: 'banned' })`,
 * and a query for 'pending' join requests.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SRC = resolve(__dirname, '../../src');

const FROM_CLUB_MEMBERS = /\.from\((['"])club_members\1\)/g;
const SINGLE_STATUS = /\.eq\(\s*['"]status['"]\s*,\s*['"](active|approved)['"]\s*\)/;

/** Offending `file:line` for every membership read narrowed to one status word. */
function findOffenders(source: string): number[] {
  const lines: number[] = [];
  FROM_CLUB_MEMBERS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_CLUB_MEMBERS.exec(source)) !== null) {
    const end = source.indexOf(';', m.index);
    const chain = source.slice(m.index, end === -1 ? m.index + 800 : end);
    if (SINGLE_STATUS.test(chain)) {
      lines.push(source.slice(0, m.index).split('\n').length);
    }
  }
  return lines;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * READ THE TREE ONCE (2026-08-28).
 *
 * Both scans below used to walk `src/` and read all ~990 files themselves, so
 * one run of this file did that work TWICE - about 24MB off disk for a guard
 * whose actual matching is microseconds. That is fine on an idle machine (each
 * test measured ~400ms) and not fine under a sharded run: with several workers
 * competing for the same filesystem the same two tests were measured at
 * ~2150ms, and they failed together once inside a 63-file shard while the third
 * test in this file - the only one that touches no disk - passed. Two I/O-bound
 * tests timing out together and a pure-computation test surviving is the shape
 * of a resource limit, not of a real offender appearing and vanishing.
 *
 * So the tree is read once and shared. NOTHING about what is asserted changes:
 * the same files are scanned with the same patterns and the same expectations,
 * and a genuine offender fails exactly as before. The explicit timeouts on the
 * two tests are headroom for a loaded CI runner, not a way to pass.
 */
const SOURCES: { rel: string; text: string }[] = walk(SRC).map((file) => ({
  rel: relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}));

describe('club_members status filters', () => {
  it('the detector actually detects', () => {
    // A guard nobody has seen fail is a guard nobody should trust.
    const bad = `const q = supabase.from('club_members').select('user_id').eq('status', 'active');`;
    const good = `const q = supabase.from('club_members').select('user_id').in('status', ['active', 'approved']);`;
    const unrelated = `const q = supabase.from('table_seats').select('id').eq('status', 'active');`;
    expect(findOffenders(bad)).toHaveLength(1);
    expect(findOffenders(good)).toHaveLength(0);
    expect(findOffenders(unrelated)).toHaveLength(0);
  });

  it('never narrows a membership read to one of the two words', { timeout: 30_000 }, () => {
    expect(SOURCES.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const { rel, text } of SOURCES) {
      for (const line of findOffenders(text)) {
        offenders.push(`${rel}:${line}`);
      }
    }

    expect(
      offenders,
      `These membership reads filter status to a single word, which hides every ` +
        `membership carrying the other one. Use .in('status', ['active', 'approved']).`
    ).toEqual([]);
  });
});

describe('club_members row caps', () => {
  it('never caps a membership read without ordering it', { timeout: 30_000 }, () => {
    // A .limit() or .range() with no .order() returns an ARBITRARY slice. On a
    // 588-member club, `.limit(500)` silently drops 88 people, and which 88
    // can differ between two loads of the same page. That is how ten horses
    // assigned to an owner vanished from the cashier: they were the most
    // recently added rows, which is exactly what falls off an unordered cap.
    //
    // Skipped for reads that end in .single()/.maybeSingle(), where one row is
    // the whole point.
    const offenders: string[] = [];

    for (const { rel, text: source } of SOURCES) {
      FROM_CLUB_MEMBERS.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FROM_CLUB_MEMBERS.exec(source)) !== null) {
        const end = source.indexOf(';', m.index);
        const chain = source.slice(m.index, end === -1 ? m.index + 900 : end);
        const capped = /\.limit\(\s*\d/.test(chain) || /\.range\(/.test(chain);
        const ordered = chain.includes('.order(');
        const single = /maybeSingle\(\)|\.single\(\)/.test(chain);
        if (capped && !ordered && !single) {
          offenders.push(`${rel}:${source.slice(0, m.index).split('\n').length}`);
        }
      }
    }

    expect(
      offenders,
      `These membership reads cap the row count without an .order(), so which ` +
        `rows survive is arbitrary and can change between loads. Add an .order().`
    ).toEqual([]);
  });
});
