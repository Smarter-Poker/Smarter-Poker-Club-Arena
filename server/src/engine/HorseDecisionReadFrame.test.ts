import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { HorseMind } from './HorseMind.js';
import {
  encodeHorseDecisionReads,
  decodeHorseDecisionReads,
  HORSE_DECISION_READ_FRAME_MAX_BYTES,
} from './HorseDecisionReadFrame.js';
import type { SeatPlayer } from '../types.js';

const players = [{ user_id: 'hero' }, { user_id: 'villain' }] as SeatPlayer[];
beforeEach(() => HorseMind.reset());
function populated() {
  HorseMind.importStats([
    { user_id: 'villain', hands: 90, folds: 80, facedAggr: 90, rHands: 12.625 },
  ]);
  HorseMind.importScoped([
    { user_id: 'villain', scope: 'omaha:hu', hands: 80, folds: 10, facedAggr: 80 },
  ]);
  HorseMind.importPairs([{ attacker_id: 'villain', victim_id: 'hero', n3: 8, opp3: 10 }]);
  HorseMind.notePlan('hand', 'hero', false);
  HorseMind.noteRaisePlan('hand', 'hero', 'flop', 'callOnce');
  HorseMind.noteOutlook('hand', 'hero', 'flop', ['Kh', 'Ah'], ['Ks', 'As']);
  return HorseMind.snapshotDecisionReads(players, 'hand');
}
describe('portable private Horse read frames', () => {
  it('retains every read container, insertion order and fractional evidence without live writes', () => {
    const view = populated(),
      frame = encodeHorseDecisionReads(view, players, 'hand');
    expect(Object.isFrozen(frame)).toBe(true);
    expect(frame.bytes).toBe(Buffer.byteLength(frame.json));
    const restored = decodeHorseDecisionReads(JSON.parse(JSON.stringify(frame)), players, 'hand');
    expect(restored).toEqual(view);
    expect([...restored.outlooks.get('hand|hero|flop')!.good]).toEqual(['Kh', 'Ah']);
    HorseMind.getStats('villain')!.hands = 900;
    HorseMind.runInSandbox(restored, () => {
      expect(HorseMind.getStats('villain')!.hands).toBe(90);
      HorseMind.setDecisionScope('omaha:hu');
      expect(HorseMind.exploit('villain', false).bluffMod).toBe(0.55);
      expect(HorseMind.getPlan('hand', 'hero')).toBe(false);
      expect(HorseMind.getRaisePlan('hand', 'hero', 'flop')).toBe('callOnce');
      expect(HorseMind.outlookOf('hand', 'hero', 'flop', 'Kh')).toBe('good');
    });
    expect(HorseMind.getStats('villain')!.hands).toBe(900);
  });

  it('refuses a valid frame belonging to another actor order or hand', () => {
    const frame = encodeHorseDecisionReads(populated(), players, 'hand');
    expect(() => decodeHorseDecisionReads(frame, [...players].reverse(), 'hand')).toThrow(
      'invalid'
    );
    expect(() => decodeHorseDecisionReads(frame, players, 'another')).toThrow('invalid');
  });

  it.each(['json', 'sha256', 'bytes', 'version'] as const)(
    'detects changed %s before restoring reads',
    (field) => {
      const frame = encodeHorseDecisionReads(populated(), players, 'hand');
      const bad = { ...frame, [field]: field === 'bytes' ? frame.bytes + 1 : 'changed' };
      expect(() => decodeHorseDecisionReads(bad as never, players, 'hand')).toThrow('invalid');
    }
  );

  it.each([
    'duplicate',
    'unknown_actor',
    'missing_stat',
    'extra_stat',
    'negative',
    'null',
    'unknown_field',
    'invalid_outlook',
    'extra_pair',
  ])('refuses a resealed malformed body: %s', (kind) => {
    const frame = encodeHorseDecisionReads(populated(), players, 'hand');
    const body = JSON.parse(frame.json);
    if (kind === 'duplicate') body.stats.push(body.stats[0]);
    if (kind === 'unknown_actor') body.stats[0][0] = 'unrelated';
    if (kind === 'missing_stat') body.stats[0][1].pop();
    if (kind === 'extra_stat') body.stats[0][1].push(0);
    if (kind === 'negative') body.stats[0][1][0] = -1;
    if (kind === 'null') body.stats[0][1][0] = null;
    if (kind === 'unknown_field') body.dirty = [];
    if (kind === 'invalid_outlook') body.outlooks[0][1].good = ['Ah', 'Ah'];
    if (kind === 'extra_pair') body.pairs[0][1].push(0);
    const json = JSON.stringify(body);
    const bad = {
      ...frame,
      json,
      bytes: Buffer.byteLength(json),
      sha256: createHash('sha256').update(json).digest('hex'),
    };
    expect(() => decodeHorseDecisionReads(bad, players, 'hand')).toThrow('invalid');
  });

  it.each(['seenActions', 'handFlags', 'dirty', 'dirtyPairs', 'dirtyScoped'] as const)(
    'never silently drops pending %s',
    (key) => {
      const view = populated();
      view[key].add('pending');
      expect(() => encodeHorseDecisionReads(view, players, 'hand')).toThrow('invalid');
    }
  );

  it('refuses over-budget or out-of-boundary captures without truncation', () => {
    const frame = encodeHorseDecisionReads(populated(), players, 'hand');
    expect(() =>
      decodeHorseDecisionReads(
        { ...frame, json: ' '.repeat(HORSE_DECISION_READ_FRAME_MAX_BYTES + 1) },
        players,
        'hand'
      )
    ).toThrow('invalid');
    const view = populated();
    view.stats.set('unrelated', { ...view.stats.get('villain')! });
    expect(() => encodeHorseDecisionReads(view, players, 'hand')).toThrow('invalid');
    expect(() => encodeHorseDecisionReads(populated(), [...players, players[0]], 'hand')).toThrow(
      'invalid'
    );
  });
});
