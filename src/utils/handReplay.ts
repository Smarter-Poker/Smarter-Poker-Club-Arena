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
import { bestFive, bestLow, cardKey, isEightOrBetterVariant } from './handEvaluator';
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
  /**
   * Set on forced-money rows that are DEAD — an ante, or the small-blind half
   * of a dead blind. Dead money is in the pot but is not part of the live bet
   * level, so it must not be differenced against a raise-TO level.
   */
  dead?: boolean;
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
  /**
   * THE STACK EACH SEAT STARTED THE HAND WITH, by seat, when the producer
   * knows it directly.
   *
   * `ReplayPlayerInput.stack` is the stack AFTER settlement, because that is
   * what a hand_history row stores, and the start is derived back out of it
   * (`start = end - won + invested`). A share link has the opposite problem:
   * it is written at the end of the hand and carries the START, never the
   * settled figure. Rather than have the sharer invert the arithmetic and
   * hand over a number the recipient inverts again, the producer that knows
   * the start says so. Ignored when the rebuild does not reconcile - a start
   * stack cannot rescue a stack column whose subtractions are short.
   */
  startStacks?: Record<number, number | null> | null;
  actions: ReplayActionInput[];
  winners: ReplayWinnerInput[];
  holeCards: Record<string, StoredCard[]> | null | undefined;
  showdown?: ReplayShowdownInput[] | null;
  pots?: { index?: number; amount?: number }[] | null;
  /**
   * WHO WON EACH BOARD (hand_history.winners_by_board, 2026-09-04). Per
   * (board, winner): 1-based board index, pre-rake share, the hand ON THAT
   * board. Absent on single-board hands and rows older than the column.
   */
  winnersByBoard?:
    | {
        board?: number;
        userId?: string;
        user_id?: string;
        amount?: number;
        handName?: string;
        /**
         * HI-LO (2026-09-04, Previous Hand second sweep): true on the entry
         * for the LOW half of a split pot. The engine writes one entry per
         * (board, winner, half) on PLO8 / FLO8 hands; rows older than that
         * carry no flag and are read as high.
         */
        low?: boolean;
      }[]
    | null;
  /**
   * Set for rows whose `amount` is already incremental on EVERY verb. Nothing
   * the engine writes is; this exists so a fixture or an imported history can
   * declare itself rather than be mis-read as raise-to levels.
   */
  amountsAreIncremental?: boolean;
  /**
   * A BOMB POT posts antes and NO BLINDS. Without this the blind-synthesis
   * below saw a log with no blind rows, decided they had been dropped, and
   * invented a small and a big blind nobody posted: a real double-board bomb
   * pot (#6704153) rebuilt to 3.75 against a stored pot of 3.00, `reconciles`
   * went false so the whole stack column was withdrawn, and the felt drew two
   * bet pills for money that never left a stack.
   */
  bombPot?: boolean | null;
  /**
   * PHASE 4 2026-09-01 - the discarded card, keyed by the user it belongs to.
   *
   * In Crazy Pineapple the thrown card is never revealed to opponents, not on
   * the discard and not at showdown, so this map holds exactly ONE entry in
   * practice: the viewer's own. That is not a convention this builder enforces
   * by trimming - it is what the DATABASE returns. `hand_discards` is read
   * through `hand_discards_read_own` (auth.uid() = user_id), so a client that
   * asked for every seat's discard would still be handed only its own. The
   * caller cannot leak somebody else's card here even by mistake.
   *
   * Absent for every hand played before this shipped, and for every variant
   * that has no discard. A row with no entry renders exactly as it does today.
   */
  discardedCards?: Record<string, StoredCard> | null;
  /**
   * YOUR OWN CARDS ON A HAND THE TABLE NEVER SAW THEM (2026-09-04).
   *
   * `holeCards` is the table's record - showdown-revealed holdings only, by
   * the server's design. `ca_hand_facts.hole_cards` holds the viewer's own
   * cards on every hand they paid into, and is read through an RLS policy
   * that returns nothing but the caller's rows, so this map can only ever
   * hold ONE entry: the viewer's. It never adds a player to the showdown,
   * never changes who is a winner, and never becomes a `show` row - the hand
   * stays a fold-around or a muck exactly as the table saw it. What it does is
   * let the rundown draw the viewer's own cards face-up, marked private,
   * where before it drew backs or nothing.
   */
  privateHoleCards?: Record<string, StoredCard[]> | null;
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
  | 'muck'
  /**
   * A verb this reader does not know. The row still renders, carrying the
   * engine's own word for it in `label`. The alternative — the old behaviour —
   * was to coerce it to `check`, which drew a player an action that never
   * happened on a surface that is about money.
   */
  | 'unknown';

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
  /**
   * The card this seat threw, on a `discard` row, when the viewer is entitled
   * to see it - which is only ever their own (see ReplayInput.discardedCards).
   * Null on every other verb, and on a discard whose card is not the viewer's
   * or was never recorded.
   */
  discardedCard: DeckCard | null;
  /**
   * On the viewer's OWN fold: the cards they threw away, face-up, marked as
   * theirs (see ReplayInput.privateHoleCards). Null on everyone else's fold
   * and on every other verb - an opponent's fold stays face-down backs.
   */
  privateCards: DeckCard[] | null;
  /**
   * DEAD forced money: an ante, a bomb-pot ante, the dead half of a dead
   * blind. It is in the pot but was never in front of the seat, so it is not
   * part of the live bet level and nothing may price a call off it.
   *
   * The reconstruction has always known this (it is why a raise-TO level is
   * differenced against live chips only), but until 2026-09-05 it kept the
   * fact to itself: `buildReplayFrames` re-derived its own per-seat
   * commitments from the rows, counted the ante among them, and the felt drew
   * a tournament big blind sitting behind 750 when 400 was in front of them.
   * Phase 3 then priced pot odds off that number and told every player facing
   * the blind a price that was not the price. One flag, read by both.
   */
  dead: boolean;
}

