/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARE HAND — Premium-Style Shareable Hand Replay
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Complete shareable hand replay system:
 * - Encode/decode hand data to URL
 * - Share modal with social options
 * - Permalink generation
 * - Preview card
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import { CardImage, type Card } from '../table/CardImage';
import './ShareHand.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShareableCard {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's';
}

export interface ShareableAction {
  seat: number;
  /**
   * v3 (2026-09-05) adds the FORCED money and the returned bet. A shared hand
   * used to carry only the six chosen verbs, so every recipient saw a pot that
   * began at the first voluntary action with no blinds in it, and a returned
   * uncalled bet stayed in the pot. `DISCARD` is Crazy Pineapple's thrown card
   * (the card itself is never shared - it is the viewer's own).
   */
  action:
    | 'FOLD'
    | 'CHECK'
    | 'CALL'
    | 'BET'
    | 'RAISE'
    | 'ALL_IN'
    | 'SB'
    | 'BB'
    | 'ANTE'
    | 'STRADDLE'
    | 'POST'
    | 'RETURN'
    | 'DISCARD';
  amount?: number;
  /**
   * v4 (2026-09-05): DEAD forced money — an ante, a bomb-pot ante, the dead
   * half of a dead blind. It is in the pot but was never in front of the seat,
   * so nothing may price a call off it. Phase 3 found what happens when this
   * fact is dropped: a tournament big blind drawn sitting behind its blind
   * PLUS its ante, and every pot-odds figure priced off that number.
   */
  dead?: boolean;
}

export interface ShareablePlayer {
  seat: number;
  name: string;
  /**
   * Chips in front of the player. OPTIONAL because not every source knows it —
   * `HandRecord.players` (the saved hand history) carries no stack at all, and
   * HandHistoryPage used to fill in a literal `1000` for every seat, so every
   * shared hand showed fabricated chip counts as if they were fact. Leave it
   * undefined rather than inventing a number; the replayer omits the figure.
   *
   * v4 pins WHICH stack: the one this seat STARTED the hand with, which is the
   * only one a replayer can count down from. v1-v3 carried whatever the
   * producer happened to hold (the live table sent the starting stack, the
   * archive sent nothing), so the number could not be read either way.
   */
  stack?: number;
  cards?: ShareableCard[];
  /**
   * v4: these cards were NEVER SHOWN to the table — they are the sharer's own
   * holding on a hand that did not reach showdown. Marked rather than merged,
   * because a recipient's reconstruction treats a known holding as a reveal:
   * without this flag, sharing a hand you folded turned your fold into a show
   * row and put you in a showdown that never happened.
   */
  privateCards?: boolean;
  isWinner?: boolean;
  isHero?: boolean;
  /** v4: reached showdown and mucked. Drawn as a muck, not as "no cards". */
  mucked?: boolean;
  /** v4: the made hand this seat showed ("Flush, Ace High"), when it showed. */
  handName?: string;
  /**
   * v4: THE CHIPS THIS SEAT WAS ACTUALLY PAID, after rake.
   *
   * Not the same number as the per-board shares in `winners`, and the wire
   * used to carry only one of them. Measured on production hand #6421788: the
   * record pays `winners[].amount` = 49.74, while `winners_by_board` shares
   * are 26.12 + 26.12 = 52.24, because the per-board figures are PRE-rake and
   * the payment is post-rake. Sending the per-board shares as the payment told
   * the recipient the winner collected 2.50 more than they did - the rake,
   * exactly - on every raked run-it-twice hand.
   */
  won?: number;
}

export interface ShareableHand {
  id: string;
  tableName: string;
  /* The live catalogue is nlh, plo4, plo5, plo6, plo8, short_deck,
     and pineapple. This union named half of it, so PLO8 was
     shared as PLO4 and short deck and both pineapples were shared as NLH.
     Encoded values ride inside a base64 payload, so labels round-trip. */
  variant: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6' | 'PLO8' | 'Short Deck' | 'Crazy Pineapple';
  stakes: string; // "1/2", "5/10", etc
  timestamp: number; // Unix timestamp
  buttonSeat: number;
  players: ShareablePlayer[];
  preflop: ShareableAction[];
  flop?: { cards: ShareableCard[]; actions: ShareableAction[] };
  turn?: { card: ShareableCard; actions: ShareableAction[] };
  river?: { card: ShareableCard; actions: ShareableAction[] };
  potTotal: number;
  winners: ShareableWinner[];

