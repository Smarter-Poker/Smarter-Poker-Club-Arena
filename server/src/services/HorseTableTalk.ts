/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE TABLE TALK: one ordinary chat line from a seated horse
 * (Phase 10 of the Fleet Content Programme, "Table talk at the felt", 2026-10-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Chat at the felt is one table, `table_chat`, written from the browser and
 * fanned out by Postgres realtime. A row with `message_type = 'player'` and a
 * seated `user_id` renders on every client as a player's line: name from the
 * seat roster, initial-letter avatar, chime, five-second bubble over the seat.
 * No client code path can tell such a row from a human's, which is exactly
 * what tests/a-horse-is-never-named.law.test.ts requires. So a horse speaks
 * by inserting that row and nothing else: the SAME four columns the browser
 * writes (useTableChat.ts), through the service-role client the engine
 * already uses for every seat and stack. Zero client change.
 *
 * WHEN. At settlement, from the hand the engine just captured (`snap` in
 * postHandTasks), one of four events:
 *
 *   big_pot_won     the horse is a winner and the pot is 40 big blinds or more
 *   showdown_loss   the horse showed two pair or better and did not win
 *   big_hand_shown  a winner SHOWED a full house or better; a non-winning
 *                   horse remarks on it (seat number only, never a name)
 *   arrival         a player sat down; a horse seated ten hands or more greets
 *
 * WHO. One candidate per hand, chosen by a hash of (table, hand, event) over
 * the horses that qualify, in a voice mapped from the dial the seat already
 * carries (resolveHorseStyle): grinder and tag are quiet, lag and tricky
 * needle, balanced is friendly. The line is a hash of (horse, hand, event)
 * over the voice's pool, so a replay answers the same way twice and a test can
 * assert the spread. Math.random stays out of the engine (CryptoRandom.ts).
 *
 * WHAT MAY BE SAID. Only facts the engine holds at that moment: the pot in
 * big blinds, the street the hand ended on, the hand name the engine SHOWED,
 * a seat number, the game variant. Never a username, never a mucked hand,
 * never another player's hole cards, never odds or history the engine does
 * not hold. sanitizeLine() is the one door every line passes before the chat
 * write: no dash in U+2012..U+2015, no emoji, no at sign, no token equal to a
 * seated player's username, at most 120 characters.
 *
 * THE GATE. Nothing is read from the ledger or written anywhere unless both
 * switches say yes (HorseTableTalkGate.ts: content_settings.engine_enabled
 * and horse_post_modes 'table_talk', cached 30 s, fail closed). The mode row
 * ships DISABLED; the owner turns it on with one UPDATE and every engine
 * process picks it up within 30 seconds, and off again the same way.
 *
 * THE CLAIM. Before the chat write, one INSERT into horse_table_talk_ledger
 * (service-role only, a row names a horse). UNIQUE (table_id, hand_number)
 * is what makes "one line per hand per table" true across engine processes:
 * the insert either wins the hand or conflicts, and a conflict is silence,
 * never a retry. The reads before it enforce the rest of the owner's limits:
 *
 *   3 lines per horse per rolling hour
 *   12 hands between a horse's lines at one table
 *   4 hands between any two lines at one table
 *   a phrase a horse used within 24 h, or anyone used at this table within
 *   2 h, is not said again
 *
 * HAND NUMBERS ARE GLOBAL (ServerTableEngineBase.handCount, 2026-08-18): they
 * come from one sequence across every table, so a difference of hand numbers
 * is not a count of hands at a table. The two "hands between" rules therefore
 * count the table's own hand_history rows since the ledger's newest row
 * (idx_hand_history_table_handnum), and this process remembers its own claims
 * per table as a fast path that refuses without any read at all.
 *
 * Ordering: ledger claim first, then the table_chat INSERT. If the chat write
 * fails the ledger row stays (the horse lost its words); nothing retries.
 * Fire-and-forget, never throws, deliberately NOT awaited by settlement, and
 * bound to the process root like HorseHandReview's writers so a line never
 * carries a tournament's data authority (it is cash-only anyway).
 *
 * NEVER refer to the horses as "bots": they are HORSES only.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { bindToProcessRoot } from './supabase/dataActorContext.js';
import { personaHash } from '../engine/HorsePersona.js';
import { resolveHorseStyle } from '../engine/HorseLogic.js';
import { HAND_RANKINGS } from '../engine/PokerEngine.js';
import { readTableTalkGate } from './HorseTableTalkGate.js';
import { LINES, TALK_PLACEHOLDERS, type TalkEvent, type TalkVoice } from './horseTableTalkLines.js';
import type { SeatedPlayer, TableInfo } from '../types.js';

export type { TalkEvent, TalkVoice } from './horseTableTalkLines.js';

// ═══════════════════════════════════════════════════════════════════════════════
// THE OWNER'S LIMITS
// ═══════════════════════════════════════════════════════════════════════════════

/** Event A fires at this pot size, in big blinds. */
export const BIG_POT_BB = 40;
/** Event D: a horse greets only once it has been seated this many hands. */
export const GREETER_MIN_HANDS_SEATED = 10;
/** At most this many lines per horse per rolling hour, fleet-wide. */
export const HORSE_LINES_PER_HOUR = 3;
/** A horse waits this many hands between its lines at one table. */
export const HORSE_MIN_HANDS_BETWEEN_LINES = 12;
/** A table hears at most one line per this many hands. */
export const TABLE_MIN_HANDS_BETWEEN_LINES = 4;
/** A horse does not repeat a phrase inside this window. */
export const PHRASE_HORSE_WINDOW_MS = 24 * 60 * 60_000;
/** A table does not hear the same phrase twice inside this window. */
export const PHRASE_TABLE_WINDOW_MS = 2 * 60 * 60_000;
/** The longest line that may be written. The client's input cap is 200. */
export const TALK_LINE_MAX_CHARS = 120;

const HOUR_MS = 60 * 60_000;

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SHAPES: what the engine hands over, and nothing it does not hold
// ═══════════════════════════════════════════════════════════════════════════════

export interface TalkSeat {
  userId: string;
  username: string | null;
  seat: number;
  isHorse: boolean;
  horseProfile?: unknown;
  occupancyId?: string | null;
}

export interface TalkTable {
  tableId: string;
  bigBlind: number;
  maxPlayers: number;
  banChat: boolean;
  isTournament: boolean;
  isDiamondCash: boolean;
  variant: string | null;
}

export interface TalkWinner {
  userId: string;
  amount: number;
  hand?: { name: string; ranking: number } | null;
}

export interface TalkShowdownResult {
  userId: string;
  handRanking: number;
  handName: string;
  mucked?: boolean;
}

export interface TableTalkInput {
  table: TalkTable;
  handNumber: number;
  potSize: number;
  communityCards: readonly string[];
  winners: readonly TalkWinner[];
  showdownResults: readonly TalkShowdownResult[];
  seated: readonly TalkSeat[];
}

export interface ArrivalInput {
  table: TalkTable;
  handNumber: number;
  arrivedUserId: string;
  arrivedSeat: number;
  seated: readonly TalkSeat[];
}

/** The slice of settlement's `snap` this module reads. Structural: `snap` fits as is. */
export interface TalkHandSnapshot {
  handNumber: number;
  variant: string | null;
  potSize: number;
  communityCards: string[];
  winners: Array<{ userId: string; amount: number; hand?: { name: string; ranking: number } }>;
  showdownResults: Array<{
    userId: string;
    handRanking: number;
    handName: string;
    mucked?: boolean;
  }>;
}

function isTournamentInfo(tableInfo: TableInfo): boolean {
  return !!(tableInfo.tournament_id || tableInfo.game_type === 'tournament');
}

function talkTableFrom(tableInfo: TableInfo, isTournament: boolean): TalkTable {
  return {
    tableId: tableInfo.id,
    bigBlind: Number(tableInfo.big_blind) || 0,
    maxPlayers: Number(tableInfo.max_players) || 0,
    banChat: tableInfo.ban_chat === true,
    isTournament,
    isDiamondCash: tableInfo.arena?.asset === 'diamonds',
    variant: tableInfo.game_variant ?? null,
  };
}

function talkSeatsFrom(players: readonly SeatedPlayer[]): TalkSeat[] {
  return players
    .filter((p) => typeof p.user_id === 'string' && p.user_id.length > 0)
    .map((p) => ({
      userId: p.user_id,
      username: p.username ?? null,
      seat: p.seat_number,
      isHorse: p.is_horse === true,
      horseProfile: p.horse_profile,
      occupancyId: p.occupancy_id ?? null,
    }));
}

/**
 * Settlement's one line: the captured hand, the roster it was dealt to, the
 * table. Null when the engine has no table row yet (nothing to say about).
 */
export function buildTableTalkInput(
  snap: TalkHandSnapshot,
  players: readonly SeatedPlayer[],
  tableInfo: TableInfo | null
): TableTalkInput | null {
  if (!tableInfo) return null;
  return {
    table: talkTableFrom(tableInfo, isTournamentInfo(tableInfo)),
    handNumber: snap.handNumber,
    potSize: snap.potSize,
    communityCards: snap.communityCards,
    winners: snap.winners,
    showdownResults: snap.showdownResults,
    seated: talkSeatsFrom(players),
  };
}

/**
 * The dealing loop's one line, from the seat_taken announcement: who arrived,
 * who is seated now, the last hand number this table dealt.
 */
export function buildArrivalInput(
  arrived: SeatedPlayer,
  seated: readonly SeatedPlayer[],
  tableInfo: TableInfo | null,
  handNumber: number,
  isTournament: boolean
): ArrivalInput | null {
  if (!tableInfo) return null;
  return {
    table: talkTableFrom(tableInfo, isTournament || isTournamentInfo(tableInfo)),
    handNumber,
    arrivedUserId: arrived.user_id,
    arrivedSeat: arrived.seat_number,
    seated: talkSeatsFrom(seated),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WHERE A HORSE MAY SPEAK AT ALL: the rules the chat RLS would apply to a person
// ═══════════════════════════════════════════════════════════════════════════════

export type TableRefusal = 'ban_chat' | 'tournament' | 'diamond_cash' | 'heads_up';

/**
 * The service role bypasses RLS, so the server honours here what
 * table_chat_insert would refuse a human: the table's ban_chat, a tournament
 * table (its own ban_chat lives on the tournament row and chat is a cash
 * feature on the client, TablePage socialFeaturesAllowed), and heads-up tables
 * (max_players <= 2, the same client rule). Diamond cash is skipped like every
 * other horse-only settlement step.
 */
export function tableRefusal(table: TalkTable): TableRefusal | null {
  if (table.isTournament) return 'tournament';
  if (table.isDiamondCash) return 'diamond_cash';
  if (table.banChat) return 'ban_chat';
  if (!(table.maxPlayers > 2)) return 'heads_up';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTS AND EVENTS: pure, from the snapshot alone
// ═══════════════════════════════════════════════════════════════════════════════

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface TalkFacts {
  potBB?: number;
  street?: Street;
  hand?: string;
  seat?: number;
}

export interface TalkCandidate {
  event: TalkEvent;
  speakerId: string;
  facts: TalkFacts;
}

export function streetOf(communityCardCount: number): Street | undefined {
  switch (communityCardCount) {
    case 0:
      return 'preflop';
    case 3:
      return 'flop';
    case 4:
      return 'turn';
    case 5:
      return 'river';
    default:
      return undefined;
  }
}

/** The hand name the engine showed, in the chat register: letters and spaces only. */
export function handWord(handName: string): string | undefined {
  const word = handName
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return word.length > 0 ? word : undefined;
}

/**
 * Every (event, horse) that qualifies on this hand, in the event order the
 * speaker is chosen by: a won pot first, then the horse's own showdown loss,
 * then somebody else's big hand. Facts are attached here so the chooser needs
 * nothing but the candidate.
 */
export function detectEvents(input: TableTalkInput): TalkCandidate[] {
  const out: TalkCandidate[] = [];
  const horses = input.seated.filter((s) => s.isHorse);
  if (horses.length === 0) return out;
  const potBB =
    input.table.bigBlind > 0 && Number.isFinite(input.potSize)
      ? Math.round(input.potSize / input.table.bigBlind)
      : undefined;
  const street = streetOf(input.communityCards.length);
  const winnerIds = new Set(input.winners.map((w) => w.userId));
  const seatOf = (userId: string): number | undefined =>
    input.seated.find((s) => s.userId === userId)?.seat;
  // A hand is "shown" only when its showdown record is unmucked. A fold-win
  // may carry an evaluated hand on the winner record; that was never seen.
  const shown = input.showdownResults.filter((r) => r.mucked !== true);
  const shownBy = (userId: string) => shown.find((r) => r.userId === userId);

  // A. big pot won
  if (potBB !== undefined && potBB >= BIG_POT_BB) {
    for (const h of horses) {
      if (!winnerIds.has(h.userId)) continue;
      out.push({ event: 'big_pot_won', speakerId: h.userId, facts: { potBB, street } });
    }
  }

  // The best hand a winner showed, if any: the seat the losers refer to.
  let bestShownWinner: { userId: string; ranking: number; hand: string } | undefined;
  for (const w of input.winners) {
    const r = shownBy(w.userId);
    if (!r) continue;
    const hand = handWord(r.handName);
    if (!hand) continue;
    if (!bestShownWinner || r.handRanking > bestShownWinner.ranking) {
      bestShownWinner = { userId: w.userId, ranking: r.handRanking, hand };
    }
  }

  // B. showdown loss with two pair or better
  for (const r of shown) {
    if (winnerIds.has(r.userId)) continue;
    if (!(r.handRanking >= HAND_RANKINGS.TWO_PAIR)) continue;
    if (!horses.some((h) => h.userId === r.userId)) continue;
    const hand = handWord(r.handName);
    if (!hand) continue;
    out.push({
      event: 'showdown_loss',
      speakerId: r.userId,
      facts: { hand, street, seat: bestShownWinner ? seatOf(bestShownWinner.userId) : undefined },
    });
  }

  // C. a winner showed a full house or better; a non-winning horse remarks
  if (bestShownWinner && bestShownWinner.ranking >= HAND_RANKINGS.FULL_HOUSE) {
    const seat = seatOf(bestShownWinner.userId);
    for (const h of horses) {
      if (winnerIds.has(h.userId)) continue;
      out.push({
        event: 'big_hand_shown',
        speakerId: h.userId,
        facts: { hand: bestShownWinner.hand, seat, street },
      });
    }
  }
  return out;
}

const EVENT_ORDER: readonly TalkEvent[] = [
  'big_pot_won',
  'showdown_loss',
  'big_hand_shown',
  'arrival',
];

/**
 * One candidate per hand: the first event in order that has any, and among
 * its horses the one the (table, hand, event) hash points at. Deterministic,
 * so a replayed hand picks the same speaker.
 */
export function pickCandidate(
  candidates: readonly TalkCandidate[],
  tableId: string,
  handNumber: number
): TalkCandidate | null {
  for (const event of EVENT_ORDER) {
    const pool = candidates
      .filter((c) => c.event === event)
      .sort((a, b) => a.speakerId.localeCompare(b.speakerId));
    if (pool.length === 0) continue;
    return pool[personaHash(`${tableId}|${handNumber}|${event}`) % pool.length];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE AND LINE: pure
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The voice is the dial the seat already carries, read through the same
 * boundary every decision reads it (resolveHorseStyle, legacy aliases and the
 * deterministic fallback included). No extra read.
 */
export function voiceFor(horseProfile: unknown, horseId: string): TalkVoice {
  const { style } = resolveHorseStyle(horseProfile, horseId);
  switch (style) {
    case 'grinder':
    case 'tag':
      return 'quiet';
    case 'lag':
    case 'tricky':
      return 'needler';
    default:
      return 'friendly';
  }
}

/** The pool index the hash points at for this (horse, hand, event). */
export function lineIndexFor(
  horseId: string,
  handNumber: number,
  event: TalkEvent,
  poolSize: number
): number {
  if (!(poolSize > 0)) return 0;
  return personaHash(`${horseId}|${Math.max(0, Math.floor(handNumber))}|${event}`) % poolSize;
}

function factValue(key: string, facts: TalkFacts): string | undefined {
  switch (key) {
    case 'potBB':
      return facts.potBB !== undefined && Number.isFinite(facts.potBB)
        ? String(Math.round(facts.potBB))
        : undefined;
    case 'street':
      return facts.street;
    case 'hand':
      return facts.hand;
    case 'seat':
      return facts.seat !== undefined && Number.isFinite(facts.seat)
        ? String(Math.round(facts.seat))
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Fill a template from the facts. Null when a placeholder has no fact: a
 * line is never written with a hole in it or with a guessed value.
 */
export function fillLine(template: string, facts: TalkFacts): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = factValue(key, facts);
    if (v === undefined) {
      missing = true;
      return '';
    }
    return v;
  });
  return missing ? null : out;
}

export interface ChosenLine {
  template: string;
  line: string;
}

/**
 * The line for this (event, voice, horse, hand): the hash picks the start,
 * and the first template from there that the facts can fill is the line. No
 * randomness; the same inputs give the same line.
 */
export function chooseLine(
  event: TalkEvent,
  voice: TalkVoice,
  horseId: string,
  handNumber: number,
  facts: TalkFacts
): ChosenLine | null {
  const pool = LINES[event][voice].lines;
  if (pool.length === 0) return null;
  const start = lineIndexFor(horseId, handNumber, event, pool.length);
  for (let k = 0; k < pool.length; k++) {
    const template = pool[(start + k) % pool.length];
    const line = fillLine(template, facts);
    if (line !== null) return { template, line };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE ONE DOOR EVERY LINE PASSES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Figure dash, en dash, em dash, horizontal bar: the four characters Dan
 * banned on 2026-08-20. Built from their code points so this file holds none
 * of them, the same move tests/a-banned-character-must-not-reach-the-database
 * makes.
 */
const BANNED_DASH = new RegExp(
  '[' + [0x2012, 0x2013, 0x2014, 0x2015].map((c) => String.fromCodePoint(c)).join('') + ']'
);

/**
 * Unicode Emoji_Presentation plus U+FE0F, the ranges scripts/ci/check-no-emoji.mjs
 * enforces on the client. The gate walks src/ only, so the server's chat line
 * carries its own copy of the rule.
 */
const EMOJI = new RegExp(
  '[' +
    '\\u231A\\u231B' +
    '\\u23E9-\\u23EC\\u23F0\\u23F3' +
    '\\u25FD\\u25FE' +
    '\\u2614\\u2615' +
    '\\u2648-\\u2653' +
    '\\u267F\\u2693\\u26A1\\u26AA\\u26AB' +
    '\\u26BD\\u26BE\\u26C4\\u26C5\\u26CE\\u26D4\\u26EA' +
    '\\u26F2\\u26F3\\u26F5\\u26FA\\u26FD' +
    '\\u2705\\u270A\\u270B\\u2728\\u274C\\u274E' +
    '\\u2753-\\u2755\\u2757\\u2795-\\u2797\\u27B0\\u27BF' +
    '\\u2B1B\\u2B1C\\u2B50\\u2B55' +
    '\\uFE0F' +
    '\\u{1F000}-\\u{1FAFF}' +
    ']',
  'u'
);

export type SanitizeRefusal =
  | 'empty'
  | 'too_long'
  | 'dash'
  | 'emoji'
  | 'at_sign'
  | 'placeholder'
  | 'names_a_player';

export type SanitizeVerdict = { ok: true; line: string } | { ok: false; reason: SanitizeRefusal };

/** The words of a line, for the username rule: split on anything that is not a word character. */
function tokensOf(line: string): string[] {
  return line
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

/**
 * Refuses, with a named reason, any line that could not have come from the
 * approved pool filled with engine facts: a banned dash, an emoji, an at sign,
 * a placeholder left unfilled, a line longer than the cap, or ANY token equal
 * to a seated player's username, case-insensitively, so a template bug can
 * never name a person. Production skips a refused line; the law test fails on
 * one.
 */
export function sanitizeLine(
  line: string,
  usernames: readonly (string | null | undefined)[]
): SanitizeVerdict {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > TALK_LINE_MAX_CHARS) return { ok: false, reason: 'too_long' };
  if (BANNED_DASH.test(trimmed)) return { ok: false, reason: 'dash' };
  if (EMOJI.test(trimmed)) return { ok: false, reason: 'emoji' };
  if (trimmed.includes('@')) return { ok: false, reason: 'at_sign' };
  if (/\{[^}]*\}/.test(trimmed)) return { ok: false, reason: 'placeholder' };
  const names = new Set(
    usernames
      .filter((u): u is string => typeof u === 'string')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0)
  );
  if (names.size > 0) {
    // Word tokens, and whole whitespace-delimited chunks with their outer
    // punctuation removed, so "dan_b", "dan.b" and "dan-b" are all caught.
    const chunks = trimmed
      .toLowerCase()
      .split(/\s+/)
      .map((c) => c.replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, ''));
    for (const token of [...tokensOf(trimmed), ...chunks]) {
      if (names.has(token)) return { ok: false, reason: 'names_a_player' };
    }
  }
  return { ok: true, line: trimmed };
}

/**
 * The identity of a phrase for the reuse rules: the TEMPLATE, lowercased,
 * punctuation and placeholder braces dropped, whitespace collapsed, digit runs
 * folded to `n`. "nice pot, {potBB} bb, gg" and "nice pot, 52 bb, gg" are the
 * same phrase; a horse that said it this morning does not say it tonight.
 */
export function normalizePhrase(line: string): string {
  return line
    .toLowerCase()
    .replace(/\d+/g, 'n')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THIS PROCESS REMEMBERS: hands seated, and its own claims (fast path only)
// ═══════════════════════════════════════════════════════════════════════════════

interface SeatMemory {
  occupancyId: string | null;
  handsSeenAtArrival: number;
}

export interface TableMemory {
  /** Settled hands this process has seen at this table (a COUNT, not a number). */
  handsSeen: number;
  lastHandNumber: number | null;
  lastSeenAt: number;
  seated: Map<string, SeatMemory>;
  /** handsSeen at this process's last successful claim at this table. */
  lastLineHandsSeen: number | null;
  /** horseId -> handsSeen at that horse's last successful claim here. */
  lastLineByHorse: Map<string, number>;
}

const tables = new Map<string, TableMemory>();
/** horseId -> said_at (ms) of this process's successful claims, pruned to the hour. */
const claimsByHorse = new Map<string, number[]>();

const TABLE_MEMORY_MAX = 4_000;
const TABLE_MEMORY_IDLE_MS = 2 * HOUR_MS;

function tableMemory(tableId: string, now: number): TableMemory {
  let mem = tables.get(tableId);
  if (!mem) {
    if (tables.size >= TABLE_MEMORY_MAX) {
      for (const [id, m] of tables)
        if (now - m.lastSeenAt > TABLE_MEMORY_IDLE_MS) tables.delete(id);
    }
    mem = {
      handsSeen: 0,
      lastHandNumber: null,
      lastSeenAt: now,
      seated: new Map(),
      lastLineHandsSeen: null,
      lastLineByHorse: new Map(),
    };
    tables.set(tableId, mem);
  }
  mem.lastSeenAt = now;
  return mem;
}

/**
 * Count the hand once (settlement and an arrival at the next loop top carry
 * the same number) and keep the roster: who is seated, since which count. A
 * player first seen at a settlement was dealt that hand, so their count
 * starts one earlier than a player first seen at the seat_taken announcement,
 * who has not been dealt anything yet. A seat that changed occupancy is a new
 * stay; a player no longer seated is forgotten, so a return starts again.
 */
function noteHand(
  mem: TableMemory,
  handNumber: number,
  seated: readonly TalkSeat[],
  dealtThisHand: boolean
): void {
  if (mem.lastHandNumber !== handNumber) {
    mem.lastHandNumber = handNumber;
    mem.handsSeen++;
  }
  const present = new Set(seated.map((s) => s.userId));
  for (const id of [...mem.seated.keys()]) if (!present.has(id)) mem.seated.delete(id);
  const since = dealtThisHand ? mem.handsSeen - 1 : mem.handsSeen;
  for (const s of seated) {
    const cur = mem.seated.get(s.userId);
    const occupancyId = s.occupancyId ?? null;
    if (!cur || (occupancyId && cur.occupancyId && cur.occupancyId !== occupancyId)) {
      mem.seated.set(s.userId, { occupancyId, handsSeenAtArrival: since });
    }
  }
}

function handsSeated(mem: TableMemory, userId: string): number {
  const seat = mem.seated.get(userId);
  return seat ? mem.handsSeen - seat.handsSeenAtArrival : 0;
}

function recentClaims(horseId: string, now: number): number[] {
  const kept = (claimsByHorse.get(horseId) ?? []).filter((t) => now - t < HOUR_MS);
  if (kept.length === 0) claimsByHorse.delete(horseId);
  else claimsByHorse.set(horseId, kept);
  return kept;
}

function rememberClaim(mem: TableMemory, horseId: string, now: number): void {
  mem.lastLineHandsSeen = mem.handsSeen;
  mem.lastLineByHorse.set(horseId, mem.handsSeen);
  claimsByHorse.set(horseId, [...recentClaims(horseId, now), now]);
}

/** A template the sanitizer refused is reported once per process, not per hand. */
const reportedTemplates = new Set<string>();

/** Test hook: forget every table and every claim this process remembers. */
export function _resetTableTalkForTests(): void {
  tables.clear();
  claimsByHorse.clear();
  reportedTemplates.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE CLAIM: reads, then one INSERT, no retry
// ═══════════════════════════════════════════════════════════════════════════════

export type ClaimRefusal =
  | 'hourly_cap'
  | 'horse_too_soon'
  | 'table_too_soon'
  | 'phrase_horse_24h'
  | 'phrase_table_2h'
  | 'silenced'
  | 'hand_taken'
  | 'unreadable'
  | 'unwritable';

export type ClaimVerdict = { ok: true } | { ok: false; reason: ClaimRefusal };

export interface ClaimRequest {
  tableId: string;
  handNumber: number;
  horseId: string;
  event: TalkEvent;
  voice: TalkVoice;
  phraseNorm: string;
  now: number;
}

interface LedgerRow {
  table_id?: string;
  horse_id?: string;
  hand_number: number | string;
  phrase_norm: string;
  said_at: string;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const ms = (iso: string): number => Date.parse(iso);

/**
 * The owner's limits, as reads before the insert, then the insert. A unique
 * conflict on (table_id, hand_number) is silence; nothing here retries. An
 * unreadable ledger is a "no", named.
 */
export async function claimLine(req: ClaimRequest, mem?: TableMemory): Promise<ClaimVerdict> {
  const { tableId, handNumber, horseId, now } = req;

  // Fast path: this process's own recent claims, no read.
  if (mem) {
    if (
      mem.lastLineHandsSeen !== null &&
      mem.handsSeen - mem.lastLineHandsSeen < TABLE_MIN_HANDS_BETWEEN_LINES
    ) {
      return { ok: false, reason: 'table_too_soon' };
    }
    const horseLast = mem.lastLineByHorse.get(horseId);
    if (horseLast !== undefined && mem.handsSeen - horseLast < HORSE_MIN_HANDS_BETWEEN_LINES) {
      return { ok: false, reason: 'horse_too_soon' };
    }
  }
  if (recentClaims(horseId, now).length >= HORSE_LINES_PER_HOUR) {
    return { ok: false, reason: 'hourly_cap' };
  }

  // The ledger: this horse's last day, and this table's newest lines.
  const [byHorse, byTable] = await Promise.all([
    supabase
      .from('horse_table_talk_ledger')
      .select('table_id, hand_number, phrase_norm, said_at')
      .eq('horse_id', horseId)
      .gte('said_at', new Date(now - PHRASE_HORSE_WINDOW_MS).toISOString())
      .order('said_at', { ascending: false })
      .limit(64),
    supabase
      .from('horse_table_talk_ledger')
      .select('horse_id, hand_number, phrase_norm, said_at')
      .eq('table_id', tableId)
      .order('said_at', { ascending: false })
      .limit(32),
  ]);
  if (byHorse.error || byTable.error) {
    reportError(
      new Error((byHorse.error ?? byTable.error)?.message ?? 'ledger read failed'),
      'HorseTableTalk.ledger_read',
      { tableId, horseId }
    );
    return { ok: false, reason: 'unreadable' };
  }
  const horseRows = (byHorse.data ?? []) as LedgerRow[];
  const tableRows = (byTable.data ?? []) as LedgerRow[];

  if (horseRows.filter((r) => now - ms(r.said_at) < HOUR_MS).length >= HORSE_LINES_PER_HOUR) {
    return { ok: false, reason: 'hourly_cap' };
  }
  if (horseRows.some((r) => r.phrase_norm === req.phraseNorm)) {
    return { ok: false, reason: 'phrase_horse_24h' };
  }
  if (
    tableRows.some(
      (r) => r.phrase_norm === req.phraseNorm && now - ms(r.said_at) < PHRASE_TABLE_WINDOW_MS
    )
  ) {
    return { ok: false, reason: 'phrase_table_2h' };
  }

  // Hands between lines, counted at THIS table (hand numbers are global).
  const tableLast = tableRows.length > 0 ? num(tableRows[0].hand_number) : undefined;
  const horseHere = [
    ...tableRows.filter((r) => r.horse_id === horseId),
    ...horseRows.filter((r) => r.table_id === tableId),
  ]
    .map((r) => num(r.hand_number))
    .filter((n) => Number.isFinite(n));
  const horseLast = horseHere.length > 0 ? Math.max(...horseHere) : undefined;
  if (tableLast !== undefined && tableLast >= handNumber) {
    return { ok: false, reason: 'table_too_soon' };
  }
  if (tableLast !== undefined || horseLast !== undefined) {
    const since = Math.min(tableLast ?? Infinity, horseLast ?? Infinity);
    const dealt = await supabase
      .from('hand_history')
      .select('hand_number')
      .eq('table_id', tableId)
      .gt('hand_number', since)
      .lt('hand_number', handNumber)
      .order('hand_number', { ascending: false })
      .limit(16);
    if (dealt.error) {
      reportError(new Error(dealt.error.message), 'HorseTableTalk.hands_read', { tableId });
      return { ok: false, reason: 'unreadable' };
    }
    const between = ((dealt.data ?? []) as Array<{ hand_number: number | string }>).map((r) =>
      num(r.hand_number)
    );
    // This hand itself counts as one dealt since any earlier line.
    if (tableLast !== undefined) {
      const sinceTable = 1 + between.filter((n) => n > tableLast).length;
      if (sinceTable < TABLE_MIN_HANDS_BETWEEN_LINES)
        return { ok: false, reason: 'table_too_soon' };
    }
    if (horseLast !== undefined) {
      const sinceHorse = 1 + between.filter((n) => n > horseLast).length;
      if (sinceHorse < HORSE_MIN_HANDS_BETWEEN_LINES)
        return { ok: false, reason: 'horse_too_soon' };
    }
  }

  // The horse's own unexpired mute at this table: what fn_table_chat_is_silenced
  // would answer for a person, which the service role cannot ask.
  const mute = await supabase
    .from('table_chat_mutes')
    .select('id')
    .eq('table_id', tableId)
    .eq('user_id', horseId)
    .gt('expires_at', new Date(now).toISOString())
    .limit(1);
  if (mute.error) {
    reportError(new Error(mute.error.message), 'HorseTableTalk.mute_read', { tableId, horseId });
    return { ok: false, reason: 'unreadable' };
  }
  if ((mute.data ?? []).length > 0) return { ok: false, reason: 'silenced' };

  // The claim. One INSERT; a conflict on (table_id, hand_number) is silence.
  const { error } = await supabase.from('horse_table_talk_ledger').insert({
    table_id: tableId,
    hand_number: handNumber,
    horse_id: horseId,
    event: req.event,
    voice: req.voice,
    phrase_norm: req.phraseNorm,
  });
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'hand_taken' };
    reportError(new Error(error.message), 'HorseTableTalk.ledger_insert', { tableId, horseId });
    return { ok: false, reason: 'unwritable' };
  }
  if (mem) rememberClaim(mem, horseId, now);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE CHAT ROW: exactly what the browser writes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The one write a player can see. The same four columns useTableChat.ts
 * inserts, and no other: no display_name, no avatar_url, no marker of any
 * kind, so the row is indistinguishable from a human's line.
 */
export async function writeChatRow(
  tableId: string,
  horseId: string,
  line: string
): Promise<boolean> {
  const { error } = await supabase.from('table_chat').insert({
    table_id: tableId,
    user_id: horseId,
    message: line,
    message_type: 'player',
  });
  if (error) {
    reportError(new Error(error.message), 'HorseTableTalk.chat_insert', { tableId, horseId });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAYING IT
// ═══════════════════════════════════════════════════════════════════════════════

export type TalkOutcome =
  | 'spoken'
  | 'lost_words'
  | 'no_line'
  | 'unsafe_line'
  | ClaimRefusal
  | TableRefusal
  | 'gate_closed'
  | 'no_event'
  | 'no_speaker';

interface SayRequest {
  table: TalkTable;
  handNumber: number;
  mem: TableMemory;
  speaker: TalkSeat;
  event: TalkEvent;
  facts: TalkFacts;
  usernames: readonly (string | null | undefined)[];
  now: number;
}

async function say(req: SayRequest): Promise<TalkOutcome> {
  const voice = voiceFor(req.speaker.horseProfile, req.speaker.userId);
  const chosen = chooseLine(req.event, voice, req.speaker.userId, req.handNumber, req.facts);
  if (!chosen) return 'no_line';
  const verdict = sanitizeLine(chosen.line, req.usernames);
  if (!verdict.ok) {
    if (!reportedTemplates.has(chosen.template)) {
      reportedTemplates.add(chosen.template);
      reportError(
        new Error(`table talk line refused (${verdict.reason})`),
        'HorseTableTalk.unsafe_line',
        { event: req.event, voice }
      );
    }
    return 'unsafe_line';
  }
  const claim = await claimLine(
    {
      tableId: req.table.tableId,
      handNumber: req.handNumber,
      horseId: req.speaker.userId,
      event: req.event,
      voice,
      phraseNorm: normalizePhrase(chosen.template),
      now: req.now,
    },
    req.mem
  );
  if (!claim.ok) return claim.reason;
  const wrote = await writeChatRow(req.table.tableId, req.speaker.userId, verdict.line);
  return wrote ? 'spoken' : 'lost_words';
}

/**
 * After a settled cash hand. Fire-and-forget: settlement calls this with
 * `void` and never waits. The roster bookkeeping is memory only and runs
 * whatever the gate says; with no qualifying event nothing is read; with the
 * gate closed, the gate's cached read is the only work.
 */
export const speakAtTheFelt = bindToProcessRoot(
  async (input: TableTalkInput | null): Promise<TalkOutcome> => {
    if (!input) return 'no_event';
    const now = Date.now();
    try {
      const mem = tableMemory(input.table.tableId, now);
      noteHand(mem, input.handNumber, input.seated, true);
      const refusal = tableRefusal(input.table);
      if (refusal) return refusal;
      const pick = pickCandidate(detectEvents(input), input.table.tableId, input.handNumber);
      if (!pick) return 'no_event';
      const gate = await readTableTalkGate(now);
      if (!gate.allowed) return 'gate_closed';
      const speaker = input.seated.find((s) => s.userId === pick.speakerId);
      if (!speaker) return 'no_speaker';
      return await say({
        table: input.table,
        handNumber: input.handNumber,
        mem,
        speaker,
        event: pick.event,
        facts: pick.facts,
        usernames: input.seated.map((s) => s.username),
        now,
      });
    } catch (err) {
      reportError(err, 'HorseTableTalk.speakAtTheFelt', { tableId: input.table.tableId });
      return 'unwritable';
    }
  }
);

/**
 * A player sat down (the dealing loop's seat_taken, human or horse alike). A
 * horse seated ten hands or more at this table may greet them; the arrival
 * itself never speaks. Same gate, same claim, same door.
 */
export const greetArrival = bindToProcessRoot(
  async (input: ArrivalInput | null): Promise<TalkOutcome> => {
    if (!input) return 'no_event';
    const now = Date.now();
    try {
      const mem = tableMemory(input.table.tableId, now);
      noteHand(mem, input.handNumber, input.seated, false);
      const refusal = tableRefusal(input.table);
      if (refusal) return refusal;
      const greeters = input.seated
        .filter(
          (s) =>
            s.isHorse &&
            s.userId !== input.arrivedUserId &&
            handsSeated(mem, s.userId) >= GREETER_MIN_HANDS_SEATED
        )
        .sort((a, b) => a.userId.localeCompare(b.userId));
      if (greeters.length === 0) return 'no_speaker';
      const gate = await readTableTalkGate(now);
      if (!gate.allowed) return 'gate_closed';
      const speaker =
        greeters[
          personaHash(`${input.table.tableId}|${input.handNumber}|arrival`) % greeters.length
        ];
      return await say({
        table: input.table,
        handNumber: input.handNumber,
        mem,
        speaker,
        event: 'arrival',
        facts: { seat: input.arrivedSeat },
        usernames: input.seated.map((s) => s.username),
        now,
      });
    } catch (err) {
      reportError(err, 'HorseTableTalk.greetArrival', { tableId: input.table.tableId });
      return 'unwritable';
    }
  }
);
