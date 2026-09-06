/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PREVIOUS HAND, PHASE 4 OF 7 — one replayer everywhere, and share link v4
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Plan: docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md.
 *
 * The claim this file has to hold up is a round trip: a hand the sharer is
 * looking at, encoded into a link, decoded by somebody who has never seen it,
 * and rebuilt into THE SAME MODEL by the same builder. Every assertion below
 * is either a thing that used to be lost on the way (the second board, the low
 * half, the rake, the dead ante, the hand number, the discard) or a thing that
 * must never be gained on the way (a reveal that did not happen, a stack
 * nobody knew, a verb the wire cannot carry renamed into one it can).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReplay, type ReplayInput } from '../../src/utils/handReplay';
import {
  replayFromShareable,
  shareableFromModel,
  shareUserId,
  blindsFromStakes,
  toShareVariant,
} from '../../src/lib/shareHandModel';
import { encodeHand, decodeHandFromUrl } from '../../src/components/table/ShareHand';

const readSrc = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');

const HERO = 'hero-1';
const VILLAIN = 'villain-1';

/** A hi-lo, run-it-twice hand with an ante, a rake and a jackpot drop. */
function ritHiLoInput(over: Partial<ReplayInput> = {}): ReplayInput {
  return {
    handNumber: 6704153,
    playedAt: '2026-09-05T12:00:00.000Z',
    gameVariant: 'plo8',
    smallBlind: 0.02,
    bigBlind: 0.05,
    potSize: 4.1,
    rakeAmount: 0.2,
    bbjAmount: 0.05,
    buttonSeat: 1,
    board: [
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 's' },
      { rank: '7', suit: 'c' },
      { rank: '2', suit: 'd' },
      { rank: '3', suit: 'h' },
    ],
    extraBoards: [
      [
        { rank: 'Q', suit: 'c' },
        { rank: 'J', suit: 'd' },
        { rank: '4', suit: 's' },
        { rank: '5', suit: 'h' },
        { rank: '6', suit: 'c' },
      ],
    ],
    players: [
      { seat: 1, userId: HERO, username: 'Hero', stack: 12.05 },
      { seat: 2, userId: VILLAIN, username: 'Villain', stack: 7.9 },
    ],
    actions: [
      { seat: 1, userId: HERO, action: 'ante', amount: 0.05, stage: 'preflop', dead: true },
      { seat: 2, userId: VILLAIN, action: 'ante', amount: 0.05, stage: 'preflop', dead: true },
      { seat: 1, userId: HERO, action: 'sb', amount: 0.02, stage: 'preflop' },
      { seat: 2, userId: VILLAIN, action: 'bb', amount: 0.05, stage: 'preflop' },
      { seat: 1, userId: HERO, action: 'raise', amount: 2, stage: 'preflop' },
      { seat: 2, userId: VILLAIN, action: 'call', amount: 2, stage: 'preflop' },
    ],
    winners: [
      { userId: HERO, amount: 2.05 },
      { userId: VILLAIN, amount: 2.05 },
    ],
    winnersByBoard: [
      { board: 1, userId: HERO, amount: 1.0, handName: 'Flush, Ace High' },
      { board: 1, userId: VILLAIN, amount: 1.05, handName: 'Seven Six Low', low: true },
      { board: 2, userId: HERO, amount: 1.05, handName: 'Straight, Six High' },
      { board: 2, userId: VILLAIN, amount: 1.0, handName: 'Six Five Low', low: true },
    ],
    holeCards: {
      [HERO]: [
        { rank: 'A', suit: 'c' },
        { rank: '2', suit: 'c' },
        { rank: 'T', suit: 'h' },
        { rank: '9', suit: 'h' },
      ],
      [VILLAIN]: [
        { rank: '3', suit: 'c' },
        { rank: '4', suit: 'c' },
        { rank: '7', suit: 'h' },
        { rank: '8', suit: 'h' },
      ],
    },
    ...over,
  } as ReplayInput;
}

/** The link's whole journey: model -> payload -> URL -> payload -> model. */
function roundTrip(input: ReplayInput, heroUserId: string | null = HERO) {
  const model = buildReplay(input);
  const shared = shareableFromModel(model, { id: 'h1', tableName: 'Table 7', heroUserId });
  const decoded = decodeHandFromUrl(encodeHand(shared));
  if (!decoded) throw new Error('payload did not decode');
  return { model, shared, decoded, rebuilt: replayFromShareable(decoded) };
}

