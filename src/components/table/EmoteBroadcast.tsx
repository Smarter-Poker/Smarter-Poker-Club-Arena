/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EMOTE BROADCAST — Cross-player floating emoji display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Listens for TABLE_EMOTE bus events and displays floating emoji animations.
 * Shows emotes from all players at the table.
 */

import { useState, useEffect, useCallback } from 'react';
import { masterBus } from '../../core/MasterBus';
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

  const addEmote = useCallback((emojiOrId: string, username?: string) => {
    // Support both direct emoji and emote ID lookup
    const emoji = EMOTE_MAP[emojiOrId] || emojiOrId;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setFloatingEmotes((prev) => [
      ...prev.slice(-5),
      { id, emoji, username, createdAt: Date.now() },
    ]);

    // Auto-remove after animation completes
    setTimeout(() => {
      setFloatingEmotes((prev) => prev.filter((e) => e.id !== id));
    }, 2500);
  }, []);

  useEffect(() => {
    const unsub = masterBus.subscribe('TABLE_EMOTE', (event) => {
      if (event?.payload?.tableId === tableId) {
        addEmote(event.payload.emoji || event.payload.emoteId || '', event.payload.playerName);
      }
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [tableId, addEmote]);

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
