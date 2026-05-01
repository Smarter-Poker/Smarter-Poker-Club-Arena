/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARE HAND — Premium-Style Shareable Hand Replay
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Complete shareable hand replay system:
 * - Encode/decode hand data to URL
 * - Share modal with social options
 * - Permalink generation
 * - Preview card
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import { CardImage, type Card } from '../table/CardImage';
import './ShareHand.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShareableCard {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's';
}

export interface ShareableAction {
  seat: number;
  action: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN';
  amount?: number;
}

export interface ShareablePlayer {
  seat: number;
  name: string;
  stack: number;
  cards?: ShareableCard[];
  isWinner?: boolean;
  isHero?: boolean;
}

export interface ShareableHand {
  id: string;
  tableName: string;
  variant: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6';
  stakes: string; // "1/2", "5/10", etc
  timestamp: number; // Unix timestamp
  buttonSeat: number;
  players: ShareablePlayer[];
  preflop: ShareableAction[];
  flop?: { cards: ShareableCard[]; actions: ShareableAction[] };
  turn?: { card: ShareableCard; actions: ShareableAction[] };
  river?: { card: ShareableCard; actions: ShareableAction[] };
  potTotal: number;
  winners: { seat: number; amount: number }[];
}

export interface ShareHandProps {
  isOpen: boolean;
  onClose: () => void;
  hand: ShareableHand;
  baseUrl?: string;
  clubName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENCODING/DECODING — Compact Base64 URL-safe encoding
// ═══════════════════════════════════════════════════════════════════════════════

// Card encoding: 2 characters per card (rank + suit)
const RANKS = '23456789TJQKA';
const SUITS = 'hdcs';

function encodeCard(card: ShareableCard): string {
  const r = RANKS.indexOf(card.rank.toUpperCase());
  const s = SUITS.indexOf(card.suit);
  return String.fromCharCode(65 + r * 4 + s); // A-Z, a-z encoding
}

function decodeCard(char: string): ShareableCard {
  const code = char.charCodeAt(0) - 65;
  const r = Math.floor(code / 4);
  const s = code % 4;
  return { rank: RANKS[r], suit: SUITS[s] as 'h' | 'd' | 'c' | 's' };
}

function encodeCards(cards: ShareableCard[]): string {
  return cards.map(encodeCard).join('');
}

function decodeCards(str: string, count: number): ShareableCard[] {
  const cards: ShareableCard[] = [];
  for (let i = 0; i < count && i < str.length; i++) {
    cards.push(decodeCard(str[i]));
  }
  return cards;
}

// Action encoding: seat(1) + action(1) + amount(variable)
const ACTIONS = 'FCXBRA'; // Fold, Check, Call, Bet, Raise, All-in

function encodeAction(action: ShareableAction): string {
  const a = ACTIONS.indexOf(action.action[0] === 'A' ? 'A' : action.action[0]);
  let str = `${action.seat}${ACTIONS[a]}`;
  if (action.amount !== undefined) {
    str += action.amount.toString(36); // Base36 for compact numbers
  }
  return str;
}

function encodeActions(actions: ShareableAction[]): string {
  return actions.map(encodeAction).join(',');
}

// Full hand encoding
export function encodeHand(hand: ShareableHand): string {
  const parts: string[] = [];

  // Version + variant
  parts.push('v1');
  parts.push(hand.variant);
  parts.push(hand.stakes.replace('/', '-'));
  parts.push(hand.buttonSeat.toString());
  parts.push(hand.timestamp.toString(36));

  // Players: seat:name:stack:cards
  const playerStr = hand.players
    .map((p) => {
      let ps = `${p.seat}:${btoa(p.name).substring(0, 8)}:${p.stack.toString(36)}`;
      if (p.cards) ps += ':' + encodeCards(p.cards);
      return ps;
    })
    .join(';');
  parts.push(playerStr);

  // Actions per street
  parts.push(encodeActions(hand.preflop));

  if (hand.flop) {
    parts.push(encodeCards(hand.flop.cards) + '|' + encodeActions(hand.flop.actions));
  } else {
    parts.push('');
  }

  if (hand.turn) {
    parts.push(encodeCard(hand.turn.card) + '|' + encodeActions(hand.turn.actions));
  } else {
    parts.push('');
  }

  if (hand.river) {
    parts.push(encodeCard(hand.river.card) + '|' + encodeActions(hand.river.actions));
  } else {
    parts.push('');
  }

  // Pot and winners
  parts.push(hand.potTotal.toString(36));
  parts.push(hand.winners.map((w) => `${w.seat}:${w.amount.toString(36)}`).join(';'));

  // Base64 URL-safe encode
  const encoded = btoa(parts.join('~')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return encoded;
}

export function decodeHandFromUrl(encoded: string): ShareableHand | null {
  try {
    // Restore Base64
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const decoded = atob(base64);

    const parts = decoded.split('~');
    if (parts[0] !== 'v1') return null;

    // Parse basic info
    const variant = parts[1] as ShareableHand['variant'];
    const stakes = parts[2].replace('-', '/');
    const buttonSeat = parseInt(parts[3]);
    const timestamp = parseInt(parts[4], 36);

    // Parse players
    const players: ShareablePlayer[] = parts[5].split(';').map((ps) => {
      const [seat, nameB64, stackB36, cardsStr] = ps.split(':');
      const player: ShareablePlayer = {
        seat: parseInt(seat),
        name: atob(nameB64 + '=='.substring(0, (4 - (nameB64.length % 4)) % 4)),
        stack: parseInt(stackB36, 36),
      };
      if (cardsStr) player.cards = decodeCards(cardsStr, cardsStr.length);
      return player;
    });

    // Parse preflop actions from parts[6]
    const preflop: ShareableAction[] = [];
    if (parts[6]) {
      const actionStrings = parts[6].split(',');
      for (const actionStr of actionStrings) {
        if (actionStr.length >= 2) {
          const seat = parseInt(actionStr[0]);
          const actionCode = actionStr[1];
          const actionMap: Record<string, ShareableAction['action']> = {
            F: 'FOLD',
            C: 'CALL',
            X: 'CHECK',
            B: 'BET',
            R: 'RAISE',
            A: 'ALL_IN',
          };
          const action: ShareableAction = {
            seat,
            action: actionMap[actionCode] || 'CHECK',
          };
          if (actionStr.length > 2) {
            action.amount = parseInt(actionStr.substring(2), 36);
          }
          preflop.push(action);
        }
      }
    }

    // Parse flop if present (parts[7])
    let flop: ShareableHand['flop'] = undefined;
    if (parts[7] && parts[7].includes('|')) {
      const [cardsStr, actionsStr] = parts[7].split('|');
      const flopCards = decodeCards(cardsStr, 3);
      const flopActions: ShareableAction[] = [];
      // Parse flop actions similar to preflop
      if (actionsStr) {
        const actionStrings = actionsStr.split(',');
        for (const actionStr of actionStrings) {
          if (actionStr.length >= 2) {
            const seat = parseInt(actionStr[0]);
            const actionCode = actionStr[1];
            const actionMap: Record<string, ShareableAction['action']> = {
              F: 'FOLD',
              C: 'CALL',
              X: 'CHECK',
              B: 'BET',
              R: 'RAISE',
              A: 'ALL_IN',
            };
            flopActions.push({
              seat,
              action: actionMap[actionCode] || 'CHECK',
              amount: actionStr.length > 2 ? parseInt(actionStr.substring(2), 36) : undefined,
            });
          }
        }
      }
      flop = { cards: flopCards, actions: flopActions };
    }

    // Build hand object
    const hand: ShareableHand = {
      id: encoded.substring(0, 12),
      tableName: 'Shared Hand',
      variant,
      stakes,
      timestamp,
      buttonSeat,
      players,
      preflop,
      flop,
      potTotal: parseInt(parts[10], 36) || 0,
      winners: [],
    };

    return hand;
  } catch (e) {
    reportError(e, 'ShareHand.Failed_to_decode_hand');
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert ShareableCard to CardImage Card type.
 */
function toCard(sc: ShareableCard): Card {
  let rank = sc.rank;
  if (rank === '10') rank = 'T';
  return { rank: rank as Card['rank'], suit: sc.suit as Card['suit'] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ShareHand({
  isOpen,
  onClose,
  hand,
  baseUrl = 'https://smarter.poker/hub/club-arena/replay',
  clubName = 'Smarter Poker',
}: ShareHandProps) {
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [copied, setCopied] = useState(false);
  // CA-2 BUG FIX: track the "Copied" dismiss timer so it can be cancelled on
  // unmount — was calling setCopied on an already-unmounted component.
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTab, setActiveTab] = useState<'link' | 'social' | 'embed'>('link');
  const [visibleSocial, setVisibleSocial] = useState<boolean[]>([]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      staggerTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  // Generate shareable URL
  const shareUrl = useMemo(() => {
    const encoded = encodeHand(hand);
    return `${baseUrl}?h=${encoded}`;
  }, [hand, baseUrl]);

  // Social share text
  const shareText = useMemo(() => {
    const hero = hand.players.find((p) => p.isHero);
    const winner = hand.players.find((p) => p.isWinner);
    const potStr = `${hand.potTotal.toLocaleString()}`;

    if (winner?.isHero) {
      return `I just won a ${potStr} pot in ${hand.stakes} ${hand.variant}! \n\nWatch the replay on ${clubName}! `;
    }
    return `Check out this ${potStr} pot hand from ${hand.stakes} ${hand.variant}!\n\nWatch the video replay on ${clubName}! `;
  }, [hand, clubName]);

  // Copy link
  const handleCopy = useCallback(async () => {
    haptic.light();
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      clearTimeout(copiedTimerRef.current!);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      reportError(error, 'ShareHand.Copy_failed');
    }
  }, [shareUrl]);

  // Share to social platforms
  const handleSocialShare = useCallback(
    (platform: 'twitter' | 'facebook' | 'telegram' | 'whatsapp') => {
      const encodedUrl = encodeURIComponent(shareUrl);
      const encodedText = encodeURIComponent(shareText);

      const urls = {
        twitter: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedText}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
        telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
        whatsapp: `https://wa.me/?text=${encodedText}%0A%0A${encodedUrl}`,
      };

      window.open(urls[platform], '_blank', 'width=600,height=400');
    },
    [shareUrl, shareText]
  );

  // Native share (mobile)
  const handleNativeShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Hand Replay - ' + clubName,
          text: shareText,
          url: shareUrl,
        });
      } catch (error) {
        reportError(error, 'ShareHand.Share_failed');
      }
    }
  }, [shareText, shareUrl, clubName]);

  // Embed code
  const embedCode = useMemo(() => {
    return `<iframe src="${shareUrl}&embed=true" width="400" height="300" frameborder="0" allowfullscreen></iframe>`;
  }, [shareUrl]);

  useEffect(() => {
    if (activeTab === 'social') {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
      setVisibleSocial([]);
      staggerTimersRef.current.push(
        ...[0, 1, 2, 3].map((i) =>
          setTimeout(() => setVisibleSocial((prev) => [...prev, true]), i * 50)
        )
      );
    }
  }, [activeTab]);

  if (!isOpen) return null;

  return (
    <div className="share-hand-overlay" onClick={onClose}>
      <div className="share-hand-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="share-hand__header">
          <h2 className="share-hand__title"> Share Hand</h2>
          <button className="share-hand__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Preview Card */}
        <div className="share-hand__preview">
          <div className="share-hand__preview-header">
            <span className="share-hand__variant">{hand.variant}</span>
            <span className="share-hand__stakes">{hand.stakes}</span>
          </div>

          {/* Board Preview — Custom PNG Deck */}
          <div className="share-hand__board">
            {hand.flop && (
              <div className="share-hand__cards">
                {hand.flop.cards.map((card, i) => (
                  <div key={i} className="share-hand__card-img">
                    <CardImage card={toCard(card)} deckStyle="4color" size="sm" />
                  </div>
                ))}
                {hand.turn && (
                  <div className="share-hand__card-img">
                    <CardImage card={toCard(hand.turn.card)} deckStyle="4color" size="sm" />
                  </div>
                )}
                {hand.river && (
                  <div className="share-hand__card-img">
                    <CardImage card={toCard(hand.river.card)} deckStyle="4color" size="sm" />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="share-hand__pot">
            <span className="share-hand__pot-label">Pot</span>
            <span className="share-hand__pot-value">{hand.potTotal.toLocaleString()}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="share-hand__tabs">
          <button
            className={`share-hand__tab ${activeTab === 'link' ? 'share-hand__tab--active' : ''}`}
            onClick={() => setActiveTab('link')}
          >
            Link
          </button>
          <button
            className={`share-hand__tab ${activeTab === 'social' ? 'share-hand__tab--active' : ''}`}
            onClick={() => setActiveTab('social')}
          >
            Social
          </button>
          <button
            className={`share-hand__tab ${activeTab === 'embed' ? 'share-hand__tab--active' : ''}`}
            onClick={() => setActiveTab('embed')}
          >
            Embed
          </button>
        </div>

        {/* Tab Content */}
        <div className="share-hand__content">
          {activeTab === 'link' && (
            <div className="share-hand__link-tab">
              <div className="share-hand__url-box">
                <input type="text" value={shareUrl} readOnly className="share-hand__url-input" />
                <button
                  className={`share-hand__copy-btn ${copied ? 'share-hand__copy-btn--success' : ''}`}
                  onClick={handleCopy}
                >
                  {copied ? '' : ''}
                </button>
              </div>

              {'share' in navigator && (
                <button className="share-hand__native-share" onClick={handleNativeShare}>
                  Share
                </button>
              )}
            </div>
          )}

          {activeTab === 'social' && (
            <div className="share-hand__social-tab">
              {[
                {
                  platform: 'twitter',
                  icon: '𝕏',
                  label: 'Twitter / X',
                  className: 'share-hand__social-btn--twitter',
                },
                {
                  platform: 'facebook',
                  icon: 'f',
                  label: 'Facebook',
                  className: 'share-hand__social-btn--facebook',
                },
                {
                  platform: 'telegram',
                  icon: '✈',
                  label: 'Telegram',
                  className: 'share-hand__social-btn--telegram',
                },
                {
                  platform: 'whatsapp',
                  icon: '',
                  label: 'WhatsApp',
                  className: 'share-hand__social-btn--whatsapp',
                },
              ].map((social, idx) => (
                <button
                  key={social.platform}
                  className={`share-hand__social-btn ${social.className}`}
                  onClick={() =>
                    handleSocialShare(
                      social.platform as 'twitter' | 'facebook' | 'telegram' | 'whatsapp'
                    )
                  }
                  style={{
                    opacity: visibleSocial[idx] ? 1 : 0,
                    transform: visibleSocial[idx] ? 'scale(1)' : 'scale(0.9)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span className="share-hand__social-icon">{social.icon}</span>
                  {social.label}
                </button>
              ))}
            </div>
          )}

          {activeTab === 'embed' && (
            <div className="share-hand__embed-tab">
              <textarea className="share-hand__embed-code" value={embedCode} readOnly rows={3} />
              <button
                className="share-hand__copy-embed"
                onClick={() => navigator.clipboard.writeText(embedCode)}
              >
                Copy Embed Code
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="share-hand__footer">
          <span className="share-hand__footer-text">
            Click the link to watch a video replay of this hand
          </span>
        </div>
      </div>
    </div>
  );
}

export default ShareHand;
