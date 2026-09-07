/**
 * A LOST RPC RESPONSE IS NOT A LOST SETTLEMENT.
 *
 * The atomic place RPC can commit every prize and flip the tournament to
 * COMPLETED while all of its responses are lost in transit.  Application
 * cleanup must therefore follow durable database truth: once COMPLETED is
 * observed, no money path runs again, but the winner event, seats, tables and
 * live manager still reach their terminal state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
// Preserve offsets for the structural slicers while retaining string literals
// used by the wiring assertions below.
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (comment) => ' '.repeat(comment.length));

const eliminations = code(read('src/tournament/TournamentManagerEliminations.ts'));
const recovery = code(read('src/tournament/tournamentRecovery.ts'));
const gameServer = code(read('src/GameServer.ts'));
const managerBase = code(read('src/tournament/TournamentManagerBase.ts'));

describe('Bubble Protection has no application-layer prepayment path', () => {
  it('records the elimination and leaves Bubble money to the terminal atomic batch', () => {
    const eliminate = sliceMethod(
      eliminations,
      'eliminatePlayer(userId: string, position: number): Promise<void>'
    );
    expect(eliminate).not.toMatch(
      /settleTournamentObligation|fn_settle_tournament_obligation|bubble_protection_paid/
    );
    expect(eliminations).not.toMatch(/retryRecordedBubbleProtectionObligation/);
    expect(eliminations).not.toMatch(/from '\.\/settleObligation\.js'/);
  });
});

describe('a committed tournament always reaches its non-money terminal cleanup', () => {
  const finish = sliceMethod(eliminations, 'finishTournament(winnerId: string): Promise<void>');

  it('does not announce completion before the atomic receipt exists', () => {
    const settlement = finish.indexOf('settleTournamentPlacesAtomically(');
    expect(settlement).toBeGreaterThan(-1);
    expect(finish.slice(0, settlement)).toMatch(/FINALIZING\.\.\. candidate winner/);
    expect(finish.slice(0, settlement)).not.toMatch(/COMPLETE!/);
  });

  it('treats a missed claim followed by durable COMPLETED as its committed receipt', () => {
    const missedClaim = sliceMethod(finish, 'if (!claimResult)');
    expect(missedClaim).toMatch(
      /held\?\.status === 'COMPLETED'[\s\S]*?cleanupCommittedTournament\(\)[\s\S]*?return;/
    );
    expect(missedClaim).not.toMatch(/settleTournamentPlacesAtomically|settleTournamentObligation/);
  });

  it('checks durable COMPLETED after an apparently failed atomic call before alarming', () => {
    const refusal = sliceMethod(finish, 'if (!settlement.ok || !settlement.completed)');
    const durableRead = refusal.indexOf('readDurableTournamentStatus()');
    const cleanup = refusal.indexOf('cleanupCommittedTournament()');
    const alarm = refusal.indexOf('raiseFinancialAlert(');
    expect(durableRead).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(durableRead);
    expect(alarm).toBeGreaterThan(cleanup);
  });

  it('uses the same idempotent cleanup after an ordinary successful receipt', () => {
    expect(finish).toMatch(/cleanupCommittedTournament\(\)/);
    expect(finish).not.toMatch(/\.from\('table_seats'\)/);
    expect(finish).not.toMatch(/this\.broadcast\('tournament_winner'/);
  });

  it('proves one durable winner, releases seats, closes tables and stops the manager', () => {
    const cleanup = sliceMethod(eliminations, 'cleanupCommittedTournament(): Promise<boolean>');
    const tables = sliceMethod(
      eliminations,
      'cleanupCommittedTablesAndManager(): Promise<boolean>'
    );
    expect(cleanup).toMatch(
      /\.from\('tournament_players'\)[\s\S]*?\.eq\('status', 'winner'\)[\s\S]*?\.eq\('position', 1\)/
    );
    expect(cleanup).toMatch(/winnerRows\.length !== 1/);
    expect(cleanup).toMatch(/this\.broadcastCommittedOutcome\('tournament_winner'/);
    expect(tables).toMatch(/await engine\.stop\(\)/);
    expect(tables).toMatch(
      /\.from\('table_seats'\)[\s\S]*?left_at:[\s\S]*?\.is\('left_at', null\)/
    );
    expect(tables).toMatch(
      /\.from\('tables'\)[\s\S]*?status: 'closed'[\s\S]*?\.eq\('tournament_id', this\.tournamentId\)/
    );
    expect(tables).toMatch(/await this\.cleanupBroadcastChannel\(\)[\s\S]*?this\.stop\(\)/);
    expect(cleanup).not.toMatch(
      /settleTournamentPlacesAtomically|settleTournamentObligation|\.rpc\(/
    );
    expect(tables).not.toMatch(
      /settleTournamentPlacesAtomically|settleTournamentObligation|\.rpc\(/
    );
  });

  it('bounds terminal announcement retries and never puts them ahead of physical cleanup', () => {
    const delivery = sliceMethod(
      eliminations,
      'broadcastCommittedOutcome(eventType: string, payload: unknown): Promise<boolean>'
    );
    const normal = sliceMethod(eliminations, 'cleanupCommittedTournament(): Promise<boolean>');
    const deal = sliceMethod(eliminations, 'cleanupCommittedFinalTableDeal(): Promise<boolean>');
    expect(eliminations).toMatch(/COMMITTED_BROADCAST_ATTEMPTS = 3/);
    expect(delivery).toMatch(/if \(await this\.broadcast\(eventType, payload\)\) return true/);
    expect(delivery).toMatch(/committed_outcome_broadcast_exhausted/);
    expect(delivery).toMatch(/return false/);
    for (const cleanup of [normal, deal]) {
      const announce = cleanup.indexOf('broadcastCommittedOutcome(');
      const physical = cleanup.indexOf('cleanupCommittedTablesAndManager()');
      expect(announce).toBeGreaterThan(-1);
      expect(physical).toBeGreaterThan(announce);
    }
  });

  it('keeps the manager and engine handles alive when any engine fails to stop', () => {
    const tables = sliceMethod(
      eliminations,
      'cleanupCommittedTablesAndManager(): Promise<boolean>'
    );
    const stopFailure = sliceEnclosingBlock(tables, 'committed_cleanup_engine_stop_failed');
    const durableTableList = tables.indexOf(".from('tables')");
    const managerStop = tables.indexOf('await engine.stop()');
    const failedStopRetryGate = tables.indexOf(
      'managerEngine && !stoppedManagerEngineIds.has(tableId)'
    );
    const incompleteReturn = tables.indexOf('if (!cleanupComplete) return false;');
    const durableTableClose = tables.indexOf(".update({ status: 'closed' })");
    const unregister = tables.indexOf('this.gameServer.unregisterTableEngine(');
    const terminalStop = tables.indexOf('this.gameServer.stopClosedTournamentTableEngine(tableId)');
    const clearHandles = tables.indexOf('this.tableEngines.clear()');
    const stopManager = tables.indexOf('this.stop()');

    expect(managerStop).toBeGreaterThan(durableTableList);
    expect(tables.slice(durableTableList, managerStop)).toMatch(
      /if \(!durableTableIds\.has\(tableId\)\)[\s\S]*?cleanupComplete = false;[\s\S]*?continue;/
    );
    expect(stopFailure).not.toMatch(/stoppedManagerEngineIds\.add/);
    expect(failedStopRetryGate).toBeGreaterThanOrEqual(0);
    expect(tables.slice(failedStopRetryGate, incompleteReturn)).toMatch(
      /cleanupComplete = false;[\s\S]*?continue;/
    );
    expect(unregister).toBeGreaterThan(durableTableClose);
    expect(terminalStop).toBeGreaterThan(durableTableClose);
    expect(clearHandles).toBeGreaterThan(incompleteReturn);
    expect(stopManager).toBeGreaterThan(clearHandles);
  });

  it('only stops a replacement owner after proving its durable table is terminal', () => {
    const terminalStop = sliceMethod(
      gameServer,
      'async stopClosedTournamentTableEngine(tableId: string): Promise<boolean>'
    );
    const statusRead = terminalStop.indexOf(".select('status, tournament_id')");
    const terminalProof = terminalStop.indexOf("row.status !== 'closed'");
    const stop = terminalStop.indexOf('await current.stop()');
    const exactUnregister = terminalStop.indexOf('this.unregisterTableEngine(tableId, current)');

    expect(statusRead).toBeGreaterThanOrEqual(0);
    expect(terminalProof).toBeGreaterThan(statusRead);
    expect(stop).toBeGreaterThan(terminalProof);
    expect(exactUnregister).toBeGreaterThan(stop);
  });
});

describe('a committed final-table deal cannot be stranded by a lost receipt or tail exception', () => {
  const checkDeal = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<void>');
  const settleDeal = sliceMethod(
    eliminations,
    'settleFinalTableDeal(deal: AtomicFinalTableDealResult): Promise<void>'
  );

  it('services cleanup-only retries before either in-memory completion latch', () => {
    const pending = checkDeal.indexOf('committedFinalTableDealCleanupPending');
    const handled = checkDeal.indexOf('this.finalTableDealHandled || this.tournamentFinished');
    const money = checkDeal.indexOf('settleFinalTableDealAtomically(');
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(handled).toBeGreaterThan(pending);
    expect(money).toBeGreaterThan(handled);
    expect(checkDeal.slice(pending, handled)).toMatch(/cleanupCommittedFinalTableDeal\(\)/);
  });

  it('turns an apparently failed deal into cleanup-only work when COMPLETED is durable', () => {
    const refusal = sliceMethod(checkDeal, 'if (!deal.ok || !deal.completed)');
    expect(refusal).toMatch(
      /readDurableTournamentStatus\(\)[\s\S]*?status === 'COMPLETED'[\s\S]*?cleanupCommittedFinalTableDeal\(\)/
    );
    expect(refusal).not.toMatch(/settleFinalTableDealAtomically\([^)]/);
  });

  it('recovers a tail exception after durable completion without replaying money', () => {
    const catchBlock = sliceEnclosingBlock(checkDeal, "'Tournament.final_table_deal_threw'");
    expect(catchBlock).toMatch(
      /readDurableTournamentStatus\(\)[\s\S]*?status === 'COMPLETED'[\s\S]*?cleanupCommittedFinalTableDeal\(\)/
    );
    expect(catchBlock).not.toMatch(/settleFinalTableDealAtomically|settleTournamentRake/);
  });

  it('keeps the ordinary receipt tail on the same idempotent table and manager cleanup', () => {
    expect(settleDeal).toMatch(/cleanupCommittedTablesAndManager\(\)/);
    expect(settleDeal).not.toMatch(/\.from\('table_seats'\)|\.from\('tables'\)/);
  });

  it('can reconstruct the deal announcement from durable rows without any money RPC', () => {
    const cleanup = sliceMethod(eliminations, 'cleanupCommittedFinalTableDeal(): Promise<boolean>');
    expect(cleanup).toMatch(
      /\.from\('tournament_payouts'\)[\s\S]*?\.eq\('source', 'final_table_deal'\)/
    );
    expect(cleanup).toMatch(
      /\.from\('tournament_players'\)[\s\S]*?\.eq\('status', 'winner'\)[\s\S]*?\.eq\('position', 1\)/
    );
    expect(cleanup).toMatch(/this\.broadcastCommittedOutcome\('final_table_deal'/);
    expect(cleanup).toMatch(/cleanupCommittedTablesAndManager\(\)/);
    expect(cleanup).not.toMatch(/\.rpc\(|settleFinalTableDealAtomically|settleTournamentRake/);
  });
});

describe('standalone recovery accepts durable completion after a lost receipt', () => {
  const recover = sliceMethod(recovery, 'export async function recoverStuckCompletingTournaments(');
  const refusal = sliceMethod(recover, 'if (!settlement.ok || !settlement.completed)');

  it('reads the tournament status and proceeds only when COMPLETED is proven', () => {
    expect(refusal).toMatch(
      /\.from\('tournaments'\)[\s\S]*?\.select\('status'\)[\s\S]*?\.eq\('id', t\.id\)/
    );
    expect(refusal).toMatch(/committed\?\.status !== 'COMPLETED'[\s\S]*?throw new Error/);
  });

  it('keeps table closure after the durable proof and never opens a second money path', () => {
    const refusalAt = recover.indexOf('if (!settlement.ok || !settlement.completed)');
    const closeAt = recover.indexOf('closeRecoveredTournamentTablesAndSeats(t.id)', refusalAt);
    expect(closeAt).toBeGreaterThan(refusalAt);
    expect(recover.match(/settleTournamentPlacesAtomically\(/g)).toHaveLength(1);
  });

  it('checks every cleanup result before continuing or logging success', () => {
    expect(
      recover.match(
        /const cleanupComplete = await closeRecoveredTournamentTablesAndSeats\(t\.id\)/g
      )
    ).toHaveLength(3);
    expect(recover.match(/if \(!cleanupComplete\) \{/g)).toHaveLength(3);
    const successLog = recover.indexOf('atomically settled ${settlement.places} place(s)');
    const finalCheck = recover.lastIndexOf('if (!cleanupComplete)', successLog);
    expect(successLog).toBeGreaterThan(finalCheck);
  });

  it('closes a durably completed deal instead of paying the structure over it', () => {
    const dealEvidence = sliceMethod(
      recover,
      'if ((dealPayouts.data?.length ?? 0) > 0 || (dealObligations.data?.length ?? 0) > 0)'
    );
    expect(dealEvidence).toMatch(
      /\.from\('tournaments'\)[\s\S]*?\.select\('status'\)[\s\S]*?status === 'COMPLETED'[\s\S]*?closeRecoveredTournamentTablesAndSeats\(t\.id\)/
    );
    expect(dealEvidence).not.toMatch(/settleTournamentPlacesAtomically|computePlacePrize/);
    expect(dealEvidence).not.toMatch(/settleFinalTableDealAtomically/);
    expect(dealEvidence.trimEnd()).toMatch(/continue;\s*}$/);
  });

  it('the recovery closure releases seats as well as closing every table', () => {
    const close = sliceMethod(recovery, 'async function closeRecoveredTournamentTablesAndSeats(');
    expect(close).toMatch(/\.from\('tables'\)[\s\S]*?\.select\('id'\)/);
    expect(close).toMatch(/\.from\('table_seats'\)[\s\S]*?\.is\('left_at', null\)/);
    expect(close).toMatch(/\.from\('tables'\)[\s\S]*?status: 'closed'/);
    expect(close).toMatch(/\.select\('id, status, current_players'\)/);
    expect(close).toMatch(/count: 'exact', head: true[\s\S]*?seatProof\.count !== 0/);
    expect(close).not.toMatch(/\.rpc\(|settleTournament/);
  });
});

describe('standalone recovery cannot leave a live manager behind', () => {
  it('stops and removes the exact seat-first manager only after claiming COMPLETING', () => {
    const sweep = sliceMethod(gameServer, 'private async finishSeatFirstGamesThatAreOver()');
    const claim = sweep.indexOf(".update({ status: 'COMPLETING' })");
    const claimProof = sweep.indexOf('if (!claim || claim.length === 0)', claim);
    const lookup = sweep.indexOf('this.tournamentEngines.get(id)', claimProof);
    const stop = sweep.indexOf('claimedManager.stop()', lookup);
    const stoppedProof = sweep.indexOf('claimedManager.isRunning()', stop);
    const exactOwner = sweep.indexOf('this.tournamentEngines.get(id) === claimedManager', stop);
    const remove = sweep.indexOf('this.tournamentEngines.delete(id)', exactOwner);
    expect(claim).toBeGreaterThan(-1);
    expect(claimProof).toBeGreaterThan(claim);
    expect(lookup).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(lookup);
    expect(stoppedProof).toBeGreaterThan(stop);
    expect(exactOwner).toBeGreaterThan(stoppedProof);
    expect(remove).toBeGreaterThan(exactOwner);
  });

  it('refuses to revive tables unless durable tournament status is RUNNING', () => {
    const revive = sliceMethod(managerBase, 'protected async reviveDeadTableEngines()');
    const statusRead = revive.indexOf(".select('status')");
    const runningGate = revive.indexOf("durableTournament.status !== 'RUNNING'", statusRead);
    const stop = revive.indexOf('this.stop()', runningGate);
    const adopt = revive.indexOf('await this.adoptEnginelessTables()', stop);
    const postAdoptGate = revive.indexOf('if (!this.running) return;', adopt);
    const engineStop = revive.indexOf('await engine.stop()', postAdoptGate);
    const postStopGate = revive.indexOf('if (!this.running) return;', engineStop);
    const replacement = revive.indexOf('new ServerTableEngine(tableId)', postStopGate);
    expect(statusRead).toBeGreaterThan(-1);
    expect(runningGate).toBeGreaterThan(statusRead);
    expect(stop).toBeGreaterThan(runningGate);
    expect(adopt).toBeGreaterThan(stop);
    expect(postAdoptGate).toBeGreaterThan(adopt);
    expect(engineStop).toBeGreaterThan(postAdoptGate);
    expect(postStopGate).toBeGreaterThan(engineStop);
    expect(replacement).toBeGreaterThan(postStopGate);
  });
});

describe('the existing startup orphan cleanup is exhaustive and evidence checked', () => {
  const cleanup = sliceEnclosingBlock(gameServer, 'const orphanPageSize = 500');

  it('keyset-pages every tournament table, including closed tables with leaked seats', () => {
    const candidateRead = cleanup.slice(
      cleanup.indexOf('let openTableQuery'),
      cleanup.indexOf('const { data: openTourneyTables')
    );
    expect(candidateRead).toMatch(/\.not\('tournament_id', 'is', null\)/);
    expect(candidateRead).toMatch(/\.order\('id', \{ ascending: true \}\)/);
    expect(candidateRead).not.toMatch(/\.(?:eq|neq|in|or)\('status'/);
    expect(cleanup).toMatch(/openTableQuery = openTableQuery\.gt\('id', afterTableId\)/);
    expect(cleanup).not.toMatch(/finishedSet|finishedError/);
  });

  it('fails closed on list, seat, proof or table-update errors and counts confirmed closes only', () => {
    expect(cleanup).toMatch(/openTableError[\s\S]*?throw new Error/);
    expect(cleanup).toMatch(/freshErr[\s\S]*?continue/);
    expect(cleanup).toMatch(/seatErr[\s\S]*?continue/);
    expect(cleanup).toMatch(
      /\.from\('table_seats'\)[\s\S]*?\.update\(\{ left_at:[\s\S]*?\.is\('left_at', null\)/
    );
    expect(cleanup).toMatch(
      /\.select\('id', \{ count: 'exact', head: true \}\)[\s\S]*?\.is\('left_at', null\)/
    );
    expect(cleanup).toMatch(/seatProofError \|\| liveSeatCount !== 0[\s\S]*?continue/);
    expect(cleanup).toMatch(
      /closeError \|\| !closedRows \|\| closedRows\.length !== batch\.length/
    );
    expect(cleanup).toMatch(/closedOrphans \+= closedRows\.length/);
    expect(cleanup).not.toMatch(/closedOrphans \+= batch\.length/);
  });
});

describe('service-role tournament money still obeys the maintenance freeze', () => {
  it('gates horse rebuys before the service-role RPC', () => {
    const rebuys = sliceMethod(eliminations, 'private async tryTournamentRebuys(');
    const freeze = rebuys.indexOf('if (isMaintenanceFrozen())');
    const rpc = rebuys.indexOf("supabase.rpc('process_tournament_rebuy'");
    expect(freeze).toBeGreaterThanOrEqual(0);
    expect(rpc).toBeGreaterThan(freeze);
    expect(rebuys.slice(freeze, rpc)).toMatch(/return \{ rebought, answered \};/);
    expect(rebuys.slice(freeze, rpc)).toMatch(/rebuyDecisionGraceUntil\.set/);
  });

  it('gates a normal finish before claiming or attempting atomic settlement', () => {
    const finish = sliceMethod(eliminations, 'finishTournament(winnerId: string): Promise<void>');
    const firstFreeze = finish.indexOf('if (isMaintenanceFrozen()) return;');
    const claim = finish.indexOf(".update({ status: 'COMPLETING' }");
    const atomic = finish.indexOf('settleTournamentPlacesAtomically(');
    const lastFreeze = finish.lastIndexOf('if (isMaintenanceFrozen())');
    expect(firstFreeze).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(firstFreeze);
    expect(lastFreeze).toBeGreaterThan(claim);
    expect(atomic).toBeGreaterThan(lastFreeze);
  });

  it('lets cleanup-only deal retries run while gating every new deal attempt', () => {
    const checkDeal = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<void>');
    const pending = checkDeal.indexOf('committedFinalTableDealCleanupPending');
    const cleanup = checkDeal.indexOf('cleanupCommittedFinalTableDeal()', pending);
    const firstFreeze = checkDeal.indexOf('isMaintenanceFrozen()', cleanup);
    const atomic = checkDeal.indexOf('settleFinalTableDealAtomically(');
    const lastFreeze = checkDeal.lastIndexOf('isMaintenanceFrozen()');
    expect(cleanup).toBeGreaterThan(pending);
    expect(firstFreeze).toBeGreaterThan(cleanup);
    expect(lastFreeze).toBeGreaterThanOrEqual(firstFreeze);
    expect(atomic).toBeGreaterThan(lastFreeze);
  });

  it('gates standalone recovery before guarantee, rake or atomic place money', () => {
    const recover = sliceMethod(
      recovery,
      'export async function recoverStuckCompletingTournaments('
    );
    const completedCleanup = recover.indexOf("status?: string }).status === 'COMPLETED'");
    const firstFreeze = recover.indexOf('if (isMaintenanceFrozen()) continue;', completedCleanup);
    const guarantee = recover.indexOf("'fn_apply_prize_guarantee'", firstFreeze);
    const rake = recover.indexOf("'fn_settle_tournament_rake'", firstFreeze);
    const atomic = recover.indexOf('settleTournamentPlacesAtomically(', firstFreeze);
    const lastFreeze = recover.lastIndexOf('if (isMaintenanceFrozen()) continue;', atomic);
    expect(completedCleanup).toBeGreaterThanOrEqual(0);
    expect(firstFreeze).toBeGreaterThan(completedCleanup);
    expect(guarantee).toBeGreaterThan(firstFreeze);
    expect(rake).toBeGreaterThan(guarantee);
    expect(lastFreeze).toBeGreaterThan(rake);
    expect(atomic).toBeGreaterThan(lastFreeze);
  });
});
