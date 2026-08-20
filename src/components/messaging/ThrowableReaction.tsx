/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ THROWABLE REACTION — Q3 Social Upgrade (Phase 2: Social Richness)
 *
 * Animated SVG reactions that fly across the screen from sender to target.
 * Inspired by premium throwable emojis and ClubGG's 3D animated reactions.
 * Uses CSS @keyframes for performant GPU-accelerated flight animations.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { haptic } from '../../services/HapticService';
import { soundService } from '../../services/SoundService';
import './ThrowableReaction.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ThrowableEmoji {
  id: string;
  emoji: string;
  label: string;
  category: 'free' | 'vip';
}

export interface ActiveThrowable {
  id: string;
  emoji: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startTime: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THROWABLE LIBRARY
// ═══════════════════════════════════════════════════════════════════════════════

export const THROWABLE_EMOJIS: ThrowableEmoji[] = [
  // Free tier
  { id: 'thumbs-up', emoji: '▲', label: 'Nice Hand', category: 'free' },
  { id: 'clap', emoji: '★', label: 'Well Played', category: 'free' },
  { id: 'fire', emoji: '▲', label: 'On Fire', category: 'free' },
  { id: 'trophy', emoji: '★', label: 'Champion', category: 'free' },
  { id: 'rocket', emoji: '▲', label: 'To The Moon', category: 'free' },
  { id: 'laugh', emoji: '◆', label: 'LOL', category: 'free' },
  { id: 'eyes', emoji: '◉', label: 'Watching', category: 'free' },
  { id: 'skull', emoji: '◆', label: 'Rekt', category: 'free' },
  // VIP tier
  { id: 'diamond', emoji: '◆', label: 'Diamond', category: 'vip' },
  { id: 'crown', emoji: '♛', label: 'Crown', category: 'vip' },
  { id: 'money-bag', emoji: '◆', label: 'Money Bag', category: 'vip' },
  { id: 'spade', emoji: '♠', label: 'Spade', category: 'vip' },
  { id: 'shark', emoji: '◆', label: 'Shark', category: 'vip' },
  { id: 'bomb', emoji: '◆', label: 'Bomb', category: 'vip' },
  { id: 'lightning', emoji: '▲', label: 'Lightning', category: 'vip' },
  { id: 'tornado', emoji: '◆', label: 'Tornado', category: 'vip' },
];

const ANIMATION_DURATION_MS = 1200;

// ═══════════════════════════════════════════════════════════════════════════════
// THROWABLE PICKER (Selection UI)
// ═══════════════════════════════════════════════════════════════════════════════

interface ThrowablePickerProps {
  isOpen: boolean;
  onSelect: (emoji: ThrowableEmoji) => void;
  onClose: () => void;
  isVip?: boolean;
}

export const ThrowablePicker: React.FC<ThrowablePickerProps> = ({
  isOpen,
  onSelect,
  onClose,
  isVip = false,
}) => {
  if (!isOpen) return null;

  const availableEmojis = isVip
    ? THROWABLE_EMOJIS
    : THROWABLE_EMOJIS.filter((e) => e.category === 'free');

  return (
    <>
      <div className="throwable-overlay" onClick={onClose} />
      <div className="throwable-picker">
        <div className="throwable-picker-header">
          <span>Send Reaction</span>
          <button className="throwable-picker-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="throwable-grid">
          {availableEmojis.map((emoji) => (
            <button
              key={emoji.id}
              className="throwable-item"
              onClick={() => {
                // ANIMATION/SOUND AUDIT 2026-08-20: this used to play the
                // IMPACT thud here — at the instant of PICKING, a full
                // ANIMATION_DURATION_MS before the object hit anything. The
                // impact now fires when the flight ends (see FlyingEmoji), for
                // everyone watching rather than only the sender. This moment
                // gets the launch whoosh, and a light tap instead of `heavy`
                // so the emphasis lands on the impact where it belongs.
                haptic.light();
                soundService.playThrowableLaunch();
                onSelect(emoji);
                onClose();
              }}
              title={emoji.label}
            >
              <span className="throwable-emoji">{emoji.emoji}</span>
              <span className="throwable-label">{emoji.label}</span>
            </button>
          ))}
        </div>
        {!isVip && (
          <div className="throwable-vip-upsell">
            Unlock {THROWABLE_EMOJIS.filter((e) => e.category === 'vip').length} more with VIP
          </div>
        )}
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// THROWABLE ANIMATION LAYER (renders flying emojis)
// ═══════════════════════════════════════════════════════════════════════════════

interface ThrowableLayerProps {
  throwables: ActiveThrowable[];
  onComplete: (id: string) => void;
}

export const ThrowableLayer: React.FC<ThrowableLayerProps> = ({ throwables, onComplete }) => {
  return (
    <div className="throwable-layer" aria-hidden="true">
      {throwables.map((t) => (
        <FlyingEmoji key={t.id} throwable={t} onComplete={onComplete} />
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// FLYING EMOJI (individual animated element)
// ═══════════════════════════════════════════════════════════════════════════════

interface FlyingEmojiProps {
  throwable: ActiveThrowable;
  onComplete: (id: string) => void;
}

const FlyingEmoji: React.FC<FlyingEmojiProps> = ({ throwable, onComplete }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // ANIMATION/SOUND AUDIT 2026-08-20: the flight used to be SILENT for
    // everyone. The impact thud was played by the picker, which only the
    // sender ever opens — so every other player at the table watched the
    // object land with no sound at all, and the sender heard it ~1.2s early.
    //
    // The impact belongs here: this component renders for every viewer, and
    // this is the moment the object actually arrives. Fired a beat before the
    // element is removed so the sound lands with the visual, not after it.
    const IMPACT_LEAD_MS = 60;
    const impactTimer = setTimeout(
      () => {
        soundService.playThrowableImpact();
      },
      Math.max(0, ANIMATION_DURATION_MS - IMPACT_LEAD_MS)
    );

    const timer = setTimeout(() => {
      onComplete(throwable.id);
    }, ANIMATION_DURATION_MS);

    return () => {
      clearTimeout(impactTimer);
      clearTimeout(timer);
    };
  }, [throwable.id, onComplete]);

  const dx = throwable.toX - throwable.fromX;
  const dy = throwable.toY - throwable.fromY;

  return (
    <div
      ref={ref}
      className="flying-emoji"
      style={
        {
          left: throwable.fromX,
          top: throwable.fromY,
          '--fly-dx': `${dx}px`,
          '--fly-dy': `${dy}px`,
          animationDuration: `${ANIMATION_DURATION_MS}ms`,
        } as React.CSSProperties
      }
    >
      <span className="flying-emoji-text">{throwable.emoji}</span>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK: useThrowableReactions
// ═══════════════════════════════════════════════════════════════════════════════

export function useThrowableReactions() {
  const [activeThrowables, setActiveThrowables] = useState<ActiveThrowable[]>([]);
  const counterRef = useRef(0);

  const throwReaction = useCallback(
    (emoji: string, fromX: number, fromY: number, toX: number, toY: number) => {
      const id = `throw-${counterRef.current++}-${Date.now()}`;
      const throwable: ActiveThrowable = {
        id,
        emoji,
        fromX,
        fromY,
        toX,
        toY,
        startTime: Date.now(),
      };
      setActiveThrowables((prev) => [...prev, throwable]);
    },
    []
  );

  const handleComplete = useCallback((id: string) => {
    setActiveThrowables((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return {
    activeThrowables,
    throwReaction,
    handleComplete,
  };
}

export default ThrowablePicker;
