/**
 * AdminTableHeatmap — "God View" table activity heatmap
 * Ported from Hub's AdminTableHeatmap.js → CA TSX
 *
 * Shows all active tables in a grid with heat indicators:
 *  - Empty (gray), Cold (<30%), Warm (30-70%), Hot (>70%), Full (pulsing)
 * Supports 3 view modes: Density, Stakes, Variant
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import haptic from '../../utils/haptic';
import { reportError } from '../../utils/errorReporter';
import { clubGamesOrFilter } from '../../utils/unionScope';

interface TableRow {
  id: string;
  name?: string;
  status?: string;
  current_players?: number;
  max_players?: number;
  small_blind?: number;
  big_blind?: number;
  game_variant?: string;
}

interface HeatResult {
  color: string;
  label: string;
  isPulse?: boolean;
}

function getTableHeat(table: TableRow): HeatResult {
  if (table.status === 'closed' || table.status === 'deleted')
    return { color: '#3A3B3C', label: 'Closed' };
  if (!table.current_players || table.current_players === 0)
    return { color: '#78909C', label: 'Empty' };
  const fillRatio = table.current_players / (table.max_players || 9);
  if (fillRatio < 0.3) return { color: '#2196F3', label: 'Cold' };
  if (fillRatio <= 0.7) return { color: '#FFA726', label: 'Warm' };
  if (fillRatio < 1) return { color: '#FF5252', label: 'Hot' };
  return { color: '#E91E63', label: 'Full', isPulse: true };
}

interface AdminTableHeatmapProps {
  clubId?: string;
  tables?: TableRow[];
  onAction?: (action: { action: string; table: TableRow }) => void;
}

type ViewMode = 'density' | 'stakes' | 'variant';

export default function AdminTableHeatmap({
  clubId,
  tables: propTables,
  onAction,
}: AdminTableHeatmapProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('density');
  const [fetchedTables, setFetchedTables] = useState<TableRow[]>([]);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (propTables && propTables.length > 0) return; // Use prop data if provided
    if (!clubId) return;

    const fetchTables = async () => {
      try {
        const { data, error: heatmapErr } = await supabase
          .from('tables')
          .select(
            'id, name, status, current_players, max_players, small_blind, big_blind, game_variant'
          )
          // P2-1: include the union's tables (union games carry the union
          // container as club_id, a plain club filter shows an empty club)
          .or(await clubGamesOrFilter(clubId))
          .eq('is_deleted', false);
        if (heatmapErr) reportError(heatmapErr, 'AdminTableHeatmap.Load_failed');
        if (isMounted.current && data) setFetchedTables(data);
      } catch (err) {
        reportError(err, 'AdminTableHeatmap.Error');
        /* silent */
      }
    };

    fetchTables();

    // Realtime subscription for live updates
    const channelKey = `heatmap-${clubId}`;
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
          fetchTables(); // Re-fetch on any change
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'AdminTableHeatmap._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[AdminTableHeatmap] Realtime channel timed out');
        }
      });

    // Bus listeners for cross-page events
    const unsubs = [
      masterBus.subscribeDebounced('TABLE_CREATED', fetchTables, 500),
      masterBus.subscribeDebounced('TABLE_UPDATED', fetchTables, 500),
      masterBus.subscribeDebounced('TABLE_CLOSED', fetchTables, 500),
    ];

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubs.forEach((u) => u());
    };
  }, [clubId, propTables?.length]);

  const tables = propTables && propTables.length > 0 ? propTables : fetchedTables;

  if (!tables || tables.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: '#B0B3B8' }}>
        No Tables Available For God View.
      </div>
    );
  }

  const activeTables = tables.filter((t) => t.status !== 'deleted' && t.status !== 'closed');

  return (
    <div
      style={{
        width: '100%',
        padding: 16,
        background: '#18191A',
        borderRadius: 12,
        border: '1px solid #3E4042',
      }}
    >
      {/* Control Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 20,
          paddingBottom: 12,
          borderBottom: '1px solid #3E4042',
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          {(['density', 'stakes', 'variant'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                haptic('light');
                setViewMode(mode);
              }}
              style={{
                background: viewMode === mode ? '#2374E1' : 'transparent',
                border: `1px solid ${viewMode === mode ? '#2374E1' : '#3E4042'}`,
                color: viewMode === mode ? '#fff' : '#B0B3B8',
                padding: '6px 12px',
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {mode === 'density' ? 'Density' : mode === 'stakes' ? 'Stakes' : 'Variant'}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: '#B0B3B8' }}>{activeTables.length} Active Tables</div>
      </div>

      {/* Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 16,
          marginBottom: 20,
        }}
      >
        {activeTables.map((t) => {
          const heat = getTableHeat(t);
          return (
            <div
              key={t.id}
              onClick={() => {
                haptic('medium');
                onAction?.({ action: 'manage', table: t });
              }}
              style={{
                background: '#242526',
                borderRadius: 16,
                border: `2px solid ${heat.color}`,
                padding: 8,
                cursor: 'pointer',
                transition: 'transform 0.1s',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                position: 'relative',
                minHeight: 100,
                boxShadow: heat.isPulse ? `0 0 12px ${heat.color}80` : 'none',
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  background: '#0c0c14',
                  borderRadius: 12,
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                <div style={{ textAlign: 'center', zIndex: 2, padding: 4 }}>
                  <div
                    style={{
                      fontSize: 10,
                      color: '#E4E6EB',
                      fontWeight: 600,
                      marginBottom: 4,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    {t.name && t.name.length > 10 ? t.name.slice(0, 10) + '...' : t.name}
                  </div>
                  {viewMode === 'stakes' && (
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 800,
                        fontFamily: '"Rajdhani", monospace',
                        textShadow: '0 2px 4px rgba(0,0,0,0.8)',
                      }}
                    >
                      {t.small_blind}/{t.big_blind}
                    </div>
                  )}
                  {viewMode === 'variant' && (
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 800,
                        fontFamily: '"Rajdhani", monospace',
                        color: '#A855F7',
                        textShadow: '0 2px 4px rgba(0,0,0,0.8)',
                      }}
                    >
                      {t.game_variant?.toUpperCase().replace('_', ' ')}
                    </div>
                  )}
                  {viewMode === 'density' && (
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 800,
                        fontFamily: '"Rajdhani", monospace',
                        color: heat.color,
                        textShadow: '0 2px 4px rgba(0,0,0,0.8)',
                      }}
                    >
                      {t.current_players || 0}/{t.max_players || 9}
                    </div>
                  )}
                </div>

                {/* Seat dots */}
                <div
                  style={{
                    position: 'absolute',
                    bottom: 8,
                    display: 'flex',
                    gap: 3,
                    zIndex: 2,
                    background: 'rgba(0,0,0,0.4)',
                    padding: '2px 6px',
                    borderRadius: 10,
                  }}
                >
                  {Array.from({ length: t.max_players || 9 }).map((_, i) => {
                    const isOccupied = i < (t.current_players || 0);
                    return (
                      <div
                        key={i}
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: isOccupied ? heat.color : 'rgba(255,255,255,0.1)',
                          border: `1px solid ${isOccupied ? '#fff' : 'rgba(255,255,255,0.2)'}`,
                          boxShadow: '0 1px 2px rgba(0,0,0,0.5)',
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          justifyContent: 'center',
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid #3E4042',
        }}
      >
        {[
          { color: '#78909C', label: 'Empty' },
          { color: '#2196F3', label: 'Cold' },
          { color: '#FFA726', label: 'Warm' },
          { color: '#FF5252', label: 'Hot' },
          { color: '#E91E63', label: 'Full' },
        ].map((l) => (
          <div
            key={l.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: '#B0B3B8',
              fontWeight: 600,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: l.color,
                display: 'inline-block',
              }}
            />
            {l.label}
          </div>
        ))}
      </div>
    </div>
  );
}
