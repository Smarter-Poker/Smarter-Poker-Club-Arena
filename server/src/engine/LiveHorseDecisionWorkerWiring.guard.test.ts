import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  blankNonCode,
  sliceCall,
  sliceMethod,
  sliceStatement,
} from '../testHelpers/sourceWindow.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

const turns = read('./ServerTableEngineTurns.ts');
const base = read('./ServerTableEngineBase.ts');
const handHistory = read('../services/supabase/handHistory.ts');
const client = read('./horseDecision/client.ts');
const workerRuntime = read('./horseDecision/workerRuntime.ts');

/** Comments only: strings and template literals stay, so a positive pin cannot
 *  be satisfied by prose while a negative one still reads real code. */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** Every reserved word that is a value on its own. A field bound to one of
 *  these, or to a number, or to an emptied string or collection, measured
 *  nothing. */
const VALUE_KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

/** True when the expression mentions at least one binding — a parameter, a
 *  local, a call — rather than being a constant the caller chose. */
const namesSomething = (expression: string): boolean =>
  (expression.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).some((word) => !VALUE_KEYWORDS.has(word));

/** The top-level `field: value` pairs of the single object argument, read from
 *  a copy with comments and string bodies blanked, so the split follows real
 *  punctuation and a string cannot smuggle in an identifier. Shorthand fields
 *  are their own value. */
const observationFields = (call: string): Array<[string, string]> => {
  const blanked = blankNonCode(call);
  const open = blanked.indexOf('{');
  const close = blanked.lastIndexOf('}');
  if (open < 0 || close < open) throw new Error('observationFields: no object argument');
  const body = blanked.slice(open + 1, close);
  const pairs: Array<[string, string]> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    if (i < body.length && !(c === ',' && depth === 0)) continue;
    const part = body.slice(start, i).trim();
    start = i + 1;
    if (!part) continue;
    const colon = part.indexOf(':');
    pairs.push(
      colon < 0 ? [part, part] : [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
    );
  }
  return pairs;
};

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

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  THE HORSE LEARNS FROM THE HAND IT WAS DEALT, NOT FROM A CONSTANT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * BUG #1 of the 2026-03-11 horse report, re-verified 2026-09-24. The engine
   * of the day handed the brain a per-seat result it had never computed —
   * chipDelta 0, showedCards true, folded false, invested 0, on every seat of
   * every hand — so the reads that shape a horse were trained on a hand that
   * did not happen. Nothing went red, because nothing asserted that any of
   * those numbers came from anywhere. The engine, the adapter and that call
   * site are all gone; the observation below carries the committed hand's own
   * accepted actions and its own showdown.
   *
   * What the original defect lacked is the second half of this test: every
   * field of the observation has to bind to an expression that NAMES
   * something. A measurement written into the call as a literal is a red test
   * here rather than a silently worse horse, and that holds for fields nobody
   * has added yet.
   */
  it('observes the hand that was dealt, never a constant standing in for it', () => {
    const call = sliceCall(handHistory, 'observeCompletedHand({');
    const code = withoutComments(call);

    // Each field says where it came from.
    expect(code).toContain('handKey,');
    expect(code).toContain('committedHandId: handId,');
    expect(code).toContain('actions: acceptedActions,');
    expect(code).toContain('bigBlind: params.bigBlind,');
    expect(code).toContain('showdown: params.showdownReveal ?? null,');
    expect(code).toMatch(/scope: readScopeOf\(/);
    expect(code).toContain('generation: params.handNumber,');

    // ...and the two locals it leans on are read off the hand, not chosen here.
    const key = withoutComments(sliceStatement(handHistory, 'const handKey ='));
    expect(key).toContain('params.tableId');
    expect(key).toContain('params.handNumber');
    const accepted = withoutComments(sliceStatement(handHistory, 'const acceptedActions ='));
    expect(accepted).toContain('params.actions.map(');

    // No field of the observation is a literal. This is the part that would
    // have caught `chipDelta: 0, showedCards: true, folded: false`.
    const fields = observationFields(call);
    expect(fields.length).toBeGreaterThan(5);
    for (const [name, value] of fields) {
      expect(
        namesSomething(value),
        `observation field "${name}" is written into the call as ${JSON.stringify(
          value
        )} instead of being read off the hand`
      ).toBe(true);
    }
  });

  it('commits speculative mind plans only after the intended wager lands', () => {
    const schedule = sliceMethod(turns, '  protected scheduleHorseAction(');

    expect(workerRuntime).toContain('this.deps.captureDecisionEffects(() =>');
    expect(workerRuntime).toContain('decision: captured.value');
    expect(workerRuntime).toContain(
      'horseReferenceWagerWasRetained(captured.value) ? captured.effects : []'
    );
    const commit = sliceMethod(workerRuntime, '  private executeEffectCommit(');
    // The later IPC request may only select the exact batch this worker issued;
    // it cannot supply replacement plan records or apply a duplicate twice.
    expect(commit).toContain('const issued = this.issuedPlanBatches.get(key)');
    expect(commit).toContain('horsePlanBatchBindingKey(request.planBinding) !== issued.bindingKey');
    expect(commit).toContain('horseDecisionEffectsKey(request.effects) !== issued.effectsKey');
    expect(commit).toContain("if (issued.state !== 'applied')");
    expect(commit).toContain('this.deps.applyDecisionEffects(issued.effects)');
    expect(commit).not.toContain('this.deps.applyDecisionEffects(request.effects)');
    expect(schedule).toContain('worker.runWithDispatchBarrier(() =>');
    expect(schedule).toContain('intendedApplied = applied');
    expect(schedule).toMatch(
      /intendedApplied\s*&&\s*decision === fastResult\.decision\s*&&\s*exactWagerAccepted\s*&&/
    );
    // Empty or unissued batches report their outcome instead of entering COMMIT.
    // The nonempty issued branch remains under the exact original FAST wager gate.
    expect(schedule).toMatch(
      /if \(fastResult\.effects\.length === 0\)\s*\{\s*noteFire\('phase15_plan_accepted_no_effects'\);\s*\} else if \(fastResult\.planIssueDisposition !== 'issued'\)\s*\{\s*noteFire\(`phase15_plan_accepted_\$\{fastResult\.planIssueDisposition\}`\);\s*\} else\s*void worker\.commitDecisionEffects\(fastResult\)/
    );
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
