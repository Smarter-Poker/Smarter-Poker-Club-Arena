import { describe, expect, it } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { jointPolicyFixture } from './multiway/JointRangeFixture.test-support.js';
import { seedFastRandom, saveFastRandom } from './HorseEval.js';
import { readFileSync } from 'node:fs';
import {
  HORSE_POLICY_REGISTRY,
  horsePolicyRegistration,
  horsePolicyOwnership,
  horsePolicyOwnershipMatches,
} from './HorsePolicyRegistry.js';
import { KNOWN_VARIANTS } from './VariantRules.js';
import type { HorseDecision } from '../types.js';
import { horseDecisionReceiptIsValid } from './horseDecision/responseValidation.js';

describe('Horse policy registration at the actual decision boundary', () => {
  it('reconciles the actual table creator and engine rule registry with runtime owners', () => {
    const creator = readFileSync(
      new URL('../../../src/pages/CreateTablePage.tsx', import.meta.url),
      'utf8'
    );
    const gameTypes = creator.split('const GAME_TYPES: GameType[] = [')[1]?.split('\n];')[0];
    expect(gameTypes).toBeTruthy();
    const created = [...gameTypes!.matchAll(/\bid: '([a-z0-9_]+)'/g)].map((m) => m[1]);
    const registered = Object.keys(HORSE_POLICY_REGISTRY).sort();
    expect(created.sort()).toEqual(registered);
    expect([...KNOWN_VARIANTS].sort()).toEqual(registered);
    expect(Object.isFrozen(HORSE_POLICY_REGISTRY)).toBe(true);
  });
  it.each([null, undefined, '', '__proto__', 'constructor', 'PLO4', 1, {}])(
    'does not normalize or inherit policy identifiers: %j',
    (variant) => {
      expect(horsePolicyRegistration(variant)).toBeNull();
    }
  );
  it.each(['PLO4', 'unsupported_game', null, undefined])(
    '%s never silently uses another variant policy',
    (variant) => {
      const { hero, state } = jointPolicyFixture('plo4', 1, 'cash', 'preflop');
      state.gameVariant = variant as any;
      seedFastRandom(913);
      const before = saveFastRandom();
      const result = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        { mind: false, telemetry: false }
      );
      expect(result.policyFallback).toBe('brain_exception');
      expect(result.policyGraph).toBeUndefined();
      expect(saveFastRandom()).toBe(before);
    }
  );
  it.each(Object.keys(HORSE_POLICY_REGISTRY))(
    '%s invokes its registered owner on each betting street',
    (raw) => {
      const variant = raw as keyof typeof HORSE_POLICY_REGISTRY;
      for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
        const { hero, state } = jointPolicyFixture(variant, 1, 'cash', street);
        state.dealerSeat = hero.seat;
        seedFastRandom(715);
        const decision = HorseLogic.decide(
          hero,
          state,
          'balanced',
          {},
          {
            mind: false,
            telemetry: false,
            decisionTimeMs: 0,
            phase10EvidenceMode: true,
            phase11EvidenceMode: true,
            phase12EvidenceMode: true,
            phase13Joint: 'off',
          }
        );
        expect(decision.policyFallback, `${variant}:${street}`).toBeUndefined();
        expect(decision.policyOwnership).toMatchObject({
          variant,
          ...HORSE_POLICY_REGISTRY[variant],
        });
        expect(decision.policyOwnership?.mode).toBe(variant === 'nlh' ? 'reference' : 'shadow');
        expect(horsePolicyOwnershipMatches(decision)).toBe(true);
        expect(horseDecisionReceiptIsValid(structuredClone(decision))).toBe(true);
        const receipts = [
          decision.plo4Policy,
          decision.omahaVariantPolicy,
          decision.remainingVariantPolicy,
        ].filter(Boolean);
        expect(receipts).toHaveLength(variant === 'nlh' ? 0 : 1);
      }
    }
  );
  it.each(['plo4', 'plo5', 'short_deck'] as const)(
    '%s records explicit disable without pretending a pack ran',
    (variant) => {
      const { hero, state } = jointPolicyFixture(variant, 1, 'cash', 'preflop');
      const decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          mind: false,
          telemetry: false,
          phase10Plo4: 'off',
          phase11Omaha: 'off',
          phase12Remaining: 'off',
          phase13Joint: 'off',
        }
      );
      expect(decision.policyOwnership).toMatchObject({
        variant,
        mode: 'off',
        outcome: 'disabled',
        reason: null,
      });
      expect(horsePolicyOwnershipMatches(decision)).toBe(true);
    }
  );
  it('retains a real depth-domain refusal instead of reporting pack execution', () => {
    const { hero, state } = jointPolicyFixture('plo4', 1, 'cash', 'preflop');
    state.dealerSeat = hero.seat;
    hero.stack = 1000 * state.bigBlind;
    state.players.forEach((p) => {
      p.stack = hero.stack;
    });
    const decision = HorseLogic.decide(
      hero,
      state,
      'balanced',
      {},
      { mind: false, telemetry: false, phase13Joint: 'off' }
    );
    expect(decision.policyOwnership).toMatchObject({
      outcome: 'outside_domain',
      reason: 'depth_or_ante_outside_pack',
      mode: 'shadow',
    });
    expect(decision.policyGraph).toBeDefined();
  });
  it.each([
    'missing',
    'wrong_owner',
    'wrong_version',
    'wrong_variant',
    'false_computed',
    'private',
    'extra_owner',
    'null',
  ])('rejects fabricated ownership: %s', (fault) => {
    const { hero, state } = jointPolicyFixture('plo5', 1, 'cash', 'preflop');
    const decision = HorseLogic.decide(
      hero,
      state,
      'balanced',
      {},
      { mind: false, telemetry: false, phase13Joint: 'off', phase11EvidenceMode: true }
    );
    expect(horsePolicyOwnershipMatches(decision)).toBe(true);
    const d = structuredClone(decision) as any;
    if (fault === 'missing') delete d.omahaVariantPolicy;
    if (fault === 'wrong_owner') d.policyOwnership.owner = 'phase12';
    if (fault === 'wrong_version') d.omahaVariantPolicy.version = 'other_pack';
    if (fault === 'wrong_variant') d.omahaVariantPolicy.variant = 'plo6';
    if (fault === 'false_computed') {
      d.omahaVariantPolicy.fired = false;
      d.policyOwnership.outcome = 'computed';
    }
    if (fault === 'private') d.policyOwnership.cards = hero.cards;
    if (fault === 'extra_owner') d.plo4Policy = d.omahaVariantPolicy;
    if (fault === 'null') d.policyOwnership = null;
    expect(horsePolicyOwnershipMatches(d)).toBe(false);
    expect(horseDecisionReceiptIsValid(d)).toBe(false);
  });
  it('does not invent a pack version for the source-bound legacy reference', () => {
    const d: HorseDecision = { action: 'check', thinkTime: 0 };
    expect(horsePolicyOwnership('nlh', d, true)).toMatchObject({
      owner: 'reference',
      packVersion: null,
      outcome: 'reference',
    });
    expect(() => horsePolicyOwnership('plo4', d, true)).toThrow('registered owner');
  });
});
