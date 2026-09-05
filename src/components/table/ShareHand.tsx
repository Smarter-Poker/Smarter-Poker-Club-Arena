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
  /**
   * v3 (2026-09-05) adds the FORCED money and the returned bet. A shared hand
   * used to carry only the six chosen verbs, so every recipient saw a pot that
   * began at the first voluntary action with no blinds in it, and a returned
   * uncalled bet stayed in the pot. `DISCARD` is Crazy Pineapple's thrown card
   * (the card itself is never shared - it is the viewer's own).
   */
  action:
    | 'FOLD'
    | 'CHECK'
    | 'CALL'
    | 'BET'
    | 'RAISE'
    | 'ALL_IN'
    | 'SB'
    | 'BB'
    | 'ANTE'
    | 'STRADDLE'
    | 'POST'
    | 'RETURN'
    | 'DISCARD';
  amount?: number;
}

export interface ShareablePlayer {
  seat: number;
  name: string;
  /**
   * Chips in front of the player. OPTIONAL because not every source knows it —
   * `HandRecord.players` (the saved hand history) carries no stack at all, and
   * HandHistoryPage used to fill in a literal `1000` for every seat, so every
   * shared hand showed fabricated chip counts as if they were fact. Leave it
   * undefined rather than inventing a number; the replayer omits the figure.
   */
  stack?: number;
  cards?: ShareableCard[];
  isWinner?: boolean;
  isHero?: boolean;
}

export interface ShareableHand {
  id: string;
  tableName: string;
  /* The live catalogue is nlh, plo4, plo5, plo6, plo8, short_deck,
     and pineapple. This union named half of it, so PLO8 was
     shared as PLO4 and short deck and both pineapples were shared as NLH.
     Encoded values ride inside a base64 payload, so labels round-trip. */
  variant: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6' | 'PLO8' | 'Short Deck' | 'Crazy Pineapple';
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
const ACTIONS = 'FCXBRA'; // Fold, Call, Check, Bet, Raise, All-in

/**
 * CODEC FIX 2026-08-15 — CHECK was encoded as CALL.
 *
 * The old encoder took the action's FIRST LETTER and looked it up in
 * 'FCXBRA'. 'CHECK'[0] and 'CALL'[0] are both 'C', so both encoded to 'C' —
 * and the decoder maps 'C' to CALL. Every check in every shared hand was
 * replayed to the recipient as a call, which changes the whole reading of the
 * hand. 'X' (the actual check code the decoder expects) was unreachable.
 *
 * Explicit table, no first-letter inference.
 */
const ACTION_CODE: Record<ShareableAction['action'], string> = {
  FOLD: 'F',
  CALL: 'C',
  CHECK: 'X',
  BET: 'B',
  RAISE: 'R',
  ALL_IN: 'A',
  // v3
  SB: 'S',
  BB: 'G',
  ANTE: 'N',
  STRADDLE: 'T',
  POST: 'P',
  RETURN: 'U',
  DISCARD: 'I',
};

const CODE_ACTION: Record<string, ShareableAction['action']> = Object.fromEntries(
  Object.entries(ACTION_CODE).map(([k, v]) => [v, k as ShareableAction['action']])
);

/**
 * MONEY IS IN CENTS ON THE WIRE (v3, 2026-09-05). Every amount, stack, pot and
 * winner share used to be `Math.round(chips)` in base36, so on a 0.02/0.05
 * table every figure in a shared hand rounded to 0 or 1 - a recipient saw
 * "Seat 3 RAISE" with no number, a pot of 0 and winners of 0. v1/v2 payloads
 * still decode as the whole chips they were written as.
 */
const CENTS = 100;
const encodeMoney = (n: number | undefined): string =>
  Math.max(0, Math.round((Number(n) || 0) * CENTS)).toString(36);
const decodeMoney = (s: string | undefined, version: string): number => {
  const raw = parseInt(s || '', 36);
  if (!Number.isFinite(raw)) return 0;
  return version === 'v3' ? raw / CENTS : raw;
};

function encodeAction(action: ShareableAction): string {
  let str = `${action.seat}${ACTION_CODE[action.action] || 'X'}`;
  if (action.amount !== undefined) {
    str += encodeMoney(action.amount);
  }
  return str;
}

function encodeActions(actions: ShareableAction[]): string {
  return actions.map(encodeAction).join(',');
}

/** Shared action-list parser — the old decoder inlined this three times and
 *  still never called it for the turn or the river. */
function decodeActions(str: string | undefined, version: string): ShareableAction[] {
  const out: ShareableAction[] = [];
  if (!str) return out;
  for (const token of str.split(',')) {
    if (token.length < 2) continue;
    const seat = parseInt(token[0], 10);
    if (!Number.isFinite(seat)) continue;
    /* An unknown code is skipped, not read as CHECK. It used to default to
       CHECK, which invented an action the player never took. */
    const verb = CODE_ACTION[token[1]];
    if (!verb) continue;
    const action: ShareableAction = { seat, action: verb };
    if (token.length > 2) {
      const amt = decodeMoney(token.substring(2), version);
      if (Number.isFinite(amt)) action.amount = amt;
    }
    out.push(action);
  }
  return out;
}

/** Split a `cards|actions` street segment; either side may be empty. */
function splitStreet(part: string | undefined): { cards: string; actions: string } | null {
  if (!part || !part.includes('|')) return null;
  const idx = part.indexOf('|');
  return { cards: part.slice(0, idx), actions: part.slice(idx + 1) };
}

/**
 * btoa() throws on any code point above U+00FF, so a single emoji or
 * non-Latin character in a player name (or the table name) blew up the whole
 * encode and the share modal rendered a broken link. UTF-8 first, then base64,
 * padding stripped — '=' inside a ':'-delimited field corrupted the re-pad on
 * the way back out.
 */
function b64utf8(text: string): string {
  try {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=+$/, '');
  } catch {
    return '';
  }
}

