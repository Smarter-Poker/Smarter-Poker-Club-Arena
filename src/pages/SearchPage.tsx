/**
 *  SEARCH PAGE
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useDebounce } from '../hooks/useDebounce';
import { useNavigate } from 'react-router-dom';
import { STORAGE_KEYS } from '../lib/storage';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import { useAuthUser } from '../hooks/useAuthUser';
import './SearchPage.css';
import PageSkeleton from '../components/common/PageSkeleton';

type SearchCategory = 'all' | 'clubs' | 'players' | 'tables' | 'tournaments';

interface SearchResult {
  id: string;
  type: 'club' | 'player' | 'table' | 'tournament';
  name: string;
  subtitle?: string;
  avatar?: string;
}

export default function SearchPage() {
  useEffect(() => {
    document.title = 'Search | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SearchCategory>('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [visibleResults, setVisibleResults] = useState(new Set<number>());
  const [searchFocused, setSearchFocused] = useState(false);
  const { user } = useAuthUser();
  const [friendAdded, setFriendAdded] = useState<Set<string>>(new Set());
  const searchRequestIdRef = useRef(0);

  // Add friend action (inline on search results)
  const handleAddFriend = async (e: React.MouseEvent, playerId: string) => {
    e.stopPropagation();
    if (!user?.id) return;
    try {
      const { error } = await supabase.from('friendships').insert({
        user_id: user.id,
        friend_id: playerId,
        status: 'pending',
      });
      if (error && error.code !== '23505') throw error;
      setFriendAdded((prev) => new Set(prev).add(playerId));
      masterBus.emit('FRIEND_REQUEST_SENT', { fromUserId: user.id, toUserId: playerId });
      toast.success('Friend request sent!');
    } catch {
      toast.error('Failed to send request');
    }
  };

  const handleMessagePlayer = (e: React.MouseEvent, playerId: string) => {
    e.stopPropagation();
    navigate(`/profile/${playerId}`);
  };

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.RECENT_SEARCHES);
    if (saved) {
      try {
        setRecentSearches(JSON.parse(saved));
      } catch {
        localStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
      }
    }
  }, []);

  const search = useCallback(
    async (searchQuery: string, getIsMounted?: () => boolean) => {
      if (!searchQuery.trim()) {
        if (!getIsMounted || getIsMounted()) setResults([]);
        return;
      }

      // Increment request ID to track stale responses
      const requestId = ++searchRequestIdRef.current;

      if (!getIsMounted || getIsMounted()) setLoading(true);
      const allResults: SearchResult[] = [];
      // Sanitize SQL wildcards to prevent unintended pattern matching
      const sanitized = searchQuery.replace(/[%_]/g, '');

      try {
        if (category === 'all' || category === 'clubs') {
          const { data: clubs } = await supabase
            .from('clubs')
            .select('id, name, avatar_url, member_count')
            .ilike('name', `%${sanitized}%`)
            .limit(10);

          if (clubs) {
            allResults.push(
              ...clubs.map((c) => ({
                id: c.id,
                type: 'club' as const,
                name: c.name,
                subtitle: `${c.member_count || 0} members`,
                avatar: c.avatar_url,
              }))
            );
          }
        }

        if (category === 'all' || category === 'players') {
          const { data: players } = await supabase
            .from('profiles')
            .select('id, username, avatar_url')
            .ilike('username', `%${sanitized}%`)
            .limit(10);

          if (players) {
            allResults.push(
              ...players.map((p) => ({
                id: p.id,
                type: 'player' as const,
                name: p.username,
                avatar: p.avatar_url,
              }))
            );
          }
        }

        if (category === 'all' || category === 'tables') {
          const { data: tables } = await supabase
            .from('tables')
            .select('id, name, stakes, current_players, max_players')
            .ilike('name', `%${sanitized}%`)
            .limit(10);

          if (tables) {
            allResults.push(
              ...tables.map((t) => ({
                id: t.id,
                type: 'table' as const,
                name: t.name,
                subtitle: `${t.stakes} • ${t.current_players}/${t.max_players}`,
              }))
            );
          }
        }

        if (category === 'all' || category === 'tournaments') {
          const { data: tournaments } = await supabase
            .from('tournaments')
            .select('id, name, buy_in_amount, status, current_players, max_players')
            .ilike('name', `%${sanitized}%`)
            .in('status', ['ANNOUNCED', 'REGISTERING', 'RUNNING'])
            .limit(10);

          if (tournaments) {
            allResults.push(
              ...tournaments.map((t) => ({
                id: t.id,
                type: 'tournament' as const,
                name: t.name,
                subtitle: `${t.status} • ${t.buy_in_amount || 0} buy-in • ${t.current_players || 0}/${t.max_players || '∞'}`,
              }))
            );
          }
        }

        if (getIsMounted && !getIsMounted()) return;
        // Reject stale responses — only apply if this is still the latest request
        if (requestId !== searchRequestIdRef.current) return;
        setResults(allResults);

        if (searchQuery.length >= 2) {
          setRecentSearches((prev) => {
            const updated = [searchQuery, ...prev.filter((s) => s !== searchQuery)].slice(0, 5);
            localStorage.setItem(STORAGE_KEYS.RECENT_SEARCHES, JSON.stringify(updated));
            return updated;
          });
        }
      } catch (error) {
        console.error('Search failed:', error);
        toast.error('Search failed. Please try again.');
      }
      if (!getIsMounted || getIsMounted()) setLoading(false);
    },
    [category]
  );

  // Stagger result rows
  useEffect(() => {
    setVisibleResults(new Set());
    const timers = results.map((_, i) =>
      setTimeout(() => setVisibleResults((prev) => new Set([...prev, i])), i * 45)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [results]);

  const debouncedQuery = useDebounce(query, 300);
  useEffect(() => {
    let isMounted = true;
    search(debouncedQuery, () => isMounted);
    return () => {
      isMounted = false;
    };
  }, [debouncedQuery, search]);

  // ── Bus Listeners: re-search when data changes from other pages (debounced) ──
  useEffect(() => {
    let isMounted = true;
    const refresh = () => {
      if (isMounted && query.trim()) search(query, () => isMounted);
    };
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 500),
      masterBus.subscribeDebounced('PROFILE_UPDATED', refresh, 500),
      masterBus.subscribeDebounced('CLUB_JOINED', refresh, 500),
      masterBus.subscribeDebounced('TOURNAMENT_UPDATED', refresh, 500),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, [query, search]);

  const getIcon = (type: string): string => {
    switch (type) {
      case 'club':
        return '♠';
      case 'player':
        return '●';
      case 'table':
        return '■';
      case 'tournament':
        return '🏆';
      default:
        return '○';
    }
  };

  const handleResultClick = (result: SearchResult) => {
    switch (result.type) {
      case 'club':
        navigate(`/clubs/${result.id}`);
        break;
      case 'player':
        navigate(`/profile/${result.id}`);
        break;
      case 'table':
        navigate(`/table/${result.id}`);
        break;
      case 'tournament':
        navigate(`/tournaments/${result.id}`);
        break;
    }
  };

  return (
    <div className="search-page">
      <div className="search-bar">
        <input
          type="text"
          placeholder="Search clubs, players, tables, tournaments..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          autoFocus
          style={{
            boxShadow: searchFocused ? '0 0 16px rgba(0, 212, 255, 0.4)' : 'none',
            transition: 'box-shadow 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        />
        {query && (
          <button className="clear-btn" onClick={() => setQuery('')}>
            ✕
          </button>
        )}
      </div>

      <div className="category-tabs">
        {(['all', 'clubs', 'players', 'tables', 'tournaments'] as SearchCategory[]).map((cat) => (
          <button
            key={cat}
            className={category === cat ? 'active' : ''}
            onClick={() => setCategory(cat)}
          >
            {cat.charAt(0).toUpperCase() + cat.slice(1)}
          </button>
        ))}
      </div>

      <div className="search-content">
        {loading ? (
          <div
            className="search-skeletons"
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}
          >
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                style={{
                  display: 'flex',
                  gap: '1rem',
                  alignItems: 'center',
                  padding: '1rem',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'rgba(255,255,255,0.05)',
                    animation: 'pulse 1.5s infinite',
                  }}
                />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div
                    style={{
                      width: '40%',
                      height: 16,
                      borderRadius: 4,
                      background: 'rgba(255,255,255,0.05)',
                      animation: 'pulse 1.5s infinite',
                    }}
                  />
                  <div
                    style={{
                      width: '25%',
                      height: 12,
                      borderRadius: 4,
                      background: 'rgba(255,255,255,0.05)',
                      animation: 'pulse 1.5s infinite',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : query.length === 0 ? (
          <div className="recent-searches">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1rem',
              }}
            >
              <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-muted)' }}>
                Recent Searches
              </h3>
              {recentSearches.length > 0 && (
                <button
                  onClick={() => {
                    setRecentSearches([]);
                    localStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#ef4444',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  Clear History
                </button>
              )}
            </div>
            {recentSearches.length === 0 ? (
              <p className="empty-text">No recent searches</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {recentSearches.map((s, i) => (
                  <button
                    key={i}
                    className="recent-item"
                    onClick={() => setQuery(s)}
                    style={{
                      padding: '0.5rem 1rem',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '20px',
                      color: '#fff',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : results.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">○</span>
            <p>No results for "{query}"</p>
          </div>
        ) : (
          <div className="results-list">
            {results.map((result, index) => (
              <div
                key={`${result.type}-${result.id}`}
                className="result-item"
                onClick={() => handleResultClick(result)}
                style={{
                  opacity: visibleResults.has(index) ? 1 : 0,
                  transform: visibleResults.has(index) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className="result-avatar">
                  {result.avatar ? (
                    <img src={result.avatar} alt="" loading="lazy" />
                  ) : (
                    <span>{getIcon(result.type)}</span>
                  )}
                </div>
                <div className="result-info">
                  <span className="result-name">{result.name}</span>
                  {result.subtitle && <span className="result-subtitle">{result.subtitle}</span>}
                </div>
                {result.type === 'player' && result.id !== user?.id ? (
                  <div className="result-actions" onClick={(e) => e.stopPropagation()}>
                    {friendAdded.has(result.id) ? (
                      <span className="friend-sent-badge">✓ Sent</span>
                    ) : (
                      <button
                        className="inline-add-btn"
                        onClick={(e) => handleAddFriend(e, result.id)}
                        title="Add Friend"
                      >
                        👥+
                      </button>
                    )}
                    <button
                      className="inline-msg-btn"
                      onClick={(e) => handleMessagePlayer(e, result.id)}
                      title="Message"
                    >
                      ✉
                    </button>
                  </div>
                ) : (
                  <span className="result-type">{result.type}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
