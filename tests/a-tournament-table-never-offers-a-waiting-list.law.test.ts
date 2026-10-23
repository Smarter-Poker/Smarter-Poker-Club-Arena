import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fmtLateRegClock,
  lateRegCallToActionCopy,
} from '../src/components/table/TournamentLateRegCallToAction';

/**
 * Dan 2026-10-21: "THIS 'TABLE FULL JOIN THE WAITING LIST' SHOULD NEVER BE
 * DISPLAYED WHEN WATCHING A TOURNAMENT OR ON A TOURNAMENT PAGE. THERE SHOULD BE
 * A MTT ONE THAT SAYS 'XYZ AMOUNT OF TIME LEFT BEFORE REGISTRATION CLOSES'
 * CLICK HERE TO REGISTER."
 */
const tablePage = readFileSync(resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8');

describe('a tournament table never offers a waiting list', () => {
  it('routes every tournament spectator to the late-registration call to action first', () => {
    const footer = tablePage.indexOf('data-testid="spectator-footer-bar"');
    expect(footer).toBeGreaterThan(0);
    const tournamentBranch = tablePage.indexOf('<TournamentLateRegCallToAction', footer);
    const waitlistBranch = tablePage.indexOf('<WaitlistCallToAction', footer);
    expect(tournamentBranch).toBeGreaterThan(footer);
    expect(waitlistBranch).toBeGreaterThan(tournamentBranch);
    // Every path that reaches the waiting list button has excluded tournaments.
    const between = tablePage.slice(tournamentBranch, waitlistBranch);
    expect(between).toMatch(/tableState\.isTournament && spectatorSeatState === 'no-seats-here'/);
  });

  it('never reads a waiting list for a tournament table', () => {
    const effect = tablePage.indexOf("if (spectatorSeatState !== 'no-seats-here') return;");
    expect(effect).toBeGreaterThan(0);
    const body = tablePage.slice(effect, tablePage.indexOf('loadWaitlist();', effect));
    expect(body).toContain('if (tableState.isTournament) return;');
  });
});

describe('late registration copy', () => {
  const now = Date.parse('2026-10-22T01:00:00Z');
  const levelMinutes = 8;
  const structure = JSON.stringify(
    Array.from({ length: 12 }, (_, i) => ({
      level: i + 1,
      smallBlind: 10 * (i + 1),
      bigBlind: 20 * (i + 1),
      ante: 0,
      durationMinutes: levelMinutes,
    }))
  );
  const base = {
    id: 't1',
    name: 'Test',
    game_type: 'nlh',
    buy_in_amount: 1,
    buy_in_fee: 0,
    guaranteed_prize: null,
    start_time: '2026-10-22T00:00:00Z',
    status: 'RUNNING',
    current_players: 368,
    max_players: null,
    starting_chips: 10000,
    late_reg_levels: 9,
    current_level: 4,
    started_at: '2026-10-22T00:20:00Z',
    // Level 5 (index 4) began 2 minutes ago.
    level_started_at: new Date(now - 2 * 60_000).toISOString(),
    blind_structure: structure,
  };

  it('prints the time left before registration closes and the register action', () => {
    // 6 minutes left in level 5, then levels 6-9 at 8 minutes each = 38:00.
    const copy = lateRegCallToActionCopy(base as never, now);
    expect(copy).toEqual({
      eyebrow: '38:00 Left Before Registration Closes',
      title: 'Tap Here To Enter',
    });
  });

  it('offers nothing once late registration has closed', () => {
    expect(lateRegCallToActionCopy({ ...base, current_level: 9 } as never, now)).toBeNull();
    expect(
      lateRegCallToActionCopy({ ...base, prize_pool_finalized: true } as never, now)
    ).toBeNull();
    expect(lateRegCallToActionCopy(null, now)).toBeNull();
  });

  it('formats long windows with hours', () => {
    expect(fmtLateRegClock(3725)).toBe('1:02:05');
    expect(fmtLateRegClock(65)).toBe('1:05');
  });

  it('contains no em dash', () => {
    const src = readFileSync(
      resolve(__dirname, '../src/components/table/TournamentLateRegCallToAction.tsx'),
      'utf8'
    );
    expect(src.includes(String.fromCharCode(0x2014))).toBe(false);
  });
});
