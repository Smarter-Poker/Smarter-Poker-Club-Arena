import { describe, expect, it } from 'vitest';
import { HorseMind } from './HorseMind.js';
import {
  decayAndAdd,
  exploitHandIncrements,
  freshExploitCounters,
} from './HorseOpponentExploit.js';
import { MEMORY_VARIANTS, opponentMemoryKey, validOpponentProfile } from './HorseOpponentMemory.js';
import { decodeHorseDecisionReads, encodeHorseDecisionReads } from './HorseDecisionReadFrame.js';

const uid = '40000000-0000-4000-8000-000000000001';
function aggressive() {
  const counters = freshExploitCounters();
  const increments = exploitHandIncrements([
    { userId: uid, action: 'raise', stage: 'preflop' },
  ]).get(uid)!;
  for (let n = 0; n < 40; n++) decayAndAdd(counters, increments);
  return counters;
}
describe('variant and session durable opponent reads', () => {
  it('validates complete finite snapshots and stable game-specific identities', () => {
    const p = {
      user_id: uid,
      variant: 'plo5',
      mode: 'cash',
      size: 'short',
      observed_hands: 40,
      initialized: true,
      counters: aggressive(),
    };
    expect(validOpponentProfile(p)).toBe(true);
    expect(validOpponentProfile({ ...p, counters: { ...p.counters, pfr: Infinity } })).toBe(false);
    expect(validOpponentProfile({ ...p, observed_hands: NaN })).toBe(false);
    expect(MEMORY_VARIANTS).toEqual([
      'nlh',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'flh',
      'flo8',
      'short_deck',
      'pineapple',
    ]);
    expect(
      new Set(MEMORY_VARIANTS.map((v) => opponentMemoryKey(uid, v, 'cash', 'short'))).size
    ).toBe(9);
  });
  it('retains the read through a portable frame, isolates PLO variants and cash/tournament contexts', () => {
    HorseMind.importDurableOpponentProfiles([
      {
        user_id: uid,
        variant: 'plo5',
        mode: 'cash',
        size: 'short',
        observed_hands: 40,
        initialized: true,
        counters: aggressive(),
      },
    ]);
    HorseMind.setDecisionScope('omaha:short', 'plo5');
    const expected = HorseMind.opponentRead(uid);
    expect(expected?.stats.pfr.engaged).toBe('high');
    HorseMind.setDecisionScope('omaha:short', 'plo4');
    expect(HorseMind.opponentRead(uid)).toBeNull();
    HorseMind.setDecisionScope('omaha:short', 'plo5', 'tournament');
    expect(HorseMind.opponentRead(uid)).toBeNull();
    HorseMind.setDecisionScope(null);
    const players = [{ user_id: uid }];
    const view = HorseMind.snapshotDecisionReads(players as never, null);
    expect(view.exploit.get(opponentMemoryKey(uid, 'plo5', 'cash', 'short'))).toEqual(aggressive());
    const frame = encodeHorseDecisionReads(view, players as never, null);
    const restored = decodeHorseDecisionReads(frame, players as never, null);
    // The second look has no access to the live map.
    HorseMind.runInSandbox(restored, () => {
      HorseMind.setDecisionScope('omaha:short', 'plo5');
      expect(HorseMind.opponentRead(uid)).toEqual(expected);
    });
  });
  it('bounds a second look to the current game context even with a broad durable cache', () => {
    HorseMind.enableDurableOpponentMemory();
    const players = [{ user_id: uid }];
    const view = HorseMind.snapshotDecisionReads(players as never, null, {
      variant: 'plo5',
      mode: 'cash',
      size: 'short',
    });
    expect(view.exploit.size).toBe(1);
    const frame = encodeHorseDecisionReads(view, players as never, null);
    expect(frame.bytes).toBeLessThan(10000);
    HorseMind.reset();
  });
});
