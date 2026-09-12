import type { HandConfig, RakeConfig } from '../../types.js';
import { calculateRake } from '../PokerEngine.js';
import { scaleWinnerCentsForRake } from '../HandController.js';
import type { settleJointScores } from './JointPotDistribution.js';

/** Exact final payout scaling uses the controller's existing cent allocator.
 * Refunds precede fees and never pay rake. No table/database state is touched. */
export function applyJointDeductions(input: {
  settlement: ReturnType<typeof settleJointScores>;
  rakeConfig: RakeConfig;
  bbjConfig: HandConfig['bbjConfig'] | null;
  asset: 'chips' | 'diamonds';
  gameMode: 'cash' | 'tournament';
  bigBlind: number;
  dealtPlayers: number;
  sawFlop: boolean;
}) {
  const r = input.rakeConfig,
    b = input.bbjConfig;
  if (
    !r ||
    !Number.isFinite(r.percent) ||
    r.percent < 0 ||
    r.percent > 10 ||
    !Number.isFinite(r.cap) ||
    r.cap < 0 ||
    typeof r.noFlopNoDrop !== 'boolean' ||
    r.timedRake ||
    r.playerCountCaps?.some(
      (c) =>
        !Number.isInteger(c.players) ||
        c.players < 2 ||
        c.players > 10 ||
        !Number.isFinite(c.cap) ||
        c.cap < 0
    ) ||
    !['chips', 'diamonds'].includes(input.asset) ||
    !['cash', 'tournament'].includes(input.gameMode) ||
    !(Number.isFinite(input.bigBlind) && input.bigBlind > 0) ||
    !Number.isInteger(input.dealtPlayers) ||
    input.dealtPlayers < 2 ||
    input.dealtPlayers > 10 ||
    (b !== null &&
      (!b ||
        typeof b.enabled !== 'boolean' ||
        !Number.isFinite(b.feeBB) ||
        b.feeBB < 0 ||
        !Number.isInteger(b.minPlayersDealt) ||
        b.minPlayersDealt < 2 ||
        b.minPlayersDealt > 10))
  )
    throw new Error('joint_deductions_invalid_config');
  if (
    (input.asset === 'diamonds' || input.gameMode === 'tournament') &&
    (r.percent !== 0 || b?.enabled)
  )
    throw new Error('joint_deductions_nonzero_whole_unit_fees');
  const gross = Object.values(input.settlement.totals).reduce((a, v) => a + v, 0);
  const rake = Math.min(gross, calculateRake(gross, input.sawFlop, r, input.dealtPlayers));
  // minPotBB describes jackpot payout eligibility, not collection. The
  // authoritative controller collects the configured per-flop fee here.
  const bbjFee =
    b?.enabled && input.sawFlop && input.dealtPlayers >= b.minPlayersDealt
      ? Math.min(Math.max(0, gross - rake), Math.round(input.bigBlind * b.feeBB * 100) / 100)
      : 0;
  // Preserve board-major then pot-major first-winning appearance. That is
  // the controller's merged-winner order for residual cent allocation.
  const ids = [
    ...new Set(
      input.settlement.awards
        .slice()
        .sort((a, b) => a.boardIndex - b.boardIndex || a.potIndex - b.potIndex)
        .map((a) => a.playerId)
    ),
  ];
  const net = { ...input.settlement.totals };
  const target = Math.max(0, Math.round((gross - rake - bbjFee) * 100) / 100);
  if (rake + bbjFee > 0) {
    const cents = scaleWinnerCentsForRake(
      ids.map((id) => net[id]),
      target
    );
    ids.forEach((id, i) => {
      net[id] = cents[i] / 100;
    });
  }
  if (Math.abs(Object.values(net).reduce((a, v) => a + v, 0) + rake + bbjFee - gross) > 1e-6)
    throw new Error('joint_deductions_conservation');
  return {
    netTotals: net,
    rake,
    bbjFee,
    gross,
    net: target,
    refunds: { ...input.settlement.refunds },
  };
}
