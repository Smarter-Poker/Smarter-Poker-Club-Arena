import type { Pot, SeatPlayer } from '../../types.js';
import type { TournamentUtilityShowdownSample } from '../HorseTournamentUtility.js';
import { calculatePots } from '../PokerEngine.js';

const unitsOf = (amount: number, unit: number) => {
  const value = amount / unit;
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1e9 ||
    Math.abs(value - Math.round(value)) > 1e-6
  )
    throw new Error('joint_pots_invalid_chip_amount');
  return Math.round(value);
};

/** Prepare hypothetical seats after their candidate investments. This is
 * memory-only: no controller state or wallet is changed. Unmatched live
 * contributions are refunded before pot construction, as at settlement;
 * individual antes and shared dead money retain their distinct pot rights. */
export function prepareJointPots(players: readonly SeatPlayer[], chipUnit: 0.01 | 1) {
  if (
    ![0.01, 1].includes(chipUnit) ||
    players.length < 2 ||
    players.length > 10 ||
    new Set(players.map((p) => p.user_id)).size !== players.length ||
    new Set(players.map((p) => p.seat)).size !== players.length
  )
    throw new Error('joint_pots_invalid_seats');
  const seats = players.map((p) => {
    if (!p.user_id || !Number.isInteger(p.seat) || p.seat < 1 || p.seat > 10)
      throw new Error('joint_pots_invalid_seats');
    for (const amount of [
      p.stack,
      p.bet,
      p.totalInvested,
      p.deadInvested ?? 0,
      p.individualAnteInvested ?? 0,
    ])
      unitsOf(amount, chipUnit);
    if (
      (p.individualAnteInvested ?? 0) > (p.deadInvested ?? 0) ||
      (p.deadInvested ?? 0) > p.totalInvested ||
      p.bet > p.totalInvested
    )
      throw new Error('joint_pots_invalid_investment');
    return { ...p, cards: [] };
  });
  const refunds: Record<string, number> = Object.fromEntries(players.map((p) => [p.user_id, 0]));
  const live = seats
    .map((p) => ({ p, units: unitsOf(p.totalInvested - (p.deadInvested ?? 0), chipUnit) }))
    .sort((a, b) => b.units - a.units);
  if (!live[0].p.is_folded && live[0].units > live[1].units) {
    const refund = (live[0].units - live[1].units) * chipUnit;
    const player = live[0].p;
    refunds[player.user_id] = refund;
    player.stack = (unitsOf(player.stack, chipUnit) + unitsOf(refund, chipUnit)) * chipUnit;
    player.totalInvested =
      (unitsOf(player.totalInvested, chipUnit) - unitsOf(refund, chipUnit)) * chipUnit;
    player.bet = Math.max(0, Math.round((player.bet - refund) / chipUnit)) * chipUnit;
  }
  const pots = calculatePots(seats).map((p) => ({
    amount: unitsOf(p.amount, chipUnit) * chipUnit,
    eligiblePlayers: [...p.eligiblePlayers],
  }));
  if (
    pots.some((p) => p.eligiblePlayers.length === 0) ||
    Math.abs(
      pots.reduce((n, p) => n + p.amount, 0) +
        Object.values(refunds).reduce((a, b) => a + b, 0) -
        players.reduce((n, p) => n + p.totalInvested, 0)
    ) >
      chipUnit / 1e4
  )
    throw new Error('joint_pots_conservation');
  return { seats, pots, refunds, chipUnit };
}

export interface JointPotAward {
  potIndex: number;
  boardIndex: number;
  half: 'high' | 'low';
  playerId: string;
  amount: number;
}

/** The shared board/pot scorer used by the Phase13 candidate calculation.
 * Independent benchmark references certify this result; none are imported
 * here. Amounts and tie remainders use actual settlement units and the button. */
