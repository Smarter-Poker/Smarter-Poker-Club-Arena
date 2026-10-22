import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ nudge: vi.fn(), unread: 0 }));

vi.mock('@/lib/pushNudgePolicy', () => ({ requestPushNudge: h.nudge }));
vi.mock('@/stores/useHeaderDataStore', () => ({
  NEW_MESSAGE_EVENT: 'ca:new-message',
  useHeaderDataStore: (selector: (s: { unreadMessages: number }) => unknown) =>
    selector({ unreadMessages: h.unread }),
}));

import MessageAlertsHost, { isNewMessageRow } from '@/components/common/MessageAlertsHost';

const deliver = (detail: unknown) =>
  act(() => {
    window.dispatchEvent(new CustomEvent('ca:new-message', { detail }));
  });

describe('message alerts host', () => {
  beforeEach(() => {
    h.nudge.mockReset();
    h.unread = 0;
    document.title = 'Club Arena';
  });

  it('draws nothing: live pop-ups belong to the Messenger dock', () => {
    const { container } = render(<MessageAlertsHost />);
    deliver({ id: 'n-1', type: 'new_message', title: 'Message from DarthBayter' });
    expect(container.innerHTML).toBe('');
    expect(document.body.querySelector('[aria-label="New Messages"]')).toBeNull();
  });

  it('raises the message_received alerts ask for each received message only', () => {
    render(<MessageAlertsHost />);
    deliver({ id: 'n-1', type: 'new_message' });
    deliver({ id: 'n-2', type: 'club_invite_joined' });
    deliver(null);
    expect(h.nudge).toHaveBeenCalledTimes(1);
    expect(h.nudge).toHaveBeenCalledWith('message_received');
  });

  it('stops listening once unmounted', () => {
    const { unmount } = render(<MessageAlertsHost />);
    unmount();
    deliver({ id: 'n-1', type: 'new_message' });
    expect(h.nudge).not.toHaveBeenCalled();
  });

  it('puts the unread message count in the browser tab title', () => {
    h.unread = 4;
    const { unmount } = render(<MessageAlertsHost />);
    expect(document.title).toBe('(4) Club Arena');
    unmount();
    expect(document.title).toBe('Club Arena');
  });

  it('recognises only identified new_message rows', () => {
    expect(isNewMessageRow({ id: 'a', type: 'new_message' })).toBe(true);
    expect(isNewMessageRow({ type: 'new_message' })).toBe(false);
    expect(isNewMessageRow({ id: 'a', type: 'friend_request' })).toBe(false);
    expect(isNewMessageRow('new_message')).toBe(false);
  });
});