export interface ReplayStreet {
  key: string;
  label: string;
  /** The whole board face-up by the end of this street — 0 / 3 / 4 / 5. */
  board: DeckCard[];
  /** Only the cards this street turned over, for surfaces that want just those. */
  newCards: DeckCard[];
  /**
   * The same street on every EXTRA board — run-it-twice runs 2..N, or the
   * second board of a double-board bomb pot. Empty on a single-board hand.
   */
  extraBoards: DeckCard[][];
  /**
   * True on the last street of the hand, and only there does the pot line
   * speak for the real pot. Everywhere else it is a running total.
   */
  isFinal: boolean;
  /** Pot after every action on this street. */
  potAfter: number;
  rows: ReplayRow[];
  /**
   * PHASE 2 (2026-09-05). Who was still in the hand when this street began
   * (nobody who had folded on an earlier street), in seat order. The equity
   * pricing prices a street only when every one of these has known cards.
   */
  contenders: string[];
  /**
   * The made hand, on THIS street's board, for every contender whose cards the
   * record shows this viewer - a showdown-revealed holding, or the viewer's
   * own private cards. Empty preflop (nothing to make yet) and for players
   * whose cards are not known. Named by the same evaluator that names the
   * showdown, so the two cannot disagree.
   */
  madeHands: Array<{ userId: string; name: string }>;
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
  /**
   * Keys of the cards that play, for lighting them. An array, not a Set: the
   * model is JSON-serialisable end to end so a record can travel through a
   * cache or a message without a shape that `JSON.stringify` turns into `{}`.
   */
  playing: string[];
  handName: string;
  /**
   * HI-LO: true on the row for a player's qualifying LOW on a split-pot
   * variant. High rows carry false. A PLO8 scoop produces two rows for one
   * player, one per half, each with its own hand name and share.
   */
  low: boolean;
  /**
   * The cards drawn are the viewer's own, never shown to the table (see
   * ReplayInput.privateHoleCards). The surface marks them so a face-up hand
   * in a "Mucked" row is not read as a reveal.
   */
  holePrivate: boolean;
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
      /** The viewer's own cards on a hand they did not show. Null otherwise. */
      privateHole: DeckCard[] | null;
    }
  >;
  /** True on a split-pot (eight-or-better) variant: rows come in halves. */
  hiLo: boolean;
  /**
   * THE RECORD SAID WHO WON EACH BOARD AND EACH HALF (`winners_by_board`).
   *
   * When it is true, a showdown row's `net` is that row's own share of the
   * pot. When it is false, the row carries the player's whole-hand NET
   * against board one and nothing at all against the others - the builder has
   * always done this, and it is correct for a rundown, which shows a player
   * what the hand cost or paid them.
   *
   * It is published because a consumer cannot tell those two numbers apart by
   * looking at them, and one of them is not a pot share. Phase 4's share link
   * read the showdown rows for per-board winners and, on an ordinary
   * single-board hand, put the winner's NET on the wire as the pot's GROSS -
   * understating the pot by the winner's own investment, which is the exact
   * conflation `winners[].amount` was corrected for on 2026-08-23.
   */
  perBoardAwards: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

const STREET_ORDER: Array<{ key: string; label: string; boardTo: number }> = [
  { key: 'preflop', label: 'PreFlop', boardTo: 0 },
  /**
   * A REAL STREET, not a footnote on preflop.
   *
   * `pineapple_discard` was being folded into preflop, so the shared rundown
   * never printed it — while the panel next door printed "Discard" for the
   * same actions. 74,631 discard actions exist in production. Collapsing a
   * street means its rows appear under a heading they did not happen on.
   */
  { key: 'pineapple_discard', label: 'Discard', boardTo: 0 },
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
  // Never actually rendered: `labelFor` prints the engine's own word instead.
  // Present so the map stays exhaustive over ReplayVerb, which is what makes
  // adding a verb a compile error rather than a silent fallthrough.
  unknown: 'Action',
};

