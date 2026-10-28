/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE TABLE GESTURES: throwables and reactions from a seated horse
 * (Dan 2026-10-21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "HORSES SHOULD SOMETIMES THROW SOME EMOJI'S AT PLAYERS THAT
 * BEAT THEM IN A HAND, OR BEFORE THEY GO ALL IN CLICK OR SEND THE GOOD LUCK
 * EMOJI. MAKE IT SEEM LIKE MORE HUMAN LIKE, CURRENTLY THEY NEVER THROW
 * ANYTHING AT ALL EVER" and then "not always just the good luck, and not every
 * time before going all in. it needs to be random and feel genuine and not
 * like a bot or ai player."
 *
 * A horse throws EXACTLY the way a person does, so no client can tell the two
 * apart (CLAUDE.md 10.5, horses are players):
 *
 *   1. The throw is charged through the person's own RPC, fn_use_throwable_v2,
 *      by way of fn_horse_use_throwable, which only binds the horse's own id
 *      as the caller. Same allowance, same cooldown, same receipts.
 *   2. The throw is broadcast as the same `[THROW:<id>:<seat>]` CHAT payload a
 *      browser sends on the table's realtime channel, with the receipt id as
 *      throwId, from the horse's own user id. A reaction is the same
 *      `[REACTION:<glyph>:<own seat>]` payload TableReactions sends.
 *
 * WHEN, and only sometimes:
 *
 *   lost        a horse lost at showdown; it may throw at the winner
 *   won         a horse won a showdown; it may throw at someone it beat
 *   all_in      a horse is moving all in; it may say good luck in chat, throw
 *               something lucky at the player it faces, or send a reaction
 *
 * Each moment rolls a hash of (table, hand, moment, horse) against
 * GESTURE_CHANCE_PCT, picks the item from a voice-shaped pool (the same dial
 * table talk reads), and waits a human beat (horsePacing.ts) before acting.
 * Process limits keep it rare: a horse throws at most HORSE_GESTURES_PER_HOUR
 * times an hour, and a table sees a gesture at most once per
 * TABLE_GESTURE_SPACING_MS.
 *
 * Gated by horse_post_modes 'table_gestures' and content_settings, the same
 * 30 second fail-closed switch as table talk. Fire-and-forget: never awaited
 * by the hand, never throws, nothing retries.
 *
 * NEVER refer to the horses as "bots": they are HORSES only.
 */

import { randomUUID } from 'node:crypto';
import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { bindToProcessRoot } from './supabase/dataActorContext.js';
import { personaHash } from '../engine/HorsePersona.js';
import { readHorsePostModeGate, TABLE_GESTURES_MODE } from './HorseTableTalkGate.js';
import { humanBeat, humanBeatMs } from './horsePacing.js';
import { personalPool, personalThrowChance } from './horseVoiceStyle.js';
import type { SeatedPlayer, TableInfo } from '../types.js';
import {
  hasAudience,
  speakAsTheyShove,
  speaksThisTime,
  tableRefusal,
  talkSeatsFrom,
  talkTableFrom,
  voiceFor,
  type TableTalkInput,
  type TalkSeat,
  type TalkTable,
  type TalkVoice,
} from './HorseTableTalk.js';

export type GestureMoment = 'lost' | 'won' | 'all_in';

/** How often a qualifying horse makes a gesture at all, in percent. */
export const GESTURE_CHANCE_PCT: Readonly<Record<GestureMoment, number>> = {
  lost: 30,
  won: 18,
  all_in: 30,
};

/** At most this many throws or reactions per horse per rolling hour. */
export const HORSE_GESTURES_PER_HOUR = 4;
/** A table sees at most one horse gesture per this window. */
export const TABLE_GESTURE_SPACING_MS = 30_000;

/**
 * What a horse throws, by moment and voice. Every id is in the live catalog
 * (src/services/ThrowableService.ts); GESTURE_ITEM_IDS is checked against it
 * by the test.
 */
export const THROW_POOLS: Record<GestureMoment, Record<TalkVoice, readonly string[]>> = {
  // thrown at the player who just beat the horse
  lost: {
    needler: [
      'tomato',
      'cracked_egg',
      'fish',
      'donkey',
      'poop',
      'thumbs_down',
      'angry_emoji',
      'rat_card',
      'banana_peel',
      'snowball',
      'water_gun',
      'boxing_glove',
    ],
    friendly: [
      'thumbs_up',
      'crown',
      'standing_ovation',
      'heart',
      'star',
      'beer',
      'trophy',
      'tomato',
    ],
    quiet: [
      'facepalm',
      'crying_emoji',
      'thinking',
      'surrender',
      'loser_hand',
      'screaming',
      'tilt_meter',
      'cracked_egg',
    ],
  },
  // thrown at a player the horse just beat
  won: {
    needler: [
      'laughing_emoji',
      'ok_smug',
      'cool_sunglasses_emoji',
      'fish',
      'bad_beat_bandage',
      'sleeping',
      'donkey',
    ],
    friendly: ['heart', 'beer', 'thumbs_up', 'rose', 'cake', 'bad_beat_bandage'],
    quiet: ['blush', 'thumbs_up', 'coffee', 'ok_smug'],
  },
  // thrown at the player the horse is moving in against
  all_in: {
    needler: ['rocket', 'lightning_bolt', 'cool_sunglasses_emoji', 'dice', 'magic_8_ball', 'bomb'],
    friendly: ['horseshoe', 'rose', 'heart', 'thumbs_up', 'star', 'magic_8_ball'],
    quiet: ['horseshoe', 'dice', 'thinking', 'magic_8_ball'],
  },
};

export const GESTURE_ITEM_IDS: readonly string[] = [
  ...new Set(
    Object.values(THROW_POOLS).flatMap((byVoice) => Object.values(byVoice).flatMap((p) => p))
  ),
];

/**
 * The quick reactions TableReactions offers (Lucky, Clap, Fire), as code
 * points so this file holds no glyph. Lucky is the good luck one and is the
 * most common, never the only one.
 */
const REACTION_LUCKY = String.fromCodePoint(0x2663);
const REACTION_CLAP = String.fromCodePoint(0x2605);
const REACTION_FIRE = String.fromCodePoint(0x25b2);
export const ALL_IN_REACTIONS: readonly string[] = [
  REACTION_LUCKY,
  REACTION_LUCKY,
  REACTION_LUCKY,
  REACTION_CLAP,
  REACTION_FIRE,
];

// The person's existing quick-reaction glyphs, chosen for the result.
const LOST_REACTIONS = [REACTION_CLAP, String.fromCodePoint(0x2716), String.fromCodePoint(0x2726)];
const WON_REACTIONS = [REACTION_FIRE, REACTION_CLAP, String.fromCodePoint(0x25c6)];

// ═══════════════════════════════════════════════════════════════════════════════
// PURE CHOICES
// ═══════════════════════════════════════════════════════════════════════════════

export function rollsGesture(
  moment: GestureMoment,
  horseId: string,
  tableId: string,
  handNumber: number
): boolean {
  return (
    personaHash(`${tableId}|${handNumber}|${moment}|${horseId}|gesture`) % 100 <
    personalThrowChance(horseId, GESTURE_CHANCE_PCT[moment])
  );
}

export function pickItem(
  moment: GestureMoment,
  voice: TalkVoice,
  horseId: string,
  handNumber: number
): string {
  // Each horse has its own favourites (Dan 2026-10-22: every horse different).
  const pool = personalPool(horseId, THROW_POOLS[moment][voice]);
  return pool[personaHash(`${horseId}|${handNumber}|${moment}|item`) % pool.length];
}

/** What form an all-in gesture takes: a chat line, a throw, or a reaction. */
export type AllInForm = 'chat' | 'throw' | 'reaction';

export function allInForm(horseId: string, handNumber: number, chatAllowed: boolean): AllInForm {
  const roll = personaHash(`${horseId}|${handNumber}|all_in|form`) % 100;
  if (roll < 40) return chatAllowed ? 'chat' : 'reaction';
  if (roll < 75) return 'throw';
  return 'reaction';
}

export function afterHandForm(horseId: string, handNumber: number): 'throw' | 'reaction' {
  return personaHash(`${horseId}|${handNumber}|after_hand|form`) % 100 < 40 ? 'reaction' : 'throw';
}

export interface GestureCandidate {
  moment: GestureMoment;
  horse: TalkSeat;
  targetSeat: number;
}

/**
 * After a hand: every horse that lost a showdown may throw at the winner, and
 * every horse that won one may throw at a player it beat. One candidate per
 * hand at most, chosen by the (table, hand) hash among the horses that rolled.
 */
export function detectAfterHand(input: TableTalkInput): GestureCandidate | null {
  const winners = new Set(input.winners.map((w) => w.userId));
  const seatOf = (id: string): number | undefined =>
    input.seated.find((s) => s.userId === id)?.seat;
  const seatedHorse = (id: string): TalkSeat | undefined =>
    input.seated.find((s) => s.userId === id && s.isHorse);
  const losers = input.showdownResults.filter((r) => !winners.has(r.userId));
  if (losers.length === 0 || winners.size === 0) return null;
  const winnerSeat = seatOf(input.winners[0].userId);
  const out: GestureCandidate[] = [];
  for (const r of losers) {
    const horse = seatedHorse(r.userId);
    if (!horse || winnerSeat === undefined || winnerSeat === horse.seat) continue;
    if (!rollsGesture('lost', horse.userId, input.table.tableId, input.handNumber)) continue;
    out.push({ moment: 'lost', horse, targetSeat: winnerSeat });
  }
  for (const w of input.winners) {
    const horse = seatedHorse(w.userId);
    if (!horse) continue;
    if (!rollsGesture('won', horse.userId, input.table.tableId, input.handNumber)) continue;
    const beaten = losers
      .map((r) => seatOf(r.userId))
      .filter((s): s is number => s !== undefined && s !== horse.seat);
    if (beaten.length === 0) continue;
    const targetSeat =
      beaten[personaHash(`${horse.userId}|${input.handNumber}|won|target`) % beaten.length];
    out.push({ moment: 'won', horse, targetSeat });
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a.horse.userId.localeCompare(b.horse.userId));
  return out[personaHash(`${input.table.tableId}|${input.handNumber}|gesture`) % out.length];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS LIMITS
// ═══════════════════════════════════════════════════════════════════════════════

const HOUR_MS = 60 * 60_000;
const byHorse = new Map<string, number[]>();
const byTable = new Map<string, number>();

function withinLimits(tableId: string, horseId: string, now: number): boolean {
  const last = byTable.get(tableId);
  if (last !== undefined && now - last < TABLE_GESTURE_SPACING_MS) return false;
  const recent = (byHorse.get(horseId) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length === 0) byHorse.delete(horseId);
  else byHorse.set(horseId, recent);
  return recent.length < HORSE_GESTURES_PER_HOUR;
}

function noteGesture(tableId: string, horseId: string, now: number): void {
  byTable.set(tableId, now);
  byHorse.set(horseId, [...(byHorse.get(horseId) ?? []), now]);
  if (byTable.size > 4_000) {
    for (const [id, t] of byTable) if (now - t > HOUR_MS) byTable.delete(id);
  }
}

/** Test hook. */
export function _resetGesturesForTests(): void {
  byHorse.clear();
  byTable.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE WIRE: exactly what a browser sends
// ═══════════════════════════════════════════════════════════════════════════════

async function broadcastChat(
  tableId: string,
  horseId: string,
  message: string,
  throwId?: string
): Promise<boolean> {
  let channel: ReturnType<typeof supabase.channel> | undefined;
  try {
    channel = supabase.channel(`table:${tableId}`);
    const receipt = await channel.httpSend('game_event', {
      type: 'CHAT',
      payload: { message, ...(throwId ? { throwId } : {}) },
      sender: horseId,
      timestamp: Date.now(),
    });
    return receipt.success === true;
  } catch (err) {
    reportError(err, 'HorseTableGestures.broadcast', { tableId });
    return false;
  } finally {
    if (channel) {
      try {
        await supabase.removeChannel(channel);
      } catch {
        /* the channel was never joined; nothing to release */
      }
    }
  }
}

export type GestureOutcome =
  | 'thrown'
  | 'reacted'
  | 'spoken'
  | 'no_gesture'
  | 'no_audience'
  | 'gate_closed'
  | 'limited'
  | 'refused'
  | 'unsent'
  | 'failed';

/** Charge the throw through the person's RPC, then broadcast it. */
export async function throwItem(
  tableId: string,
  horseId: string,
  throwableId: string,
  targetSeat: number
): Promise<GestureOutcome> {
  const requestId = randomUUID();
  const { data, error } = await supabase.rpc('fn_horse_use_throwable', {
    p_horse_id: horseId,
    p_throwable_id: throwableId,
    p_request_id: requestId,
  });
  if (error) {
    reportError(new Error(error.message), 'HorseTableGestures.charge', { tableId });
    return 'failed';
  }
  if ((data as { success?: unknown } | null)?.success !== true) return 'refused';
  const sent = await broadcastChat(
    tableId,
    horseId,
    `[THROW:${throwableId}:${targetSeat}]`,
    requestId
  );
  return sent ? 'thrown' : 'unsent';
}

export async function sendReaction(
  tableId: string,
  horseId: string,
  glyph: string,
  ownSeat: number
): Promise<GestureOutcome> {
  const sent = await broadcastChat(tableId, horseId, `[REACTION:${glyph}:${ownSeat}]`);
  return sent ? 'reacted' : 'unsent';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * After a settled hand, any table type (a person may throw at any table).
 * Fire-and-forget from settlement.
 */
export const gestureAfterHand = bindToProcessRoot(
  async (input: TableTalkInput | null): Promise<GestureOutcome> => {
    if (!input) return 'no_gesture';
    try {
      // A throw is an animation with no history: with nobody watching it is
      // only writes. Measured 2026-10-22: 1,470 horse throws in one hour.
      if (!hasAudience(input.table.tableId)) return 'no_audience';
      const pick = detectAfterHand(input);
      if (!pick) return 'no_gesture';
      const now = Date.now();
      if (!withinLimits(input.table.tableId, pick.horse.userId, now)) return 'limited';
      const gate = await readHorsePostModeGate(TABLE_GESTURES_MODE, now);
      if (!gate.allowed) return 'gate_closed';
      noteGesture(input.table.tableId, pick.horse.userId, now);
      const voice = voiceFor(pick.horse.horseProfile, pick.horse.userId);
      const item = pickItem(pick.moment, voice, pick.horse.userId, input.handNumber);
      await humanBeat(
        humanBeatMs(`${pick.horse.userId}|${input.handNumber}|${pick.moment}`, 'tap')
      );
      // Reactions used to exist only on the uncommon all-in path. Ordinary
      // showdowns should sometimes get the same quick reaction a person taps.
      if (afterHandForm(pick.horse.userId, input.handNumber) === 'reaction') {
        const pool = pick.moment === 'lost' ? LOST_REACTIONS : WON_REACTIONS;
        const glyph =
          pool[
            personaHash(`${pick.horse.userId}|${input.handNumber}|after_hand|glyph`) % pool.length
          ];
        return await sendReaction(input.table.tableId, pick.horse.userId, glyph, pick.horse.seat);
      }
      return await throwItem(input.table.tableId, pick.horse.userId, item, pick.targetSeat);
    } catch (err) {
      reportError(err, 'HorseTableGestures.afterHand', { tableId: input.table.tableId });
      return 'failed';
    }
  }
);

export interface AllInGestureInput {
  table: TalkTable;
  handNumber: number;
  horse: TalkSeat;
  /** The seat the horse is moving in against (the bettor, or an opponent). */
  targetSeat: number | null;
  seated: readonly TalkSeat[];
}

/**
 * A horse is moving all in. Sometimes, never every time, it says good luck,
 * throws something lucky at the player it faces, or taps a reaction.
 */
export const gestureBeforeAllIn = bindToProcessRoot(
  async (input: AllInGestureInput | null): Promise<GestureOutcome> => {
    if (!input) return 'no_gesture';
    try {
      const { table, horse, handNumber } = input;
      if (!hasAudience(table.tableId)) return 'no_audience';
      const form = allInForm(horse.userId, handNumber, tableRefusal(table) === null);
      // Choose the form before its participation roll: a chat-only horse can
      // still speak, while a silent horse never gets chat via its throw habit.
      const participates =
        form === 'chat'
          ? speaksThisTime('all_in', horse.userId, table.tableId, handNumber)
          : rollsGesture('all_in', horse.userId, table.tableId, handNumber);
      if (!participates) return 'no_gesture';
      const now = Date.now();
      if (form === 'chat') {
        // Table talk owns the chat door, its gate and its limits.
        const said = await speakAsTheyShove({ table, handNumber, horse, seated: input.seated });
        return said === 'spoken' ? 'spoken' : 'no_gesture';
      }
      if (!withinLimits(table.tableId, horse.userId, now)) return 'limited';
      const gate = await readHorsePostModeGate(TABLE_GESTURES_MODE, now);
      if (!gate.allowed) return 'gate_closed';
      noteGesture(table.tableId, horse.userId, now);
      await humanBeat(humanBeatMs(`${horse.userId}|${handNumber}|all_in`, 'quick'));
      if (form === 'throw' && input.targetSeat !== null && input.targetSeat !== horse.seat) {
        const voice = voiceFor(horse.horseProfile, horse.userId);
        const item = pickItem('all_in', voice, horse.userId, handNumber);
        return await throwItem(table.tableId, horse.userId, item, input.targetSeat);
      }
      const glyph =
        ALL_IN_REACTIONS[
          personaHash(`${horse.userId}|${handNumber}|reaction`) % ALL_IN_REACTIONS.length
        ];
      return await sendReaction(table.tableId, horse.userId, glyph, horse.seat);
    } catch (err) {
      reportError(err, 'HorseTableGestures.beforeAllIn', { tableId: input.table.tableId });
      return 'failed';
    }
  }
);

/** The slice of the live hand the all-in hook reads. */
export interface AllInHandSeat {
  seat: number;
  user_id: string;
  is_folded?: boolean;
  stack?: number;
}

/**
 * The engine's one line at the moment a horse commits its chips: who it faces
 * (the last aggressor when it is calling or re-shoving into a bet, else an
 * opponent still in the hand), from the authoritative hand state.
 */
export function buildAllInGestureInput(
  tableInfo: TableInfo | null,
  seated: readonly SeatedPlayer[],
  horseUserId: string,
  handNumber: number,
  isTournament: boolean,
  handSeats: readonly AllInHandSeat[],
  lastAggressorSeat: number | undefined,
  toCall: number
): AllInGestureInput | null {
  if (!tableInfo) return null;
  const seats = talkSeatsFrom(seated);
  const horse = seats.find((s) => s.userId === horseUserId);
  if (!horse) return null;
  const live = handSeats.filter((p) => p.user_id !== horseUserId && p.is_folded !== true);
  let targetSeat: number | null = null;
  if (
    toCall > 0 &&
    typeof lastAggressorSeat === 'number' &&
    lastAggressorSeat !== horse.seat &&
    live.some((p) => p.seat === lastAggressorSeat)
  ) {
    targetSeat = lastAggressorSeat;
  } else if (live.length > 0) {
    const ordered = [...live].sort((a, b) => a.seat - b.seat);
    targetSeat =
      ordered[personaHash(`${horseUserId}|${handNumber}|all_in|target`) % ordered.length].seat;
  }
  const table = talkTableFrom(tableInfo, isTournament || !!tableInfo.tournament_id);
  return { table, handNumber, horse, targetSeat, seated: seats };
}
