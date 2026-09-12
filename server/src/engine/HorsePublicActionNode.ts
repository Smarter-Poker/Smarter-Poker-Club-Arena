import type {
  ActionType,
  AuthoritativeActionState,
  GameState,
  HandConfig,
  HandStage,
} from '../types.js';
import { isKnownVariant, isShortDeckVariant } from './VariantRules.js';
import {
  captureHorsePublicDeductions,
  type HorsePublicDeductions,
} from './HorsePublicDeductions.js';

/** Public facts only. Hand/session identity and action origin must be bound by
 * the accepted-hand producer before any model may learn from this snapshot.
 */
export type HorsePublicActionNode =
  | Readonly<{
      version: 1;
      status: 'captured';
      variant: HandConfig['gameVariant'];
      mode: 'cash' | 'tournament';
      asset: 'chips' | 'diamonds';
      chipUnit: 0.01 | 1;
      /** Absent on earlier schema-1 rows; those rows cannot establish net EV. */
      deductions?: HorsePublicDeductions;
      street: HandStage;
      dealerSeat: number;
      actorSeat: number;
      smallBlind: number;
      bigBlind: number;
      ante: number;
      anteType: 'per_player' | 'big_blind';
      allInOrFold: boolean;
      bombPot: boolean;
      boardCount: number;
      /** Compact public cards, one string per physical board; no seat cards. */
      boards: readonly string[];
      pot: number;
      currentBet: number;
      toCall: number;
      structure: AuthoritativeActionState['structure'];
      minRaiseTo: number | null;
      maxRaiseTo: number | null;
      fixedBetSize: number | null;
      wagersCapped: boolean;
      legalActions: readonly ActionType[];
      /** seat, behind, street wager, invested, dead invested, individual ante,
       * flags (folded=1, all-in=2, sitting-out=4). Identity lives on the action.
       */
      seats: ReadonlyArray<readonly [number, number, number, number, number, number, number]>;
    }>
  | Readonly<{
      version: 1;
      status: 'unavailable';
      reason:
        | 'invalid_public_state'
        | 'non_betting_action'
        | 'private_discard_choice'
        | 'timeout_discard_fold'
        | 'forced_discard';
    }>;

export const unavailablePublicActionNode = (
  reason: Extract<HorsePublicActionNode, { status: 'unavailable' }>['reason']
): HorsePublicActionNode => Object.freeze({ version: 1, status: 'unavailable', reason });

/** Bounded allowlist capture called after action validation, before mutation.
 * Failure excludes learning data; it never changes whether poker can proceed.
 */
