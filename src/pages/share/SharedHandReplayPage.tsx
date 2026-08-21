/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARED HAND REPLAY — /replay?h=<encoded>
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * VISIBLE FIX 2026-08-15: every shared-hand link was a 404.
 *
 * ShareHand builds links as `/hub/club-arena/replay?h=<base64>` — copy link,
 * Twitter, Facebook, Telegram, WhatsApp, native share and the iframe embed all
 * used it — but no `/replay` route existed, so every one of them fell through
 * to the SPA catch-all 404. The only real route, `/share/hand/:handId`, reads
 * `hand_history` directly, whose RLS restricts SELECT to hand participants —
 * so even a corrected link showed "Hand Not Found" to the person it was
 * shared with, which is everyone.
 *
 * Decoding the payload that already travels inside the link fixes both at
 * once: the route exists, and the viewer needs no database read at all, so a
 * recipient who never played the hand (or is logged out) can watch it.
 */

import React, { useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { decodeHandFromUrl, type ShareableHand } from '../../components/table/ShareHand';

const SUIT_GLYPH: Record<string, string> = { h: '♥', d: '♦', c: '♣', s: '♠' };
const SUIT_RED = (suit: string) => suit === 'h' || suit === 'd';

function Card({ card }: { card: { rank: string; suit: string } }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 34,
        padding: '6px 8px',
        margin: '0 3px',
        borderRadius: 6,
        background: '#fff',
        color: SUIT_RED(card.suit) ? '#d32029' : '#111',
        fontWeight: 800,
        fontSize: '1rem',
        boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
      }}
    >
      {card.rank}
      {SUIT_GLYPH[card.suit] ?? card.suit}
    </span>
  );
}

function Street({
  label,
  cards,
  actions,
}: {
  label: string;
  cards?: Array<{ rank: string; suit: string }>;
  actions?: Array<{ seat: number; action: string; amount?: number }>;
}) {
  if (!actions?.length && !cards?.length) return null;
  return (
    <section style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: '0.8rem', letterSpacing: 1, opacity: 0.7 }}>
        {label.toUpperCase()}
      </h3>
      {!!cards?.length && (
        <div style={{ marginBottom: 8 }}>
          {cards.map((c, i) => (
            <Card key={i} card={c} />
          ))}
        </div>
      )}
      {actions?.map((a, i) => (
        <div key={i} style={{ fontSize: '0.85rem', opacity: 0.9 }}>
          Seat {a.seat} - {a.action}
          {a.amount ? ` ${a.amount.toLocaleString()}` : ''}
        </div>
      ))}
    </section>
  );
}

export default function SharedHandReplayPage() {
  const [params] = useSearchParams();
  const encoded = params.get('h');

  const hand: ShareableHand | null = useMemo(
    () => (encoded ? decodeHandFromUrl(encoded) : null),
    [encoded]
  );

  if (!hand) {
    return (
      <div style={{ padding: 32, color: '#fff', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.3rem' }}>This replay link is not readable</h1>
        <p style={{ opacity: 0.75 }}>
          The link may have been truncated when it was copied. Ask for it again, or open the hand
          from your own Hand History.
        </p>
        <Link to="/" style={{ color: '#ffd700' }}>
          Go to the lobby
        </Link>
      </div>
    );
  }

  const hero = hand.players.find((p) => p.isHero);

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 20, color: '#fff' }}>
      <header style={{ borderBottom: '1px solid rgba(255,255,255,0.14)', paddingBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>{hand.tableName || 'Shared hand'}</h1>
        <div style={{ opacity: 0.7, fontSize: '0.85rem' }}>
          {hand.variant} · {hand.stakes} ·{' '}
          {hand.timestamp ? new Date(hand.timestamp).toLocaleString() : ''}
        </div>
      </header>

      <div
        style={{
          marginTop: 16,
          padding: '12px 14px',
          borderRadius: 10,
          background: 'rgba(255,215,0,0.08)',
          border: '1px solid rgba(255,215,0,0.25)',
        }}
      >
        <strong style={{ color: '#ffd700' }}>Pot {hand.potTotal.toLocaleString()}</strong>
        {!!hand.winners?.length && (
          <div style={{ fontSize: '0.85rem', opacity: 0.9 }}>
            Won by{' '}
            {hand.winners
              .map((w) => `seat ${w.seat} (${w.amount.toLocaleString()})`)
              .join(', ')}
          </div>
        )}
      </div>

      <section style={{ marginTop: 18 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: '0.8rem', letterSpacing: 1, opacity: 0.7 }}>
          PLAYERS
        </h3>
        {hand.players.map((p) => (
          <div
            key={p.seat}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 0',
              fontWeight: p.isHero ? 700 : 400,
            }}
          >
            <span style={{ minWidth: 58, opacity: 0.65 }}>Seat {p.seat}</span>
            <span style={{ flex: 1 }}>
              {p.name}
              {p.isHero ? ' (hero)' : ''}
              {p.isWinner ? ' ★' : ''}
            </span>
            {!!p.cards?.length && (
              <span>
                {p.cards.map((c, i) => (
                  <Card key={i} card={c} />
                ))}
              </span>
            )}
          </div>
        ))}
      </section>

      <Street label="Preflop" actions={hand.preflop} />
      <Street label="Flop" cards={hand.flop?.cards} actions={hand.flop?.actions} />
      <Street
        label="Turn"
        cards={hand.turn?.card ? [hand.turn.card] : undefined}
        actions={hand.turn?.actions}
      />
      <Street
        label="River"
        cards={hand.river?.card ? [hand.river.card] : undefined}
        actions={hand.river?.actions}
      />

      <footer style={{ marginTop: 28, opacity: 0.6, fontSize: '0.8rem' }}>
        {hero ? `Shared from ${hero.name}'s hand history · ` : ''}Smarter Poker
      </footer>
    </div>
  );
}
