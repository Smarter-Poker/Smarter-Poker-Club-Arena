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

  it('arms on one poll and requires a later physical park', () => {
    const acquire = sliceMethod(eliminations, 'acquireFinalTableDealPause(): Promise<boolean>');
    const arm = acquire.indexOf('pauseForFinalTableDeal(');
    const firstReturn = acquire.indexOf('return false', arm);
    const proof = acquire.indexOf('isParkedForFinalTableDeal()', firstReturn);
    expect(arm).toBeGreaterThanOrEqual(0);
    expect(firstReturn).toBeGreaterThan(arm);
    expect(proof).toBeGreaterThan(firstReturn);
  });

  it('parks before guarantee funding and re-proves after awaited reads before money', () => {
    const check = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
    const acquire = check.indexOf('acquireFinalTableDealPause()');
    const guarantee = check.indexOf("applyPrizeGuarantee('final_table_deal')");
    const firstReproof = check.indexOf('finalTableDealPauseIsStillAuthoritative()', guarantee);
    const finalInputs = check.indexOf('{ data: finalAlive, error: finalAliveErr }', firstReproof);
    const finalReproof = check.indexOf('finalTableDealPauseIsStillAuthoritative()', finalInputs);
    const money = check.indexOf('settleFinalTableDealAtomically(', finalReproof);
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(guarantee).toBeGreaterThan(acquire);
    expect(firstReproof).toBeGreaterThan(guarantee);
    expect(finalInputs).toBeGreaterThan(firstReproof);
    expect(finalReproof).toBeGreaterThan(finalInputs);
    expect(money).toBeGreaterThan(finalReproof);
  });

  it('releases only the exact engine and every non-committed refusal releases the hold', () => {
    const release = sliceMethod(eliminations, 'releaseFinalTableDealPause(): void');
    const check = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
    expect(release).toContain('this.gameServer.getTableEngine(held.tableId) !== held.engine');
    expect(release).toContain('held.engine.resumeFromFinalTableDeal()');
    expect(check).toMatch(
      /!deal\.ok \|\| !deal\.completed[\s\S]*?committed\.status === 'COMPLETED'[\s\S]*?releaseFinalTableDealPause\(\)/
    );
    expect(check).toMatch(
      /this\.tournamentFinished = false;[\s\S]*?this\.finalTableDealHandled = false;[\s\S]*?releaseFinalTableDealPause\(\)/
    );
  });

  it('wires the independent authority into every engine pause and resume gate', () => {
    expect(engineBase).toContain('protected finalTableDealPaused: boolean = false');
    expect(engineBase).toMatch(
      /resumeFromMaintenance\(\)[\s\S]*?handForHandPaused \|\| this\.finalTableDealPaused/
    );
    expect(engineBase).toMatch(
      /resumeDealing\(\)[\s\S]*?maintenancePaused \|\| this\.finalTableDealPaused/
    );
    expect(engineBase).toMatch(/isPausedByDesign\(\)[\s\S]*?this\.finalTableDealPaused/);
    expect(engineBase).toMatch(
      /isParkedForFinalTableDeal\(\)[\s\S]*?!this\.hasSettlementInFlight\(\)[\s\S]*?this\.isBetweenHands\(\)/
    );
    expect(dealing).toMatch(
      /this\.maintenancePaused \|\|[\s\S]*?this\.finalTableDealPaused \|\|[\s\S]*?await this\.awaitPauseGate\(\)/
    );
  });
});