  // ── v4 (2026-09-05) — everything the one reconstruction knows ────────────
  /**
   * The hand's own number, so a shared hand is called what it is called
   * everywhere else. Absent on v1-v3 links, whose replay had no title.
   */
  handNumber?: number | string | null;
  /**
   * Crazy Pineapple's discard street. A real street, not a footnote on
   * preflop: 74,631 discard actions exist in production and a link that
   * folded them into preflop printed them under a heading they did not
   * happen on. The CARD never travels - it is the viewer's own.
   */
  discard?: { actions: ShareableAction[] };
  /**
   * The SHOWDOWN street's own rows. Small but not empty: the engine writes a
   * returned uncalled bet with stage `showdown`, and a wire with no slot for
   * that street dropped it - see the note in `encodeHand`.
   */
  showdown?: { actions: ShareableAction[] };
  /**
   * Run-it-twice runs 2..N, and the second and third boards of a
   * double-board bomb pot. Board one stays in flop / turn / river. Each entry
   * is the whole board that run finished on.
   */
  extraBoards?: ShareableCard[][];
  /** What the house took out of this pot, and the jackpot drop beside it. */
  rake?: number;
  bbjFee?: number;
  /**
   * A BOMB POT posts antes and NO blinds. Without this the recipient's
   * reconstruction sees a hand with no blind rows, decides they were dropped,
   * and invents a small and a big blind nobody posted - the exact defect
   * Phase 3 found on hand #6704153.
   */
  bombPot?: boolean;
  /**
   * Which wire version this hand was decoded FROM, set by the decoder and
   * never encoded. It is how a reader knows what the amounts mean: v4 carries
   * the reconstruction's own INCREMENTAL amounts, v1-v3 carried the engine's
   * raise-TO levels. Undefined on a hand built in memory (it has not been on
   * a wire), which reads as current - v4.
   */
  wireVersion?: 'v1' | 'v2' | 'v3' | 'v4';
}

/**
 * A SHARE OF THE POT.
 *
 * On v1-v3 this list WAS the payment: one row per winner, the chips they
 * collected. On v4 it is the record's own breakdown - one row per board and
 * per half when the hand had them - and what each player was PAID lives on
 * `ShareablePlayer.won`, because those are two different numbers (see there).
 * A v4 hand with no per-board awards still writes one row per winner here, so
 * the two agree on an ordinary pot.
 */
export interface ShareableWinner {
  seat: number;
  /** GROSS chips out of the pot, before rake. */
  amount: number;
  /** v4: 1-based board this share was won on. Absent on a single-board hand. */
  board?: number;
  /** v4: this share is the LOW half of a split (eight-or-better) pot. */
  low?: boolean;
  /** v4: the hand it was won with, on that board. */
  hand?: string;
}

