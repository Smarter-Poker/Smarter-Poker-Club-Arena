import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceBlockAfter, sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
const ELIMINATIONS = read('src/tournament/TournamentManagerEliminations.ts');
const MANAGER = read('src/tournament/TournamentManager.ts');
const BASE = read('src/tournament/TournamentManagerBase.ts');

describe('seatless tournament roster repair ordering', () => {
  it('runs the one cursor-owned seating stage immediately after terminal cleanup', () => {
    const sweep = sliceMethod(ELIMINATIONS, 'private async runEliminationSweep(');
    const executable = blankNonCode(sweep);
    const terminalCleanupAt = executable.indexOf('await this.resumeCommittedTerminalCleanup()');
    const seatingAt = executable.indexOf('seatingStage:');
    const entryRepriceAt = executable.indexOf('this.reconcileTournamentEntryWindow(');
    const recoveryAt = executable.indexOf('recoveryStage:');
    const bustAt = executable.indexOf('bustStage:');
    const finishAt = executable.indexOf('finishStage:');

    expect(terminalCleanupAt).toBeGreaterThan(-1);
    expect(seatingAt).toBeGreaterThan(terminalCleanupAt);
    expect(entryRepriceAt).toBeGreaterThan(seatingAt);
    expect(recoveryAt).toBeGreaterThan(seatingAt);
    expect(bustAt).toBeGreaterThan(recoveryAt);
    expect(finishAt).toBeGreaterThan(bustAt);
    expect(executable.match(/\bseatingStage:/g)).toHaveLength(1);
  });

  it('advances exactly once without adding a duplicate scheduler wake', () => {
    const sweep = sliceMethod(ELIMINATIONS, 'private async runEliminationSweep(');
    const seating = blankNonCode(sliceBlockAfter(sweep, 'seatingStage:'));

    expect(seating).toContain('this.eliminationSweepCursor.nextStage > 0');
    expect(seating.match(/await this\.ensureLateRegSeated\(\)/g)).toHaveLength(1);
    expect(seating.match(/completedStage\(1\)/g)).toHaveLength(1);
    expect(seating).not.toMatch(/request(?:Urgent)?EliminationSweep/);

    expect(sweep).toContain('this.eliminationSweepCursor.nextStage > 1');
    expect(sweep).toContain('completedStage(2)');
    expect(sweep).toContain('this.eliminationSweepCursor.nextStage > 2');
    expect(sweep).toContain('completedStage(3)');
    expect(sweep).toContain('this.eliminationSweepCursor.nextStage > 3');
    expect(sweep).toContain('completedStage(4)');
  });

  it('reserves only the chair certified by the database receipt in caller snapshots', () => {
    const seating = sliceMethod(MANAGER, 'protected async ensureLateRegSeated()');
    const executable = blankNonCode(seating);
    const launch = blankNonCode(
      sliceMethod(BASE, 'createTablesAndSeatPlayers(tournament: any): Promise<void>')
    );

    expect(executable).toContain('occupancy.get(receipt.tableId)?.taken.add(receipt.seatNumber)');
    expect(executable).not.toContain('occ.taken.add(receipt.seatNumber)');
    expect(launch).toContain('occupiedSeats.get(receipt.tableId)');
    expect(launch).toContain('occupiedSeats.set(receipt.tableId, taken)');
    expect(launch).not.toContain('occupiedSeats.get(tableId) ?? new Set<number>()');
  });
});
