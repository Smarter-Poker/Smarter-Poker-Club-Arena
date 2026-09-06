/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SHARED HAND IS THE SAME HAND — the round trip, against real hands
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 4 of the Previous Hand plan made a share link carry the sharer's own
 * reconstruction and rebuild it at the other end. The claim is not "it
 * renders" - it is that NOTHING CHANGES on the way. This file is how that
 * claim is checked, and it is written as a DIFFER rather than a list of
 * assertions: build the model, put it on the wire, rebuild it, and compare
 * every figure a player can read.
 *
 * That distinction found four defects the hand-written tests did not, three of
 * them money:
 *
 *   1. A shared FOLD-AROUND grew a Showdown section. `players[].mucked` in the
 *      model means "no hole cards on record", which on a fold-around is
 *      everyone; sending it as a muck told the recipient every folder was at a
 *      showdown that never happened.
 *   2. The winner of a raked RUN-IT-TWICE hand was credited with the rake as
 *      well. `winners[].amount` is what was PAID (post-rake) and
 *      `winners_by_board[].amount` is the pre-rake share of each board - two
 *      different numbers, and the wire carried one field for both. Production
 *      #6421788: paid 49.74, per-board 26.12 + 26.12 = 52.24.
 *   3. The RETURNED UNCALLED BET moved street. This engine writes it with
 *      stage `showdown`, the wire had no slot for that street, so it never
 *      travelled - the recipient's reconstruction inferred one of its own and
 *      hung it on the river, and the river's pot line read 15.52 where the
 *      hand had 23.22 in the middle (production #5087420).
 *   4. Table names were cut at 40 characters, which removed the TABLE NUMBER
 *      from every tournament table ("... Bounty Hunter - 5 PM CT - Table 10").
 *      1,484 live tables are over that cut.
 *
 * The corpus is 38 real hands pulled from `hand_history` (2026-09-05) and
 * anonymised - every user id and username replaced, nothing else touched. It
 * covers NLH, PLO4/5/6, PLO8, FLO8, short deck, pineapple and limit hold'em;
 * run-it-twice, bomb pots, per-board and per-half awards, antes, straddles,
 * discards, side pots, returned bets, rake and jackpot drops.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReplay, replayInputFromRow, type ReplayModel } from '../../src/utils/handReplay';
import { shareableFromModel, replayFromShareable } from '../../src/lib/shareHandModel';
import { decodeHandFromUrl, encodeHand } from '../../src/components/table/ShareHand';

const rows = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures-realhands.json'), 'utf8')
) as Array<Record<string, unknown>>;

/**
 * THE ONE THING THE WIRE NARROWS, on purpose and in one place.
 *
 * The engine's `bomb_ante` is a verb the reconstruction does not
 * canonicalise, so it reaches the model as `unknown` carrying the engine's own
 * word for its label. The wire has no free-text verb - deliberately - so a
 * dead post that it cannot name travels as an ANTE, which is what a bomb ante
 * is. Every figure attached to it (the amount, the dead flag, the pot) is
 * exact; only the row's word narrows from "Bomb Ante" to "Ante".
 *
 * Normalised here rather than ignored, so that if anything ELSE ever starts
 * narrowing, this file says so.
 */
const sameVerb = (v: string) => (v === 'unknown' ? 'ante' : v);

/** Every figure a player can read off the model, as a comparable shape. */
function shape(m: ReplayModel) {
  return {
    hiLo: m.hiLo,
    perBoardAwards: m.perBoardAwards,
    sb: m.smallBlind,
    bb: m.bigBlind,
    button: m.buttonSeat,
    potTotal: m.potTotal,
    rake: m.rake,
    bbj: m.bbjFee,
    reconciles: m.reconciles,
    rebuiltPot: m.rebuiltPot,
    boards: m.boards.map((b) => b.map((c) => `${c.rank}${c.suit}`).join(' ')),
    streets: m.streets.map((s) => ({
      key: s.key,
      board: s.board.map((c) => `${c.rank}${c.suit}`).join(' '),
      extra: s.extraBoards.map((b) => b.map((c) => `${c.rank}${c.suit}`).join(' ')),
      potAfter: s.potAfter,
      rows: s.rows.map((r) => `${r.seat}:${sameVerb(r.verb)}:${r.amount}:${r.dead ? 'D' : ''}`),
    })),
    players: m.players.map((p) => ({
      seat: p.seat,
      startStack: p.startStack,
      invested: p.invested,
      won: p.won,
      net: p.net,
      hole: (p.hole || []).map((c) => `${c.rank}${c.suit}`).join(' '),
      mucked: p.mucked,
      position: p.position,
    })),
    winners: m.showdown
      .filter((r) => r.isWinner)
      .map((r) => `${r.seat}:b${r.boardIndex}:${r.low ? 'lo' : 'hi'}:${r.net}`)
      .sort(),
  };
}