/**
 * Verbs whose stored amount is a raise-TO level rather than an increment.
 *
 * Tested against the CANONICAL verb, not the raw string. It used to be tested
 * against `raw.toLowerCase()` while the label went through a normaliser that
 * also collapsed spaces and hyphens — so a row storing `"all in"` was labelled
 * All In and had its amount treated as an INCREMENT, adding the whole raise-to
 * level to the pot on top of what that seat already had in.
 */
const TO_LEVEL_VERBS = new Set(['bet', 'raise', 'all_in', 'allin']);

/**
 * The forced-money verbs that ARE a blind.
 *
 * The engine writes these as of 2026-08-27 (FORCED_BETS_POSTED). Millions of
 * rows predate it and carry none, which is why the blinds are still
 * synthesised below — but only when the log has no blinds of its own.
 *
 * `ante` and `straddle` are deliberately NOT here. Their presence says nothing
 * about whether the blinds were recorded, and treating them as evidence of
 * blinds is what made an antes-only tournament row rebuild short by SB + BB.
 */
const BLIND_VERBS = new Set([
  'post',
  'post_sb',
  'post_bb',
  'sb',
  'bb',
  'blind',
  'small_blind',
  'big_blind',
]);

const money = (n: number) => Math.round(n * 100) / 100;

/** One normalisation, used by BOTH the label and the amount rule. */
function canonicalVerb(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
}

/**
 * Returns null for anything this does not recognise.
 *
 * It used to return `'check'`. That is the worst possible default on a money
 * rundown: any action string the engine writes that is not in VERB_LABEL — a
 * timeout, a sit-out, a verb added next quarter — was drawn to the player as a
 * CHECK THAT NEVER HAPPENED, indistinguishable from a real one. An unknown
 * verb is now carried through as itself (see `labelFor`), which is ugly
 * exactly once and never a lie.
 */
function normalizeVerb(raw: string): ReplayVerb | null {
  const v = canonicalVerb(raw);
  if (v === 'allin' || v === 'all_in') return 'all_in';
  if (v === 'post_sb' || v === 'sb' || v === 'small_blind') return 'sb';
  if (v === 'post_bb' || v === 'bb' || v === 'big_blind') return 'bb';
  if (v === 'blind' || v === 'post') return 'bb';
  if ((VERB_LABEL as Record<string, string>)[v]) return v as ReplayVerb;
  return null;
}

/** The chip on the row. An unrecognised verb prints as itself, Title Cased. */
function labelFor(raw: string, verb: ReplayVerb | null): string {
  if (verb) return VERB_LABEL[verb];
  return titleCase(canonicalVerb(raw).replace(/_/g, ' ')) || 'Action';
}

