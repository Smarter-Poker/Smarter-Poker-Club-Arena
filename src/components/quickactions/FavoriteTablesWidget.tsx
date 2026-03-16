import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import './FavoriteTablesWidget.css';

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

  useEffect(() => {
    if (user?.id) {
      loadFavorites();
    }
  }, [user?.id]);

  useEffect(() => {
    favorites.forEach((_, i) => {
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
    });
  }, [favorites]);

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
                        is_running,
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
          isRunning: f.tables?.is_running || false,
        })) || []
      );
    } catch (error) {
      console.error('Failed to load favorites:', error);
    } finally {
      setLoading(false);
    }
  };

  const removeFavorite = async (favoriteId: string) => {
    // SECURITY: Scope to current user — reject if not authenticated
    if (!user?.id) {
      console.error('[FavoriteTablesWidget] Cannot remove favorite: no authenticated user');
      return;
    }
    const { error } = await supabase
      .from('favorite_tables')
      .delete()
      .eq('id', favoriteId)
      .eq('user_id', user.id);
    if (error) {
      console.error('Failed to remove favorite:', error);
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
          <p>No favorite tables yet</p>
          <span>Star tables to add them here for quick access</span>
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
