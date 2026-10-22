import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  UNION_DASHBOARD_CLUB_COLUMNS,
  clubWithMoneyPanel,
} from '../src/services/unionDashboardClubs';

/*
 * Tables whose browser SELECT grant is column-level (production, 2026-10-21).
 * PostgREST expands `*` to every column, withheld ones included, and fails the
 * whole read with "permission denied for table <name>". Union Bank (PR #7621)
 * and the Union Dashboard both showed zero clubs because of exactly that.
 */
const PROTECTED = [
  'clubs',
  'club_members',
  'commander_home_members',
  'live_streams',
  'profiles',
  'social_posts',
  'social_reels',
  'table_seats',
  'trivia_pvp_matches',
  'trivia_pvp_queue',
  'trivia_question_reports',
  'trivia_questions',
];

const WITHHELD_CLUB_COLUMNS = [
  'chip_pool',
  'chip_treasury',
  'club_commission_rate',
  'guarantee_treasury_floor',
  'hands_played',
  'insurance_balance',
  'promo_balance',
  'spins_preseed_amount',
  'spins_wallet_funding',
  'total_rake',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('Union Dashboard club directory', () => {
  it('reads club identity only, never a withheld money column', () => {
    const cols = UNION_DASHBOARD_CLUB_COLUMNS.split(',').map((c) => c.trim());
    expect(cols).not.toContain('*');
    for (const c of WITHHELD_CLUB_COLUMNS) expect(cols).not.toContain(c);
    expect(cols).toEqual(expect.arrayContaining(['id', 'name']));
  });

  it('takes club money from an authorized panel', () => {
    const club = { id: 'c1', name: 'Club', club_commission_rate: 0.9 };
    const out = clubWithMoneyPanel(club, {
      authorized: true,
      club_treasury: 1234.5,
      club_rake_this_week: 88,
    });
    expect(out.chip_treasury).toBe(1234.5);
    expect(out.total_rake).toBe(88);
    expect(out.name).toBe('Club');
  });

  it('leaves money unknown, never 0, when the panel is refused or unreadable', () => {
    const club = { id: 'c1', name: 'Club', club_commission_rate: 0.9 };
    for (const panel of [null, undefined, { authorized: false, reason: 'not_a_member' }]) {
      const out = clubWithMoneyPanel(club, panel);
      expect(out.chip_treasury).toBeUndefined();
      expect(out.total_rake).toBeUndefined();
    }
  });
});

describe('No browser query asks a column-protected table for every column', () => {
  const files = sourceFiles(join(__dirname, '..', 'src'));

  it('has no embedded wildcard such as clubs:club_id(*)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/\.select\(\s*(['"`])([^'"`]*)\1/g)) {
        if (/\(\s*\*\s*\)/.test(m[2])) offenders.push(`${f}: ${m[2]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no from('<protected>').select('*') or select()", () => {
    const offenders: string[] = [];
    const re = new RegExp(
      String.raw`\.from\(\s*['"](${PROTECTED.join('|')})['"]\s*\)\s*\.select\(\s*(?:\)|['"\`]\s*\*\s*[,'"\`])`,
      'g'
    );
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(re)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
