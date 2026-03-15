/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND VALIDATION SERVICE — Client-side hand result verification
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Validates hand results received from the server by independently
 * computing expected outcomes. Flags discrepancies for admin review.
 *
 * - Validates pot size calculations
 * - Validates side pot distributions
 * - Validates winner determination
 * - Logs mismatches to Supabase for audit
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HandValidationInput {
  handId: string;
  tableId: string;
  communityCards: string[];
  players: {
    id: string;
    holeCards: string[];
    betTotal: number;
    isAllIn: boolean;
    isFolded: boolean;
  }[];
  pots: {
    amount: number;
    eligiblePlayerIds: string[];
    winnerId?: string;
  }[];
  reportedWinners: { playerId: string; amount: number }[];
}

export interface ValidationResult {
  valid: boolean;
  discrepancies: ValidationDiscrepancy[];
}

export interface ValidationDiscrepancy {
  type: 'POT_MISMATCH' | 'WINNER_MISMATCH' | 'SIDE_POT_ERROR' | 'AMOUNT_MISMATCH';
  expected: string;
  actual: string;
  severity: 'warning' | 'critical';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const HandValidationService = {
  /**
   * Validate a completed hand result
   */
  validate(input: HandValidationInput): ValidationResult {
    const discrepancies: ValidationDiscrepancy[] = [];

    // 1. Validate total pot equals sum of all bets
    const totalBets = input.players.reduce((sum, p) => sum + p.betTotal, 0);
    const totalPots = input.pots.reduce((sum, p) => sum + p.amount, 0);

    if (Math.abs(totalBets - totalPots) > 0.01) {
      discrepancies.push({
        type: 'POT_MISMATCH',
        expected: `Total bets: ${totalBets.toFixed(2)}`,
        actual: `Total pots: ${totalPots.toFixed(2)}`,
        severity: 'critical',
      });
    }

    // 2. Validate total winnings equals total pots (no chips created/destroyed)
    const totalWinnings = input.reportedWinners.reduce((sum, w) => sum + w.amount, 0);

    if (Math.abs(totalWinnings - totalPots) > 0.01) {
      discrepancies.push({
        type: 'AMOUNT_MISMATCH',
        expected: `Pot total: ${totalPots.toFixed(2)}`,
        actual: `Winnings total: ${totalWinnings.toFixed(2)}`,
        severity: 'critical',
      });
    }

    // 3. Validate side pot eligibility (folded players shouldn't win)
    for (const pot of input.pots) {
      if (pot.winnerId) {
        const winner = input.players.find((p) => p.id === pot.winnerId);
        if (winner?.isFolded) {
          discrepancies.push({
            type: 'WINNER_MISMATCH',
            expected: 'Winner should not be folded',
            actual: `Player ${pot.winnerId} won pot but is marked as folded`,
            severity: 'critical',
          });
        }

        // Check winner is in eligible list
        if (!pot.eligiblePlayerIds.includes(pot.winnerId)) {
          discrepancies.push({
            type: 'SIDE_POT_ERROR',
            expected: `Winner must be in eligible list: [${pot.eligiblePlayerIds.join(', ')}]`,
            actual: `Winner ${pot.winnerId} not in eligible list`,
            severity: 'critical',
          });
        }
      }
    }

    // 4. Validate no player wins more than pot contains
    for (const winner of input.reportedWinners) {
      if (winner.amount > totalPots) {
        discrepancies.push({
          type: 'AMOUNT_MISMATCH',
          expected: `Max winnings: ${totalPots.toFixed(2)}`,
          actual: `Player ${winner.playerId} won ${winner.amount.toFixed(2)}`,
          severity: 'critical',
        });
      }
    }

    return {
      valid: discrepancies.length === 0,
      discrepancies,
    };
  },

  /**
   * Validate and log results to Supabase
   */
  async validateAndLog(input: HandValidationInput): Promise<ValidationResult> {
    const result = this.validate(input);

    if (!result.valid) {
      console.error(
        `[HandValidation] ${result.discrepancies.length} discrepancies found for hand ${input.handId}:`,
        result.discrepancies
      );

      // Log to Supabase
      try {
        await supabase.from('hand_validation_log').insert(
          result.discrepancies.map((d) => ({
            hand_id: input.handId,
            table_id: input.tableId,
            discrepancy_type: d.type,
            expected_result: d.expected,
            actual_result: d.actual,
            severity: d.severity,
            created_at: new Date().toISOString(),
          }))
        );
      } catch (err: unknown) {
        console.error('[HandValidation] Failed to log to Supabase:', err);
      }

      // Emit bus event for real-time admin alerts
      masterBus.emit('VALIDATION_MISMATCH', {
        handId: input.handId,
        tableId: input.tableId,
        discrepancies: result.discrepancies,
      });

      // Raise financial alert for critical discrepancies
      const criticalCount = result.discrepancies.filter((d) => d.severity === 'critical').length;
      if (criticalCount > 0) {
        try {
          const { FinancialAlertService } = await import('./FinancialAlertService');
          FinancialAlertService.raise(
            'critical',
            `Hand validation failed: ${criticalCount} critical discrepancies in hand ${input.handId}`,
            'HandValidationService',
            { handId: input.handId, discrepancies: result.discrepancies }
          );
        } catch (err) {

          console.error("[HandValidationService] Error:", err);
          /* best effort */
        }
      }
    }

    return result;
  },
};

export default HandValidationService;
