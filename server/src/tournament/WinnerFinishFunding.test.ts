import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const eliminations = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const finish = sliceMethod(eliminations, 'finishTournament(winnerId: string): Promise<void>');

describe('winner pricing uses confirmed guarantee funding', () => {
  it('re-reads and proves the funded row before deriving any prize', () => {
    const funding = finish.indexOf("this.applyPrizeGuarantee('finish_fallback')");
    const refresh = finish.indexOf(
      ".select('prize_pool, guaranteed_prize, prize_pool_finalized')",
      funding
    );
    const finalizedProof = finish.indexOf('refreshed.prize_pool_finalized !== true', refresh);
    const guaranteeProof = finish.indexOf('refreshedPool + 0.005 < refreshedGuarantee', refresh);
    const receiptMatch = finish.indexOf('Math.abs(refreshedPool - funded) >= 0.005', refresh);
    const price = finish.indexOf('resolvePayoutStructure(', receiptMatch);

    expect(funding).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(funding);
    expect(finalizedProof).toBeGreaterThan(refresh);
    expect(guaranteeProof).toBeGreaterThan(refresh);
    expect(receiptMatch).toBeGreaterThan(refresh);
    expect(price).toBeGreaterThan(Math.max(finalizedProof, guaranteeProof, receiptMatch));
  });

  it('leaves the durable COMPLETING claim retryable when funding has no receipt', () => {
    const refusal = sliceEnclosingBlock(finish, 'if (funded === null)');

    expect(refusal).toContain("'Tournament.finish_guarantee_unconfirmed'");
    expect(refusal).toMatch(/this\.tournamentFinished = false;\s*return;/);
    expect(blankNonCode(refusal)).not.toMatch(
      /resolvePayoutStructure|computePlacePrize|settleTournamentPlacesAtomically/
    );
  });

  it('rejects a stale, underfunded, or unfinalized read-back', () => {
    const refusal = sliceEnclosingBlock(finish, 'refreshed.prize_pool_finalized !== true', 0, 1);

    expect(refusal).toContain('refreshErr');
    expect(refusal).toContain('!refreshed');
    expect(refusal).toContain('!Number.isFinite(refreshedPool)');
    expect(refusal).toContain('refreshed.prize_pool_finalized !== true');
    expect(refusal).toContain('refreshedPool + 0.005 < refreshedGuarantee');
    expect(refusal).toContain('Math.abs(refreshedPool - funded) >= 0.005');
    expect(refusal).toMatch(/this\.tournamentFinished = false;\s*return;/);
  });

  it('uses the same funding receipt path even when the published guarantee is zero', () => {
    const formatCheck = finish.indexOf('const isSatelliteFinish');
    const funding = finish.indexOf("this.applyPrizeGuarantee('finish_fallback')", formatCheck);
    const price = finish.indexOf('resolvePayoutStructure(', funding);
    const gate = finish.slice(formatCheck, funding);

    expect(formatCheck).toBeGreaterThanOrEqual(0);
    expect(funding).toBeGreaterThan(formatCheck);
    expect(price).toBeGreaterThan(funding);
    expect(blankNonCode(gate)).not.toMatch(/guaranteed_prize\s*>|prize_pool\s*>/);
  });
});