describe('share link v4 carries what the reconstruction knows', () => {
  it('decodes as v4 and reads its money in cents', () => {
    const { decoded } = roundTrip(ritHiLoInput());
    expect(decoded.wireVersion).toBe('v4');
    /* 0.02/0.05 blinds: v1/v2 rounded every figure to whole chips, which is
       how a recipient saw a pot of 0. */
    expect(decoded.potTotal).toBeCloseTo(4.1, 2);
  });

  it('carries the second board of a run-it-twice hand', () => {
    const { decoded, rebuilt } = roundTrip(ritHiLoInput());
    expect(decoded.extraBoards?.length).toBe(1);
    expect(decoded.extraBoards?.[0]).toHaveLength(5);
    // And the rebuilt model deals it as a real second board, not as text.
    const last = rebuilt.streets[rebuilt.streets.length - 1];
    expect(last.extraBoards.length).toBe(1);
    expect(last.extraBoards[0].map((c) => `${c.rank}${c.suit}`)).toEqual([
      'Qc',
      'Jd',
      '4s',
      '5h',
      '6c',
    ]);
  });

  it('carries the hi-lo halves, per board, with the hand each was won with', () => {
    const { decoded } = roundTrip(ritHiLoInput());
    const lows = decoded.winners.filter((w) => w.low);
    expect(lows).toHaveLength(2);
    expect(lows.map((w) => w.board).sort()).toEqual([1, 2]);
    expect(decoded.winners.find((w) => w.board === 1 && !w.low)?.hand).toBe('Flush, Ace High');
  });

  it('rebuilds the low half as a low row on the right board', () => {
    const { rebuilt } = roundTrip(ritHiLoInput());
    expect(rebuilt.hiLo).toBe(true);
    const lowBoardTwo = rebuilt.showdown.find((r) => r.low && r.boardIndex === 1 && r.isWinner);
    expect(lowBoardTwo?.userId).toBe(shareUserId(2));
  });

  it('carries the rake and the jackpot drop', () => {
    const { decoded, rebuilt } = roundTrip(ritHiLoInput());
    expect(decoded.rake).toBeCloseTo(0.2, 2);
    expect(decoded.bbjFee).toBeCloseTo(0.05, 2);
    expect(rebuilt.rake).toBeCloseTo(0.2, 2);
    expect(rebuilt.bbjFee).toBeCloseTo(0.05, 2);
  });

  it('carries the hand number, so a shared hand is called what it is called', () => {
    const { decoded, rebuilt } = roundTrip(ritHiLoInput());
    expect(String(decoded.handNumber)).toBe('6704153');
    expect(String(rebuilt.handNumber)).toBe('6704153');
  });

  it('keeps dead money dead: an ante is in the pot and never in front of a seat', () => {
    const { rebuilt } = roundTrip(ritHiLoInput());
    const antes = rebuilt.streets.flatMap((s) => s.rows).filter((r) => r.verb === 'ante');
    expect(antes).toHaveLength(2);
    expect(antes.every((r) => r.dead)).toBe(true);
    /* And the raise is still differenced against LIVE chips only. Hero has
       0.02 live in front (the ante does not count), so a raise to 2 is an
       increment of 1.98 - the number Phase 3 found the felt drawing wrong. */
    const raise = rebuilt.streets
      .flatMap((s) => s.rows)
      .find((r) => r.verb === 'raise' && r.seat === 1);
    expect(raise?.amount).toBeCloseTo(1.98, 2);
  });

  it('rebuilds to the same pot the sharer saw', () => {
    const { model, rebuilt } = roundTrip(ritHiLoInput());
    expect(rebuilt.potTotal).toBeCloseTo(model.potTotal, 2);
    expect(rebuilt.reconciles).toBe(true);
  });
});

