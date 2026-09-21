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
import { titleCase } from '../../utils/titleCase';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
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
            as="div"
            className={styles.console}
            eyebrow="Network Locator"
            title="Find A Player"
            titleId="find-player-title"
            pill={total ? `${total} Found` : 'Live'}
            pillInk={total ? 'blue' : 'muted'}
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
            <p className={`sc-copy sc-copy--center ${styles.copy}`}>
              Find Any Player, See Who Is Playing, And Open Their Live Game.
            </p>

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
              <label className="sc-label sc-ink--blue" htmlFor="find-player-query">
                Player Name, Poker Alias, Or Number
              </label>
              <input
                id="find-player-query"
                type="search"
                className={styles.input}
                placeholder="Name, Alias, Or Player Number"
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
                aria-autocomplete="list"
                aria-expanded={showSuggestions}
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
              <div className={styles.suggestList} role="listbox">
                {suggestions.map((player, index) => (
                  <button
                    key={player.id}
                    role="option"
                    aria-selected={index === highlightedIndex}
                    className={styles.suggestRow}
                    onPointerMove={() => setHighlightedIndex(index)}
                    onClick={() => chooseSuggestion(player)}
                  >
                    <span
                      className={`${styles.rowName} ${
                        index === highlightedIndex ? 'sc-ink--white' : 'sc-ink--silver'
                      }`}
                    >
                      {player.display_name || player.username}
                    </span>
                    {player.display_name && (
                      <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
                        @{player.username}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* The three filters: lit words, never a drawn select. */}
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

            <div className={styles.results} aria-live="polite" aria-busy={isSearching}>
              {error && <p className={`sc-copy sc-ink--red ${styles.copy}`}>{titleCase(error)}</p>}
              {!error && !isSearching && lastCompletedQueryRef.current && results.length === 0 && (
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
                          {player.display_name || player.username}
                        </span>
                        {player.display_name && (
                          <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
                            @{player.username}
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
                        <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
                          {player.relationship}
                        </span>
                      </button>

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
                            Authorized Account Data ({player.sensitive_accounts.length})
                          </button>
                          {expandedAccounts.has(player.id) &&
                            player.sensitive_accounts.map((account) => (
                              <div key={account.club_uuid} className={styles.account}>
                                <div className={styles.accountHead}>
                                  <span className={`${styles.rowName} sc-ink--silver`}>
                                    {account.club_name}
                                  </span>
                                  <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
                                    {account.access} / {account.role}
                                  </span>
                                </div>
                                <dl className={styles.facts}>
                                  <Fact
                                    label="Player"
                                    value={compactChips(account.wallets.player_wallet)}
                                  />
                                  <Fact
                                    label="Agent"
                                    value={compactChips(account.wallets.agent_wallet)}
                                  />
                                  <Fact
                                    label="Promo"
                                    value={compactChips(account.wallets.promo_wallet)}
                                  />
                                  <Fact
                                    label="Club Chips"
                                    value={compactChips(account.wallets.chip_balance)}
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

                      {player.tables.length > 0 && (
                        <div className={styles.tables}>
                          <span className={`sc-label sc-ink--blue ${styles.tablesHeading}`}>
                            Playing Now - {player.tables.length} Live Game
                            {player.tables.length === 1 ? '' : 's'}
                          </span>
                          {player.tables.map((table) => (
                            <button
                              key={table.id}
                              className={styles.tableRow}
                              onClick={() => void handleTableClick(table)}
                              disabled={verifyingTableId !== null}
                            >
                              <span
                                className={`sc-label ${styles.rowAside} ${
                                  gameKind(table) === 'tournament' ? 'sc-ink--gold' : 'sc-ink--blue'
                                }`}
                              >
                                {table.is_tournament ? 'Tournament' : 'Cash Game'}
                              </span>
                              <span className={`${styles.rowName} sc-ink--silver`}>
                                {table.name}
                              </span>
                              <span className={`sc-copy ${styles.tableDetails}`}>
                                {table.game_variant} / {table.stakes}
                                {table.club_name && ` / ${table.club_name}`}
                              </span>
                              {!table.can_watch && (
                                <span className={`sc-copy sc-ink--muted ${styles.tableDetails}`}>
                                  {gateCopy(table)}
                                </span>
                              )}
                              <span
                                className={`sc-label ${styles.tableAction} ${
                                  table.can_watch ? 'sc-ink--green' : 'sc-ink--gold'
                                }`}
                              >
                                {verifyingTableId === table.table_id
                                  ? 'Verifying Access'
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
                      className={`${styles.word} ${isLoadingMore ? 'sc-ink--muted' : 'sc-ink--blue'}`}
                      disabled={isLoadingMore}
                      onClick={() => runSearch(lastCompletedQueryRef.current, results.length, true)}
                    >
                      {isLoadingMore ? 'Loading' : 'Load More Players'}
                    </button>
                  )}
                </div>
              )}
              {!error && !isSearching && !lastCompletedQueryRef.current && (
                <p className={`sc-copy sc-copy--center sc-ink--muted ${styles.copy}`}>
                  Search By Alias, Display Name, Or Player Number. Close Matches Appear After{' '}
                  {FUZZY_MIN_CHARS} Letters - Spelling Does Not Have To Be Exact.
                </p>
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
  const { clubs, unions, hidden_count: hiddenCount } = player.affiliations || EMPTY_AFFILIATIONS;
  if (!clubs.length && !unions.length && !hiddenCount) return null;

  return (
    <section
      className={styles.affiliations}
      aria-label={`Clubs And Unions For ${player.display_name || player.username}`}
    >
      {clubs.length > 0 && (
        <div className={styles.affiliationGroup}>
          <span className="sc-label sc-ink--blue">Clubs</span>
          <ul className={styles.affiliationList}>
            {clubs.map((club) => {
              const joinable =
                club.viewer_action === 'join' || club.viewer_action === 'request_join';
              return (
                <li key={club.club_uuid} className={styles.affiliationItem}>
                  {joinable ? (
                    <button
                      type="button"
                      className={styles.affiliationRow}
                      onClick={() => onJoinClub(club)}
                    >
                      <span className={`${styles.rowName} sc-ink--silver`}>{club.club_name}</span>
                      <span className={`sc-label sc-ink--gold ${styles.rowAside}`}>
                        {clubActionLabel(club.viewer_action)}
                      </span>
                    </button>
                  ) : (
                    <span className={styles.affiliationRow}>
                      <span className={`${styles.rowName} sc-ink--silver`}>{club.club_name}</span>
                      <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
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
          <span className="sc-label sc-ink--blue">Unions</span>
          <ul className={styles.affiliationList}>
            {unions.map((union) => (
              <li key={union.union_id} className={styles.affiliationItem}>
                <span className={styles.affiliationRow}>
                  <span className={`${styles.rowName} sc-ink--silver`}>{union.union_name}</span>
                  {union.union_code && (
                    <span className={`sc-label sc-ink--muted ${styles.rowAside}`}>
                      #{union.union_code}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hiddenCount > 0 && (
        <p className={`sc-copy sc-ink--muted ${styles.copy}`}>
          {hiddenCount} Private Club{hiddenCount === 1 ? '' : 's'} Not Shown.
        </p>
      )}
    </section>
  );
}
