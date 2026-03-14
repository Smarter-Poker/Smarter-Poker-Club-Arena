/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BAD BEAT JACKPOT — Interactive Display Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Ported from World Hub → Club Arena (March 2026)
 *
 *  Used in:
 *    1. Lobby: Clickable banner → opens full modal
 *    2. Table page: Top-center ticker (compact mode)
 *
 *  Tabs: Winner | Basic | Qualifying Hands
 *  Modeled after PokerBros BBJ display
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabase';

const FB = {
  bg: '#18191A',
  card: '#242526',
  cardHover: '#3A3B3C',
  primary: '#2374E1',
  text: '#E4E6EB',
  textSec: '#B0B3B8',
  textMuted: '#65676B',
  border: '#3E4042',
  gold: '#FFD700',
  goldDark: '#B8860B',
  danger: '#FA383E',
  success: '#31A24C',
};

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

interface BBJPool {
  amount: number;
  handsContributed?: number;
}

interface BBJTier {
  label: string;
  blindRange: string;
  feeBB: number;
  payout: { loser: number; winner: number; table: number; total: number };
}

interface BBJWinner {
  id?: string;
  loserName: string;
  loserHand: string;
  winnerHand: string;
  totalPayout?: number;
  awardedAt?: string;
}

interface QualifyingHandInfo {
  description?: string;
}

export interface BBJData {
  pool: BBJPool;
  winners?: BBJWinner[];
  tiers?: Record<string, BBJTier>;
  qualifyingHands?: Record<string, QualifyingHandInfo>;
  rules?: string[];
  hourlyRate?: number;
}

// ═══════════════════════════════════════════════════════════
// ANIMATED COUNTER (Direct DOM Mutation for 60FPS)
// ═══════════════════════════════════════════════════════════
function AnimatedAmount({ amount, hourlyRate = 0 }: { amount: number; hourlyRate?: number }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const targetRef = useRef(amount);
  const displayRef = useRef(amount);

  useEffect(() => {
    targetRef.current = amount;
  }, [amount]);

  useEffect(() => {
    if (hourlyRate <= 0) {
      if (spanRef.current) {
        spanRef.current.textContent = amount.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      }
      return;
    }
    const perSecond = hourlyRate / 3600;
    let frameId: number;

    const tick = () => {
      displayRef.current += perSecond / 60;
      if (displayRef.current > targetRef.current + hourlyRate) {
        displayRef.current = targetRef.current;
      }
      if (spanRef.current) {
        spanRef.current.textContent = displayRef.current.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      }
      frameId = requestAnimationFrame(tick);
    };
    displayRef.current = amount;
    frameId = requestAnimationFrame(tick);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [amount, hourlyRate]);

  return (
    <span ref={spanRef} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════
// BBJ BANNER — Clickable strip for lobby (compact mode)
// ═══════════════════════════════════════════════════════════
export function BBJBanner({
  amount = 0,
  hourlyRate = 0,
  onClick,
}: {
  amount?: number;
  hourlyRate?: number;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '10px 16px',
        marginBottom: 12,
        background: 'linear-gradient(135deg, #1a0a00 0%, #3d1800 30%, #1a0a00 60%, #3d1800 100%)',
        border: '1px solid #8B6914',
        borderRadius: 12,
        cursor: 'pointer',
        boxShadow: '0 2px 12px rgba(255,215,0,0.15), inset 0 1px 0 rgba(255,215,0,0.1)',
      }}
    >
      <span style={{ fontSize: 20 }}>🏆</span>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: FB.goldDark,
            letterSpacing: 2,
            textTransform: 'uppercase',
          }}
        >
          Bad Beat Jackpot
        </div>
        <div
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: FB.gold,
            textShadow: '0 0 10px rgba(255,215,0,0.5), 0 2px 4px rgba(0,0,0,0.5)',
          }}
        >
          <AnimatedAmount amount={amount} hourlyRate={hourlyRate} />
        </div>
      </div>
      <span style={{ fontSize: 10, color: FB.goldDark, fontWeight: 600 }}>TAP FOR INFO ▸</span>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════
