/**
 * EACH TOURNAMENT STARTS ITS OWN FIVE MINUTES (Dan 2026-10-25, BINDING).
 *
 * Dan, verbatim: "THE 5 MINUTE BREAK FOR ALL TOURNAMENTS DOES NOT START FOR
 * THE TOURNAMENT UNTIL ALL HANDS FOR THAT SPECIFIC TOURNAMENT ARE COMPLETED,
 * 'LAST HAND BEFORE BREAK' THEN BREAK, NOT STARTING THE CLOCK BEFORE THE LAST
 * HAND INSIDE THAT TOURNAMENT IS COMPLETED. EVERY TOURNAMENT WILL START AND
 * STOP THERE 5 MINUTE BREAK AT DIFFERENT TIMES WITH THIS SETTING. BUT THIS IS
 * 100% HOW ITS SUPPOSED TO BE."
 *
 * Two things were wrong, and both are pinned here:
 *
 * 1. The engine waited for every table of EVERY tournament and stamped one
 *    shared end on all of them, then resumed them all at once.
 * 2. The table's break clock was never handed the phase or the server's end
 *    time, so it fell back to its 'counting_down' default and ran a local five
 *    minutes from :55 while the last hand was still being played (Dan's
 *    screenshot: "Break: 4:24" over a live flop, with "Resumes: Last Hand"
 *    in the info bar beneath it).
 *
 * The behaviour itself is exercised in server/src/SynchronizedBreakDeadline.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const GAME_SERVER = read('server/src/GameServer.ts');
const MODALS = read('src/components/table/TableModalsLayer.tsx');
const SCREEN = read('src/components/table/TournamentBreakScreen.tsx');

function method(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

describe('each tournament starts its own break', () => {
  it('the :55 trigger hands every tournament to its own break instead of one shared drain', () => {
    const trigger = method(GAME_SERVER, 'private async triggerSynchronizedBreak()');
    expect(trigger).toContain(
      'this.runTournamentBreak(tm, maintenanceEndsAt, generation, breakGeneration)'
    );
    expect(trigger).not.toMatch(/waitForAllTablesParked\(\s*breakEngines\s*\)/);
    expect(trigger).not.toMatch(/beginBreakCountdown\(/);
  });

  it("a tournament's countdown waits for that tournament's tables alone", () => {
    const own = method(GAME_SERVER, 'private async runTournamentBreak(');
    expect(own).toContain('await this.waitForAllTablesParked([tm])');
    const wait = method(GAME_SERVER, 'private async waitForAllTablesParked(');
    // The drain must not widen itself to other tournaments.
    expect(wait).not.toContain('this.tournamentEngines');
    expect(wait).not.toContain('PARK_WAIT_CEILING_MS');
    expect(wait).toContain('if (waitingOn.length === 0) return true');
  });

  it('each tournament is resumed by its own timer, never by a sweep of every engine', () => {
    const schedule = method(GAME_SERVER, 'private scheduleTournamentBreakResume(');
    expect(schedule).toContain('this.resumeTournamentBreak(tm, generation, breakGeneration)');
    const resume = method(GAME_SERVER, 'private async resumeSynchronizedBreak(');
    expect(resume).not.toContain('this.tournamentEngines');
  });

  it('the table break clock is told the phase and the real end, and shows Last Hand until then', () => {
    expect(MODALS).toMatch(
      /phase=\{addOnBreakNotice \? 'counting_down' : \(tournamentBreak\.phase \?\? 'last_hand'\)\}/
    );
    expect(MODALS).toMatch(
      /breakEndsAtMs=\{addOnBreakNotice\?\.endsAtMs \?\? tournamentBreak\.breakEndsAtMs \?\? null\}/
    );
    expect(SCREEN).toContain(
      "countingDown ? `Break: ${formatTime(displayTime)}` : 'Break: Last Hand'"
    );
  });
});
