/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY SHAPE — the stored row, normalised for replay
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is the shape `hand_history` ACTUALLY holds, verified against production
 * on 2026-08-23 across 11.8M action rows:
 *
 *   actions[]  { action, amount, seat, stage, timestamp, userId }
 *   players[]  { cards, seat, stack, userId, username }
 *   winners[]  { amount, hand: { name, ranking }, potIndex, userId }
 *
 *   action  fold | check | call | bet | raise | all_in | discard
 *           plus `rit_board_2:<comma,separated,cards>` pseudo-entries, which
 *           carry the run-it-twice second board rather than a player action
 *   stage   preflop | flop | turn | river | pineapple_discard
 *
 * HandReplayViewer previously invented a different name for every one of these
 * — `street` for stage, `playerName` on an action that has no name, `playerId`
 * for userId, `'all-in'` for `all_in`. The 2026-08-22 fix repaired the QUERY,
 * so rows came back and were then mapped through those wrong names: blank
 * names on every action, a board that never revealed a card because no `stage`
 * branch could match, 236,898 all-ins printed as the raw token `all_in`, and a
 * winners lookup comparing `undefined === undefined` that named the first
 * player in the array as the winner of every hand.
 *
 * RETAINED DELIBERATELY, AND NOT DEAD CODE. `HandReplayViewer`, the component
 * this was extracted from, was retired on 2026-08-23 once `replay/HandReplay`
 * was confirmed as the one live replay. What survives it is the part that had
 * lasting value: an executable statement of what `hand_history` actually holds.
 * `tests/hand-history-shape.test.ts` asserts these names against real
 * production rows, and `HandHistoryService.mapHandHistoryRow` — the LIVE
 * mapper — reads the same JSONB under the same names. If an engine rename ever
 * lands, this fails first and says which key moved, before the live path starts
 * quietly rendering blanks.
 *
 * It lives here, as one pure function, so it can be pinned by tests instead of
 * rediscovered. Anything unrecognised degrades to a readable fallback rather
 * than throwing: a replay is a record of something that already happened, and
 * refusing to show it helps nobody.
 */

export const RIT_PREFIX = 'rit_board_2:';
/**
 * POKERBROS PARITY 2026-08-26: a hand can run THREE times. Boards 2..N are
 * stored as `rit_board_N:<cards>` pseudo-actions; the old parser read only
 * board 2, so a 3-run hand lost its third board in replay.
 */
export const RIT_ANY_PREFIX = /^rit_board_(\d+):/;

