/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND ARENA'S PLAYERS PAGE (2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond programme, line 3 ("Show real member/online/seated/
 * table counts with meaningful zero/error states") and the Players-page half
 * of line 6 ("no agent panels, union menus, chip metrics or synthetic players
 * as real activity").
 *
 * The arena's Players door used to open the chip roster, ClubMembersPage. Its
 * summary read looks the viewer up in club_members, where the arena has one
 * row with status `automatic`, so every Diamond player was told "This Roster
 * Is Available Only To Approved Club Members." Answered, it would still have
 * been the chip roster: My Downline, Agents, Admins, Fees 100+, Wallet Balance.
 *
 * This page is its Diamond variant. ClubPlayersDoor picks it from the
 * server-verified arena entitlement, so a chip club still gets ClubMembersPage
 * exactly as before. It borrows the chip roster's stylesheet for the same look
 * (Dan 2026-09-11: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA")
 * and carries none of its chip machinery:
 *
 *   - four figures from fn_diamond_arena_counts: Members, Online Now, At
 *     Tables and Tables. Each tile prints "..." while it loads, a real number
 *     (a real 0 included) once read, and "Unavailable" when the server could
 *     not tell or the read failed. An unknown is never shown as 0.
 *   - the arena's players from fn_diamond_arena_roster: name, username,
 *     avatar, player number and presence. No role, upline, downline, fee,
 *     wallet or chip figure, no agent or admin view, no export, and no field
 *     that says which players are horses. Certification fixtures and deleted
 *     accounts are not players and are not listed.
 *
 * A row opens nothing. The member page under /members/:userId is the chip
 * club's member management screen and has no Diamond meaning.
 *
 * Where the four figures live is Dan's decision 1 in
 * docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md. They are here, and the lobby rail
 * stays as he set it on 2026-09-11: "JUST 'ACTIVE' AND THE NUMBER UNDER IT.
 * AND THE FREE ROLL STARTS CLOCK."
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import PageSkeleton from '../components/common/PageSkeleton';
import { useDebounce } from '../hooks/useDebounce';
import {
  DIAMOND_ARENA_COUNTS_PENDING,
  DIAMOND_ARENA_COUNTS_UNKNOWN,
  diamondCountsStatus,
  diamondFigureText,
  type DiamondArenaCounts,
  type DiamondCountsPhase,
} from '../lib/diamondArenaCounts';
import DiamondArenaRosterService, {
  type DiamondRosterCursor,
  type DiamondRosterFilter,
  type DiamondRosterPlayer,
} from '../services/DiamondArenaRosterService';
import { generateAvatarSvg, sizedStorageUrl } from '../utils/avatarGenerator';
import { reportError } from '../utils/errorReporter';
import './ClubMembersPage.css';
import './DiamondPlayersPage.css';

const ROSTER_ART = `${import.meta.env.BASE_URL}images/club-members/roster-ledger-desk-v2.webp`;
const PAGE_SIZE = 80;

const FILTER_LABEL: Record<DiamondRosterFilter, string> = {
  all: 'All Players',
  seated: 'At Tables',
};

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

export default function DiamondPlayersPage() {
  const [counts, setCounts] = useState<DiamondArenaCounts>(DIAMOND_ARENA_COUNTS_PENDING);
  const [countsPhase, setCountsPhase] = useState<DiamondCountsPhase>('loading');
  const [players, setPlayers] = useState<DiamondRosterPlayer[]>([]);
  const [cursor, setCursor] = useState<DiamondRosterCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [filter, setFilter] = useState<DiamondRosterFilter>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const debouncedSearch = useDebounce(search, 260);
  const rosterEpoch = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setCounts(DIAMOND_ARENA_COUNTS_PENDING);
    setCountsPhase('loading');
    DiamondArenaRosterService.getCounts(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setCounts(next);
        setCountsPhase('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        reportError(error, 'DiamondPlayersPage.counts');
        setCounts(DIAMOND_ARENA_COUNTS_UNKNOWN);
        setCountsPhase('failed');
      });
    return () => controller.abort();
  }, [refreshes]);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++rosterEpoch.current;
    setLoading(true);
    setLoadError(false);
    setLoadingMore(false);
    setMoreError(false);
    DiamondArenaRosterService.getRosterPage({
      search: debouncedSearch,
      filter,
      limit: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((page) => {
        if (controller.signal.aborted || epoch !== rosterEpoch.current) return;
        setPlayers(page.items);
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
        setTotal(page.filtered_total);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error) || epoch !== rosterEpoch.current) return;
        reportError(error, 'DiamondPlayersPage.roster');
        setPlayers([]);
        setCursor(null);
        setHasMore(false);
        setTotal(null);
        setLoadError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [debouncedSearch, filter, refreshes]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const epoch = rosterEpoch.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await DiamondArenaRosterService.getRosterPage({
        search: debouncedSearch,
        filter,
        cursor,
        limit: PAGE_SIZE,
      });
      if (epoch !== rosterEpoch.current) return;
      setPlayers((current) => {
        const known = new Set(current.map((row) => row.user_id));
        return [...current, ...page.items.filter((row) => !known.has(row.user_id))];
      });
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
      setTotal(page.filtered_total);
    } catch (error) {
      if (epoch !== rosterEpoch.current) return;
      reportError(error, 'DiamondPlayersPage.loadMore');
      setMoreError(true);
    } finally {
      if (epoch === rosterEpoch.current) setLoadingMore(false);
    }
  }, [cursor, debouncedSearch, filter, loadingMore]);

  const refresh = useCallback(() => setRefreshes((value) => value + 1), []);
  const status = diamondCountsStatus(countsPhase, counts);
  const searching = debouncedSearch.trim().length > 0;

  return (
    <div className="club-members-page diamond-players" aria-busy={loading}>
      <section className="members-hero" aria-labelledby="diamond-players-title">
        <img
          className="members-hero__art"
          src={ROSTER_ART}
          alt=""
          aria-hidden="true"
          width="1774"
          height="887"
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
        <div className="members-hero__content">
          <div className="members-hero__copy">
            <span className="members-eyebrow">Diamond Arena</span>
            <h1 id="diamond-players-title">Players</h1>
            <p>Every Player On Smarter.Poker Is A Member Of The Diamond Arena.</p>
          </div>
          <div className="members-summary-shell">
            <dl
              className="members-summary"
              aria-label="Diamond Arena Totals"
              aria-busy={countsPhase === 'loading'}
            >
              <Figure label="Members" value={diamondFigureText(counts.members)} />
              <Figure
                label="Online Now"
                value={diamondFigureText(counts.online)}
                modifier="online"
              />
              <Figure
                label="At Tables"
                value={diamondFigureText(counts.seated)}
                modifier="seated"
              />
              <Figure label="Tables" value={diamondFigureText(counts.tables)} modifier="tables" />
            </dl>
            {status && (
              <span className="members-summary__status" role="status" aria-live="polite">
                {status}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="members-console" aria-labelledby="diamond-players-directory">
        <div className="members-console__heading">
          <div>
            <span className="members-eyebrow">Diamond Arena</span>
            <h2 id="diamond-players-directory">Find A Player</h2>
          </div>
          <span className="members-result-count" aria-live="polite">
            {loading ? 'Loading...' : total === null ? '' : `${total.toLocaleString()} Results`}
          </span>
        </div>

        <label className="members-search">
          <span>Search The Players</span>
          <input
            type="search"
            placeholder="Search Name, Username Or Number"
            aria-label="Search Diamond Arena Players"
            value={search}
            maxLength={120}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="members-filter-rail" role="group" aria-label="Player Views">
          <div className="members-filters">
            {(Object.keys(FILTER_LABEL) as DiamondRosterFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                className={filter === value ? 'active' : ''}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {FILTER_LABEL[value]}
              </button>
            ))}
          </div>
        </div>

        <div className="members-toolbar">
          <button
            type="button"
            className="members-refresh"
            onClick={refresh}
            disabled={loading && countsPhase === 'loading'}
          >
            Refresh
          </button>
        </div>
      </section>

      <div
        className="members-list"
        role="list"
        aria-label="Diamond Arena Players"
        aria-busy={loading || loadingMore}
      >
        {loading && players.length === 0 ? (
          <PageSkeleton variant="list" />
        ) : loadError ? (
          <div className="members-error" role="alert">
            Could Not Load The Players.
            <button type="button" className="members-export" onClick={refresh}>
              Try Again
            </button>
          </div>
        ) : players.length === 0 ? (
          <EmptyPlayers filter={filter} searching={searching} />
        ) : (
          players.map((player) => <PlayerRow key={player.user_id} player={player} />)
        )}
      </div>

      {!loadError && players.length > 0 && (
        <div className="members-count diamond-players__more" role="status" aria-live="polite">
          <span>
            {`Showing ${players.length.toLocaleString()} Of ${(total ?? players.length).toLocaleString()}`}
          </span>
          {moreError && <span>Could Not Load More Players.</span>}
          {hasMore && (
            <button
              type="button"
              className="members-refresh"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading...' : moreError ? 'Try Again' : 'Show More Players'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, modifier }: { label: string; value: string; modifier?: string }) {
  return (
    <div className={`summary-stat${modifier ? ` summary-stat--${modifier}` : ''}`}>
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value">{value}</dd>
    </div>
  );
}

function PlayerRow({ player }: { player: DiamondRosterPlayer }) {
  const initial = (player.alias || '?')[0]?.toUpperCase() ?? '?';
  const presence = player.is_seated ? 'At A Table' : player.is_online ? 'Online' : null;
  return (
    <div
      className={`member-row${player.is_seated ? ' member-row--seated' : player.is_online ? ' member-row--online' : ''}`}
      role="listitem"
      aria-label={presence ? `${player.alias}, ${presence}` : player.alias}
    >
      <div className="member-row__open diamond-player-row__body">
        <span className="member-avatar">
          {player.avatar_url ? (
            <img
              src={sizedStorageUrl(player.avatar_url, 64)}
              alt=""
              loading="lazy"
              onError={(event) => {
                const image = event.currentTarget;
                image.onerror = null;
                image.src = generateAvatarSvg(player.user_id, player.alias || '?');
              }}
            />
          ) : (
            <span>{initial}</span>
          )}
        </span>
        <span className="member-main">
          <span className="member-identity">
            <span className="member-alias">{player.alias}</span>
            {player.username && player.username.toLowerCase() !== player.alias.toLowerCase() && (
              <span className="member-username">{player.username}</span>
            )}
          </span>
          <span className="member-subline">
            {player.player_number && (
              <span className="member-number">No. {player.player_number}</span>
            )}
            {player.is_seated ? (
              <span className="member-seated">At Table</span>
            ) : player.is_online ? (
              <span className="member-online">Online</span>
            ) : null}
          </span>
        </span>
      </div>
    </div>
  );
}

function EmptyPlayers({ filter, searching }: { filter: DiamondRosterFilter; searching: boolean }) {
  const [heading, body] = searching
    ? ['No Results Found', 'No Diamond Arena Player Matches That Search.']
    : filter === 'seated'
      ? ['No Players At Tables', 'No One Is Seated At A Diamond Table Right Now.']
      : ['No Players Found', 'The Diamond Arena Has No Players To List.'];
  return (
    <div className="members-empty">
      <span className="members-empty__mark" aria-hidden="true">
        &bull;
      </span>
      <p className="members-empty__heading">{heading}</p>
      <p className="members-empty__body">{body}</p>
    </div>
  );
}
