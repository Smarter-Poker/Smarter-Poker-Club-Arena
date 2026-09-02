/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TableReactions — Animated Floating Emoji Reactions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 6 quick-tap reactions that float up from the player's seat with a
 * scale-rise-fade animation. Rate-limited to 1 per 3 seconds.
 * Broadcast to all players via RoomService.
 */

import React, { useState, useCallback, useRef } from 'react';
import { roomService } from '../../services/RoomService';
import { haptic } from '../../services/SoundService';
import type { ReactionEvent } from '../../hooks/useTableChat';
import './TableReactions.css';

// Re-export for convenience
export type { ReactionEvent };

interface Reaction {
  emoji: string;
  label: string;
}

// ANIMATION AUDIT 2026-08-27: Laugh, Shock and Dead all shared the glyph
// '◆' — React keyed the picker on the glyph (duplicate-key mis-reconcile)
// and the [REACTION:glyph:seat] wire format could not distinguish the three
// on the receiving client. Every reaction now has a unique symbol (plain
// Unicode, per the no-emoji rule).
const REACTIONS: Reaction[] = [
  { emoji: '★', label: 'Clap' },
  { emoji: '◆', label: 'Laugh' },
  { emoji: '✦', label: 'Shock' },
  { emoji: '▲', label: 'Fire' },
  { emoji: '✖', label: 'Dead' },
  { emoji: '♣', label: 'Lucky' },
];

const RATE_LIMIT_MS = 3000;

export interface TableReactionsProps {
  tableId: string | undefined;
  userId: string;
  heroSeat: number;
  isOpen: boolean;
  onClose: () => void;
  // Active floating reactions (received from all players)
  activeReactions: ReactionEvent[];
}

export function TableReactions({
  tableId,
  userId,
  heroSeat,
  isOpen,
  onClose,
  activeReactions,
}: TableReactionsProps) {
  const lastSentRef = useRef(0);

  const handleReaction = useCallback(
    (reaction: Reaction) => {
      const now = Date.now();
      if (now - lastSentRef.current < RATE_LIMIT_MS) return;
      lastSentRef.current = now;

      haptic.medium();

      // Broadcast via room service chat channel (encoded format)
      if (tableId && userId) {
        roomService.sendChat(tableId, userId, `[REACTION:${reaction.emoji}:${heroSeat}]`);
      }

      onClose();
    },
    [tableId, userId, heroSeat, onClose]
  );

  return (
    <>
      {/* Reaction Picker (opens from quick action or seat tap) */}
      {isOpen && (
        <div className="tr-picker-overlay" onClick={onClose}>
          <div className="tr-picker" onClick={(e) => e.stopPropagation()}>
            {REACTIONS.map((r) => (
              <button
                key={r.label}
                className="tr-picker__btn"
                onClick={() => handleReaction(r)}
                title={r.label}
              >
                <span className="tr-picker__emoji">{r.emoji}</span>
                <span className="tr-picker__label">{r.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Floating Reactions — rendered at seat positions */}
      <div className="tr-floating-container" aria-hidden="true">
        {activeReactions.map((event) => (
          <div
            key={event.id}
            className="tr-float"
            style={
              {
                // Position based on seat index (simplified — consumer can override via CSS var)
                '--seat-index': event.seatIndex,
              } as React.CSSProperties
            }
          >
            <span className="tr-float__emoji">{event.emoji}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export default TableReactions;
