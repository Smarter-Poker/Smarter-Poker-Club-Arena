/**
 * Bubble Protection is one prize-pool-funded base buy-in. The database owns
 * the transfer; the manager may announce it only from an exact receipt for
 * the observed user, place, and configured buy-in amount.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const SOURCE = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
const ELIMINATE = sliceMethod(SOURCE, 'protected async eliminatePlayer');

function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const CODE = executable(ELIMINATE);

describe('bubble protection presentation requires its exact atomic receipt', () => {
  it('uses the dedicated database authority and never a process-side payer', () => {
    expect(CODE).toContain("'fn_settle_tournament_bubble_protection'");
    expect(CODE).toContain('p_observed_bubble_user_id: userId');
    expect(CODE).not.toMatch(/settleTournamentObligation|fn_credit_and_log|credit_player_wallet/);
  });

  it('matches the receipt to the observed user, finishing place, and one base buy-in', () => {
    expect(CODE).toContain('bubble.user_id === userId');
    expect(CODE).toContain('bubblePosition === position');
    expect(CODE).toContain('expectedBubbleAmount = Number((tournament as any).buy_in_amount)');
    expect(CODE).toContain(
      'Math.round(bubbleAmount * 100) === Math.round(expectedBubbleAmount * 100)'
    );
    expect(CODE).toContain('bubble.fully_settled === true');
  });

  it('does not mark or announce Bubble Protection after any malformed receipt', () => {
    const validation = CODE.indexOf('const exactReceipt =');
    const refusal = CODE.indexOf('if (!exactReceipt)', validation);
    const announce = CODE.indexOf("await this.broadcast('bubble_protection_paid'", refusal);
    const mark = CODE.indexOf('this.bubbleProtectionPaid = true', announce);
    expect(validation).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(validation);
    expect(announce).toBeGreaterThan(refusal);
    expect(mark).toBeGreaterThan(announce);
  });
});
