export interface PlayedSpinLaunchRecoveryProof {
  tournamentId: string;
  originalPlayerIds: string[];
  activePlayerIds: string[];
  fundingFieldSize: 3;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const exactIds = (raw: unknown, field: string, expectedLength: number): string[] => {
  if (!Array.isArray(raw) || raw.length !== expectedLength) {
    throw new Error(`played Spin launch proof has no exact ${field}`);
  }
  const ids = raw.map((value) => String(value ?? '').toLowerCase());
  if (ids.some((value) => !UUID.test(value)) || new Set(ids).size !== ids.length) {
    throw new Error(`played Spin launch proof contains an invalid ${field}`);
  }
  return ids.sort();
};

/**
 * Parse the database's narrow exception for a Spin that already dealt a hand
 * before its launch receipt completed. This is not a generic two-player Spin:
 * one original paid player must be busted and vacated, while the exact two
 * active identities returned by PostgreSQL must be the identities the manager
 * just read from the active roster.
 */
export function parsePlayedSpinLaunchRecoveryProof(
  raw: unknown,
  expectedTournamentId: string,
  expectedActivePlayerIds: readonly string[]
): PlayedSpinLaunchRecoveryProof {
  const value = raw as Record<string, unknown> | null;
  if (!value || value.ok !== true || value.recovery_mode !== 'played_vacated_spin') {
    throw new Error('database did not prove a played-and-vacated Spin launch');
  }
  if (String(value.tournament_id ?? '').toLowerCase() !== expectedTournamentId.toLowerCase()) {
    throw new Error('played Spin launch proof names a different tournament');
  }
  if (
    Number(value.original_field) !== 3 ||
    Number(value.active_field) !== 2 ||
    Number(value.eliminated_players) !== 1 ||
    Number(value.paid_users) !== 3 ||
    Number(value.entitlement_users) !== 3 ||
    Number(value.live_seats) !== 2 ||
    Number(value.hand_count) < 1
  ) {
    throw new Error('played Spin launch proof does not describe one exact paid three-seat game');
  }

  const fundingFloor = Number(value.funding_floor);
  const rosterChips = Number(value.roster_chips);
  const seatChips = Number(value.seat_chips);
  if (
    !Number.isFinite(fundingFloor) ||
    fundingFloor <= 0 ||
    !Number.isFinite(rosterChips) ||
    rosterChips !== fundingFloor ||
    !Number.isFinite(seatChips) ||
    seatChips !== fundingFloor ||
    seatChips !== rosterChips
  ) {
    throw new Error('played Spin launch proof does not conserve the three bought stacks');
  }

  const originalPlayerIds = exactIds(value.original_player_ids, 'original roster', 3);
  const activePlayerIds = exactIds(value.active_player_ids, 'active roster', 2);
  if (activePlayerIds.some((id) => !originalPlayerIds.includes(id))) {
    throw new Error('played Spin launch proof active roster is not part of the original field');
  }

  const expectedActive = exactIds(expectedActivePlayerIds, 'manager active roster', 2);
  if (activePlayerIds.some((id, index) => id !== expectedActive[index])) {
    throw new Error('played Spin launch proof disagrees with the manager active roster');
  }

  return {
    tournamentId: expectedTournamentId,
    originalPlayerIds,
    activePlayerIds,
    fundingFieldSize: 3,
  };
}
