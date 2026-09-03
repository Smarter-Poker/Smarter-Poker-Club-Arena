import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import haptic from '../../services/HapticService';
import {
  EMPTY_AFFILIATIONS,
  FUZZY_MIN_CHARS,
  PlayerSearchService,
  type PlayerClubAffiliation,
  type PlayerPresenceFilter,
  type PlayerSearchResult,
  type PlayerSearchPreferences,
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
  /**
   * watchTableId is null when the viewer asked to join a club from the affiliations
   * panel rather than from a live game — there is no table to land on afterwards.
   */
  onMembershipRequired: (intent: { code: string; watchTableId: string | null }) => void;
}

const PAGE_SIZE = 20;
/**
 * Short enough to feel live, long enough that the trigram query is not re-issued
 * on every keystroke of a fast typist.
 */
const SUGGEST_DEBOUNCE_MS = 180;

export default function FindPlayerModal({
  isOpen,
  onClose,
  onMembershipRequired,
}: FindPlayerModalProps) {
  const navigate = useNavigate();
  // Without this the trap focuses the first focusable descendant, which is the
  // Access Rules button in the header, one frame after autoFocus put the caret
  // in the search box. Opening the locator and typing did nothing.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(isOpen, searchInputRef);
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
  const [preferences, setPreferences] = useState<PlayerSearchPreferences | null>(null);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
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
      // Also cancel any suggestion in flight or still on the debounce. Without
      // this, hitting Enter within the debounce window let the type-ahead
      // resolve afterwards and pop its dropdown open on top of the results the
      // user just asked for.
      if (suggestionTimerRef.current) window.clearTimeout(suggestionTimerRef.current);
      suggestionAbortRef.current?.abort();
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
    // Live fuzzy matching starts at the third character: that is the point where
    // the server widens from substring to trigram similarity, so suggesting
    // earlier would show a narrower result set than the one the user is about to
    // get and make the list appear to shrink as they type.
    if (value.trim().length < FUZZY_MIN_CHARS) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    suggestionTimerRef.current = window.setTimeout(
      () => fetchSuggestions(value.trim()),
      SUGGEST_DEBOUNCE_MS
    );
  };

  // The server enforces these three preferences; until now nothing set them, so
  // the enforcement governed a value no player could reach. Loaded lazily on
  // first open of the panel so the locator's own search path stays one request.
  useEffect(() => {
    if (!showAccessRules || preferences) return;
    let cancelled = false;
    void PlayerSearchService.getPreferences()
      .then((value) => {
        if (!cancelled) setPreferences(value);
      })
      .catch((prefsError) => {
        reportError(prefsError, 'FindPlayerModal.LoadPreferences');
        if (!cancelled) setPreferencesError('Could Not Load Your Search Privacy Settings.');
      });
    return () => {
      cancelled = true;
    };
  }, [showAccessRules, preferences]);

  const savePreference = async (patch: Partial<PlayerSearchPreferences>) => {
    if (!preferences || savingPreferences) return;
    const next = { ...preferences, ...patch };
    setPreferences(next); // optimistic, reverted below if the write fails
    setSavingPreferences(true);
    setPreferencesError(null);
    try {
      setPreferences(await PlayerSearchService.setPreferences(next));
    } catch (prefsError) {
      reportError(prefsError, 'FindPlayerModal.SavePreferences');
      setPreferences(preferences);
      setPreferencesError('Could Not Save. Please Try Again.');
    } finally {
      setSavingPreferences(false);
    }
  };

  /** Join / apply to a club straight from the affiliations panel, with no table to return to. */
  const handleClubJoin = (club: PlayerClubAffiliation) => {
    if (club.viewer_action !== 'join' && club.viewer_action !== 'request_join') return;
    haptic.selection();
    ClubEntryTrustService.track('find', 'watch_membership_required', {
      outcome: 'viewed',
      metadata: { club_id: club.club_uuid, action: club.viewer_action, source: 'affiliations' },
    });
    onClose();
    onMembershipRequired({
      code: club.club_slug || String(club.club_id || '') || club.club_uuid,
      watchTableId: null,
    });
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
        // 'play' means the viewer is SITTING at this table. Sending them in with
        // observer=1 would seat them as a spectator on their own live hand, which
        // is what happened before this branch existed: can_watch is true for your
        // own seat, and every can_watch went to the observer route.
        const ownSeat = access.action === 'play';
        haptic.success();
        ClubEntryTrustService.track('find', ownSeat ? 'seat_resumed' : 'watch_opened', {
          outcome: 'succeeded',
          metadata: { table_id: table.table_id, tournament_id: table.tournament_id || null },
        });
        onClose();
        navigate(ownSeat ? `/table/${table.table_id}` : `/table/${table.table_id}?observer=1`);
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
    // HomePage keeps this modal mounted and only toggles isOpen, so any panel
    // flag left standing here is still standing on reopen. Leaving
    // showSuggestions set produced an empty listbox under the input AND made
    // the first Escape after reopening do nothing, which is exactly the trap
    // the layered Escape above exists to prevent.
    setShowSuggestions(false);
    setShowAccessRules(false);
    setHighlightedIndex(-1);
    setError(null);
    setTotal(0);
    setHasMore(false);
    setExpandedAccounts(new Set());
    lastCompletedQueryRef.current = '';
    ClubEntryTrustService.track('find', 'closed', { outcome: 'cancelled' });
    onClose();
  };

  /**
   * Escape unwinds one layer at a time — access rules, then the suggestion list,
   * then the locator itself. With the backdrop inert and no corner X, Escape is the
   * only keyboard way out, so it must not slam the whole page shut on the keypress
   * a user meant for the autocomplete.
   */
  useDialogEscape(isOpen, () => {
    if (showAccessRules) {
      setShowAccessRules(false);
      return;
    }
    if (showSuggestions) {
      setShowSuggestions(false);
      return;
    }
    handleClose();
  });

  if (!isOpen) return null;

  return (
    // The backdrop is deliberately inert: the locator is a full-surface page and
    // a stray click outside the panel must not dismiss a search in progress. The
    // quiet exit at the bottom of the page is the mouse route out; Escape stays
    // wired so keyboard and screen-reader users are never trapped in the dialog.
    <div className={styles.overlay}>
      <div
        ref={trapRef}
        className={styles.modalContainer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="find-player-title"
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
                  A Game Requires An Active Membership In The Club Hosting It.
                </p>
                <p>
                  Club And Union Membership Is Shown For Open Clubs. A Club That Is Private Or
                  Requires Approval Is Named Only To Someone Already In That Club Or Its Union.
                  Everything Else Is Withheld Without Being Counted.
                </p>
                <p>
                  Wallets, Balances, Statistics, Notes, And Hierarchy Data Are Returned Only For
                  Accounts Your Club, Union, Administrator, Or Agent Role Authorizes You To Manage.
                </p>
                <p>
                  Your Own Visibility Is Yours To Set. Staff And Agents Who Administer Your Account
                  Still See You.
                </p>
                {preferences ? (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={preferences.discoverable}
                        disabled={savingPreferences}
                        onChange={(event) =>
                          void savePreference({ discoverable: event.target.checked })
                        }
                      />
                      Let Other Players Find Me
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={preferences.showPresence}
                        disabled={savingPreferences}
                        onChange={(event) =>
                          void savePreference({ showPresence: event.target.checked })
                        }
                      />
                      Show When I Am Online Or Playing
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={preferences.showCurrentTable}
                        disabled={savingPreferences}
                        onChange={(event) =>
                          void savePreference({ showCurrentTable: event.target.checked })
                        }
                      />
                      Show Which Game I Am In
                    </label>
                    {preferencesError && <p>{preferencesError}</p>}
                  </>
                ) : (
                  <p>{preferencesError || 'Loading Your Search Privacy Settings…'}</p>
                )}
              </section>
            )}

            <div className={styles.searchSection}>
              <div className={styles.searchInputWrapper}>
                <input
                  ref={searchInputRef}
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
                    }
                    // Escape is handled once, by useDialogEscape, so the dropdown
                    // and the dialog cannot both react to the same keypress.
                  }}
                  onFocus={() => suggestions.length && setShowSuggestions(true)}
                  aria-label="Player Name, Poker Alias, Or Number"
                  // Arrow keys move a purely visual highlight; aria-controls and
                  // aria-activedescendant are what make that movement audible to
                  // a screen reader. Deliberately NOT role="combobox": that would
                  // override the implicit searchbox role of <input type="search">,
                  // which this app and its tests query by.
                  aria-autocomplete="list"
                  aria-expanded={showSuggestions}
                  aria-controls="find-player-suggestions"
                  aria-activedescendant={
                    showSuggestions && highlightedIndex >= 0 && suggestions[highlightedIndex]
                      ? `find-player-suggestion-${suggestions[highlightedIndex].id}`
                      : undefined
                  }
                  autoFocus
                />
                {showSuggestions && (
                  <div
                    className={styles.suggestDropdown}
                    role="listbox"
                    id="find-player-suggestions"
                  >
                    {suggestions.map((player, index) => (
                      <button
                        key={player.id}
                        id={`find-player-suggestion-${player.id}`}
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
                        {/* The header promises "see who is playing", so the
                            type-ahead should answer it before you commit to a
                            search. The payload already carries presence. */}
                        {player.presence_status !== 'offline' && (
                          <span
                            className={styles.suggestPresence}
                            data-status={player.presence_status}
                          >
                            {player.presence_status === 'playing' ? 'Playing' : 'Online'}
                          </span>
                        )}
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
                  ? `${total} Eligible Match${total === 1 ? '' : 'Es'}`
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
                        <span className={styles.relationshipBadge}>
                          {relationshipLabel(player.relationship)}
                        </span>
                      </button>

                      <PlayerAffiliations player={player} onJoinClub={handleClubJoin} />

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
                                      {enumLabel(account.access)} / {enumLabel(account.role)}
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
                          <span className={styles.tablesHeading}>
                            Playing Now - {player.tables.length} Live Game
                            {player.tables.length === 1 ? '' : 's'}
                          </span>
                          {player.tables.map((table) => (
                            <button
                              key={table.id}
                              className={styles.tableCard}
                              data-locked={!table.can_watch || undefined}
                              onClick={() => void handleTableClick(table)}
                              disabled={verifyingTableId !== null}
                            >
                              <span className={styles.tableInfo}>
                                <span className={styles.tableKind} data-kind={gameKind(table)}>
                                  {table.is_tournament ? 'Tournament' : 'Cash Game'}
                                </span>
                                <span className={styles.tableName}>{table.name}</span>
                                <span className={styles.tableDetails}>
                                  {table.game_variant} • {table.stakes}
                                  {table.club_name && ` • ${table.club_name}`}
                                </span>
                                {!table.can_watch && (
                                  <span className={styles.tableGateNote}>{gateCopy(table)}</span>
                                )}
                              </span>
                              <span
                                className={styles.watchButton}
                                data-action={table.can_watch ? 'open' : table.access_action}
                              >
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
                  <p>
                    Search By Alias, Display Name, Or Player Number. Close Matches Appear After{' '}
                    {FUZZY_MIN_CHARS} Letters - Spelling Does Not Have To Be Exact.
                  </p>
                </div>
              )}
            </div>
          </div>

          <footer className={styles.pageFooter}>
            <button
              className={styles.closeButton}
              onClick={handleClose}
              aria-label="Close The Player Locator"
            >
              Exit Locator
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function presenceCopy(player: PlayerSearchResult): string {
  const tournaments = player.tables.filter((table) => table.is_tournament).length;
  const cash = player.tables.length - tournaments;
  if (player.tables.length) {
    const parts: string[] = [];
    if (cash) parts.push(`${cash} Cash Game${cash === 1 ? '' : 's'}`);
    if (tournaments) parts.push(`${tournaments} Tournament${tournaments === 1 ? '' : 's'}`);
    return `Playing Now - ${parts.join(' And ')}`;
  }
  // Seated somewhere the viewer is not allowed to see (anonymous or hidden table).
  if (player.presence_status === 'playing') return 'Playing Now';
  if (player.presence_status === 'online') return 'Online';
  return 'Offline';
}

/**
 * CLAUDE.md section 9 lists rendering a raw DB enum as a known bug shape
 * (HIGH_HAND reaching a player instead of "High Hand"). These two were doing it:
 * the relationship badge printed "public"/"managed", and the account card
 * printed "downline / super_agent".
 */
function relationshipLabel(relationship: PlayerSearchResult['relationship']): string {
  switch (relationship) {
    case 'self':
      return 'You';
    case 'friend':
      return 'Friend';
    case 'club':
      return 'Your Club';
    case 'union':
      return 'Your Union';
    case 'managed':
      return 'Your Player';
    default:
      return 'Arena';
  }
}

function enumLabel(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function gameKind(table: PlayerSearchTable): 'tournament' | 'cash' {
  return table.is_tournament ? 'tournament' : 'cash';
}

function watchLabel(table: PlayerSearchTable): string {
  if (table.can_watch) return table.access_action === 'play' ? 'Return To Seat' : 'Observe Table';
  if (table.access_action === 'request_join') return 'Apply To Join';
  if (table.access_action === 'join') return 'Join Club';
  if (table.access_action === 'pending') return 'Request Pending';
  if (table.access_action === 'observers_restricted') return 'Observers Off';
  return 'Unavailable';
}

/**
 * Why this game cannot be opened yet, in the viewer's own terms. The point is that
 * a locked card still tells you exactly what to do next rather than dead-ending.
 */
function gateCopy(table: PlayerSearchTable): string {
  const club = table.club_name || 'This Club';
  switch (table.access_action) {
    case 'join':
      return `Members Only - Join ${club} To Observe This Table.`;
    case 'request_join':
      return `Members Only - ${club} Is Gated. Apply To Join And Wait For Approval Before You Can Observe.`;
    case 'pending':
      return `Your Request To Join ${club} Is Awaiting Approval.`;
    case 'observers_restricted':
      return 'This Table Has Turned Observers Off.';
    default:
      return `You Cannot Enter ${club} Right Now.`;
  }
}

function clubActionLabel(action: PlayerClubAffiliation['viewer_action']): string {
  switch (action) {
    case 'member':
      return 'Your Club';
    case 'pending':
      return 'Approval Pending';
    case 'request_join':
      return 'Apply To Join';
    case 'join':
      return 'Join';
    default:
      return 'Closed';
  }
}

/** Clubs and unions the searched player belongs to, with the viewer's own way in. */
function PlayerAffiliations({
  player,
  onJoinClub,
}: {
  player: PlayerSearchResult;
  onJoinClub: (club: PlayerClubAffiliation) => void;
}) {
  // A player row can arrive without affiliations from an older cached bundle or a
  // half-rolled-out RPC. Falling back keeps the whole result list rendering instead
  // of blanking the modal on a destructure.
  const { clubs, unions, has_hidden: hasHidden } = player.affiliations || EMPTY_AFFILIATIONS;
  if (!clubs.length && !unions.length && !hasHidden) return null;

  return (
    <section
      className={styles.affiliations}
      aria-label={`Clubs And Unions For ${player.display_name || player.username}`}
    >
      {clubs.length > 0 && (
        <div className={styles.affiliationGroup}>
          <span className={styles.affiliationLabel}>Clubs</span>
          <ul className={styles.affiliationList}>
            {clubs.map((club) => {
              const joinable =
                club.viewer_action === 'join' || club.viewer_action === 'request_join';
              return (
                <li key={club.club_uuid}>
                  {joinable ? (
                    <button
                      type="button"
                      className={styles.affiliationChip}
                      data-action={club.viewer_action}
                      onClick={() => onJoinClub(club)}
                      title={
                        club.viewer_action === 'request_join'
                          ? `${club.club_name} Is Gated - Apply And Wait For Approval`
                          : `Join ${club.club_name}`
                      }
                    >
                      <span className={styles.affiliationName}>{club.club_name}</span>
                      <span className={styles.affiliationAction}>
                        {clubActionLabel(club.viewer_action)}
                      </span>
                    </button>
                  ) : (
                    <span className={styles.affiliationChip} data-action={club.viewer_action}>
                      <span className={styles.affiliationName}>{club.club_name}</span>
                      <span className={styles.affiliationAction}>
                        {clubActionLabel(club.viewer_action)}
                      </span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {unions.length > 0 && (
        <div className={styles.affiliationGroup}>
          <span className={styles.affiliationLabel}>Unions</span>
          <ul className={styles.affiliationList}>
            {unions.map((union) => (
              <li key={union.union_id}>
                <span className={styles.affiliationChip} data-action="union">
                  <span className={styles.affiliationName}>{union.union_name}</span>
                  {union.union_code && (
                    <span className={styles.affiliationAction}>#{union.union_code}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasHidden && (
        <p className={styles.affiliationHidden}>
          Private Clubs Not Shown. You Only See Clubs You Share Or Clubs That Are Open.
        </p>
      )}
    </section>
  );
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
