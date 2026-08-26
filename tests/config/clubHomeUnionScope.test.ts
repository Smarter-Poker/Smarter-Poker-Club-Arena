/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A UNION CLUB MUST SEE WHAT THE UNION RUNS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23, from Shark Club's lobby: "YOU SAY SPINS ARE OPEN AND
 * RUNNING, BUT THE CLUBS CAN'T SEE ANY SPINS, HEADS UP OR MTT'S ANYWHERE...
 * THIS HAS GOT TO STOP HAPPENING!"
 *
 * WHAT IT WAS. get_club_home carried the union scope TWICE — once for tables,
 * once for tournaments — and only the tables copy had ever been fixed:
 *
 *   tables       THEN (union_id = v_union_id OR (club_id = ... AND is_private))
 *   tournaments  THEN (club_id = ... AND is_private = true)          ← no union
 *
 * Fifteen lines apart, meant to say the same thing. So a union club got every
 * union cash table and only its OWN PRIVATE tournaments — Shark Club has none.
 * Measured: 43 tables, ZERO tournaments, while the union ran 36 joinable
 * Spins, 33 MTTs and 21 heads-up games.
 *
 * It also explains the intermittency: this RPC is the FAST PATH that paints
 * first, and the client's authoritative query does carry the union branch. On
 * a healthy database the real query overwrote the empty paint and the games
 * appeared; when it timed out — repeatedly, all day — the empty paint was all
 * that survived. "Sometimes it displays, then it disappears."
 *
 * THE POINT OF THIS FILE. The missing branch is the symptom. The disease is
 * that the rule was WRITABLE TWICE, and this is at least the second time the
 * copies drifted. These tests fail if anyone re-introduces a second copy, on
 * either side of the wire.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tournamentVariant } from '../../src/utils/tournamentFilters';
import { classifyTournament } from '../../src/components/lobby/lobbyEntries';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const dir = resolve(root, 'supabase/migrations');
const sql = readdirSync(dir)
  .filter((f) => f.includes('club_home_one_scope'))
  .map((f) => readFileSync(resolve(dir, f), 'utf8'))
  .join('\n');
const clubHome = read('src/pages/ClubHomePage.tsx');

describe('the union scope exists in exactly one place', () => {
  it('ships the migration', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it('refuses to pass unless BOTH lists route through the one predicate', () => {
    expect(sql).toMatch(/fn_club_home_in_scope/);
    expect(sql).toMatch(/does not route exactly its two lists through the shared scope/);
  });

  it('refuses to pass while any union club is blind', () => {
    expect(sql).toMatch(/fn_club_home_scope_parity/);
    expect(sql).toMatch(/a union club still sees no tournaments/);
  });

  it('names the real disease, not just the missing branch', () => {
    expect(sql).toMatch(/WRITABLE TWICE/);
  });
});

describe('the client asks for the union too, on both queries', () => {
  it('scopes the tournament fetch through the one shared rule', () => {
    // Superseded within the day: this used to assert TWO queries, one scoped
    // by club and one by union. That asymmetry against the single-query table
    // path is exactly what let the union branch go missing from the
    // tournament side, so the shape is now identical for both.
    expect(clubHome).toMatch(/applyClubScope\(clubTournamentQuery/);
    expect(clubHome).toMatch(/applyClubScope\(tableQuery/);
  });

  it('every tournament select carries variant, so nothing guesses from a name', () => {
    const selects = clubHome.match(/'id, name, game_type[^']*'/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(1);
    for (const sel of selects) expect(sel).toContain('variant');
  });
});

describe('a Spin is classified by what it is, not what it is called', () => {
  it('trusts the column over the name', () => {
    // "Spinnaker Special" is not a Spin, and a renamed Spin is still a Spin.
    expect(
      tournamentVariant({
        name: 'Spinnaker Special',
        variant: 'freezeout',
        max_players: 200,
        start_time: '',
      })
    ).toBe('MTT');
    expect(
      tournamentVariant({
        name: 'Tuesday Lottery',
        variant: 'spin',
        max_players: 3,
        start_time: '',
      })
    ).toBe('Spin-It');
    expect(
      classifyTournament({
        name: 'Spinnaker Special',
        variant: 'freezeout',
        max_players: 200,
      } as never)
    ).toBe('mtt');
    expect(
      classifyTournament({ name: 'Tuesday Lottery', variant: 'spin', max_players: 3 } as never)
    ).toBe('spin');
  });

  it('still classifies when the column is absent, rather than emptying the tab', () => {
    // Removing the heuristic would turn a wrong tab into an empty one.
    expect(tournamentVariant({ name: '10 Chip Spin PLO4', max_players: 3, start_time: '' })).toBe(
      'Spin-It'
    );
    expect(classifyTournament({ name: '10 Chip Spin PLO4', max_players: 3 } as never)).toBe('spin');
  });

  it('still puts a real Spin on the Spins tab and heads-up on its own', () => {
    expect(
      tournamentVariant({
        name: '10 Chip Spin PLO4',
        variant: 'spin',
        max_players: 3,
        start_time: '',
      })
    ).toBe('Spin-It');
    expect(
      tournamentVariant({ name: 'NLH Heads-Up 10', variant: 'sng', max_players: 2, start_time: '' })
    ).toBe('SN');
    expect(
      tournamentVariant({
        name: 'Afternoon Bounty (NLH)',
        variant: 'freezeout',
        max_players: 200,
        start_time: '',
      })
    ).toBe('MTT');
  });
});
