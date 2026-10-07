/**
 * THE FIVE LAUNCH OWNER DECISIONS (2026-10-07), decided under CLAUDE.md 10.9
 * on Dan's delegation. docs/changelog/2026-10-07-five-launch-owner-decisions.md.
 *
 *   1. Insurance is not sold on a hi-lo game: the engine never offers it and
 *      the create flow shows no switch for it.
 *   2. A promotion advertises no prize money, because nothing pays one.
 *   3. Every paid finish of a scheduled event is told to its player, horse or
 *      human, in the payment's own transaction.
 *   4. Only a club's owner may write its club card image.
 *   5. A Diamond jackpot hit pays every Diamond it announces; the floors'
 *      leftover goes to the losing hand, as in chips.
 *
 * Each decision is behaviour that a later edit could quietly undo, so each is
 * pinned at the line that carries it. Decisions 2, 3, 5 and the storage half
 * of 4 are database changes; their pins arrive with their migrations.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('1. insurance is not sold on a hi-lo game', () => {
  it('the engine gate refuses a hi-lo hand by the hand variant', () => {
    const runout = read('server/src/engine/ServerTableEngineRunout.ts');
    expect(runout).toMatch(/if \(isHiLoVariant\(controller\.getGameVariant\(\)\)\) return false;/);
    expect(runout).toContain(
      'const insuranceEnabled = insuranceOnThisHand && insuranceContractIsExact(this.handController);'
    );
  });

  it('the create flow shows no Insurance switch on a hi-lo game and sends it off', () => {
    const flow = read('src/components/cash/CashGameCreateFlow.tsx');
    expect(flow).toContain('const insuranceOffered = !isEightOrBetterVariant(variant);');
    expect(flow).toMatch(/\{insuranceOffered && \(\s*<Toggle\s+label="Insurance"/);
    expect(flow).toContain('insurance_enabled: false');
  });
});

describe("4. only a club's owner writes its club card", () => {
  it('the home page only bakes a card for a club the viewer owns', () => {
    const home = read('src/pages/HomePage.tsx');
    expect(home).toMatch(/c\.is_owner === true &&\s+c\.entity_type !== 'union' &&/);
  });
});