export interface ShareHandProps {
  isOpen: boolean;
  onClose: () => void;
  hand: ShareableHand;
  baseUrl?: string;
  clubName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENCODING/DECODING — Compact Base64 URL-safe encoding
// ═══════════════════════════════════════════════════════════════════════════════

// Card encoding: 2 characters per card (rank + suit)
const RANKS = '23456789TJQKA';
const SUITS = 'hdcs';

function encodeCard(card: ShareableCard): string {
  const r = RANKS.indexOf(card.rank.toUpperCase());
  const s = SUITS.indexOf(card.suit);
  return String.fromCharCode(65 + r * 4 + s); // A-Z, a-z encoding
}

function decodeCard(char: string): ShareableCard {
  const code = char.charCodeAt(0) - 65;
  const r = Math.floor(code / 4);
  const s = code % 4;
  return { rank: RANKS[r], suit: SUITS[s] as 'h' | 'd' | 'c' | 's' };
}

function encodeCards(cards: ShareableCard[]): string {
  return cards.map(encodeCard).join('');
}

function decodeCards(str: string, count: number): ShareableCard[] {
  const cards: ShareableCard[] = [];
  for (let i = 0; i < count && i < str.length; i++) {
    cards.push(decodeCard(str[i]));
  }
  return cards;
}

// Action encoding: seat(digits) + verb(1 uppercase) + amount(base36) + dead(!)

/**
 * CODEC FIX 2026-08-15 — CHECK was encoded as CALL.
 *
 * The old encoder took the action's FIRST LETTER and looked it up in
 * 'FCXBRA'. 'CHECK'[0] and 'CALL'[0] are both 'C', so both encoded to 'C' —
 * and the decoder maps 'C' to CALL. Every check in every shared hand was
 * replayed to the recipient as a call, which changes the whole reading of the
 * hand. 'X' (the actual check code the decoder expects) was unreachable.
 *
 * Explicit table, no first-letter inference.
 */
const ACTION_CODE: Record<ShareableAction['action'], string> = {
  FOLD: 'F',
  CALL: 'C',
  CHECK: 'X',
  BET: 'B',
  RAISE: 'R',
  ALL_IN: 'A',
  // v3
  SB: 'S',
  BB: 'G',
  ANTE: 'N',
  STRADDLE: 'T',
  POST: 'P',
  RETURN: 'U',
  DISCARD: 'I',
};

const CODE_ACTION: Record<string, ShareableAction['action']> = Object.fromEntries(
  Object.entries(ACTION_CODE).map(([k, v]) => [v, k as ShareableAction['action']])
);

/**
 * MONEY IS IN CENTS ON THE WIRE (v3, 2026-09-05). Every amount, stack, pot and
 * winner share used to be `Math.round(chips)` in base36, so on a 0.02/0.05
 * table every figure in a shared hand rounded to 0 or 1 - a recipient saw
 * "Seat 3 RAISE" with no number, a pot of 0 and winners of 0. v1/v2 payloads
 * still decode as the whole chips they were written as.
 */
const CENTS = 100;
const encodeMoney = (n: number | undefined): string =>
  Math.max(0, Math.round((Number(n) || 0) * CENTS)).toString(36);
const decodeMoney = (s: string | undefined, version: string): number => {
  const raw = parseInt(s || '', 36);
  if (!Number.isFinite(raw)) return 0;
  return version === 'v3' || version === 'v4' ? raw / CENTS : raw;
};

/** v4: dead forced money is marked on its own token. */
const DEAD_MARK = '!';

function encodeAction(action: ShareableAction): string {
  let str = `${action.seat}${ACTION_CODE[action.action] || 'X'}`;
  if (action.amount !== undefined) {
    str += encodeMoney(action.amount);
  }
  if (action.dead) str += DEAD_MARK;
  return str;
}

function encodeActions(actions: ShareableAction[]): string {
  return actions.map(encodeAction).join(',');
}

/**
 * Shared action-list parser — the old decoder inlined this three times and
 * still never called it for the turn or the river.
 *
 * THE SEAT IS ITS LEADING DIGITS, not `token[0]`. A one-character seat was
 * fine while every table was nine-handed or smaller, but it is a limit hidden
 * inside a codec rather than a stated one: on a ten-seat table seat 10 encoded
 * as `10F` and read back as SEAT 1 taking action `0` - an unknown code, so the
 * row was dropped and one player's whole hand vanished from the link. Digits,
 * then the verb (always an UPPERCASE letter), then the amount (base36, always
 * lowercase or a digit), then an optional dead mark.
 */
function decodeActions(str: string | undefined, version: string): ShareableAction[] {
  const out: ShareableAction[] = [];
  if (!str) return out;
  for (const rawToken of str.split(',')) {
    const dead = rawToken.endsWith(DEAD_MARK);
    const token = dead ? rawToken.slice(0, -1) : rawToken;
    const m = token.match(/^(\d+)([A-Z])(.*)$/);
    if (!m) continue;
    const seat = parseInt(m[1], 10);
    if (!Number.isFinite(seat)) continue;
    /* An unknown code is skipped, not read as CHECK. It used to default to
       CHECK, which invented an action the player never took. */
    const verb = CODE_ACTION[m[2]];
    if (!verb) continue;
    const action: ShareableAction = { seat, action: verb };
    if (m[3]) {
      const amt = decodeMoney(m[3], version);
      if (Number.isFinite(amt)) action.amount = amt;
    }
    if (dead) action.dead = true;
    out.push(action);
  }
  return out;
}

/** Split a `cards|actions` street segment; either side may be empty. */
function splitStreet(part: string | undefined): { cards: string; actions: string } | null {
  if (!part || !part.includes('|')) return null;
  const idx = part.indexOf('|');
  return { cards: part.slice(0, idx), actions: part.slice(idx + 1) };
}

/**
 * btoa() throws on any code point above U+00FF, so a single emoji or
 * non-Latin character in a player name (or the table name) blew up the whole
 * encode and the share modal rendered a broken link. UTF-8 first, then base64,
 * padding stripped — '=' inside a ':'-delimited field corrupted the re-pad on
 * the way back out.
 */
function b64utf8(text: string): string {
  try {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=+$/, '');
  } catch {
    return '';
  }
}