function stageOf(a: ReplayActionInput): string {
  const s = String(a.stage ?? a.street ?? 'preflop').toLowerCase();
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

  /**
   * PHASE 4 2026-09-01 - the discarded card, by user, normalised once.
   *
   * Built up here rather than beside `holeByUser` further down because the
   * action rows are pushed BEFORE that point, and a discard row needs its card
   * at the moment it is created.
   *
   * `toDeckCards` is reused rather than a bespoke parser so a discard is read
   * by exactly the same code that reads a hole card and a board card: one
   * shape rule for every card in this file. It takes an array, so the single
   * card is wrapped and unwrapped - a deliberate round trip that keeps the
   * storage format free to become an array later without touching this.
   */
  const discardByUser = new Map<string, DeckCard>();
  for (const [uid, card] of Object.entries(input.discardedCards || {})) {
    if (!card) continue;
    const deck = toDeckCards([card]);
    if (deck.length > 0) discardByUser.set(uid, deck[0]);
  }
  const discardedCardFor = (userId: string | undefined): DeckCard | null =>
    (userId && discardByUser.get(userId)) || null;

  const board = toDeckCards(input.board);
  const extra = (input.extraBoards || []).map((b) => toDeckCards(b)).filter((b) => b.length > 0);
  const ritFromLog = ritBoardsFromActions(input.actions || []).map((b) => toDeckCards(b));
  /* ONE COPY OF EACH BOARD (2026-09-04 second sweep). The engine writes a
     run-it-twice board BOTH as the `rit_boards` column and as a `rit_board_N:`
     pseudo-action "for old readers", and this concatenated the two, so every
     row written since the column existed listed each extra run twice. The
     column is authoritative when it is present; the log is the fallback for
     rows that predate it. And a board that is card-for-card identical to one
     already listed is the same board, whatever the source. */
  const seen = new Set<string>();
  const boards: DeckCard[][] = [];
  for (const b of [board, ...(extra.length > 0 ? extra : ritFromLog)]) {
    if (b.length === 0) continue;
    const sig = b.map(cardKey).join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    boards.push(b);
  }
  if (boards.length === 0) boards.push([]);
  const hiLo = isEightOrBetterVariant(input.gameVariant);

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
  /**
   * Does the log carry the BLINDS specifically?
   *
   * This used to ask whether the log had any forced-money verb at all, with
   * `ante` in the set — so a tournament row that recorded antes but no blinds
   * suppressed blind synthesis entirely. The rebuilt pot came out short by
   * SB + BB, `reconciles` went false, the whole stack column was withdrawn,
   * and every preflop raise-TO was differenced against a `committed` map that
   * was missing the blinds. An ante is not a blind, and its presence says
   * nothing about whether the blinds were recorded.
   */
  const logHasBlinds = live.some((a) => BLIND_VERBS.has(canonicalVerb(a.action)));
  /**
   * A hand written by an engine that records its own returns needs no
   * inference — and inferring on top of a recorded return would subtract the
   * same chips twice.
   */
  const logHasReturns = live.some((a) => normalizeVerb(a.action) === 'return');

  // Blinds, synthesised only when the log does not already carry them.
  /**
   * A bomb pot posts ANTES AND NO BLINDS, so "the log has no blinds" is the
   * truth there rather than a gap to be filled. Read from the row's own
   * `bomb_pot` fact, and from a `bomb_ante` row for any input path that does
   * not carry it (the share codec, an import).
   */
  const isBombPot =
    input.bombPot === true || live.some((a) => canonicalVerb(a.action).includes('bomb_ante'));

  const preflopPosts: Array<ReplayRow & { stage: string }> = [];
  if (!logHasBlinds && !isBombPot) {
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
        discardedCard: null,
        privateCards: null,
        // Synthesised because the log had no blinds at all: a live blind.
        dead: false,
      });
    };
    post(sbSeat, Number(input.smallBlind) || 0, 'sb');
    post(bbSeat, Number(input.bigBlind) || 0, 'bb');
  }
  rows.push(...preflopPosts);

  // Per-street committed totals, so a raise-TO level becomes an increment.
  let streetKey = 'preflop';
  let committed = new Map<number, number>();
  if (!logHasBlinds) {
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
  /**
   * Uncalled bets this reader INFERRED, kept so the engine's own pot_size can
   * overrule them.
   *
   * The inference is right for the common case — a bet everyone folds to — and
   * it is a guess on any street whose log is incomplete, where it would
   * fabricate a Return that never happened and a negative number in a money
   * rundown. Rather than pick a heuristic and hope, both readings are computed
   * and `pot_size` decides which one was real. See the reconciliation below.
   */
  const inferredReturns: Array<{ key: string; seat: number; amount: number }> = [];

  const settleStreet = () => {
    if (logHasReturns) return;
    const entries = [...committed.entries()].filter(([, v]) => v > 0);
    if (entries.length < 1) return;
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries[0];
    const next = entries[1]?.[1] ?? 0;
    const excess = money(top[1] - next);
    if (excess <= 0.005) return;
    addMoney(top[0], -excess);
    inferredReturns.push({ key: `return-${streetKey}-${top[0]}`, seat: top[0], amount: excess });
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
      discardedCard: null,
      privateCards: null,
      dead: false,
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
    const canonical = canonicalVerb(a.action);
    const raw = Number(a.amount) || 0;

    let increment = 0;
    if (verb === 'return') {
      // Stored positive, like every other amount. The verb carries the
      // direction, so the sign is applied here and exactly once.
      increment = -Math.abs(raw);
    } else if (input.amountsAreIncremental) {
      increment = raw;
    } else if (TO_LEVEL_VERBS.has(canonical)) {
      increment = money(raw - (committed.get(seat) || 0));
    } else {
      increment = raw;
    }
    if (increment < 0 && verb !== 'return') increment = 0;

    /**
     * DEAD money goes into the pot but NOT into the live bet level.
     *
     * Computed for EVERY row (not only the ones that moved chips) and carried
     * on the row itself, so every consumer - the rundown, the frames, the
     * felt's bet pills, the pot odds - reads one answer instead of guessing.
     */
    const isDead = (a as { dead?: boolean }).dead === true || canonical === 'ante';
    if (increment !== 0) {
      addMoney(seat, increment);
      /**
       * `committed` exists for one job: differencing a raise-TO level against
       * what that seat already had in. An ante is in the pot and counts toward
       * nothing — a player who posted a 1 ante and then raises TO 20 has added
       * 20 live chips, not 19. Folding the ante into `committed` understates
       * every raise made by anyone who posted one, which in a tournament is
       * everyone at the table.
       *
       * `verb === 'ante'` is the floor for rows written before the engine
       * carried the flag, and for any importer that does not set it.
       */
      if (!isDead) committed.set(seat, money((committed.get(seat) || 0) + increment));
    }

    rows.push({
      key: `a-${i}`,
      stage,
      seat,
      userId: a.userId || bySeat.get(seat)?.userId || '',
      name: bySeat.get(seat)?.username || 'Player',
      position: positions[seat] || '',
      // An unrecognised verb keeps the engine's own word for it rather than
      // being coerced into one of ours. `unknown` is a real ReplayVerb so the
      // CSS has something to hang off; the LABEL is what the player reads.
      verb: verb ?? 'unknown',
      label: labelFor(a.action, verb),
      amount: increment,
      stackAfter: null,
      dead: isDead,
      showsMuck: verb === 'fold' || verb === 'muck',
      shownCards: null,
      /* PHASE 4 2026-09-01: the card this seat threw, and only ever the
         viewer's own - `discardedCards` is populated straight from
         `hand_discards`, whose RLS hands a client nothing but its own rows.
         Undefined for every hand played before this shipped, so those rows
         render exactly as they did. */
      discardedCard:
        verb === 'discard' ? discardedCardFor(a.userId || bySeat.get(seat)?.userId) : null,
      privateCards: null,
    });
  });
  settleStreet();

  /**
   * THE STORED POT ARBITRATES THE INFERENCE.
   *
   * If the rebuild with the inferred returns does not land on `pot_size` but
   * the rebuild WITHOUT them does, the inference was wrong and it is withdrawn
   * — rows, chips and all. A guess that disagrees with the engine's own number
   * is not a guess worth drawing.
   */
  const returnedTotal = money(inferredReturns.reduce((t, r) => t + r.amount, 0));
  const storedPot = Number(input.potSize) || 0;
  if (
    inferredReturns.length > 0 &&
    Math.abs(money(pot) - storedPot) >= 0.02 &&
    Math.abs(money(pot + returnedTotal) - storedPot) < 0.02
  ) {
    for (const r of inferredReturns) {
      pot = money(pot + r.amount);
      invested.set(r.seat, money((invested.get(r.seat) || 0) + r.amount));
    }
    const dropped = new Set(inferredReturns.map((r) => r.key));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (dropped.has(rows[i].key)) rows.splice(i, 1);
    }
  }

  const rebuiltPot = money(pot);
  /**
   * A hand whose stored pot is 0 and whose rebuild is also 0 DOES reconcile.
   *
   * This required `storedPot > 0`, so a walk - or any row written before
   * pot_size existed - could never reconcile even when the rebuild was
   * provably exact, and the stack column was withdrawn for no reason.
   */
  const reconciles = Math.abs(rebuiltPot - storedPot) < 0.02;

  // ── starting stacks, then the stack after every row ────────────────────────
  const startStack = new Map<number, number | null>();
  for (const p of players) {
    const seat = Number(p.seat);
    const end = p.stack === null || p.stack === undefined ? null : Number(p.stack);
    const inv = invested.get(seat) || 0;
    const won = wonByUser.get(p.userId) || 0;
    /* A producer that KNOWS the starting stack says so, and is believed - it
       is a fact rather than an inversion of the settled figure. Still gated on
       the rebuild, because `stackAfter` subtracts this street by street and a
       short rebuild makes every one of those subtractions wrong. */
    const declared = input.startStacks?.[seat];
    if (declared !== null && declared !== undefined && reconciles) {
      startStack.set(seat, money(Number(declared)));
      continue;
    }
    // Only trustworthy when the rebuild agrees with the engine's own pot: if
    // forced money is missing (an ante, a straddle) `inv` is short and every
    // figure in this column would be short with it.
    startStack.set(seat, end === null || !reconciles ? null : money(end - won + inv));
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
  /* The viewer's own unrevealed cards. Kept apart from `holeByUser` on
     purpose: presence in THAT map is the reveal flag (it makes a `show` row and
     a showdown seat), and a card the table never saw must do neither. */
  const privateByUser = new Map<string, DeckCard[]>();
  for (const [uid, cards] of Object.entries(input.privateHoleCards || {})) {
    if (holeByUser.has(uid)) continue;
    const deck = toDeckCards(cards);
    if (deck.length > 0) privateByUser.set(uid, deck);
  }
  // The viewer's own fold draws their own cards; nobody else's does.
  for (const r of rows) {
    if (r.verb === 'fold' && r.userId && privateByUser.has(r.userId)) {
      r.privateCards = privateByUser.get(r.userId) || null;
    }
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
      // A `show` moves no chips, so there is no stack transition to draw. The
      // column is blank here by intent, not by accident - this line used to be
      // a ternary whose two branches were both null.
      stackAfter: null,
      showsMuck: false,
      shownCards: hole,
      discardedCard: null,
      privateCards: null,
      dead: false,
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

  /* Phase 2: who is still in when each street begins, and what each known
     hand has made on it. Folds are cumulative across streets. */
  const foldedBefore = new Set<string>();
  const knownHole = (uid: string): DeckCard[] | null =>
    holeByUser.get(uid) || privateByUser.get(uid) || null;
  const builtStreets = STREET_ORDER.map((street, i) => {
    const prev = i === 0 ? 0 : STREET_ORDER[i - 1].boardTo;
    const contenders = players.map((p) => p.userId).filter((uid) => !foldedBefore.has(uid));
    const streetBoard = board.slice(0, street.boardTo);
    const madeHands: Array<{ userId: string; name: string }> = [];
    if (streetBoard.length >= 3) {
      for (const uid of contenders) {
        const hole = knownHole(uid);
        if (!hole) continue;
        const made = bestFive(hole, streetBoard, input.gameVariant);
        if (made) madeHands.push({ userId: uid, name: titleCase(made.name) });
      }
    }
    for (const r of rows) {
      if (r.stage === street.key && (r.verb === 'fold' || r.verb === 'muck') && r.userId)
        foldedBefore.add(r.userId);
    }
    return {
      key: street.key,
      label: street.label,
      board: streetBoard,
      newCards: board.slice(prev, street.boardTo),
      contenders,
      madeHands,
      /**
       * EVERY EXTRA BOARD, sliced to the same street. A run-it-twice hand and a
       * double-board bomb pot both deal a second board street by street, and
       * until now the model carried those boards and the view drew only board
       * one - the second run existed as a text label and nothing else.
       */
      extraBoards: boards.slice(1).map((b) => b.slice(0, street.boardTo)),
      potAfter: potAtEndOf.get(street.key) ?? 0,
      rows: rows.filter((r) => r.stage === street.key).map(({ stage: _s, ...rest }) => rest),
    };
  }).filter((s) => s.rows.length > 0 || s.newCards.length > 0);

  /**
   * The pot line under a street is a RUNNING total, not the main pot.
   *
   * It read `Main({potAfter})` after every street, so a flop section announced
   * `Main(24.00)` on a hand whose main pot was 240 - true only on the last
   * street. Only the final street can speak for the pot, and only that one now
   * carries the real breakdown.
   */
  const streets: ReplayStreet[] = builtStreets.map((s, i) => ({
    ...s,
    isFinal: i === builtStreets.length - 1,
  }));

  // ── pot breakdown, resolved before the showdown rows that name it ─────────
  const storedPotsRaw = (input.pots || []).filter((p) => Number(p?.amount) > 0);
  const potBreakdown =
    storedPotsRaw.length > 0
      ? storedPotsRaw.map((p, i) => ({
          label: i === 0 ? 'Main' : `Side ${i}`,
          amount: money(Number(p.amount) || 0),
        }))
      : [{ label: 'Main', amount: money(storedPot || rebuiltPot) }];

  /**
   * Which pot a player contested.
   *
   * The engine records the winner of each pot index in `winners[].potIndex`,
   * so for anyone who won something the answer is exact. For everyone else it
   * is the main pot unless they were all-in short, which the row does not
   * record — so it says "Main pot" rather than guessing at a side pot.
   */
  const potIndexByWinner = new Map<string, number>();
  for (const w of input.winners || []) {
    if (!w?.userId) continue;
    const idx = Number(w.potIndex) || 0;
    const prev = potIndexByWinner.get(w.userId);
    if (prev === undefined || idx > prev) potIndexByWinner.set(w.userId, idx);
  }
  const potLabelFor = (userId: string): string => {
    const idx = potIndexByWinner.get(userId);
    if (idx === undefined || idx <= 0) return 'Main pot';
    return `${potBreakdown[idx]?.label ?? `Side ${idx}`} pot`;
  };

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

  /* WHO WON EACH BOARD, when the row says (2026-09-04). Keyed `${board}|${uid}`
     with the 1-based board index the writer uses. */
  const perBoard = new Map<string, { amount: number; handName?: string }>();
  for (const w of input.winnersByBoard || []) {
    const uid = w.userId || w.user_id;
    if (!uid) continue;
    /* One key per (board, winner, half). A row older than the `low` flag has
       no half and is read as high, which is what it was. */
    perBoard.set(`${Number(w.board) || 1}|${uid}|${w.low ? 'lo' : 'hi'}`, {
      amount: Number(w.amount) || 0,
      handName: w.handName || undefined,
    });
  }
  const hasPerBoard = perBoard.size > 0;
  const hasLowAwards = [...perBoard.keys()].some((k) => k.endsWith('|lo'));

  /* A SHOWDOWN ROW IS A PLAYER WHOSE CARDS WERE SHOWN, OR WHO MUCKED AT
     SHOWDOWN (Dan 2026-09-04: "doesn't display the correct hands"). This used
     to emit a row for EVERY player in the hand, on EVERY board - so a six-way
     fold-around listed six seats of card backs under a "Showdown" heading. A
     player with no cards on record and no showdown ruling folded earlier;
     they are in the action log, not here. */
  const atShowdown = ordered.filter((p) => holeByUser.has(p.userId) || muckedByUser.has(p.userId));

  boards.forEach((b, boardIndex) => {
    for (const p of atShowdown) {
      const publicHole = holeByUser.get(p.userId) || null;
      const privateHole = privateByUser.get(p.userId) || null;
      /* A mucked seat draws the viewer's OWN cards when the record has them,
         marked private; anyone else's muck stays backs. The evaluation runs on
         whichever is drawn, so the viewer sees what their muck was worth. */
      const hole = publicHole || privateHole;
      const holePrivate = !publicHole && !!privateHole;
      const made = hole ? bestFive(hole, b, input.gameVariant) : null;
      const won = wonByUser.get(p.userId) || 0;
      const inv = invested.get(Number(p.seat)) || 0;
      const onThisBoard = perBoard.get(`${boardIndex + 1}|${p.userId}|hi`);
      const lowOnThisBoard = perBoard.get(`${boardIndex + 1}|${p.userId}|lo`);
      /* THE HAND ON THIS BOARD. The hand-level name (showdown / engine) is
         board 1's; on a multi-board hand the row used to draw board 2's best
         five under board 1's name. Per-board name first, then the local
         evaluation against THIS board, then the hand-level name only for
         board 1. */
      const boardName =
        onThisBoard?.handName ||
        (boards.length > 1 && boardIndex > 0
          ? made?.name || ''
          : showdownName.get(p.userId) || engineHandName.get(p.userId) || made?.name || '');
      showdownRows.push({
        key: `sd-${boardIndex}-${p.userId}`,
        userId: p.userId,
        name: p.username,
        seat: Number(p.seat),
        position: positions[Number(p.seat)] || '',
        hole,
        holePrivate,
        made: made?.cards || [],
        playing: (made?.cards || []).map(cardKey),
        handName: titleCase(boardName),
        low: false,
        boardIndex,
        boardLabel:
          boards.length > 1
            ? `Board ${boardIndex + 1}${hiLo ? ' High' : ''}`
            : hiLo
              ? 'High'
              : null,
        /* Per board when the record has it (the share of that board);
           otherwise the whole-hand net once, against board one, rather than
           invented for every board. On a hi-lo hand with per-half awards the
           high row carries the high share and the low row the low share. */
        net: hasPerBoard
          ? onThisBoard
            ? money(onThisBoard.amount)
            : boards.length > 1 || hasLowAwards
              ? null
              : money(won - inv)
          : boardIndex === 0
            ? money(won - inv)
            : null,
        // Names the pot this player actually contested. It was hard-coded to
        // "Main pot" for every row, which is a claim rather than a label the
        // moment a hand has a side pot.
        potLabel: potLabelFor(p.userId),
        // A one-board winner is not a winner on the other boards.
        isWinner: hasPerBoard ? !!onThisBoard : won > 0,
      });

      /* THE LOW HALF (hi-lo variants only). One extra row per player who
         qualifies for a low on this board, or whom the record paid a low. The
         name comes from the record when it has one and from the local
         eight-or-better evaluation otherwise - the same evaluator the engine
         awards with. A row without per-half awards cannot say who won the
         low, and does not: `isWinner` stays false and the share blank rather
         than guessed. */
      if (hiLo) {
        const low = hole ? bestLow(hole, b) : null;
        if (low || lowOnThisBoard) {
          showdownRows.push({
            key: `sd-${boardIndex}-${p.userId}-lo`,
            userId: p.userId,
            name: p.username,
            seat: Number(p.seat),
            position: positions[Number(p.seat)] || '',
            hole,
            holePrivate,
            made: low?.cards || [],
            playing: (low?.cards || []).map(cardKey),
            handName: lowOnThisBoard?.handName || low?.name || 'Low',
            low: true,
            boardIndex,
            boardLabel: boards.length > 1 ? `Board ${boardIndex + 1} Low` : 'Low',
            net: lowOnThisBoard ? money(lowOnThisBoard.amount) : null,
            potLabel: potLabelFor(p.userId),
            isWinner: !!lowOnThisBoard,
          });
        }
      }
    }
  });

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
        privateHole: privateByUser.get(p.userId) || null,
      };
    }),
    hiLo,
    perBoardAwards: hasPerBoard,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ROW -> INPUT MAPPER, shared by every reader of hand_history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `hand_history` row as PostgREST returns it. Every field optional: the
 * mapper is fed by three different SELECT lists and must read what is there.
 */
