import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  horseDecisionReceiptIsValid,
  horseDecisionReceiptRefusal,
  type HorseDecisionReceiptContext,
} from './responseValidation.js';
import type { HorseDecision } from '../../types.js';

const captured = JSON.parse(
  readFileSync(new URL('./fixtures/plo6-river-call-receipt.json', import.meta.url), 'utf8')
) as { context: HorseDecisionReceiptContext; decision: HorseDecision };
const fixture = () => structuredClone(captured);

describe('PLO6 river raise-to-call receipt admission', () => {
  it('admits the actual synthetic worker graph and its priced call without rewriting it', () => {
    const { context, decision } = fixture();
    const before = structuredClone(decision);
    expect(horseDecisionReceiptRefusal(decision, 'plo6', context)).toBeNull();
    expect(horseDecisionReceiptIsValid(decision, 'plo6', context)).toBe(true);
    expect(decision).toEqual(before);
  });

  it('retains the context-free legacy reader for the same PLO6 graph', () => {
    expect(horseDecisionReceiptRefusal(fixture().decision, 'plo6')).toBeNull();
  });

  it('also admits a priced cap from a raise with chips left behind', () => {
    const { context, decision } = fixture();
    context.player.stack = 1000;
    context.gameState.legalActions = ['fold', 'call', 'raise', 'all_in'];
    for (const p of context.gameState.players)
      if (p.user_id === context.player.user_id) p.stack = 1000;
    for (const t of decision.policyGraph!.transitions) {
      if (t.before?.action === 'all_in') t.before = { action: 'raise', amount: 400 };
      if (t.after.action === 'all_in') t.after = { action: 'raise', amount: 400 };
    }
    expect(horseDecisionReceiptRefusal(decision, 'plo6', context)).toBeNull();
  });

  it('refuses an unpriced legacy call even when the graph reconciles', () => {
    const { decision } = fixture();
    delete decision.amount;
    decision.policyGraph!.finalAction.amount = null;
    for (const t of decision.policyGraph!.transitions) {
      if (t.before?.action === 'call') t.before.amount = null;
      if (t.after.action === 'call') t.after.amount = null;
    }
    expect(horseDecisionReceiptRefusal(decision, 'plo6')).toBe('policy_graph');
  });

  it.each(['nlh', 'plo4', 'plo5', 'plo8'])('refuses the transition in %s', (variant) => {
    const { context, decision } = fixture();
    context.gameState.gameVariant = variant;
    expect(horseDecisionReceiptRefusal(decision, variant, context)).toBe('policy_graph');
  });

  it.each(['flop', 'turn', 'preflop'] as const)('refuses the transition on the %s', (stage) => {
    const { context, decision } = fixture();
    context.gameState.stage = stage;
    expect(horseDecisionReceiptRefusal(decision, 'plo6', context)).toBe('policy_graph');
  });

  it.each([
    'multiple_boards',
    'missing_board',
    'foreign_variant',
    'wrong_price',
    'no_call',
    'short_stack',
    'wrong_hole_count',
  ])('refuses a request outside the owner rule: %s', (fault) => {
    const { context, decision } = fixture();
    if (fault === 'multiple_boards') context.gameState.boardCount = 2;
    if (fault === 'missing_board') context.gameState.communityCards.pop();
    if (fault === 'foreign_variant') context.gameState.gameVariant = 'nlh';
    if (fault === 'wrong_price') context.gameState.toCall! -= 1;
    if (fault === 'no_call') context.gameState.legalActions = ['fold', 'all_in'];
    if (fault === 'short_stack') context.player.stack = context.gameState.toCall!;
    if (fault === 'wrong_hole_count') context.player.cards.pop();
    expect(horseDecisionReceiptRefusal(decision, 'plo6', context)).toBe('policy_graph');
  });
});