describe('winner completion requires an atomic COMPLETED receipt', () => {
  it('has no per-winner application payment or terminal status write', () => {
    const code = blankNonCode(finish);

    expect(code).not.toMatch(/settleTournamentObligation|fn_settle_tournament_obligation/);
    expect(finish).not.toMatch(
      /\.from\('tournaments'\)[\s\S]{0,300}?\.update\(\{[\s\S]{0,200}?status:\s*'COMPLETED'/
    );
  });

  it('accepts the batch only with ok and completed, then runs cleanup-only work', () => {
    const atomic = finish.indexOf('settleTournamentPlacesAtomically(');
    const proof = finish.indexOf('if (!settlement.ok || !settlement.completed)', atomic);
    const durableRead = finish.indexOf('this.readDurableTournamentStatus()', proof);
    const refusalReturn = finish.indexOf('return;', durableRead);
    const cleanup = finish.lastIndexOf('this.cleanupCommittedTournament()');

    expect(atomic).toBeGreaterThanOrEqual(0);
    expect(proof).toBeGreaterThan(atomic);
    expect(durableRead).toBeGreaterThan(proof);
    expect(refusalReturn).toBeGreaterThan(durableRead);
    expect(cleanup).toBeGreaterThan(refusalReturn);
  });

  it('treats a lost response as success only after durable COMPLETED is re-proven', () => {
    const refusal = sliceEnclosingBlock(finish, 'if (!settlement.ok || !settlement.completed)');
    const durableRead = refusal.indexOf('this.readDurableTournamentStatus()');
    const completed = refusal.indexOf("committed.status === 'COMPLETED'", durableRead);
    const cleanup = refusal.indexOf('this.cleanupCommittedTournament()', completed);
    const alert = refusal.indexOf('raiseFinancialAlert(', cleanup);

    expect(durableRead).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThan(durableRead);
    expect(cleanup).toBeGreaterThan(completed);
    expect(alert).toBeGreaterThan(cleanup);
  });
});

describe('fallback winner pricing needs a complete published structure', () => {
  it('does not invent winner-take-all when a funded pool has no usable ladder', () => {
    const condition = finish.indexOf('else if (Number(tournament.prize_pool || 0) > 0)');
    const error = finish.indexOf("'Tournament.payout_structure_unavailable_at_finish'", condition);
    const refusal = sliceEnclosingBlock(
      finish,
      "'Tournament.payout_structure_unavailable_at_finish'"
    );

    expect(condition).toBeGreaterThanOrEqual(0);
    expect(error).toBeGreaterThan(condition);
    expect(refusal).toMatch(/this\.tournamentFinished = false;\s*return;/);
    expect(blankNonCode(refusal)).not.toMatch(
      /winnerStamp|settleTournamentPlacesAtomically|cleanupCommittedTournament/
    );
  });
});

describe('all satellite identities take the seat-award path', () => {
  it('recognizes target, variant and tournament type before any cash pricing', () => {
    const identity = finish.indexOf('const isSatelliteFinish');
    const price = finish.indexOf('resolvePayoutStructure(', identity);

    expect(identity).toBeGreaterThanOrEqual(0);
    expect(finish.slice(identity, price)).toContain("variant ?? '').toLowerCase() === 'satellite'");
    expect(finish.slice(identity, price)).toContain(
      "tournament_type || '').toUpperCase() === 'SATELLITE'"
    );
    expect(finish.slice(identity, price)).toContain('satellite_target_id');
    expect(finish.slice(identity, price)).toContain('if (!isSatelliteFinish)');
  });

  it('routes satellites to the atomic seat finalizer and normal events to place settlement', () => {
    const settlementBranch = sliceEnclosingBlock(finish, 'if (isSatelliteFinish)');

    expect(settlementBranch).toContain('settleSatelliteFinishAtomically(tournament)');
    expect(settlementBranch).toContain('settleTournamentPlacesAtomically(');
    expect(settlementBranch.indexOf('settleSatelliteFinishAtomically(tournament)')).toBeLessThan(
      settlementBranch.indexOf('settleTournamentPlacesAtomically(')
    );
  });
});

describe('finish proves the final roster before atomic settlement', () => {
  it('fails closed when the unresolved-player roster is unreadable', () => {
    const read = finish.indexOf('const { data: stillPlaying, error: stillPlayingErr }');
    const guard = finish.indexOf('if (stillPlayingErr || !Array.isArray(stillPlaying))', read);
    const stamp = finish.indexOf('const { error: winnerStampErr', guard);
    const refusal = finish.slice(guard, stamp);

    expect(read).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(read);
    expect(stamp).toBeGreaterThan(guard);
    expect(refusal).toContain("'Tournament.unresolved_players_read_failed'");
    expect(refusal).toMatch(/this\.tournamentFinished = false;\s*return;/);
  });

  it('accepts only readable, positive-integer, unique finishing positions', () => {
    const read = finish.indexOf('const { data: finishTaken, error: finishTakenErr }');
    const accepted = finish.indexOf('const finishTakenPositions = new Set<number>', read);
    const guard = finish.slice(read, accepted);

    expect(read).toBeGreaterThanOrEqual(0);
    expect(accepted).toBeGreaterThan(read);
    expect(guard).toContain('finishTakenErr');
    expect(guard).toContain('!Array.isArray(finishTaken)');
    expect(guard).toContain('!Number.isInteger(Number(r.position))');
    expect(guard).toContain('Number(r.position) < 1');
    expect(guard).toContain(
      'new Set(finishTaken.map((r) => Number(r.position))).size !== finishTaken.length'
    );
    expect(guard).toContain("'Tournament.finish_positions_unconfirmed'");
    expect(guard).toMatch(/this\.tournamentFinished = false;\s*return;/);
  });

  it('requires each fallback assignment and the post-assignment roster read to succeed', () => {
    const assignment = finish.indexOf('const eliminated = await this.eliminatePlayer(');
    const assignmentGuard = finish.indexOf('if (!eliminated)', assignment);
    const verificationRead = finish.indexOf(
      'const { data: remainingPlayers, error: remainingPlayersErr }',
      assignmentGuard
    );
    const verificationGuard = finish.indexOf(
      'if (remainingPlayersErr || !Array.isArray(remainingPlayers) || remainingPlayers.length > 0)',
      verificationRead
    );
    const stamp = finish.indexOf('const { error: winnerStampErr', verificationGuard);
    const refusal = finish.slice(assignmentGuard, verificationRead);
    const verification = finish.slice(verificationGuard, stamp);

    expect(assignment).toBeGreaterThanOrEqual(0);
    expect(finish.slice(assignment, assignmentGuard)).toContain(', finishNext, true)');
    expect(assignmentGuard).toBeGreaterThan(assignment);
    expect(refusal).toContain("'Tournament.finish_fallback_place_deferred'");
    expect(refusal).toContain('this.requestUrgentEliminationSweepAfter(');
    expect(verificationRead).toBeGreaterThan(assignmentGuard);
    expect(verificationGuard).toBeGreaterThan(verificationRead);
    expect(verification).toContain("'Tournament.finish_players_unresolved'");
    expect(verification).toMatch(/this\.tournamentFinished = false;/);
    expect(verification).toContain('this.requestUrgentEliminationSweepAfter(');
    expect(verification).toMatch(/return;/);
    expect(stamp).toBeGreaterThan(verificationGuard);
  });
});

describe('winner entitlement write has exact cardinality', () => {
  it('requires exactly one winner row before any settlement can run', () => {
    const stamp = finish.indexOf('const { error: winnerStampErr, count: winnerStampCount }');
    const guard = finish.indexOf('if (winnerStampErr || winnerStampCount !== 1)', stamp);
    const normalize = finish.indexOf("'fn_normalize_tournament_final_standings'", guard);
    const write = finish.slice(stamp, guard);
    const refusal = finish.slice(guard, normalize);

    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(write).toContain("{ count: 'exact' }");
    expect(guard).toBeGreaterThan(stamp);
    expect(refusal).toContain("'Tournament.winner_row_stamp_failed'");
    expect(refusal).toMatch(/this\.tournamentFinished = false;\s*return;/);
    expect(normalize).toBeGreaterThan(guard);
  });
});
