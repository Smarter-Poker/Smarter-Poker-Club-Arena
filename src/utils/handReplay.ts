/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND REPLAY — one reconstruction, shared by every hand-detail surface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-27: "make sure that the HAND DETAILS looks and is exactly like it
 * appears inside our hand details. don't leave anything out. and make sure that
 * smarter.poker looks and feels like this with all the same data points and
 * architecture."
 *
 * There were two hand-detail renderers (the BBJ one and the table's Previous
 * Hand modal), each reconstructing the hand its own way, and BOTH were wrong in
 * the same place. This is the single reconstruction; both render from it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THING THAT MAKES THIS HARD: `actions[].amount` IS NOT ONE UNIT
 *
 * The engine writes two different meanings into the same field
 * (server/src/engine/HandController.ts:600-724):
 *
 *   bet / raise / all_in -> the raise-TO level for that street (CUMULATIVE)
 *   call                 -> the chips actually added            (INCREMENTAL)
 *   fold / check         -> 0
 *
 * Every previous consumer summed the field as if it were uniformly incremental.
 * `HandDetailModal` did it for its running pot, `HandHistoryService.buildResult`
 * did it for each player's net, `handHistoryAdapter.investedBy` did it again.
 * All three over-count every raised pot, because a raise-to level includes the
 * chips that player already had in from earlier on the same street.
 *
 * Worked against a real production row (hand 3048511, PLO5 1/2, pot_size
 * 324.20). Naive sum: 1 + 2 + 2 + 1 + 3 + 15 + 50 + 156 + 159.1 + 3.1 = 392.20,
 * off by 68. Street-committed differencing gives 324.20 to the penny.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OTHER THREE GAPS, AND WHAT IS DONE ABOUT EACH
 *
 * 1. NO STARTING STACK IS STORED. `players[].stack` is the stack AFTER
 *    settlement (server/src/services/supabase/handHistory.ts:849). The reference
 *    layout puts the player's remaining stack against every action, so it has to
 *    be recovered:
 *
 *        startStack = endStack - grossWon + netInvested
 *
 *    which is exact, and checks out on the same real row: seat 4 ends 318.70,
 *    won 318.70 gross, invested 161.10, so he started with 161.10 — and he was
 *    all-in for exactly 161.10.
 *
 * 2. BLINDS ARE NOT IN THE ACTION LOG. `postBlinds` mutates stacks and emits a
 *    bus event but never records an action. They are synthesised here from
 *    `small_blind` / `big_blind` and the derived blind seats — and only when the
 *    log does not already carry explicit post rows, so this keeps working if the
 *    engine starts writing them.
 *
 *    ANTES AND STRADDLES ARE NOT RECOVERABLE AT ALL from a hand_history row.
 *    They are not in `actions` and not in any column. When the rebuilt pot comes
 *    up short against the stored `pot_size` this says so (`reconciles: false`)
 *    rather than drawing a stack curve that is quietly wrong.
 *
 * 3. AN UNCALLED BET IS NEVER RECORDED. `returnUncalledBet` moves the chips and
 *    emits an event; nothing persists it, so the log shows a player betting 900
 *    and never getting it back, while `pot_size` and the ending stack both
 *    already exclude it. It is INFERRED here: at the end of a street the top
 *    contributor's excess over the next-highest is uncalled by definition. That
 *    is what produces the `return` row with a negative amount that the reference
 *    shows, and it is what makes the rebuilt pot agree with `pot_size` on a hand
 *    that ends in a fold.
 *
 * Nothing here decides a pot. The engine remains the authority on who won and
 * what the hand was called; this reads what it recorded and lays it out.
 */

import { toDeckCards, type StoredCard, type DeckCard } from './deckCards';
import { bestFive, cardKey } from './handEvaluator';
import { derivePositions, smallBlindSeat, bigBlindSeat } from './pokerPositions';

