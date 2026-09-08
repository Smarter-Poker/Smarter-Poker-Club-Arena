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
const finishCertificate = code(
  read('../supabase/migrations/20260907210000_completed_means_financially_certified.sql')
);

const sqlFunction = (source: string, name: string): string => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  if (start < 0) throw new Error(`SQL function ${name} is missing`);
  const bodyStart = source.indexOf('AS $function$', start);
  const end = source.indexOf('$function$;', bodyStart);
  if (bodyStart < 0 || end < 0) throw new Error(`SQL function ${name} has no complete body`);
  return source.slice(start, end + '$function$;'.length);
};

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
    const settlement = finish.indexOf('settleTournamentPlacesAtomically(');
    expect(settlement).toBeGreaterThan(-1);
    expect(finish.slice(0, settlement)).toMatch(/FINALIZING\.\.\. candidate winner/);
    expect(finish.slice(0, settlement)).not.toMatch(/COMPLETE!/);
  });

  it('treats a replayed immutable COMPLETED claim as cleanup-only work', () => {
    const replay = sliceMethod(
      finish,
      "if (finishClaim.alreadyCompleted || finishClaim.status === 'COMPLETED')"
    );
    expect(replay).toMatch(/cleanupCommittedTournament\(\)[\s\S]*?return;/);
    expect(replay).not.toMatch(
      /settleTournamentPlacesAtomically|settleSatelliteFinishAtomically|settleTournamentObligation|\.rpc\(/
    );
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
  const checkDeal = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
  const settleDeal = sliceMethod(
    eliminations,
    'settleFinalTableDeal(deal: AtomicFinalTableDealResult): Promise<boolean>'
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
    const assigned =
      recover.match(
        /const cleanupComplete = await closeRecoveredTournamentTablesAndSeats\(t\.id\)/g
      ) ?? [];
    const allCalls = recover.match(/closeRecoveredTournamentTablesAndSeats\(t\.id\)/g) ?? [];
    const guarded =
      recover.match(
        /const cleanupComplete = await closeRecoveredTournamentTablesAndSeats\(t\.id\);\s*if \(!cleanupComplete\) \{/g
      ) ?? [];
    expect(assigned.length).toBeGreaterThan(0);
    expect(assigned).toHaveLength(allCalls.length);
    expect(guarded).toHaveLength(assigned.length);
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

describe('the startup orphan cleanup is evidence-bounded and evidence checked', () => {
  const cleanup = sliceEnclosingBlock(gameServer, 'const orphanPageSize = 500');

  it('keyset-pages only nonterminal table state plus live-seat evidence', () => {
    const candidateRead = cleanup.slice(
      cleanup.indexOf('let nonterminalTableQuery'),
      cleanup.indexOf('const { data: nonterminalTables')
    );
    expect(candidateRead).toMatch(/\.not\('tournament_id', 'is', null\)/);
    expect(candidateRead).toMatch(
      /\.or\([\s\S]*?status\.neq\.closed[\s\S]*?current_players\.neq\.0/
    );
    expect(candidateRead).toMatch(/\.order\('id', \{ ascending: true \}\)/);
    expect(cleanup).toMatch(
      /nonterminalTableQuery = nonterminalTableQuery\.gt\('id', afterTableId\)/
    );
    expect(cleanup).toMatch(
      /\.from\('table_seats'\)[\s\S]*?\.is\('left_at', null\)[\s\S]*?\.order\('id'/
    );
    expect(cleanup).toMatch(/liveSeatQuery = liveSeatQuery\.gt\('id', afterSeatId\)/);
    expect(cleanup).toMatch(
      /\.from\('tables'\)[\s\S]*?\.in\('id', liveSeatTableIds\.slice\(i, i \+ 100\)\)/
    );
    expect(cleanup).not.toMatch(
      /\.select\('id, tournament_id'\)[\s\S]*?\.not\('tournament_id', 'is', null\)[\s\S]*?\.order\('id'/
    );
  });

  it('fails closed and counts only rows that were actually changed', () => {
    expect(cleanup).toMatch(/openTableError[\s\S]*?throw new Error/);
    expect(cleanup).toMatch(/liveSeatListError[\s\S]*?throw new Error/);
    expect(cleanup).toMatch(/liveSeatTableError[\s\S]*?throw new Error/);
    expect(cleanup).toMatch(/freshErr[\s\S]*?continue/);
    expect(cleanup).toMatch(/seatErr[\s\S]*?continue/);
    expect(cleanup).toMatch(
      /\.from\('table_seats'\)[\s\S]*?\.update\(\{ left_at:[\s\S]*?\.is\('left_at', null\)[\s\S]*?\.select\('id'\)/
    );
    expect(cleanup).toMatch(/releasedOrphanSeats \+= releasedSeats\?\.length \?\? 0/);
    expect(cleanup).toMatch(
      /\.update\(\{ status: 'closed', current_players: 0 \}\)[\s\S]*?\.or\([\s\S]*?status\.neq\.closed[\s\S]*?current_players\.neq\.0[\s\S]*?\.select\('id'\)/
    );
    expect(cleanup).toMatch(
      /\.select\('id', \{ count: 'exact', head: true \}\)[\s\S]*?\.is\('left_at', null\)/
    );
    expect(cleanup).toMatch(/seatProof\.error \|\| seatProof\.count !== 0[\s\S]*?continue/);
    expect(cleanup).toMatch(/\.select\('id, status, current_players'\)/);
    expect(cleanup).toMatch(/terminalTables\.length !== batch\.length/);
    expect(cleanup).toMatch(/closedOrphans \+= closedRows\?\.length \?\? 0/);
    expect(cleanup).not.toMatch(/closedOrphans \+= batch\.length/);
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

  it('gates a normal finish before claiming or attempting atomic settlement', () => {
    const finish = sliceMethod(eliminations, 'finishTournament(winnerId: string): Promise<void>');
    const firstFreeze = finish.indexOf('if (isMaintenanceFrozen()) return;');
    const claim = finish.indexOf('claimTournamentFinish(');
    const atomic = finish.indexOf('settleTournamentPlacesAtomically(');
    const lastFreeze = finish.lastIndexOf('if (isMaintenanceFrozen())');
    expect(firstFreeze).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(firstFreeze);
    expect(lastFreeze).toBeGreaterThan(claim);
    expect(atomic).toBeGreaterThan(lastFreeze);
    expect(finish).not.toMatch(/\.from\('tournaments'\)\s*\.update\(\{[\s\S]*?status:/);

    const claimSql = sqlFunction(finishCertificate, 'fn_claim_tournament_finish(');
    const receipt = claimSql.indexOf('INSERT INTO public.tournament_finish_receipts');
    const ownerToken = claimSql.indexOf("set_config('app.tournament_finish_claim'", receipt);
    const status = claimSql.indexOf("SET status = 'COMPLETING'", ownerToken);
    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(ownerToken).toBeGreaterThan(receipt);
    expect(status).toBeGreaterThan(ownerToken);
  });

  it('lets cleanup-only deal retries run while gating every new deal attempt', () => {
    const checkDeal = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
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
    const rake = recover.indexOf("'fn_settle_tournament_rake'", guarantee);
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