describe('what must never be gained on the way', () => {
  it('never turns the sharer’s own folded cards into a showdown', () => {
    const input = ritHiLoInput({
      holeCards: {},
      privateHoleCards: {
        [HERO]: [
          { rank: 'A', suit: 'c' },
          { rank: '2', suit: 'c' },
          { rank: 'T', suit: 'h' },
          { rank: '9', suit: 'h' },
        ],
      },
      winnersByBoard: null,
      winners: [{ userId: VILLAIN, amount: 4.1 }],
    });
    const { decoded, rebuilt } = roundTrip(input);
    const hero = decoded.players.find((p) => p.seat === 1);
    expect(hero?.cards).toHaveLength(4);
    expect(hero?.privateCards).toBe(true);
    // Private on the way back in: drawn for the viewer, never a `show` row.
    const rebuiltHero = rebuilt.players.find((p) => p.seat === 1);
    expect(rebuiltHero?.privateHole).toHaveLength(4);
    expect(rebuiltHero?.hole).toBeNull();
    expect(rebuilt.streets.flatMap((s) => s.rows).some((r) => r.verb === 'show')).toBe(false);
  });

  it('shares nobody else’s private cards, only the sharer’s own', () => {
    const input = ritHiLoInput({
      holeCards: {},
      privateHoleCards: {
        [VILLAIN]: [
          { rank: '3', suit: 'c' },
          { rank: '4', suit: 'c' },
          { rank: '7', suit: 'h' },
          { rank: '8', suit: 'h' },
        ],
      },
    });
    const { shared } = roundTrip(input, HERO);
    expect(shared.players.find((p) => p.seat === 2)?.cards).toBeUndefined();
  });

  it('omits a stack nobody knew rather than sharing a zero', () => {
    /* `encodeMoney(undefined)` is '0', so an unknown stack used to arrive as
       every seat sitting behind nothing - which reads as fact. */
    const input = ritHiLoInput({
      players: [
        { seat: 1, userId: HERO, username: 'Hero', stack: null },
        { seat: 2, userId: VILLAIN, username: 'Villain', stack: null },
      ],
    });
    const { decoded } = roundTrip(input);
    for (const p of decoded.players) expect(p.stack).toBeUndefined();
  });

  it('carries a known starting stack through as itself', () => {
    const { decoded, rebuilt } = roundTrip(ritHiLoInput());
    const hero = decoded.players.find((p) => p.seat === 1);
    expect(hero?.stack).toBeGreaterThan(0);
    expect(rebuilt.players.find((p) => p.seat === 1)?.startStack).toBeCloseTo(hero!.stack!, 2);
  });

  it('does not invent blinds for a bomb pot', () => {
    const bomb = ritHiLoInput({
      gameVariant: 'plo4',
      potSize: 3.0,
      rakeAmount: 0,
      bbjAmount: 0,
      extraBoards: null,
      winnersByBoard: null,
      winners: [{ userId: HERO, amount: 3.0 }],
      actions: [
        { seat: 1, userId: HERO, action: 'bomb_ante', amount: 1.5, stage: 'preflop', dead: true },
        {
          seat: 2,
          userId: VILLAIN,
          action: 'bomb_ante',
          amount: 1.5,
          stage: 'preflop',
          dead: true,
        },
      ],
      bombPot: true,
    });
    const { shared, rebuilt } = roundTrip(bomb);
    expect(shared.bombPot).toBe(true);
    const rows = rebuilt.streets.flatMap((s) => s.rows);
    expect(rows.some((r) => r.verb === 'sb' || r.verb === 'bb')).toBe(false);
    expect(rebuilt.rebuiltPot).toBeCloseTo(3.0, 2);
    expect(rebuilt.reconciles).toBe(true);
  });

  it('drops a verb the wire cannot carry instead of renaming it', () => {
    const odd = ritHiLoInput({
      actions: [
        { seat: 1, userId: HERO, action: 'sb', amount: 0.02, stage: 'preflop' },
        { seat: 2, userId: VILLAIN, action: 'bb', amount: 0.05, stage: 'preflop' },
        { seat: 1, userId: HERO, action: 'teleported', amount: 0, stage: 'preflop' },
      ],
      potSize: 0.07,
      winners: [{ userId: HERO, amount: 0.07 }],
      winnersByBoard: null,
      extraBoards: null,
      rakeAmount: 0,
      bbjAmount: 0,
    });
    const { shared } = roundTrip(odd);
    expect(shared.preflop.map((a) => a.action)).toEqual(['SB', 'BB']);
  });
});

