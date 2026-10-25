/**
 * ONE CHANNEL FOR EVERY PLAYER'S CHAT LINE (2026-10-24)
 *
 * WHY. A player's table chat is written by the browser straight into
 * public.table_chat; until now the engine never heard it, so no horse ever
 * answered anybody. Production chat held "Nice Hand", "Unlucky", "FAT
 * FINGERED THAT SMH", "YOU GUYS PLAY HERE EVERY NIGHT?! LOL" and "Hey Ingrid",
 * each met with silence. Dan 2026-10-24: horses must stop "SCREAMING I AM A
 * BOT".
 *
 * HOW. ONE Supabase Realtime channel per engine process, the shape
 * BombRequestBus established (a channel per table would breach the 100
 * channels a socket allows): postgres_changes INSERTs on public.table_chat,
 * filtered server-side to message_type = 'player'. table_chat is already in
 * the supabase_realtime publication for the browsers' own chat feed (measured
 * 2026-10-24: about 4,700 rows a day, almost all horse lines), so this adds
 * one subscriber to a stream Realtime already decodes, not a new WAL cost.
 *
 * Each cash table's engine registers a context provider when it starts and
 * on its throttled refresh, and unregisters when it stops. A row for a table
 * this process does not serve finds no provider and is dropped; the process
 * that serves it answers. Unregistering is OWNER-SAFE: a superseded engine
 * instance cannot remove its successor's registration.
 *
 * BEST-EFFORT BY DESIGN. A reply is a nicety, not state: a missed broadcast
 * loses one possible "ty". There is no catch-up, no poll and no retry loop
 * (CLAUDE.md 10.12). A terminal channel status releases the handle so the
 * next registration (every engine's throttled refresh) opens a fresh one.
 * Nothing here may throw into a dealing loop.
 */

import { supabase } from './supabase/client.js';
import {
  replyToPlayer,
  talkSeatsFrom,
  talkTableFrom,
  type PlayerChatLine,
  type TalkOutcome,
} from './HorseTableTalk.js';
import type { SeatedPlayer, TableInfo } from '../types.js';

/** The one topic name this process listens on. */
export const CHAT_REPLY_TOPIC = 'engine:table-chat-replies';

/** What an engine hands over when a player's line arrives at its table. */
export interface ChatReplyContext {
  tableInfo: TableInfo | null;
  seatedPlayers: readonly SeatedPlayer[];
  handCount: number;
  isTournament: boolean;
}

interface Registration {
  owner: object;
  context: () => ChatReplyContext | null;
}

const registry = new Map<string, Registration>();

interface ChannelLike {
  on(...args: unknown[]): ChannelLike;
  subscribe(cb?: (status: string) => void): unknown;
}

let channel: ChannelLike | null = null;

/** Test seam: what replyToPlayer is, so a test can watch dispatch without the write path. */
let reply: (input: Parameters<typeof replyToPlayer>[0]) => Promise<TalkOutcome> = replyToPlayer;
export function _setReplyForTests(fn: typeof reply | null): void {
  reply = fn ?? replyToPlayer;
}

function releaseChannel(ch: ChannelLike): void {
  if (channel === ch) channel = null;
  try {
    void supabase.removeChannel(ch as never);
  } catch {
    /* a channel that throws on the way out is already gone */
  }
}

/** Read one realtime row into a chat line, or null when it is not a usable one. */
export function chatLineFrom(row: unknown): { tableId: string; line: PlayerChatLine } | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.message_type !== 'player') return null;
  const tableId = typeof r.table_id === 'string' ? r.table_id : null;
  const id = typeof r.id === 'string' ? r.id : typeof r.id === 'number' ? String(r.id) : null;
  const userId = typeof r.user_id === 'string' ? r.user_id : null;
  const message = typeof r.message === 'string' ? r.message : null;
  if (!tableId || !id || !userId || !message) return null;
  const createdAt = typeof r.created_at === 'string' ? r.created_at : null;
  return { tableId, line: { id, userId, message, createdAt } };
}

/**
 * Hand one inserted row to the table that owns it. Never throws, never awaits
 * the reply: the reply has its own human pause and the channel callback must
 * return at once. Exported for the tests, which drive it without a socket.
 */
export function dispatchChatRow(row: unknown): boolean {
  try {
    const parsed = chatLineFrom(row);
    if (!parsed) return false;
    const reg = registry.get(parsed.tableId);
    if (!reg) return false;
    const ctx = reg.context();
    if (!ctx || !ctx.tableInfo || ctx.isTournament) return false;
    void reply({
      table: talkTableFrom(ctx.tableInfo, ctx.isTournament),
      handNumber: ctx.handCount,
      seated: talkSeatsFrom(ctx.seatedPlayers),
      chat: parsed.line,
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function ensureChannel(): void {
  if (channel) return;
  try {
    const ch = (supabase.channel(CHAT_REPLY_TOPIC) as unknown as ChannelLike).on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'table_chat',
        filter: 'message_type=eq.player',
      },
      (payload: unknown) => {
        dispatchChatRow((payload as { new?: unknown } | null)?.new);
      }
    );
    channel = ch;
    void ch.subscribe((status: string) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (channel === ch) {
          console.warn(`[HorseChat] shared chat channel ${status}; releasing the handle`);
          releaseChannel(ch);
        }
      }
    });
  } catch (err) {
    console.warn('[HorseChat] shared chat channel failed to open:', err);
    channel = null;
  }
}

/**
 * Listen for players' lines at one table. Idempotent: registering again
 * (the throttled refresh does) replaces the provider and re-opens a channel
 * that a terminal status released.
 */
export function registerChatReplies(
  tableId: string,
  owner: object,
  context: () => ChatReplyContext | null
): void {
  if (!tableId) return;
  registry.set(tableId, { owner, context });
  ensureChannel();
}

/**
 * Stop listening for one table, only if this owner still holds it. The shared
 * channel closes once the last table has gone.
 */
export function unregisterChatReplies(tableId: string, owner: object): void {
  const reg = registry.get(tableId);
  if (!reg || reg.owner !== owner) return;
  registry.delete(tableId);
  if (registry.size > 0 || !channel) return;
  releaseChannel(channel);
}

/** Test seams. */
export function chatReplyListenerCount(): number {
  return registry.size;
}
export function chatReplyChannelOpen(): boolean {
  return channel !== null;
}
export function _resetChatListenerForTests(): void {
  registry.clear();
  channel = null;
  reply = replyToPlayer;
}