function unb64utf8(text: string): string {
  if (!text) return '';
  try {
    const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

// Full hand encoding
export function encodeHand(hand: ShareableHand): string {
  const parts: string[] = [];

  // Version + variant.
  // CODEC FIX 2026-08-15: bumped to v2. v1 dropped the turn, the river, the
  // winners, the table name and the hero/winner flags on the way back out —
  // see decodeHandFromUrl. v1 payloads still decode (there are none in the
  // wild: the /replay route did not exist until today).
  // v3 (2026-09-05): money in cents, forced-money verbs. v1/v2 still decode.
  parts.push('v3');
  parts.push(hand.variant);
  parts.push(hand.stakes.replace('/', '-'));
  parts.push(hand.buttonSeat.toString());
  parts.push(hand.timestamp.toString(36));

  // Players: seat:name:stack:cards:flags
  //   flags — 'h' hero, 'w' winner, 'hw' both, '' neither.
  // v1 truncated the base64 name to 8 chars (≈6 bytes) and lost isHero /
  // isWinner entirely, so a replay could not mark who shared it or who won.
  const playerStr = hand.players
    .map((p) => {
      const flags = `${p.isHero ? 'h' : ''}${p.isWinner ? 'w' : ''}`;
      const cards = p.cards?.length ? encodeCards(p.cards) : '';
      return `${p.seat}:${b64utf8((p.name || '').slice(0, 24))}:${encodeMoney(p.stack)}:${cards}:${flags}`;
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
  parts.push(encodeMoney(hand.potTotal));
  parts.push((hand.winners || []).map((w) => `${w.seat}:${encodeMoney(w.amount)}`).join(';'));
  // v2 field — the table name. v1 hard-coded "Shared Hand" on decode, so the
  // recipient never saw which table the hand came from.
  parts.push(b64utf8((hand.tableName || '').slice(0, 40)));

  // Base64 URL-safe encode. Everything above is ASCII by construction (names
  // are base64'd), so btoa cannot throw here.
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
    const version = parts[0];
    // CODEC FIX 2026-08-15: v1 is still accepted so no link can rot, but v1
    // payloads genuinely do not carry the turn, the river, the winners, the
    // table name or the hero/winner flags — they were never encoded as
    // recoverable fields. v2 does.
    if (version !== 'v1' && version !== 'v2' && version !== 'v3') return null;

    // Parse basic info
    const variant = parts[1] as ShareableHand['variant'];
    const stakes = (parts[2] || '').replace('-', '/');
    const buttonSeat = parseInt(parts[3], 10) || 0;
    const timestamp = parseInt(parts[4], 36) || Date.now();

    // Parse players — v1: seat:name:stack:cards / v2 adds :flags
    const players: ShareablePlayer[] = (parts[5] || '')
      .split(';')
      .filter(Boolean)
      .map((ps) => {
        const [seat, nameB64, stackB36, cardsStr, flags] = ps.split(':');
        const player: ShareablePlayer = {
          seat: parseInt(seat, 10) || 0,
          name: unb64utf8(nameB64) || `Seat ${seat}`,
          stack: decodeMoney(stackB36, version),
        };
        if (cardsStr) player.cards = decodeCards(cardsStr, cardsStr.length);
        if (flags) {
          if (flags.includes('h')) player.isHero = true;
          if (flags.includes('w')) player.isWinner = true;
        }
        return player;
      });

    // Streets. THE BUG: the old decoder parsed preflop and the flop, then
    // jumped straight to building the object — parts[8] (turn) and parts[9]
    // (river) were read by nothing, so every shared hand ended on the flop no
    // matter how it actually played, and parts[11] (winners) was discarded in
    // favour of a hard-coded empty array.
    const preflop = decodeActions(parts[6], version);

    let flop: ShareableHand['flop'];
    const flopSeg = splitStreet(parts[7]);
    if (flopSeg) {
      flop = {
        cards: decodeCards(flopSeg.cards, 3),
        actions: decodeActions(flopSeg.actions, version),
      };
    }

    let turn: ShareableHand['turn'];
    const turnSeg = splitStreet(parts[8]);
    if (turnSeg && turnSeg.cards) {
      turn = {
        card: decodeCard(turnSeg.cards[0]),
        actions: decodeActions(turnSeg.actions, version),
      };
    }

    let river: ShareableHand['river'];
    const riverSeg = splitStreet(parts[9]);
    if (riverSeg && riverSeg.cards) {
      river = {
        card: decodeCard(riverSeg.cards[0]),
        actions: decodeActions(riverSeg.actions, version),
      };
    }

    const winners = (parts[11] || '')
      .split(';')
      .filter(Boolean)
      .map((w) => {
        const [seat, amt] = w.split(':');
        return { seat: parseInt(seat, 10) || 0, amount: decodeMoney(amt, version) };
      });

    // Build hand object
    const hand: ShareableHand = {
      id: encoded.substring(0, 12),
      tableName: unb64utf8(parts[12]) || 'Shared Hand',
      variant,
      stakes,
      timestamp,
      buttonSeat,
      players,
      preflop,
      flop,
      turn,
      river,
      potTotal: decodeMoney(parts[10], version),
      winners,
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
                    <CardImage card={toCard(card)} size="md" />
                  </div>
                ))}
                {hand.turn && (
                  <div className="share-hand__card-img">
                    <CardImage card={toCard(hand.turn.card)} size="md" />
                  </div>
                )}
                {hand.river && (
                  <div className="share-hand__card-img">
                    <CardImage card={toCard(hand.river.card)} size="md" />
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
                  icon: '',
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
            Click The Link To Watch A Video Replay Of This Hand
          </span>
        </div>
      </div>
    </div>
  );
}

export default ShareHand;
