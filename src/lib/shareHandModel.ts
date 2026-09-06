/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SHARED HAND IS THE SAME HAND — the model on both ends of the link
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 4 of the Previous Hand build plan (2026-09-05). Until today a shared
 * hand was a SECOND hand shape with a second reading of the same poker: the
 * sharer looked at `HandRecord.replay` - the one reconstruction, with its
 * boards, its dead money, its hi-lo halves and its rake - and the recipient
 * got a flat list of streets that could not draw a felt, could not run, and
 * did not know a run-it-twice hand had a second board.
 *
 * Two functions, and the link is a round trip:
 *
 *   shareableFromModel(model, meta)  the sharer's model  -> the wire shape
 *   replayFromShareable(hand)        the wire shape      -> the SAME model
 *
 * The second one calls `buildReplay`, exactly as HandHistoryService does for a
 * database row. So the recipient's replayer is not a copy of the sharer's
 * replayer: it is the same component, driven by a model built by the same
 * builder from the same facts. Nothing here re-walks an action log, and
 * nothing here invents a figure the wire did not carry.
 *
 * WHAT THE WIRE CANNOT CARRY, IT LEAVES EMPTY. A recipient's model has no side
 * pots (only the total is shared), no per-street pot history and no stacks
 * unless the sharer knew them. Every one of those degrades to "not shown"
 * rather than to a plausible number, which is the whole difference between a
 * hand history and a story about a hand.
 */

import {
  buildReplay,
  type ReplayActionInput,
  type ReplayInput,
  type ReplayModel,
  type ReplayWinnerInput,
} from '../utils/handReplay';
import type {
  ShareableAction,
  ShareableCard,
  ShareableHand,
  ShareablePlayer,
  ShareableWinner,
} from '../components/table/ShareHand';
import type { DeckCard } from '../utils/deckCards';

// ─────────────────────────────────────────────────────────────────────────────
// VARIANTS
// ─────────────────────────────────────────────────────────────────────────────

const SHARE_VARIANTS = [
  'NLH',
  'PLO4',
  'PLO5',
  'PLO6',
  'PLO8',
  'Short Deck',
  'Crazy Pineapple',
] as const;

/**
 * Widen a stored game_type onto the share union without silently
 * mislabelling. Order matters: PLO8 must be tested before PLO, and SHORT
 * before anything else, or "PLO8" is shared as "PLO4" - which is what the
 * union's own comment records as having happened.
 *
 * It lives here now rather than in `handHistoryAdapter`, because the TABLE
 * had its own copy that listed four of the seven variants and read everything
 * else as NLH: a PLO8 hand shared from the felt reached the recipient as
 * hold'em, which changes how many cards each seat is dealt and whether the
 * pot splits. One mapping, used by both producers.
 */
export function toShareVariant(gameType: string | undefined | null): ShareableHand['variant'] {
  const g = (gameType || '').toUpperCase().replace(/[\s_-]/g, '');
  if (g.includes('PINEAPPLE')) return 'Crazy Pineapple';
  if (g.includes('SHORT') || g === 'SIXPLUS') return 'Short Deck';
  if (g.includes('PLO8') || g.includes('FLO8') || g.includes('OMAHA8') || g.includes('HILO'))
    return 'PLO8';
  if (g.includes('PLO6')) return 'PLO6';
  if (g.includes('PLO5')) return 'PLO5';
  if (g.includes('PLO') || g.includes('OMAHA')) return 'PLO4';
  return (SHARE_VARIANTS as readonly string[]).includes(gameType || '')
    ? (gameType as ShareableHand['variant'])
    : 'NLH';
}

/** The share label back to the variant KEY the reconstruction reads. */
const VARIANT_KEY: Record<ShareableHand['variant'], string> = {
  NLH: 'nlh',
  PLO4: 'plo4',
  PLO5: 'plo5',
  PLO6: 'plo6',
  PLO8: 'plo8',
  'Short Deck': 'short_deck',
  'Crazy Pineapple': 'pineapple',
};

// ─────────────────────────────────────────────────────────────────────────────
// VERBS
// ─────────────────────────────────────────────────────────────────────────────

/** Model verb -> wire verb. A verb with no entry does not travel. */
const WIRE_VERB: Partial<Record<string, ShareableAction['action']>> = {
  fold: 'FOLD',
  check: 'CHECK',
  call: 'CALL',
  bet: 'BET',
  raise: 'RAISE',
  all_in: 'ALL_IN',
  sb: 'SB',
  bb: 'BB',
  ante: 'ANTE',
  straddle: 'STRADDLE',
  return: 'RETURN',
  discard: 'DISCARD',
};

