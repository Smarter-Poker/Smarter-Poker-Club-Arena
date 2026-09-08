import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const handController = readFileSync(new URL('./HandController.ts', import.meta.url), 'utf8');
const runout = readFileSync(new URL('./ServerTableEngineRunout.ts', import.meta.url), 'utf8');

describe('Pineapple Monte Carlo has one worker owner', () => {
  it('has no strategy implementation or synchronous fallback in either main-thread path', () => {
    expect(here).toContain('/engine/');
    expect(handController).not.toMatch(/bestPineappleDiscard|HorseLogic\.decideDiscard/);
    expect(runout).not.toMatch(/HorseLogic\.decideDiscard|bestPineappleDiscard/);
    expect(runout).toContain('getLiveHorseDecisionWorker().decideDiscard(');
  });

  it('pins cancellation and exact lifecycle/result fences in the production call site', () => {
    expect(runout).toContain('protected override clearLooseHandTimers(): void');
    expect(runout).toContain('this.pineappleDecisionAbortControllers.get(seat)?.abort()');
    expect(runout).toContain('this.handController !== controller');
    expect(runout).toContain('this.handCount !== handNumber');
    expect(runout).toContain('!this.lifecycleCanMutate()');
    expect(runout).toContain('currentLease.generation === leaseGeneration');
    expect(runout).toContain('result.generation !== generation');
    expect(runout).toContain('result.fence !== fence');
  });

  it('requires a complete exact-flop result set before any Pineapple settlement', () => {
    expect(handController).toContain('decisions.size !== snapshot.players.length');
    expect(handController).toContain('prepared.flopKey !== flopKey');
    expect(handController).toContain("this.reportMissingPineappleRunoutDiscards('finalizeRunout')");
    expect(runout).toContain('controller.preparePineappleRunoutDiscards(snapshot.flop, decisions)');
    expect(runout).toContain(
      'controller.commitPreparedPineappleRunoutDiscards(boards[0].slice(0, 3))'
    );
  });
});
