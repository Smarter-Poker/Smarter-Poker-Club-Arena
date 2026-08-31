import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import haptic from '../../services/HapticService';
import {
  PlayerSearchService,
  type PlayerPresenceFilter,
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
import { titleCase } from '../../utils/titleCase';
import styles from './FindPlayerModal.module.css';

interface FindPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMembershipRequired: (intent: { code: string; watchTableId: string }) => void;
}

const PAGE_SIZE = 20;

export default function FindPlayerModal({
  isOpen,
  onClose,
  onMembershipRequired,
}: FindPlayerModalProps) {
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
  const [showAccessRules, setShowAccessRules] = useState(false);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [verifyingTableId, setVerifyingTableId] = useState<string | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const suggestionAbortRef = useRef<AbortController | null>(null);
  const suggestionTimerRef = useRef<number | null>(null);
  const lastCompletedQueryRef = useRef('');

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
    return () => {
      searchAbortRef.current?.abort();
      suggestionAbortRef.current?.abort();
      if (suggestionTimerRef.current) window.clearTimeout(suggestionTimerRef.current);
    };
  }, [isOpen]);

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

  const handleTableClick = async (table: PlayerSearchTable) => {
    if (verifyingTableId) return;
    setVerifyingTableId(table.table_id);
    setError(null);
    try {
      const access = await PlayerSearchService.getTableWatchAccess(table.table_id);
      if (access.can_watch) {
        haptic.success();
        ClubEntryTrustService.track('find', 'watch_opened', {
          outcome: 'succeeded',
          metadata: { table_id: table.table_id, tournament_id: table.tournament_id || null },
        });
        onClose();
        navigate(`/table/${table.table_id}?observer=1`);
        return;
      }

      if (['join', 'request_join', 'pending'].includes(access.action)) {
        const identifier =
          access.club_slug || String(access.club_id || '') || access.club_uuid || table.club_uuid;
        haptic.selection();
        ClubEntryTrustService.track('find', 'watch_membership_required', {
          outcome: 'viewed',
          metadata: { club_id: access.club_uuid || table.club_uuid, action: access.action },
        });
        onClose();
        onMembershipRequired({ code: identifier, watchTableId: table.table_id });
        return;
      }

      setError(
        access.action === 'observers_restricted'
          ? 'This table does not allow observers.'
          : 'This game is not available to watch.'
      );
    } catch (accessError) {
      reportError(accessError, 'FindPlayerModal.WatchAccess');
      setError('Could not verify table access. Please try again.');
    } finally {
      setVerifyingTableId(null);
    }
  };

  const handleProfileClick = (playerId: string) => {
    haptic.success();
    onClose();
    navigate(`/profile/${playerId}`);
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
    setExpandedAccounts(new Set());
    lastCompletedQueryRef.current = '';
    ClubEntryTrustService.track('find', 'closed', { outcome: 'cancelled' });
    onClose();
  };

  useDialogEscape(isOpen, () => (showAccessRules ? setShowAccessRules(false) : handleClose()));

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
          <div className={styles.scrollBody}>
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
                <p>Find Any Player, See Who Is Playing, And Open Their Live Game.</p>
              </div>
              <button
                className={styles.privacyButton}
                onClick={() => setShowAccessRules((value) => !value)}
                aria-expanded={showAccessRules}
              >
                Access Rules
              </button>
            </header>

            {showAccessRules && (
              <section className={styles.privacyPanel} aria-label="Player Search Access Rules">
                <p>
                  Player Identity And Playing Now Status Are Searchable Across Club Arena. Watching
                  Requires An Active Membership In The Game&apos;S Club.
                </p>
                <p>
                  Wallets, Balances, Statistics, Notes, And Hierarchy Data Are Returned Only For
                  Accounts Your Club, Union, Administrator, Or Agent Role Authorizes You To Manage.
                </p>
              </section>
            )}

            <div className={styles.searchSection}>
              <div className={styles.searchInputWrapper}>
                <input
                  type="search"
                  className={styles.searchInput}
                  placeholder="Name, Alias, Or Player Number…"
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
                  aria-label="Player Name, Poker Alias, Or Number"
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
                  <span className={styles.suggestLoading} aria-label="Loading Suggestions">
                    <span className={styles.suggestSpinner} aria-hidden="true" />
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

            <div className={styles.filterControls} aria-label="Player Search Filters">
              <label>
                Network
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as PlayerSearchScope)}
                >
                  <option value="all">All Players</option>
                  <option value="friends">Friends</option>
                  <option value="clubs">My Clubs</option>
                  <option value="union">My Unions</option>
                  <option value="managed">My Managed Accounts</option>
                </select>
              </label>
              <label>
                Status
                <select
                  value={presence}
                  onChange={(event) => setPresence(event.target.value as PlayerPresenceFilter)}
                >
                  <option value="all">Any Status</option>
                  <option value="online">Online</option>
                  <option value="playing">Playing Now</option>
                </select>
              </label>
              <label>
                Sort
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value as PlayerSearchSort)}
                >
                  <option value="relevance">Best Match</option>
                  <option value="name">Name</option>
                </select>
              </label>
              <span className={styles.scopeLabel}>
                {total
                  ? `${total} Eligible Match${total === 1 ? '' : 'es'}`
                  : 'Global Player Directory'}
              </span>
            </div>

            <div className={styles.resultsArea} aria-live="polite" aria-busy={isSearching}>
              {error && <div className={styles.errorMessage}>{titleCase(error)}</div>}
              {!error && !isSearching && lastCompletedQueryRef.current && results.length === 0 && (
                <div className={styles.notFoundMessage}>
                  <p>No Matching Players Were Found.</p>
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
                          <span
                            className={styles.playerStatus}
                            data-status={player.presence_status}
                          >
                            {presenceCopy(player)}
                          </span>
                        </span>
                        <span className={styles.relationshipBadge}>{player.relationship}</span>
                      </button>
                      {player.sensitive_accounts.length > 0 && (
                        <section className={styles.accountAccess}>
                          <button
                            className={styles.accountAccessToggle}
                            aria-expanded={expandedAccounts.has(player.id)}
                            onClick={() =>
                              setExpandedAccounts((current) => {
                                const next = new Set(current);
                                if (next.has(player.id)) next.delete(player.id);
                                else next.add(player.id);
                                return next;
                              })
                            }
                          >
                            Authorized Account Data ({player.sensitive_accounts.length})
                          </button>
                          {expandedAccounts.has(player.id) && (
                            <div className={styles.accountGrid}>
                              {player.sensitive_accounts.map((account) => (
                                <article key={account.club_uuid} className={styles.accountCard}>
                                  <header>
                                    <strong>{account.club_name}</strong>
                                    <span>
                                      {account.access} / {account.role}
                                    </span>
                                  </header>
                                  <dl>
                                    <div>
                                      <dt>Player</dt>
                                      <dd>{chips(account.wallets.player_wallet)}</dd>
                                    </div>
                                    <div>
                                      <dt>Agent</dt>
                                      <dd>{chips(account.wallets.agent_wallet)}</dd>
                                    </div>
                                    <div>
                                      <dt>Promo</dt>
                                      <dd>{chips(account.wallets.promo_wallet)}</dd>
                                    </div>
                                    <div>
                                      <dt>Club Chips</dt>
                                      <dd>{chips(account.wallets.chip_balance)}</dd>
                                    </div>
                                    <div>
                                      <dt>Direct</dt>
                                      <dd>{account.downline?.downline_direct ?? 0}</dd>
                                    </div>
                                    <div>
                                      <dt>Downline</dt>
                                      <dd>{account.downline?.downline_total ?? 0}</dd>
                                    </div>
                                  </dl>
                                </article>
                              ))}
                            </div>
                          )}
                        </section>
                      )}
                      {player.tables.length > 0 && (
                        <div className={styles.tablesList}>
                          {player.tables.map((table) => (
                            <button
                              key={table.id}
                              className={styles.tableCard}
                              onClick={() => void handleTableClick(table)}
                              disabled={verifyingTableId !== null}
                            >
                              <span className={styles.tableInfo}>
                                <span className={styles.tableName}>{table.name}</span>
                                <span className={styles.tableDetails}>
                                  {table.game_variant} • {table.stakes}
                                  {table.club_name && ` • ${table.club_name}`}
                                </span>
                              </span>
                              <span className={styles.watchButton}>
                                {verifyingTableId === table.table_id
                                  ? 'Verifying Access…'
                                  : watchLabel(table)}
                              </span>
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
                  <p>Search By Alias, Display Name, Or Player Number.</p>
                </div>
              )}
            </div>
          </div>

          <footer className={styles.pageFooter}>
            <button className={styles.closeButton} onClick={handleClose}>
              Close Locator
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function presenceCopy(player: PlayerSearchResult): string {
  if (player.tables.length)
    return `Playing At ${player.tables.length} Table${player.tables.length === 1 ? '' : 's'}`;
  if (player.presence_status === 'playing') return 'Playing Now';
  if (player.presence_status === 'online') return 'Online';
  return 'Offline';
}

function watchLabel(table: PlayerSearchTable): string {
  if (table.can_watch) return table.access_action === 'play' ? 'Return' : 'Watch';
  if (table.access_action === 'request_join') return 'Request To Join';
  if (table.access_action === 'join') return 'Join To Watch';
  if (table.access_action === 'pending') return 'Request Pending';
  if (table.access_action === 'observers_restricted') return 'Observers Off';
  return 'Unavailable';
}

function chips(value: number): string {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
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
