import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { HorseMind } from './HorseMind.js';
import { observeHandResults, resetWinnerReads } from './HorseWinnerRead.js';
import { encodeHorseDecisionReads, decodeHorseDecisionReads } from './HorseDecisionReadFrame.js';
import type { SeatPlayer } from '../types.js';
import { freshExploitCounters } from './HorseOpponentExploit.js';

const players = [{ user_id: 'hero' }, { user_id: 'winner' }] as SeatPlayer[];
function learnWinner() {
  for (let n = 0; n < 400; n++)
    observeHandResults(`winner:${n}`, [{ user_id: 'winner', net: 2 }], 2);
}
afterEach(() => {
  HorseMind.reset();
  resetWinnerReads();
});

describe('winner beliefs belong to the original decision read frame', () => {
  it('retains the FAST winner belief through a global reset before the second look', () => {
    learnWinner();
    const view = HorseMind.snapshotDecisionReads(players, 'hand');
    const before = HorseMind.exploit('winner');
    const frame = encodeHorseDecisionReads(view, players, 'hand');
    resetWinnerReads();
    const restored = decodeHorseDecisionReads(frame, players, 'hand');
    expect(HorseMind.runInSandbox(restored, () => HorseMind.exploit('winner'))).toEqual(before);
  });

  it('does not borrow a belief learned after FAST, and restores live reads after an exception', () => {
    const view = HorseMind.snapshotDecisionReads(players, 'hand');
    const before = HorseMind.exploit('winner');
    learnWinner();
    expect(HorseMind.exploit('winner').bluffMod).toBe(0.6);
    expect(() =>
      HorseMind.runInSandbox(view, () => {
        expect(HorseMind.exploit('winner')).toEqual(before);
        expect(() => HorseMind.runInSandbox(view, () => null)).toThrow('already inside');
        throw Error('decision failed');
      })
    ).toThrow('decision failed');
    expect(HorseMind.exploit('winner').bluffMod).toBe(0.6);
    const next = HorseMind.snapshotDecisionReads(players, 'hand');
    expect(next.winnerReads?.get('winner')).toBe(true);
  });

  it('captures only the at-most-ten actual actors, including false beliefs, detached from global state', () => {
    learnWinner();
    const ten = Array.from({ length: 10 }, (_, i) => ({ user_id: `actor-${i}` })) as SeatPlayer[];
    const view = HorseMind.snapshotDecisionReads(ten, null);
    expect([...view.winnerReads!]).toEqual(ten.map((p) => [p.user_id, false]));
    const frame = encodeHorseDecisionReads(view, ten, null);
    expect(frame.version).toBe('horse-decision-reads-v5');
    const restored = decodeHorseDecisionReads(frame, ten, null);
    expect(restored.winnerReads).toEqual(view.winnerReads);
    expect(restored.winnerReads).not.toBe(view.winnerReads);
    expect(() =>
      HorseMind.snapshotDecisionReads([...ten, { user_id: 'extra' } as SeatPlayer], null)
    ).toThrow('boundary');
    // Out-of-frame actors never borrow a global belief during a private replay.
    expect(HorseMind.runInSandbox(restored, () => HorseMind.exploit('winner').bluffMod)).toBe(1);
  });

  it.each(['missing', 'duplicate', 'outsider', 'non_boolean', 'extra', 'absent'])(
    'refuses resealed incomplete or malformed v5 beliefs: %s',
    (fault) => {
      const frame = encodeHorseDecisionReads(
        HorseMind.snapshotDecisionReads(players, 'hand'),
        players,
        'hand'
      );
      const body = JSON.parse(frame.json);
      if (fault === 'missing') body.winnerReads.pop();
      if (fault === 'duplicate') body.winnerReads[1] = body.winnerReads[0];
      if (fault === 'outsider') body.winnerReads[1][0] = 'elsewhere';
      if (fault === 'non_boolean') body.winnerReads[1][1] = 1;
      if (fault === 'extra') body.winnerReads.push(['elsewhere', false]);
      if (fault === 'absent') delete body.winnerReads;
      const json = JSON.stringify(body);
      expect(() =>
        decodeHorseDecisionReads(
          {
            ...frame,
            json,
            bytes: Buffer.byteLength(json),
            sha256: createHash('sha256').update(json).digest('hex'),
          },
          players,
          'hand'
        )
      ).toThrow('invalid');
    }
  );

  it('refuses partial or out-of-scope winner maps before encoding, rather than dropping them', () => {
    const view = HorseMind.snapshotDecisionReads(players, 'hand');
    view.winnerReads!.delete('hero');
    expect(() => encodeHorseDecisionReads(view, players, 'hand')).toThrow('invalid');
    view.winnerReads!.set('outsider', false);
    expect(() => encodeHorseDecisionReads(view, players, 'hand')).toThrow('invalid');
  });

  it.each([1, 2, 3, 4])(
    'preserves v%s bytes and gives missing historical winner capture explicit neutral semantics',
    (version) => {
      const view = HorseMind.createSandbox();
      const context = version === 2 ? { version: 1 as const, hand: null } : undefined;
      if (version === 3) {
        HorseMind.importStats([{ user_id: 'winner', hands: 90 }]);
        view.stats = HorseMind.snapshotDecisionReads(players, null).stats;
      }
      if (version === 4) view.exploit.set('holdem:hu|winner', freshExploitCounters());
      const frame = encodeHorseDecisionReads(view, players, null, context);
      expect(frame.version).toBe(`horse-decision-reads-v${version}`);
      const restored = decodeHorseDecisionReads(frame, players, null, context);
      expect(restored.winnerReads).toBeUndefined();
      expect(encodeHorseDecisionReads(restored, players, null, context)).toEqual(frame);
      learnWinner();
      expect(HorseMind.runInSandbox(restored, () => HorseMind.exploit('winner').bluffMod)).toBe(1);
      expect(HorseMind.exploit('winner').bluffMod).toBe(0.6);
    }
  );
});
