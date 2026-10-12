import { describe, expect, it } from 'vitest';
import { PILOT, selectPilotGame } from '../../scripts/ops/prepare-lightning-private-pilot.mjs';
const clubId = 'owned-private-club';
const pilot = {
  id: 'owned-private-pilot',
  club_id: clubId,
  union_id: null,
  name: PILOT.gameName,
  variant: 'nlh',
  handedness: 6,
  must_move: true,
  lightning_enabled: false,
  cluster_mode: 'must_move',
  ruleset_snapshot: { options: { is_private: true } },
};
const seeded = Array.from({ length: 9 }, (_, i) => ({
  ...pilot,
  id: `seeded-${i}`,
  name: `Classic Default ${i}`,
  ruleset_snapshot: { options: { is_private: false } },
}));
describe('durable pilot discovery after normal club provisioning', () => {
  it('does not adopt or modify the nine ordinary seeded games', () => {
    const before = structuredClone(seeded);
    expect(selectPilotGame(seeded, clubId)).toBeNull();
    expect(seeded).toEqual(before);
  });
  it('recovers the same private game among defaults after an unknown creation acknowledgment', () => {
    expect(selectPilotGame([...seeded, pilot], clubId)).toBe(pilot);
  });
  it('refuses ambiguous, wrong-club, public and already active targets', () => {
    expect(() =>
      selectPilotGame([...seeded, pilot, { ...pilot, id: 'duplicate' }], clubId)
    ).toThrow('Ambiguous');
    for (const patch of [
      { club_id: 'another-club' },
      { lightning_enabled: true },
      { ruleset_snapshot: { options: { is_private: false } } },
    ])
      expect(() => selectPilotGame([...seeded, { ...pilot, ...patch }], clubId)).toThrow();
  });
});
