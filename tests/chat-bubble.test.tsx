/**
 * A chat message must appear as a speech bubble over the SENDER'S SEAT, for
 * everyone at the table, and go away on its own.
 *
 * Dan 2026-08-23: "WHEN YOU TYPE A MESSAGE INSIDE THE CHAT, IT NEEDS TO APPEAR
 * ABOVE THE AVATAR AS A 'BUBBLE MESSAGE' FOR ALL PLAYERS TO SEE."
 *
 * The broadcast leg already worked: `useTableChat` writes to `table_chat` and a
 * realtime INSERT listener pushes the row into `chatMessages` on every client.
 * What did not exist was the mapping from a message to a SEAT, and every rule
 * pinned below is one that would be visible to a player if it were missing:
 * reaction and throw payloads ride the same chat table and must never render as
 * text; fifty rows of history load on mount and must not fire fifty bubbles;
 * the optimistic local copy and the database row that replaces it are one
 * message, not two.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import {
  ChatBubble,
  useSeatChatBubbles,
  bubbleForSeat,
  isBubbleWorthy,
  seatOfSender,
  CHAT_BUBBLE_LIFETIME_MS,
} from '../src/components/table/ChatBubble';
import type { ChatMessage } from '../src/components/table/TableChat';

/** Seat-ordered occupants, exactly as TablePage holds them: index 0 = seat 1. */
const SEATS: (string | null | undefined)[] = ['hero-id', null, 'villain-id', undefined, 'third-id'];

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  type: 'PLAYER',
  playerId: 'villain-id',
  playerName: 'Villain',
  content: 'nice hand',
  timestamp: new Date(),
  ...over,
});

describe('isBubbleWorthy', () => {
  it('accepts an ordinary player line', () => {
    expect(isBubbleWorthy(msg({ id: 'a' }))).toBe(true);
  });

  it('rejects the dealer and system narration that shares the chat feed', () => {
    // useTableChat injects these from MasterBus events. They belong in the
    // panel, never over a seat.
    expect(isBubbleWorthy(msg({ id: 'b', type: 'SYSTEM', content: 'auto-folded' }))).toBe(false);
    expect(isBubbleWorthy(msg({ id: 'c', type: 'DEALER', content: 'Villain wins' }))).toBe(false);
  });

  it('rejects the encoded reaction and throw payloads', () => {
    // These are how TableReactions and the throwables layer broadcast; a
    // bubble reading "[THROW:tomato:4]" is the failure this guards.
    expect(isBubbleWorthy(msg({ id: 'd', content: '[REACTION:star:3]' }))).toBe(false);
    expect(isBubbleWorthy(msg({ id: 'e', content: '[THROW:tomato:4]' }))).toBe(false);
  });

  it('rejects an empty or whitespace-only message', () => {
    expect(isBubbleWorthy(msg({ id: 'f', content: '   ' }))).toBe(false);
  });

  it('rejects a message with no sender to attribute it to', () => {
    expect(isBubbleWorthy(msg({ id: 'g', playerId: undefined }))).toBe(false);
  });
});

describe('seatOfSender', () => {
  it('resolves a seated player to a 1-based seat number', () => {
    expect(seatOfSender('hero-id', SEATS)).toBe(1);
    expect(seatOfSender('villain-id', SEATS)).toBe(3);
    expect(seatOfSender('third-id', SEATS)).toBe(5);
  });

  it('returns 0 for an observer, who has no seat to sit over', () => {
    expect(seatOfSender('watcher-id', SEATS)).toBe(0);
  });

  it('does not match an empty seat against a missing id', () => {
    expect(seatOfSender('', SEATS)).toBe(0);
  });
});