export interface HandHistoryRowLike {
  id?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  hand_number?: number | string | null;
  game_variant?: string | null;
  small_blind?: number | string | null;
  big_blind?: number | string | null;
  pot_size?: number | string | null;
  rake_amount?: number | string | null;
  bbj_amount?: number | string | null;
  button_seat?: number | string | null;
  community_cards?: unknown;
  bomb_pot?: unknown;
  community_cards2?: unknown;
  community_cards3?: unknown;
  rit_boards?: unknown;
  players?: unknown;
  actions?: unknown;
  winners?: unknown;
  winners_by_board?: unknown;
  hole_cards?: unknown;
  showdown?: unknown;
  pots?: unknown;
}

/**
 * The one mapping from a stored row to `buildReplay`'s input.
 *
 * 2026-09-04 (Previous Hand second sweep): three readers each built this
 * input by hand - HandHistoryService with half the fields (no extra boards,
 * no showdown, no pots, no per-board winners, no jackpot fee), the replay
 * hook with a different half (no discards), and HandReplay with none of it.
 * A field added to one was silently absent from the others. Now there is one
 * place a column is read, and a surface that wants the model calls this.
 *
 * `extras` carries what the row itself cannot: the viewer's own discard and
 * the viewer's own unrevealed cards, both read through RLS-scoped tables by
 * the caller and keyed by user id.
 */
