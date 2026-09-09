import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const eliminations = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const engineBase = readFileSync(join(process.cwd(), 'src/engine/ServerTableEngineBase.ts'), 'utf8');
const dealing = readFileSync(join(process.cwd(), 'src/engine/ServerTableEngineDealing.ts'), 'utf8');

describe('a final-table deal is settled only from a physically parked table', () => {
  it('requires the manager and GameServer to own the same sole occupied engine', () => {
    const authority = sliceMethod(eliminations, 'authoritativeFinalTableDealEngine(): Promise<');
    expect(authority).toMatch(/from\('tables'\)[\s\S]*?from\('table_seats'\)/);
    expect(authority).toContain('occupiedTableIds.length !== 1');
    expect(authority).toContain('this.tableEngines.get(tableId)');
    expect(authority).toContain('this.gameServer.getTableEngine(tableId)');
    expect(authority).toContain('managerEngine !== serverEngine');
    expect(authority).toContain('managerEngine.isRunning()');
  });

  it('hands the exact engine to the hard terminal boundary', () => {
    const check = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
    const authority = check.indexOf('authoritativeFinalTableDealEngine()');
    const latch = check.indexOf('this.finalTableDealHandled = true', authority);
    const boundary = check.indexOf(
      'completeFinalTableDealAtBoundary(tableId, engine, tableSize)',
      latch
    );
    expect(authority).toBeGreaterThanOrEqual(0);
    expect(latch).toBeGreaterThan(authority);
    expect(boundary).toBeGreaterThan(latch);
  });

  it('parks before every final input and lets only the terminal receipt move money', () => {
    const boundary = sliceMethod(
      eliminations,
      'completeFinalTableDealAtBoundary(\n    tableId: string,'
    );
    const park = boundary.indexOf('parkForTerminalCloseout(');
    const finalInputs = boundary.indexOf(".select('user_id, chips')", park);
    const votes = boundary.indexOf(".from('tournament_deal_votes')", finalInputs);
    const money = boundary.indexOf('requestTournamentTerminalReceipt(', votes);
    expect(park).toBeGreaterThanOrEqual(0);
    expect(finalInputs).toBeGreaterThan(park);
    expect(votes).toBeGreaterThan(finalInputs);
    expect(money).toBeGreaterThan(votes);
    expect(boundary.slice(0, money)).not.toMatch(
      /applyPrizeGuarantee|settleTournamentRake|settleFinalTableDealAtomically|\.update\(|\.rpc\(/
    );
  });

  it('releases only on a proven refusal and stops ownership for every unknown outcome', () => {
    const check = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
    const proven = check.indexOf('err instanceof TerminalSettlementRefusedError');
    const stop = check.indexOf(
      "this.fenceUnknownTerminalOutcome('Tournament.final_table_deal_manager_stop_failed')",
      proven
    );
    const release = check.indexOf('engine.releaseTerminalCloseoutPause()', stop);
    expect(proven).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(proven);
    expect(release).toBeGreaterThan(stop);
    expect(check.slice(proven, release)).toContain('if (!provenRefusal)');
    expect(check.slice(release)).toMatch(
      /this\.finalTableDealHandled = false;[\s\S]*?this\.tournamentFinished = false/
    );
  });

  it('wires the terminal authority into every engine pause and resume gate', () => {
    expect(engineBase).toContain('protected terminalCloseoutPaused: boolean = false');
    expect(engineBase).toContain('async parkForTerminalCloseout(maxWaitMs: number)');
    expect(engineBase).toContain('releaseTerminalCloseoutPause(): void');
    expect(engineBase).toMatch(/resumeFromMaintenance\(\)[\s\S]*?this\.terminalCloseoutPaused/);
    expect(engineBase).toMatch(/resumeDealing\(\)[\s\S]*?this\.terminalCloseoutPaused/);
    expect(engineBase).toMatch(/isPausedByDesign\(\)[\s\S]*?this\.terminalCloseoutPaused/);
    expect(dealing).toMatch(/this\.terminalCloseoutPaused[\s\S]*?await this\.awaitPauseGate\(\)/);
  });
});