export function captureHorsePublicActionNode(
  config: HandConfig,
  state: GameState,
  rights: AuthoritativeActionState | null,
  boardCount: number
): HorsePublicActionNode {
  const unavailable = () => unavailablePublicActionNode('invalid_public_state');
  if (!['preflop', 'flop', 'turn', 'river'].includes(state.stage))
    return unavailablePublicActionNode('non_betting_action');
  const amount = (n: number): boolean => Number.isFinite(n) && n >= 0;
  if (
    !rights?.canAct ||
    rights.schemaVersion !== 1 ||
    rights.heroSeat !== state.currentPlayerSeat ||
    rights.currentPlayerSeat !== state.currentPlayerSeat ||
    !isKnownVariant(config.gameVariant) ||
    ![1, 2, 3].includes(boardCount) ||
    state.players.length < 2 ||
    state.players.length > 10 ||
    ![
      config.smallBlind,
      config.bigBlind,
      config.ante ?? 0,
      state.pot,
      state.currentBet,
      rights.toCall,
    ].every(amount) ||
    config.bigBlind <= 0 ||
    config.smallBlind > config.bigBlind ||
    ![rights.minRaiseTo, rights.maxRaiseTo, rights.fixedBetSize].every(
      (v) => v === null || amount(v)
    ) ||
    !['no_limit', 'pot_limit', 'fixed_limit'].includes(rights.structure) ||
    typeof rights.wagersCapped !== 'boolean' ||
    !Array.isArray(rights.legalActions) ||
    rights.legalActions.length === 0 ||
    rights.legalActions.length > 7 ||
    !rights.legalActions.every((a) =>
      ['fold', 'check', 'call', 'bet', 'raise', 'all_in'].includes(a)
    )
  )
    return unavailable();
  const sizedWager = rights.legalActions.includes('bet') || rights.legalActions.includes('raise');
  if (
    new Set(rights.legalActions).size !== rights.legalActions.length ||
    (sizedWager
      ? rights.minRaiseTo === null ||
        rights.maxRaiseTo === null ||
        rights.minRaiseTo > rights.maxRaiseTo
      : rights.minRaiseTo !== null || rights.maxRaiseTo !== null) ||
    (rights.structure === 'fixed_limit'
      ? rights.fixedBetSize === null || rights.fixedBetSize <= 0
      : rights.fixedBetSize !== null) ||
    ![config.isTournament, config.bigBlindAnte, config.allInOrFold].every(
      (v) => v === undefined || typeof v === 'boolean'
    ) ||
    (config.asset !== undefined && config.asset !== 'chips' && config.asset !== 'diamonds')
  )
    return unavailable();
  const seenSeats = new Set<number>();
  const seats: Array<readonly [number, number, number, number, number, number, number]> = [];
  for (const player of state.players) {
    const amounts = [
      player.stack,
      player.bet,
      player.totalInvested,
      player.deadInvested ?? 0,
      player.individualAnteInvested ?? 0,
    ];
    if (
      !Number.isSafeInteger(player.seat) ||
      player.seat < 1 ||
      player.seat > 10 ||
      seenSeats.has(player.seat) ||
      !amounts.every(amount)
    )
      return unavailable();
    seenSeats.add(player.seat);
    if (
      ![player.is_folded, player.is_all_in, player.is_sitting_out].every(
        (v) => v === undefined || typeof v === 'boolean'
      )
    )
      return unavailable();
    seats.push(
      Object.freeze([
        player.seat,
        ...amounts,
        Number(player.is_folded === true) +
          2 * Number(player.is_all_in === true) +
          4 * Number(player.is_sitting_out === true),
      ] as [number, number, number, number, number, number, number])
    );
  }
  if (!seenSeats.has(state.dealerSeat) || !seenSeats.has(rights.heroSeat)) return unavailable();
  seats.sort((a, b) => a[0] - b[0]);
  const expectedCards =
    state.stage === 'preflop' ? 0 : state.stage === 'flop' ? 3 : state.stage === 'turn' ? 4 : 5;
  const sourceBoards = [state.communityCards, state.communityCards2, state.communityCards3];
  const suits = { clubs: 'c', diamonds: 'd', hearts: 'h', spades: 's' } as const;
  const boards: string[] = [];
  // Betting on bomb-pot boards uses independently dealt physical cards.
  // Run-it-twice shared prefixes are terminal runouts with no betting action.
  const seenCards = new Set<string>();
  for (let index = 0; index < 3; index++) {
    const board = sourceBoards[index];
    if (!Array.isArray(board) || board.length !== (index < boardCount ? expectedCards : 0))
      return unavailable();
    if (index >= boardCount) continue;
    let publicCards = '';
    for (const card of board) {
      if (
        !card ||
        typeof card.rank !== 'string' ||
        card.rank.length !== 1 ||
        !'23456789TJQKA'.includes(card.rank) ||
        !Object.hasOwn(suits, card.suit) ||
        (isShortDeckVariant(config.gameVariant) && '2345'.includes(card.rank))
      )
        return unavailable();
      const code = card.rank + suits[card.suit];
      if (seenCards.has(code)) return unavailable();
      seenCards.add(code);
      publicCards += code;
    }
    boards.push(publicCards);
  }
  return Object.freeze({
    version: 1,
    status: 'captured',
    variant: config.gameVariant,
    mode: config.isTournament ? 'tournament' : 'cash',
    asset: config.asset === 'diamonds' ? 'diamonds' : 'chips',
    chipUnit: config.isTournament || config.asset === 'diamonds' ? 1 : 0.01,
    deductions: captureHorsePublicDeductions(config),
    street: state.stage,
    dealerSeat: state.dealerSeat,
    actorSeat: rights.heroSeat,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    ante: config.ante ?? 0,
    anteType: config.bigBlindAnte ? 'big_blind' : 'per_player',
    allInOrFold: config.allInOrFold === true,
    bombPot: config.bombPot !== undefined,
    boardCount,
    boards: Object.freeze(boards),
    pot: state.pot,
    currentBet: state.currentBet,
    toCall: rights.toCall,
    structure: rights.structure,
    minRaiseTo: rights.minRaiseTo,
    maxRaiseTo: rights.maxRaiseTo,
    fixedBetSize: rights.fixedBetSize,
    wagersCapped: rights.wagersCapped,
    legalActions: Object.freeze(rights.legalActions.slice()),
    seats: Object.freeze(seats),
  });
}
