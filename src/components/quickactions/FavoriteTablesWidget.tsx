import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import './FavoriteTablesWidget.css';
import { reportError } from '../../utils/errorReporter';

interface FavoriteTable {
  id: string;
  tableId: string;
  tableName: string;
  stakes: string;
  clubName: string;
  currentPlayers: number;
  maxPlayers: number;
  isRunning: boolean;
}

interface FavoriteTablesWidgetProps {
  onJoinTable?: (tableId: string) => void;
}

export const FavoriteTablesWidget: React.FC<FavoriteTablesWidgetProps> = ({ onJoinTable }) => {
  const { user } = useAuthUser();
  const [favorites, setFavorites] = useState<FavoriteTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (user?.id) {
      loadFavorites();
    }
  }, [user?.id]);

  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = favorites.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, [favorites]);

  /* AUDIT 2026-08-20: favorite_tables did not exist in the database until
     migration 20260821010000, so this widget — mounted in ClubLobby and run on
     every lobby load — had never listed a favourite, and its remove button had
     never removed one. Both were reported through reportError and swallowed. */
  const loadFavorites = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('favorite_tables')
        .select(
          `
                    id,
                    table_id,
                    tables (
                        name,
                        stakes,
                        current_players,
                        max_players,
                        status,
                        clubs ( name )
                    )
                `
        )
        .eq('user_id', user?.id);

      if (error) throw error;

      setFavorites(
        data?.map((f: any) => ({
          id: f.id,
          tableId: f.table_id,
          tableName: f.tables?.name || 'Unknown',
          stakes: f.tables?.stakes || '',
          clubName: f.tables?.clubs?.name || '',
          currentPlayers: f.tables?.current_players || 0,
          maxPlayers: f.tables?.max_players || 9,
          /* AUDIT 2026-08-20: this read tables.is_running, which is not a
             column on tables — so even once favorite_tables existed, the whole
             embedded select would have 400'd on it. `status` is the real
             column; a table is running when it is not in a terminal state. */
          isRunning: !['closed', 'completed', 'cancelled', 'finished'].includes(
            String(f.tables?.status || '').toLowerCase()
          ),
        })) || []
      );
    } catch (error) {
      reportError(error, 'FavoriteTablesWidget.Failed_to_load_favorites');
    } finally {
      setLoading(false);
    }
  };

  const removeFavorite = async (favoriteId: string) => {
    // SECURITY: Scope to current user — reject if not authenticated
    if (!user?.id) {
      reportError(
        new Error('[FavoriteTablesWidget] Cannot remove favorite: no authenticated user'),
        'FavoriteTablesWidget.Cannot_remove_favorite'
      );
      return;
    }
    const { error } = await supabase
      .from('favorite_tables')
      .delete()
      .eq('id', favoriteId)
      .eq('user_id', user.id);
    if (error) {
      reportError(error, 'FavoriteTablesWidget.Failed_to_remove_favorite');
      return;
    }
    setFavorites((prev) => prev.filter((f) => f.id !== favoriteId));
  };

  if (loading) {
    return <div className="favorites-loading">Loading...</div>;
  }

  return (
    <div className="favorite-tables-widget">
      <div className="widget-header">
        <span className="widget-title"> Favorite Tables</span>
        <span className="widget-count">{favorites.length}</span>
      </div>

      {favorites.length === 0 ? (
        <div className="no-favorites">
          <p>No Favorite Tables Yet</p>
          <span>Star Tables To Add Them Here For Quick Access</span>
        </div>
      ) : (
        <div className="favorites-list">
          {favorites.map((table, i) => (
            <div
              key={table.id}
              className="favorite-item"
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="favorite-info">
                <span className="table-name">{table.tableName}</span>
                <span className="table-details">
                  {table.stakes} • {table.clubName}
                </span>
              </div>
              <div className="favorite-status">
                <span className={`status-badge ${table.isRunning ? 'running' : 'idle'}`}>
                  {table.isRunning ? `${table.currentPlayers}/${table.maxPlayers}` : 'Empty'}
                </span>
              </div>
              <div className="favorite-actions">
                <button
                  className="join-btn"
                  onClick={() => onJoinTable?.(table.tableId)}
                  disabled={!table.isRunning || table.currentPlayers >= table.maxPlayers}
                >
                  Join
                </button>
                <button className="remove-btn" onClick={() => removeFavorite(table.id)}>
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default FavoriteTablesWidget;