describe('the wire itself', () => {
  it('reads a seat number that is more than one digit', () => {
    /* `parseInt(token[0])` made seat 10 into seat 1 taking an unknown action,
       so that seat's whole hand vanished from the link. */
    const input = ritHiLoInput({
      players: [
        { seat: 9, userId: HERO, username: 'Hero', stack: 5 },
        { seat: 10, userId: VILLAIN, username: 'Villain', stack: 5 },
      ],
      buttonSeat: 9,
      actions: [
        { seat: 9, userId: HERO, action: 'sb', amount: 0.02, stage: 'preflop' },
        { seat: 10, userId: VILLAIN, action: 'bb', amount: 0.05, stage: 'preflop' },
        { seat: 9, userId: HERO, action: 'fold', amount: 0, stage: 'preflop' },
      ],
      potSize: 0.07,
      winners: [{ userId: VILLAIN, amount: 0.07 }],
      winnersByBoard: null,
      extraBoards: null,
      board: [],
      holeCards: {},
      rakeAmount: 0,
      bbjAmount: 0,
    });
    const { decoded } = roundTrip(input);
    expect(decoded.preflop.map((a) => a.seat)).toEqual([9, 10, 9]);
  });

  it('still decodes a v3 payload, and reads its amounts as raise-TO levels', () => {
    /* No link may rot. A v3 payload carried the ENGINE's amounts, where a
       raise's number is the level rather than the increment; reading those as
       increments would count every raise twice. */
    const v3 = [
      'v3',
      'NLH',
      '1-2',
      '1',
      Date.now().toString(36),
      `1:${btoa('Hero')}:${(500 * 100).toString(36)}::h`,
      `1B${(10 * 100).toString(36)},2C${(10 * 100).toString(36)}`,
      '',
      '',
      '',
      (20 * 100).toString(36),
      `1:${(20 * 100).toString(36)}`,
      btoa('Table 7'),
    ].join('~');
    const decoded = decodeHandFromUrl(
      btoa(v3).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    );
    expect(decoded?.wireVersion).toBe('v3');
    expect(decoded?.preflop[0]).toEqual({ seat: 1, action: 'BET', amount: 10 });
    expect(decoded?.potTotal).toBe(20);
  });

  it('refuses a payload it cannot read rather than half-reading it', () => {
    expect(decodeHandFromUrl('not-a-payload')).toBeNull();
    expect(decodeHandFromUrl('')).toBeNull();
  });

  it('reads blinds out of stakes however the producer wrote them', () => {
    expect(blindsFromStakes('0.02/0.05')).toEqual({ smallBlind: 0.02, bigBlind: 0.05 });
    // A tournament's group separator used to make 1,000 parse as 1.
    expect(blindsFromStakes('500/1,000')).toEqual({ smallBlind: 500, bigBlind: 1000 });
    expect(blindsFromStakes(undefined)).toEqual({ smallBlind: 0, bigBlind: 0 });
  });

  it('maps every live variant, from either producer', () => {
    expect(toShareVariant('plo8')).toBe('PLO8');
    expect(toShareVariant('short_deck')).toBe('Short Deck');
    expect(toShareVariant('pineapple')).toBe('Crazy Pineapple');
    expect(toShareVariant('nlh')).toBe('NLH');
  });
});

describe('there is one replayer', () => {
  it('the share page renders HandReplay, not a list of streets', () => {
    const page = readSrc('src/pages/share/SharedHandReplayPage.tsx');
    expect(page).toContain('replayFromShareable');
    expect(page).toContain('<HandReplay');
    // The felt it draws must not come from a second reading of the hand.
    expect(page).not.toMatch(/function Street\(/);
  });

  it('the by-id share route renders HandReplay too', () => {
    const page = readSrc('src/pages/share/HandReplayerPage.tsx');
    expect(page).toContain('<HandReplay');
    // The import, not the word: the file explains in prose what it retired.
    expect(page).not.toMatch(/^import .*HandReplay3D/m);
    // No timeline of its own: the step state that indexed a board by step
    // number is gone with the second replayer.
    expect(page).not.toMatch(/useState.*currentStep|setCurrentStep/);
  });

  it('the second replayer and its widgets are gone', () => {
    expect(existsSync(resolve(__dirname, '../../src/components/replay/HandReplay3D.tsx'))).toBe(
      false
    );
    expect(existsSync(resolve(__dirname, '../../src/components/hand-replayer'))).toBe(false);
    expect(existsSync(resolve(__dirname, '../../src/types/engine/handReplay.ts'))).toBe(false);
  });

  it('a hand handed to the replayer outright is never also fetched', () => {
    const src = readSrc('src/components/replay/HandReplay.tsx');
    expect(src).toContain('propSource ? undefined :');
    expect(src).toContain('export interface ReplaySource');
  });
});
