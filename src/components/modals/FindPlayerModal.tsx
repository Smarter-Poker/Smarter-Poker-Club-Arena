import { usePlayerPreference } from '../../hooks/usePlayerPreference';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FIND A PLAYER - the network locator, on the spade console (#ClubArenaConsole)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This was a full-surface sheet with the vault emblem bolted into its header,
 * a Rajdhani title, a rounded search well, a floating suggestion card with
 * 44px avatar discs, three native selects, and results built out of nested
 * rounded cards: a player card holding an affiliation chip rail, a grid of
 * bordered wallet cards and a stack of rounded table cards, each with its own
 * pill-shaped watch button. Frames on frames on frames.
 *
 * It is now Dan's approved spade master, cut into head / rails / foot by
 * SpadeConsole. Dan 2026-09-09: "I'M NOT A BIG FAN OF THESE CARDS. I DON'T
 * LIKE THE 4 BOXES, AND THE WAY IT STICKS OUT ON THE SIDES" - so every list
 * here prints as ROWS on the black glass: a suggestion is a row, a player is a
 * row, a club is a row, a wallet figure is a label in lit blue against a value
 * in silver, and an engraved rule separates them. The three selects are lit
 * words. The two doors are the plates painted into the foot - ACCESS RULES on
 * steel, SEARCH on the blue glass.
 *
 * THE WAY OUT IS UNCHANGED AND IT IS PINNED. The backdrop stays inert, there
 * is no corner dismiss, and the quiet exit at the bottom keeps its accessible
 * name "Close The Player Locator" (tests/components/FindPlayerLocator.test.tsx
 * asserts all three). Escape still unwinds one layer at a time.
 *
 * LESS TEXT, AND ONE TAP TO WATCH (Dan 2026-10-16): "CLEAN UP THE 'FIND A
 * PLAYER' TOO MUCH TEXT THAT ISN'T NEEDED. AND THERE SHOULD BE AN 'WATCH AT
 * TABLE' BUTTON WHEN THEY ARE PLAYING TO EASILY WATCH THEM." The Network
 * Locator eyebrow, the idle Live pill, the field label, the idle prompt, the
 * relationship word, a handle that repeats the name, the Clubs / Unions
 * headings and per-row status words, and the per-game heading, type label,
 * details and gate sentence are gone. A result is now its name, Playing /
 * Online / Offline, one quiet line of clubs and unions (plus a gold word for
 * each club the viewer could join), and a painted Watch At Table shell for
 * every live game.
 *
 * Nothing about the search changed. The two abort controllers, the 180ms
 * suggestion debounce, the three-character fuzzy floor, the access
 * revalidation at click time, the pagination and every track() call below are
 * the ones that were here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import haptic from '../../services/HapticService';
import {
  EMPTY_AFFILIATIONS,
  FUZZY_MIN_CHARS,
  QUERY_MAX_CHARS,
  PlayerSearchService,
  type PlayerClubAffiliation,
  type PlayerPresenceFilter,
  type PlayerSearchResult,
  type PlayerSearchScope,
  type PlayerSearchSort,
  type PlayerSearchTable,
} from '../../services/PlayerSearchService';
import { reportError } from '../../utils/errorReporter';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useDialogEscape } from '../../hooks/useDialogEscape';
import { ClubEntryTrustService } from '../../services/ClubEntryTrustService';
import { enumToTitleCase, titleCase } from '../../utils/titleCase';
import { SpadeConsole } from '../console/SpadeConsole';
import { WatchAtTableButton } from '../club/WatchAtTableButton';
import { withStakes } from '../../utils/tableEyebrow';
import { compactChips, formatWalletChips } from '../../utils/format';
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
const SUGGESTION_LIST_ID = 'find-player-suggestions';
/** fn_search_players' own refusal when the find_player feature flag is off. */
const SEARCH_UNAVAILABLE = 'Player search is temporarily unavailable.';

