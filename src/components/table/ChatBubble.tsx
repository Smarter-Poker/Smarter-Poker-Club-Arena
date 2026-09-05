/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHAT BUBBLE — a sent chat line, shown above the sender's seat avatar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23: "WHEN YOU TYPE A MESSAGE INSIDE THE CHAT, IT NEEDS TO APPEAR
 * ABOVE THE AVATAR AS A 'BUBBLE MESSAGE' FOR ALL PLAYERS TO SEE."
 *
 * WHY this is derived rather than plumbed as a new event: every chat line
 * already reaches every client. `useTableChat` inserts into `table_chat` and a
 * Supabase realtime INSERT listener on `table_chat:table_id=eq.<id>` pushes the
 * row into `chatMessages` for everyone seated or observing. So the broadcast
 * leg is done; what was missing was a SEAT for the message. `ChatMessage`
 * carries `playerId` (the row's `user_id`) and nothing else, and the seat is
 * recoverable from the seat-ordered `players` array the table already renders
 * (index 0 = seat 1 — the same mapping `useTableChat.parseIncomingMessage`
 * uses to resolve a thrower's seat). Adding a second transport for text that
 * is already flowing would mean two sources of truth for one message.
 *
 * This module is self-contained on purpose: SeatSlot.tsx and TablePage.tsx are
 * owned by other agents, so the bubble ships as a component plus a hook they
 * can mount with a two-line change.
 */

import { useEffect, useRef, useState } from 'react';
import './ChatBubble.css';
import type { ChatMessage } from './TableChat';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * How long a bubble stays over the seat.
 *
 * 5s is the read time for the 200-character ceiling `TableChat` puts on the
 * input (roughly 40 words per minute of reading, doubled for a glance while a
 * hand is running). Long enough to read without becoming furniture that hides
 * the seat plate for the rest of the hand.
 */
export const CHAT_BUBBLE_LIFETIME_MS = 5000;

/**
 * Bubbles older than this on FIRST RENDER are ignored entirely.
 *
 * `useTableChat` seeds `chatMessages` with the last 50 rows of history the
 * moment the table mounts. Without this guard, sitting down at a chatty table
 * would fire fifty bubbles at once over seats whose occupants may have left.
 */
const BUBBLE_MAX_AGE_MS = CHAT_BUBBLE_LIFETIME_MS;

/**
 * Reaction and throw payloads ride the SAME chat table as text (see
 * `useTableChat`'s REACTION_MSG_REGEX / THROW_MSG_REGEX). They are rendered by
 * the animation layer and must never surface as a speech bubble reading
 * "[THROW:tomato:4]".
 */
const ENCODED_MSG_REGEX = /^\[(REACTION|THROW):.+:\d+\]$/;

/** Stable identity, so the default for `speakingPlayerIds` is not a new array
    on every render (which would restart every memo that depends on it). */
const EMPTY_SPEAKERS: ReadonlyArray<string> = [];

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * What kind of bubble this is.
 *
 * Dan's request was "a bubble with the chat above the player who has MESSAGED
 * OR TALKED on the table". A typed line and a live microphone are the same
 * affordance in the same place, and they are not the same picture: text has
 * words and a 5s life, voice has neither - it is on while the player holds the
 * button and off the instant they let go.
 */
/**
 * 'notice' (2026-09-04): a table fact about the seat rather than something
 * the player said — today, "Has Added On For 50.00" from `AddOnBubble.ts`.
 * Words like a message, gold like a chip so nobody reads it as chat.
 */
export type SeatChatBubbleVariant = 'message' | 'speaking' | 'notice';

export interface SeatChatBubble {
  /** Source chat message id, so React keys stay stable across re-renders. */
  id: string;
  /** 1-based seat number, matching SeatSlot's `seatNumber` prop. */
  seatNumber: number;
  playerId: string;
  playerName: string;
  content: string;
  /** Epoch ms the bubble was raised; used only for expiry. */
  shownAt: number;
  /** 'message' unless voice raised it. Absent means 'message'. */
  variant?: SeatChatBubbleVariant;
}

export interface ChatBubbleProps {
  /** The message text. Rendered verbatim: it is already profanity-filtered by
      `useTableChat.censorMessage` before it ever reaches the database. */
  text: string;
  /** Sender name, shown small above the text for seats far from the reader. */
  playerName?: string;
  /** The hero's own bubble is tinted so a player can spot their own line. */
  isOwn?: boolean;
  /**
   * Seats on the top arc of the table have nothing below them and everything
   * above them (the BBJ banner), so their bubble points DOWN instead of up.
   */
  placement?: 'above' | 'below';
  /**
   * 'speaking' draws the voice indicator instead of text: three pulsing dots,
   * a green rim, and no 5s life - it stays for exactly as long as the caller
   * keeps saying the player is talking. `text` is ignored in that variant, so
   * the voice agent does not have to invent a string.
   */
  variant?: SeatChatBubbleVariant;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESENTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The bubble itself. Absolutely positioned against its nearest positioned
 * ancestor, which at the table is `.seat-wrapper` (position: absolute in
 * TablePage.css) — so mounting it as a SIBLING of <SeatSlot> puts it directly
 * over that seat with no coordinate maths.
 */
export function ChatBubble({
  text,
  playerName,
  isOwn = false,
  placement = 'above',
  variant = 'message',
}: ChatBubbleProps) {
  const isSpeaking = variant === 'speaking';
  const isNotice = variant === 'notice';
  return (
    <div
      className={`chat-bubble chat-bubble--${placement}${isOwn ? ' chat-bubble--own' : ''}${
        isSpeaking ? ' chat-bubble--speaking' : ''
      }${isNotice ? ' chat-bubble--notice' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={isSpeaking ? `${playerName || 'Player'} Is Speaking` : undefined}
    >
      {playerName ? <span className="chat-bubble__name">{playerName}</span> : null}
      {isSpeaking ? (
        /* Three dots, not the word "Speaking": the bubble is 132px wide at
           375px and sits over a seat plate during a live hand. `aria-hidden`
           because the label above already says it in words. */
        <span className="chat-bubble__voice" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <span className="chat-bubble__text">{text}</span>
      )}
      <span className="chat-bubble__tail" aria-hidden="true" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVATION — chat messages to per-seat bubbles
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A message qualifies for a bubble when it is a real player line: not a
 * SYSTEM/DEALER injection, not an encoded reaction or throw, not empty.
 *
 * Exported for the unit tests, which pin the reaction/throw exclusion — that
 * exclusion is the one rule here whose absence would be visible and ugly.
 */
export function isBubbleWorthy(message: ChatMessage): boolean {
  if (message.type !== 'PLAYER') return false;
  if (!message.playerId) return false;
  const text = (message.content || '').trim();
  if (!text) return false;
  return !ENCODED_MSG_REGEX.test(text);
}

/**
 * Resolve a sender's 1-based seat from the table's seat-ordered player array.
 * Returns 0 when the sender is not seated (an observer chatting, or a player
 * who has since stood up), which the caller treats as "no bubble".
 */
export function seatOfSender(
  playerId: string,
  seatOwnerIds: ReadonlyArray<string | null | undefined>
): number {
  const idx = seatOwnerIds.findIndex((id) => !!id && id === playerId);
  return idx >= 0 ? idx + 1 : 0;
}

export interface UseSeatChatBubblesOptions {
  /** Override the 5s lifetime (tests use a short one). */
  lifetimeMs?: number;
  /** Chat can be switched off per table (Bible V8 text_message); bubbles follow. */
  enabled?: boolean;
  /**
   * ═══ THE VOICE INTEGRATION ═══
   *
   * Player ids that are talking RIGHT NOW. Each one that maps to a seat gets a
   * `variant: 'speaking'` bubble for exactly as long as its id stays in this
   * array - no timer, no lifetime, because the caller already knows when the
   * microphone opened and closed and a second opinion here could only disagree
   * with it.
   *
   * This is the whole API the voice agent needs. Pass the ids; the table shows
   * it. Default empty, so nothing changes for a table with no voice.
   *
   * A seat that is BOTH talking and has a live message bubble shows the
   * MESSAGE: the words are the more informative of the two, and stacking both
   * over one seat plate is how you cover the seat above.
   */
  speakingPlayerIds?: ReadonlyArray<string>;
}

/**
 * Turn the live `chatMessages` array into at most one bubble per seat.
 *
 * One per seat, latest wins: a player firing three lines in a row must not
 * stack three boxes over their own head and cover the seat above them.
 */
export function useSeatChatBubbles(
  messages: ReadonlyArray<ChatMessage>,
  seatOwnerIds: ReadonlyArray<string | null | undefined>,
  options: UseSeatChatBubblesOptions = {}
): SeatChatBubble[] {
  const {
    lifetimeMs = CHAT_BUBBLE_LIFETIME_MS,
    enabled = true,
    speakingPlayerIds = EMPTY_SPEAKERS,
  } = options;

  const [bubbles, setBubbles] = useState<SeatChatBubble[]>([]);
  /** Message ids already turned into a bubble (or deliberately skipped). */
  const seenIdsRef = useRef<Set<string>>(new Set());
  /**
   * `playerId|content` of the last bubble raised per seat, so the OPTIMISTIC
   * local copy (`msg_<ts>`) and the real database row that replaces it a
   * moment later — different ids, identical text — do not read as two separate
   * messages and re-arm the timer for a second full lifetime.
   */
  const lastKeyRef = useRef<Map<number, string>>(new Map());
  const seatOwnerIdsRef = useRef(seatOwnerIds);
  seatOwnerIdsRef.current = seatOwnerIds;
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Clear every pending expiry on unmount: a timer that fires after the table
  // is gone calls setState on a dead component.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Mark everything currently known as seen so re-enabling chat mid-hand
      // does not replay the backlog as a wall of bubbles.
      messages.forEach((m) => seenIdsRef.current.add(m.id));
      setBubbles((prev) => (prev.length ? [] : prev));
      return;
    }

    const now = Date.now();
    const fresh: SeatChatBubble[] = [];

    for (const message of messages) {
      if (seenIdsRef.current.has(message.id)) continue;
      seenIdsRef.current.add(message.id);

      if (!isBubbleWorthy(message)) continue;

      // History replay guard — see BUBBLE_MAX_AGE_MS.
      const sentAt = message.timestamp instanceof Date ? message.timestamp.getTime() : now;
      if (Number.isFinite(sentAt) && now - sentAt > BUBBLE_MAX_AGE_MS) continue;

      const seatNumber = seatOfSender(message.playerId as string, seatOwnerIdsRef.current);
      if (seatNumber <= 0) continue; // Observer or departed player: no seat to sit over.

      const key = `${message.playerId}|${message.content}`;
      if (lastKeyRef.current.get(seatNumber) === key) continue;
      lastKeyRef.current.set(seatNumber, key);

      fresh.push({
        id: message.id,
        seatNumber,
        playerId: message.playerId as string,
        playerName: message.playerName || 'Player',
        content: message.content,
        shownAt: now,
      });
    }

    if (fresh.length === 0) return;

    setBubbles((prev) => {
      const replacedSeats = new Set(fresh.map((b) => b.seatNumber));
      return [...prev.filter((b) => !replacedSeats.has(b.seatNumber)), ...fresh];
    });

    const ids = fresh.map((b) => b.id);
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setBubbles((prev) => prev.filter((b) => !ids.includes(b.id)));
    }, lifetimeMs);
    timersRef.current.add(timer);
    // `seatOwnerIds` is read through a ref so a seat change does not re-run the
    // scan and re-raise bubbles that have already expired.
  }, [messages, enabled, lifetimeMs]);

  // Prune bubbles whose seat emptied out while the bubble was still up: the
  // player left, so the box would hover over an EMPTY seat plate.
  const activeSeats = new Set(seatOwnerIds.map((id, i) => (id ? i + 1 : 0)).filter((n) => n > 0));
  const messageBubbles = bubbles.filter((b) => activeSeats.has(b.seatNumber));

  if (!enabled || speakingPlayerIds.length === 0) return messageBubbles;

  /* Voice, derived on the spot rather than held in state: whether a player is
     talking is not this hook's fact, it is the caller's, and copying it into
     state here would only create a version of it that can go stale. */
  const takenSeats = new Set(messageBubbles.map((b) => b.seatNumber));
  const speaking: SeatChatBubble[] = [];
  for (const playerId of speakingPlayerIds) {
    const seatNumber = seatOfSender(playerId, seatOwnerIds);
    if (seatNumber <= 0) continue; // Not seated: nothing to sit over.
    if (takenSeats.has(seatNumber)) continue; // A message is already up there.
    takenSeats.add(seatNumber);
    speaking.push({
      // Not a message id, and deliberately prefixed so it can never collide
      // with one — this bubble has no row behind it.
      id: `speaking-${playerId}`,
      seatNumber,
      playerId,
      // The last thing they said carries their display name; the hook is never
      // given the roster, and a wrong name over a seat is worse than none.
      playerName: nameFromMessages(messages, playerId),
      content: '',
      shownAt: 0,
      variant: 'speaking',
    });
  }
  return speaking.length ? [...messageBubbles, ...speaking] : messageBubbles;
}

/** Most recent display name this feed has for a player, or '' if it has none. */
function nameFromMessages(messages: ReadonlyArray<ChatMessage>, playerId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.playerId === playerId && m.playerName) return m.playerName;
  }
  return '';
}

/**
 * Pick the bubble belonging to one seat. Convenience for the seat renderer,
 * which holds the whole list and asks per seat.
 */
export function bubbleForSeat(
  bubbles: ReadonlyArray<SeatChatBubble>,
  seatNumber: number
): SeatChatBubble | undefined {
  return bubbles.find((b) => b.seatNumber === seatNumber);
}

export default ChatBubble;
