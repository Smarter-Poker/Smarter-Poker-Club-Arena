/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FindPlayerModal — Search for Active Players
 * ═══════════════════════════════════════════════════════════════════════════════
 * Search by player alias to see if they're currently playing on any tables.
 * Shows "Not currently playing" or 1-4 active tables/tournaments.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import haptic from '../../services/HapticService';
import styles from './FindPlayerModal.module.css';

interface FindPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PlayerTable {
  id: string;
  name: string;
  game_variant: string;
  stakes: string;
  club_name?: string;
  is_tournament?: boolean;
}

interface PlayerResult {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  tables: PlayerTable[];
}

// Frame image for the modal
const MODAL_FRAME_URL = `${import.meta.env.BASE_URL}images/modals/find-player-frame.png`;

export default function FindPlayerModal({ isOpen, onClose }: FindPlayerModalProps) {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<PlayerResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleTables, setVisibleTables] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (searchResult?.tables) {
      searchResult.tables.forEach((_, i) => {
        setTimeout(() => setVisibleTables((prev) => new Set(prev).add(i)), i * 60);
      });
    }
  }, [searchResult?.tables]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    haptic.medium();
    setIsSearching(true);
    setSearchResult(null);
    setNotFound(false);
    setError(null);

    try {
      // Search for player by username or display name (case insensitive)
      const { data: players, error: searchError } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .or(`username.ilike.%${searchQuery.trim()}%,display_name.ilike.%${searchQuery.trim()}%`)
        .limit(1);

      if (searchError) {
        throw searchError;
      }

      if (!players || players.length === 0) {
        setNotFound(true);
        return;
      }

      const player = players[0];

      // Check if player is currently at any tables via player_presence
      const { data: presenceData } = await supabase
        .from('player_presence')
        .select(
          `
                    id,
                    table_id,
                    status,
                    tables:table_id (
                        id,
                        name,
                        game_variant,
                        small_blind,
                        big_blind,
                        club_id,
                        clubs:club_id (name)
                    )
                `
        )
        .eq('user_id', player.id)
        .eq('status', 'playing')
        .limit(4);

      const tables: PlayerTable[] = [];

      if (presenceData && presenceData.length > 0) {
        for (const presence of presenceData) {
          if (presence.tables) {
            const table = presence.tables as any;
            tables.push({
              id: table.id,
              name: table.name || 'Cash Game',
              game_variant: table.game_variant || 'NLH',
              stakes: `${table.small_blind || 0}/${table.big_blind || 0}`,
              club_name: table.clubs?.name || undefined,
              is_tournament: false,
            });
          }
        }
      }

      // Also check tournament players
      const { data: tournamentData } = await supabase
        .from('tournament_players')
        .select(
          `
                    id,
                    tournament_id,
                    tournaments:tournament_id (
                        id,
                        name,
                        status,
                        buy_in_amount,
                        club_id,
                        clubs:club_id (name)
                    )
                `
        )
        .eq('user_id', player.id)
        .in('status', ['registered', 'playing'])
        .limit(4 - tables.length);

      if (tournamentData && tournamentData.length > 0) {
        for (const reg of tournamentData) {
          if (reg.tournaments) {
            const tournament = reg.tournaments as any;
            if (tournament.status === 'running' || tournament.status === 'late_reg') {
              tables.push({
                id: tournament.id,
                name: tournament.name || 'Tournament',
                game_variant: 'MTT',
                stakes: `${tournament.buy_in_chips || 0} buy-in`,
                club_name: tournament.clubs?.name || undefined,
                is_tournament: true,
              });
            }
          }
        }
      }

      if (tables.length === 0) {
        // Player found but not currently playing
        setNotFound(true);
      } else {
        setSearchResult({
          ...player,
          tables,
        });
      }
    } catch (err) {
      console.error('Search error:', err);
      setError('Search failed. Please try again.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleTableClick = (table: PlayerTable) => {
    haptic.success();
    onClose();
    if (table.is_tournament) {
      navigate(`/tournaments/${table.id}`);
    } else {
      navigate(`/table/${table.id}`);
    }
  };

  const handleClose = () => {
    haptic.light();
    setSearchQuery('');
    setSearchResult(null);
    setNotFound(false);
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={styles.modalContainer} onClick={(e) => e.stopPropagation()}>
        {/* Modal content */}
        <div className={styles.modalContent}>
          <h2 className={styles.title}>Find a Player</h2>

          {/* Search input */}
          <div className={styles.searchSection}>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Enter player username or alias..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              autoFocus
            />
            <button
              className={styles.searchButton}
              onClick={handleSearch}
              disabled={isSearching || !searchQuery.trim()}
            >
              {isSearching ? '...' : 'GO'}
            </button>
          </div>

          {/* Results area */}
          <div className={styles.resultsArea}>
            {error && <div className={styles.errorMessage}>{error}</div>}

            {notFound && (
              <div className={styles.notFoundMessage}>
                <span className={styles.notFoundIcon}></span>
                <p>Player is not currently playing on Club Arena</p>
              </div>
            )}

            {searchResult && (
              <div className={styles.playerResult}>
                <div className={styles.playerHeader}>
                  <div className={styles.playerAvatar}>
                    {searchResult.avatar_url ? (
                      <img src={searchResult.avatar_url} alt="" />
                    ) : (
                      <span>?</span>
                    )}
                  </div>
                  <div className={styles.playerInfo}>
                    <span className={styles.playerName}>
                      {searchResult.display_name || searchResult.username}
                    </span>
                    <span className={styles.playerStatus}>
                      Playing at {searchResult.tables.length} table
                      {searchResult.tables.length > 1 ? 's' : ''}
                    </span>
                  </div>
                </div>

                <div className={styles.tablesList}>
                  {searchResult.tables.map((table, i) => (
                    <button
                      key={table.id}
                      className={styles.tableCard}
                      onClick={() => handleTableClick(table)}
                      style={{
                        opacity: visibleTables.has(i) ? 1 : 0,
                        transform: visibleTables.has(i) ? 'translateY(0)' : 'translateY(8px)',
                        transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                      }}
                    >
                      <div className={styles.tableInfo}>
                        <span className={styles.tableName}>{table.name}</span>
                        <span className={styles.tableDetails}>
                          {table.game_variant} • {table.stakes}
                          {table.club_name && ` • ${table.club_name}`}
                        </span>
                      </div>
                      <span className={styles.watchButton}>Watch</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!error && !notFound && !searchResult && !isSearching && (
              <div className={styles.hintMessage}>
                <p>Search for a player to see their active tables</p>
              </div>
            )}
          </div>

          {/* Close button */}
          <button className={styles.closeButton} onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
