/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EMOTE BROADCAST — Cross-player floating emoji display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Listens for TABLE_EMOTE bus events and displays floating emoji animations.
 * Shows emotes from all players at the table.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './EmoteBroadcast.css';

interface FloatingEmote {
  id: string;
  emoji: string;
  username?: string;
  createdAt: number;
}

// Emote ID → emoji lookup
const EMOTE_MAP: Record<string, string> = {
  thumbsup: '👍',
  thumbsdown: '👎',
  clap: '👏',
  fire: '🔥',
  thinking: '🤔',
  laugh: '😂',
  shocked: '😱',
  cool: '😎',
  angry: '😤',
  cry: '😢',
  money: '💰',
  trophy: '🏆',
  rocket: '🚀',
  skull: '💀',
  wave: '👋',
  heart: '❤️',
  nh: '👍',
  ty: '🙏',
  gg: '🤝',
  gl: '🍀',
  vnh: '👏',
  lol: '😂',
};

interface EmoteBroadcastProps {
  tableId: string;
}

export function EmoteBroadcast({ tableId }: EmoteBroadcastProps) {
  const [floatingEmotes, setFloatingEmotes] = useState<FloatingEmote[]>([]);
  // CA-10 BUG FIX: each emote spawns a 2500ms auto-remove timer. Previously these
  // were fire-and-forget setTimeouts. If the component unmounts while emotes are
  // floating (e.g. user leaves table), all pending setFloatingEmotes calls would
  // fire on an unmounted component. Added emoteTimersRef keyed by emote id.
  const emoteTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Unmount guard — cancel all in-flight emote timers
  useEffect(() => {
    return () => {
      emoteTimersRef.current.forEach(clearTimeout);
      emoteTimersRef.current.clear();
    };
  }, []);

  const addEmote = useCallback((emojiOrId: string, username?: string) => {
    // Support both direct emoji and emote ID lookup
    const emoji = EMOTE_MAP[emojiOrId] || emojiOrId;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setFloatingEmotes((prev) => [
      ...prev.slice(-5),
      { id, emoji, username, createdAt: Date.now() },
    ]);

    // Auto-remove after animation completes — tracked so unmount can cancel
    const timer = setTimeout(() => {
      setFloatingEmotes((prev) => prev.filter((e) => e.id !== id));
      emoteTimersRef.current.delete(id);
    }, 2500);
    emoteTimersRef.current.set(id, timer);
  }, []);

  useMasterBusSubscription('TABLE_EMOTE', (payload) => {
    if (payload?.tableId === tableId) {
      addEmote(payload.emoji || payload.emoteId || '', payload.playerName);
    }
  });

  if (floatingEmotes.length === 0) return null;

  return (
    <div className="emote-broadcast">
      {floatingEmotes.map((emote, index) => (
        <div
          key={emote.id}
          className="emote-broadcast__float"
          style={
            {
              '--float-delay': `${index * 0.1}s`,
              '--float-x': `${30 + Math.random() * 40}%`,
            } as React.CSSProperties
          }
        >
          <span className="emote-broadcast__emoji">{emote.emoji}</span>
          {emote.username && <span className="emote-broadcast__name">{emote.username}</span>}
        </div>
      ))}
    </div>
  );
}

export default EmoteBroadcast;