export function replayInputFromRow(
  row: HandHistoryRowLike,
  extras: {
    discardedCards?: Record<string, StoredCard> | null;
    privateHoleCards?: Record<string, StoredCard[]> | null;
  } = {}
): ReplayInput {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const cards = (v: unknown): StoredCard[] => arr(v) as StoredCard[];
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const players = arr(row.players).map((p) => {
    const r = rec(p);
    return {
      userId: String(r.userId ?? ''),
      username: String(r.username ?? 'Player'),
      seat: Number(r.seat) || 0,
      stack: r.stack === undefined || r.stack === null ? null : Number(r.stack),
    };
  });
  const actions = arr(row.actions).map((a) => {
    const r = rec(a);
    return {
      seat: Number(r.seat) || 0,
      userId: String(r.userId ?? ''),
      action: String(r.action ?? ''),
      amount: r.amount === undefined || r.amount === null ? 0 : Number(r.amount),
      stage: (r.stage as string | null | undefined) ?? null,
      /* The engine has written `dead` on forced-money rows since the ante
         work; this mapper dropped it, so only the rows whose verb happened to
         be the literal string `ante` hit the fallback and a bomb pot's
         `bomb_ante` was read as live money in front of the seat. */
      dead: r.dead === true,
    };
  });
  const winners = arr(row.winners).map((w) => {
    const r = rec(w);
    return {
      userId: String(r.userId ?? ''),
      amount: Number(r.amount) || 0,
      potIndex: Number(r.potIndex) || 0,
      hand: (r.hand as { name?: string } | null | undefined) ?? null,
    };
  });
  const winnersByBoard = arr(row.winners_by_board).map((w) => {
    const r = rec(w);
    return {
      board: Number(r.board) || 1,
      userId: String(r.userId ?? r.user_id ?? ''),
      amount: Number(r.amount) || 0,
      handName: typeof r.handName === 'string' ? r.handName : undefined,
      low: r.low === true,
    };
  });
  const buttonRaw = Number(row.button_seat);
  return {
    handNumber: (row.hand_number as number | string | null | undefined) ?? null,
    playedAt: row.started_at || row.created_at || null,
    gameVariant: row.game_variant ?? null,
    smallBlind: Number(row.small_blind) || 0,
    bigBlind: Number(row.big_blind) || 0,
    potSize: Number(row.pot_size) || 0,
    rakeAmount: Number(row.rake_amount) || 0,
    bbjAmount: Number(row.bbj_amount) || 0,
    buttonSeat: Number.isFinite(buttonRaw) && buttonRaw > 0 ? buttonRaw : null,
    board: cards(row.community_cards),
    // rit_boards is boards 2..N of a run-it-twice; community_cards2/3 are the
    // second and third boards of a bomb pot. Different features, both extra
    // boards as far as the rundown is concerned.
    extraBoards: [
      ...arr(row.rit_boards).map((b) => cards(b)),
      ...(arr(row.community_cards2).length ? [cards(row.community_cards2)] : []),
      ...(arr(row.community_cards3).length ? [cards(row.community_cards3)] : []),
    ],
    players,
    actions,
    winners,
    winnersByBoard: winnersByBoard.length ? winnersByBoard : null,
    holeCards: (row.hole_cards as Record<string, StoredCard[]> | null | undefined) ?? {},
    showdown: (row.showdown as ReplayShowdownInput[] | null | undefined) ?? null,
    pots: (row.pots as { index?: number; amount?: number }[] | null | undefined) ?? null,
    discardedCards: extras.discardedCards ?? null,
    privateHoleCards: extras.privateHoleCards ?? null,
    bombPot: row.bomb_pot != null,
  };
}
