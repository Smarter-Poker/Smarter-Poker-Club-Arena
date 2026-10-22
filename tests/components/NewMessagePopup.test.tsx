import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  leaveForHub: vi.fn(),
  emit: vi.fn(),
  nudge: vi.fn(),
  setUnreadMessages: vi.fn(),
  unread: 0,
}));

vi.mock('@/lib/openExternal', () => ({ leaveForHub: h.leaveForHub }));
vi.mock('@/core/MasterBus', () => ({ masterBus: { emit: h.emit } }));
vi.mock('@/lib/pushNudgePolicy', () => ({ requestPushNudge: h.nudge }));
vi.mock('@/stores/useHeaderDataStore', () => {
  const useHeaderDataStore = Object.assign(
    (selector: (s: { unreadMessages: number }) => unknown) =>
      selector({ unreadMessages: h.unread }),
    { getState: () => ({ setUnreadMessages: h.setUnreadMessages }) }
  );
  return { NEW_MESSAGE_EVENT: 'ca:new-message', useHeaderDataStore };
});

import NewMessagePopup from '@/components/common/NewMessagePopup';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'n-1',
  type: 'new_message',
  title: 'Message from DarthBayter',
  message: 'How do I take a seat',
  link: '/hub/messenger?c=conv-1',
  data: { conversationId: 'conv-1', senderAvatarUrl: 'https://cdn.example/darth.png' },
  ...over,
});

const deliver = (detail: unknown) =>
  act(() => {
    window.dispatchEvent(new CustomEvent('ca:new-message', { detail }));
  });

describe('live new message pop-up', () => {
  beforeEach(() => {
    vi.useRealTimers();
    h.leaveForHub.mockReset();
    h.emit.mockReset();
    h.nudge.mockReset();
    h.setUnreadMessages.mockReset();
    h.unread = 0;
    delete document.body.dataset.caLiveTables;
    document.title = 'Club Arena';
  });

  it('shows the sender, the message and their photo, and raises the alerts ask', () => {
    render(<NewMessagePopup />);
    deliver(row());
    expect(screen.getByText('How do I take a seat')).toBeTruthy();
    const open = screen.getByRole('button', { name: /Open Message From DarthBayter/i });
    expect(open.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/darth.png');
    expect(h.nudge).toHaveBeenCalledWith('message_received');
  });

  it('opens that conversation in the messenger when clicked', () => {
    render(<NewMessagePopup />);
    deliver(row());
    fireEvent.click(screen.getByRole('button', { name: /Open Message From DarthBayter/i }));
    expect(h.leaveForHub).toHaveBeenCalledWith('/hub/messenger?c=conv-1');
    expect(h.setUnreadMessages).toHaveBeenCalledWith(0);
    expect(screen.queryByText('How do I take a seat')).toBeNull();
  });

  it('opens the messenger as a hub tab instead of leaving live tables', () => {
    document.body.dataset.caLiveTables = '1';
    render(<NewMessagePopup />);
    deliver(row());
    fireEvent.click(screen.getByRole('button', { name: /Open Message From DarthBayter/i }));
    expect(h.emit).toHaveBeenCalledWith('OPEN_HUB_TAB', { path: '/hub/messenger?c=conv-1' });
    expect(h.leaveForHub).not.toHaveBeenCalled();
  });

  it('stacks at most three cards, ignores repeats and other notification types', () => {
    render(<NewMessagePopup />);
    for (const id of ['a', 'b', 'c', 'd']) deliver(row({ id, message: `msg ${id}` }));
    deliver(row({ id: 'd', message: 'msg d' }));
    deliver({ id: 'x', type: 'club_invite_joined', title: 'Joined' });
    expect(screen.getAllByRole('button', { name: /Open Message From/i })).toHaveLength(3);
    expect(screen.queryByText('msg a')).toBeNull();
    expect(screen.getByText('msg d')).toBeTruthy();
  });

  it('dismisses on the close button and closes itself after a few seconds', () => {
    vi.useFakeTimers();
    render(<NewMessagePopup />);
    deliver(row({ id: 'one', message: 'first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Message' }));
    expect(screen.queryByText('first')).toBeNull();
    deliver(row({ id: 'two', message: 'second' }));
    expect(screen.getByText('second')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(9500);
    });
    expect(screen.queryByText('second')).toBeNull();
  });

  it('falls back to the messenger icon when the sender has no photo', () => {
    render(<NewMessagePopup />);
    deliver(row({ data: { conversationId: 'conv-1' } }));
    const img = screen.getByRole('button', { name: /Open Message From/i }).querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/messenger\.png$/);
  });

  it('puts the unread count in the browser tab title', () => {
    h.unread = 4;
    render(<NewMessagePopup />);
    expect(document.title).toBe('(4) Club Arena');
  });
});
