/**
 * THE FRAMES ARE THE ENGINE'S FRAMES (Lightning Phase 6, 2026-09-27).
 *
 * Each builder in handEventFrames.ts replaced an object literal inside
 * ServerTableEngineHandEvents.handleHandEvent. The literals are kept here,
 * FROZEN as they stood before the move, and every builder is compared with its
 * literal over randomized inputs: same keys, same order, same values. The
 * Animation Law (CLAUDE.md 10.6) requires a Lightning client's events to be
 * identical to a physical table's, and both dealers now emit through these.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../HandFuzzer.js';
import {
  accumulateBoard,
  antesPostedFrame,
  blindsPostedFrame,
  communityCardsDealtFrame,
  handStartedFrame,
  normalizeShowdownResults,
  normalizeWinners,
  playerActionFrame,
  potDistributedFrame,
  potWinFrame,
  showdownCardsRevealedFrame,
  showdownFrame,
  turnChangeFrame,
} from './handEventFrames.js';

const same = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['h', 'd', 'c', 's'];
const card = (rnd: () => number) => ({
  rank: RANKS[Math.floor(rnd() * 13)],
  suit: SUITS[Math.floor(rnd() * 4)],
});

describe('every hand-event frame matches the frozen engine literal', () => {
  const rnd = mulberry32(99);

  it('hand_started, blinds_posted, antes_posted, turn_change, player_action', () => {
    for (let i = 0; i < 300; i++) {
      const tableId = `t${i}`;
      const hn = Math.floor(rnd() * 1e6);
      const now = 1_700_000_000_000 + i;
      same(handStartedFrame({ tableId, handNumber: hn, dealerSeat: i % 9, timestamp: now }), {
        type: 'hand_started',
        table_id: tableId,
        hand_number: hn,
        dealer_seat: i % 9,
        timestamp: now,
      });
      const blinds =
        rnd() < 0.2
          ? undefined
          : Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => ({
              seat: k + 1,
              type: k ? 'bb' : 'sb',
              amount: k + 1,
            }));
      same(
        blindsPostedFrame({ tableId, handNumber: hn, postings: blinds, timestamp: now }),
        blinds && blinds.length > 0
          ? {
              type: 'blinds_posted',
              table_id: tableId,
              hand_number: hn,
              postings: blinds,
              timestamp: now,
            }
          : null
      );
      const forced = Array.from({ length: Math.floor(rnd() * 5) }, (_, k) => ({
        seat: k + 1,
        userId: `u${k}`,
        kind: rnd() < 0.5 ? 'ante' : 'bb',
        amount: rnd() < 0.2 ? 0 : 1 + k,
        dead: false,
      }));
      const antePostings = forced
        .filter((p) => p && p.kind === 'ante' && p.amount > 0)
        .map((p) => ({ seat: p.seat, amount: p.amount }));
      same(
        antesPostedFrame({ tableId, handNumber: hn, postings: forced, timestamp: now }),
        antePostings.length > 0
          ? {
              type: 'antes_posted',
              table_id: tableId,
              hand_number: hn,
              postings: antePostings,
              timestamp: now,
            }
          : null
      );
      same(
        turnChangeFrame({
          actionContext: 'ctx',
          tableId,
          handNumber: hn,
          seat: 3,
          userId: 'u3',
          deadlineMs: now + 15000,
          timestamp: now,
        }),
        {
          type: 'turn_change',
          action_context: 'ctx',
          table_id: tableId,
          hand_number: hn,
          seat: 3,
          user_id: 'u3',
          deadline_ms: now + 15000,
          timestamp: now,
        }
      );
      const amount = rnd() < 0.3 ? undefined : Math.floor(rnd() * 100);
      same(
        playerActionFrame({
          tableId,
          handNumber: hn,
          seat: 2,
          userId: 'u2',
          action: 'raise',
          amount,
          stage: 'flop',
          timestamp: now,
        }),
        {
          type: 'player_action',
          table_id: tableId,
          hand_number: hn,
          seat: 2,
          user_id: 'u2',
          action: 'raise',
          amount: amount ?? 0,
          stage: 'flop',
          timestamp: now,
        }
      );
    }
  });

  it('community_cards_dealt and the running board', () => {
    for (let i = 0; i < 200; i++) {
      const prev = Array.from(
        { length: Math.floor(rnd() * 4) },
        () => `${card(rnd).rank}${card(rnd).suit}`
      );
      const stage = ['flop', 'turn', 'river'][Math.floor(rnd() * 3)];
      const cards: any[] = Array.from({ length: stage === 'flop' ? 3 : 1 }, () =>
        rnd() < 0.2 ? 'Ah' : card(rnd)
      );
      const newCards = cards.map((c: any) => (typeof c === 'string' ? c : `${c.rank}${c.suit}`));
      const legacy = stage === 'flop' ? newCards : [...prev, ...newCards];
      same(accumulateBoard(prev, stage, cards), legacy);
      same(
        communityCardsDealtFrame({
          tableId: 't',
          handNumber: 5,
          stage,
          newCards: cards,
          board: legacy,
          newCards2: [],
          board2: [],
          newCards3: [],
          board3: [],
          timestamp: 9,
        }),
        {
          type: 'community_cards_dealt',
          table_id: 't',
          hand_number: 5,
          stage,
          new_cards: cards,
          board: legacy,
          new_cards2: [],
          board2: [],
          new_cards3: [],
          board3: [],
          timestamp: 9,
        }
      );
    }
  });

  it('showdown, showdown_cards_revealed, pot_win and pot_distributed', () => {
    for (let i = 0; i < 200; i++) {
      const n = 2 + Math.floor(rnd() * 5);
      const raw = Array.from({ length: n }, (_, k) => ({
        userId: `u${k}`,
        seat: rnd() < 0.1 ? undefined : k + 1,
        revealOrder: rnd() < 0.1 ? undefined : k,
        mucked: rnd() < 0.3,
        handDescription: rnd() < 0.2 ? undefined : `desc ${k}`,
        cards: [card(rnd), rnd() < 0.5 ? 'Kd' : card(rnd)],
        hand: rnd() < 0.1 ? undefined : { ranking: k, name: `name ${k}`, kickers: [k] },
      }));
      const results = normalizeShowdownResults(raw);
      const legacyResults = raw.map((r: any) => ({
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
      same(results, legacyResults);
      const muckSet = new Set(raw.filter((r) => r.mucked && rnd() < 0.8).map((r) => r.userId));
      const isMucked = (u: string) => muckSet.has(u);
      same(showdownFrame({ tableId: 't', handNumber: 1, results, isMuckedAtShowdown: isMucked }), {
        type: 'showdown',
        table_id: 't',
        hand_number: 1,
        results: legacyResults.map((r) => {
          const mucked = isMucked(r.userId);
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
      });
      const reveals = legacyResults
        .filter((r) => !isMucked(r.userId))
        .map((r) => ({
          user_id: r.userId,
          seat: r.seat ?? -1,
          cards: r.holeCards ?? [],
          best_hand_label: r.handName,
          best_hand_rank: r.handRanking,
          best_hand_description: r.handDescription ?? '',
          reveal_order: r.revealOrder ?? 0,
        }));
      const muckedPlayers = legacyResults
        .filter((r) => isMucked(r.userId))
        .map((r) => ({ user_id: r.userId, seat: r.seat ?? -1 }));
      same(
        showdownCardsRevealedFrame({
          tableId: 't',
          handNumber: 1,
          results,
          isMuckedAtShowdown: isMucked,
          timestamp: 4,
        }),
        reveals.length > 0 || muckedPlayers.length > 0
          ? {
              type: 'showdown_cards_revealed',
              table_id: 't',
              hand_number: 1,
              reveals,
              mucked_players: muckedPlayers,
              timestamp: 4,
            }
          : null
      );
      const rawWinners = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => ({
        userId: rnd() < 0.2 ? undefined : `u${k}`,
        user_id: `u${k}`,
        amount: rnd() < 0.1 ? 0 : 10 + k,
        potIndex: rnd() < 0.3 ? undefined : k,
        hand:
          rnd() < 0.2
            ? undefined
            : {
                name: `n${k}`,
                ranking: k,
                cards:
                  rnd() < 0.2 ? 'nope' : [card(rnd), card(rnd), card(rnd), card(rnd), card(rnd)],
              },
      }));
      const winners = normalizeWinners(rawWinners);
      const legacyWinners = rawWinners.map((w: any) => ({
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
      same(winners, legacyWinners);
      const board = Array.from({ length: 5 }, () => card(rnd));
      const cardKey = (c: { rank?: string; suit?: string }) => `${c?.rank}${c?.suit}`;
      const legacyIndices = (() => {
        const used = new Set<string>();
        for (const w of legacyWinners)
          for (const c of (w.hand?.cards ?? []) as any[]) used.add(cardKey(c));
        if (used.size === 0) return [];
        const out: number[] = [];
        board.forEach((c, idx) => {
          if (used.has(cardKey(c))) out.push(idx);
        });
        return out;
      })();
      const byBoard = rnd() < 0.5 ? [] : [{ board: 1, userId: 'u0', amount: 5, handName: 'x' }];
      const awards = [{ pot_index: 0 }];
      same(
        potWinFrame({
          tableId: 't',
          emitHandNumber: 3,
          capturedWinnerIds: legacyWinners.map((w) => w.userId),
          capturedPotSize: 40,
          capturedBoard: board,
          capturedWinners: winners,
          capturedShowdownResults: results,
          capturedWinnersByBoard: byBoard,
          capturedPotAwards: awards,
        }),
        {
          type: 'pot_win',
          table_id: 't',
          hand_number: 3,
          winner_ids: legacyWinners.map((w) => w.userId),
          pot: 40,
          card_indices: legacyIndices,
          winners: legacyWinners.map((w) => {
            const sd = legacyResults.find((r) => r.userId === w.userId);
            const holeIndices: number[] = [];
            if (sd && w.hand?.cards) {
              const usedKeys = new Set((w.hand.cards as any[]).map((c) => `${c?.rank}${c?.suit}`));
              (sd.holeCards ?? []).forEach((c: any, idx: number) => {
                if (usedKeys.has(`${c?.rank}${c?.suit}`)) holeIndices.push(idx);
              });
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
          winners_by_board: byBoard.map((w) => ({
            board: w.board,
            user_id: w.userId,
            amount: w.amount,
            hand_name: w.handName,
          })),
          pot_awards: awards,
        }
      );
      const pots = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) =>
        rnd() < 0.5
          ? {
              amount: 10 * (k + 1),
              eligiblePlayers: legacyWinners.slice(0, k + 1).map((w) => w.userId),
            }
          : { amount: 10 * (k + 1), eligible: rnd() < 0.5 ? [] : ['u0'] }
      );
      same(
        potDistributedFrame({
          tableId: 't',
          emitHandNumber: 3,
          capturedPotSize: 40,
          capturedPots: pots,
          capturedWinners: winners,
          timestamp: 8,
        }),
        {
          type: 'pot_distributed',
          table_id: 't',
          hand_number: 3,
          total_pot: 40,
          pots: pots.map((p: any, idx) => {
            const eligibleIds = p.eligiblePlayers ?? p.eligible ?? [];
            const eligibleWinners = legacyWinners.filter(
              (w) => eligibleIds.length === 0 || eligibleIds.includes(w.userId)
            );
            const total = eligibleWinners.reduce((s, w) => s + w.amount, 0) || 1;
            return {
              pot_index: idx,
              amount: p.amount,
              winner_user_ids: eligibleWinners.map((w) => w.userId),
              per_winner_share: eligibleWinners.map((w) => ({
                user_id: w.userId,
                share: (w.amount / total) * p.amount,
              })),
            };
          }),
          timestamp: 8,
        }
      );
    }
  });
});