export function settleJointScores(input: {
  prepared: ReturnType<typeof prepareJointPots>;
  heroId: string;
  opponentIds: string[];
  sample: TournamentUtilityShowdownSample;
  splitLow: boolean;
  dealerSeat: number;
}) {
  const { prepared, sample, heroId, opponentIds } = input;
  const { chipUnit, seats, pots } = prepared;
  const boardCount = sample.boards.length;
  if (
    ![1, 2, 3].includes(boardCount) ||
    !Number.isInteger(input.dealerSeat) ||
    input.dealerSeat < 1 ||
    input.dealerSeat > 10 ||
    !seats.some((p) => p.user_id === heroId) ||
    opponentIds.includes(heroId) ||
    new Set(opponentIds).size !== opponentIds.length ||
    opponentIds.some((id) => !seats.some((p) => p.user_id === id))
  )
    throw new Error('joint_scores_invalid_identity');
  for (const board of sample.boards) {
    if (
      board.opponentHigh.length !== opponentIds.length ||
      board.opponentLow.length !== opponentIds.length ||
      ![board.heroHigh, ...board.opponentHigh].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      ![board.heroLow, ...board.opponentLow].every(
        (n) => n === null || (Number.isSafeInteger(n) && n >= 0)
      )
    )
      throw new Error('joint_scores_invalid_sample');
  }
  const awards: JointPotAward[] = [];
  const totals: Record<string, number> = Object.fromEntries(seats.map((p) => [p.user_id, 0]));
  const boardTotals = sample.boards.map(() => ({ ...totals }));
  const order = (ids: string[]) =>
    seats
      .filter((p) => ids.includes(p.user_id))
      .sort(
        (a, b) =>
          Number(a.seat <= input.dealerSeat) - Number(b.seat <= input.dealerSeat) || a.seat - b.seat
      );
  const award = (
    units: number,
    winners: string[],
    potIndex: number,
    boardIndex: number,
    half: JointPotAward['half']
  ) => {
    if (!winners.length) throw new Error('joint_scores_no_winner');
    order(winners).forEach((p, index) => {
      const amount =
        (Math.floor(units / winners.length) + Number(index < units % winners.length)) * chipUnit;
      if (amount > 0) awards.push({ potIndex, boardIndex, half, playerId: p.user_id, amount });
      totals[p.user_id] += amount;
      boardTotals[boardIndex][p.user_id] += amount;
    });
  };
  for (let potIndex = 0; potIndex < pots.length; potIndex++) {
    const pot = pots[potIndex],
      units = unitsOf(pot.amount, chipUnit);
    for (let boardIndex = 0; boardIndex < boardCount; boardIndex++) {
      const boardUnits = Math.floor(units / boardCount) + Number(boardIndex < units % boardCount);
      const board = sample.boards[boardIndex];
      const scores = pot.eligiblePlayers.map((id) => {
        if (id === heroId) return { id, high: board.heroHigh, low: board.heroLow };
        const index = opponentIds.indexOf(id);
        if (index < 0) throw new Error('joint_scores_missing_contender');
        return { id, high: board.opponentHigh[index], low: board.opponentLow[index] };
      });
      const high = Math.max(...scores.map((s) => s.high));
      const lows = input.splitLow ? scores.filter((s) => s.low !== null) : [];
      const low = lows.length ? Math.min(...lows.map((s) => s.low!)) : null;
      award(
        low === null ? boardUnits : Math.ceil(boardUnits / 2),
        scores.filter((s) => s.high === high).map((s) => s.id),
        potIndex,
        boardIndex,
        'high'
      );
      if (low !== null)
        award(
          Math.floor(boardUnits / 2),
          lows.filter((s) => s.low === low).map((s) => s.id),
          potIndex,
          boardIndex,
          'low'
        );
    }
  }
  const resultingStacks = Object.fromEntries(
    seats.map((p) => [p.user_id, p.stack + totals[p.user_id]])
  );
  const distributed = Object.values(totals).reduce((a, b) => a + b, 0);
  if (Math.abs(distributed - pots.reduce((n, p) => n + p.amount, 0)) > chipUnit / 1e4)
    throw new Error('joint_scores_conservation');
  return { awards, totals, boardTotals, resultingStacks, refunds: prepared.refunds };
}

/** Retain the joint distribution rather than averaging independently sampled
 * boards. Covariance is measured from the same physical deal in each row.
 * This is gross settlement evidence; the caller must price applicable rake. */
export function jointPotDistribution(
  input: Omit<Parameters<typeof settleJointScores>[0], 'sample'> & {
    samples: TournamentUtilityShowdownSample[];
  }
) {
  if (!input.samples.length || input.samples.length > 128)
    throw new Error('joint_distribution_invalid_samples');
  const rows = input.samples.map((sample) => settleJointScores({ ...input, sample }));
  const boardCount = input.samples[0].boards.length;
  if (rows.some((row) => row.boardTotals.length !== boardCount))
    throw new Error('joint_distribution_board_mismatch');
  const n = rows.length;
  const pots: Pot[] = input.prepared.pots.filter((p) => p.eligiblePlayers.includes(input.heroId));
  const eligiblePot = pots.reduce((a, p) => a + p.amount, 0);
  const returns = rows.map((r) => r.totals[input.heroId]);
  const boardMeans = Array.from(
    { length: boardCount },
    (_, b) => rows.reduce((s, row) => s + row.boardTotals[b][input.heroId], 0) / n
  );
  const covariance = boardMeans.map((mean, a) =>
    boardMeans.map((other, b) =>
      n > 1
        ? rows.reduce(
            (s, row) =>
              s +
              (row.boardTotals[a][input.heroId] - mean) *
                (row.boardTotals[b][input.heroId] - other),
            0
          ) /
          (n - 1)
        : null
    )
  );
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : null;
  const histogram = new Map<number, number>();
  for (const value of returns) {
    const units = Math.round(value / input.prepared.chipUnit);
    histogram.set(units, (histogram.get(units) ?? 0) + 1);
  }
  return {
    samples: n,
    eligiblePot,
    expectedAward: mean,
    heroRefund: input.prepared.refunds[input.heroId],
    expectedReturn: mean + input.prepared.refunds[input.heroId],
    standardError: variance === null ? null : Math.sqrt(variance / n),
    // This bound covers Monte Carlo uncertainty under the declared heuristic
    // sampler only; it does not certify range-model accuracy.
    samplingRadius99: eligiblePot * Math.sqrt(Math.log(200) / (2 * n)),
    variance,
    boardMeans,
    covariance,
    scoopProbability:
      eligiblePot > 0 ? returns.filter((v) => Math.abs(v - eligiblePot) < 1e-7).length / n : 0,
    quarterOrLessProbability:
      eligiblePot > 0
        ? returns.filter((v) => v > 0 && v / eligiblePot <= 0.25 + 1e-9).length / n
        : 0,
    distribution: [...histogram]
      .sort(([a], [b]) => a - b)
      .map(([units, count]) => ({
        award: units * input.prepared.chipUnit,
        probability: count / n,
      })),
    perPot: input.prepared.pots.map((pot, potIndex) => ({
      ...pot,
      expectedHeroAward:
        rows.reduce(
          (s, row) =>
            s +
            row.awards
              .filter((a) => a.playerId === input.heroId && a.potIndex === potIndex)
              .reduce((sum, a) => sum + a.amount, 0),
          0
        ) / n,
    })),
  };
}