describe('useSeatChatBubbles', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    /* Deliberately NOT vi.runOnlyPendingTimers() here. Testing Library's own
       afterEach unmounts later than this one, so flushing timers now fires the
       expiry callback while the hook is still mounted and outside act(),
       producing a "not wrapped in act" warning on every test that left a bubble
       up. The hook clears its own timers on unmount, so there is nothing to
       drain. */
    vi.useRealTimers();
  });

  it('raises a bubble on the sender seat when a message arrives', () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) => useSeatChatBubbles(messages, SEATS),
      { initialProps: { messages: [] as ChatMessage[] } }
    );

    expect(result.current).toHaveLength(0);

    rerender({ messages: [msg({ id: 'm1', content: 'nh sir' })] });

    expect(result.current).toHaveLength(1);
    expect(result.current[0].seatNumber).toBe(3);
    expect(result.current[0].content).toBe('nh sir');
    expect(bubbleForSeat(result.current, 3)?.playerName).toBe('Villain');
    expect(bubbleForSeat(result.current, 1)).toBeUndefined();
  });

  it('shows the HERO their own line too, so a sent message is visibly sent', () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) => useSeatChatBubbles(messages, SEATS),
      { initialProps: { messages: [] as ChatMessage[] } }
    );

    rerender({ messages: [msg({ id: 'm1', playerId: 'hero-id', content: 'gg' })] });

    expect(bubbleForSeat(result.current, 1)?.content).toBe('gg');
  });

  it('clears the bubble once its lifetime is up', () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) => useSeatChatBubbles(messages, SEATS),
      { initialProps: { messages: [] as ChatMessage[] } }
    );

    rerender({ messages: [msg({ id: 'm1' })] });
    expect(result.current).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(CHAT_BUBBLE_LIFETIME_MS - 1);
    });
    expect(result.current).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current).toHaveLength(0);
  });

  it('ignores the fifty rows of history loaded on mount', () => {
    // useTableChat seeds chatMessages with the last 50 rows the moment the
    // table opens. Sitting down at a chatty table must not fire fifty bubbles.
    const old = new Date(Date.now() - CHAT_BUBBLE_LIFETIME_MS - 60_000);
    const history = Array.from({ length: 50 }, (_, i) =>
      msg({ id: `h${i}`, content: `line ${i}`, timestamp: old })
    );

    const { result } = renderHook(() => useSeatChatBubbles(history, SEATS));

    expect(result.current).toHaveLength(0);
  });

  it('keeps one bubble per seat: the latest line replaces the previous one', () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) => useSeatChatBubbles(messages, SEATS),
      { initialProps: { messages: [] as ChatMessage[] } }
    );

    rerender({ messages: [msg({ id: 'm1', content: 'first' })] });
    rerender({
      messages: [msg({ id: 'm1', content: 'first' }), msg({ id: 'm2', content: 'second' })],
    });

    const onSeatThree = result.current.filter((b) => b.seatNumber === 3);
    expect(onSeatThree).toHaveLength(1);
    expect(onSeatThree[0].content).toBe('second');
  });

  it('treats the optimistic copy and the database row as one message', () => {
    // handleSendChatMessage appends `msg_<ts>` immediately, then the realtime
    // INSERT swaps in the real uuid with identical text. Two bubbles for one
    // typed line would be wrong, and it would re-arm the expiry timer.
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) => useSeatChatBubbles(messages, SEATS),
      { initialProps: { messages: [] as ChatMessage[] } }
    );

    rerender({ messages: [msg({ id: 'msg_1700000000000', content: 'hello' })] });
    rerender({
      messages: [msg({ id: 'a1b2c3d4-0000-0000-0000-000000000001', content: 'hello' })],
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0].content).toBe('hello');
  });

  it('drops an observer message, which has no seat to sit over', () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) => useSeatChatBubbles(messages, SEATS),
      { initialProps: { messages: [] as ChatMessage[] } }
    );

    rerender({ messages: [msg({ id: 'm1', playerId: 'watcher-id', content: 'hi all' })] });

    expect(result.current).toHaveLength(0);
  });

  it('removes a live bubble when its player leaves the seat', () => {
    const { result, rerender } = renderHook(
      ({ messages, seats }: { messages: ChatMessage[]; seats: (string | null | undefined)[] }) =>
        useSeatChatBubbles(messages, seats),
      { initialProps: { messages: [] as ChatMessage[], seats: SEATS } }
    );

    rerender({ messages: [msg({ id: 'm1' })], seats: SEATS });
    expect(result.current).toHaveLength(1);

    // Villain stands up while the bubble is still up: it would otherwise hover
    // over an EMPTY seat plate.
    rerender({
      messages: [msg({ id: 'm1' })],
      seats: ['hero-id', null, null, null, 'third-id'],
    });
    expect(result.current).toHaveLength(0);
  });

  it('raises nothing while chat is switched off for the table', () => {
    // Bible V8 text_message gate: when chat is off, TablePage does not render
    // the panel, so bubbles must not appear either.
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) =>
        useSeatChatBubbles(messages, SEATS, { enabled: false }),
      { initialProps: { messages: [] as ChatMessage[] } }
    );

    rerender({ messages: [msg({ id: 'm1' })] });

    expect(result.current).toHaveLength(0);
  });
});

describe('ChatBubble component', () => {
  it('renders the message text and the sender name', () => {
    const { container } = render(<ChatBubble text="nice hand" playerName="Villain" />);

    expect(container.textContent).toContain('nice hand');
    expect(container.textContent).toContain('Villain');
    expect(container.querySelector('.chat-bubble')).not.toBeNull();
  });

  it('points up by default and down when asked, for the top-arc seats', () => {
    const { container: up } = render(<ChatBubble text="hi" />);
    expect(up.querySelector('.chat-bubble--above')).not.toBeNull();

    const { container: down } = render(<ChatBubble text="hi" placement="below" />);
    expect(down.querySelector('.chat-bubble--below')).not.toBeNull();
  });

  it('marks the hero own bubble so a player can spot their own line', () => {
    const { container } = render(<ChatBubble text="gg" isOwn />);
    expect(container.querySelector('.chat-bubble--own')).not.toBeNull();
  });

  it('announces politely rather than interrupting the hand', () => {
    // role=status + aria-live=polite: a chat line must never preempt a screen
    // reader mid-announcement of the action the player has to respond to.
    const { container } = render(<ChatBubble text="hi" />);
    const el = container.querySelector('.chat-bubble') as HTMLElement;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });
});
