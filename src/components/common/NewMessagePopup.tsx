/**
 * NEW MESSAGE POPUP (Dan 2026-10-21)
 *
 * "it should pop up in the bottom right hand corner of the screen like
 * facebook messenger with new live messages."
 *
 * Every direct message lands as a `new_message` notification. The header data
 * store already holds the realtime channel for this user's notifications and
 * re-dispatches each new message on window as NEW_MESSAGE_EVENT, so this
 * component opens no channel of its own. It stacks up to three live message
 * cards in the bottom right corner; each one opens that conversation in the
 * messenger, and closes itself after a short while.
 *
 * Over a live table the stack moves to the top right, under the header, so it
 * never sits on the action buttons.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { masterBus } from '../../core/MasterBus';
import { leaveForHub } from '../../lib/openExternal';
import { MEDIA_BASE } from '../../utils/mediaBase';
import { formatPopupText } from '../../utils/popupStyle';
import { NEW_MESSAGE_EVENT, useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { toMessageCard, type MessageCard } from './newMessageCard';
import { requestPushNudge } from '../../lib/pushNudgePolicy';
import { useUnreadTabTitle } from './useUnreadTabTitle';
import styles from './NewMessagePopup.module.css';

const MAX_CARDS = 3;
const VISIBLE_MS = 9000;
const MESSENGER_ICON = `${MEDIA_BASE}images/global-header/messenger.png`;

const liveTablesOpen = (): boolean =>
  typeof document !== 'undefined' && Number(document.body?.dataset.caLiveTables ?? '0') > 0;

export default function NewMessagePopup() {
  const [cards, setCards] = useState<MessageCard[]>([]);
  const [overTable, setOverTable] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const unreadMessages = useHeaderDataStore((state) => state.unreadMessages);
  // "(3) Club Arena" in the browser tab while messages wait, so a player on
  // another tab still sees them.
  useUnreadTabTitle(unreadMessages);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setCards((list) => list.filter((card) => card.id !== id));
  }, []);

  useEffect(() => {
    const onMessage = (event: Event) => {
      const card = toMessageCard((event as CustomEvent).detail);
      if (!card) return;
      // A received message is the moment an alert is most obviously useful.
      // The shared policy decides whether the ask may appear: never when this
      // device already has push, the player turned it off or blocked it, or
      // they were asked within the last day.
      requestPushNudge('message_received');
      setOverTable(liveTablesOpen());
      setCards((list) => {
        if (list.some((existing) => existing.id === card.id)) return list;
        const next = [card, ...list];
        for (const dropped of next.slice(MAX_CARDS)) {
          const timer = timers.current.get(dropped.id);
          if (timer) clearTimeout(timer);
          timers.current.delete(dropped.id);
        }
        return next.slice(0, MAX_CARDS);
      });
      timers.current.set(
        card.id,
        setTimeout(() => dismiss(card.id), VISIBLE_MS)
      );
    };
    window.addEventListener(NEW_MESSAGE_EVENT, onMessage);
    const pending = timers.current;
    return () => {
      window.removeEventListener(NEW_MESSAGE_EVENT, onMessage);
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, [dismiss]);

  const open = useCallback(
    (card: MessageCard) => {
      dismiss(card.id);
      useHeaderDataStore.getState().setUnreadMessages(0);
      // With live tables open, a full navigation would unmount them all, so the
      // messenger opens as a hub tab beside them (same rule as the header).
      if (liveTablesOpen()) {
        masterBus.emit('OPEN_HUB_TAB', { path: card.path });
        return;
      }
      leaveForHub(card.path);
    },
    [dismiss]
  );

  if (cards.length === 0 || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={`${styles.stack} ${overTable ? styles.overTable : ''}`}
      role="region"
      aria-live="polite"
      aria-label="New Messages"
    >
      {cards.map((card) => (
        <div key={card.id} className={styles.card}>
          <button
            type="button"
            className={styles.body}
            onClick={() => open(card)}
            aria-label={`Open Message From ${card.sender}`}
          >
            <img
              className={card.avatarUrl ? styles.avatar : styles.icon}
              src={card.avatarUrl || MESSENGER_ICON}
              alt=""
              onError={(event) => {
                const img = event.currentTarget;
                if (img.src.endsWith('messenger.png')) return;
                img.src = MESSENGER_ICON;
                img.className = styles.icon;
              }}
            />
            <span className={styles.text}>
              <span className={styles.sender}>
                {formatPopupText(`Message From ${card.sender}`)}
              </span>
              {card.preview && <span className={styles.preview}>{card.preview}</span>}
              <span className={styles.reply}>Tap To Reply</span>
            </span>
          </button>
          <button
            type="button"
            className={styles.close}
            onClick={() => dismiss(card.id)}
            aria-label="Dismiss Message"
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}
