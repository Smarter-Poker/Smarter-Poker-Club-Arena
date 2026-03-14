/**
 * GameLobbyGrid — Two-column responsive grid for game lobby
 * Ported from Hub's GameLobbyGrid.jsx → CA TSX
 *
 * Differences from Hub:
 *  - Uses direct Supabase queries instead of Hub API routes
 *  - Uses masterBus instead of useMiniStatePoller hook
 *  - Filters: All | Hold'em | Omaha | Mixed | MTT | Spin-It | SNG
 *  - Polling every 15s for real-time updates
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import haptic from '../../utils/haptic';

const TABS = [
  { id: 'all', label: 'ALL' },
  { id: 'holdem', label: "Hold'em" },
  { id: 'omaha', label: 'Omaha' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'mtt', label: 'MTT' },
  { id: 'spin', label: 'Spin-It' },
  { id: 'sng', label: 'SNG' },
];

const HOLDEM_VARIANTS = new Set(['nlh', 'flh', 'short_deck']);
const OMAHA_VARIANTS = new Set(['plo4', 'plo5', 'plo6', 'plo8', 'flo']);
const MIXED_VARIANTS = new Set(['mixed', 'ofc']);

interface GameRow {
  id: string;
  name?: string;
  game_variant?: string;
  variant?: string;
  game_type?: string;
  type?: string;
  status?: string;
  current_players?: number;
  registered_count?: number;
  max_players?: number;
  label_new?: boolean;
  [key: string]: any;
}

function matchesTab(game: GameRow, tabId: string): boolean {
  if (tabId === 'all') return true;
  const v = game.game_variant || game.variant || '';
  const gt = game.game_type || game.type || '';
  switch (tabId) {
    case 'holdem':
      return HOLDEM_VARIANTS.has(v) && gt !== 'mtt' && gt !== 'sng' && gt !== 'spin';
    case 'omaha':
      return OMAHA_VARIANTS.has(v) && gt !== 'mtt' && gt !== 'sng' && gt !== 'spin';
    case 'mixed':
      return MIXED_VARIANTS.has(v) && gt !== 'mtt' && gt !== 'sng' && gt !== 'spin';
    case 'mtt':
      return gt === 'mtt' || gt === 'tournament';
    case 'spin':
      return gt === 'spin' || v === 'spin';
    case 'sng':
      return gt === 'sng';
    // New tab logic based on the provided diff's TABS array
    case 'cash':
      return (gt === 'cash' || gt === 'ring') && !['mtt', 'sng', 'spin'].includes(gt);
    case 'tourn':
      return gt === 'mtt' || gt === 'tournament';
    default:
      return true;
  }
}

function sortGames(games: GameRow[]) {
  return games.sort((a, b) => {
    const statusOrder = { running: 0, active: 0, waiting: 1, REGISTERING: 1, RUNNING: 0 };
    const sa = (statusOrder as any)[a.status || ''] ?? 2;
    const sb = (statusOrder as any)[b.status || ''] ?? 2;
    if (sa !== sb) return sa - sb;
    return (
      (b.current_players || b.registered_count || 0) -
      (a.current_players || a.registered_count || 0)
    );
  });
}

interface GameLobbyGridProps {
  clubId: string;
  onGamePress?: (game: GameRow) => void;
  pollMs?: number;
}

export default function GameLobbyGrid({ clubId, onGamePress }: GameLobbyGridProps) {
  const [activeTab, setActiveTab] = useState('all');
  const [games, setGames] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  const loadGames = useCallback(async () => {
    if (!clubId) return;
    try {
      const [tablesRes, tourneysRes] = await Promise.all([
        supabase.from('tables').select('*').eq('club_id', clubId).neq('status', 'deleted'),
        supabase.from('tournaments').select('*').eq('club_id', clubId).neq('status', 'deleted'),
      ]);
      const tables = tablesRes.data || [];
      const tournaments = tourneysRes.data || [];
      if (isMounted.current) {
        setGames(sortGames([...tables, ...tournaments]));
        setError(null);
      }
    } catch (e: any) {
      if (isMounted.current) setError(e.message || 'Failed to load games');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId]);

  // Initial load + realtime subscriptions
  useEffect(() => {
    loadGames();

    // Realtime: postgres_changes for tables + tournaments
    const channelKey = `game-grid-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tables',
          filter: `club_id=eq.${clubId}`,
        },
        () => {
          loadGames();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournaments',
          filter: `club_id=eq.${clubId}`,
        },
        () => {
          loadGames();
        }
      )
      .subscribe();

    // MasterBus listeners for cross-page events
    const unsubs = [
      masterBus.subscribeDebounced('TABLE_CREATED', loadGames, 500),
      masterBus.subscribeDebounced('TABLE_UPDATED', loadGames, 500),
      masterBus.subscribeDebounced('TABLE_DELETED', loadGames, 500),
      masterBus.subscribeDebounced('TOURNAMENT_UPDATED', loadGames, 500),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', loadGames, 500),
    ];

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubs.forEach((u) => u());
    };
  }, [loadGames, clubId]);

  const visible = games.filter((g) => matchesTab(g, activeTab));
  const countForTab = (id: string) =>
    id === 'all' ? games.length : games.filter((g) => matchesTab(g, id)).length;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#0e1015',
        fontFamily: 'Inter, -apple-system, sans-serif',
      }}
    >
      {/* Filter Tabs */}
      <div
        style={{
          background: '#16181d',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', overflowX: 'auto', scrollbarWidth: 'none', gap: 0 }}>
          {TABS.map((tab) => {
            const count = countForTab(tab.id);
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  haptic('light');
                  setActiveTab(tab.id);
                }}
                style={{
                  flexShrink: 0,
                  padding: '10px 12px',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  transition: 'color 0.15s, background 0.15s',
                  whiteSpace: 'nowrap',
                  background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: active ? '#fff' : 'rgba(255,255,255,0.45)',
                  borderBottom: active ? '2px solid #F5A623' : '2px solid transparent',
                }}
              >
                {tab.label}
                {count > 0 && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      borderRadius: 8,
                      padding: '1px 5px',
                      minWidth: 16,
                      textAlign: 'center',
                      background: active ? '#F5A623' : 'rgba(255,255,255,0.15)',
                      color: active ? '#000' : 'rgba(255,255,255,0.6)',
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {loading ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: 60,
              gap: 8,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                border: '3px solid rgba(255,255,255,0.1)',
                borderTopColor: '#F5A623',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>Loading games…</span>
          </div>
        ) : error ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: 60,
              gap: 8,
            }}
          >
            <span style={{ fontSize: 13, color: '#E74C3C' }}>⚠️ {error}</span>
            <button
              onClick={loadGames}
              style={{
                marginTop: 8,
                padding: '8px 20px',
                background: '#F5A623',
                border: 'none',
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                color: '#000',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: 60,
              gap: 8,
            }}
          >
            <span style={{ fontSize: 32, marginBottom: 12 }}>🃏</span>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
              No {activeTab === 'all' ? '' : activeTab.toUpperCase() + ' '}games running
            </span>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {visible.map((game) => (
              <div
                key={game.id}
                onClick={() => onGamePress?.(game)}
                style={{
                  background: '#1a1d24',
                  borderRadius: 8,
                  padding: 12,
                  border: '1px solid rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                  transition: 'transform 0.1s',
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#E4E6EB',
                    marginBottom: 4,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {game.name || 'Untitled'}
                </div>
                <div style={{ fontSize: 10, color: '#B0B3B8', marginBottom: 4 }}>
                  {game.game_variant?.toUpperCase() || game.variant?.toUpperCase() || '—'}
                </div>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: game.status === 'active' ? '#22c55e' : '#F5A623',
                      fontWeight: 600,
                    }}
                  >
                    {game.status === 'active' ? '● Live' : game.status || '—'}
                  </span>
                  <span style={{ fontSize: 11, color: '#B0B3B8' }}>
                    👥 {game.current_players ?? game.registered_count ?? 0}/
                    {game.max_players || '?'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
