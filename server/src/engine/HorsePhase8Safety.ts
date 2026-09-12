import type { HorseTournamentPostflopLedger } from './HorseTournamentPostflop.js';

export const PHASE8_SAFETY = { budgetFailureLimit: 3, silentEligibleLimit: 32 } as const;

/** Local fail-closed state. Restart returns to unpromoted shadow, never active. */
export class HorsePhase8Safety {
  private consecutiveBudgetFailures = 0;
  private eligibleSinceFire = 0;
  disabledReason: string | null = null;
  observe(ledger: HorseTournamentPostflopLedger): void {
    if (this.disabledReason) return;
    if (ledger.fired) this.eligibleSinceFire = 0;
    else if (ledger.eligible) this.eligibleSinceFire++;
    if (ledger.reason === 'illegal_candidate' || ledger.reason === 'conservation_error') {
      this.disabledReason = ledger.reason;
      return;
    }
    if (
      ledger.changed &&
      ledger.candidateCriticalCommitment &&
      !ledger.baselineCriticalCommitment
    ) {
      this.disabledReason = 'critical_commitment_increase';
      return;
    }
    // A cooperative stop inside the 4 ms work deadline is a safe fallback,
    // not a breach of the 5 ms wall-clock limit. Counting it as an overrun
    // permanently disabled otherwise healthy workers after three costly nodes.
    this.consecutiveBudgetFailures =
      ledger.reason === 'budget_exhausted' ? this.consecutiveBudgetFailures + 1 : 0;
    if (this.consecutiveBudgetFailures >= PHASE8_SAFETY.budgetFailureLimit)
      this.disabledReason = 'repeated_budget_breach';
    // A bounded warm-up permits caches and JIT to settle. This is an execution
    // sentinel only; it cannot turn a candidate on or certify its strength.
    if (this.eligibleSinceFire >= PHASE8_SAFETY.silentEligibleLimit)
      this.disabledReason = 'eligible_but_silent';
  }
}
export const liveHorsePhase8Safety = new HorsePhase8Safety();