// ─────────────────────────────────────────────────────────────────────────────
// INPUT — the union of what hand_history stores and what the BBJ RPC returns
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayPlayerInput {
  userId: string;
  username: string;
  seat: number;
  /** Stack AFTER settlement. The only stack the row carries. */
  stack: number | null;
  playerNumber?: string | null;
  avatarUrl?: string | null;
}

export interface ReplayActionInput {
  seat: number;
  userId: string;
  action: string;
  amount?: number | null;
  /** The engine's key is `stage`; the table adapter renames it `street`. */
  stage?: string | null;
  street?: string | null;
}

export interface ReplayWinnerInput {
  userId: string;
  amount: number;
  potIndex?: number;
  hand?: { name?: string; ranking?: number; cards?: StoredCard[] } | null;
}

export interface ReplayShowdownInput {
  user_id?: string;
  userId?: string;
  seat?: number;
  mucked?: boolean;
  hand_name?: string | null;
  hand_description?: string | null;
  reveal_order?: number;
}

export interface ReplayInput {
  handNumber: number | string | null;
  playedAt: string | null;
  gameVariant: string | null;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rakeAmount?: number | null;
  bbjAmount?: number | null;
  buttonSeat?: number | null;
  /** Board one. Either stored shape. */
  board: StoredCard[] | null | undefined;
  /** Run-it-twice boards 2..N, and/or a double-board bomb pot's second board. */
  extraBoards?: (StoredCard[] | null | undefined)[] | null;
  players: ReplayPlayerInput[];
  actions: ReplayActionInput[];
  winners: ReplayWinnerInput[];
  holeCards: Record<string, StoredCard[]> | null | undefined;
  showdown?: ReplayShowdownInput[] | null;
  pots?: { index?: number; amount?: number }[] | null;
  /**
   * Set for rows whose `amount` is already incremental on EVERY verb. Nothing
   * the engine writes is; this exists so a fixture or an imported history can
   * declare itself rather than be mis-read as raise-to levels.
   */
  amountsAreIncremental?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

export type ReplayVerb =
  | 'sb'
  | 'bb'
  | 'ante'
  | 'straddle'
  | 'fold'
  | 'check'
  | 'call'
  | 'bet'
  | 'raise'
  | 'all_in'
  | 'discard'
  | 'return'
  | 'show'
  | 'muck';

export interface ReplayRow {
  key: string;
  seat: number;
  userId: string;
  name: string;
  position: string;
  verb: ReplayVerb;
  /** Title Cased, per the house popup rule. */
  label: string;
  /** Incremental chips for this action. Negative on a returned uncalled bet. */
  amount: number;
  /** The player's stack the moment after this action. Null when unrecoverable. */
  stackAfter: number | null;
  /** Face-down cards drawn beside a fold, the way the reference shows a muck. */
  showsMuck: boolean;
  /** Face-up cards drawn beside a `show`. */
  shownCards: DeckCard[] | null;
}

export interface ReplayStreet {
  key: string;
  label: string;
  /** The whole board face-up by the end of this street — 0 / 3 / 4 / 5. */
  board: DeckCard[];
  /** Only the cards this street turned over, for surfaces that want just those. */
  newCards: DeckCard[];
  /** Pot after every action on this street. */
  potAfter: number;
  rows: ReplayRow[];
}

export interface ReplayShowdownRow {
  key: string;
  userId: string;
  name: string;
  seat: number;
  position: string;
  /** Null when the player never showed — draw backs. */
  hole: DeckCard[] | null;
  /** The five that played, in poker-room order. Empty when not derivable. */
  made: DeckCard[];
  /** Keys of the cards that play, for lighting them. */
  playing: Set<string>;
  handName: string;
  /** Which board this row is for; 0 unless the hand ran more than once. */
  boardIndex: number;
  boardLabel: string | null;
  /** Net for the hand. Null on the second and later boards — see the note. */
  net: number | null;
  potLabel: string;
  isWinner: boolean;
}

export interface ReplayModel {
  handNumber: number | string | null;
  playedAt: string | null;
  gameVariant: string | null;
  smallBlind: number;
  bigBlind: number;
  buttonSeat: number | null;
  positions: Record<number, string>;
  streets: ReplayStreet[];
  boards: DeckCard[][];
  showdown: ReplayShowdownRow[];
  potTotal: number;
  pots: { label: string; amount: number }[];
  rake: number;
  bbjFee: number;
  /** True when the rebuilt pot lands on the stored pot_size. */
  reconciles: boolean;
  /** Rebuilt total, whether or not it reconciles. Useful in diagnostics. */
  rebuiltPot: number;
  /** Per-player resolved figures, seat-ordered. */
  players: Array<
    ReplayPlayerInput & {
      position: string;
      startStack: number | null;
      invested: number;
      won: number;
      net: number;
      hole: DeckCard[] | null;
      mucked: boolean;
    }
  >;
}

// ─────────────────────────────────────────────────────────────────────────────

const STREET_ORDER: Array<{ key: string; label: string; boardTo: number }> = [
  { key: 'preflop', label: 'PreFlop', boardTo: 0 },
  { key: 'flop', label: 'Flop', boardTo: 3 },
  { key: 'turn', label: 'Turn', boardTo: 4 },
  { key: 'river', label: 'River', boardTo: 5 },
  { key: 'showdown', label: 'Showdown', boardTo: 5 },
];

const VERB_LABEL: Record<ReplayVerb, string> = {
  sb: 'SB',
  bb: 'BB',
  ante: 'Ante',
  straddle: 'Straddle',
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
  all_in: 'All In',
  discard: 'Discard',
  return: 'Return',
  show: 'Show',
  muck: 'Muck',
};

/** Verbs whose stored amount is a raise-TO level rather than an increment. */
const TO_LEVEL_VERBS = new Set(['bet', 'raise', 'all_in', 'allin', 'all-in']);

/** Explicit forced-money rows, if the engine ever starts writing them. */
const POST_VERBS = new Set(['post', 'post_sb', 'post_bb', 'sb', 'bb', 'ante', 'straddle', 'blind']);

const money = (n: number) => Math.round(n * 100) / 100;

function normalizeVerb(raw: string): ReplayVerb {
  const v = String(raw || '')
    .toLowerCase()
    .replace(/[\s-]/g, '_');
  if (v === 'allin' || v === 'all_in') return 'all_in';
  if (v === 'post_sb' || v === 'sb' || v === 'small_blind') return 'sb';
  if (v === 'post_bb' || v === 'bb' || v === 'big_blind') return 'bb';
  if (v === 'blind' || v === 'post') return 'bb';
  if ((VERB_LABEL as Record<string, string>)[v]) return v as ReplayVerb;
  return 'check';
}

function stageOf(a: ReplayActionInput): string {
  const s = String(a.stage ?? a.street ?? 'preflop').toLowerCase();
  if (s === 'pineapple_discard') return 'preflop';
  return STREET_ORDER.some((x) => x.key === s) ? s : 'preflop';
}

/**
 * Run-it-twice boards used to be recorded as a pseudo-action on the river:
 * `rit_board_2:6hearts,2spades,...` with userId `system`. Newer rows use the
 * `rit_boards` column. Both are read; the pseudo-actions never become rows.
 */
function ritBoardsFromActions(actions: ReplayActionInput[]): StoredCard[][] {
  const out: StoredCard[][] = [];
  for (const a of actions) {
    const m = /^rit_board_\d+:(.+)$/.exec(String(a.action || ''));
    if (m) out.push(m[1].split(',').map((s) => s.trim()));
  }
  return out;
}

const isSystemAction = (a: ReplayActionInput) =>
  String(a.userId || '') === 'system' || /^rit_board_/.test(String(a.action || ''));

/** Title Case, per Dan's popup rule. Applied to every label this produces. */
export function titleCase(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

export function buildReplay(input: ReplayInput): ReplayModel {
  const players = [...(input.players || [])]
    .filter((p) => p && Number.isFinite(Number(p.seat)))
    .sort((a, b) => Number(a.seat) - Number(b.seat));

  const seats = players.map((p) => Number(p.seat));
  const bySeat = new Map(seats.map((s, i) => [s, players[i]]));
  const positions = derivePositions(seats, input.buttonSeat);
  const sbSeat = smallBlindSeat(seats, input.buttonSeat);
  const bbSeat = bigBlindSeat(seats, input.buttonSeat);

  const board = toDeckCards(input.board);
  const extra = (input.extraBoards || []).map((b) => toDeckCards(b)).filter((b) => b.length > 0);
  const ritFromLog = ritBoardsFromActions(input.actions || []).map((b) => toDeckCards(b));
  const boards = [board, ...extra, ...ritFromLog].filter((b) => b.length > 0);
  if (boards.length === 0) boards.push([]);

  // ── gross winnings, and the engine's own name for each winning hand ────────
  const wonByUser = new Map<string, number>();
  const engineHandName = new Map<string, string>();
  for (const w of input.winners || []) {
    if (!w?.userId) continue;
    wonByUser.set(w.userId, money((wonByUser.get(w.userId) || 0) + (Number(w.amount) || 0)));
    if (w.hand?.name) engineHandName.set(w.userId, w.hand.name);
  }

  // ── the walk ──────────────────────────────────────────────────────────────
  const invested = new Map<number, number>();
  const rows: Array<ReplayRow & { stage: string }> = [];
  let pot = 0;

  const addMoney = (seat: number, amount: number) => {
    pot = money(pot + amount);
    invested.set(seat, money((invested.get(seat) || 0) + amount));
  };

  const live = (input.actions || []).filter((a) => a && !isSystemAction(a));
  const logHasPosts = live.some((a) => POST_VERBS.has(String(a.action || '').toLowerCase()));

  // Blinds, synthesised only when the log does not already carry them.
  const preflopPosts: Array<ReplayRow & { stage: string }> = [];
  if (!logHasPosts) {
    const post = (seat: number | null, amount: number, verb: 'sb' | 'bb') => {
      if (seat === null || !(amount > 0)) return;
      addMoney(seat, amount);
      preflopPosts.push({
        key: `post-${verb}`,
        stage: 'preflop',
        seat,
        userId: bySeat.get(seat)?.userId || '',
        name: bySeat.get(seat)?.username || 'Player',
        position: positions[seat] || '',
        verb,
        label: VERB_LABEL[verb],
        amount,
        stackAfter: null,
        showsMuck: false,
        shownCards: null,
      });
    };
    post(sbSeat, Number(input.smallBlind) || 0, 'sb');
    post(bbSeat, Number(input.bigBlind) || 0, 'bb');
  }
  rows.push(...preflopPosts);

  // Per-street committed totals, so a raise-TO level becomes an increment.
  let streetKey = 'preflop';
  let committed = new Map<number, number>();
  if (!logHasPosts) {
    if (sbSeat !== null && Number(input.smallBlind) > 0)
      committed.set(sbSeat, Number(input.smallBlind));
    if (bbSeat !== null && Number(input.bigBlind) > 0)
      committed.set(bbSeat, Number(input.bigBlind));
  }

  /**
   * End-of-street uncalled bet. The top contributor's excess over the next
   * highest was matched by nobody, so the engine gave it back and both
   * `pot_size` and the ending stack already exclude it.
   */
  const settleStreet = () => {
    const entries = [...committed.entries()].filter(([, v]) => v > 0);
    if (entries.length < 1) return;
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries[0];
    const next = entries[1]?.[1] ?? 0;
    const excess = money(top[1] - next);
    if (excess <= 0.005) return;
    addMoney(top[0], -excess);
    rows.push({
      key: `return-${streetKey}-${top[0]}`,
      stage: streetKey,
      seat: top[0],
      userId: bySeat.get(top[0])?.userId || '',
      name: bySeat.get(top[0])?.username || 'Player',
      position: positions[top[0]] || '',
      verb: 'return',
      label: VERB_LABEL.return,
      amount: -excess,
      stackAfter: null,
      showsMuck: false,
      shownCards: null,
    });
  };

  live.forEach((a, i) => {
    const stage = stageOf(a);
    if (stage !== streetKey) {
      settleStreet();
      streetKey = stage;
      committed = new Map();
    }

    const seat = Number(a.seat);
    const verb = normalizeVerb(a.action);
    const raw = Number(a.amount) || 0;

    let increment = 0;
    if (input.amountsAreIncremental) {
      increment = raw;
    } else if (TO_LEVEL_VERBS.has(String(a.action || '').toLowerCase())) {
      increment = money(raw - (committed.get(seat) || 0));
    } else {
      increment = raw;
    }
    if (increment < 0) increment = 0;

    if (increment > 0) {
      addMoney(seat, increment);
      committed.set(seat, money((committed.get(seat) || 0) + increment));
    }

    rows.push({
      key: `a-${i}`,
      stage,
      seat,
      userId: a.userId || bySeat.get(seat)?.userId || '',
      name: bySeat.get(seat)?.username || 'Player',
      position: positions[seat] || '',
      verb,
      label: VERB_LABEL[verb],
      amount: increment,
      stackAfter: null,
      showsMuck: verb === 'fold' || verb === 'muck',
      shownCards: null,
    });
  });
  settleStreet();

  const rebuiltPot = money(pot);
  const storedPot = Number(input.potSize) || 0;
  const reconciles = storedPot > 0 && Math.abs(rebuiltPot - storedPot) < 0.02;

  // ── starting stacks, then the stack after every row ────────────────────────
  const startStack = new Map<number, number | null>();
  for (const p of players) {
    const end = p.stack === null || p.stack === undefined ? null : Number(p.stack);
    const inv = invested.get(Number(p.seat)) || 0;
    const won = wonByUser.get(p.userId) || 0;
    // Only trustworthy when the rebuild agrees with the engine's own pot: if
    // forced money is missing (an ante, a straddle) `inv` is short and every
    // figure in this column would be short with it.
    startStack.set(Number(p.seat), end === null || !reconciles ? null : money(end - won + inv));
  }

  const spent = new Map<number, number>();
  for (const r of rows) {
    const s = money((spent.get(r.seat) || 0) + r.amount);
    spent.set(r.seat, s);
    const start = startStack.get(r.seat);
    r.stackAfter = start === null || start === undefined ? null : money(start - s);
  }

  // ── hole cards, showdown ruling ───────────────────────────────────────────
  const holeByUser = new Map<string, DeckCard[]>();
  for (const [uid, cards] of Object.entries(input.holeCards || {})) {
    const deck = toDeckCards(cards);
    if (deck.length > 0) holeByUser.set(uid, deck);
  }

  const muckedByUser = new Map<string, boolean>();
  const revealOrder = new Map<string, number>();
  const showdownName = new Map<string, string>();
  for (const s of input.showdown || []) {
    const uid = s.user_id || s.userId;
    if (!uid) continue;
    muckedByUser.set(uid, !!s.mucked);
    if (typeof s.reveal_order === 'number') revealOrder.set(uid, s.reveal_order);
    const name = s.hand_name || '';
    if (name) showdownName.set(uid, name);
  }

  // Attach a `show` row for every player who revealed, the way the reference
  // closes out the log before the pot line.
  for (const p of players) {
    const hole = holeByUser.get(p.userId);
    if (!hole) continue;
    rows.push({
      key: `show-${p.userId}`,
      stage: 'showdown',
      seat: Number(p.seat),
      userId: p.userId,
      name: p.username,
      position: positions[Number(p.seat)] || '',
      verb: 'show',
      label: VERB_LABEL.show,
      amount: 0,
      stackAfter: startStack.get(Number(p.seat)) === null ? null : null,
      showsMuck: false,
      shownCards: hole,
    });
  }

  // ── streets ───────────────────────────────────────────────────────────────
  const potAtEndOf = new Map<string, number>();
  {
    let running = 0;
    for (const street of STREET_ORDER) {
      for (const r of rows.filter((x) => x.stage === street.key))
        running = money(running + r.amount);
      potAtEndOf.set(street.key, running);
    }
  }

  const streets: ReplayStreet[] = STREET_ORDER.map((street, i) => {
    const prev = i === 0 ? 0 : STREET_ORDER[i - 1].boardTo;
    return {
      key: street.key,
      label: street.label,
      board: board.slice(0, street.boardTo),
      newCards: board.slice(prev, street.boardTo),
      potAfter: potAtEndOf.get(street.key) ?? 0,
      rows: rows.filter((r) => r.stage === street.key).map(({ stage: _s, ...rest }) => rest),
    };
  }).filter((s) => s.rows.length > 0 || s.newCards.length > 0);

  // ── showdown rows, one per player per board ───────────────────────────────
  const showdownRows: ReplayShowdownRow[] = [];
  const ordered = [...players].sort((a, b) => {
    const ra = revealOrder.get(a.userId);
    const rb = revealOrder.get(b.userId);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return Number(a.seat) - Number(b.seat);
  });

  boards.forEach((b, boardIndex) => {
    for (const p of ordered) {
      const hole = holeByUser.get(p.userId) || null;
      const made = hole ? bestFive(hole, b, input.gameVariant) : null;
      const won = wonByUser.get(p.userId) || 0;
      const inv = invested.get(Number(p.seat)) || 0;
      showdownRows.push({
        key: `sd-${boardIndex}-${p.userId}`,
        userId: p.userId,
        name: p.username,
        seat: Number(p.seat),
        position: positions[Number(p.seat)] || '',
        hole,
        made: made?.cards || [],
        playing: new Set((made?.cards || []).map(cardKey)),
        handName: titleCase(
          showdownName.get(p.userId) || engineHandName.get(p.userId) || made?.name || ''
        ),
        boardIndex,
        boardLabel: boards.length > 1 ? `Board ${boardIndex + 1}` : null,
        // The engine records ONE winners[] entry for the whole hand, not one per
        // run. On a hand that ran twice the split between boards is not stored,
        // so it is shown once against board one rather than invented for both.
        net: boardIndex === 0 ? money(won - inv) : null,
        potLabel: 'Main pot',
        isWinner: won > 0,
      });
    }
  });

  // ── pot breakdown ─────────────────────────────────────────────────────────
  const storedPots = (input.pots || []).filter((p) => Number(p?.amount) > 0);
  const potBreakdown =
    storedPots.length > 0
      ? storedPots.map((p, i) => ({
          label: i === 0 ? 'Main' : `Side ${i}`,
          amount: money(Number(p.amount) || 0),
        }))
      : [{ label: 'Main', amount: money(storedPot || rebuiltPot) }];

  return {
    handNumber: input.handNumber,
    playedAt: input.playedAt,
    gameVariant: input.gameVariant,
    smallBlind: Number(input.smallBlind) || 0,
    bigBlind: Number(input.bigBlind) || 0,
    buttonSeat: input.buttonSeat ?? null,
    positions,
    streets,
    boards,
    showdown: showdownRows,
    potTotal: money(storedPot || rebuiltPot),
    pots: potBreakdown,
    rake: money(Number(input.rakeAmount) || 0),
    bbjFee: money(Number(input.bbjAmount) || 0),
    reconciles,
    rebuiltPot,
    players: players.map((p) => {
      const inv = invested.get(Number(p.seat)) || 0;
      const won = wonByUser.get(p.userId) || 0;
      return {
        ...p,
        position: positions[Number(p.seat)] || '',
        startStack: startStack.get(Number(p.seat)) ?? null,
        invested: inv,
        won,
        net: money(won - inv),
        hole: holeByUser.get(p.userId) || null,
        mucked: muckedByUser.get(p.userId) ?? !holeByUser.has(p.userId),
      };
    }),
  };
}
