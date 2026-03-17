/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LiveActionTicker — Scrolling Activity Feed
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Ported from World Hub → Club Arena (March 2026)
 *
 *  Displays a scrolling ticker of live club activity:
 *  - Tables opening (via MasterBus)
 *  - Tournaments starting (via MasterBus)
 *  - System chat announcements (via Supabase Realtime)
 *  - BBJ milestones (via Supabase Realtime)
 */

import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';

interface TickerMessage {
  id: string;
  text: string;
  type: 'system' | 'action' | 'bbj' | 'info';
  timestamp: number;
}

interface LiveActionTickerProps {
  clubId: string | null;
  primaryColor?: string;
}

export default function LiveActionTicker({
  clubId,
  primaryColor = '#2D88FF',
}: LiveActionTickerProps) {
  const [messages, setMessages] = useState<TickerMessage[]>([
    { id: 'initial', text: 'Welcome to the club!', type: 'system', timestamp: Date.now() },
  ]);

  // Cleanup old messages
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setMessages((prev) => prev.filter((m) => now - m.timestamp < 600000));
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const addMessage = (text: string, type: TickerMessage['type'] = 'info') => {
    setMessages((prev) => {
      const newM: TickerMessage[] = [
        { id: Math.random().toString(36).substring(7), text, type, timestamp: Date.now() },
        ...prev,
      ];
      return newM.slice(0, 10);
    });
  };

  // 1. Listen to MasterBus for immediate optimistic UI updates
  useMasterBusSubscription('TABLE_CREATED', (payload: Record<string, unknown>) => {
    const table = payload.table as Record<string, unknown> | undefined;
    const name = (table?.name as string) || 'A new table';
    const style = (table?.game_type as string) || 'NLH';
    addMessage(`🃏 ${name} (${style}) just opened!`, 'action');
  });

  useMasterBusSubscription('TOURNAMENT_UPDATED', (payload: Record<string, unknown>) => {
    if (payload.status === 'starting') {
      addMessage(`🏆 Tournament approaching start time!`, 'action');
    }
  });

  useMasterBusSubscription('DATA_MUTATED', () => {
    // Reserved for future table action events
  });

  // 2. Listen to Supabase Realtime for Global Network events
  useEffect(() => {
    if (!clubId) return;

    const channelKey = `ticker:${clubId}`;
    const channel = masterBus
      .getOrCreateChannel(channelKey)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'table_chat',
          filter: `message_type=eq.system`,
        },
        (payload) => {
          const msg = payload.new?.message as string | undefined;
          if (msg) addMessage(`📣 ${msg}`, 'system');
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bbj_pools',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          const oldAmt = Number(payload.old?.amount) || 0;
          const newAmt = Number(payload.new?.amount) || 0;
          const thresholds = [10000, 50000, 100000, 500000, 1000000];
          const crossed = thresholds.find((t) => oldAmt < t && newAmt >= t);
          if (crossed) {
            addMessage(
              `🚨 BAD BEAT JACKPOT just crossed ${crossed.toLocaleString()} chips!`,
              'bbj'
            );
          }
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  if (messages.length === 0) return null;

  return (
    <div style={styles.tickerContainer}>
      <div
        style={{
          ...styles.tickerTrack,
          animationDuration: `${Math.max(20, messages.length * 5)}s`,
        }}
      >
        {[...messages, ...messages].map((m, i) => (
          <div key={`${m.id}-${i}`} style={styles.messageItem}>
            <span
              style={{
                ...styles.dot,
                backgroundColor:
                  m.type === 'bbj'
                    ? '#FFD700'
                    : m.type === 'action'
                      ? '#00E676'
                      : m.type === 'system'
                        ? primaryColor
                        : '#B0B3B8',
              }}
            />
            <span
              style={{
                ...styles.text,
                color: m.type === 'bbj' ? '#FFD700' : '#E4E6EB',
                fontWeight: m.type === 'bbj' ? 800 : 600,
              }}
            >
              {m.text}
            </span>
          </div>
        ))}
      </div>
      <div style={styles.fadeLeft} />
      <div style={styles.fadeRight} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  tickerContainer: {
    position: 'relative',
    width: '100%',
    height: '28px',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    marginBottom: '12px',
  },
  tickerTrack: {
    display: 'flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    width: 'max-content',
    animationName: 'tickerScroll',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    paddingLeft: '100%',
  },
  messageItem: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 24px',
    gap: '8px',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    boxShadow: '0 0 4px rgba(255,255,255,0.2)',
  },
  text: {
    fontSize: '11px',
    letterSpacing: '0.3px',
    fontFamily: '"Inter", -apple-system, sans-serif',
  },
  fadeLeft: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '30px',
    background: 'linear-gradient(to right, #000 0%, transparent 100%)',
    zIndex: 2,
    pointerEvents: 'none',
  },
  fadeRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: '30px',
    background: 'linear-gradient(to left, #000 0%, transparent 100%)',
    zIndex: 2,
    pointerEvents: 'none',
  },
};

// Inject keyframes globally once (SSR-safe)
if (typeof document !== 'undefined') {
  const existingStyle = document.getElementById('ticker-scroll-keyframes');
  if (!existingStyle) {
    const style = document.createElement('style');
    style.id = 'ticker-scroll-keyframes';
    style.innerHTML = `
      @keyframes tickerScroll {
        0% { transform: translateX(0); }
        100% { transform: translateX(-50%); }
      }
    `;
    document.head.appendChild(style);
  }
}
