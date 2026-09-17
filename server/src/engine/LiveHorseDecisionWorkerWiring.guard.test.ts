import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

const turns = read('./ServerTableEngineTurns.ts');
const base = read('./ServerTableEngineBase.ts');
const handHistory = read('../services/supabase/handHistory.ts');
const client = read('./horseDecision/client.ts');
const workerRuntime = read('./horseDecision/workerRuntime.ts');

describe('live horse decisions stay outside the table event loop', () => {
  it('routes fast and deep decisions through the worker with one exact turn fence', () => {
    const schedule = sliceMethod(turns, '  protected scheduleHorseAction(');

    expect(schedule).not.toContain('HorseLogic.decide(');
    expect(schedule).not.toContain('saveFastRandom(');
    expect(schedule).not.toContain('restoreFastRandom(');
    expect(schedule).toContain('getLiveHorseDecisionWorker().decideFast(');
    expect(schedule).toContain('.decideDeep(');
    expect(schedule).toContain('decisionTimeMs');
    expect(schedule).toContain('currentLease.generation !== leaseGeneration');
    expect(schedule).toContain('fastResult.generation !== turnToken');
    expect(schedule).toContain('fastResult.fence !== fence');
    expect(schedule).toContain('deepResult.generation !== turnToken');
    expect(schedule).toContain('deepResult.fence !== fence');
  });

  it('counts queue and compute latency inside the chosen visible think time', () => {
    const schedule = sliceMethod(turns, '  protected scheduleHorseAction(');

    expect(schedule).toContain('const remainingThinkMs = Math.min(');
    expect(schedule).toContain('Math.max(0, thinkTimeMs - (Date.now() - decisionTimeMs))');
    expect(schedule).toContain('Math.max(0, protectedDeadlineMs - Date.now() - 100)');
    expect(schedule).toContain('fastResult.governorScale');
    expect(schedule).toContain('}, remainingThinkMs)');
  });

  it('cancels the request, deep delay and action timer as one turn-owned unit', () => {
    const cancel = sliceMethod(base, '  protected cancelHorseDecisionWork()');
    const clearLoose = sliceMethod(base, '  protected clearLooseHandTimers()');
    const clearTurn = sliceMethod(turns, '  protected clearTurnTimer()');

    expect(cancel).toContain('this.horseTurnToken += 1');
    expect(cancel).toContain('this.horseDecisionAbortController?.abort()');
    expect(cancel).toContain('clearTimeout(this.horseSecondLookTimer)');
    expect(cancel).toContain('clearTimeout(this.horseActionTimer)');
    expect(clearLoose).toContain('this.cancelHorseDecisionWork()');
    expect(clearTurn).toContain('this.cancelHorseDecisionWork()');
  });

  it('queues completed-hand learning through the same FIFO without holding settlement', () => {
    expect(handHistory).not.toContain('HorseMind.observeHandComplete(');
    expect(handHistory).not.toContain('await getLiveHorseDecisionWorker().observeCompletedHand({');
    expect(handHistory).toContain(
      'const observation = getLiveHorseDecisionWorker().observeCompletedHand({'
    );
    expect(handHistory).toContain('void observation.catch((error) =>');
    expect(handHistory).toContain(
      "reportError(error, 'HandHistory.horse_mind_observation_failed')"
    );
    expect(workerRuntime).toContain("request.type === 'OBSERVE_COMPLETED_HAND'");
    expect(workerRuntime).toContain('this.executeObservation(request)');
    expect(workerRuntime).toContain('HorseMind.observeHandComplete(');
  });

  it('commits speculative mind plans only after the intended wager lands', () => {
    const schedule = sliceMethod(turns, '  protected scheduleHorseAction(');

    expect(workerRuntime).toContain('this.deps.captureDecisionEffects(() =>');
    expect(workerRuntime).toContain('decision: captured.value');
    expect(workerRuntime).toContain('effects: captured.effects');
    expect(workerRuntime).toContain('this.deps.applyDecisionEffects(request.effects)');
    expect(schedule).toContain('worker.runWithDispatchBarrier(() =>');
    expect(schedule).toContain('intendedApplied = applied');
    expect(schedule).toContain('fastResult.effects.length > 0');
    expect(schedule).toContain("action === 'bet' || action === 'raise'");
    expect(schedule).toContain('.commitDecisionEffects(');
    expect(schedule.indexOf('intendedApplied = applied')).toBeLessThan(
      schedule.indexOf('.commitDecisionEffects(')
    );
    expect(schedule.indexOf('.commitDecisionEffects(')).toBeLessThan(
      schedule.indexOf('if (!applied)')
    );
  });

  it('has no synchronous fallback or replacement-worker path', () => {
    expect(client.match(/new Worker\(/g) ?? []).toHaveLength(1);
    expect(client).not.toContain('HorseLogic.decide(');
    expect(client).not.toContain('respawn');
    expect(client).toContain("this.phase = 'failed'");
    expect(client).toContain('this.terminateWorker()');
  });
});
