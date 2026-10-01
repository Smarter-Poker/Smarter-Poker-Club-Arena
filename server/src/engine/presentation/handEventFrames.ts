/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HAND EVENTS, AS CLIENT FRAMES (extracted 2026-09-27, Lightning Phase 6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The core of ServerTableEngineHandEvents.handleHandEvent: how a HandController
 * event becomes the hub frame every client animates from - the deal, each
 * action, each street, the showdown, the pots and the winners. PURE builders:
 * each takes the facts the dealer captured and returns the frame, and the
 * dealer decides when to emit it (the pacing sleeps, the settle holds and the
 * hand-number fences stay with the dealer, where they were).
 *
 * WHY IT MOVED. A Lightning hand is dealt by LightningHandHost, not by a table
 * engine, and the Animation Law (CLAUDE.md 10.6) requires that its client
 * events be IDENTICAL to a physical table's. One set of builders, used by both
 * dealers, is how that stays true. Field names, order and defaults are the
 * engine's; `handEventFrames.equivalence.test.ts` pins them against a frozen
 * copy of the inline literals they replaced.
 *
 * NO FRAME HERE CARRIES A HOLE CARD before the hand is over. The deal is not a
 * hub frame at all (hole cards go to their owner alone, as `hole_cards`); the
 * showdown frames carry only hands that were tabled and not mucked.
 */
import type { Card, HandStage } from '../../types.js';

type AnyCard = Card | string | { rank?: string; suit?: string };

/** `hand_started`: the dealer button for the hand that is about to deal. */
export function handStartedFrame(a: {
  tableId: string;
  handNumber: number;
  dealerSeat: number;
  timestamp: number;
}): Record<string, unknown> {
  return {
    type: 'hand_started',
    table_id: a.tableId,
    hand_number: a.handNumber,
    dealer_seat: a.dealerSeat,
    timestamp: a.timestamp,
  };
}

/** `blinds_posted`: the SB and BB, or null when nothing was posted. */
export function blindsPostedFrame(a: {
  tableId: string;
  handNumber: number;
  postings: Array<{ seat: number; type: string; amount: number }> | undefined;
  timestamp: number;
}): Record<string, unknown> | null {
  const postings = a.postings;
  if (!postings || postings.length === 0) return null;
  return {
    type: 'blinds_posted',
    table_id: a.tableId,
    hand_number: a.handNumber,
    postings,
    timestamp: a.timestamp,
  };
}

/**
 * `antes_posted`: every seat that posted a regular ante, and how much, so the
 * felt can fly it to the middle (Dan 2026-09-04). Null when there was none.
 */
export function antesPostedFrame(a: {
  tableId: string;
  handNumber: number;
  postings: ReadonlyArray<{ seat: number; kind: string; amount: number } | null | undefined>;
  timestamp: number;
}): Record<string, unknown> | null {
  const antePostings = a.postings
    .filter((p) => p && p.kind === 'ante' && p.amount > 0)
    .map((p) => ({ seat: p!.seat, amount: p!.amount }));
  if (antePostings.length === 0) return null;
  return {
    type: 'antes_posted',
    table_id: a.tableId,
    hand_number: a.handNumber,
    postings: antePostings,
    timestamp: a.timestamp,
  };
}

/** `turn_change`: whose decision it is and the server's deadline for it. */
export function turnChangeFrame(a: {
  actionContext: string | null;
  tableId: string;
  handNumber: number;
  seat: number;
  userId: string;
  deadlineMs: number;
  timestamp: number;
}): Record<string, unknown> {
  return {
    type: 'turn_change',
    action_context: a.actionContext,
    table_id: a.tableId,
    hand_number: a.handNumber,
    seat: a.seat,
    user_id: a.userId,
    deadline_ms: a.deadlineMs,
    timestamp: a.timestamp,
  };
}

/** `player_action`: a seat, a verb and an amount. Never a card. */
export function playerActionFrame(a: {
  tableId: string;
  handNumber: number;
  seat: number;
  userId: string;
  action: string;
  amount: number | undefined;
  stage: HandStage | string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    type: 'player_action',
    table_id: a.tableId,
    hand_number: a.handNumber,
    seat: a.seat,
    user_id: a.userId,
    action: a.action,
    amount: a.amount ?? 0,
    stage: a.stage,
    timestamp: a.timestamp,
  };
}

/** A board card as the history records it: "Ah". */
export function boardCardString(c: AnyCard): string {
  return typeof c === 'string' ? c : `${(c as Card).rank}${(c as Card).suit}`;
}

/** The running board after a street: the flop replaces it, later streets append. */
export function accumulateBoard(
  previous: readonly string[],
  stage: HandStage | string | undefined,
  cards: readonly AnyCard[]
): string[] {
  const newCards = cards.map((c) => boardCardString(c));
  return stage === 'flop' ? newCards : [...previous, ...newCards];
}

/** `community_cards_dealt`: the new cards and the whole board, per board. */
export function communityCardsDealtFrame(a: {
  tableId: string;
  handNumber: number;
  stage: HandStage | string | undefined;
  newCards: readonly AnyCard[];
  board: readonly string[];
  newCards2: readonly AnyCard[];
  board2: readonly string[];
  newCards3: readonly AnyCard[];
  board3: readonly string[];
  timestamp: number;
}): Record<string, unknown> {
  return {
    type: 'community_cards_dealt',
    table_id: a.tableId,
    hand_number: a.handNumber,
    stage: a.stage,
    new_cards: a.newCards,
    board: a.board,
    new_cards2: a.newCards2,
    board2: a.board2,
    new_cards3: a.newCards3,
    board3: a.board3,
    timestamp: a.timestamp,
  };
}

/** One showdown result as the dealer keeps it for the rest of the hand. */
export interface ShowdownRecord {
  userId: string;
  handRanking: number;
  handName: string;
  kickers: number[];
  holeCards: Array<{ rank: string; suit: string }>;
  seat?: number;
  revealOrder?: number;
  mucked?: boolean;
  handDescription?: string;
}

/** HandController's SHOWDOWN results, normalized the way the engine stores them. */
export function normalizeShowdownResults(results: unknown): ShowdownRecord[] {
  return ((results as any[]) || []).map((r: any) => ({
    userId: r.userId,
    handRanking: r.hand?.ranking ?? 0,
    handName: r.hand?.name ?? '',
    kickers: r.hand?.kickers ?? [],
    holeCards: (r.cards || []).map((c: any) =>
      typeof c === 'string'
        ? { rank: c.slice(0, -1), suit: c.slice(-1) }
        : { rank: c.rank, suit: c.suit }
    ),
    seat: r.seat,
    revealOrder: r.revealOrder,
    mucked: r.mucked === true,
    handDescription: r.handDescription ?? '',
  }));
}

/**
 * `showdown`: the reveal SEQUENCE and the muck ruling (SHOWDOWN SYSTEM
 * 2026-08-25). A mucked hand's identity stays private.
 */
export function showdownFrame(a: {
  tableId: string;
  handNumber: number;
  results: readonly ShowdownRecord[];
  isMuckedAtShowdown: (userId: string) => boolean;
}): Record<string, unknown> {
  const isMuckedAtShowdown = a.isMuckedAtShowdown;
  return {
    type: 'showdown',
    table_id: a.tableId,
    hand_number: a.handNumber,
    results: a.results.map((r) => {
      const mucked = isMuckedAtShowdown(r.userId);
      return {
        user_id: r.userId,
        seat: r.seat ?? -1,
        reveal_order: r.revealOrder ?? 0,
        mucked,
        hand_name: mucked ? '' : r.handName,
        hand_ranking: mucked ? 0 : r.handRanking,
        hand_description: mucked ? '' : (r.handDescription ?? ''),
      };
    }),
  };
}

/**
 * `showdown_cards_revealed`: the tabled hands and who mucked. A hand the
 * engine ruled muckable is never in `reveals`. Null when there is nothing.
 */
export function showdownCardsRevealedFrame(a: {
  tableId: string;
  handNumber: number;
  results: readonly ShowdownRecord[];
  isMuckedAtShowdown: (userId: string) => boolean;
  timestamp: number;
}): Record<string, unknown> | null {
  const isMuckedAtShowdown = a.isMuckedAtShowdown;
  const reveals = a.results
    .filter((r) => !isMuckedAtShowdown(r.userId))
    .map((r) => ({
      user_id: r.userId,
      seat: r.seat ?? -1,
      cards: r.holeCards ?? [],
      best_hand_label: r.handName,
      best_hand_rank: r.handRanking,
      best_hand_description: r.handDescription ?? '',
      reveal_order: r.revealOrder ?? 0,
    }));
  const muckedPlayers = a.results
    .filter((r) => isMuckedAtShowdown(r.userId))
    .map((r) => ({ user_id: r.userId, seat: r.seat ?? -1 }));
  if (reveals.length === 0 && muckedPlayers.length === 0) return null;
  return {
    type: 'showdown_cards_revealed',
    table_id: a.tableId,
    hand_number: a.handNumber,
    reveals,
    mucked_players: muckedPlayers,
    timestamp: a.timestamp,
  };
}

/** One winner as the dealer keeps it. */
export interface WinnerRecord {
  userId: string;
  amount: number;
  potIndex?: number;
  hand?: { name: string; ranking: number; cards?: Array<{ rank?: string; suit?: string }> };
}

/** HandController's WINNERS, normalized the way the engine stores them. */
export function normalizeWinners(winners: unknown): WinnerRecord[] {
  return ((winners as any[]) || []).map((w: any) => ({
    userId: w.userId || w.user_id || '',
    amount: w.amount || 0,
    potIndex: w.potIndex ?? 0,
    hand: w.hand
      ? {
          name: w.hand.name || '',
          ranking: w.hand.ranking ?? 0,
          cards: Array.isArray(w.hand.cards) ? w.hand.cards : undefined,
        }
      : undefined,
  }));
}

/**
 * The indices of the BOARD cards the winners' evaluated hands used (w.hand?.cards
 * matched against capturedBoard), so the felt can light them. Board cards only;
 * a failure here yields no highlight and never breaks the payout event.
 */
export function winningBoardIndices(
  capturedWinners: readonly WinnerRecord[],
  capturedBoard: ReadonlyArray<{ rank?: string; suit?: string }>
): number[] {
  const cardKey = (c: { rank?: string; suit?: string }) => `${c?.rank}${c?.suit}`;
  try {
    const used = new Set<string>();
    for (const w of capturedWinners) {
      for (const c of (w.hand?.cards ?? []) as Array<{ rank?: string; suit?: string }>) {
        used.add(cardKey(c));
      }
    }
    if (used.size === 0) return [];
    const out: number[] = [];
    capturedBoard.forEach((c, i) => {
      if (used.has(cardKey(c))) out.push(i);
    });
    return out;
  } catch {
    return [];
  }
}

/** `pot_win`: the winners, their hands, the lit cards and the award groups. */
export function potWinFrame(a: {
  tableId: string;
  emitHandNumber: number;
  capturedWinnerIds: readonly string[];
  capturedPotSize: number;
  capturedBoard: ReadonlyArray<{ rank?: string; suit?: string }>;
  capturedWinners: readonly WinnerRecord[];
  capturedShowdownResults: readonly ShowdownRecord[];
  capturedWinnersByBoard: ReadonlyArray<{
    board: number;
    userId: string;
    amount: number;
    handName?: string;
  }>;
  capturedPotAwards: unknown;
}): Record<string, unknown> {
  const capturedWinners = a.capturedWinners;
  const capturedShowdownResults = a.capturedShowdownResults;
  return {
    type: 'pot_win',
    table_id: a.tableId,
    hand_number: a.emitHandNumber,
    winner_ids: a.capturedWinnerIds,
    pot: a.capturedPotSize,
    card_indices: winningBoardIndices(capturedWinners, a.capturedBoard),
    winners: capturedWinners.map((w) => {
      const sd = capturedShowdownResults.find((r) => r.userId === w.userId);
      const holeIndices: number[] = [];
      try {
        if (sd && w.hand?.cards) {
          const usedKeys = new Set(
            (w.hand.cards as Array<{ rank?: string; suit?: string }>).map(
              (c) => `${c?.rank}${c?.suit}`
            )
          );
          (sd.holeCards ?? []).forEach((c, i) => {
            if (usedKeys.has(`${c?.rank}${c?.suit}`)) holeIndices.push(i);
          });
        }
      } catch {
        /* a highlight failure never breaks the payout event */
      }
      return {
        user_id: w.userId,
        amount: w.amount,
        hand_name: w.hand?.name,
        hand_description: sd?.handDescription ?? '',
        hole_card_indices: holeIndices,
        pot_index: w.potIndex ?? 0,
      };
    }),
    winners_by_board: a.capturedWinnersByBoard.map((w) => ({
      board: w.board,
      user_id: w.userId,
      amount: w.amount,
      hand_name: w.handName,
    })),
    pot_awards: a.capturedPotAwards,
  };
}

/** `pot_distributed`: each pot, who took it and each winner's share. */
export function potDistributedFrame(a: {
  tableId: string;
  emitHandNumber: number;
  capturedPotSize: number;
  capturedPots: ReadonlyArray<{ amount: number; eligiblePlayers?: string[]; eligible?: string[] }>;
  capturedWinners: readonly WinnerRecord[];
  timestamp: number;
}): Record<string, unknown> {
  const capturedWinners = a.capturedWinners;
  const potBreakdown = a.capturedPots.map((p, idx) => {
    const eligibleIds = p.eligiblePlayers ?? p.eligible ?? [];
    const eligibleWinners = capturedWinners.filter(
      (w) => eligibleIds.length === 0 || eligibleIds.includes(w.userId)
    );
    const totalEligibleAmount = eligibleWinners.reduce((s, w) => s + w.amount, 0) || 1;
    return {
      pot_index: idx,
      amount: p.amount,
      winner_user_ids: eligibleWinners.map((w) => w.userId),
      per_winner_share: eligibleWinners.map((w) => ({
        user_id: w.userId,
        share: (w.amount / totalEligibleAmount) * p.amount,
      })),
    };
  });
  return {
    type: 'pot_distributed',
    table_id: a.tableId,
    hand_number: a.emitHandNumber,
    total_pot: a.capturedPotSize,
    pots: potBreakdown,
    timestamp: a.timestamp,
  };
}
