import { beforeEach, describe, expect, it } from 'vitest';
import { HorseMind } from './HorseMind.js';
import type { SeatPlayer } from '../types.js';

const players = [{ user_id: 'hero' }, { user_id: 'villain' }] as SeatPlayer[];
beforeEach(() => HorseMind.reset());

describe('bounded private second-look reads', () => {
  it('copies every consumed kind of read without pending writes or unrelated memory', () => {
    HorseMind.importStats([{ user_id: 'villain', hands: 90, folds: 80, facedAggr: 90 }]);
    HorseMind.importStats([{ user_id: 'unrelated', hands: 40 }]);
    HorseMind.importScoped([
      { user_id: 'villain', scope: 'omaha:hu', hands: 80, folds: 10, facedAggr: 80 },
    ]);
    HorseMind.importPairs([{ attacker_id: 'villain', victim_id: 'hero', n3: 8, opp3: 10 }]);
    HorseMind.notePlan('hand', 'hero', false);
    HorseMind.noteRaisePlan('hand', 'hero', 'flop', 'callOnce');
    HorseMind.noteOutlook('hand', 'hero', 'flop', ['Ah'], ['Ks']);
    HorseMind.notePlan('other-hand', 'hero', true);
    HorseMind.requeueDirty(['villain']);
    HorseMind.requeueDirtyScoped([{ user_id: 'villain', scope: 'omaha:hu' }]);
    const view = HorseMind.snapshotDecisionReads(players, 'hand');
    expect(view.stats.size).toBe(1);
    expect(view.scoped.size).toBe(1);
    expect(view.plans.size).toBe(1);
    for (const key of ['seenActions', 'handFlags', 'dirty', 'dirtyPairs', 'dirtyScoped'] as const)
      expect(view[key].size).toBe(0);
    HorseMind.getStats('villain')!.hands = 900;
    HorseMind.getScopedStats('villain', 'omaha:hu')!.hands = 800;
    HorseMind.getPair('villain', 'hero')!.n3 = 9;
    HorseMind.notePlan('hand', 'hero', true);
    HorseMind.noteRaisePlan('hand', 'hero', 'flop', 'commit');
    HorseMind.noteOutlook('hand', 'hero', 'flop', ['Ks'], ['Ah']);
    HorseMind.setDecisionScope('holdem:hu');
    HorseMind.runInSandbox(view, () => {
      expect(HorseMind.currentScope()).toBeNull();
      expect(HorseMind.getStats('villain')?.hands).toBe(90);
      expect(HorseMind.getScopedStats('villain', 'omaha:hu')?.hands).toBe(80);
      expect(HorseMind.getPair('villain', 'hero')?.n3).toBe(8);
      expect(HorseMind.getPlan('hand', 'hero')).toBe(false);
      expect(HorseMind.getRaisePlan('hand', 'hero', 'flop')).toBe('callOnce');
      expect(HorseMind.outlookOf('hand', 'hero', 'flop', 'Ah')).toBe('good');
      HorseMind.setDecisionScope('omaha:hu');
      expect(HorseMind.exploit('villain', false).bluffMod).toBe(0.55);
      view.outlooks.get('hand|hero|flop')!.good.clear();
      const captured = HorseMind.captureDecisionEffects(() =>
        HorseMind.notePlan('hand', 'hero', true)
      );
      expect(captured.effects).toHaveLength(1);
      expect(HorseMind.getPlan('hand', 'hero')).toBe(false);
    });
    expect(HorseMind.currentScope()).toBe('holdem:hu');
    expect(HorseMind.getStats('villain')?.hands).toBe(900);
    expect(HorseMind.outlookOf('hand', 'hero', 'flop', 'Ks')).toBe('good');
    expect(HorseMind.dirtyCount()).toBe(1);
    expect(HorseMind.dirtyScopedCount()).toBe(1);
  });

  it('restores the surrounding read scope on exceptions', () => {
    HorseMind.setDecisionScope('omaha:full');
    expect(() =>
      HorseMind.runInSandbox(HorseMind.createSandbox(), () => {
        HorseMind.setDecisionScope('sixplus:short');
        throw Error('failed second look');
      })
    ).toThrow('failed second look');
    expect(HorseMind.currentScope()).toBe('omaha:full');
  });

  it('refuses crossing an active live intent capture', () => {
    expect(() =>
      HorseMind.captureDecisionEffects(() =>
        HorseMind.runInSandbox(HorseMind.createSandbox(), () =>
          HorseMind.notePlan('hand', 'hero', true)
        )
      )
    ).toThrow('active effect capture');
    expect(HorseMind.captureDecisionEffects(() => 0).effects).toEqual([]);
  });

  it('bounds the actor set and refuses a partial capture', () => {
    expect(() =>
      HorseMind.snapshotDecisionReads(
        Array.from({ length: 11 }, (_, i) => ({ user_id: String(i) })) as SeatPlayer[],
        null
      )
    ).toThrow('invalid boundary');
    expect(() => HorseMind.snapshotDecisionReads([players[0], players[0]], null)).toThrow(
      'invalid boundary'
    );
    expect(() =>
      HorseMind.captureDecisionEffects(() => HorseMind.snapshotDecisionReads(players, null))
    ).toThrow('invalid boundary');
    expect(HorseMind.snapshotDecisionReads(players, null).stats.size).toBe(0);
  });
});
