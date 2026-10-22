/**
 * MESSAGE ALERTS HOST (Dan 2026-10-21)
 *
 * Live message pop-ups are owned by the Messenger dock (MessengerDockHost):
 * Facebook-style chat heads with the sender's photo and an inline reply,
 * honouring the player's Messenger alerts setting. This host adds the two
 * things the dock does not do, without drawing any surface of its own:
 *
 *  - the browser tab reads "(N) <title>" while messages are unread, so a
 *    player on another tab still sees them;
 *  - a received message is the moment an alert is most obviously useful, so
 *    it raises the shared `message_received` enrollment moment. The shared
 *    policy decides whether an ask may appear: never when this device already
 *    has push, the player turned it off or blocked it, they were asked within
 *    the last day, or they are on the felt.
 *
 * Every direct message lands as a `new_message` notification; the header data
 * store holds that realtime channel and re-dispatches each one on window as
 * NEW_MESSAGE_EVENT, so this host opens no channel of its own.
 */

import { useEffect } from 'react';
import { NEW_MESSAGE_EVENT, useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { requestPushNudge } from '../../lib/pushNudgePolicy';
import { useUnreadTabTitle } from './useUnreadTabTitle';

/** Pure: whether a dispatched notification row is a received direct message. */
export function isNewMessageRow(row: unknown): boolean {
  return (
    !!row &&
    typeof row === 'object' &&
    (row as { type?: unknown }).type === 'new_message' &&
    !!(row as { id?: unknown }).id
  );
}

export default function MessageAlertsHost() {
  const unreadMessages = useHeaderDataStore((state) => state.unreadMessages);
  useUnreadTabTitle(unreadMessages);

  useEffect(() => {
    const onMessage = (event: Event) => {
      if (isNewMessageRow((event as CustomEvent).detail)) requestPushNudge('message_received');
    };
    window.addEventListener(NEW_MESSAGE_EVENT, onMessage);
    return () => window.removeEventListener(NEW_MESSAGE_EVENT, onMessage);
  }, []);

  return null;
}
