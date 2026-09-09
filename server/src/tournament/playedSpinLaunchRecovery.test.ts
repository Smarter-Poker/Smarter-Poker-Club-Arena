import { describe, expect, it } from 'vitest';
import { parsePlayedSpinLaunchRecoveryProof } from './playedSpinLaunchRecovery.js';

const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const tournamentId = id('10');
const original = [id('1'), id('2'), id('3')];
const active = [id('2'), id('3')];

const proof = () => ({
  ok: true,
  recovery_mode: 'played_vacated_spin',
  tournament_id: tournamentId,
  original_field: 3,
  active_field: 2,
  eliminated_players: 1,
  paid_users: 3,
  entitlement_users: 3,
  live_seats: 2,
  hand_count: 1,
  funding_floor: 3_000,
  roster_chips: 3_000,
  seat_chips: 3_000,
  original_player_ids: original,
  active_player_ids: active,
});

describe('the manager admits only the exact played-and-vacated Spin proof', () => {
  it('keeps all three payment identities but only the two live launch identities', () => {
    expect(
      parsePlayedSpinLaunchRecoveryProof(proof(), tournamentId, [...active].reverse())
    ).toEqual({
      tournamentId,
      originalPlayerIds: [...original].sort(),
      activePlayerIds: [...active].sort(),
      fundingFieldSize: 3,
    });
  });

  it.each([
    ['recovery_mode', 'heads_up_sng'],
    ['original_field', 2],
    ['active_field', 1],
    ['eliminated_players', 0],
    ['paid_users', 2],
    ['entitlement_users', 2],
    ['live_seats', 1],
    ['hand_count', 0],
    ['roster_chips', 2_999],
    ['seat_chips', 2_999],
    ['roster_chips', 3_001],
    ['seat_chips', 3_001],
  ])('refuses a proof with wrong %s evidence', (field, wrong) => {
    expect(() =>
      parsePlayedSpinLaunchRecoveryProof({ ...proof(), [field]: wrong }, tournamentId, active)
    ).toThrow();
  });

  it('refuses a proof whose live identities changed after the manager read them', () => {
    expect(() =>
      parsePlayedSpinLaunchRecoveryProof(proof(), tournamentId, [id('1'), id('2')])
    ).toThrow(/disagrees/);
  });

  it('refuses duplicate, malformed, or foreign roster identities', () => {
    expect(() =>
      parsePlayedSpinLaunchRecoveryProof(
        { ...proof(), original_player_ids: [id('1'), id('1'), id('3')] },
        tournamentId,
        active
      )
    ).toThrow(/invalid/);
    expect(() =>
      parsePlayedSpinLaunchRecoveryProof(
        { ...proof(), active_player_ids: [id('2'), id('99')] },
        tournamentId,
        active
      )
    ).toThrow(/not part/);
  });
});
