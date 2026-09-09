export interface SpinSettlementReceipt {
  tournamentId: string;
  multiplier: number;
  prizePool: number;
  reserveIn: number;
  reserveBalance: number;
  houseRake: number;
  lockedTiers: Array<{ multiplier: number; reason?: string; unlocksAt?: number }>;
}

interface SpinSettlementExpectation {
  tournamentId: string;
  buyIn: number;
  seats: number;
  rakeRate: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const centsEqual = (left: unknown, right: number): boolean => {
  const value = Number(left);
  return Number.isFinite(value) && Math.abs(value - right) < 0.005;
};

const requireUuid = (value: unknown, field: string): void => {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`atomic Spin receipt has no valid ${field}`);
  }
};

/**
 * Treat the database receipt as evidence, not as a convenient multiplier DTO.
 * The engine may reveal or deal only when every authoritative row agrees with
 * the exact three-paid-seat contract that the RPC says it committed.
 */
export function parseSpinSettlementReceipt(
  raw: unknown,
  expected: SpinSettlementExpectation
): SpinSettlementReceipt {
  const value = raw as Record<string, unknown> | null;
  if (!value || value.ok !== true || value.money_path !== 'fn_spin_draw_and_settle') {
    throw new Error('atomic Spin settlement did not return an authoritative receipt');
  }
  if (value.tournament_id !== expected.tournamentId) {
    throw new Error('atomic Spin receipt names a different tournament');
  }
  if (Number(value.seats) !== expected.seats || Number(value.paid_users) !== expected.seats) {
    throw new Error('atomic Spin receipt does not prove exactly three paid seats');
  }

  const multiplier = Number(value.multiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error('atomic Spin receipt has no positive multiplier');
  }
  const prizePool = Math.round(expected.buyIn * multiplier * 100) / 100;
  const collected = Math.round(expected.buyIn * expected.seats * 100) / 100;
  const houseRake = Math.round(collected * expected.rakeRate * 100) / 100;
  const reserveIn = Math.round((collected - houseRake) * 100) / 100;

  for (const [field, amount] of [
    ['prize_pool', prizePool],
    ['pool_covered', prizePool],
    ['draw_amount', prizePool],
    ['tournament_prize_pool', prizePool],
    ['reserve_in', reserveIn],
    ['entry_amount', reserveIn],
    ['escrow_reserve_out', reserveIn],
    ['escrow_reserve_in', prizePool],
    ['escrow_prize_balance', prizePool],
    ['house_rake', houseRake],
  ] as const) {
    if (!centsEqual(value[field], amount)) {
      throw new Error(`atomic Spin receipt ${field} disagrees with the locked contract`);
    }
  }
  if (!centsEqual(value.operator_shortfall, 0)) {
    throw new Error('atomic Spin receipt contains an operator shortfall');
  }
  if (Number(value.tournament_multiplier) !== multiplier) {
    throw new Error('atomic Spin receipt multiplier was not stamped on the tournament');
  }

  requireUuid(value.owner_id, 'reserve owner');
  requireUuid(value.pool_id, 'reserve pool');
  requireUuid(value.entry_reserve_id, 'entry reserve row');
  requireUuid(value.entry_journal_id, 'entry journal row');
  requireUuid(value.draw_reserve_id, 'draw reserve row');
  requireUuid(value.draw_journal_id, 'draw journal row');

  if (!Array.isArray(value.locked)) {
    throw new Error('atomic Spin receipt has no locked-tier evidence');
  }
  const lockedTiers = value.locked.map((item) => {
    const row = item as Record<string, unknown>;
    const lockedMultiplier = Number(row?.multiplier);
    if (!Number.isFinite(lockedMultiplier) || lockedMultiplier <= 0) {
      throw new Error('atomic Spin receipt contains an invalid locked tier');
    }
    return {
      multiplier: lockedMultiplier,
      reason: row.reason == null ? undefined : String(row.reason),
      unlocksAt: Number.isFinite(Number(row.unlocksAt)) ? Number(row.unlocksAt) : undefined,
    };
  });

  const reserveBalance = Number(value.reserve_balance);
  if (!Number.isFinite(reserveBalance) || reserveBalance < 0) {
    throw new Error('atomic Spin receipt has an invalid reserve balance');
  }

  return {
    tournamentId: expected.tournamentId,
    multiplier,
    prizePool,
    reserveIn,
    reserveBalance,
    houseRake,
    lockedTiers,
  };
}
