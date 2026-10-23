/**
 * A SWITCHED-OFF GAME EMPTIES OF HORSES (Dan 2026-10-23).
 *
 * The PLO board was trimmed to one game per stake by switching the rest off
 * (cash_games.enabled = false). The fleet already stopped seating there, but a
 * horse already seated kept its chair, so a "Closed" game stayed on the board
 * with players in it. The rotator now stands those horses up at the end of
 * the hand, never when a person is at the table, and never on an unread set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { horsesLeaveSwitchedOffGame } from './HorseDisabledGames.js';

const ROTATOR = readFileSync(resolve(__dirname, 'HorseSessionRotator.ts'), 'utf8');
const horses = new Set(['h1', 'h2', 'h3']);
const off = new Set(['game-off']);

describe('a switched-off game empties of horses', () => {
  it('stands the horses up at a disabled game table with nobody else there', () => {
    expect(horsesLeaveSwitchedOffGame('game-off', ['h1', 'h2'], horses, off)).toBe(true);
  });

  it('never leaves a person alone at the table', () => {
    expect(horsesLeaveSwitchedOffGame('game-off', ['h1', 'person'], horses, off)).toBe(false);
  });

  it('leaves an enabled game, a non-cluster table and an unread set alone', () => {
    expect(horsesLeaveSwitchedOffGame('game-on', ['h1', 'h2'], horses, off)).toBe(false);
    expect(horsesLeaveSwitchedOffGame(null, ['h1', 'h2'], horses, off)).toBe(false);
    expect(horsesLeaveSwitchedOffGame('game-off', ['h1', 'h2'], horses, new Set())).toBe(false);
  });

  it('is wired into the rotator leave pass through the same leaveTable door', () => {
    expect(ROTATOR).toContain('const disabledGameIds = await this.readDisabledGameIds(byTable);');
    expect(ROTATOR).toContain('const offGame = horsesLeaveSwitchedOffGame(');
    expect(ROTATOR).toContain('if (!benched && !offPlo && !offGame) continue;');
    const pass = ROTATOR.slice(ROTATOR.indexOf('const offGame = horsesLeaveSwitchedOffGame('));
    expect(pass.indexOf('await engine.leaveTable(uid)')).toBeGreaterThan(0);
    // The read fails open: any error or incomplete read returns an empty set.
    const read = ROTATOR.slice(
      ROTATOR.indexOf('private async readDisabledGameIds('),
      ROTATOR.indexOf('private noteLeaveResult(')
    );
    expect(read).toContain(".eq('enabled', false)");
    expect(read).toContain('if (!read.complete) return new Set();');
    expect(read).toContain('return new Set();');
  });
});
