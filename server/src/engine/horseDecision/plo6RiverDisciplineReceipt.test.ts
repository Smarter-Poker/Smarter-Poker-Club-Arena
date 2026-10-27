import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { HorseMind } from '../HorseMind.js';
import { HORSE_POLICY_GRAPH_VERSION, HORSE_POLICY_ORDER } from '../HorsePolicyGraph.js';
import { horseDecisionReceiptIsValid } from './responseValidation.js';
import {
  defaultHorseDecisionWorkerDependencies as defaults,
  HorseDecisionWorkerRuntime,
} from './workerRuntime.js';
import type { HorseDecisionWorkerResponse, FastHorseDecisionRequest } from './protocol.js';
import type { HorseDecision } from '../../types.js';

afterEach(() => HorseMind.reset());

function graphDecision(before: string, after: string, amount: number | null = 9): any {
  let prior: any = null;
  const transitions = HORSE_POLICY_ORDER.map((node) => {
    const next =
      node === 'wager_rules' || node === 'timing'
        ? { action: after, amount }
        : { action: before, amount: before === 'raise' ? 61 : null };
    const row = {
      node,
      before: prior,
      after: next,
      changed: prior !== null && (prior.action !== next.action || prior.amount !== next.amount),
      elapsedMs: 0,
    };
    prior = next;
    return row;
  });
  return {
    action: after,
    ...(amount === null ? {} : { amount }),
    thinkTime: 0,
    policyGraph: { version: HORSE_POLICY_GRAPH_VERSION, transitions, finalAction: prior },
  };
}

describe('PLO6 river discipline is a valid final wager-rule call', () => {
  it('accepts a raise or covering shove reduced to the owed call', () => {
    for (const prior of ['raise', 'all_in'])
      expect(horseDecisionReceiptIsValid(graphDecision(prior, 'call'), 'plo6')).toBe(true);
  });

  it('does not allow a call downgrade in another game', () => {
    for (const variant of ['nlh', 'plo4', 'plo5', 'plo8', 'flh', 'short_deck', 'pineapple'])
      expect(horseDecisionReceiptIsValid(graphDecision('raise', 'call'), variant)).toBe(false);
  });

  it('refuses a free, unsized, or unrelated final-rule call and a final check', () => {
    for (const value of [
      graphDecision('raise', 'call', 0),
      graphDecision('raise', 'call', null),
      graphDecision('check', 'call'),
      graphDecision('bet', 'call'),
      graphDecision('raise', 'check', null),
    ])
      expect(horseDecisionReceiptIsValid(value, 'plo6')).toBe(false);
  });

  it('replays the real worker request whose river raise became a call', async () => {
    // Synthetic closed-hand fixture captured while reproducing the full-suite
    // failure. No production account, cards, financial write or service is used.
    const request = JSON.parse(
      readFileSync(
        new URL('./fixtures/plo6-river-discipline-call.request.json', import.meta.url),
        'utf8'
      )
    ) as FastHorseDecisionRequest;
    const messages: HorseDecisionWorkerResponse[] = [];
    const worker = new HorseDecisionWorkerRuntime((m) => messages.push(m), {
      ...defaults,
      startServices: async () => defaults.workerReadiness(),
      stopServices: async () => {},
      journalEnabled: () => false,
      journalAcceptedHand: () => {},
      journalLifecycle: () => {},
      noteFeature: () => {},
      noteDecision: () => {},
    });
    await worker.start();
    worker.receive(request);
    await worker.drain();
    const result = messages.find((m) => m.type === 'FAST_RESULT') as
      | { decision: HorseDecision }
      | undefined;
    expect(result).toBeDefined();
    const decision = result!.decision;
    const finalRule = decision.policyGraph!.transitions.find((t) => t.node === 'wager_rules')!;
    expect(finalRule.before?.action).toBe('raise');
    expect(finalRule.after).toEqual({ action: 'call', amount: 9 });
    expect(decision.action).toBe('call');
    expect(horseDecisionReceiptIsValid(decision, 'plo6')).toBe(true);
    expect(
      horseDecisionReceiptIsValid(decision, 'plo6', {
        player: request.player,
        gameState: request.gameState,
      })
    ).toBe(true);
  });
});
