import type { WheelSegment, WheelSpinResult } from '../services/DiamondWheelService';

const gameNames = ['plinko', 'crash', 'crossing', 'mines'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const versioned = receipt.contract_version === 2 || receipt.contract_version === 3;
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
    if (
      receipt.fairness.domain !== `wheel-v${receipt.contract_version}` ||
      !table ||
      table.length !== 12 ||
      new Set(table.map((s) => s.ord)).size !== 12 ||
      kinds.filter((k) => k === 'bonus').length !== 4 ||
      new Set(games).size !== 4 ||
      gameNames.some((g) => !games.includes(g)) ||
      kinds.filter((k) => k === 'chips').length !== 3 ||
      ['upgrade', 'throwables', 'time_bank', 'rabbit_hunt', 'diamonds'].some(
        (k) => kinds.filter((v) => v === k).length !== 1
      ) ||
      table.some(
        (s) =>
          !Number.isSafeInteger(s.ord) ||
          s.ord < 1 ||
          s.locked ||
          !Number.isSafeInteger(s.weight) ||
          s.weight <= 0
      ) ||
      table.reduce((sum, s) => sum + s.weight, 0) !== receipt.fairness.weight_total ||
      new Set(receipt.fairness.eligible_ords).size !== 12 ||
      table.some((s) => !receipt.fairness.eligible_ords.includes(s.ord)) ||
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
  if (!Number.isFinite(outcome.amount) || outcome.amount < 0) fail();
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
    const count = receipt.contract_version === 3 ? 8 : 4;
    if (!secondary || secondary.segments.length !== count) return fail();
    if (receipt.contract_version === 3) {
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
      (receipt.contract_version === 3 &&
        (selected.amount !== secondary.outcome.amount ||
          selected.value_chips !== secondary.outcome.value_chips ||
          selected.weight !== secondary.outcome.weight ||
          selected.probability !== secondary.outcome.probability ||
          secondary.outcome.locked)) ||
      new Set(secondary.fairness.eligible_ords).size !== count ||
      secondary.segments.some((s) => !secondary.fairness.eligible_ords.includes(s.ord)) ||
      secondary.segments.some((s) => !Number.isSafeInteger(s.weight) || s.weight <= 0) ||
      secondary.fairness.weight_total !==
        secondary.segments.reduce((sum, s) => sum + s.weight, 0) ||
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
      if (receipt.contract_version !== 3 || bonus) fail();
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
