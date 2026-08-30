import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import CommunitySurfaceHeader from '../components/community/CommunitySurfaceHeader';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useDebounce } from '../hooks/useDebounce';
import { STORAGE_KEYS } from '../lib/storage';
import { supabase } from '../lib/supabase';
import { formatBuyInShort } from '../utils/buyIn';
import { reportError } from '../utils/errorReporter';
import './SearchPage.css';

type SearchCategory = 'all' | 'clubs' | 'players' | 'tables' | 'tournaments';

interface SearchResult {
  id: string;
  type: 'club' | 'player' | 'table' | 'tournament';
  name: string;
  subtitle?: string;
  avatar?: string;
}

const CATEGORIES: Array<{ id: SearchCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'players', label: 'Players' },
  { id: 'clubs', label: 'Clubs' },
  { id: 'tables', label: 'Tables' },
  { id: 'tournaments', label: 'Tournaments' },
];

function getSearchCategory(value: string | null): SearchCategory {
  return CATEGORIES.some((category) => category.id === value) ? (value as SearchCategory) : 'all';
}

function getResultMark(type: SearchResult['type']): string {
  switch (type) {
    case 'club':
      return '♠';
    case 'player':
      return '●';
    case 'table':
      return '▰';
    case 'tournament':
      return '◆';
  }
}