function unb64utf8(text: string): string {
  if (!text) return '';
  try {
    const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

/**
 * TRIM A LABEL WITHOUT CUTTING A CHARACTER IN HALF.
 *
 * `String.prototype.slice` counts UTF-16 code units, so it splits a surrogate
 * pair - an emoji in a player's name came back as a replacement character on
 * exactly the wrong boundary. `Array.from` iterates code points, so a trim
 * lands between characters.
 *
 * The CAPS were also too tight, measured against production 2026-09-05:
 *
 *   player name   longest real 23  (cap was 24 - one character of headroom)
 *   table name    longest real 59  (cap was 40, and 1,484 tables are over it)
 *
 * The table-name cut was not cosmetic. Tournament tables are named
 * "DSS Wednesday $16.50 NLH Bounty Hunter - 5 PM CT - Table 10", so 40
 * characters removed THE TABLE NUMBER: every table of one tournament shared
 * under the same truncated name, and the header of a shared hand no longer
 * said which table it came from.
 */
function clip(text: string | null | undefined, max: number): string {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/** How much of each label the wire carries. See `clip` for the measurements. */
const CAP_NAME = 40;
const CAP_TABLE = 80;
const CAP_HAND = 48;

// Full hand encoding
export function encodeHand(hand: ShareableHand): string {
  const parts: string[] = [];

  // Version + variant.
  // CODEC FIX 2026-08-15: bumped to v2. v1 dropped the turn, the river, the
  // winners, the table name and the hero/winner flags on the way back out —
  // see decodeHandFromUrl. v1 payloads still decode (there are none in the
  // wild: the /replay route did not exist until today).
  // v3 (2026-09-05): money in cents, forced-money verbs. v1/v2 still decode.
  // v4 (2026-09-05): the reconstruction's own hand. Amounts are INCREMENTAL,
  // dead money is marked, and the extra boards, the hi-lo halves, the rake,
  // the jackpot drop, the hand number and the discard street all travel — so
  // a recipient rebuilds the same model the sharer was looking at rather than
  // a thinner cousin of it. v1-v3 still decode; see decodeHandFromUrl.
  parts.push('v4');
  parts.push(hand.variant);
  parts.push(hand.stakes.replace('/', '-'));
  parts.push(hand.buttonSeat.toString());
  parts.push(hand.timestamp.toString(36));

  // Players: seat:name:stack:cards:flags:handName
  //   flags — 'h' hero, 'w' winner, 'm' mucked, 'p' cards never shown to the
  //   table (the sharer's own); any combination, '' none.
  // v1 truncated the base64 name to 8 chars (≈6 bytes) and lost isHero /
  // isWinner entirely, so a replay could not mark who shared it or who won.
  const playerStr = hand.players
    .map((p) => {
      const flags =
        `${p.isHero ? 'h' : ''}${p.isWinner ? 'w' : ''}` +
        `${p.mucked ? 'm' : ''}${p.privateCards ? 'p' : ''}`;
      const cards = p.cards?.length ? encodeCards(p.cards) : '';
      const handName = p.handName ? b64utf8(clip(p.handName, CAP_HAND)) : '';
      /* An UNKNOWN stack is empty, not zero. `encodeMoney(undefined)` is '0',
         so a hand shared from the archive - which carries no stacks at all -
         used to reach the recipient with every seat sitting behind nothing,
         which reads as fact and is not one. */
      const stack = p.stack == null ? '' : encodeMoney(p.stack);
      /* What this seat was PAID, after rake. Empty when they won nothing. */
      const won = p.won ? encodeMoney(p.won) : '';
      return `${p.seat}:${b64utf8(clip(p.name, CAP_NAME))}:${stack}:${cards}:${flags}:${handName}:${won}`;
    })
    .join(';');
  parts.push(playerStr);

  // Actions per street
  parts.push(encodeActions(hand.preflop));

  if (hand.flop) {
    parts.push(encodeCards(hand.flop.cards) + '|' + encodeActions(hand.flop.actions));
  } else {
    parts.push('');
  }

  if (hand.turn) {
    parts.push(encodeCard(hand.turn.card) + '|' + encodeActions(hand.turn.actions));
  } else {
    parts.push('');
  }

  if (hand.river) {
    parts.push(encodeCard(hand.river.card) + '|' + encodeActions(hand.river.actions));
  } else {
    parts.push('');
  }

  // Pot and winners. v4 adds the board a share was won on, the low-half mark
  // and the hand it was won with: `seat:amount:board:low:hand`.
  parts.push(encodeMoney(hand.potTotal));
  parts.push(
    (hand.winners || [])
      .map((w) =>
        [
          w.seat,
          encodeMoney(w.amount),
          w.board ?? '',
          w.low ? '1' : '',
          w.hand ? b64utf8(clip(w.hand, CAP_HAND)) : '',
        ].join(':')
      )
      .join(';')
  );
  // v2 field — the table name. v1 hard-coded "Shared Hand" on decode, so the
  // recipient never saw which table the hand came from.
  parts.push(b64utf8(clip(hand.tableName, CAP_TABLE)));

  // ── v4 fields, appended so every earlier payload still parses ───────────
  // 13: run-it-twice / bomb-pot boards 2..N, whole boards, ';'-joined.
  parts.push((hand.extraBoards || []).map((b) => encodeCards(b)).join(';'));
  // 14: what the house took, and the jackpot drop.
  parts.push(`${encodeMoney(hand.rake)}:${encodeMoney(hand.bbjFee)}`);
  // 15: the hand's own number.
  parts.push(hand.handNumber == null ? '' : b64utf8(clip(String(hand.handNumber), 24)));
  // 16: Crazy Pineapple's discard street (the card itself never travels).
  parts.push(hand.discard ? encodeActions(hand.discard.actions) : '');
  // 17: hand-level flags. 'b' — a bomb pot, which posts antes and NO blinds.
  parts.push(hand.bombPot ? 'b' : '');
  /* 18: the SHOWDOWN street's own rows. The engine writes the returned
     uncalled bet with stage `showdown`, and the wire had no slot for that
     street - so the return never travelled, the recipient's reconstruction
     inferred one of its own and hung it on the river, and the river's pot
     line read the hand 7.70 lighter than it was (production #5087420). */
  parts.push(hand.showdown ? encodeActions(hand.showdown.actions) : '');

  // Base64 URL-safe encode. Everything above is ASCII by construction (names
  // are base64'd), so btoa cannot throw here.
  const encoded = btoa(parts.join('~')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return encoded;
}

export function decodeHandFromUrl(encoded: string): ShareableHand | null {
  try {
    // Restore Base64
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const decoded = atob(base64);

    const parts = decoded.split('~');
    const version = parts[0];
    // CODEC FIX 2026-08-15: v1 is still accepted so no link can rot, but v1
    // payloads genuinely do not carry the turn, the river, the winners, the
    // table name or the hero/winner flags — they were never encoded as
    // recoverable fields. v2 does.
    if (version !== 'v1' && version !== 'v2' && version !== 'v3' && version !== 'v4') return null;

    // Parse basic info
    const variant = parts[1] as ShareableHand['variant'];
    const stakes = (parts[2] || '').replace('-', '/');
    const buttonSeat = parseInt(parts[3], 10) || 0;
    const timestamp = parseInt(parts[4], 36) || Date.now();

    // Parse players — v1: seat:name:stack:cards / v2 adds :flags / v4 :handName
    const players: ShareablePlayer[] = (parts[5] || '')
      .split(';')
      .filter(Boolean)
      .map((ps) => {
        const [seat, nameB64, stackB36, cardsStr, flags, handNameB64, wonB36] = ps.split(':');
        const player: ShareablePlayer = {
          seat: parseInt(seat, 10) || 0,
          name: unb64utf8(nameB64) || `Seat ${seat}`,
        };
        /* Empty means the producer did not know it (v4). Zero means zero. */
        if (stackB36) player.stack = decodeMoney(stackB36, version);
        if (cardsStr) player.cards = decodeCards(cardsStr, cardsStr.length);
        if (flags) {
          if (flags.includes('h')) player.isHero = true;
          if (flags.includes('w')) player.isWinner = true;
          if (flags.includes('m')) player.mucked = true;
          if (flags.includes('p')) player.privateCards = true;
        }
        const handName = unb64utf8(handNameB64);
        if (handName) player.handName = handName;
        if (wonB36) player.won = decodeMoney(wonB36, version);
        return player;
      });

    // Streets. THE BUG: the old decoder parsed preflop and the flop, then
    // jumped straight to building the object — parts[8] (turn) and parts[9]
    // (river) were read by nothing, so every shared hand ended on the flop no
    // matter how it actually played, and parts[11] (winners) was discarded in
    // favour of a hard-coded empty array.
    const preflop = decodeActions(parts[6], version);

    let flop: ShareableHand['flop'];
    const flopSeg = splitStreet(parts[7]);
    if (flopSeg) {
      flop = {
        cards: decodeCards(flopSeg.cards, 3),
        actions: decodeActions(flopSeg.actions, version),
      };
    }

    let turn: ShareableHand['turn'];
    const turnSeg = splitStreet(parts[8]);
    if (turnSeg && turnSeg.cards) {
      turn = {
        card: decodeCard(turnSeg.cards[0]),
        actions: decodeActions(turnSeg.actions, version),
      };
    }

    let river: ShareableHand['river'];
    const riverSeg = splitStreet(parts[9]);
    if (riverSeg && riverSeg.cards) {
      river = {
        card: decodeCard(riverSeg.cards[0]),
        actions: decodeActions(riverSeg.actions, version),
      };
    }

    /* v1-v3: `seat:amount`. v4 appends the board, the low-half mark and the
       hand it was won with; the extra fields are simply absent on the old
       shape, which is why they are read positionally rather than counted. */
    const winners: ShareableWinner[] = (parts[11] || '')
      .split(';')
      .filter(Boolean)
      .map((w) => {
        const [seat, amt, board, low, handB64] = w.split(':');
        const row: ShareableWinner = {
          seat: parseInt(seat, 10) || 0,
          amount: decodeMoney(amt, version),
        };
        const boardIndex = parseInt(board || '', 10);
        if (Number.isFinite(boardIndex) && boardIndex > 0) row.board = boardIndex;
        if (low === '1') row.low = true;
        const handName = unb64utf8(handB64);
        if (handName) row.hand = handName;
        return row;
      });

    // ── v4 tail. Absent on every earlier payload, which parses unchanged ───
    const extraBoards = (parts[13] || '')
      .split(';')
      .filter(Boolean)
      .map((b) => decodeCards(b, b.length))
      .filter((b) => b.length > 0);
    const [rakeStr, bbjStr] = (parts[14] || '').split(':');
    const handNumber = unb64utf8(parts[15]);
    const discardActions = decodeActions(parts[16], version);
    const handFlags = parts[17] || '';
    const showdownActions = decodeActions(parts[18], version);

    // Build hand object
    const hand: ShareableHand = {
      id: encoded.substring(0, 12),
      tableName: unb64utf8(parts[12]) || 'Shared Hand',
      variant,
      stakes,
      timestamp,
      buttonSeat,
      players,
      preflop,
      flop,
      turn,
      river,
      potTotal: decodeMoney(parts[10], version),
      winners,
      wireVersion: version,
    };
    if (extraBoards.length) hand.extraBoards = extraBoards;
    if (rakeStr) hand.rake = decodeMoney(rakeStr, version);
    if (bbjStr) hand.bbjFee = decodeMoney(bbjStr, version);
    if (handNumber) hand.handNumber = handNumber;
    if (discardActions.length) hand.discard = { actions: discardActions };
    if (showdownActions.length) hand.showdown = { actions: showdownActions };
    if (handFlags.includes('b')) hand.bombPot = true;

    return hand;
  } catch (e) {
    reportError(e, 'ShareHand.Failed_to_decode_hand');
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert ShareableCard to CardImage Card type.
 */
function toCard(sc: ShareableCard): Card {
  let rank = sc.rank;
  if (rank === '10') rank = 'T';
  return { rank: rank as Card['rank'], suit: sc.suit as Card['suit'] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ShareHand({
  isOpen,
  onClose,
  hand,
  baseUrl = 'https://smarter.poker/hub/club-arena/replay',
  clubName = 'Smarter Poker',
}: ShareHandProps) {
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [copied, setCopied] = useState(false);
  // CA-2 BUG FIX: track the "Copied" dismiss timer so it can be cancelled on
  // unmount — was calling setCopied on an already-unmounted component.
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTab, setActiveTab] = useState<'link' | 'social' | 'embed'>('link');
  const [visibleSocial, setVisibleSocial] = useState<boolean[]>([]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      staggerTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  // Generate shareable URL
  const shareUrl = useMemo(() => {
    const encoded = encodeHand(hand);
    return `${baseUrl}?h=${encoded}`;
  }, [hand, baseUrl]);

  // Social share text
  const shareText = useMemo(() => {
    const hero = hand.players.find((p) => p.isHero);
    const winner = hand.players.find((p) => p.isWinner);
    const potStr = `${hand.potTotal.toLocaleString()}`;

    if (winner?.isHero) {
      return `I just won a ${potStr} pot in ${hand.stakes} ${hand.variant}! \n\nWatch the replay on ${clubName}! `;
    }
    return `Check out this ${potStr} pot hand from ${hand.stakes} ${hand.variant}!\n\nWatch the video replay on ${clubName}! `;
  }, [hand, clubName]);

  // Copy link
  const handleCopy = useCallback(async () => {
    haptic.light();
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      clearTimeout(copiedTimerRef.current!);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      reportError(error, 'ShareHand.Copy_failed');
    }
  }, [shareUrl]);

  // Share to social platforms
  const handleSocialShare = useCallback(
    (platform: 'twitter' | 'facebook' | 'telegram' | 'whatsapp') => {
      const encodedUrl = encodeURIComponent(shareUrl);
      const encodedText = encodeURIComponent(shareText);

      const urls = {
        twitter: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedText}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
        telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
        whatsapp: `https://wa.me/?text=${encodedText}%0A%0A${encodedUrl}`,
      };

      window.open(urls[platform], '_blank', 'width=600,height=400');
    },
    [shareUrl, shareText]
  );

  // Native share (mobile)
  const handleNativeShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Hand Replay - ' + clubName,
          text: shareText,
          url: shareUrl,
        });
      } catch (error) {
        reportError(error, 'ShareHand.Share_failed');
      }
    }
  }, [shareText, shareUrl, clubName]);

  // Embed code
  const embedCode = useMemo(() => {
    return `<iframe src="${shareUrl}&embed=true" width="400" height="300" frameborder="0" allowfullscreen></iframe>`;
  }, [shareUrl]);

  useEffect(() => {
    if (activeTab === 'social') {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
      setVisibleSocial([]);
      staggerTimersRef.current.push(
        ...[0, 1, 2, 3].map((i) =>
          setTimeout(() => setVisibleSocial((prev) => [...prev, true]), i * 50)
        )
      );
    }
  }, [activeTab]);

  if (!isOpen) return null;

  return (
    <div className="share-hand-overlay" onClick={onClose}>
      <div className="share-hand-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="share-hand__header">
          <h2 className="share-hand__title"> Share Hand</h2>
          <button className="share-hand__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Preview Card */}
        <div className="share-hand__preview">
          <div className="share-hand__preview-header">
            <span className="share-hand__variant">{hand.variant}</span>
            <span className="share-hand__stakes">{hand.stakes}</span>
          </div>

          {/* Board Preview — Custom PNG Deck */}
          <div className="share-hand__board">
            {hand.flop && (
              <div className="share-hand__cards">
                {hand.flop.cards.map((card, i) => (
                  <div key={i} className="share-hand__card-img">
                    <CardImage card={toCard(card)} size="md" />
                  </div>
                ))}
                {hand.turn && (
                  <div className="share-hand__card-img">
                    <CardImage card={toCard(hand.turn.card)} size="md" />
                  </div>
                )}
                {hand.river && (
                  <div className="share-hand__card-img">
                    <CardImage card={toCard(hand.river.card)} size="md" />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="share-hand__pot">
            <span className="share-hand__pot-label">Pot</span>
            <span className="share-hand__pot-value">{hand.potTotal.toLocaleString()}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="share-hand__tabs">
          <button
            className={`share-hand__tab ${activeTab === 'link' ? 'share-hand__tab--active' : ''}`}
            onClick={() => setActiveTab('link')}
          >
            Link
          </button>
          <button
            className={`share-hand__tab ${activeTab === 'social' ? 'share-hand__tab--active' : ''}`}
            onClick={() => setActiveTab('social')}
          >
            Social
          </button>
          <button
            className={`share-hand__tab ${activeTab === 'embed' ? 'share-hand__tab--active' : ''}`}
            onClick={() => setActiveTab('embed')}
          >
            Embed
          </button>
        </div>

        {/* Tab Content */}
        <div className="share-hand__content">
          {activeTab === 'link' && (
            <div className="share-hand__link-tab">
              <div className="share-hand__url-box">
                <input type="text" value={shareUrl} readOnly className="share-hand__url-input" />
                <button
                  className={`share-hand__copy-btn ${copied ? 'share-hand__copy-btn--success' : ''}`}
                  onClick={handleCopy}
                >
                  {copied ? '' : ''}
                </button>
              </div>

              {'share' in navigator && (
                <button className="share-hand__native-share" onClick={handleNativeShare}>
                  Share
                </button>
              )}
            </div>
          )}

          {activeTab === 'social' && (
            <div className="share-hand__social-tab">
              {[
                {
                  platform: 'twitter',
                  icon: '𝕏',
                  label: 'Twitter / X',
                  className: 'share-hand__social-btn--twitter',
                },
                {
                  platform: 'facebook',
                  icon: 'f',
                  label: 'Facebook',
                  className: 'share-hand__social-btn--facebook',
                },
                {
                  platform: 'telegram',
                  icon: '',
                  label: 'Telegram',
                  className: 'share-hand__social-btn--telegram',
                },
                {
                  platform: 'whatsapp',
                  icon: '',
                  label: 'WhatsApp',
                  className: 'share-hand__social-btn--whatsapp',
                },
              ].map((social, idx) => (
                <button
                  key={social.platform}
                  className={`share-hand__social-btn ${social.className}`}
                  onClick={() =>
                    handleSocialShare(
                      social.platform as 'twitter' | 'facebook' | 'telegram' | 'whatsapp'
                    )
                  }
                  style={{
                    opacity: visibleSocial[idx] ? 1 : 0,
                    transform: visibleSocial[idx] ? 'scale(1)' : 'scale(0.9)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span className="share-hand__social-icon">{social.icon}</span>
                  {social.label}
                </button>
              ))}
            </div>
          )}

          {activeTab === 'embed' && (
            <div className="share-hand__embed-tab">
              <textarea className="share-hand__embed-code" value={embedCode} readOnly rows={3} />
              <button
                className="share-hand__copy-embed"
                onClick={() => navigator.clipboard.writeText(embedCode)}
              >
                Copy Embed Code
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="share-hand__footer">
          <span className="share-hand__footer-text">
            Click The Link To Watch A Video Replay Of This Hand
          </span>
        </div>
      </div>
    </div>
  );
}

export default ShareHand;
