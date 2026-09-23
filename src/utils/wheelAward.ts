import type { WheelSegment, WheelSpinResult } from '../services/DiamondWheelService';
import { WHEEL_V4_TOTAL } from './wheelV4Model';

const gameNames = ['plinko', 'crash', 'crossing', 'mines'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The three cards a VIP is shown instead of a throwable, a time bank and a rabbit hunt. */
const vipChipMultipliers: Readonly<Record<number, number>> = { 3: 0.2, 6: 0.25, 9: 0.3 };
const fail = (): never => {
  throw new Error('The Wheel Award Could Not Be Confirmed. Recover The Same Spin');
};

/** Validate the server's v3 quote, without choosing prizes or assigning odds. */
export function assertWheelUpgradeTable(
  table: WheelSegment[] | undefined,
  entry: number,
  rate: number
): asserts table is WheelSegment[] {
  const games = table?.filter((s) => s.kind === 'bonus') ?? [];
  const chips = table?.filter((s) => s.kind === 'chips') ?? [];
  if (
    !table ||
    table.length !== 8 ||
    !Number.isSafeInteger(entry) ||
    entry < 25 ||
    entry > 2500 ||
    !Number.isSafeInteger(rate) ||
    rate <= 0 ||
    new Set(table.map((s) => s.ord)).size !== 8 ||
    games.length !== 4 ||
    gameNames.some((game) => games.filter((s) => s.game === game).length !== 1) ||
    chips.length !== 4 ||
    [5, 10, 25, 100].some(
      (multiplier) => chips.filter((s) => s.multiplier === multiplier).length !== 1
    ) ||
    table.some(
      (s) =>
        !Number.isSafeInteger(s.ord) ||
        s.ord < 1 ||
        s.ord > 8 ||
        s.locked ||
        !Number.isSafeInteger(s.weight) ||
        s.weight <= 0 ||
        !Number.isFinite(s.probability) ||
        s.probability !== s.weight / 100000
    ) ||
    table.reduce((sum, s) => sum + s.weight, 0) !== 100000 ||
    games.some(
      (s) => s.multiplier !== 2 || s.amount !== entry * 2 || s.value_chips !== (entry * 2) / rate
    ) ||
    chips.some(
      (s) =>
        s.game !== undefined ||
        s.amount !== (entry * s.multiplier!) / rate ||
        s.value_chips !== s.amount
    )
  )
    fail();
}

/** A reveal must never invent a missing game, secondary result, or funded award. */
export function assertWheelAward(receipt: WheelSpinResult): void {
  const { outcome, bonus, secondary } = receipt;
  const version = receipt.contract_version;
  const versioned = version === 2 || version === 3 || version === 4;
  // CONTRACT 4 (owner rulings 2026-09-21). Three things change shape here: the
  // published table no longer has to be what this one spin drew from, because
  // no prize may repeat (R12); the three item cards are chip cards for a VIP
  // (R2); and Diamonds pays nothing at the spin, opening a sealed three-card
  // game instead (R15). Contracts 2 and 3 keep every rule they had.
  const v4 = version === 4;
  const vip = v4 && receipt.vip === true;
  if (v4 && (receipt.model !== 'wheel-v4' || typeof receipt.vip !== 'boolean')) fail();
  if (
    ![
      'nothing',
      'chips',
      'diamonds',
      'bonus',
      'upgrade',
      'throwables',
      'time_bank',
      'rabbit_hunt',
    ].includes(outcome.kind)
  )
    fail();
  if (versioned) {
    const table = receipt.segments;
    const kinds = table?.map((s) => s.kind) ?? [];
    const games = table?.filter((s) => s.kind === 'bonus').map((s) => s.game) ?? [];
    const weights = receipt.fairness.weights;
    const drawn = v4 ? weights : undefined;
    if (
      receipt.fairness.domain !== `wheel-v${receipt.contract_version}` ||
      !table ||
      table.length !== 12 ||
      new Set(table.map((s) => s.ord)).size !== 12 ||
      kinds.filter((k) => k === 'bonus').length !== 4 ||
      new Set(games).size !== 4 ||
      gameNames.some((g) => !games.includes(g)) ||
      kinds.filter((k) => k === 'chips').length !== (vip ? 6 : 3) ||
      (vip && kinds.some((k) => ['throwables', 'time_bank', 'rabbit_hunt'].includes(k))) ||
      (!vip &&
        ['throwables', 'time_bank', 'rabbit_hunt'].some(
          (k) => kinds.filter((v) => v === k).length !== 1
        )) ||
      ['upgrade', 'diamonds'].some((k) => kinds.filter((v) => v === k).length !== 1) ||
      (vip &&
        Object.entries(vipChipMultipliers).some(
          ([ord, multiplier]) =>
            table.find((s) => s.ord === Number(ord))?.multiplier !== multiplier ||
            table.find((s) => s.ord === Number(ord))?.kind !== 'chips'
        )) ||
      table.some(
        (s) =>
          !Number.isSafeInteger(s.ord) ||
          s.ord < 1 ||
          s.locked ||
          !Number.isSafeInteger(s.weight) ||
          s.weight <= 0
      ) ||
      // The published table keeps its base weights from contract 4 on; what the
      // draw actually used is the separate `weights` row, which is what the
      // total and the eligible list have to agree with.
      (v4
        ? !drawn ||
          drawn.length !== 12 ||
          drawn.some((w) => !Number.isSafeInteger(w) || w < 0) ||
          table.reduce((sum, s) => sum + s.weight, 0) !== WHEEL_V4_TOTAL ||
          drawn.reduce((sum, w) => sum + w, 0) !== receipt.fairness.weight_total ||
          drawn.filter((w) => w > 0).length !== receipt.fairness.eligible_ords.length ||
          drawn.some((w, i) => w > 0 !== receipt.fairness.eligible_ords.includes(i + 1)) ||
          drawn[outcome.ord - 1] <= 0 ||
          receipt.fairness.previous === undefined
        : table.reduce((sum, s) => sum + s.weight, 0) !== receipt.fairness.weight_total ||
          new Set(receipt.fairness.eligible_ords).size !== 12 ||
          table.some((s) => !receipt.fairness.eligible_ords.includes(s.ord))) ||
      !Number.isSafeInteger(receipt.fairness.roll) ||
      receipt.fairness.roll < 0 ||
      receipt.fairness.roll >= 2 ** 48 ||
      !Number.isSafeInteger(receipt.fairness.nonce) ||
      receipt.fairness.nonce < 1 ||
      !table.some(
        (s) =>
          s.ord === outcome.ord &&
          s.kind === outcome.kind &&
          s.game === outcome.game &&
          s.multiplier === outcome.multiplier
      ) ||
      outcome.kind === 'nothing' ||
      (!['bonus', 'upgrade'].includes(outcome.kind) && outcome.amount <= 0)
    )
      fail();
  }
  // A Diamonds outcome under contract 4 is a sealed card game, never a payment:
  // it names its award and what it risks, and it never carries the three values.
  if (v4 && outcome.kind === 'diamonds') {
    if (
      !outcome.cards ||
      !uuid.test(outcome.cards.award_id) ||
      outcome.cards.status !== 'pending' ||
      !Number.isSafeInteger(outcome.cards.risk_diamonds) ||
      outcome.cards.risk_diamonds !== receipt.entry_value_diamonds ||
      outcome.amount !== outcome.cards.risk_diamonds ||
      Object.keys(outcome.cards).length !== 3
    )
      fail();
    // Under contract 3 a Diamonds outcome PAID at the spin, and its own rules
    // above already pin that. A `cards` block on an older receipt is a field a
    // newer server added, not a game the browser may open, so it is ignored.
  } else if (v4 && outcome.cards) fail();
  if (!Number.isFinite(outcome.amount) || outcome.amount < 0) fail();
  if (vip && (['throwables', 'time_bank', 'rabbit_hunt'].includes(outcome.kind) || outcome.grants))
    fail();
  if (versioned && ['throwables', 'time_bank', 'rabbit_hunt'].includes(outcome.kind)) {
    const feature = {
      throwables: 'throwable',
      time_bank: 'time_bank_seconds',
      rabbit_hunt: 'rabbit_hunt',
    }[outcome.kind as 'throwables' | 'time_bank' | 'rabbit_hunt'];
    if (
      !outcome.grants?.length ||
      outcome.grants.some(
        (g) =>
          !['throwable', 'time_bank_seconds', 'rabbit_hunt'].includes(g.feature) ||
          !Number.isSafeInteger(g.uses) ||
          g.uses <= 0
      ) ||
      outcome.grants.find((g) => g.feature === feature)?.uses !== outcome.amount
    )
      fail();
  }
  if (outcome.kind !== 'bonus' && outcome.kind !== 'upgrade') {
    if (bonus || secondary) fail();
    return;
  }
  if (outcome.kind === 'upgrade') {
    const count = version === 3 || version === 4 ? 8 : 4;
    if (!secondary || secondary.segments.length !== count) return fail();
    if (version === 3 || version === 4) {
      assertWheelUpgradeTable(
        secondary.segments,
        receipt.entry_value_diamonds!,
        receipt.diamonds_per_chip
      );
      if (
        outcome.amount !== receipt.entry_value_diamonds! * 2 ||
        outcome.value_chips !== (receipt.entry_value_diamonds! * 2) / receipt.diamonds_per_chip
      )
        fail();
    } else {
      if (
        new Set(secondary.segments.map((s) => s.game)).size !== 4 ||
        secondary.segments.some(
          (s) => s.kind !== 'bonus' || !s.game || !gameNames.includes(s.game)
        ) ||
        secondary.outcome.kind !== 'bonus'
      )
        fail();
    }
    const selected = secondary.segments.find((s) => s.ord === secondary.outcome.ord);
    if (
      new Set(secondary.segments.map((s) => s.ord)).size !== count ||
      secondary.segments.some((s) => !Number.isSafeInteger(s.ord) || s.ord <= 0 || s.locked) ||
      !selected ||
      selected.kind !== secondary.outcome.kind ||
      selected.game !== secondary.outcome.game ||
      selected.multiplier !== secondary.outcome.multiplier ||
      ((version === 3 || version === 4) &&
        (selected.amount !== secondary.outcome.amount ||
          selected.value_chips !== secondary.outcome.value_chips ||
          selected.weight !== secondary.outcome.weight ||
          selected.probability !== secondary.outcome.probability ||
          secondary.outcome.locked)) ||
      secondary.segments.some((s) => !Number.isSafeInteger(s.weight) || s.weight <= 0) ||
      (v4
        ? !secondary.fairness.weights ||
          secondary.fairness.weights.length !== count ||
          secondary.fairness.weights.some((w) => !Number.isSafeInteger(w) || w < 0) ||
          secondary.segments.reduce((sum, s) => sum + s.weight, 0) !== WHEEL_V4_TOTAL ||
          secondary.fairness.weights.reduce((sum, w) => sum + w, 0) !==
            secondary.fairness.weight_total ||
          secondary.fairness.weights.filter((w) => w > 0).length !==
            secondary.fairness.eligible_ords.length ||
          secondary.fairness.weights.some(
            (w, i) => w > 0 !== secondary.fairness.eligible_ords.includes(i + 1)
          ) ||
          secondary.fairness.weights[secondary.outcome.ord - 1] <= 0
        : new Set(secondary.fairness.eligible_ords).size !== count ||
          secondary.segments.some((s) => !secondary.fairness.eligible_ords.includes(s.ord)) ||
          secondary.fairness.weight_total !==
            secondary.segments.reduce((sum, s) => sum + s.weight, 0)) ||
      !Number.isSafeInteger(secondary.fairness.roll) ||
      secondary.fairness.roll < 0 ||
      secondary.fairness.roll >= 2 ** 48 ||
      secondary.fairness.commit_id !== receipt.fairness.commit_id ||
      secondary.fairness.server_seed_hash !== receipt.fairness.server_seed_hash ||
      secondary.fairness.server_seed !== receipt.fairness.server_seed ||
      secondary.fairness.client_seed !== receipt.fairness.client_seed ||
      secondary.fairness.nonce !== receipt.fairness.nonce ||
      (versioned && secondary.fairness.domain !== `wheel-v${receipt.contract_version}-upgrade`)
    )
      fail();
    if (secondary.outcome.kind === 'chips') {
      // Instant chips are already credited by the spin transaction. They may
      // never masquerade as a funded game or require a second payout request.
      if ((version !== 3 && version !== 4) || bonus) fail();
      return;
    }
  }
  if (
    !bonus ||
    !uuid.test(bonus.id) ||
    !gameNames.includes(bonus.game) ||
    !Number.isSafeInteger(bonus.base_diamonds) ||
    bonus.base_diamonds < 25 ||
    bonus.base_diamonds > 5000 ||
    bonus.boost_multiplier !== (outcome.kind === 'upgrade' ? 2 : 1)
  )
    fail();
  if (
    versioned &&
    (!Number.isSafeInteger(bonus!.entry_diamonds) ||
      bonus!.entry_diamonds < 25 ||
      bonus!.entry_diamonds > 2500 ||
      bonus!.entry_diamonds !== receipt.entry_value_diamonds ||
      bonus!.base_diamonds !== bonus!.entry_diamonds * bonus!.boost_multiplier)
  )
    fail();
  if (outcome.kind === 'bonus') {
    if (secondary || outcome.game !== bonus?.game) fail();
    return;
  }
  if (secondary?.outcome.game !== bonus?.game) fail();
}
