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
const seatExitMigration = read(
  '../supabase/migrations/20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql'
);
describe('Bubble Protection has no application-layer prepayment path', () => {
  it('records the elimination and leaves Bubble money to the terminal atomic batch', () => {
    const eliminate = sliceMethod(
      eliminations,
      'eliminatePlayer(\n    userId: string,\n    position: number,\n    allowCompletingClaim = false\n  ): Promise<boolean>'
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
    const settlement = finish.indexOf('requestTournamentTerminalReceipt(');
    const complete = finish.indexOf('COMPLETE - winner', settlement);
    expect(settlement).toBeGreaterThan(-1);
    expect(finish.slice(0, settlement)).toMatch(/FINALIZING\.\.\. candidate winner/);
    expect(finish.slice(0, settlement)).not.toMatch(/COMPLETE - winner/);
    expect(complete).toBeGreaterThan(settlement);
  });

  it('treats an already-held immutable receipt as cleanup-only work', () => {
    const replay = sliceMethod(finish, 'if (this.committedFinishReceipt)');
    expect(replay).toMatch(
      /cleanupCommittedTournament\(this\.committedFinishReceipt\)[\s\S]*?return;/
    );
    expect(replay).not.toMatch(
      /requestTournamentTerminalReceipt|settleSatelliteFinishAtomically|settleTournamentObligation|\.rpc\(/
    );
  });

  it('releases only a proven refusal and stops ownership for every unknown result', () => {
    const refusal = sliceEnclosingBlock(finish, "'Tournament.atomic_finish_outcome_unknown'");
    const proof = refusal.indexOf('settlementErr instanceof TerminalSettlementRefusedError');
    const alarm = refusal.indexOf('raiseFinancialAlert(');
    const release = refusal.indexOf('if (provenRefusal) releaseFinishGuard()');
    const stop = refusal.indexOf('if (!provenRefusal) await this.stopAndWait()');
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(alarm).toBeGreaterThan(proof);
    expect(release).toBeGreaterThan(alarm);
    expect(stop).toBeGreaterThan(release);
    expect(refusal).not.toMatch(/readDurableTournamentStatus|\.from\(|\.rpc\(/);
  });

  it('uses the same idempotent cleanup after an ordinary successful receipt', () => {
    expect(finish).toMatch(/cleanupCommittedTournament\(receipt\)/);
    expect(finish).not.toMatch(/\.from\('table_seats'\)/);
    expect(finish).not.toMatch(/this\.broadcast\('tournament_winner'/);
  });

  it('uses only receipt identity to announce and stop exact process owners', () => {
    const cleanup = sliceMethod(
      eliminations,
      'cleanupCommittedTournament(\n    receipt: VerifiedTournamentCompletionReceipt'
    );
    const tables = sliceMethod(
      eliminations,
      'cleanupCommittedTablesAndManager(\n    closedTableIds: readonly string[]'
    );
    expect(cleanup).toContain('receipt.winnerId');
    expect(cleanup).toContain('receipt.winnerAmount');
    expect(cleanup).toContain('receipt.tableClosure.closedTableIds');
    expect(cleanup).toMatch(/this\.broadcastCommittedOutcome\('tournament_winner'/);
    expect(tables).toMatch(/await managerEngine\.stop\(\)/);
    expect(tables).toContain('this.gameServer.unregisterTableEngine(tableId, managerEngine)');
    expect(tables).toContain('this.gameServer.stopClosedTournamentTableEngine(tableId)');
    expect(tables).toMatch(/await this\.cleanupBroadcastChannel\(\)[\s\S]*?this\.stop\(\)/);
    expect(`${cleanup}\n${tables}`).not.toMatch(
      /settleTournamentPlacesAtomically|settleTournamentObligation|\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.from\(/
    );
  });

  it('bounds terminal announcement retries and never puts them ahead of physical cleanup', () => {
    const delivery = sliceMethod(
      eliminations,
      'broadcastCommittedOutcome(eventType: string, payload: unknown): Promise<boolean>'
    );
    const normal = sliceMethod(
      eliminations,
      'cleanupCommittedTournament(\n    receipt: VerifiedTournamentCompletionReceipt'
    );
    const deal = sliceMethod(
      eliminations,
      'settleFinalTableDeal(\n    receipt: VerifiedTournamentCompletionReceipt'
    );
    const satellite = sliceMethod(
      eliminations,
      'cleanupCommittedSatellite(\n    receipt: VerifiedSatelliteSettlementReceipt'
    );
    expect(eliminations).toMatch(/COMMITTED_BROADCAST_ATTEMPTS = 3/);
    expect(delivery).toMatch(/if \(await this\.broadcast\(eventType, payload\)\) return true/);
    expect(delivery).toMatch(/committed_outcome_broadcast_exhausted/);
    expect(delivery).toMatch(/return false/);
    for (const cleanup of [normal, deal, satellite]) {
      const announce = cleanup.indexOf('broadcastCommittedOutcome(');
      const physical = cleanup.indexOf('cleanupCommittedTablesAndManager(');
      expect(announce).toBeGreaterThan(-1);
      expect(physical).toBeGreaterThan(announce);
    }
  });

  it('retires only released exact owners and retains failures that still own the process', () => {
    const tables = sliceMethod(
      eliminations,
      'cleanupCommittedTablesAndManager(\n    closedTableIds: readonly string[]'
    );
    const stopFailure = sliceEnclosingBlock(tables, 'committed_cleanup_engine_stop_failed');
    const receiptIds = tables.indexOf('const receiptTableIds = new Set(tableIds)');
    const provenanceGate = tables.indexOf('if (receiptTableIds.has(tableId)) continue');
    const managerStop = tables.indexOf('await managerEngine.stop()');
    const incompleteReturn = tables.indexOf('if (!cleanupComplete) return false;');
    const unregister = tables.indexOf('this.gameServer.unregisterTableEngine(');
    const terminalStop = tables.indexOf('this.gameServer.stopClosedTournamentTableEngine(tableId)');
    const clearHandles = tables.indexOf('this.tableEngines.clear()');
    const stopManager = tables.indexOf('this.stop()');

    expect(receiptIds).toBeGreaterThanOrEqual(0);
    expect(provenanceGate).toBeGreaterThan(receiptIds);
    expect(managerStop).toBeGreaterThan(provenanceGate);
    expect(tables).toContain('!managerEngine.hasReleasedProcessOwnership()');
    expect(stopFailure).not.toMatch(/this\.tableEngines\.delete|this\.tableEngines\.clear/);
    expect(tables).toContain('committed_cleanup_engine_stop_cleanup_failed');
    expect(tables).toMatch(
      /committed_cleanup_engine_stop_cleanup_failed[\s\S]*?released = this\.gameServer\.unregisterTableEngine\(tableId, managerEngine\)/
    );
    expect(unregister).toBeGreaterThan(managerStop);
    expect(terminalStop).toBeGreaterThan(unregister);
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
    expect(terminalStop).toMatch(
      /if \(!current\.hasReleasedProcessOwnership\(\)\)[\s\S]*?terminal_table_engine_stop_failed[\s\S]*?return false;/
    );
    expect(terminalStop).toMatch(
      /terminal_table_engine_stop_cleanup_failed[\s\S]*?this\.unregisterTableEngine\(tableId, current\)/
    );
  });
});

describe('a committed final-table deal cannot be stranded by a lost receipt or tail exception', () => {
  const checkDeal = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
  const settleDeal = sliceMethod(
    eliminations,
    'settleFinalTableDeal(\n    receipt: VerifiedTournamentCompletionReceipt'
  );

  it('services cleanup-only retries before either in-memory completion latch', () => {
    const pending = checkDeal.indexOf('committedFinalTableDealCleanupPending');
    const handled = checkDeal.indexOf('this.finalTableDealHandled || this.tournamentFinished');
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(handled).toBeGreaterThan(pending);
    expect(checkDeal.slice(pending, handled)).toMatch(
      /settleFinalTableDeal\(this\.committedFinalTableDealReceipt\)/
    );
  });

  it('turns every already-held receipt into cleanup-only work', () => {
    const committed = sliceMethod(checkDeal, 'if (committedReceipt)');
    expect(committed).toMatch(
      /committedFinalTableDealReceipt = committedReceipt[\s\S]*?settleFinalTableDeal\(committedReceipt\)/
    );
    expect(committed).not.toMatch(/requestTournamentTerminalReceipt|\.rpc\(|\.from\(/);
  });

  it('never releases the hard gate for an unclassified or outcome-unknown error', () => {
    const unknown = checkDeal.indexOf('if (!provenRefusal)');
    const release = checkDeal.indexOf('engine.releaseTerminalCloseoutPause()');
    const refusal = checkDeal.slice(unknown, release);
    expect(unknown).toBeGreaterThanOrEqual(0);
    expect(refusal).toContain('await this.stopAndWait()');
    expect(refusal).toContain('return false;');
    expect(release).toBeGreaterThan(unknown);
  });

  it('keeps the ordinary receipt tail on the same idempotent table and manager cleanup', () => {
    expect(settleDeal).toMatch(/cleanupCommittedTablesAndManager\(/);
    expect(settleDeal).not.toMatch(/\.from\('table_seats'\)|\.from\('tables'\)/);
  });

  it('reconstructs the deal announcement only from the immutable receipt', () => {
    expect(settleDeal).toContain('receipt.dealShares');
    expect(settleDeal).toContain('receipt.winnerId');
    expect(settleDeal).toContain('receipt.tableClosure.closedTableIds');
    expect(settleDeal).toMatch(/this\.broadcastCommittedOutcome\('final_table_deal'/);
    expect(settleDeal).not.toMatch(
      /\.from\(|\.rpc\(|settleFinalTableDealAtomically|settleTournamentRake/
    );
  });
});

describe('standalone recovery delegates terminal mutation and cleanup to one receipt authority', () => {
  const recover = sliceMethod(recovery, 'export async function recoverStuckCompletingTournaments(');

  it('uses the same whole-domain receipt helpers as live play', () => {
    expect(recover.match(/requestTournamentTerminalReceipt\(/g)).toHaveLength(1);
    expect(recover.match(/requestSatelliteSettlementReceipt\(/g)).toHaveLength(1);
    expect(recover).not.toMatch(
      /settleTournamentPlacesAtomically|settleTournamentObligation|settleFinalTableDealAtomically/
    );
  });

  it('never performs post-receipt seat, table, status, or money cleanup', () => {
    expect(recover).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(recover).not.toMatch(/closeRecoveredTournamentTablesAndSeats|cleanupCommitted/);
  });

  it('logs only from a verified immutable receipt', () => {
    const request = recover.indexOf('const receipt = await requestTournamentTerminalReceipt(');
    const success = recover.indexOf('[GameServer] Recovered tournament', request);
    expect(request).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(request);
    expect(recover.slice(request, success)).not.toMatch(/\.from\(|\.rpc\(/);
  });

  it('classifies a refusal separately and raises a critical alert for an unknown outcome', () => {
    expect(recover).toMatch(/error instanceof TerminalSettlementRefusedError/);
    expect(recover).toMatch(
      /reportUnknownRecoveryOutcome\(tournament, winnerId, reason, 'tournament'/
    );
  });
});

describe('the seat-first watchdog leaves terminal ownership with the tournament manager', () => {
  it('never claims completion, chooses a winner or stops a manager from the outside', () => {
    const sweep = sliceMethod(gameServer, 'private async finishSeatFirstGamesThatAreOver()');
    const decided = sweep.indexOf('if (liveStacks > 1) continue;');
    const lookup = sweep.indexOf('this.tournamentEngines.get(id)', decided);
    const wake = sweep.indexOf("requestEliminationSweep('seat_first_terminal_stack')", lookup);
    const admit = sweep.indexOf('ensureTournamentManagerAdmission(', lookup);
    expect(decided).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeGreaterThan(decided);
    expect(wake).toBeGreaterThan(lookup);
    expect(admit).toBeGreaterThan(lookup);
    expect(sweep).not.toMatch(
      /claimTournamentFinish|status:\s*'COMPLETING'|status:\s*'COMPLETED'|claimedManager\.stop|tournamentEngines\.delete/
    );
  });

  it('replaces only the exact live dealer generation and inherits every pause first', () => {
    const recoverEngine = sliceMethod(
      managerBase,
      'private async performManagedTableEngineRecovery('
    );
    const firstFence = recoverEngine.indexOf('this.tableEngines.get(tableId) !== engine');
    const prepare = recoverEngine.indexOf('this.prepareManagedTableEngineForPlay(fresh)');
    const replace = recoverEngine.indexOf(
      'this.gameServer.replaceTableEngine(tableId, engine, fresh)'
    );
    const replacementFailure = recoverEngine.indexOf('if (!replaced)');
    const stopCandidate = recoverEngine.indexOf('await fresh.stop()', replacementFailure);
    const postAwaitFence = recoverEngine.indexOf(
      'this.tableEngines.get(tableId) !== engine',
      replace
    );
    const publish = recoverEngine.indexOf('this.tableEngines.set(tableId, fresh)', postAwaitFence);
    expect(firstFence).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(firstFence);
    expect(replace).toBeGreaterThan(prepare);
    expect(replacementFailure).toBeGreaterThan(replace);
    expect(stopCandidate).toBeGreaterThan(replacementFailure);
    expect(postAwaitFence).toBeGreaterThan(replace);
    expect(publish).toBeGreaterThan(postAwaitFence);
  });
});

describe('the startup orphan reconciler is retired behind a one-time write barrier', () => {
  const cleanup = sliceMethod(gameServer, 'private async cleanupStaleData(');

  it('never scans or writes tournament seat or table orphans at process startup', () => {
    expect(cleanup).not.toMatch(/orphanPageSize|releasedOrphanSeats|closedOrphans/);
    expect(cleanup).not.toMatch(/from\('table_seats'\)/);
    expect(cleanup).not.toMatch(/nonterminalTableQuery|liveSeatQuery/);
  });

  it('moves the historical repair into the atomic migration and records exact identities', () => {
    expect(seatExitMigration).toContain(
      'LOCK TABLE public.table_seats IN SHARE ROW EXCLUSIVE MODE'
    );
    expect(seatExitMigration).toContain(
      'CREATE TABLE public.tournament_seat_exit_authority_cutover'
    );
    expect(seatExitMigration).toContain('repaired_seat_ids uuid[] NOT NULL');
    expect(seatExitMigration).toContain('repaired_table_ids uuid[] NOT NULL');
    expect(seatExitMigration).toContain('public.fn_ca_has_committed_tournament_receipt(t.id)');
    expect(seatExitMigration).toContain(
      'terminal seat-exit cutover receipt lost its exact repair state'
    );
  });
});

describe('service-role tournament money still obeys the maintenance freeze', () => {
  it('gates horse rebuys before the service-role RPC', () => {
    const rebuys = sliceMethod(eliminations, 'private async tryTournamentRebuys(');
    const freeze = rebuys.indexOf('if (isMaintenanceFrozen())');
    const profileRead = rebuys.indexOf(".from('profiles')");
    const rpc = rebuys.indexOf("supabase.rpc('process_tournament_rebuy'");
    expect(freeze).toBeGreaterThanOrEqual(0);
    expect(profileRead).toBeGreaterThan(freeze);
    expect(rpc).toBeGreaterThan(freeze);
    expect(rebuys.slice(freeze, rpc)).toMatch(/return \{ rebought, answered \};/);
    expect(rebuys).not.toMatch(/rebuyDecisionGraceUntil|\.setTimeout\(|setTimeout\(/);
  });

  it('gates a normal finish before attempting the terminal receipt', () => {
    const finish = sliceMethod(eliminations, 'finishTournament(winnerId: string): Promise<void>');
    const firstFreeze = finish.indexOf(
      'if (isMaintenanceFrozen() || this.tournamentFinished) return;'
    );
    const terminal = finish.indexOf('requestTournamentTerminalReceipt(');
    expect(firstFreeze).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(firstFreeze);
    expect(finish).not.toMatch(/\.from\('tournaments'\)\s*\.update\(\{[\s\S]*?status:/);
    expect(finish.slice(0, terminal)).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
  });

  it('lets cleanup-only deal retries run while gating every new deal attempt', () => {
    const checkDeal = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
    const pending = checkDeal.indexOf('committedFinalTableDealCleanupPending');
    const cleanup = checkDeal.indexOf(
      'settleFinalTableDeal(this.committedFinalTableDealReceipt)',
      pending
    );
    const firstFreeze = checkDeal.indexOf('isMaintenanceFrozen()', cleanup);
    const boundary = checkDeal.indexOf('completeFinalTableDealAtBoundary(', firstFreeze);
    expect(cleanup).toBeGreaterThan(pending);
    expect(firstFreeze).toBeGreaterThan(cleanup);
    expect(boundary).toBeGreaterThan(firstFreeze);
  });

  it('gates standalone recovery before any field read or atomic receipt request', () => {
    const recover = sliceMethod(
      recovery,
      'export async function recoverStuckCompletingTournaments('
    );
    const loop = recover.indexOf('for (const candidate of stuck');
    const freeze = recover.indexOf('if (isMaintenanceFrozen()) continue;', loop);
    const field = recover.indexOf('readRecoveryField(tournament.id)', freeze);
    const satellite = recover.indexOf('requestSatelliteSettlementReceipt(', freeze);
    const terminal = recover.indexOf('requestTournamentTerminalReceipt(', freeze);
    expect(loop).toBeGreaterThanOrEqual(0);
    expect(freeze).toBeGreaterThan(loop);
    expect(field).toBeGreaterThan(freeze);
    expect(satellite).toBeGreaterThan(field);
    expect(terminal).toBeGreaterThan(field);
    expect(recover).not.toMatch(
      /fn_apply_prize_guarantee|fn_settle_tournament_rake|settleTournamentPlacesAtomically/
    );
  });
});
