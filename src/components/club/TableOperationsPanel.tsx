/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TABLE OPERATIONS PANEL — Admin Control Center for Club Tables
 * ═══════════════════════════════════════════════════════════════════════════════
 * Live table management for club owners/admins:
 * - View all tables with status, player count, rake stats
 * - Pause/Resume tables
 * - Kick players (returns chips to wallet)
 * - View seated players per table
 * - Adjust table settings (blinds, ante, max players)
 *
 * Mobile-first, dark theme consistent with Club Arena design
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { tableService } from '../../services/TableService';

interface TableInfo {
  id: string;
  name: string;
  game_variant: string;
  small_blind: number;
  big_blind: number;
  ante: number;
  max_players: number;
  current_players: number;
  status: string;
  game_type: string;
}

interface SeatedPlayer {
  user_id: string;
  seat_number: number;
  stack: number;
  created_at: string;
  profiles: {
    display_name: string;
    username: string;
    avatar_url: string | null;
    is_horse: boolean;
  } | null;
}

interface TableStats {
  totalRake: number;
  totalHands: number;
}

interface Props {
  clubId: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES — Dark theme, mobile-first, inline CSS module
// ═══════════════════════════════════════════════════════════════════════════════

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '12px',
    maxWidth: '100%',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  title: {
    fontSize: '18px',
    fontWeight: 700,
    color: '#fff',
    margin: 0,
  },
  refreshBtn: {
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '8px',
    color: '#aaa',
    padding: '6px 12px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  tableCard: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '12px',
    padding: '14px',
    marginBottom: '12px',
  },
  tableCardExpanded: {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(139,92,246,0.3)',
  },
  tableHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    cursor: 'pointer',
  },
  tableName: {
    fontSize: '15px',
    fontWeight: 600,
    color: '#fff',
    margin: 0,
  },
  tableSubtext: {
    fontSize: '12px',
    color: '#888',
    marginTop: '2px',
  },
  statusBadgeBase: {
    padding: '3px 10px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  },
  expandedContent: {
    marginTop: '12px',
    paddingTop: '12px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  controlRow: {
    display: 'flex',
    gap: '8px',
    marginBottom: '12px',
    flexWrap: 'wrap' as const,
  },
  actionBtn: {
    padding: '8px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    transition: 'all 0.2s',
  },
  pauseBtn: {
    background: 'rgba(234,179,8,0.15)',
    color: '#eab308',
  },
  resumeBtn: {
    background: 'rgba(34,197,94,0.15)',
    color: '#22c55e',
  },
  closeBtn: {
    background: 'rgba(239,68,68,0.15)',
    color: '#ef4444',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#888',
    marginBottom: '8px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  playerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 10px',
    background: 'rgba(255,255,255,0.03)',
    borderRadius: '8px',
    marginBottom: '6px',
  },
  playerInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  playerAvatar: {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    background: 'rgba(139,92,246,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '12px',
    color: '#8b5cf6',
  },
  playerName: {
    fontSize: '13px',
    color: '#fff',
  },
  playerStack: {
    fontSize: '12px',
    color: '#aaa',
  },
  horseBadge: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '4px',
    background: 'rgba(139,92,246,0.15)',
    color: '#8b5cf6',
    marginLeft: '4px',
  },
  kickBtn: {
    background: 'rgba(239,68,68,0.1)',
    color: '#ef4444',
    border: '1px solid rgba(239,68,68,0.2)',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '11px',
    cursor: 'pointer',
  },
  statsRow: {
    display: 'flex',
    gap: '16px',
    marginBottom: '12px',
  },
  statItem: {
    flex: 1,
    padding: '8px 12px',
    background: 'rgba(255,255,255,0.03)',
    borderRadius: '8px',
    textAlign: 'center' as const,
  },
  statValue: {
    fontSize: '16px',
    fontWeight: 700,
    color: '#fff',
  },
  statLabel: {
    fontSize: '11px',
    color: '#666',
    marginTop: '2px',
  },
  emptyState: {
    textAlign: 'center' as const,
    padding: '40px 20px',
    color: '#666',
    fontSize: '14px',
  },
  noPlayers: {
    textAlign: 'center' as const,
    padding: '12px',
    color: '#555',
    fontSize: '12px',
    fontStyle: 'italic' as const,
  },
  confirmOverlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  confirmDialog: {
    background: '#1a1a2e',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '16px',
    padding: '20px',
    maxWidth: '320px',
    width: '90%',
  },
  confirmTitle: {
    fontSize: '16px',
    fontWeight: 700,
    color: '#fff',
    marginBottom: '8px',
  },
  confirmText: {
    fontSize: '13px',
    color: '#aaa',
    marginBottom: '16px',
  },
  confirmActions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  },
  cancelBtn: {
    background: 'rgba(255,255,255,0.08)',
    color: '#aaa',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  dangerBtn: {
    background: 'rgba(239,68,68,0.15)',
    color: '#ef4444',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const getStatusBadgeStyle = (status: string): React.CSSProperties => ({
  ...styles.statusBadgeBase,
  background:
    status === 'running'
      ? 'rgba(34,197,94,0.15)'
      : status === 'paused'
        ? 'rgba(234,179,8,0.15)'
        : status === 'waiting'
          ? 'rgba(59,130,246,0.15)'
          : 'rgba(255,255,255,0.1)',
  color:
    status === 'running'
      ? '#22c55e'
      : status === 'paused'
        ? '#eab308'
        : status === 'waiting'
          ? '#3b82f6'
          : '#888',
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function TableOperationsPanel({ clubId }: Props) {
  const isMounted = useIsMounted();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [seatedPlayers, setSeatedPlayers] = useState<Record<string, SeatedPlayer[]>>({});
  const [tableStats, setTableStats] = useState<Record<string, TableStats>>({});
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'kick' | 'pause' | 'close';
    tableId: string;
    userId?: string;
    playerName?: string;
  } | null>(null);
  const [visibleTables, setVisibleTables] = useState<boolean[]>([]);
  const [visiblePlayers, setVisiblePlayers] = useState<Record<string, boolean[]>>({});

  // ─── Load tables ───────────────────────────────────────────────────────────
  const loadTables = useCallback(async () => {
    setLoading(true);
    const data = await tableService.getClubTables(clubId);
    setTables(data as unknown as TableInfo[]);
    setLoading(false);
  }, [clubId]);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  useEffect(() => {
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    setVisibleTables([]);
    staggerTimersRef.current.push(
      ...tables.map((_, i) => setTimeout(() => setVisibleTables((prev) => [...prev, true]), i * 60))
    );
  }, [tables]);

  useEffect(() => {
    if (expandedTable && seatedPlayers[expandedTable]) {
      setVisiblePlayers((prev) => ({
        ...prev,
        [expandedTable]: [],
      }));
      seatedPlayers[expandedTable].forEach((_, i) => {
        setTimeout(() => {
          setVisiblePlayers((prev) => ({
            ...prev,
            [expandedTable]: [...(prev[expandedTable] || []), true],
          }));
        }, i * 50);
      });
    }
  }, [expandedTable, seatedPlayers]);

  // ─── Realtime subscription ─────────────────────────────────────────────────
  useEffect(() => {
    const channelKey = 'table-ops-live';

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tables', filter: `club_id=eq.${clubId}` },
        () => loadTables()
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'table_seats' }, () => {
        // Refresh seated players for expanded table
        if (expandedTable) loadSeatedPlayers(expandedTable);
      })
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, expandedTable, loadTables]);

  // ─── Load seated players for a table ───────────────────────────────────────
  const loadSeatedPlayers = async (tableId: string) => {
    const players = await tableService.getSeatedPlayers(tableId);
    setSeatedPlayers((prev) => ({ ...prev, [tableId]: players as unknown as SeatedPlayer[] }));
  };

  // ─── Load stats for a table ────────────────────────────────────────────────
  const loadTableStats = async (tableId: string) => {
    const stats = await tableService.getTableStats(tableId);
    setTableStats((prev) => ({ ...prev, [tableId]: stats }));
  };

  // ─── Expand/collapse table ─────────────────────────────────────────────────
  const toggleExpand = (tableId: string) => {
    if (expandedTable === tableId) {
      setExpandedTable(null);
    } else {
      setExpandedTable(tableId);
      loadSeatedPlayers(tableId);
      loadTableStats(tableId);
    }
  };

  // ─── Actions ───────────────────────────────────────────────────────────────
  const handlePauseResume = async (tableId: string, currentStatus: string) => {
    setActionLoading(tableId);
    if (currentStatus === 'paused') {
      await tableService.resumeTable(tableId);
    } else {
      await tableService.pauseTable(tableId);
    }
    await loadTables();
    setActionLoading(null);
  };

  const handleKickPlayer = async () => {
    if (!confirmAction || confirmAction.type !== 'kick' || !confirmAction.userId) return;
    setActionLoading(confirmAction.tableId);
    try {
      await tableService.kickPlayer(
        confirmAction.tableId,
        confirmAction.userId,
        'Removed by admin'
      );
      await loadSeatedPlayers(confirmAction.tableId);
      await loadTables();
    } catch (err) {
      console.error('[TableOperationsPanel] Failed to kick player:', err);
    } finally {
      if (isMounted.current) setConfirmAction(null);
      setActionLoading(null);
    }
  };

  const handleCloseTable = async () => {
    if (!confirmAction || confirmAction.type !== 'close') return;
    setActionLoading(confirmAction.tableId);
    try {
      await tableService.closeTable(confirmAction.tableId);
      await loadTables();
    } catch (err) {
      console.error('[TableOperationsPanel] Failed to close table:', err);
    } finally {
      if (isMounted.current) setConfirmAction(null);
      setActionLoading(null);
    }
  };

  // ─── Format helpers ────────────────────────────────────────────────────────
  const formatChips = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatVariant = (v: string) => {
    const map: Record<string, string> = {
      nlh: "NL Hold'em",
      plo: 'PLO',
      plo5: 'PLO-5',
      nlh_plo: 'Mixed',
      short_deck: 'Short Deck',
    };
    return map[v] || v.toUpperCase();
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return <div style={styles.emptyState}>Loading tables...</div>;
  }

  if (tables.length === 0) {
    return <div style={styles.emptyState}>No active tables in this club</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Table Operations</h2>
        <button style={styles.refreshBtn} onClick={loadTables}>
          Refresh
        </button>
      </div>

      {tables.map((table, idx) => {
        const isExpanded = expandedTable === table.id;
        const players = seatedPlayers[table.id] || [];
        const stats = tableStats[table.id];
        const isLoading = actionLoading === table.id;

        return (
          <div
            key={table.id}
            style={{
              ...styles.tableCard,
              ...(isExpanded ? styles.tableCardExpanded : {}),
              opacity: isLoading ? 0.6 : visibleTables[idx] ? 1 : 0,
              transform: visibleTables[idx] ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            {/* Table Header — Click to Expand */}
            <div style={styles.tableHeader} onClick={() => toggleExpand(table.id)}>
              <div>
                <div style={styles.tableName}>
                  {table.name || formatVariant(table.game_variant)}
                </div>
                <div style={styles.tableSubtext}>
                  {formatVariant(table.game_variant)} · {table.small_blind}/{table.big_blind}
                  {table.ante > 0 ? ` (+${table.ante})` : ''}
                  {' · '}
                  {table.current_players}/{table.max_players} players
                </div>
              </div>
              <span style={getStatusBadgeStyle(table.status)}>{table.status}</span>
            </div>

            {/* Expanded Content */}
            {isExpanded && (
              <div style={styles.expandedContent}>
                {/* Stats Row */}
                {stats && (
                  <div style={styles.statsRow}>
                    <div style={styles.statItem}>
                      <div style={styles.statValue}>{stats.totalHands}</div>
                      <div style={styles.statLabel}>Hands Dealt</div>
                    </div>
                    <div style={styles.statItem}>
                      <div style={styles.statValue}>{formatChips(stats.totalRake)}</div>
                      <div style={styles.statLabel}>Total Rake</div>
                    </div>
                    <div style={styles.statItem}>
                      <div style={styles.statValue}>{table.current_players}</div>
                      <div style={styles.statLabel}>Players</div>
                    </div>
                  </div>
                )}

                {/* Control Buttons */}
                <div style={styles.controlRow}>
                  {table.status === 'paused' ? (
                    <button
                      style={{ ...styles.actionBtn, ...styles.resumeBtn }}
                      onClick={() => handlePauseResume(table.id, table.status)}
                      disabled={isLoading}
                    >
                      ▶ Resume
                    </button>
                  ) : (
                    <button
                      style={{ ...styles.actionBtn, ...styles.pauseBtn }}
                      onClick={() => handlePauseResume(table.id, table.status)}
                      disabled={isLoading}
                    >
                      ⏸ Pause
                    </button>
                  )}
                  <button
                    style={{ ...styles.actionBtn, ...styles.closeBtn }}
                    onClick={() => setConfirmAction({ type: 'close', tableId: table.id })}
                    disabled={isLoading}
                  >
                    ✕ Close Table
                  </button>
                </div>

                {/* Seated Players */}
                <div style={styles.sectionTitle}>Seated Players</div>
                {players.length === 0 ? (
                  <div style={styles.noPlayers}>No players seated</div>
                ) : (
                  players.map((player, pIdx) => {
                    const profile = player.profiles;
                    const name = profile?.display_name || profile?.username || 'Unknown';
                    const isHorse = profile?.is_horse || false;
                    const playerVisible = visiblePlayers[expandedTable]?.[pIdx];

                    return (
                      <div
                        key={player.user_id}
                        style={{
                          ...styles.playerRow,
                          opacity: playerVisible ? 1 : 0,
                          transform: playerVisible ? 'translateY(0)' : 'translateY(8px)',
                          transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                        }}
                      >
                        <div style={styles.playerInfo}>
                          <div style={styles.playerAvatar}>
                            {profile?.avatar_url ? (
                              <img
                                src={profile.avatar_url}
                                alt=""
                                style={{ width: '100%', height: '100%', borderRadius: '50%' }}
                              />
                            ) : (
                              name.charAt(0).toUpperCase()
                            )}
                          </div>
                          <div>
                            <div style={styles.playerName}>
                              Seat {player.seat_number}: {name}
                              {isHorse && <span style={styles.horseBadge}>HORSE</span>}
                            </div>
                            <div style={styles.playerStack}>Stack: {formatChips(player.stack)}</div>
                          </div>
                        </div>
                        <button
                          style={styles.kickBtn}
                          onClick={() =>
                            setConfirmAction({
                              type: 'kick',
                              tableId: table.id,
                              userId: player.user_id,
                              playerName: name,
                            })
                          }
                          disabled={isLoading}
                        >
                          Kick
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div style={styles.confirmOverlay} onClick={() => setConfirmAction(null)}>
          <div style={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
            {confirmAction.type === 'kick' ? (
              <>
                <div style={styles.confirmTitle}>Kick Player</div>
                <div style={styles.confirmText}>
                  Remove <strong>{confirmAction.playerName}</strong> from the table? Their chips
                  will be returned to their wallet.
                </div>
                <div style={styles.confirmActions}>
                  <button style={styles.cancelBtn} onClick={() => setConfirmAction(null)}>
                    Cancel
                  </button>
                  <button style={styles.dangerBtn} onClick={handleKickPlayer}>
                    Kick Player
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={styles.confirmTitle}>Close Table</div>
                <div style={styles.confirmText}>
                  This will close the table and all seated players will be cashed out. This action
                  cannot be undone.
                </div>
                <div style={styles.confirmActions}>
                  <button style={styles.cancelBtn} onClick={() => setConfirmAction(null)}>
                    Cancel
                  </button>
                  <button style={styles.dangerBtn} onClick={handleCloseTable}>
                    Close Table
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
