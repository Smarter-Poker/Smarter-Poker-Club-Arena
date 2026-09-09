import { describe, expect, it } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';

// Execute the real admission proof without constructing a manager or doing I/O.
const proof = Object.create(TournamentManagerBase.prototype) as {
  launchRowMatchesPatch(
    row: Record<string, unknown> | null,
    patch: Record<string, unknown>
  ): boolean;
};
const patch = {
  prize_pool: 200,
  spin_multiplier: 2,
  is_premium_spin: false,
  starting_chips: 300,
  blind_structure: [{ level: 1, smallBlind: 10, bigBlind: 20, ante: 0, duration: 180 }],
  payout_structure: [{ place: 1, percentage: 100 }],
  spin_reveal_lag_ms: 15789,
  spin_reveal_at: '2026-09-08T18:31:46.054Z',
  spin_locked_tiers: [{ multiplier: 2, probability: 0.5, payouts: [1] }],
};
function persisted() {
  return {
    ...patch,
    prize_pool: '200.00',
    spin_multiplier: '2',
    // Both columns are TEXT in the verified production catalog.
    blind_structure: JSON.stringify(patch.blind_structure),
    payout_structure: JSON.stringify(patch.payout_structure),
    spin_reveal_at: '2026-09-08T18:31:46.054+00:00',
    // JSONB does not preserve the object's original key insertion order.
    spin_locked_tiers: [{ payouts: [1], probability: 0.5, multiplier: 2 }],
  };
}

describe('a Spin draw proves values after a PostgreSQL round trip', () => {
  it('accepts the saved TEXT structures, numeric scale and timestamp representation', () => {
    expect(proof.launchRowMatchesPatch(persisted(), patch)).toBe(true);
  });
  it('accepts native JSON and reordered nested object keys', () => {
    expect(
      proof.launchRowMatchesPatch(
        {
          ...persisted(),
          blind_structure: [{ duration: 180, ante: 0, bigBlind: 20, smallBlind: 10, level: 1 }],
          payout_structure: patch.payout_structure,
        },
        patch
      )
    ).toBe(true);
  });
  it.each([
    ['prize_pool', '199.99'],
    ['spin_multiplier', '3'],
    ['starting_chips', 1000],
    ['is_premium_spin', true],
    ['spin_reveal_lag_ms', 15790],
    ['spin_reveal_at', '2026-09-08T18:31:46.055Z'],
    ['blind_structure', '[{"level":1,"smallBlind":10,"bigBlind":21,"ante":0,"duration":180}]'],
    ['payout_structure', '[{"place":1,"percentage":99}]'],
    ['blind_structure', '[broken'],
    ['payout_structure', 'null'],
    ['spin_locked_tiers', [{ multiplier: 2, probability: 0.5, payouts: [1], invented: true }]],
  ])('rejects a different or unreadable %s', (key, value) => {
    expect(proof.launchRowMatchesPatch({ ...persisted(), [key as string]: value }, patch)).toBe(
      false
    );
  });
  it('preserves array order and requires every selected column', () => {
    const ordered = {
      payout_structure: [
        { place: 1, percentage: 80 },
        { place: 2, percentage: 20 },
      ],
    };
    expect(
      proof.launchRowMatchesPatch(
        { payout_structure: JSON.stringify([...ordered.payout_structure].reverse()) },
        ordered
      )
    ).toBe(false);
    expect(proof.launchRowMatchesPatch({}, { spin_reveal_at: null })).toBe(false);
    expect(proof.launchRowMatchesPatch({ spin_reveal_at: null }, { spin_reveal_at: null })).toBe(
      true
    );
    expect(proof.launchRowMatchesPatch(null, patch)).toBe(false);
  });
  it.each([null, false, '', ' ', 'NaN', Infinity])(
    'does not coerce %s into numeric proof',
    (actual) => {
      expect(
        proof.launchRowMatchesPatch({ spin_reveal_lag_ms: actual }, { spin_reveal_lag_ms: 0 })
      ).toBe(false);
    }
  );
});
