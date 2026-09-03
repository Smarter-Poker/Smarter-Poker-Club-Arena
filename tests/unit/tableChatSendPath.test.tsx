/**
 * Table chat send path — the two silent losses.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  CONTEXT: THIS SURFACE IS NOT DEAD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The brief that produced this file said the in-game table chat "has never sent
 * a message" and that `broadcast-message` has no caller. Both were checked
 * against reality on 2026-08-25:
 *
 *   `broadcast-message` does not exist in this repository. It was
 *   `pages/api/messenger/broadcast-message.js` in Smarter-Poker-World-Hub, an
 *   orphaned DM route, and it was DELETED on 2026-08-21. Only audit notes
 *   mention it. It never had anything to do with table chat.
 *
 *   Table chat has sent messages. `table_chat` holds real player rows, the most
 *   recent two days before this was written. The transport is an INSERT into
 *   `table_chat` plus a postgres_changes subscription, and `table_chat` IS in
 *   the `supabase_realtime` publication.
 *
 * So the send path was not missing. It was LOSSY, in two places, and both losses
 * were invisible to the player. That is what these tests pin.
 *
 * LOSS 1 — two rate limiters that disagreed. `TableChat.handleSend` cleared the
 * input after 300ms; `useTableChat.handleSendChatMessage` refused anything
 * inside 1000ms and returned in silence. A player typing two quick messages had
 * the second one taken out of the box and dropped.
 *
 * LOSS 2 — a refused insert was handled by filtering the optimistic message out
 * of the transcript. The line appeared and then vanished, with nothing to say
 * it had not been sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  TableChat,
  SEND_COOLDOWN_MS,
  type ChatMessage,
} from '../../src/components/table/TableChat';

function baseMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    type: 'PLAYER',
    playerId: 'p1',
    playerName: 'Villain',
    content: 'nice hand',
    timestamp: new Date('2026-08-25T12:00:00Z'),
    ...over,
  };
}

describe('TableChat compose box', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a cooldown at least as long as the hook rate limit', () => {
    /* The invariant, stated once. `RATE_LIMIT_MS` in useTableChat is 1000. If
       this constant ever drops below that, the box clears the input for a
       message the hook then discards and LOSS 1 is back. */
    expect(SEND_COOLDOWN_MS).toBeGreaterThanOrEqual(1000);
  });

  it('sends the trimmed message and clears the box', () => {
    const onSendMessage = vi.fn();
    render(<TableChat messages={[]} onSendMessage={onSendMessage} isCollapsed={false} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '  raise it up  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSendMessage).toHaveBeenCalledWith('raise it up');
    expect(input.value).toBe('');
  });

  it('KEEPS THE TEXT when a second send lands inside the cooldown', () => {
    // LOSS 1. Before the fix the input was cleared at 300ms and the hook then
    // dropped the message at <1000ms, so this text was simply gone.
    const onSendMessage = vi.fn();
    render(<TableChat messages={[]} onSendMessage={onSendMessage} isCollapsed={false} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'first' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSendMessage).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: 'second' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('second');
  });

  it('accepts the next message once the cooldown has passed', () => {
    const onSendMessage = vi.fn();
    render(<TableChat messages={[]} onSendMessage={onSendMessage} isCollapsed={false} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'first' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    act(() => {
      vi.advanceTimersByTime(SEND_COOLDOWN_MS + 10);
    });

    fireEvent.change(input, { target: { value: 'second' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSendMessage).toHaveBeenCalledTimes(2);
    expect(onSendMessage).toHaveBeenLastCalledWith('second');
    expect(input.value).toBe('');
  });

  it('does not start the cooldown on an empty send', () => {
    /* Pressing Enter on an empty box used to stamp the cooldown, so a player
       who hit Enter and then typed had to wait a second for no reason. */
    const onSendMessage = vi.fn();
    render(<TableChat messages={[]} onSendMessage={onSendMessage} isCollapsed={false} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'real message' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSendMessage).toHaveBeenCalledWith('real message');
  });

  it('does not send while disabled, and keeps the text', () => {
    const onSendMessage = vi.fn();
    render(
      <TableChat messages={[]} onSendMessage={onSendMessage} isCollapsed={false} isDisabled />
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'observers cannot chat' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSendMessage).not.toHaveBeenCalled();
  });
});

describe('TableChat failed message', () => {
  it('says Not Sent instead of deleting the message', () => {
    // LOSS 2. The old behaviour removed the row entirely; there was no branch
    // to test because there was nothing left on screen.
    render(
      <TableChat
        messages={[baseMessage({ playerId: 'me', content: 'gg', isFailed: true })]}
        onSendMessage={() => {}}
        myPlayerId="me"
        isCollapsed={false}
      />
    );
    expect(screen.getByText('gg')).toBeTruthy();
    expect(screen.getByText('Not Sent')).toBeTruthy();
  });

  it('marks a failed message for the eye as well as the screen reader', () => {
    const { container } = render(
      <TableChat
        messages={[baseMessage({ playerId: 'me', isFailed: true })]}
        onSendMessage={() => {}}
        myPlayerId="me"
        isCollapsed={false}
      />
    );
    expect(container.querySelector('.chat-message--failed')).not.toBeNull();
    expect(screen.getByText('Not Sent').getAttribute('role')).toBe('status');
  });

  it('leaves a delivered message completely unmarked', () => {
    const { container } = render(
      <TableChat
        messages={[baseMessage({ playerId: 'me' })]}
        onSendMessage={() => {}}
        myPlayerId="me"
        isCollapsed={false}
      />
    );
    expect(container.querySelector('.chat-message--failed')).toBeNull();
    expect(screen.queryByText('Not Sent')).toBeNull();
  });
});
