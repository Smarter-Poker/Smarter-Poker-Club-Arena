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

  it('never narrows a membership read to one of the two words', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      for (const line of findOffenders(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(SRC, file)}:${line}`);
      }
    }

    expect(
      offenders,
      `These membership reads filter status to a single word, which hides every ` +
        `membership carrying the other one. Use .in('status', ['active', 'approved']).`
    ).toEqual([]);
  });
});