/** The three filters, as lit words rather than three drawn selects. */
const SCOPE_OPTIONS: ReadonlyArray<{ value: PlayerSearchScope; label: string }> = [
  { value: 'all', label: 'All Players' },
  { value: 'friends', label: 'Friends' },
  { value: 'clubs', label: 'My Clubs' },
  { value: 'union', label: 'My Unions' },
  { value: 'managed', label: 'My Managed Accounts' },
];

const PRESENCE_OPTIONS: ReadonlyArray<{ value: PlayerPresenceFilter; label: string }> = [
  { value: 'all', label: 'Any Status' },
  { value: 'online', label: 'Online' },
  { value: 'playing', label: 'Playing Now' },
];

const SORT_OPTIONS: ReadonlyArray<{ value: PlayerSearchSort; label: string }> = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'name', label: 'Name' },
];

export default function FindPlayerModal({
  isOpen,
  onClose,
  onMembershipRequired,
}: FindPlayerModalProps) {
  const navigate = useNavigate();
  const trapRef = useFocusTrap(isOpen);
  const [searchQuery, setSearchQuery] = usePlayerPreference('findPlayer.search', '', 'global');
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
  const [scope, setScope] = usePlayerPreference<PlayerSearchScope>(
    'findPlayer.scope',
    'all',
    'global'
  );
  const [presence, setPresence] = usePlayerPreference<PlayerPresenceFilter>(
    'findPlayer.presence',
    'all',
    'global'
  );
  const [sort, setSort] = usePlayerPreference<PlayerSearchSort>(
    'findPlayer.sort',
    'relevance',
    'global'
  );
  const [showAccessRules, setShowAccessRules] = useState(false);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [verifyingTableId, setVerifyingTableId] = useState<string | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const suggestionAbortRef = useRef<AbortController | null>(null);
  const suggestionTimerRef = useRef<number | null>(null);
  const lastCompletedQueryRef = useRef('');
  const watchScope = useRef({ open: isOpen, generation: 0 });
  const previousOpen = useRef(isOpen);
  const watchBusyRef = useRef(false);
  if (previousOpen.current !== isOpen) {
    previousOpen.current = isOpen;
    watchScope.current = { open: isOpen, generation: watchScope.current.generation + 1 };
    watchBusyRef.current = false;
  }
  const retireWatch = () => {
    watchScope.current = { open: false, generation: watchScope.current.generation + 1 };
    watchBusyRef.current = false;
  };

  const runSearch = useCallback(
    async (query: string, offset = 0, append = false) => {
      const normalized = query.trim().slice(0, QUERY_MAX_CHARS).trim();
      if (normalized.length < 2) {
        setError('Enter at least two characters.');
        return;
      }
      searchAbortRef.current?.abort();
      // A suggestion lookup still waiting on its debounce would reopen the
      // dropdown over the results the player just asked for (2026-10-25).
      if (suggestionTimerRef.current) window.clearTimeout(suggestionTimerRef.current);
      suggestionTimerRef.current = null;
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
        // A player whose presence changed between pages can land on the next page
        // too; Load More never prints the same player twice.
        setResults((current) =>
          append
            ? [
                ...current,
                ...page.items.filter((item) => !current.some((row) => row.id === item.id)),
              ]
            : page.items
        );
        setTotal(page.total);
        setHasMore(page.hasMore);
        lastCompletedQueryRef.current = normalized;
      } catch (searchError) {
        if (searchError instanceof DOMException && searchError.name === 'AbortError') return;
        reportError(searchError, 'FindPlayerModal.Search');
        setError(
          searchError instanceof Error && searchError.message === SEARCH_UNAVAILABLE
            ? SEARCH_UNAVAILABLE
            : 'Could not search right now. Please try again.'
        );
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
    watchScope.current = { open: true, generation: watchScope.current.generation + 1 };
    setVerifyingTableId(null);
    ClubEntryTrustService.track('find', 'opened', { outcome: 'viewed' });
    return () => {
      retireWatch();
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

  const handleInputChange = (raw: string) => {
    // maxLength already stops typing and pasting past the limit; this also covers
    // autofill and anything else that sets the value without going through it.
    const value = raw.slice(0, QUERY_MAX_CHARS);
    setSearchQuery(value);
    setError(null);
    if (!value.trim()) {
      // An emptied field shows nothing: results for words no longer there are noise.
      searchAbortRef.current?.abort();
      setResults([]);
      setTotal(0);
      setHasMore(false);
      setExpandedAccounts(new Set());
      lastCompletedQueryRef.current = '';
    }
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

  /** Join / apply to a club straight from the affiliations panel, with no table to return to. */
  const handleClubJoin = (club: PlayerClubAffiliation) => {
    if (club.viewer_action !== 'join' && club.viewer_action !== 'request_join') return;
    haptic.selection();
    ClubEntryTrustService.track('find', 'watch_membership_required', {
      outcome: 'viewed',
      metadata: { club_id: club.club_uuid, action: club.viewer_action, source: 'affiliations' },
    });
    retireWatch();
    onClose();
    onMembershipRequired({
      code: club.club_slug || String(club.club_id || '') || club.club_uuid,
      watchTableId: null,
    });
  };

  /**
   * Picking a suggestion shows that player, and only that player, at once. The
   * suggestion row is a full result from the same search, so there is nothing
   * to fetch; re-searching the name used to list everyone else who shared it.
   */
  const chooseSuggestion = (player: PlayerSearchResult) => {
    const value = (player.display_name || player.username).slice(0, QUERY_MAX_CHARS);
    haptic.selection();
    if (suggestionTimerRef.current) window.clearTimeout(suggestionTimerRef.current);
    suggestionTimerRef.current = null;
    suggestionAbortRef.current?.abort();
    searchAbortRef.current?.abort();
    setSearchQuery(value);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
    setError(null);
    setIsSearching(false);
    setResults([player]);
    setTotal(1);
    setHasMore(false);
    lastCompletedQueryRef.current = value.trim();
  };

  const handleTableClick = async (table: PlayerSearchTable, targetUserId: string) => {
    if (watchBusyRef.current || !watchScope.current.open) return;
    watchBusyRef.current = true;
    const generation = watchScope.current.generation;
    const isCurrent = () => watchScope.current.open && watchScope.current.generation === generation;
    setVerifyingTableId(table.table_id);
    setError(null);
    try {
      const access = await PlayerSearchService.getTableWatchAccess(table.table_id, targetUserId);
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      reportError(accessError, 'FindPlayerModal.WatchAccess');
      setError('Could not verify table access. Please try again.');
    } finally {
      if (isCurrent()) {
        watchBusyRef.current = false;
        setVerifyingTableId(null);
      }
    }
  };

  const handleProfileClick = (playerId: string) => {
    retireWatch();
    haptic.success();
    onClose();
    navigate(`/profile/${playerId}`);
  };

  const handleClose = () => {
    retireWatch();
    haptic.light();
    searchAbortRef.current?.abort();
    suggestionAbortRef.current?.abort();
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
        <div className={styles.scrollBody}>
          <SpadeConsole
            onClose={handleClose}
            as="div"
            className={styles.console}
            title="Find A Player"
            titleId="find-player-title"
            pill={total ? `${total} Found` : undefined}
            pillInk="blue"
            plates={{
              secondary: {
                label: 'Access Rules',
                onClick: () => setShowAccessRules((value) => !value),
                'aria-expanded': showAccessRules,
              },
              primary: {
                label: isSearching ? 'Scanning' : 'Search',
                ink: 'white',
                onClick: () => runSearch(searchQuery),
                disabled: isSearching || searchQuery.trim().length < 2,
              },
            }}
          >
            {showAccessRules && (
              <section className={styles.rules} aria-label="Player Search Access Rules">
                <p className={`sc-copy ${styles.copy}`}>
                  Player Identity And Playing Now Status Are Searchable Across Club Arena. Watching
                  Requires An Active Membership In The Game&apos;S Club.
                </p>
                <p className={`sc-copy ${styles.copy}`}>
                  Wallets, Balances, Statistics, Notes, And Hierarchy Data Are Returned Only For
                  Accounts Your Club, Union, Administrator, Or Agent Role Authorizes You To Manage.
                </p>
              </section>
            )}

            {/* A groove cut into the glass, not a bordered well. */}
            <div className={styles.field}>
              <input
                id="find-player-query"
                type="search"
                className={styles.input}
                placeholder="Name, Alias Or Player Number"
                maxLength={QUERY_MAX_CHARS}
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
                onFocus={() => {
                  if (suggestions.length) setShowSuggestions(true);
                }}
                // The list closes when focus leaves the field, so it cannot sit
                // open over the filters or the results.
                onBlur={() => setShowSuggestions(false)}
                aria-label="Name, Alias Or Number"
                aria-autocomplete="list"
                aria-expanded={showSuggestions}
                aria-controls={showSuggestions ? SUGGESTION_LIST_ID : undefined}
                aria-activedescendant={
                  showSuggestions && highlightedIndex >= 0
                    ? `${SUGGESTION_LIST_ID}-${highlightedIndex}`
                    : undefined
                }
                autoFocus
              />
              {isSuggesting && (
                <span className={`sc-label sc-ink--blue ${styles.fieldState}`}>
                  Loading Suggestions
                </span>
              )}
            </div>

            {/* Suggestions print as rows under the groove. A floating card over
                the glass would be a frame on a frame. */}
            {showSuggestions && (
              <div
                id={SUGGESTION_LIST_ID}
                className={styles.suggestList}
                role="listbox"
                aria-label="Suggested Players"
              >
                {suggestions.map((player, index) => (
                  <button
                    key={player.id}
                    id={`${SUGGESTION_LIST_ID}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === highlightedIndex}
                    className={styles.suggestRow}
                    onPointerMove={() => setHighlightedIndex(index)}
                    // Keep focus in the field so its blur does not close the list
                    // before this row's click lands.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSuggestion(player)}
                  >
                    <span
                      className={`${styles.rowName} ${
                        index === highlightedIndex ? 'sc-ink--white' : 'sc-ink--silver'
                      }`}
                    >
                      {titleCase(player.display_name || player.username)}
                    </span>
                    {showsHandle(player) && (
                      <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
                        @{titleCase(player.username)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* The three filters: lit words, never a drawn select. */}
            <details className={styles.filterDetails}>
              <summary>Filters</summary>
              <div className={styles.filters}>
                <WordFilter
                  label="Network"
                  groupLabel="Player Search Network"
                  options={SCOPE_OPTIONS}
                  value={scope}
                  onChange={setScope}
                />
                <WordFilter
                  label="Status"
                  groupLabel="Player Search Status"
                  options={PRESENCE_OPTIONS}
                  value={presence}
                  onChange={setPresence}
                />
                <WordFilter
                  label="Sort"
                  groupLabel="Player Search Sort"
                  options={SORT_OPTIONS}
                  value={sort}
                  onChange={setSort}
                />
                <div className={styles.fact}>
                  <span className="sc-label sc-ink--blue">Directory</span>
                  <span className={`${styles.factValue} sc-ink--silver`}>
                    {total
                      ? `${total} Eligible Match${total === 1 ? '' : 'Es'}`
                      : 'Global Player Directory'}
                  </span>
                </div>
              </div>
            </details>

            <div className={styles.results} aria-live="polite" aria-busy={isSearching}>
              {error && <p className={`sc-copy sc-ink--red ${styles.copy}`}>{titleCase(error)}</p>}
              {/* Only for the words in the field now: an empty answer to an
                  earlier search never sits under a new one (2026-10-25). */}
              {!error &&
                !isSearching &&
                lastCompletedQueryRef.current &&
                lastCompletedQueryRef.current === searchQuery.trim() &&
                results.length === 0 && (
                  <p className={`sc-copy sc-copy--center sc-ink--muted ${styles.copy}`}>
                    No Matching Players Were Found.
                  </p>
                )}
              {results.length > 0 && (
                <div className={styles.resultList}>
                  {results.map((player) => (
                    <article key={player.id} className={styles.player}>
                      <button
                        className={styles.playerHeader}
                        onClick={() => handleProfileClick(player.id)}
                      >
                        <span className={`${styles.rowName} sc-ink--silver`}>
                          {titleCase(player.display_name || player.username)}
                        </span>
                        {showsHandle(player) && (
                          <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
                            @{titleCase(player.username)}
                          </span>
                        )}
                        <span
                          className={`sc-label ${styles.rowAside} ${
                            player.presence_status === 'playing'
                              ? 'sc-ink--green'
                              : player.presence_status === 'online'
                                ? 'sc-ink--blue'
                                : 'sc-ink--muted'
                          }`}
                        >
                          {presenceCopy(player)}
                        </span>
                      </button>

                      {/* Watch At Table (Dan 2026-10-16): one painted control per
                          live game, straight under the name, so watching a
                          player is a single tap. Access is still revalidated
                          at click time by handleTableClick. */}
                      {player.tables.length > 0 && (
                        <div className={styles.tables}>
                          {player.tables.map((table) => (
                            <WatchAtTableButton
                              key={table.id}
                              onClick={() => void handleTableClick(table, player.id)}
                              disabled={verifyingTableId !== null}
                              socket={table.is_tournament ? 'MTT' : 'Cash'}
                              eyebrow={tableEyebrow(table)}
                              title={
                                verifyingTableId === table.table_id
                                  ? 'Verifying Access'
                                  : watchLabel(table)
                              }
                              tone={table.can_watch ? 'watch' : 'gated'}
                              ariaLabel={`${watchLabel(table)}, ${titleCase(table.name)}`}
                            />
                          ))}
                        </div>
                      )}

                      <PlayerAffiliations player={player} onJoinClub={handleClubJoin} />

                      {player.sensitive_accounts.length > 0 && (
                        <section className={styles.accounts}>
                          <button
                            className={`${styles.word} sc-ink--blue`}
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
                            Account Data
                          </button>
                          {expandedAccounts.has(player.id) &&
                            player.sensitive_accounts.map((account) => (
                              <div key={account.club_uuid} className={styles.account}>
                                <div className={styles.accountHead}>
                                  <span className={`${styles.rowName} sc-ink--silver`}>
                                    {titleCase(account.club_name)}
                                  </span>
                                  <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
                                    {enumToTitleCase(account.access)} /{' '}
                                    {enumToTitleCase(account.role)}
                                  </span>
                                </div>
                                <dl className={styles.facts}>
                                  <Fact
                                    label="Player"
                                    value={formatWalletChips(account.wallets.player_wallet)}
                                  />
                                  <Fact
                                    label="Agent"
                                    value={formatWalletChips(account.wallets.agent_wallet)}
                                  />
                                  <Fact
                                    label="Promo"
                                    value={formatWalletChips(account.wallets.promo_wallet)}
                                  />
                                  <Fact
                                    label="Club Chips"
                                    value={formatWalletChips(account.wallets.chip_balance)}
                                  />
                                  <Fact
                                    label="Direct"
                                    value={compactChips(account.downline?.downline_direct ?? 0)}
                                  />
                                  <Fact
                                    label="Downline"
                                    value={compactChips(account.downline?.downline_total ?? 0)}
                                  />
                                </dl>
                              </div>
                            ))}
                        </section>
                      )}
                    </article>
                  ))}
                  {hasMore && (
                    <button
                      className={`${styles.word} ${isLoadingMore ? 'sc-ink--muted' : 'sc-ink--blue'}`}
                      disabled={isLoadingMore}
                      onClick={() => runSearch(lastCompletedQueryRef.current, results.length, true)}
                    >
                      {isLoadingMore ? 'Loading' : 'Load More Players'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </SpadeConsole>
        </div>

        {/* The quiet exit, locked above the home indicator. There is no corner
            dismiss and the backdrop is inert, so this is the mouse route out. */}
        <footer className={styles.pageFooter}>
          <button
            className={`${styles.exit} sc-ink--muted`}
            onClick={handleClose}
            aria-label="Close The Player Locator"
          >
            Exit Locator
          </button>
        </footer>
      </div>
    </div>
  );
}

/** One label/value pair on the glass: lit blue on the left, silver on the right. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.fact}>
      <dt className="sc-label sc-ink--blue">{label}</dt>
      <dd className={`${styles.factValue} sc-ink--silver`}>{value}</dd>
    </div>
  );
}

/** A filter as a rail of lit words. A select is a control the master never paints. */
function WordFilter<T extends string>({
  label,
  groupLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  groupLabel: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className={styles.filter}>
      <span className="sc-label sc-ink--blue">{label}</span>
      <div className={styles.filterRail} role="radiogroup" aria-label={groupLabel}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={`${styles.filterWord} ${
              option.value === value ? 'sc-ink--silver' : 'sc-ink--muted'
            }`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function presenceCopy(player: PlayerSearchResult): string {
  // A seat the viewer may not see (anonymous or hidden table) still reads Playing.
  if (player.tables.length || player.presence_status === 'playing') return 'Playing';
  if (player.presence_status === 'online') return 'Online';
  return 'Offline';
}

/**
 * The @handle only earns its line when it says something the name does not:
 * "Dinodollars @Dinodollars" printed the same word twice (Dan 2026-10-16,
 * "TOO MUCH TEXT THAT ISN'T NEEDED").
 */
function showsHandle(player: PlayerSearchResult): boolean {
  if (!player.display_name || !player.username) return false;
  return player.display_name.trim().toLowerCase() !== player.username.trim().toLowerCase();
}

/** Which table, on one line: its name and stakes, or its club when it is locked. */
function tableEyebrow(table: PlayerSearchTable): string {
  const name = titleCase(table.name);
  if (!table.can_watch && table.club_name) return `${name} · ${titleCase(table.club_name)}`;
  return withStakes(name, titleCase(table.stakes));
}

function watchLabel(table: PlayerSearchTable): string {
  if (table.can_watch) return table.access_action === 'play' ? 'Return To Seat' : 'Watch At Table';
  if (table.access_action === 'request_join') return 'Apply To Join';
  if (table.access_action === 'join') return 'Join Club To Watch';
  if (table.access_action === 'pending') return 'Request Pending';
  if (table.access_action === 'observers_restricted') return 'Observers Off';
  return 'Unavailable';
}

/**
 * Clubs and unions the searched player belongs to, with the viewer's own way in.
 *
 * Dan 2026-10-16: "TOO MUCH TEXT THAT ISN'T NEEDED". This was two headed lists,
 * a row per club with a status word beside it and a row per union with its
 * code. It is now one quiet line of names, plus a lit gold word for each club
 * the viewer could still join - the only entry here anyone acts on.
 */
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

  // A club whose live game already carries its join action on the Watch At
  // Table shell is not offered a second time as a word.
  const offeredByGame = new Set(
    player.tables.filter((table) => !table.can_watch).map((table) => table.club_uuid)
  );
  const joinable = clubs.filter(
    (club) =>
      (club.viewer_action === 'join' || club.viewer_action === 'request_join') &&
      !offeredByGame.has(club.club_uuid)
  );
  const named = [
    ...clubs.filter((club) => !joinable.includes(club)).map((club) => titleCase(club.club_name)),
    ...unions.map((union) => titleCase(union.union_name)),
    ...(hasHidden ? ['Private Clubs'] : []),
  ];

  return (
    <section
      className={styles.affiliations}
      aria-label={`Clubs And Unions For ${titleCase(player.display_name || player.username)}`}
    >
      {named.length > 0 && (
        <p className={`sc-copy sc-ink--muted ${styles.copy} ${styles.affiliationLine}`}>
          {named.join(' / ')}
        </p>
      )}
      {joinable.map((club) => (
        <button
          key={club.club_uuid}
          type="button"
          className={`${styles.word} sc-ink--gold`}
          onClick={() => onJoinClub(club)}
        >
          {club.viewer_action === 'request_join' ? 'Apply To Join' : 'Join'}{' '}
          {titleCase(club.club_name)}
        </button>
      ))}
    </section>
  );
}