export default function SearchPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuthUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryFromUrl = searchParams.get('q') || '';
  const category = getSearchCategory(searchParams.get('type') || searchParams.get('tab'));
  const [query, setQuery] = useState(queryFromUrl);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [friendAdded, setFriendAdded] = useState<Set<string>>(new Set());
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    document.title = 'Community Search | Smarter Poker';
  }, []);

  useEffect(() => {
    setQuery(queryFromUrl);
  }, [queryFromUrl]);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.RECENT_SEARCHES);
    if (!saved) return;
    try {
      setRecentSearches(JSON.parse(saved));
    } catch {
      localStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
    }
  }, []);

  const updateLocation = useCallback(
    (nextQuery: string, nextCategory = category, replace = true) => {
      const next = new URLSearchParams(searchParams);
      next.delete('tab');
      if (nextCategory === 'all') next.delete('type');
      else next.set('type', nextCategory);
      if (nextQuery.trim()) next.set('q', nextQuery.trim());
      else next.delete('q');
      setSearchParams(next, { replace });
    },
    [category, searchParams, setSearchParams]
  );

  const rememberSearch = useCallback((value: string) => {
    const normalized = value.trim();
    if (normalized.length < 2) return;
    setRecentSearches((previous) => {
      const updated = [normalized, ...previous.filter((item) => item !== normalized)].slice(0, 5);
      localStorage.setItem(STORAGE_KEYS.RECENT_SEARCHES, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const search = useCallback(
    async (searchQuery: string, getIsMounted?: () => boolean) => {
      const normalized = searchQuery.trim();
      if (!normalized) {
        searchRequestIdRef.current += 1;
        if (!getIsMounted || getIsMounted()) {
          setResults([]);
          setSearchError(null);
          setLoading(false);
        }
        return;
      }

      const requestId = ++searchRequestIdRef.current;
      if (!getIsMounted || getIsMounted()) {
        setLoading(true);
        setSearchError(null);
      }

      const sanitized = normalized.replace(/[%_]/g, '');
      const tasks: Array<Promise<SearchResult[]>> = [];

      if (category === 'all' || category === 'clubs') {
        tasks.push(
          (async () => {
            const { data, error } = await supabase
              .from('clubs')
              .select('id, name, avatar_url, member_count')
              .ilike('name', `%${sanitized}%`)
              .limit(10);
            if (error) throw error;
            return (data || []).map((club) => ({
              id: club.id,
              type: 'club' as const,
              name: club.name,
              subtitle: `${club.member_count || 0} members`,
              avatar: club.avatar_url,
            }));
          })()
        );
      }

      if (category === 'all' || category === 'players') {
        tasks.push(
          (async () => {
            const { data, error } = await supabase
              .from('profiles')
              .select('id, username, avatar_url:arena_avatar_url')
              .ilike('username', `%${sanitized}%`)
              .limit(10);
            if (error) throw error;
            return (data || []).map((player) => ({
              id: player.id,
              type: 'player' as const,
              name: player.username,
              avatar: player.avatar_url,
            }));
          })()
        );
      }

      if (category === 'all' || category === 'tables') {
        tasks.push(
          (async () => {
            const { data, error } = await supabase
              .from('tables')
              .select('id, name, stakes, current_players, max_players')
              .ilike('name', `%${sanitized}%`)
              .eq('is_deleted', false)
              .neq('status', 'closed')
              .is('tournament_id', null)
              .or('is_private.is.null,is_private.eq.false')
              .limit(10);
            if (error) throw error;
            return (data || []).map((table) => ({
              id: table.id,
              type: 'table' as const,
              name: table.name,
              subtitle: `${table.stakes} · ${table.current_players}/${table.max_players} seated`,
            }));
          })()
        );
      }

      if (category === 'all' || category === 'tournaments') {
        tasks.push(
          (async () => {
            const { data, error } = await supabase
              .from('tournaments')
              .select('id, name, buy_in_amount, buy_in_fee, status, current_players, max_players')
              .ilike('name', `%${sanitized}%`)
              .in('status', ['ANNOUNCED', 'REGISTERING', 'RUNNING'])
              .or('is_private.is.null,is_private.eq.false')
              .limit(10);
            if (error) throw error;
            return (data || []).map((tournament) => ({
              id: tournament.id,
              type: 'tournament' as const,
              name: tournament.name,
              subtitle: `${tournament.status} · ${formatBuyInShort(
                tournament.buy_in_amount || 0,
                tournament.buy_in_fee
              )} buy-in · ${tournament.current_players || 0}/${tournament.max_players || '∞'}`,
            }));
          })()
        );
      }

      const settled = await Promise.allSettled(tasks);
      if ((getIsMounted && !getIsMounted()) || requestId !== searchRequestIdRef.current) return;

      const successful = settled.filter(
        (entry): entry is PromiseFulfilledResult<SearchResult[]> => entry.status === 'fulfilled'
      );
      const failed = settled.filter((entry) => entry.status === 'rejected');
      failed.forEach((entry) => reportError(entry.reason, 'SearchPage.Search_failed'));
      setResults(successful.flatMap((entry) => entry.value));
      if (failed.length === settled.length) {
        setSearchError(
          'The community index is temporarily unavailable. Your query is safe to retry.'
        );
      } else if (failed.length > 0) {
        setSearchError(
          'Some community records could not be reached. The results below are partial.'
        );
      }
      setLoading(false);
    },
    [category]
  );

  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (debouncedQuery.trim() !== queryFromUrl.trim()) updateLocation(debouncedQuery);
    let isMounted = true;
    search(debouncedQuery, () => isMounted);
    return () => {
      isMounted = false;
    };
  }, [debouncedQuery, queryFromUrl, search, updateLocation]);

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
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [query, search]);

  const handleAddFriend = async (playerId: string) => {
    if (!user?.id) return;
    try {
      const { error } = await supabase.from('friendships').insert({
        user_id: user.id,
        friend_id: playerId,
        status: 'pending',
      });
      if (error && error.code !== '23505') throw error;
      setFriendAdded((previous) => new Set(previous).add(playerId));
      masterBus.emit('FRIEND_REQUEST_SENT', { fromUserId: user.id, toUserId: playerId });
      toast.success(
        error?.code === '23505' ? 'Friend request already sent' : 'Friend request sent!'
      );
    } catch (error) {
      reportError(error, 'SearchPage.setFriendAdded');
      toast.error('Failed to send request');
    }
  };

  const openResult = (result: SearchResult) => {
    rememberSearch(query);
    const destinations: Record<SearchResult['type'], string> = {
      club: `/clubs/${result.id}`,
      player: `/profile/${result.id}`,
      table: `/table/${result.id}`,
      tournament: `/tournaments/${result.id}`,
    };
    navigate(destinations[result.type]);
  };

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    rememberSearch(query);
    updateLocation(query, category, false);
    search(query);
  };

  const clearHistory = () => {
    setRecentSearches([]);
    localStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
  };

  return (
    <main className="search-page">
      <CommunitySurfaceHeader
        eyebrow="Community / Discovery"
        title="Find Your Next Game"
        description="Scan live players, clubs, open tables, and active tournaments from one precise community index."
        metrics={[
          { label: 'Live indexes', value: 4, tone: 'live' },
          { label: 'Current scope', value: category === 'all' ? 'Network' : category },
          { label: 'Results', value: loading ? 'Scanning' : results.length },
        ]}
      />

      <section className="search-console" aria-labelledby="search-console-title">
        <div className="search-console-heading">
          <div>
            <p className="search-section-kicker">Network Scanner</p>
            <h2 id="search-console-title">Community Search</h2>
          </div>
          <span className="search-index-status">LIVE DATA</span>
        </div>

        <form className="search-form" role="search" onSubmit={submitSearch}>
          <label htmlFor="community-search">Search The Smarter Poker Network</label>
          <div className="search-field-shell">
            <span className="search-field-mark" aria-hidden="true">
              ⌕
            </span>
            <input
              id="community-search"
              type="search"
              autoComplete="off"
              placeholder="Player, club, table, or tournament"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
            {query && (
              <button className="search-clear" type="button" onClick={() => setQuery('')}>
                Clear
              </button>
            )}
            <button className="search-submit" type="submit">
              Search
            </button>
          </div>
        </form>

        <div className="search-category-rail" role="tablist" aria-label="Search categories">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              id={`search-tab-${item.id}`}
              className={category === item.id ? 'is-active' : ''}
              type="button"
              role="tab"
              aria-selected={category === item.id}
              aria-controls="search-results-panel"
              onClick={() => updateLocation(query, item.id, false)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          id="search-results-panel"
          className="search-content"
          role="tabpanel"
          aria-labelledby={`search-tab-${category}`}
        >
          {searchError && (
            <div className="search-error" role="alert">
              <div>
                <strong>Index Connection Interrupted</strong>
                <span>{searchError}</span>
              </div>
              <button type="button" onClick={() => search(query)}>
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="search-skeletons" role="status" aria-label="Scanning community index">
              {Array.from({ length: 4 }).map((_, index) => (
                <div className="search-skeleton" key={index}>
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                </div>
              ))}
            </div>
          ) : searchError && results.length === 0 ? null : !query.trim() ? (
            <div className="search-history">
              <div className="search-history-heading">
                <div>
                  <p className="search-section-kicker">Local History</p>
                  <h3>Recent Searches</h3>
                </div>
                {recentSearches.length > 0 && (
                  <button type="button" onClick={clearHistory}>
                    Clear History
                  </button>
                )}
              </div>
              {recentSearches.length === 0 ? (
                <div className="search-empty compact">
                  <span aria-hidden="true">◇</span>
                  <p>Your Submitted Searches Will Appear Here.</p>
                </div>
              ) : (
                <div className="search-history-list">
                  {recentSearches.map((recent) => (
                    <button key={recent} type="button" onClick={() => setQuery(recent)}>
                      <span aria-hidden="true">↗</span>
                      {recent}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : results.length === 0 && !searchError ? (
            <div className="search-empty">
              <span aria-hidden="true">⌁</span>
              <h3>No Matches For “{query}”</h3>
              <p>
                {category === 'all'
                  ? 'Check the spelling or try a broader term.'
                  : 'Switch to All or try a broader term.'}
              </p>
            </div>
          ) : (
            <div className="search-results" aria-live="polite">
              <div className="search-results-heading">
                <span>{results.length} Matches</span>
                <span>{category === 'all' ? 'Across the network' : `Filtered to ${category}`}</span>
              </div>
              {results.map((result) => (
                <article className="search-result" key={`${result.type}-${result.id}`}>
                  <button
                    className="search-result-primary"
                    type="button"
                    onClick={() => openResult(result)}
                    aria-label={`Open ${result.name}`}
                  >
                    <span className="search-result-avatar" aria-hidden={!result.avatar}>
                      {result.avatar ? (
                        <img src={result.avatar} alt="" loading="lazy" />
                      ) : (
                        getResultMark(result.type)
                      )}
                    </span>
                    <span className="search-result-copy">
                      <strong>{result.name}</strong>
                      <span>
                        {result.subtitle || (result.id === user?.id ? 'Your profile' : result.type)}
                      </span>
                    </span>
                    <span className="search-result-type">{result.type}</span>
                  </button>

                  {result.type === 'player' && result.id !== user?.id && (
                    <div className="search-result-actions">
                      {friendAdded.has(result.id) ? (
                        <span className="search-request-sent">Request Sent</span>
                      ) : (
                        <button type="button" onClick={() => handleAddFriend(result.id)}>
                          Add Friend
                        </button>
                      )}
                      <button
                        className="is-primary"
                        type="button"
                        onClick={() => navigate(`/messages?compose=${result.id}`)}
                      >
                        Message
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
