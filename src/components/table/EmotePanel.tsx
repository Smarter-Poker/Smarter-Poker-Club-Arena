/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EMOTE PANEL — Emoji Reactions at Table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Quick emote selector for table reactions:
 * - Predefined emoji grid
 * - Animation on send
 * - Cooldown between emotes
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import './EmotePanel.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Emote {
  id: string;
  emoji: string;
  label: string;
}

export interface EmotePanelProps {
  isOpen: boolean;
  onClose: () => void;
  onEmote: (emoteId: string) => void;
  customEmotes?: Emote[];
  cooldownMs?: number;
  position?: { x: number; y: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT EMOTES
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_EMOTES: Emote[] = [
  { id: 'thumbsup', emoji: '', label: 'Nice' },
  { id: 'thumbsdown', emoji: '', label: 'Bad beat' },
  { id: 'clap', emoji: '👏', label: 'Well played' },
  { id: 'fire', emoji: '', label: 'Hot' },
  { id: 'thinking', emoji: '🤔', label: 'Hmm' },
  { id: 'laugh', emoji: '😂', label: 'LOL' },
  { id: 'shocked', emoji: '😱', label: 'OMG' },
  { id: 'cool', emoji: '', label: 'Cool' },
  { id: 'angry', emoji: '😤', label: 'Tilted' },
  { id: 'cry', emoji: '😢', label: 'Sad' },
  { id: 'money', emoji: '', label: 'Ship it' },
  { id: 'trophy', emoji: '', label: 'Winner' },
  { id: 'rocket', emoji: '', label: 'To the moon' },
  { id: 'skull', emoji: '', label: 'Dead' },
  { id: 'wave', emoji: '', label: 'Hi/Bye' },
  { id: 'heart', emoji: '❤️', label: 'Love' },
];

// Quick text emotes
export const QUICK_TEXT_EMOTES = [
  { id: 'nh', text: 'nh', label: 'Nice hand' },
  { id: 'ty', text: 'ty', label: 'Thank you' },
  { id: 'gg', text: 'gg', label: 'Good game' },
  { id: 'gl', text: 'gl', label: 'Good luck' },
  { id: 'vnh', text: 'vnh', label: 'Very nice hand' },
  { id: 'lol', text: 'lol', label: 'Laugh out loud' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function EmotePanel({
  isOpen,
  onClose,
  onEmote,
  customEmotes,
  cooldownMs = 3000,
  position,
}: EmotePanelProps) {
  const [lastEmoteTime, setLastEmoteTime] = useState(0);
  const [animatingEmote, setAnimatingEmote] = useState<string | null>(null);
  const [selectedEmote, setSelectedEmote] = useState<string | null>(null);
  // CA-11 BUG FIX: animTimerRef tracks the 500ms animation-clear timer.
  // Previously fire-and-forget; on rapid panel close/unmount the timer fired
  // setAnimatingEmote(null) / setSelectedEmote(null) on unmounted component.
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
    };
  }, []);

  const emotes = customEmotes || DEFAULT_EMOTES;

  // Force re-render tick during cooldown so countdown text updates and buttons re-enable
  const [, setTick] = useState(0);
  useEffect(() => {
    if (lastEmoteTime === 0) return;
    const remaining = cooldownMs - (Date.now() - lastEmoteTime);
    if (remaining <= 0) return;
    const interval = setInterval(() => {
      const left = cooldownMs - (Date.now() - lastEmoteTime);
      if (left <= 0) {
        clearInterval(interval);
      }
      setTick((t) => t + 1); // Force re-render
    }, 250);
    return () => clearInterval(interval);
  }, [lastEmoteTime, cooldownMs]);

  // Check if on cooldown
  const isOnCooldown = Date.now() - lastEmoteTime < cooldownMs;
  const cooldownRemaining = Math.max(0, cooldownMs - (Date.now() - lastEmoteTime));

  // Handle emote click
  const handleEmote = useCallback(
    (emoteId: string) => {
      if (isOnCooldown) return;

      setAnimatingEmote(emoteId);
      setSelectedEmote(emoteId);
      setLastEmoteTime(Date.now());
      onEmote(emoteId);

      // Clear animations — tracked so unmount can cancel
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      animTimerRef.current = setTimeout(() => {
        animTimerRef.current = null;
        setAnimatingEmote(null);
        setSelectedEmote(null);
      }, 500);
    },
    [isOnCooldown, onEmote]
  );

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="emote-overlay" onClick={onClose}>
      <div
        className="emote-panel emote-panel--entrance"
        onClick={(e) => e.stopPropagation()}
        style={position ? { left: position.x, top: position.y } : undefined}
      >
        {/* Header */}
        <div className="emote-panel__header">
          <span className="emote-panel__title">Send Reaction</span>
          {isOnCooldown && (
            <span className="emote-panel__cooldown">{Math.ceil(cooldownRemaining / 1000)}s</span>
          )}
        </div>

        {/* Emoji Grid */}
        <div className="emote-panel__grid">
          {emotes.map((emote, index) => (
            <button
              key={emote.id}
              className={`emote-panel__emote ${selectedEmote === emote.id ? 'emote-panel__emote--selected' : ''} ${animatingEmote === emote.id ? 'emote-panel__emote--animating' : ''} ${isOnCooldown ? 'emote-panel__emote--disabled' : ''}`}
              onClick={() => handleEmote(emote.id)}
              disabled={isOnCooldown}
              title={emote.label}
              style={{
                animationDelay: `${index * 0.05}s`,
              }}
            >
              {emote.emoji}
            </button>
          ))}
        </div>

        {/* Quick Text */}
        <div className="emote-panel__quick-text">
          {QUICK_TEXT_EMOTES.map((emote) => (
            <button
              key={emote.id}
              className={`emote-panel__text ${isOnCooldown ? 'emote-panel__text--disabled' : ''}`}
              onClick={() => handleEmote(emote.id)}
              disabled={isOnCooldown}
              title={emote.label}
            >
              {emote.text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default EmotePanel;
