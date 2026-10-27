import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HorseDecision } from '../types.js';
process.env.EQUITY_GOVERNOR = 'off';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'feature-ablation-offline-placeholder';
const { createFeatureAblationWorker } = await import('./FeatureAblationWorker.js');
const { runFeatureAblationDevelopment } = await import('./FeatureAblationLeague.js');
const { incrementalDevelopmentProfiles, incrementalDevelopmentSpec, buildIncrementalWarmRecords } =
  await import('./IncrementalPressureDevelopment.js');
const { makeFeatureAblationOwnHistory } = await import('./FeatureAblationHistory.js');
const { horseObserverReadContextFromRequest } =
  await import('../engine/HorseObserverReadContext.js');
const { hydrateFrozenFeatureAblationStores } = await import('./FeatureAblationStores.js');
const { enableBrainTelemetry } = await import('../engine/BrainTelemetry.js');
const { HorseLogic } = await import('../engine/HorseLogic.js');
const { channelHub } = await import('../hub/ChannelHub.js');
beforeAll(async () => {
  await hydrateFrozenFeatureAblationStores();
  enableBrainTelemetry();
});
afterAll(() => channelHub.close());
afterEach(() => vi.restoreAllMocks());
describe('V54 station intent survives the actual worker policy graph', () => {
  it.each([
    ['plo4', 15, false],
    ['plo5', 16, false],
    ['plo6', 16, false],
    ['plo4', 15, true],
  ] as const)(
    '%s retained pair %i copied/forged identity=%s',
    async (variant, index, copied) => {
      if (copied) {
        const owner = HorseLogic as unknown as {
          decidePostflop: (...args: unknown[]) => HorseDecision;
        };
        const postflop = owner.decidePostflop;
        vi.spyOn(owner, 'decidePostflop').mockImplementation((...args) => ({
          ...postflop.apply(HorseLogic, args),
          v54StationCheck: true,
        }));
      }
      const records = buildIncrementalWarmRecords(variant, 2, 'targeted_river_bluff');
      const brain = createFeatureAblationWorker(
        () => {},
        () => {},
        true,
        (r) => {
          const c = horseObserverReadContextFromRequest(r);
          if (!c) throw Error('Missing context');
          return makeFeatureAblationOwnHistory(c, r.player.seat, records);
        }
      );
      const original = brain.decide.bind(brain);
      const baselineRiver: { action: string; amount: number | null }[] = [];
      const checks: { reference: string; final: string; changed: boolean }[] = [];
      brain.decide = async (...args) => {
        const d = await original(...args);
        if (args[1].stage === 'river' && args[3].v54RiverBluff === false)
          baselineRiver.push({ action: d.action, amount: d.amount ?? null });
        if (args[1].stage === 'river' && args[3].v54RiverBluff === true) {
          const g = d.policyGraph!;
          checks.push({
            reference: g.transitions[0].after.action,
            final: d.action,
            changed: g.transitions.some((t) => t.changed),
          });
        }
        return d;
      };
      const profile = incrementalDevelopmentProfiles('targeted_river_bluff', variant)[0];
      const r = await runFeatureAblationDevelopment(
        incrementalDevelopmentSpec('targeted_river_bluff', variant, profile.id, brain),
        { seed: 27301101, pairs: 1, startPair: index }
      );
      expect(r.complete).toBe(true);
      for (const key of [
        'protocolErrors',
        'brainExceptions',
        'illegalActions',
        'conservationErrors',
        'cardErrors',
        'truncatedHands',
        'settlementMismatches',
        'deductionMismatches',
        'pairedReplayMismatches',
      ] as const)
        expect(r[key], key).toBe(0);
      expect(baselineRiver).toEqual([
        { action: 'bet', amount: variant === 'plo4' ? 22 : variant === 'plo5' ? 19 : 16 },
      ]);
      expect(checks.some((c) => c.reference === 'check')).toBe(true);
      expect(
        checks
          .filter((c) => c.reference === 'check')
          .every((c) =>
            copied ? c.final === 'bet' && c.changed : c.final === 'check' && !c.changed
          )
      ).toBe(true);
    },
    30000
  );
});
