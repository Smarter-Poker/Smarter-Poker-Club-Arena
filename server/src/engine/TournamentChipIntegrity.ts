import type { GameState, HandConfig, HandEvent, SeatPlayer } from '../types.js';

/**
 * Tournament chips are counters, not currency. There is no smaller settlement
 * unit than one chip, so accepting a fractional value anywhere upstream only
 * postpones the failure until settlement (or, worse, silently rounds money
 * between players). Cash games deliberately keep their existing cent scale.
 */
export const TOURNAMENT_WHOLE_CHIP_ERROR = 'Tournament chip amounts must be whole chips';

/** Largest whole value representable by table_seats.stack numeric(15,2). */
export const TOURNAMENT_MAX_WHOLE_CHIPS = 9_999_999_999_999;

export function isWholeTournamentChip(value: unknown, allowNegative = false): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value <= TOURNAMENT_MAX_WHOLE_CHIPS &&
    (allowNegative ? value >= -TOURNAMENT_MAX_WHOLE_CHIPS : value >= 0)
  );
}

/**
 * Decode a database value without changing its denomination. PostgREST can
 * return exact numeric values as strings, but no caller may floor, round or
 * default malformed tournament state into a seemingly valid stack.
 */
export function readWholeTournamentChip(value: unknown): number | null {
  const decoded =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return isWholeTournamentChip(decoded) ? decoded : null;
}

/**
 * A per-hand cap is a cash-table feature. Resolve the cash amount in one place
 * so neither the human nor horse path can accidentally apply a copied cap flag
 * to a tournament (especially a fractional cap_bb).
 */
export function cashHandCapChips(
  isTournament: boolean,
  enabled: unknown,
  capBBValue: unknown,
  bigBlindValue: unknown
): number {
  if (isTournament || enabled !== true) return 0;
  const capBB = Number(capBBValue);
  const bigBlind = Number(bigBlindValue);
  if (!Number.isFinite(capBB) || capBB <= 0 || !Number.isFinite(bigBlind) || bigBlind <= 0) {
    return 0;
  }
  return capBB * bigBlind;
}

export type CanonicalTournamentBlindStructure =
  | { ok: true; levels: Array<Record<string, any>> }
  | { ok: false; reason: string };

/**
 * Validate and canonicalize the persisted ladder before the manager can cache
 * it or mutate a roster/table. The database intentionally accepts historical
 * blind aliases; manager consumers intentionally read one shape. Bridging the
 * two here prevents a valid `sb`/`bb` row from becoming undefined blinds after
 * it has already passed the integrity gate.
 */
export function canonicalTournamentBlindStructure(
  structure: unknown
): CanonicalTournamentBlindStructure {
  if (!Array.isArray(structure)) return { ok: false, reason: 'blind_structure is not an array' };
  if (structure.length === 0) return { ok: false, reason: 'blind_structure is empty' };

  const levels: Array<Record<string, any>> = [];
  let playableLevels = 0;
  for (const [index, rawLevel] of structure.entries()) {
    if (!rawLevel || typeof rawLevel !== 'object' || Array.isArray(rawLevel)) {
      return { ok: false, reason: `blind_structure[${index}] is not an object` };
    }
    const level = rawLevel as Record<string, any>;
    if (level.isBreak === true) {
      levels.push({ ...level, isBreak: true });
      continue;
    }
    const firstPresent = (keys: readonly string[]): unknown => {
      for (const key of keys) {
        if (level[key] !== null && level[key] !== undefined) return level[key];
      }
      return undefined;
    };
    const smallValue = firstPresent(['smallBlind', 'small_blind', 'small', 'sb']);
    const bigValue = firstPresent(['bigBlind', 'big_blind', 'big', 'bb']);
    const smallBlind = readWholeTournamentChip(smallValue);
    const bigBlind = readWholeTournamentChip(bigValue);
    const ante = readWholeTournamentChip(level.ante ?? 0);
    if (smallBlind === null) {
      return {
        ok: false,
        reason: `blind_structure[${index}].smallBlind=${String(smallValue)}`,
      };
    }
    if (bigBlind === null || bigBlind <= 0) {
      return {
        ok: false,
        reason: `blind_structure[${index}].bigBlind=${String(bigValue)}`,
      };
    }
    if (ante === null) {
      return {
        ok: false,
        reason: `blind_structure[${index}].ante=${String(level.ante)}`,
      };
    }
    playableLevels += 1;
    levels.push({ ...level, smallBlind, bigBlind, ante });
  }
  if (playableLevels === 0) {
    return { ok: false, reason: 'blind_structure has no playable level' };
  }
  return { ok: true, levels };
}

/** Validate persisted tournament chip configuration before launch/resume writes. */
export function tournamentConfigChipError(config: Record<string, any>): string | null {
  const positive = (value: unknown, label: string): string | null => {
    const decoded = readWholeTournamentChip(value);
    return decoded !== null && decoded > 0 ? null : `${label}=${String(value)}`;
  };
  const nonnegative = (value: unknown, label: string): string | null =>
    readWholeTournamentChip(value) !== null ? null : `${label}=${String(value)}`;

  const starting = positive(config.starting_chips, 'starting_chips');
  if (starting) return starting;
  for (const field of ['rebuy_chips', 'addon_chips'] as const) {
    if (config[field] === null || config[field] === undefined) continue;
    // 0 is the schema's canonical "use starting_chips" sentinel.
    const invalid = nonnegative(config[field], field);
    if (invalid) return invalid;
  }

  const structure = canonicalTournamentBlindStructure(config.blind_structure);
  return structure.ok ? null : structure.reason;
}