/**
 * Wire verb -> the word the reconstruction canonicalises from.
 *
 * `POST` stays `post`, which the reader does not canonicalise: the row keeps
 * the engine's own word, its chips count into the pot at face value, and it
 * joins no bet level. That is the honest reading of "some forced post whose
 * name this link does not know" - calling it a big blind instead would put it
 * into the live bet level and every raise-TO after it would be differenced
 * against a level that was never there.
 */
const MODEL_VERB: Record<ShareableAction['action'], string> = {
  FOLD: 'fold',
  CHECK: 'check',
  CALL: 'call',
  BET: 'bet',
  RAISE: 'raise',
  ALL_IN: 'all_in',
  SB: 'sb',
  BB: 'bb',
  ANTE: 'ante',
  STRADDLE: 'straddle',
  POST: 'post',
  RETURN: 'return',
  DISCARD: 'discard',
};

// ─────────────────────────────────────────────────────────────────────────────
// CARDS
// ─────────────────────────────────────────────────────────────────────────────

const toShareCard = (c: DeckCard): ShareableCard => ({ rank: c.rank, suit: c.suit });
const toShareCards = (cards: DeckCard[] | null | undefined): ShareableCard[] =>
  (cards || []).map(toShareCard);

/**
 * Blinds off the stakes string.
 *
 * Tolerant on purpose: v4 writes plain numbers (`500/1000`), but every payload
 * already in the wild carries whatever the producer displayed, and
 * `blindLabel` group-separates - so a tournament's "500/1,000" reached
 * `parseFloat` as 1. Strip everything that is not a digit or a point.
 */
