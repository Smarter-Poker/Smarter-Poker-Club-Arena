import type { EconomicsRow } from './diamondCashRakeSchedule.js';

export interface DiamondCashJackpotSchedule {
  readonly enabled: boolean;
  readonly drop: number;
  readonly minDealtIn: number;
  readonly minPot: number;
  readonly excludedVariants: readonly string[];
  readonly qualifyingHands: Readonly<Record<string, string>>;
  readonly miniEnabled: boolean;
  readonly miniAmount: number;
  readonly miniReserveFloor: number;
}

export const diamondJackpotSettingNames = [
  'bbj_enabled',
  'bbj_drop_per_hand',
  'bbj_min_dealt_in',
  'bbj_min_pot',
  'bbj_excluded_games',
  'bbj_qualifying_hand',
  'mini_bbj_enabled',
  'mini_bbj_amount',
  'mini_bbj_reserve_floor',
] as const;

function setting(rows: readonly EconomicsRow[], name: string, scope = 'all'): EconomicsRow {
  const row = rows
    .filter((r) => r.name === name && r.scope === scope)
    .sort(
      (a, b) => Date.parse(String(b.recorded_at)) - Date.parse(String(a.recorded_at)) || b.id - a.id
    )[0];
  if (!row) throw new Error('diamond_economics_unset:' + name + '/' + scope);
  return row;
}

function whole(rows: readonly EconomicsRow[], name: string, scope = 'all'): number {
  const raw = setting(rows, name, scope).value;
  const value = Number(raw);
  if (
    (typeof raw !== 'number' && typeof raw !== 'string') ||
    (typeof raw === 'string' && !/^(?:0|[1-9][0-9]*)(?:[.]0+)?$/.test(raw)) ||
    !Number.isSafeInteger(value) ||
    value < 0
  )
    throw new Error('diamond_economics_unreadable:' + name + '/' + scope);
  return value;
}

function word(rows: readonly EconomicsRow[], name: string): string {
  const value = setting(rows, name).value_text;
  if (typeof value !== 'string' || !value)
    throw new Error('diamond_economics_unset:' + name + '/all');
  return value;
}

function switchOn(rows: readonly EconomicsRow[], name: string): boolean {
  const value = word(rows, name);
  if (value !== 'yes' && value !== 'no')
    throw new Error('diamond_economics_unreadable:' + name + '/all');
  return value === 'yes';
}

/** No chip price or fallback; an off switch needs no new rolling-upgrade values. */
export function resolveDiamondCashJackpotSchedule(
  rows: readonly EconomicsRow[],
  bigBlind: number
): DiamondCashJackpotSchedule {
  if (!Number.isSafeInteger(bigBlind) || bigBlind <= 0)
    throw new Error('diamond_jackpot_stake_not_whole');
  const enabled = switchOn(rows, 'bbj_enabled');
  if (!enabled)
    return {
      enabled: false,
      drop: 0,
      minDealtIn: 0,
      minPot: 0,
      excludedVariants: [],
      qualifyingHands: {},
      miniEnabled: false,
      miniAmount: 0,
      miniReserveFloor: 0,
    };
  const scope = 'bb:' + bigBlind;
  const qualifyingHands: Record<string, string> = {};
  for (const item of word(rows, 'bbj_qualifying_hand').split(',')) {
    const [variant, hand, extra] = item.split('=');
    if (!variant || !hand || extra || qualifyingHands[variant])
      throw new Error('diamond_jackpot_qualifying_map_invalid');
    qualifyingHands[variant] = hand;
  }
  const miniEnabled = switchOn(rows, 'mini_bbj_enabled');
  const minDealtIn = whole(rows, 'bbj_min_dealt_in');
  if (minDealtIn < 2 || minDealtIn > 10) throw new Error('diamond_jackpot_invalid_dealt_floor');
  return {
    enabled: true,
    drop: whole(rows, 'bbj_drop_per_hand', scope),
    minDealtIn,
    minPot: whole(rows, 'bbj_min_pot', scope),
    excludedVariants: word(rows, 'bbj_excluded_games').split(','),
    qualifyingHands,
    miniEnabled,
    miniAmount: miniEnabled ? whole(rows, 'mini_bbj_amount', scope) : 0,
    miniReserveFloor: miniEnabled ? whole(rows, 'mini_bbj_reserve_floor') : 0,
  };
}

export interface DiamondJackpotHandFacts {
  pot: number;
  dealtIn: number;
  sawFlop: boolean;
  variant: string;
  doubleBoard: boolean;
}

/** Fixed whole-Diamond fee on eligible flops; the pot floor belongs only to a hit. */
export function priceDiamondCashJackpotDrop(
  schedule: DiamondCashJackpotSchedule,
  facts: DiamondJackpotHandFacts
): number {
  if (
    !Number.isSafeInteger(facts.pot) ||
    facts.pot < 0 ||
    !Number.isSafeInteger(facts.dealtIn) ||
    facts.dealtIn < 0 ||
    typeof facts.sawFlop !== 'boolean' ||
    typeof facts.doubleBoard !== 'boolean'
  )
    throw new Error('diamond_jackpot_invalid_hand_facts');
  if (
    !schedule.enabled ||
    !facts.sawFlop ||
    facts.doubleBoard ||
    facts.dealtIn < schedule.minDealtIn ||
    !schedule.qualifyingHands[facts.variant] ||
    schedule.excludedVariants.includes(facts.variant)
  )
    return 0;
  if (!Number.isSafeInteger(schedule.drop) || schedule.drop < 0 || schedule.drop > facts.pot)
    throw new Error('diamond_jackpot_drop_exceeds_pot');
  return schedule.drop;
}
