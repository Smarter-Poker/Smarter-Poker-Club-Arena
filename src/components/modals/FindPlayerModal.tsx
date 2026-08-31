import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import haptic from '../../services/HapticService';
import {
  PlayerSearchService,
  type PlayerPresenceFilter,
  type PlayerSearchPreferences,
  type PlayerSearchResult,
  type PlayerSearchScope,
  type PlayerSearchSort,
  type PlayerSearchTable,
} from '../../services/PlayerSearchService';
import { generateDefaultAvatar, sizedStorageUrl } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useDialogEscape } from '../../hooks/useDialogEscape';
import { ClubEntryTrustService } from '../../services/ClubEntryTrustService';
import styles from './FindPlayerModal.module.css';

interface FindPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PAGE_SIZE = 20;
const DEFAULT_PRIVACY: PlayerSearchPreferences = {
  discoverable: true,
  showDisplayName: true,
  showPresence: true,
  showCurrentTable: true,
};

export default function FindPlayerModal({ isOpen, onClose }: FindPlayerModalProps) {
  const navigate = useNavigate();
  const trapRef = useFocusTrap(isOpen);
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const [suggestions, setSuggestions] = useState<PlayerSearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<PlayerSearchScope>('all');
  const [presence, setPresence] = useState<PlayerPresenceFilter>('all');
  const [sort, setSort] = useState<PlayerSearchSort>('relevance');
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [privacy, setPrivacy] = useState<PlayerSearchPreferences>(DEFAULT_PRIVACY);
  const [privacyLoadState, setPrivacyLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [isSavingPrivacy, setIsSavingPrivacy] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  const suggestionAbortRef = useRef<AbortController | null>(null);
  const suggestionTimerRef = useRef<number | null>(null);
  const lastCompletedQueryRef = useRef('');

  const loadPrivacy = useCallback(async () => {
    setPrivacyLoadState('loading');
    try {
      setPrivacy(await PlayerSearchService.getPreferences());
      setPrivacyLoadState('ready');
    } catch (preferenceError) {
      reportError(preferenceError, 'FindPlayerModal.LoadPreferences');
      setPrivacyLoadState('error');
    }
  }, []);

  const runSearch = useCallback(
    async (query: string, offset = 0, append = false) => {
      const normalized = query.trim();
      if (normalized.length < 2) {
        setError('Enter at least two characters.');
        return;
      }
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      if (append) setIsLoadingMore(true);
      else setIsSearching(true);
      if (!append) {
        setResults([]);
        setTotal(0);
      }
      setError(null);
      setShowSuggestions(false);
      try {
        const page = await PlayerSearchService.search({
          query: normalized,
          limit: PAGE_SIZE,
          offset,
          scope,
          presence,
          sort,
          signal: controller.signal,
        });
        setResults((current) => (append ? [...current, ...page.items] : page.items));
        setTotal(page.total);
        setHasMore(page.hasMore);
        lastCompletedQueryRef.current = normalized;
      } catch (searchError) {
        if (searchError instanceof DOMException && searchError.name === 'AbortError') return;
        reportError(searchError, 'FindPlayerModal.Search');
        setError('Could not search right now. Please try again.');
      } finally {
        if (searchAbortRef.current === controller) {
          setIsSearching(false);
          setIsLoadingMore(false);
        }
      }
    },
    [presence, scope, sort]
  );

  useEffect(() => {
    if (!isOpen) return;
    ClubEntryTrustService.track('find', 'opened', { outcome: 'viewed' });
    void loadPrivacy();

    const channel = supabase
      .channel('club-arena-player-locator')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_presence' },
        (payload: { new?: Record<string, unknown> }) => {
          const update = payload.new;
          if (!update?.user_id || !update.status) return;
          setResults((current) =>
            current.map((player) =>
              player.id === update.user_id && player.presence_status !== 'hidden'
                ? {
                    ...player,
                    presence_status: String(update.status) as PlayerSearchResult['presence_status'],
                  }
                : player
            )
          );
        }
      )
      .subscribe();
    return () => {
      searchAbortRef.current?.abort();
      suggestionAbortRef.current?.abort();
      if (suggestionTimerRef.current) window.clearTimeout(suggestionTimerRef.current);
      supabase.removeChannel(channel);
    };
  }, [isOpen, loadPrivacy]);

  useEffect(() => {
    if (!isOpen || !lastCompletedQueryRef.current) return;
    runSearch(lastCompletedQueryRef.current);
  }, [scope, presence, sort, isOpen, runSearch]);

  const fetchSuggestions = useCallback(
    async (query: string) => {
      suggestionAbortRef.current?.abort();
      const controller = new AbortController();
      suggestionAbortRef.current = controller;
      setIsSuggesting(true);
      try {
        const page = await PlayerSearchService.search({
          query,
          limit: 6,
          scope,
          presence,
          sort: 'relevance',
          signal: controller.signal,
        });
        setSuggestions(page.items);
        setShowSuggestions(page.items.length > 0);
        setHighlightedIndex(-1);
      } catch (suggestionError) {
        if (!(suggestionError instanceof DOMException && suggestionError.name === 'AbortError')) {
          reportError(suggestionError, 'FindPlayerModal.Suggestions');
        }
      } finally {
        if (suggestionAbortRef.current === controller) setIsSuggesting(false);
      }
    },
    [presence, scope]
  );

  const handleInputChange = (value: string) => {
    setSearchQuery(value);
    setError(null);
    if (suggestionTimerRef.current) window.clearTimeout(suggestionTimerRef.current);
    suggestionAbortRef.current?.abort();
    if (value.trim().length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    suggestionTimerRef.current = window.setTimeout(() => fetchSuggestions(value.trim()), 300);
  };

  const chooseSuggestion = (player: PlayerSearchResult) => {
    const value = player.display_name || player.username;
    haptic.selection();
    setSearchQuery(value);
    setShowSuggestions(false);
    runSearch(value);
  };

  const handleTableClick = (table: PlayerSearchTable) => {
    haptic.success();
    onClose();
    navigate(table.is_tournament ? `/tournaments/${table.id}` : `/table/${table.id}`);
  };

  const handleProfileClick = (playerId: string) => {
    haptic.success();
    onClose();
    navigate(`/profile/${playerId}`);
  };

  const savePrivacy = async () => {
    if (privacyLoadState !== 'ready') return;
    setIsSavingPrivacy(true);
    setError(null);
    try {
      setPrivacy(await PlayerSearchService.setPreferences(privacy));
      setShowPrivacy(false);
    } catch (privacyError) {
      reportError(privacyError, 'FindPlayerModal.SavePreferences');
      setError('Could not save your search privacy.');
    } finally {
      setIsSavingPrivacy(false);
    }
  };

  const handleClose = () => {
    haptic.light();
    searchAbortRef.current?.abort();
    suggestionAbortRef.current?.abort();
    setSearchQuery('');
    setResults([]);
    setSuggestions([]);
    setError(null);
    setTotal(0);
    setHasMore(false);
    lastCompletedQueryRef.current = '';
    ClubEntryTrustService.track('find', 'closed', { outcome: 'cancelled' });
    onClose();
  };

  useDialogEscape(isOpen, () => (showPrivacy ? setShowPrivacy(false) : handleClose()));

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div
        ref={trapRef}
        className={styles.modalContainer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="find-player-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.modalContent}>
          <header className={styles.machineHeader}>
            <img
              src="/hub/club-arena/images/club-arena/vault-iris-emblem-v1-320.webp"
              alt=""
              width="320"
              height="296"
            />
            <div>
              <span className={styles.eyebrow}>Network Locator / Live Presence</span>
              <h2 id="find-player-title" className={styles.title}>
                Find A Player
              </h2>
              <p>Search only the friends, clubs, and unions your role permits.</p>
            </div>
            <button
              className={styles.privacyButton}
              onClick={() => {
                if (privacyLoadState === 'error') void loadPrivacy();
                else setShowPrivacy((value) => !value);
              }}
              disabled={privacyLoadState === 'loading'}
              title={
                privacyLoadState === 'error'
                  ? 'Visibility settings failed to load. Select to retry.'
                  : undefined
              }
              aria-expanded={showPrivacy}
            >
              {privacyLoadState === 'loading'
                ? 'Loading Visibility'
                : privacyLoadState === 'error'
                  ? 'Retry Visibility'
                  : 'My Visibility'}
            </button>
          </header>

          {showPrivacy && (
            <section className={styles.privacyPanel} aria-label="Player search privacy">
              <label>
                <input
                  type="checkbox"
                  checked={privacy.discoverable}
                  onChange={(event) =>
                    setPrivacy((value) => ({ ...value, discoverable: event.target.checked }))
                  }
                />{' '}
                Allow club and union members to find me
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={privacy.showDisplayName}
                  onChange={(event) =>
                    setPrivacy((value) => ({ ...value, showDisplayName: event.target.checked }))
                  }
                />{' '}
                Show my display name
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={privacy.showPresence}
                  onChange={(event) =>
                    setPrivacy((value) => ({ ...value, showPresence: event.target.checked }))
                  }
                />{' '}
                Show online presence
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={privacy.showCurrentTable}
                  disabled={!privacy.showPresence}
                  onChange={(event) =>
                    setPrivacy((value) => ({ ...value, showCurrentTable: event.target.checked }))
                  }
                />{' '}
                Show my current table
              </label>
              <button onClick={savePrivacy} disabled={isSavingPrivacy}>
                {isSavingPrivacy ? 'Saving…' : 'Save Visibility'}
              </button>
            </section>
          )}

          <div className={styles.searchSection}>
            <div className={styles.searchInputWrapper}>
              <input
                type="search"
                className={styles.searchInput}
                placeholder="Name, alias, or player number…"
                value={searchQuery}
                onChange={(event) => handleInputChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' && suggestions.length) {
                    event.preventDefault();
                    setHighlightedIndex((value) => (value + 1) % suggestions.length);
                  } else if (event.key === 'ArrowUp' && suggestions.length) {
                    event.preventDefault();
                    setHighlightedIndex(
                      (value) => (value - 1 + suggestions.length) % suggestions.length
                    );
                  } else if (event.key === 'Enter') {
                    if (showSuggestions && highlightedIndex >= 0)
                      chooseSuggestion(suggestions[highlightedIndex]);
                    else runSearch(searchQuery);
                  } else if (event.key === 'Escape') setShowSuggestions(false);
                }}
                onFocus={() => suggestions.length && setShowSuggestions(true)}
                aria-label="Player name, poker alias, or number"
                aria-autocomplete="list"
                aria-expanded={showSuggestions}
                autoFocus
              />
              {showSuggestions && (
                <div className={styles.suggestDropdown} role="listbox">
                  {suggestions.map((player, index) => (
                    <button
                      key={player.id}
                      role="option"
                      aria-selected={index === highlightedIndex}
                      className={styles.suggestItem}
                      onPointerMove={() => setHighlightedIndex(index)}
                      onClick={() => chooseSuggestion(player)}
                    >
                      <PlayerAvatar player={player} className={styles.suggestAvatar} />
                      <span className={styles.suggestInfo}>
                        <span className={styles.suggestName}>
                          {player.display_name || player.username}
                        </span>
                        {player.display_name && (
                          <span className={styles.suggestAlias}>@{player.username}</span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {isSuggesting && (
                <span className={styles.suggestLoading} aria-label="Loading suggestions">
                  ⟳
                </span>
              )}
            </div>
            <button
              className={styles.searchButton}
              onClick={() => runSearch(searchQuery)}
              disabled={isSearching || searchQuery.trim().length < 2}
            >
              {isSearching ? 'Scanning…' : 'Search'}
            </button>
          </div>

          <div className={styles.filterControls} aria-label="Player search filters">
            <label>
              Network
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as PlayerSearchScope)}
              >
                <option value="all">Best available</option>
                <option value="friends">Friends</option>
                <option value="clubs">My clubs</option>
                <option value="union">My unions</option>
              </select>
            </label>
            <label>
              Status
              <select
                value={presence}
                onChange={(event) => setPresence(event.target.value as PlayerPresenceFilter)}
              >
                <option value="all">Any status</option>
                <option value="online">Online</option>
                <option value="playing">Playing now</option>
              </select>
            </label>
            <label>
              Sort
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as PlayerSearchSort)}
              >
                <option value="relevance">Best match</option>
                <option value="name">Name</option>
              </select>
            </label>
            <span className={styles.scopeLabel}>
              {total
                ? `${total} eligible match${total === 1 ? '' : 'es'}`
                : 'Privacy-scoped results'}
            </span>
          </div>

          <div className={styles.resultsArea} aria-live="polite" aria-busy={isSearching}>
            {error && <div className={styles.errorMessage}>{error}</div>}
            {!error && !isSearching && lastCompletedQueryRef.current && results.length === 0 && (
              <div className={styles.notFoundMessage}>
                <p>No matching players in your permitted network.</p>
              </div>
            )}
            {results.length > 0 && (
              <div className={styles.resultsList}>
                {results.map((player) => (
                  <article key={player.id} className={styles.playerResult}>
                    <button
                      className={styles.playerHeader}
                      onClick={() => handleProfileClick(player.id)}
                    >
                      <PlayerAvatar player={player} className={styles.playerAvatar} />
                      <span className={styles.playerInfo}>
                        <span className={styles.playerName}>
                          {player.display_name || player.username}
                        </span>
                        {player.display_name && (
                          <span className={styles.playerAlias}>@{player.username}</span>
                        )}
                        <span className={styles.playerStatus} data-status={player.presence_status}>
                          {presenceCopy(player)}
                        </span>
                      </span>
                      <span className={styles.relationshipBadge}>{player.relationship}</span>
                    </button>
                    {player.tables.length > 0 && (
                      <div className={styles.tablesList}>
                        {player.tables.map((table) => (
                          <button
                            key={table.id}
                            className={styles.tableCard}
                            onClick={() => handleTableClick(table)}
                          >
                            <span className={styles.tableInfo}>
                              <span className={styles.tableName}>{table.name}</span>
                              <span className={styles.tableDetails}>
                                {table.game_variant} • {table.stakes}
                                {table.club_name && ` • ${table.club_name}`}
                              </span>
                            </span>
                            <span className={styles.watchButton}>Watch</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
                {hasMore && (
                  <button
                    className={styles.loadMoreButton}
                    disabled={isLoadingMore}
                    onClick={() => runSearch(lastCompletedQueryRef.current, results.length, true)}
                  >
                    {isLoadingMore ? 'Loading…' : 'Load More Players'}
                  </button>
                )}
              </div>
            )}
            {!error && !isSearching && !lastCompletedQueryRef.current && (
              <div className={styles.hintMessage}>
                <p>Search by alias, display name, or player number.</p>
              </div>
            )}
          </div>

          <button className={styles.closeButton} onClick={handleClose}>
            Close Locator
          </button>
        </div>
      </div>
    </div>
  );
}

function presenceCopy(player: PlayerSearchResult): string {
  if (player.presence_status === 'hidden') return 'Presence private';
  if (player.tables.length)
    return `Playing at ${player.tables.length} table${player.tables.length === 1 ? '' : 's'}`;
  if (player.presence_status === 'playing') return 'Playing now';
  if (player.presence_status === 'online') return 'Online';
  if (player.presence_status === 'away') return 'Away';
  return 'Offline';
}

function PlayerAvatar({ player, className }: { player: PlayerSearchResult; className: string }) {
  return (
    <span className={className}>
      {player.avatar_url ? (
        <img
          loading="lazy"
          decoding="async"
          src={sizedStorageUrl(player.avatar_url, 44)}
          alt=""
          onError={(event) => {
            event.currentTarget.src = generateDefaultAvatar();
          }}
        />
      ) : (
        <span aria-hidden="true">?</span>
      )}
    </span>
  );
}
