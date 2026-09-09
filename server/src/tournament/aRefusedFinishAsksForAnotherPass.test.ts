/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REFUSED FINISH ASKS FOR ANOTHER PASS, AND SOMEBODY HEARS IT (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `finishTournament` fails closed in about thirty-five places, and every one of
 * them ends by releasing `this.tournamentFinished` under a comment promising
 * that "the next elimination sweep can resume the durable COMPLETING claim and
 * prepared obligations."
 *
 * There was no next sweep. A sweep is woken by an elimination, and
 * `finishTournament` is only ever reached once the field is down to its last
 * player: no hand left to deal, nobody left to bust, nothing left to wake it.
 * The release was a request nothing listened for, so a refusal - the hourly
 * maintenance freeze, a refused claim, an unreadable row, a transport blip -
 * stopped the event where it stood with its winner unpaid.
 *
 * This is CLAUDE.md 10.86 in its purest form: a component answering
 * confidently ("the next sweep will resume it") about something it had no way
 * to know. The pins below are the listener.
 *
 * FOUND BY READING, NOT BY WATCHING. No production incident is attributed to
 * this. The changelog beside it
 * (`docs/changelog/2026-09-09-a-refused-finish-asks-for-another-pass.md`)
 * carries a retraction of the ten-tournament "backlog" its first draft claimed:
 * that was one snapshot of a population which turns over all day, and a
 * re-read seven minutes later found nine of the ten already finished. The
 * defect stands on the control flow. The evidence for it does not need to be
 * invented, and these pins do not depend on it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const ELIM = readFileSync(resolve(__dirname, './TournamentManagerEliminations.ts'), 'utf8');

const REARM = sliceMethod(ELIM, 'rearmIfTheFinishWasRefused(): void');
const FINISH = sliceMethod(ELIM, 'finishTournament(winnerId: string): Promise<void>');

describe('a refused finish asks for another pass', () => {
  it('the windows under test are real', () => {
    expect(REARM.length).toBeGreaterThan(40);
    expect(FINISH.length).toBeGreaterThan(2000);
  });

  it('the winner path re-arms after the finish returns', () => {
    // The block is `if (winner) { ... }` in runEliminationSweep. Bounded by its
    // braces, so a comment added inside it can never push the call out of view.
    const block = sliceEnclosingBlock(ELIM, 'await this.finishTournament(winner.user_id);');
    expect(block).toContain('await this.finishTournament(winner.user_id);');
    expect(block, 'a refused finish must be retried, not dropped').toContain(
      'this.rearmIfTheFinishWasRefused();'
    );
  });

  it('the all-busted-simultaneously path re-arms too', () => {
    const block = sliceEnclosingBlock(ELIM, 'await this.finishTournament(lastEliminated.user_id);');
    expect(block).toContain('await this.finishTournament(lastEliminated.user_id);');
    expect(block).toContain('this.rearmIfTheFinishWasRefused();');
  });

  it('a finish that SUCCEEDED never re-arms, or a completed event sweeps forever', () => {
    // The flag is the only signal there is: still set means the finish owns the
    // event (or completed it), cleared means it gave the event back.
    expect(REARM).toMatch(/if \(this\.tournamentFinished\) return;/);
    const afterGuard = REARM.slice(REARM.indexOf('if (this.tournamentFinished) return;'));
    expect(afterGuard).toContain('this.requestUrgentEliminationSweepAfter(');
    expect(afterGuard).toContain('UNRESOLVED_BUST_RETRY_MS');
  });

  it('the retry uses the sweep scheduler, which keeps one pending wake per tournament', () => {
    // Not a bare setTimeout. `wakeUrgentAfter` coalesces, so an exit that
    // already re-armed (the maintenance-freeze branch does) cannot stack timers
    // with this one.
    expect(REARM).not.toMatch(/setTimeout\(/);
    expect(REARM).not.toMatch(/setInterval\(/);
  });

  it('releases the centralized guard only for a proven refusal', () => {
    // Atomic completion has one classified failure boundary instead of the old
    // collection of application-side payout exits. A definitive database
    // refusal gives the finish back to the scheduler; an unknown outcome keeps
    // ownership stopped so a possibly committed settlement is never replayed.
    expect(FINISH).toMatch(
      /const releaseFinishGuard = \(\): void => \{[\s\S]*?this\.tournamentFinished = false;[\s\S]*?this\.requestUrgentEliminationSweepAfter\(/
    );

    const ordinaryFailure = FINISH.slice(
      FINISH.indexOf('let receipt: VerifiedTournamentCompletionReceipt;')
    );
    expect(ordinaryFailure).toMatch(
      /const provenRefusal = settlementErr instanceof TerminalSettlementRefusedError;[\s\S]*?const outcomeUnknown =[\s\S]*?TerminalSettlementOutcomeUnknownError \|\| !provenRefusal;[\s\S]*?if \(provenRefusal\) releaseFinishGuard\(\);[\s\S]*?if \(!provenRefusal\) \{[\s\S]*?this\.fenceUnknownTerminalOutcome\('Tournament\.atomic_finish_manager_stop_failed'\);[\s\S]*?\}/
    );
  });

  it('the freeze branch defers rather than dropping the finish on the floor', () => {
    // CLAUDE.md 13 rule 4: a deadline is thawed, not burned. The break holds the
    // platform for five minutes of every hour, so a bare `return` here loses
    // roughly one finish in twelve.
    const freeze = sliceEnclosingBlock(FINISH, 'the platform is frozen for the maintenance break');
    expect(freeze).toContain('this.requestUrgentEliminationSweepAfter(');
  });
});