// BBJ TICKER — Compact bar for top of table pages
// ═══════════════════════════════════════════════════════════
export function BBJTicker({
  amount = 0,
  hourlyRate = 0,
  onClick,
}: {
  amount?: number;
  hourlyRate?: number;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 14px',
        cursor: 'pointer',
        background: 'linear-gradient(90deg, #2d1000, #4a1a00, #2d1000)',
        border: '1px solid #8B6914',
        borderRadius: 20,
        boxShadow: '0 0 12px rgba(255,215,0,0.2)',
      }}
    >
      <span style={{ fontSize: 12 }}>🏆</span>
      <span style={{ fontSize: 9, color: FB.goldDark, fontWeight: 700, letterSpacing: 1 }}>
        BBJ
      </span>
      <span
        style={{
          fontSize: 15,
          fontWeight: 800,
          color: FB.gold,
          textShadow: '0 0 6px rgba(255,215,0,0.4)',
        }}
      >
        <AnimatedAmount amount={amount} hourlyRate={hourlyRate} />
      </span>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════
// BBJ FULL MODAL — Interactive 3-tab display
// ═══════════════════════════════════════════════════════════
export function BBJModal({ data, onClose }: { data: BBJData | null; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState('basic');
  if (!data) return null;

  const { pool, winners = [], tiers = {}, qualifyingHands = {}, rules = [] } = data;
  const tabs = [
    { key: 'winners', label: 'Winners' },
    { key: 'basic', label: 'Basic' },
    { key: 'qualifying', label: 'Qualifying Hands' },
  ];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 420,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: FB.bg,
          borderRadius: 16,
          border: `1px solid ${FB.border}`,
          boxShadow: '0 0 60px rgba(255,215,0,0.15)',
        }}
      >
        {/* Header */}
        <div
          style={{
            background: 'linear-gradient(135deg, #1a0800 0%, #4a1a00 50%, #1a0800 100%)',
            padding: '20px 20px 16px',
            textAlign: 'center',
            position: 'relative',
            borderRadius: '16px 16px 0 0',
          }}
        >
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 12,
              right: 14,
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              color: FB.text,
              fontSize: 18,
              cursor: 'pointer',
              width: 30,
              height: 30,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>

          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: FB.gold,
              letterSpacing: 2,
              textTransform: 'uppercase',
            }}
          >
            Bad Beat Jackpot
          </div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 900,
              color: FB.gold,
              marginTop: 6,
              textShadow: '0 0 20px rgba(255,215,0,0.5), 0 2px 8px rgba(0,0,0,0.6)',
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 10,
              padding: '6px 20px',
              display: 'inline-block',
              border: '1px solid rgba(255,215,0,0.3)',
            }}
          >
            <AnimatedAmount amount={pool?.amount || 0} hourlyRate={data.hourlyRate || 0} />
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${FB.border}` }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                flex: 1,
                padding: '10px 0',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 700,
                background: activeTab === tab.key ? FB.gold : 'transparent',
                color: activeTab === tab.key ? '#000' : FB.textSec,
                borderRadius: activeTab === tab.key ? '8px 8px 0 0' : 0,
                transition: 'all 0.2s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div style={{ padding: '16px 16px 20px' }}>
          {activeTab === 'basic' && <BasicTab tiers={tiers} rules={rules} />}
          {activeTab === 'winners' && <WinnersTab winners={winners} />}
          {activeTab === 'qualifying' && <QualifyingTab hands={qualifyingHands} />}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// BASIC TAB
// ═══════════════════════════════════════════════════════════
function BasicTab({ tiers, rules }: { tiers: Record<string, BBJTier>; rules: string[] }) {
  return (
    <div>
      <div
        style={{
          marginBottom: 14,
          padding: '10px 12px',
          background: FB.card,
          borderRadius: 8,
          fontSize: 11,
          color: FB.textSec,
          lineHeight: 1.6,
        }}
      >
        {rules.map((rule, i) => (
          <div key={i}>• {rule}</div>
        ))}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${FB.border}` }}>
            {['Stakes', 'Blinds', 'Fee', 'Payout'].map((h) => (
              <th
                key={h}
                style={{
                  padding: '6px 4px',
                  color: FB.textSec,
                  fontWeight: 700,
                  textAlign: h === 'Payout' ? 'left' : 'center',
                  fontSize: 11,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
          <tr style={{ borderBottom: `1px solid ${FB.border}` }}>
            <th colSpan={3} />
            <th
              style={{
                fontSize: 9,
                color: FB.textMuted,
                fontWeight: 600,
                textAlign: 'left',
                padding: '2px 4px',
              }}
            >
              Loser / Winner / Table / Total
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(tiers).map(([key, tier]) => (
            <tr key={key} style={{ borderBottom: `1px solid ${FB.border}20` }}>
              <td
                style={{
                  padding: '8px 4px',
                  color: FB.gold,
                  fontWeight: 700,
                  textAlign: 'center',
                  fontSize: 12,
                }}
              >
                {tier.label}
              </td>
              <td style={{ padding: '8px 4px', color: FB.text, textAlign: 'center', fontSize: 11 }}>
                {tier.blindRange}
              </td>
              <td
                style={{ padding: '8px 4px', color: FB.text, textAlign: 'center', fontWeight: 600 }}
              >
                {tier.feeBB}bb
              </td>
              <td style={{ padding: '8px 4px', color: FB.textSec, fontSize: 11 }}>
                {tier.payout.loser}% / {tier.payout.winner}% / {tier.payout.table}% /{' '}
                {tier.payout.total}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// WINNERS TAB
// ═══════════════════════════════════════════════════════════
function WinnersTab({ winners }: { winners: BBJWinner[] }) {
  if (!winners || winners.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '30px 0', color: FB.textSec }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🏆</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>No jackpot winners yet</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>Be the first to hit the Bad Beat!</div>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: FB.gold,
          textAlign: 'center',
          marginBottom: 12,
        }}
      >
        Last {winners.length} Bad Beat Jackpot Winners
      </div>
      {winners.slice(0, 5).map((w, i) => (
        <div
          key={w.id || i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            marginBottom: 6,
            background: FB.card,
            borderRadius: 10,
            border: `1px solid ${FB.border}`,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              flexShrink: 0,
              background: `linear-gradient(135deg, ${FB.gold}, ${FB.goldDark})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
              fontWeight: 800,
              color: '#000',
            }}
          >
            {(w.loserName || '?')[0].toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: FB.text }}>{w.loserName}</div>
            <div style={{ fontSize: 10, color: FB.textMuted }}>
              {w.loserHand} beaten by {w.winnerHand}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: FB.success }}>
              +{w.totalPayout?.toLocaleString() || '0'}
            </div>
            <div style={{ fontSize: 9, color: FB.textMuted }}>
              {w.awardedAt
                ? new Date(w.awardedAt).toLocaleString('en-US', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// QUALIFYING HANDS TAB
// ═══════════════════════════════════════════════════════════
function QualifyingTab({ hands }: { hands: Record<string, QualifyingHandInfo> }) {
  if (!hands) return null;

  const CARD_IMAGES: Record<string, { label: string; display: string; cards: string[] }> = {
    nlh: { label: 'NLH / FLH', display: 'AAAJJ+', cards: ['A♠', 'A♥', 'A♦', 'J♠', 'J♥'] },
    plo4: { label: 'PLO4 / FLO4', display: 'KKKK+', cards: ['K♠', 'K♥', 'K♦', 'K♣'] },
    plo5: { label: 'PLO5 / FLO5', display: '8-high SF', cards: ['8♠', '7♠', '6♠', '5♠', '4♠'] },
  };

  const suitColor = (s: string) => (s === '♥' || s === '♦' ? '#ef4444' : '#1a1a2e');

  return (
    <div>
      <div style={{ fontSize: 12, color: FB.textSec, marginBottom: 12, lineHeight: 1.5 }}>
        Losing players must have a Minimum Qualifying Hand.{' '}
        <strong style={{ color: FB.text }}>
          Both players must use two cards from their hands.
        </strong>{' '}
        If more than one player loses holding a hand that qualifies for the BBJP prize, the prize
        will be divided proportionally.
      </div>

      {Object.entries(CARD_IMAGES).map(([key, variant]) => {
        const info = hands[key];
        return (
          <div
            key={key}
            style={{
              padding: '14px',
              marginBottom: 10,
              background: FB.card,
              borderRadius: 10,
              border: `1px solid ${FB.border}`,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: FB.text, marginBottom: 4 }}>
              {variant.label}
            </div>
            <div style={{ fontSize: 11, color: FB.textMuted, marginBottom: 10 }}>
              Minimum Qualifying Hand:
            </div>
            <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginBottom: 10 }}>
              {variant.cards.map((c, i) => {
                const rank = c.slice(0, -1);
                const suit = c.slice(-1);
                return (
                  <div
                    key={i}
                    style={{
                      width: 48,
                      height: 66,
                      borderRadius: 6,
                      background: '#fff',
                      border: '2px solid #ddd',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 20,
                        fontWeight: 800,
                        color: suitColor(suit),
                        lineHeight: 1,
                      }}
                    >
                      {rank}
                    </span>
                    <span style={{ fontSize: 18, color: suitColor(suit), lineHeight: 1 }}>
                      {suit}
                    </span>
                  </div>
                );
              })}
            </div>
            {info?.description && (
              <div
                style={{
                  fontSize: 10,
                  color: FB.gold,
                  textAlign: 'center',
                  padding: '6px 8px',
                  background: 'rgba(255,215,0,0.06)',
                  borderRadius: 6,
                  lineHeight: 1.4,
                }}
              >
                {info.description}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// HOOK: useBBJ — Fetch + realtime subscription
// ═══════════════════════════════════════════════════════════
export function useBBJ(clubId: string | null) {
  const [bbjData, setBbjData] = useState<BBJData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBBJ = useCallback(async () => {
    if (!clubId) return;
    try {
      // Direct Supabase query instead of API route
      const { data: pool } = await supabase
        .from('bbj_pools')
        .select('*')
        .eq('club_id', clubId)
        .maybeSingle();

      if (pool) {
        const { data: winners } = await supabase
          .from('bbj_winners')
          .select('*')
          .eq('club_id', clubId)
          .order('awarded_at', { ascending: false })
          .limit(5);

        setBbjData({
          pool: {
            amount: Number(pool.main_balance) || 0,
            handsContributed: Number(pool.hands_contributed) || 0,
          },
          winners: (winners || []).map((w: Record<string, unknown>) => ({
            id: w.id as string,
            loserName: (w.loser_name as string) || 'Unknown',
            loserHand: (w.loser_hand as string) || '',
            winnerHand: (w.winner_hand as string) || '',
            totalPayout: Number(w.total_payout) || 0,
            awardedAt: w.awarded_at as string,
          })),
          hourlyRate: Number(pool.hourly_rate) || 0,
          tiers: (pool.tiers as Record<string, BBJTier>) || {},
          qualifyingHands: (pool.qualifying_hands as Record<string, QualifyingHandInfo>) || {},
          rules: (pool.rules as string[]) || [],
        });
      }
    } catch (err) {
      console.error('[BBJ] Fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    fetchBBJ();
  }, [fetchBBJ]);

  // Realtime subscription for pool updates
  useEffect(() => {
    if (!clubId) return;

    const channel = supabase
      .channel(`bbj:${clubId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bbj_pools',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          setBbjData((prev) =>
            prev
              ? {
                  ...prev,
                  pool: {
                    ...prev.pool,
                    amount: Number(payload.new.main_balance),
                    handsContributed: Number(payload.new.hands_contributed),
                  },
                }
              : prev
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [clubId]);

  return { bbjData, loading, refetch: fetchBBJ };
}

export default BBJModal;