/** Community cards revealed by the end of each stage. */
export const CARDS_VISIBLE_AT_STAGE: Record<string, number> = {
  preflop: 0,
  pineapple_discard: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

export interface StoredAction {
  action?: unknown;
  amount?: unknown;
  seat?: unknown;
  stage?: unknown;
  timestamp?: unknown;
  userId?: unknown;
}

export interface StoredPlayer {
  cards?: unknown;
  seat?: unknown;
  stack?: unknown;
  userId?: unknown;
  username?: unknown;
}

export interface StoredWinner {
  amount?: unknown;
  hand?: { name?: unknown; ranking?: unknown } | null;
  potIndex?: unknown;
  userId?: unknown;
}

/** One action, with the display name already resolved. */
export interface ReplayAction {
  userId: string;
  seat: number | null;
  verb: string;
  amount: number;
  stage: string;
  playerName: string;
}

export interface ReplayPlayer {
  userId: string;
  username: string;
  seat: number | null;
  cards: string[];
  stack: number;
}

export interface ReplayWinner {
  userId: string;
  amount: number;
  handName: string | null;
  playerName: string;
}

export interface NormalisedHand {
  players: ReplayPlayer[];
  actions: ReplayAction[];
  winners: ReplayWinner[];
  /** Run-it-twice second board, empty when the hand did not run twice. */
  secondBoard: string[];
  /**
   * Every extra run-it-twice board in run order (board 2 first, board 3
   * after it when the hand ran three times). `secondBoard` stays as the
   * first entry for existing consumers.
   */
  extraBoards: string[][];
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const seatOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalise the three JSONB columns of one `hand_history` row.
 * Every argument is whatever the database handed back, including null.
 */
export function normaliseStoredHand(
  rawPlayers: unknown,
  rawActions: unknown,
  rawWinners: unknown
): NormalisedHand {
  const playersIn: StoredPlayer[] = Array.isArray(rawPlayers) ? rawPlayers : [];
  const actionsIn: StoredAction[] = Array.isArray(rawActions) ? rawActions : [];
  const winnersIn: StoredWinner[] = Array.isArray(rawWinners) ? rawWinners : [];

  const players: ReplayPlayer[] = playersIn.map((p) => {
    const seat = seatOf(p.seat);
    return {
      userId: p.userId == null ? '' : String(p.userId),
      username:
        typeof p.username === 'string' && p.username.trim()
          ? p.username
          : seat != null
            ? `Seat ${seat}`
            : 'Player',
      seat,
      cards: Array.isArray(p.cards) ? (p.cards as unknown[]).map(String) : [],
      stack: num(p.stack),
    };
  });

  const nameByUserId = new Map<string, string>();
  const nameBySeat = new Map<number, string>();
  for (const p of players) {
    if (p.userId) nameByUserId.set(p.userId, p.username);
    if (p.seat != null) nameBySeat.set(p.seat, p.username);
  }

  /* An action carries no name — only userId and seat. Resolve through the
     players array, and fall back to the seat so a replay of a hand whose
     player list is incomplete still reads as poker rather than as blanks. */
  const nameFor = (userId: string, seat: number | null): string => {
    if (userId && nameByUserId.has(userId)) return nameByUserId.get(userId) as string;
    if (seat != null && nameBySeat.has(seat)) return nameBySeat.get(seat) as string;
    return seat != null ? `Seat ${seat}` : 'Player';
  };

  const verbOf = (a: StoredAction): string => (typeof a.action === 'string' ? a.action : '');

  // Boards 2..N in run order. A 3-run hand stores rit_board_2 AND rit_board_3.
  const extraBoards: string[][] = actionsIn
    .map((a) => {
      const v = verbOf(a);
      const m = RIT_ANY_PREFIX.exec(v);
      if (!m) return null;
      return {
        run: Number(m[1]),
        cards: v
          .slice(m[0].length)
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      };
    })
    .filter((b): b is { run: number; cards: string[] } => b !== null && b.cards.length > 0)
    .sort((x, y) => x.run - y.run)
    .map((b) => b.cards);
  const secondBoard: string[] = extraBoards[0] ?? [];

  const actions: ReplayAction[] = actionsIn
    .filter((a) => {
      const v = verbOf(a);
      return v !== '' && !RIT_ANY_PREFIX.test(v);
    })
    .map((a) => {
      const userId = a.userId == null ? '' : String(a.userId);
      const seat = seatOf(a.seat);
      return {
        userId,
        seat,
        verb: verbOf(a),
        amount: num(a.amount),
        stage: typeof a.stage === 'string' && a.stage ? a.stage : 'preflop',
        playerName: nameFor(userId, seat),
      };
    });

  const winners: ReplayWinner[] = winnersIn.map((w) => {
    const userId = w.userId == null ? '' : String(w.userId);
    return {
      userId,
      amount: num(w.amount),
      handName: typeof w.hand?.name === 'string' ? w.hand.name : null,
      playerName: nameFor(userId, null),
    };
  });

  return { players, actions, winners, secondBoard, extraBoards };
}

/** How many community cards are face up once `stage` has been reached. */
export function cardsVisibleAtStage(stage: string | null | undefined): number {
  if (!stage) return 0;
  return CARDS_VISIBLE_AT_STAGE[stage] ?? 0;
}