export function assertWholeTournamentChip(
  value: unknown,
  label: string,
  allowNegative = false
): asserts value is number {
  if (isWholeTournamentChip(value, allowNegative)) return;
  throw new Error(`${TOURNAMENT_WHOLE_CHIP_ERROR}: ${label}=${String(value)}`);
}

/** Validate every chip-valued input that can seed a tournament hand. */
export function assertTournamentHandInputs(
  config: HandConfig,
  players: readonly SeatPlayer[]
): void {
  if (!config.isTournament) return;

  assertWholeTournamentChip(config.smallBlind, 'config.smallBlind');
  assertWholeTournamentChip(config.bigBlind, 'config.bigBlind');
  if (config.ante !== undefined) assertWholeTournamentChip(config.ante, 'config.ante');

  for (const [index, straddle] of (config.straddles ?? []).entries()) {
    assertWholeTournamentChip(straddle.amount, `config.straddles[${index}].amount`);
  }

  if (config.bombPot) {
    const fixed = config.bombPot.anteFixed;
    if (fixed !== undefined) {
      assertWholeTournamentChip(fixed, 'config.bombPot.anteFixed');
    }
    const resolvedAnte =
      fixed && fixed > 0 ? fixed : config.bigBlind * config.bombPot.anteMultiplier;
    assertWholeTournamentChip(resolvedAnte, 'config.bombPot.resolvedAnte');
  }

  for (const [index, player] of players.entries()) {
    assertWholeTournamentChip(player.stack, `players[${index}].stack`);
  }
}

/**
 * Fail closed if an already-created tournament hand has become fractional.
 * This is intentionally an assertion, not a repair: rounding a live state can
 * change side-pot eligibility and silently transfer a chip between players.
 */
export function assertTournamentGameState(state: GameState, context: string): void {
  const amount = (value: unknown, label: string, allowNegative = false): void =>
    assertWholeTournamentChip(value, `${context}.${label}`, allowNegative);

  amount(state.pot, 'pot');
  amount(state.currentBet, 'currentBet');
  amount(state.lastRaise, 'lastRaise');
  amount(state.minRaise, 'minRaise');

  for (const [index, player] of state.players.entries()) {
    amount(player.stack, `players[${index}].stack`);
    amount(player.bet, `players[${index}].bet`);
    amount(player.totalInvested, `players[${index}].totalInvested`);
    if (player.deadInvested !== undefined) {
      amount(player.deadInvested, `players[${index}].deadInvested`);
    }
    if (player.returnedUncalled !== undefined) {
      amount(player.returnedUncalled, `players[${index}].returnedUncalled`);
    }
  }

  for (const [index, pot] of state.pots.entries()) amount(pot.amount, `pots[${index}].amount`);
  for (const [index, action] of state.actionHistory.entries()) {
    amount(action.amount, `actionHistory[${index}].amount`);
  }
}

/**
 * Validate the chip-bearing fields of an event before any listener can persist
 * or broadcast it. Several animation-only events are intentionally outside the
 * historical HandEvent union, so the runtime shape is handled explicitly.
 */
export function assertTournamentHandEvent(event: HandEvent): void {
  const e = event as unknown as Record<string, any> & { type: string };
  const amount = (value: unknown, label: string): void =>
    assertWholeTournamentChip(value, `event.${e.type}.${label}`);
  const postings = (values: unknown, label: string): void => {
    if (!Array.isArray(values)) return;
    values.forEach((posting, index) => amount(posting?.amount, `${label}[${index}].amount`));
  };
  const players = (values: unknown, label: string): void => {
    if (!Array.isArray(values)) return;
    values.forEach((player, index) => {
      amount(player?.stack, `${label}[${index}].stack`);
      amount(player?.bet, `${label}[${index}].bet`);
      amount(player?.totalInvested, `${label}[${index}].totalInvested`);
      if (player?.deadInvested !== undefined) {
        amount(player.deadInvested, `${label}[${index}].deadInvested`);
      }
      if (player?.returnedUncalled !== undefined) {
        amount(player.returnedUncalled, `${label}[${index}].returnedUncalled`);
      }
    });
  };

  switch (e.type) {
    case 'HAND_START':
      players(e.players, 'players');
      break;
    case 'PLAYER_ACTION':
    case 'UNCALLED_BET_RETURNED':
    case 'STRADDLE_POSTED':
      amount(e.amount, 'amount');
      break;
    case 'POT_UPDATE':
      amount(e.pot, 'pot');
      if (Array.isArray(e.pots)) {
        e.pots.forEach((pot: { amount?: unknown }, index: number) =>
          amount(pot.amount, `pots[${index}].amount`)
        );
      }
      break;
    case 'ALL_IN_RUNOUT':
      amount(e.pot, 'pot');
      players(e.players, 'players');
      break;
    case 'WINNERS':
      postings(e.winners, 'winners');
      postings(e.winnersByBoard, 'winnersByBoard');
      postings(e.perPotAwards, 'perPotAwards');
      break;
    case 'BLINDS_POSTED':
    case 'FORCED_BETS_POSTED':
      postings(e.postings, 'postings');
      break;
    case 'BOMB_POT_TRIGGERED':
      amount(e.anteAmount, 'anteAmount');
      postings(e.postings, 'postings');
      break;
    case 'HAND_COMPLETE':
      amount(e.rake, 'rake');
      amount(e.bbjFee, 'bbjFee');
      break;
    default:
      break;
  }
}
