import type { WheelSpinResult } from '../services/DiamondWheelService';

const gameNames = ['plinko', 'crash', 'crossing', 'mines'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A reveal must never invent a missing game, secondary result, or funded award. */
export function assertWheelAward(receipt: WheelSpinResult): void {
  const { outcome, bonus, secondary } = receipt;
  const fail = (): never => {
    throw new Error('The Wheel Award Could Not Be Confirmed. Recover The Same Spin');
  };
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
  if (receipt.contract_version === 2) {
    const table = receipt.segments;
    const kinds = table?.map((s) => s.kind) ?? [];
    const games = table?.filter((s) => s.kind === 'bonus').map((s) => s.game) ?? [];
    if (
      receipt.fairness.domain !== 'wheel-v2' ||
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
  if (
    receipt.contract_version === 2 &&
    ['throwables', 'time_bank', 'rabbit_hunt'].includes(outcome.kind)
  ) {
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
    receipt.contract_version === 2 &&
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
  if (!secondary || secondary.segments.length !== 4) {
    fail();
    return;
  }
  const games = new Set(secondary.segments.map((s) => s.game));
  const ords = new Set(secondary.segments.map((s) => s.ord));
  if (
    games.size !== 4 ||
    ords.size !== 4 ||
    secondary.segments.some(
      (s) =>
        s.kind !== 'bonus' ||
        !s.game ||
        !gameNames.includes(s.game) ||
        !Number.isSafeInteger(s.ord) ||
        s.ord <= 0 ||
        s.locked
    ) ||
    secondary.outcome.kind !== 'bonus' ||
    secondary.outcome.game !== bonus?.game ||
    !secondary.segments.some(
      (s) => s.ord === secondary.outcome.ord && s.game === secondary.outcome.game
    ) ||
    new Set(secondary.fairness.eligible_ords).size !== 4 ||
    secondary.segments.some((s) => !secondary.fairness.eligible_ords.includes(s.ord)) ||
    secondary.segments.some((s) => !Number.isSafeInteger(s.weight) || s.weight <= 0) ||
    secondary.fairness.weight_total !== secondary.segments.reduce((sum, s) => sum + s.weight, 0) ||
    !Number.isSafeInteger(secondary.fairness.roll) ||
    secondary.fairness.roll < 0 ||
    secondary.fairness.roll >= 2 ** 48 ||
    secondary.fairness.commit_id !== receipt.fairness.commit_id ||
    secondary.fairness.server_seed_hash !== receipt.fairness.server_seed_hash ||
    secondary.fairness.server_seed !== receipt.fairness.server_seed ||
    secondary.fairness.client_seed !== receipt.fairness.client_seed ||
    secondary.fairness.nonce !== receipt.fairness.nonce ||
    (receipt.contract_version === 2 && secondary.fairness.domain !== 'wheel-v2-upgrade')
  )
    fail();
}