function roundTrip(model: ReplayModel, heroId: string | null) {
  const shared = shareableFromModel(model, { id: 'h', tableName: 'T', heroUserId: heroId });
  const decoded = decodeHandFromUrl(encodeHand(shared));
  if (!decoded) throw new Error('the payload did not decode');
  return { shared, decoded, rebuilt: replayFromShareable(decoded) };
}

describe('every real production hand survives the share link unchanged', () => {
  for (const row of rows) {
    const n = String(row.hand_number);
    it(`#${n} (${row.game_variant})`, () => {
      const sharer = buildReplay(replayInputFromRow(row as never));
      const heroId = sharer.players[0]?.userId ?? null;
      const { rebuilt } = roundTrip(sharer, heroId);
      expect(shape(rebuilt)).toEqual(shape(sharer));
    });
  }

  it('covers the shapes it claims to', () => {
    const variants = new Set(rows.map((r) => String(r.game_variant)));
    expect(variants.size).toBeGreaterThanOrEqual(6);
    expect(rows.some((r) => Array.isArray(r.rit_boards) && r.rit_boards.length)).toBe(true);
    expect(rows.some((r) => r.bomb_pot)).toBe(true);
    expect(rows.some((r) => Array.isArray(r.winners_by_board) && r.winners_by_board.length)).toBe(
      true
    );
    expect(rows.some((r) => Number(r.rake_amount) > 0)).toBe(true);
  });
});

describe('the three money facts the differ caught', () => {
  const withRake = rows.find(
    (r) =>
      Number(r.rake_amount) > 0 && Array.isArray(r.winners_by_board) && r.winners_by_board.length
  );

  it('pays the winner what the pot paid, not the pre-rake board shares', () => {
    expect(withRake, 'a raked per-board hand is in the corpus').toBeTruthy();
    const sharer = buildReplay(replayInputFromRow(withRake as never));
    const { shared, rebuilt } = roundTrip(sharer, null);
    const paid = sharer.players.reduce((t, p) => t + p.won, 0);
    const boardShares = (shared.winners || []).reduce((t, w) => t + w.amount, 0);
    /* The two really are different on this hand - that is the whole point. */
    expect(boardShares).toBeGreaterThan(paid);
    expect(shared.players.reduce((t, p) => t + (p.won ?? 0), 0)).toBeCloseTo(paid, 2);
    expect(rebuilt.players.reduce((t, p) => t + p.won, 0)).toBeCloseTo(paid, 2);
  });

  it('keeps a returned uncalled bet on the street it happened', () => {
    const withReturn = rows.find((r) =>
      (r.actions as Array<{ action?: string; stage?: string }> | undefined)?.some(
        (a) => String(a.action).toLowerCase() === 'return' && a.stage === 'showdown'
      )
    );
    expect(withReturn, 'a showdown-street return is in the corpus').toBeTruthy();
    const sharer = buildReplay(replayInputFromRow(withReturn as never));
    const { rebuilt } = roundTrip(sharer, null);
    const streetOf = (m: ReplayModel) =>
      m.streets.find((s) => s.rows.some((r) => r.verb === 'return'))?.key;
    expect(streetOf(rebuilt)).toBe(streetOf(sharer));
    expect(streetOf(sharer)).toBe('showdown');
  });

  it('never puts a folder in a showdown that did not happen', () => {
    const foldAround = rows.find(
      (r) => !Array.isArray(r.showdown) || (r.showdown as unknown[]).length === 0
    );
    expect(foldAround, 'a hand with no showdown is in the corpus').toBeTruthy();
    const sharer = buildReplay(replayInputFromRow(foldAround as never));
    const { shared, rebuilt } = roundTrip(sharer, null);
    expect(shared.players.every((p) => !p.mucked)).toBe(true);
    expect(rebuilt.showdown.length).toBe(sharer.showdown.length);
  });
});