export function blindsFromStakes(stakes: string | null | undefined): {
  smallBlind: number;
  bigBlind: number;
} {
  const [sb, bb] = String(stakes || '').split('/');
  const num = (s: string | undefined) => {
    const v = Number(String(s ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(v) ? v : 0;
  };
  return { smallBlind: num(sb), bigBlind: num(bb) };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL -> WIRE
// ─────────────────────────────────────────────────────────────────────────────

export interface ShareableFromModelMeta {
  /** The hand's id, so the modal has a stable key. */
  id: string;
  tableName: string;
  /** Whose share this is. Marks one seat as the hero; never changes the hand. */
  heroUserId?: string | null;
}

/**
 * The rows of one street, as the wire carries them. The model keys are
 * `preflop`, `pineapple_discard`, `flop`, `turn` and `river`, and the payload
 * has a slot for each.
 */
function wireActions(model: ReplayModel, key: string): ShareableAction[] {
  const street = model.streets.find((s) => s.key === key);
  if (!street) return [];
  const out: ShareableAction[] = [];
  for (const row of street.rows) {
    let verb = WIRE_VERB[row.verb];
    /**
     * A VERB THE WIRE HAS NO WORD FOR STILL MOVED CHIPS.
     *
     * `show` and `muck` do not travel as actions - what they mean travels on
     * the player instead, so a recipient cannot end up with a show row for
     * cards the link did not carry - and neither moves money, so dropping
     * them costs nothing.
     *
     * A row the reader could not canonicalise is different. The engine's
     * `bomb_ante` is exactly that: an unmistakable forced post that reaches
     * the model with the verb `unknown` and only its DEAD flag to say what it
     * is. Dropping it took the whole bomb-pot ante off the wire, so the
     * recipient's pot rebuilt to nothing against a stored pot of 3.00 and the
     * hand arrived "not reconciled" with its stack column withdrawn. Anything
     * dead travels as an ante; anything else that moved chips travels as a
     * generic post, which the reader keeps at face value.
     */
    if (!verb) {
      if (row.dead && row.amount !== 0) verb = 'ANTE';
      else if (row.amount !== 0) verb = 'POST';
      else continue;
    }
    const action: ShareableAction = { seat: row.seat, action: verb };
    /* A returned uncalled bet is negative in the model and positive on the
       wire: the wire's money is unsigned, and the reconstruction re-applies
       the sign from the verb. Encoding it as-is clamped it to zero and left
       the uncalled bet sitting in the recipient's pot. */
    if (row.amount !== 0) action.amount = Math.abs(row.amount);
    if (row.dead) action.dead = true;
    out.push(action);
  }
  return out;
}

export function shareableFromModel(
  model: ReplayModel,
  meta: ShareableFromModelMeta
): ShareableHand {
  const board = model.streets.length ? model.streets[model.streets.length - 1].board : [];
  const flopCards = board.slice(0, 3);
  const turnCard = board[3];
  const riverCard = board[4];

  const flopActions = wireActions(model, 'flop');
  const turnActions = wireActions(model, 'turn');
  const riverActions = wireActions(model, 'river');
  const discardActions = wireActions(model, 'pineapple_discard');

  /* The high row a seat showed down with, for the seat strip's label. */
  const highRow = (userId: string) =>
    model.showdown.find((r) => r.userId === userId && r.boardIndex === 0 && !r.low);

  const players: ShareablePlayer[] = model.players.map((p) => {
    const shown = p.hole && p.hole.length ? p.hole : null;
    const player: ShareablePlayer = {
      seat: p.seat,
      name: p.username,
    };
    if (p.startStack !== null && p.startStack !== undefined) player.stack = p.startStack;
    /* Only holdings the TABLE saw travel as shown cards. The sharer's own
       unrevealed hand travels too, marked private, so their replayer draws it
       face-up for them without telling the recipient that a hand which never
       reached showdown did. */
    if (shown) {
      player.cards = toShareCards(shown);
    } else if (p.privateHole && p.privateHole.length && p.userId === meta.heroUserId) {
      player.cards = toShareCards(p.privateHole);
      player.privateCards = true;
    }
    /* Stated either way, so a reader can tell "not the hero" from "the
       producer did not say". */
    player.isHero = p.userId === meta.heroUserId;
    player.isWinner = p.won > 0;
    if (p.mucked) player.mucked = true;
    const high = highRow(p.userId);
    if (high?.handName) player.handName = high.handName;
    return player;
  });

  /**
   * WHO WON WHAT, AND ON WHICH BOARD. A run-it-twice hand pays a share per
   * board and a hi-lo hand pays a share per half; both used to arrive as one
   * flat "seat won N", so a recipient could not tell a scoop from a split and
   * a two-board hand looked like one pot with a strange number in it.
   */
  const seatOf = new Map(model.players.map((p) => [p.userId, p.seat]));
  /**
   * ONLY when the record actually said who won each board and each half. A
   * showdown row's `net` is a pot SHARE then; without per-board awards it is
   * the player's whole-hand net, and putting that on the wire understates the
   * pot by the winner's own investment - 195 where the pot paid 201 on this
   * repo's own fixture, which is the conflation `winners[].amount` was
   * corrected for on 2026-08-23.
   */
  const perBoard = model.perBoardAwards
    ? model.showdown.filter((r) => r.isWinner && r.net !== null)
    : [];
  const winners: ShareableWinner[] = perBoard.length
    ? perBoard.map((r) => ({
        seat: r.seat,
        amount: Math.max(0, Number(r.net) || 0),
        board: r.boardIndex + 1,
        low: r.low || undefined,
        hand: r.handName || undefined,
      }))
    : model.players
        .filter((p) => p.won > 0)
        .map((p) => ({
          seat: seatOf.get(p.userId) ?? p.seat,
          amount: p.won,
          hand: highRow(p.userId)?.handName || undefined,
        }));

  const hand: ShareableHand = {
    id: meta.id,
    tableName: meta.tableName || 'Club Arena',
    variant: toShareVariant(model.gameVariant),
    /* Plain numbers, so the recipient's blinds are the sharer's blinds. */
    stakes: `${model.smallBlind}/${model.bigBlind}`,
    timestamp: model.playedAt ? new Date(model.playedAt).getTime() || Date.now() : Date.now(),
    buttonSeat: model.buttonSeat ?? 0,
    players,
    preflop: wireActions(model, 'preflop'),
    flop:
      flopCards.length >= 3 ? { cards: toShareCards(flopCards), actions: flopActions } : undefined,
    turn: turnCard ? { card: toShareCard(turnCard), actions: turnActions } : undefined,
    river: riverCard ? { card: toShareCard(riverCard), actions: riverActions } : undefined,
    potTotal: model.potTotal,
    winners,
    handNumber: model.handNumber ?? null,
  };

  if (discardActions.length) hand.discard = { actions: discardActions };
  /* Every board past the first: the run-it-twice runs, or the second and
     third boards of a double-board bomb pot. Read off the last street so a
     run that ended early carries what it actually ran to. */
  const extra = model.streets.length
    ? model.streets[model.streets.length - 1].extraBoards.map(toShareCards)
    : [];
  if (extra.some((b) => b.length > 0)) hand.extraBoards = extra.filter((b) => b.length > 0);
  if (model.rake > 0) hand.rake = model.rake;
  if (model.bbjFee > 0) hand.bbjFee = model.bbjFee;
  /* A bomb pot posts antes and no blinds. Said out loud on the wire, because
     a reconstruction that infers it would infer blinds nobody posted. */
  if (isBombPot(model)) hand.bombPot = true;

  return hand;
}

/**
 * Forced money, all of it dead, and no blind: that is a bomb pot.
 *
 * Tested on the DEAD flag rather than on the word "ante", because the engine
 * writes the bomb pot's forced post as `bomb_ante` - a verb the reader does
 * not canonicalise, so a row that is unmistakably a bomb ante has the verb
 * `unknown` and only the dead flag to say what it is.
 */
function isBombPot(model: ReplayModel): boolean {
  const rows = model.streets.flatMap((s) => s.rows);
  const hasDeadPost = rows.some((r) => r.dead && r.amount > 0);
  const hasBlind = rows.some((r) => r.verb === 'sb' || r.verb === 'bb');
  return hasDeadPost && !hasBlind;
}

// ─────────────────────────────────────────────────────────────────────────────
// WIRE -> MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** A seat's stand-in identity. The wire carries no user ids, and must not. */
export const shareUserId = (seat: number): string => `share-seat-${seat}`;

export function replayFromShareable(hand: ShareableHand): ReplayModel {
  const seats = hand.players.map((p) => p.seat);
  const idOf = (seat: number) => shareUserId(seat);

  const actionsOn = (street: string, actions: ShareableAction[] | undefined) =>
    (actions || [])
      .filter((a) => seats.includes(a.seat))
      .map(
        (a): ReplayActionInput => ({
          seat: a.seat,
          userId: idOf(a.seat),
          action: MODEL_VERB[a.action] || String(a.action).toLowerCase(),
          amount: a.amount,
          stage: street,
          street,
          dead: a.dead === true,
        })
      );

  const actions: ReplayActionInput[] = [
    ...actionsOn('preflop', hand.preflop),
    ...actionsOn('pineapple_discard', hand.discard?.actions),
    ...actionsOn('flop', hand.flop?.actions),
    ...actionsOn('turn', hand.turn?.actions),
    ...actionsOn('river', hand.river?.actions),
  ];

  const board: ShareableCard[] = [
    ...(hand.flop?.cards || []),
    ...(hand.turn?.card ? [hand.turn.card] : []),
    ...(hand.river?.card ? [hand.river.card] : []),
  ];

  /* Shown cards are the table's record; the sharer's own unrevealed hand is
     kept apart, exactly as a database row keeps it apart, so it never becomes
     a showdown seat or a `show` row on the recipient's screen. */
  const holeCards: Record<string, ShareableCard[]> = {};
  const privateHoleCards: Record<string, ShareableCard[]> = {};
  for (const p of hand.players) {
    if (!p.cards?.length) continue;
    if (p.privateCards) privateHoleCards[idOf(p.seat)] = p.cards;
    else holeCards[idOf(p.seat)] = p.cards;
  }

  const winners: ReplayWinnerInput[] = (hand.winners || []).map((w) => ({
    userId: idOf(w.seat),
    amount: w.amount,
    hand: w.hand ? { name: w.hand } : null,
  }));

  /* Per-board and per-half awards, when the link carried them. Without this a
     run-it-twice hand pays one lump against board one and the second board
     shows a winner it did not have. */
  const hasBoards = (hand.winners || []).some((w) => w.board || w.low);
  const winnersByBoard = hasBoards
    ? (hand.winners || []).map((w) => ({
        board: w.board ?? 1,
        userId: idOf(w.seat),
        amount: w.amount,
        handName: w.hand,
        low: w.low === true,
      }))
    : null;

  const startStacks: Record<number, number> = {};
  for (const p of hand.players) {
    if (p.stack !== null && p.stack !== undefined) startStacks[p.seat] = p.stack;
  }

  const { smallBlind, bigBlind } = blindsFromStakes(hand.stakes);

  const showdown = hand.players
    .filter((p) => (p.cards?.length && !p.privateCards) || p.mucked)
    .map((p) => ({
      userId: idOf(p.seat),
      seat: p.seat,
      mucked: p.mucked === true,
      hand_name: p.handName ?? null,
    }));

  const input: ReplayInput = {
    handNumber: hand.handNumber ?? null,
    playedAt: hand.timestamp ? new Date(hand.timestamp).toISOString() : null,
    gameVariant: VARIANT_KEY[hand.variant] || 'nlh',
    smallBlind,
    bigBlind,
    potSize: hand.potTotal,
    rakeAmount: hand.rake ?? 0,
    bbjAmount: hand.bbjFee ?? 0,
    buttonSeat: hand.buttonSeat || null,
    board,
    extraBoards: hand.extraBoards?.length ? hand.extraBoards : null,
    players: hand.players.map((p) => ({
      userId: idOf(p.seat),
      username: p.name,
      seat: p.seat,
      /* The wire carries the STARTING stack; the settled one is not shared,
         and is not guessed. `startStacks` is what the felt counts down from. */
      stack: null,
    })),
    actions,
    winners,
    holeCards,
    privateHoleCards,
    showdown,
    winnersByBoard,
    startStacks,
    bombPot: hand.bombPot === true,
    /**
     * v4 carries the reconstruction's OWN amounts, which are incremental.
     * Every earlier payload carried the engine's raise-TO levels, which is
     * what the default reading expects - so an old link keeps replaying the
     * way it always did rather than having every raise counted twice.
     */
    amountsAreIncremental: (hand.wireVersion ?? 'v4') === 'v4',
  };

  return buildReplay(input);
}
