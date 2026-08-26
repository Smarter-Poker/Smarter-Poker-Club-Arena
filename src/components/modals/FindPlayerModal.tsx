/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FindPlayerModal — Role-Based Player Search with Permission Enforcement
 * ═══════════════════════════════════════════════════════════════════════════════
 * Search visibility is determined by user's role:
 *
 * NORMAL USERS: Can only search friends (from friendships table)
 * AGENTS / SUB-AGENTS / SUPER AGENTS: Can search all players in their downline + club
 * CLUB ADMIN / CLUB OWNER: Can search all players in their club(s)
 * UNION OWNER / UNION ADMIN: Can search all players in their union's clubs
 *
 * Features:
 * - Auto-suggest after typing 3+ characters (typeahead)
 * - Results sortable by Real Name and Poker Alias
 * - Multi-result display with table presence
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { isClubStaff } from '../../types/clubRoles';
import { useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../../lib/supabase';
import haptic from '../../services/HapticService';
import styles from './FindPlayerModal.module.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { sizedStorageUrl } from '../../utils/avatarGenerator';
import { sanitizeInput } from '../../utils/sanitizeInput';
import { reportError } from '../../utils/errorReporter';

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

interface SuggestedPlayer {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

type SortField = 'display_name' | 'username';

/** Capitalize the first letter of every word */
function toTitleCase(str: string): string {
  return str.replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Make user input safe for use inside a PostgREST .or(`...ilike.%q%...`) filter:
 * strip the or() delimiter characters (comma, parens, dot sequences that could
 * terminate the expression) and escape ilike wildcards so "100%" matches
 * literally instead of matching everything.
 */
function escapeSearchQuery(raw: string): string {
  return raw
    .replace(/[(),]/g, ' ') // PostgREST or() syntax delimiters
    .replace(/[\\%_]/g, (m) => `\\${m}`) // ilike wildcards / escape char
    .replace(/\s+/g, ' ')
    .trim();
}

/** Role scope for search permissions */
interface SearchScope {
  role: 'player' | 'agent' | 'admin' | 'owner' | 'union';
  clubIds: string[];
  friendIds: string[];
  searchableUserIds: string[];
}

/** Determine the user's highest privilege role across all clubs/unions and cache searchable IDs */
async function getUserSearchScope(userId: string): Promise<SearchScope> {
  const result: SearchScope = {
    role: 'player',
    clubIds: [],
    friendIds: [],
    searchableUserIds: [],
  };

  try {
    // ── 1. Get all club memberships to determine role ──
    const { data: memberships } = await supabase
      .from('club_members')
      .select('club_id, role')
      .eq('user_id', userId)
      .in('status', ['active', 'approved']);

    if (memberships && memberships.length > 0) {
      const clubIds = memberships.map((m: any) => m.club_id);
      result.clubIds = [...new Set(clubIds)];

      // Determine highest role
      for (const m of memberships) {
        const r = (m as any).role as string;
        if (r === 'owner' && result.role !== 'union') {
          result.role = 'owner';
        } else if (
          (r === 'admin' || r === 'co_owner') &&
          result.role !== 'owner' &&
          result.role !== 'union'
        ) {
          // co_owner is a first-class role in club_members_role_check and an
          // owner can grant it, but this ladder never tested for it, so a
          // co-owner fell through to 'player' and was silently demoted to
          // searching their friends list.
          result.role = 'admin';
        } else if (
          (r === 'agent' || r === 'super_agent' || r === 'sub_agent') &&
          result.role !== 'owner' &&
          result.role !== 'admin' &&
          result.role !== 'union'
        ) {
          result.role = 'agent';
        }
      }
    }

    // ── 2. Check if user is a union owner/admin ──
    try {
      const { data: ownedUnions } = await supabase
        .from('unions')
        .select('id')
        .eq('owner_id', userId);

      if (ownedUnions && ownedUnions.length > 0) {
        result.role = 'union';
        const unionIds = ownedUnions.map((u: any) => u.id);
        const { data: unionClubs } = await supabase
          .from('union_clubs')
          .select('club_id')
          .in('union_id', unionIds);

        if (unionClubs) {
          const additionalClubIds = unionClubs.map((uc: any) => uc.club_id);
          result.clubIds = [...new Set([...result.clubIds, ...additionalClubIds])];
        }
      }
    } catch {
      // unions table may not exist — non-blocking
    }

    // ── 3. Get friend IDs ──
    const [outbound, inbound] = await Promise.all([
      supabase
        .from('friendships')
        .select('friend_id')
        .eq('user_id', userId)
        .eq('status', 'accepted'),
      supabase
        .from('friendships')
        .select('user_id')
        .eq('friend_id', userId)
        .eq('status', 'accepted'),
    ]);

    const outIds = (outbound.data || []).map((f: any) => f.friend_id);
    const inIds = (inbound.data || []).map((f: any) => f.user_id);
    result.friendIds = [...new Set([...outIds, ...inIds])];

    // ── 4. Build searchable user ID pool based on role ──
    if (result.role === 'player') {
      result.searchableUserIds = [...new Set([...result.friendIds, userId])];
    } else {
      // Elevated role: get all club member IDs
      if (result.clubIds.length > 0) {
        const { data: clubMembers } = await supabase
          .from('club_members')
          .select('user_id')
          .in('club_id', result.clubIds)
          .in('status', ['active', 'approved']);

        if (clubMembers) {
          const memberIds = clubMembers.map((cm: any) => cm.user_id);
          result.searchableUserIds = [...new Set([...memberIds, ...result.friendIds, userId])];
        }
      }

      if (result.searchableUserIds.length === 0) {
        result.searchableUserIds = [...new Set([...result.friendIds, userId])];
      }
    }
  } catch (err) {
    reportError(err, 'FindPlayerModal.getUserSearchScope');
  }

  return result;
}

export default function FindPlayerModal({ isOpen, onClose }: FindPlayerModalProps) {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<PlayerResult[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleResults, setVisibleResults] = useState<Set<number>>(new Set());
  const [sortField, setSortField] = useState<SortField>('display_name');
  const [scopeLabel, setScopeLabel] = useState('');

  // Auto-suggest state
  const [suggestions, setSuggestions] = useState<SuggestedPlayer[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const suggestDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cached search scope — computed once when modal opens
  const searchScopeRef = useRef<SearchScope | null>(null);
  const scopeLoadingRef = useRef(false);

  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      if (suggestDebounceRef.current) clearTimeout(suggestDebounceRef.current);
    };
  }, []);

  // Pre-load search scope when modal opens
  useEffect(() => {
    if (!isOpen) {
      searchScopeRef.current = null;
      return;
    }

    let cancelled = false;
    async function loadScope() {
      if (scopeLoadingRef.current) return;
      scopeLoadingRef.current = true;
      try {
        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (!authUser?.id || cancelled) return;
        const scope = await getUserSearchScope(authUser.id);
        if (cancelled) return;
        searchScopeRef.current = scope;

        // Set scope label
        if (scope.role === 'union') {
          setScopeLabel('Searching union members');
        } else if (isClubStaff(scope.role)) {
          setScopeLabel('Searching club members');
        } else if (scope.role === 'agent') {
          setScopeLabel('Searching club members');
        } else {
          setScopeLabel('Searching friends');
        }
      } catch (err) {
        reportError(err, 'FindPlayerModal.loadScope');
      } finally {
        scopeLoadingRef.current = false;
      }
    }

    loadScope();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Stagger result entrance animations
  useEffect(() => {
    if (searchResults.length > 0) {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = searchResults.map((_, i) =>
        setTimeout(() => setVisibleResults((prev) => new Set(prev).add(i)), i * 60)
      );
    }
  }, [searchResults]);

  // Sort helper
  const sortResults = useCallback((results: PlayerResult[], field: SortField): PlayerResult[] => {
    return [...results].sort((a, b) => {
      const aVal =
        field === 'display_name'
          ? (a.display_name || a.username || '').toLowerCase()
          : (a.username || '').toLowerCase();
      const bVal =
        field === 'display_name'
          ? (b.display_name || b.username || '').toLowerCase()
          : (b.username || '').toLowerCase();
      return aVal.localeCompare(bVal);
    });
  }, []);

  const handleSortChange = useCallback(
    (field: SortField) => {
      setSortField(field);
      setSearchResults((prev) => sortResults(prev, field));
      setVisibleResults(new Set());
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    },
    [sortResults]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-SUGGEST — fires after 3+ characters with 350ms debounce
  // ═══════════════════════════════════════════════════════════════════════════
  const fetchSuggestions = useCallback(async (query: string) => {
    const scope = searchScopeRef.current;
    if (!scope || scope.searchableUserIds.length === 0) return;

    const safeQuery = escapeSearchQuery(sanitizeInput(query.trim()));
    if (!safeQuery || safeQuery.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    setIsSuggesting(true);
    try {
      // WALK THE WHOLE ROSTER, not the first 200 ids of it.
      //
      // This used to be `slice(0, 200)` in arbitrary database order while the
      // GO button walked every batch. For an owner with 1502 memberships that
      // is 13% coverage: typing a real member's name produced no dropdown, and
      // then pressing GO found them. It read as random breakage.
      //
      // Batched at 200 because that is a filter list a PostgREST URL comfortably
      // carries, and stopped as soon as six suggestions exist - for a matching
      // name that is almost always the first batch, so the common case costs
      // exactly what it did before.
      const BATCH = 200;
      const players: Array<{
        id: string;
        username: string | null;
        display_name: string | null;
        avatar_url: string | null;
      }> = [];

      for (let i = 0; i < scope.searchableUserIds.length && players.length < 6; i += BATCH) {
        const batch = scope.searchableUserIds.slice(i, i + BATCH);
        const { data: page, error: pageError } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url:arena_avatar_url')
          .in('id', batch)
          .or(`username.ilike.%${safeQuery}%,display_name.ilike.%${safeQuery}%`)
          .limit(6 - players.length);

        // Report it. A dropped error here is why a failing typeahead was
        // indistinguishable from a roster with nobody in it.
        if (pageError) {
          reportError(pageError, 'FindPlayerModal.fetchSuggestions');
          break;
        }
        if (page?.length) players.push(...page);
      }

      if (!isMountedRef.current) return;

      if (players && players.length > 0) {
        setSuggestions(
          players.map((p: any) => ({
            id: p.id,
            username: p.username || '',
            display_name: p.display_name || null,
            avatar_url: p.avatar_url || null,
          }))
        );
        setHighlightedIndex(-1);
        setShowSuggestions(true);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    } catch (err) {
      reportError(err, 'FindPlayerModal.fetchSuggestions');
    } finally {
      if (isMountedRef.current) setIsSuggesting(false);
    }
  }, []);

  const handleInputChange = useCallback(
    (value: string) => {
      setSearchQuery(value);

      // Clear previous debounce
      if (suggestDebounceRef.current) clearTimeout(suggestDebounceRef.current);

      if (value.trim().length >= 3) {
        suggestDebounceRef.current = setTimeout(() => {
          fetchSuggestions(value);
        }, 350);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    },
    [fetchSuggestions]
  );

  const handleSuggestionClick = (player: SuggestedPlayer) => {
    haptic.selection();
    setSearchQuery(player.display_name || player.username);
    setShowSuggestions(false);
    setSuggestions([]);
    // Trigger full search for this specific player
    performFullSearch(player.id);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // FULL SEARCH — fetches table presence for matched players
  // ═══════════════════════════════════════════════════════════════════════════
  const performFullSearch = async (specificPlayerId?: string) => {
    setIsSearching(true);
    setSearchResults([]);
    setNotFound(false);
    setError(null);
    setVisibleResults(new Set());
    setShowSuggestions(false);

    try {
      const scope = searchScopeRef.current;
      if (!scope) {
        // Scope not loaded yet — try loading
        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (!authUser?.id) {
          setError('You must be logged in to search.');
          return;
        }
        const freshScope = await getUserSearchScope(authUser.id);
        if (!isMountedRef.current) return;
        searchScopeRef.current = freshScope;
        // Continue with freshScope below
      }

      const activeScope = searchScopeRef.current!;

      if (activeScope.searchableUserIds.length === 0) {
        setNotFound(true);
        if (activeScope.role === 'player') {
          setError('Add friends to search for players. Only friends are visible in search.');
        }
        return;
      }

      let allPlayers: any[] = [];

      if (specificPlayerId) {
        // Direct lookup for a specific player
        const { data: player } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url:arena_avatar_url')
          .eq('id', specificPlayerId)
          .maybeSingle();

        if (!isMountedRef.current) return;
        if (player) allPlayers = [player];
      } else {
        // Search by query
        const safeQuery = escapeSearchQuery(sanitizeInput(searchQuery.trim()));
        if (!safeQuery) return;

        const BATCH_SIZE = 100;
        for (let i = 0; i < activeScope.searchableUserIds.length; i += BATCH_SIZE) {
          const batch = activeScope.searchableUserIds.slice(i, i + BATCH_SIZE);
          const { data: players, error: searchError } = await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url:arena_avatar_url')
            .in('id', batch)
            .or(`username.ilike.%${safeQuery}%,display_name.ilike.%${safeQuery}%`)
            .limit(20);

          if (!isMountedRef.current) return;
          if (searchError) throw searchError;
          if (players) allPlayers = [...allPlayers, ...players];
          if (allPlayers.length >= 20) {
            allPlayers = allPlayers.slice(0, 20);
            break;
          }
        }
      }

      if (allPlayers.length === 0) {
        setNotFound(true);
        return;
      }

      // ── Fetch table presence for matched players (parallel) ──
      const results: PlayerResult[] = await Promise.all(
        allPlayers.map(async (player: any) => {
          const tables: PlayerTable[] = [];

          // Cash Game Presence
          try {
            const { data: seatData } = await supabase
              .from('table_seats')
              .select(
                `
                id,
                table_id,
                tables:table_id (
                  id, name, game_variant, small_blind, big_blind, status, club_id,
                  clubs:club_id (name)
                )
              `
              )
              .eq('user_id', player.id)
              .is('left_at', null)
              .limit(4);

            if (seatData) {
              for (const seat of seatData) {
                const table = (seat as Record<string, unknown>).tables as {
                  id: string;
                  name: string;
                  game_variant: string;
                  small_blind: number;
                  big_blind: number;
                  status: string;
                  clubs: { name: string } | { name: string }[] | null;
                } | null;
                // 'active' is not a value tables.status holds (running / waiting
                // / closed). Compared case-insensitively so a future casing
                // change cannot silently empty this list the way it did for
                // tournaments above.
                const tableStatus = (table?.status || '').toLowerCase();
                if (table && (tableStatus === 'running' || tableStatus === 'waiting')) {
                  const clubName = Array.isArray(table.clubs)
                    ? table.clubs[0]?.name
                    : table.clubs?.name;
                  tables.push({
                    id: table.id,
                    name: toTitleCase(table.name || 'Cash Game'),
                    game_variant: toTitleCase(table.game_variant || 'NLH'),
                    stakes: `$${table.small_blind}/$${table.big_blind}`,
                    club_name: clubName ? toTitleCase(clubName) : undefined,
                    is_tournament: false,
                  });
                }
              }
            }
          } catch {
            /* non-critical */
          }

          // Tournament Presence
          if (tables.length < 4) {
            try {
              const { data: tournamentData } = await supabase
                .from('tournament_players')
                .select(
                  `
                  id, tournament_id,
                  tournaments:tournament_id (
                    id, name, status, buy_in_amount, club_id,
                    clubs:club_id (name)
                  )
                `
                )
                .eq('user_id', player.id)
                .in('status', ['registered', 'playing'])
                .limit(4 - tables.length);

              if (tournamentData) {
                for (const reg of tournamentData) {
                  const tournament = (reg as Record<string, unknown>).tournaments as {
                    id: string;
                    name: string;
                    status: string;
                    buy_in_amount: number;
                    clubs: { name: string } | { name: string }[] | null;
                  } | null;
                  // CASE-INSENSITIVE, and 'REGISTERING' not 'late_reg'.
                  // tournaments.status is stored UPPERCASE - COMPLETED,
                  // CANCELLED, RUNNING, REGISTERING - and 'late_reg' is not a
                  // value the column has ever held. Both comparisons were
                  // therefore always false, so the entire tournament half of
                  // this feature was dead: 356 live registrations were being
                  // fetched and then silently discarded, and a player sitting
                  // in an MTT showed as "Not Currently Playing".
                  const tourneyStatus = (tournament?.status || '').toUpperCase();
                  if (
                    tournament &&
                    (tourneyStatus === 'RUNNING' || tourneyStatus === 'REGISTERING')
                  ) {
                    const clubName = Array.isArray(tournament.clubs)
                      ? tournament.clubs[0]?.name
                      : tournament.clubs?.name;
                    tables.push({
                      id: tournament.id,
                      name: toTitleCase(tournament.name || 'Tournament'),
                      game_variant: 'MTT',
                      stakes: `$${tournament.buy_in_amount || 0} Buy-In`,
                      club_name: clubName ? toTitleCase(clubName) : undefined,
                      is_tournament: true,
                    });
                  }
                }
              }
            } catch {
              /* non-critical */
            }
          }

          return {
            id: player.id,
            username: toTitleCase(player.username || ''),
            display_name: player.display_name ? toTitleCase(player.display_name) : null,
            avatar_url: player.avatar_url,
            tables,
          };
        })
      );

      if (!isMountedRef.current) return;
      const sorted = sortResults(results, sortField);
      setSearchResults(sorted);
    } catch (err) {
      if (!isMountedRef.current) return;
      reportError(err, 'FindPlayerModal.Search_error');
      setError('Search failed. Please try again.');
    } finally {
      if (isMountedRef.current) setIsSearching(false);
    }
  };

  const handleSearch = () => {
    if (!searchQuery.trim()) return;
    haptic.medium();
    performFullSearch();
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

  const handleProfileClick = (playerId: string) => {
    haptic.success();
    onClose();
    navigate(`/profile/${playerId}`);
  };

  const handleClose = () => {
    haptic.light();
    setSearchQuery('');
    setSearchResults([]);
    setSuggestions([]);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
    setNotFound(false);
    setError(null);
    setScopeLabel('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={styles.modalContainer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalContent}>
          <h2 className={styles.title}>Find A Player</h2>

          {/* Search input with auto-suggest */}
          <div className={styles.searchSection}>
            <div className={styles.searchInputWrapper}>
              <input
                type="text"
                className={styles.searchInput}
                placeholder="Search By Name Or Alias..."
                value={searchQuery}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && showSuggestions && suggestions.length > 0) {
                    e.preventDefault();
                    setHighlightedIndex((prev) => (prev + 1) % suggestions.length);
                    return;
                  }
                  if (e.key === 'ArrowUp' && showSuggestions && suggestions.length > 0) {
                    e.preventDefault();
                    setHighlightedIndex(
                      (prev) => (prev - 1 + suggestions.length) % suggestions.length
                    );
                    return;
                  }
                  if (e.key === 'Enter') {
                    if (
                      showSuggestions &&
                      highlightedIndex >= 0 &&
                      highlightedIndex < suggestions.length
                    ) {
                      handleSuggestionClick(suggestions[highlightedIndex]);
                      return;
                    }
                    setShowSuggestions(false);
                    handleSearch();
                  }
                  if (e.key === 'Escape') {
                    setShowSuggestions(false);
                    setHighlightedIndex(-1);
                  }
                }}
                onFocus={() => {
                  if (suggestions.length > 0) setShowSuggestions(true);
                }}
                autoFocus
              />

              {/* Auto-suggest dropdown */}
              {showSuggestions && suggestions.length > 0 && (
                <div className={styles.suggestDropdown}>
                  {suggestions.map((s, i) => (
                    <button
                      key={s.id}
                      className={styles.suggestItem}
                      style={
                        i === highlightedIndex
                          ? { background: 'rgba(0, 212, 255, 0.15)' }
                          : undefined
                      }
                      onMouseEnter={() => setHighlightedIndex(i)}
                      onClick={() => handleSuggestionClick(s)}
                    >
                      <div className={styles.suggestAvatar}>
                        {s.avatar_url ? (
                          <img
                            loading="lazy"
                            decoding="async"
                            src={sizedStorageUrl(s.avatar_url, 44)}
                            alt=""
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = generateDefaultAvatar();
                            }}
                          />
                        ) : (
                          <span>?</span>
                        )}
                      </div>
                      <div className={styles.suggestInfo}>
                        <span className={styles.suggestName}>{s.display_name || s.username}</span>
                        {s.display_name && s.username && (
                          <span className={styles.suggestAlias}>@{s.username}</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Suggest loading indicator */}
              {isSuggesting && (
                <div className={styles.suggestLoading}>
                  <span className={styles.suggestSpinner}>⟳</span>
                </div>
              )}
            </div>

            <button
              className={styles.searchButton}
              onClick={handleSearch}
              disabled={isSearching || !searchQuery.trim()}
            >
              {isSearching ? '...' : 'GO'}
            </button>
          </div>

          {/* Sort controls — show when we have multiple results */}
          {searchResults.length > 1 && (
            <div className={styles.sortControls}>
              <span className={styles.sortLabel}>Sort By:</span>
              <button
                className={`${styles.sortBtn} ${sortField === 'display_name' ? styles.sortBtnActive : ''}`}
                onClick={() => handleSortChange('display_name')}
              >
                Real Name
              </button>
              <button
                className={`${styles.sortBtn} ${sortField === 'username' ? styles.sortBtnActive : ''}`}
                onClick={() => handleSortChange('username')}
              >
                Poker Alias
              </button>
            </div>
          )}

          {/* Scope label */}
          {scopeLabel && <div className={styles.scopeLabel}>{scopeLabel}</div>}

          {/* Results area */}
          <div className={styles.resultsArea}>
            {error && <div className={styles.errorMessage}>{error}</div>}

            {notFound && !error && (
              <div className={styles.notFoundMessage}>
                <span className={styles.notFoundIcon}></span>
                <p>No Matching Players Found In Your Network</p>
              </div>
            )}

            {searchResults.length > 0 && (
              <div className={styles.resultsList}>
                {searchResults.map((player, idx) => (
                  <div
                    key={player.id}
                    className={styles.playerResult}
                    style={{
                      opacity: visibleResults.has(idx) ? 1 : 0,
                      transform: visibleResults.has(idx) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <div
                      className={styles.playerHeader}
                      onClick={() => handleProfileClick(player.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <div className={styles.playerAvatar}>
                        {player.avatar_url ? (
                          <img
                            loading="lazy"
                            decoding="async"
                            src={sizedStorageUrl(player.avatar_url, 44)}
                            alt=""
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = generateDefaultAvatar();
                            }}
                          />
                        ) : (
                          <span>?</span>
                        )}
                      </div>
                      <div className={styles.playerInfo}>
                        <span className={styles.playerName}>
                          {player.display_name || player.username}
                        </span>
                        {player.display_name && player.username && (
                          <span className={styles.playerAlias}>@{player.username}</span>
                        )}
                        <span className={styles.playerStatus}>
                          {player.tables.length > 0
                            ? `Playing At ${player.tables.length} Table${player.tables.length > 1 ? 's' : ''}`
                            : 'Not Currently Playing'}
                        </span>
                      </div>
                    </div>

                    {player.tables.length > 0 && (
                      <div className={styles.tablesList}>
                        {player.tables.map((table) => (
                          <button
                            key={table.id}
                            className={styles.tableCard}
                            onClick={() => handleTableClick(table)}
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
                    )}
                  </div>
                ))}
              </div>
            )}

            {!error && !notFound && searchResults.length === 0 && !isSearching && (
              <div className={styles.hintMessage}>
                <p>Search For A Player To See Their Active Tables</p>
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
