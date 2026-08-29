/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIONS — the tab that was one sentence
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim:
 *
 *   "UNIONS SHOULD HAVE ANY AND ALL CLUBS THAT ARE PARTICIPATING IN THE EVENT
 *    HERE. IT SHOULD SHOW THE NAME, CLUB LEVEL, CLUB LOGO, AND WHICH PLAYERS
 *    FROM WHICH CLUB ARE PARTICIPATING."
 *
 * What was here before: for a union event, three label/value rows and a count
 * of `new Set(entries.map(e => e.club_id))` — a field the lobby's own entry
 * type does not carry, so the count was very often "All union clubs eligible",
 * which is not an answer. For every other event, the whole tab was the single
 * line "This Is A Club Tournament, Not A Union (XMTT) Event."
 *
 * Roughly 95% of events are club events, so 95% of the time this tab existed
 * only to refuse. A tab that is blank for almost every tournament is the bug,
 * not the design, so this one shows the host club properly in that case: the
 * same card, the same roster, with a quiet note about which kind of event it
 * is. The tab is useful either way.
 *
 * ── HOW A PLAYER IS MAPPED TO A CLUB (the whole problem) ─────────────────────
 *
 * `tournament_players.club_id` exists in production and is the club a player
 * ENTERED FROM, which is exactly the question this tab asks. It is not, however,
 * reliable on its own: 68,846 of 114,679 rows carry it, so about 40% of history
 * predates it being written. Rendering only the resolved 60% would quietly drop
 * two players in five from a roster whose entire job is to say who is playing —
 * a roster that silently omits players is worse than one that admits a gap.
 *
 * So this resolves in two passes and never guesses:
 *
 *   1. `tournament_players.club_id` — authoritative, the club they entered from.
 *   2. `club_members` for whoever pass 1 could not answer, preferring a club
 *      inside THIS event's union (a player can hold membership in several), and
 *      falling back to their earliest-joined club. This is an inference about
 *      where they entered from, not a record of it, so it is marked as one on
 *      the card rather than being passed off as fact.
 *   3. Anyone still unresolved is grouped under "Unaffiliated" and counted.
 *      They are never dropped.
 *
 * ── QUERY BUDGET ────────────────────────────────────────────────────────────
 *
 * Four round trips, none of them per-club or per-player: the entrants' club
 * ids, the fallback memberships, the clubs themselves, the union's name. The
 * membership lookup chunks its `.in()` list because a thousand-entrant field
 * would otherwise build a querystring long enough to be refused by the edge —
 * chunking is still batched, it is just batched in more than one parcel.
 *
 * Player names, avatars and statuses come from `entries` and are never
 * refetched: the page keeps those fresh over realtime, and a tab that
 * re-selects them can print a different answer than the tab beside it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useIsMounted } from '../../../hooks/useIsMounted';
import { reportError, reportWarning } from '../../../utils/errorReporter';
import { getClubLevel, getTierForLevel, MAX_CLUB_LEVEL } from '../../../utils/clubLevels';
import type { ClubTier } from '../../../utils/clubLevels';
import { chips, initials, ordinal, type TournamentTabProps } from './types';
import type { TournamentEntry } from './types';
import '../../../styles/tournament-lobby-3d.css';
import './UnionsTab.css';

/**
 * How many ids go into one `.in()`. Supabase encodes these into the URL, and a
 * field of a thousand players would otherwise produce a querystring past the
 * proxy's limit — which fails as a 414 with no useful message attached.
 */
const ID_CHUNK = 150;

/** The one club a card is built from. */
interface ClubRow {
  id: string;
  name: string;
  logo_url: string | null;
  level: number | null;
  union_id: string | null;
}

/** How a player's club was arrived at, because the two are not equally certain. */
type ClubSource = 'entered' | 'member';

/** One club and the players from it, as the tab renders them. */
interface ClubGroup {
  club: ClubRow | null;
  /** Null club id is the Unaffiliated bucket. */
  key: string;
  players: TournamentEntry[];
  /** True when every player here was inferred from membership, not entry. */
  inferredOnly: boolean;
}

interface LoadedData {
  clubsById: Map<string, ClubRow>;
  /** user_id -> club_id, for whoever could be resolved at all. */
  clubByUser: Map<string, string>;
  /** user_id -> how we got there. */
  sourceByUser: Map<string, ClubSource>;
  unionName: string | null;
}

type LoadState = 'loading' | 'ready' | 'error';

/**
 * WHAT THIS LOAD HAS TO FETCH, decided in one pure function.
 *
 * Extracted so it can be TESTED. The first attempt at guarding this behaviour
 * asserted source strings — `const userIds = isTopUp ? ...` and friends — and
 * passed happily when the logic was disabled underneath them, because the
 * strings were all still there. A test that passes either way pins nothing.
 * This takes real inputs and returns a real decision, so a test can break it.
 *
 *   cold   nothing resolved yet: read the whole field
 *   topup  some entrants are new: read only those
 *   noop   every entrant is already resolved: read nothing at all
 *
 * `noop` is the common case. A re-render, a chip tick, or a player LEAVING all
 * land here — `groups` buckets from `entries`, so a departure needs no query.
 */
export type UnionLoadPlan =
  | { mode: 'cold'; userIds: string[] }
  | { mode: 'topup'; userIds: string[] }
  | { mode: 'noop'; userIds: [] };

export function planUnionLoad(
  prior: Pick<LoadedData, 'clubByUser'> | null,
  allEntrantIds: string[]
): UnionLoadPlan {
  if (!prior) return { mode: 'cold', userIds: allEntrantIds };
  const missing = allEntrantIds.filter((id) => !prior.clubByUser.has(id));
  if (missing.length === 0) return { mode: 'noop', userIds: [] };
  return { mode: 'topup', userIds: missing };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CLUB LEVEL — validated before it is ever drawn
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The house rule is that a level badge is validated against a known list and
 * renders NOTHING rather than a raw or impossible value. The published ladder
 * is 1..55 (`MAX_CLUB_LEVEL`), so anything outside it — null, zero, a float, a
 * migration artefact like 9999 — returns null and the card simply has no badge.
 *
 * Note this deliberately does NOT lean on `getClubLevel`'s own clamp, which
 * would turn level 0 into "Level 1 Starter" and level 9999 into the top tier.
 * Clamping invents a level; the badge should be absent instead.
 */
function clubLevelBadge(level: number | null | undefined): { level: number; label: string } | null {
  if (level === null || level === undefined) return null;
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CLUB_LEVEL) return null;
  const info = getClubLevel({ level: n });
  // `tierLabel` is already display-formatted ("Large Club", "Regional
  // Operator") — the enum itself ("large", "regional") is never shown.
  if (!info?.tierLabel) return null;
  return { level: n, label: info.tierLabel };
}

/**
 * Tier -> one of five depth steps on the accent/action ramp.
 *
 * The obvious instinct for a "club level" badge is gold, and the shared
 * `TIER_COLORS` map does go gold at enterprise and elite. The house palette
 * forbids it, so tier is carried by DEPTH here — a deeper surface, a stronger
 * bevel, a wider glow — rather than by hue drifting off-palette.
 */
function tierStep(level: number): 1 | 2 | 3 | 4 | 5 {
  const tier: ClubTier = getTierForLevel(level);
  switch (tier) {
    case 'starter':
    case 'small':
      return 1;
    case 'growing':
    case 'established':
      return 2;
    case 'large':
    case 'regional':
      return 3;
    case 'major':
    case 'network':
      return 4;
    default:
      return 5;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SMALL PIECES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A club logo that degrades twice: no url at all, and a url that 404s. The
 * second case is the common one in practice (a club renamed its upload), and
 * without the `onError` it renders as a broken-image glyph inside a circle.
 */
function ClubLogo({ club }: { club: ClubRow | null }) {
  const [broken, setBroken] = useState(false);
  const url = club?.logo_url;

  if (!url || broken) {
    return (
      <span className="tl-avatar un-logo" aria-hidden="true">
        {club ? initials(club.name) : '?'}
      </span>
    );
  }
  return (
    <img
      className="tl-avatar un-logo"
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}

function PlayerAvatar({ entry }: { entry: TournamentEntry }) {
  const [broken, setBroken] = useState(false);

  if (!entry.avatar_url || broken) {
    return (
      <span className="tl-avatar un-face" aria-hidden="true">
        {initials(entry.username)}
      </span>
    );
  }
  return (
    <img
      className="tl-avatar un-face"
      src={entry.avatar_url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}

/** Playing, out, or waiting — the same words the rest of the lobby uses. */
function statusOf(entry: TournamentEntry): { text: string; badge: string } {
  switch (entry.status) {
    case 'winner':
      return { text: 'Winner', badge: 'tl-badge--action' };
    case 'eliminated':
    case 'finished':
      return {
        text: entry.position ? `Finished ${ordinal(entry.position)}` : 'Eliminated',
        badge: 'tl-badge--mute',
      };
    case 'playing':
      return {
        text: entry.chips ? `${chips(entry.chips)} Chips` : 'Playing',
        badge: 'tl-badge--good',
      };
    default:
      return { text: 'Registered', badge: '' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ONE CLUB CARD
// ═══════════════════════════════════════════════════════════════════════════════

interface ClubCardProps {
  group: ClubGroup;
  isHost: boolean;
  currentUserId?: string;
  open: boolean;
  onToggle: (key: string) => void;
}

const ClubCard = React.memo(function ClubCard({
  group,
  isHost,
  currentUserId,
  open,
  onToggle,
}: ClubCardProps) {
  const { club, players, key } = group;
  const badge = clubLevelBadge(club?.level);
  const count = players.length;
  const unaffiliated = club === null;
  const panelId = `un-roster-${key}`;

  return (
    <li className={`un-card${unaffiliated ? ' un-card--muted' : ''}`}>
      <button
        type="button"
        className="un-card__head"
        onClick={() => onToggle(key)}
        /* Both attributes are dropped for a club with nobody in it: there is
           nothing to expand, so claiming a collapsed panel and pointing
           `aria-controls` at an element that is never rendered is a lie a
           screen reader repeats out loud. */
        aria-expanded={count > 0 ? open : undefined}
        aria-controls={count > 0 && open ? panelId : undefined}
        disabled={count === 0}
      >
        <ClubLogo club={club} />

        <span className="un-card__id">
          <span className="un-card__nameline">
            <span className="tl-name un-club-name">{club ? club.name : 'Unaffiliated'}</span>
            {isHost && <span className="tl-badge tl-badge--action">Host</span>}
          </span>

          <span className="un-card__meta">
            {badge ? (
              <span className={`tl-badge un-lvl un-lvl--${tierStep(badge.level)}`}>
                Level {chips(badge.level)} - {badge.label}
              </span>
            ) : (
              unaffiliated && (
                <span className="tl-sub">Club Could Not Be Determined For These Players</span>
              )
            )}
            {group.inferredOnly && !unaffiliated && (
              <span className="tl-sub un-inferred">By Membership</span>
            )}
          </span>
        </span>

        <span className="un-card__count">
          <span className="tl-num un-count">{chips(count)}</span>
          <span className="tl-sub">{count === 1 ? 'Player' : 'Players'}</span>
        </span>

        {count > 0 && (
          <span className={`un-chev${open ? ' un-chev--open' : ''}`} aria-hidden="true" />
        )}
      </button>

      {open && count > 0 && (
        <ul className="tl-list un-roster" id={panelId}>
          {players.map((player) => {
            const state = statusOf(player);
            const isHero = !!currentUserId && player.user_id === currentUserId;
            return (
              <li key={player.id || player.user_id} className="un-roster__item">
                <div className={`tl-row un-player${isHero ? ' tl-row--hero' : ''}`}>
                  <PlayerAvatar entry={player} />
                  <span className="un-player__id">
                    <span className="tl-name">{player.username}</span>
                    <span className="tl-sub">{state.text}</span>
                  </span>
                  {isHero && <span className="tl-badge tl-badge--action">You</span>}
                  <span className={`tl-badge ${state.badge}`}>
                    {player.status === 'playing'
                      ? 'In'
                      : player.status === 'winner'
                        ? 'Won'
                        : 'Out'}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  THE TAB
// ═══════════════════════════════════════════════════════════════════════════════

export default function UnionsTab({ tournament, entries, currentUserId }: TournamentTabProps) {
  const isMounted = useIsMounted();

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<LoadedData | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());

  // `is_xmtt` / `union_id` are on the row in production but not yet on the
  // generated Tournament type, so they are read through one narrow cast rather
  // than sprinkling `as any` down the file.
  const meta = tournament as unknown as {
    id?: string;
    club_id?: string | null;
    union_id?: string | null;
    is_xmtt?: boolean | null;
  };
  const tournamentId = meta?.id;
  const unionId = meta?.union_id || null;
  const hostClubId = meta?.club_id || null;
  const isUnionEvent = !!meta?.is_xmtt && !!unionId;

  // Entrant identity comes from props and only changes when the field does.
  const entryUserIds = useMemo(
    () => Array.from(new Set(entries.map((e) => e.user_id).filter(Boolean))),
    [entries]
  );
  // A stable primitive so the effect below does not re-run on every chip tick.
  const entrantKey = useMemo(() => entryUserIds.slice().sort().join(','), [entryUserIds]);

  /**
   * WHAT WE HAVE ALREADY RESOLVED, so a new entrant costs one small query
   * instead of the whole sweep (2026-08-29).
   *
   * `entrantKey` is deliberately stable against a chip tick, which was the bug
   * it was written to fix. But it changes on every REGISTRATION, and the effect
   * below re-ran the entire load on it: one paged `tournament_players` read,
   * one chunked `club_members` read, one chunked `clubs` read and the union
   * name. On a 500-runner event with late reg open, that is a full 4-to-16
   * query sweep for each new player who joins — during exactly the window when
   * players are joining fastest.
   *
   * A club assignment does not change once resolved: it comes from the
   * `tournament_players` row a player entered on, or from their membership.
   * So the resolved map is cumulative, and an entrant-set change only has to
   * ask about the ids that are NOT in it. A player LEAVING needs no query at
   * all — `groups` below buckets from `entries`, so they simply stop being
   * rendered.
   *
   * Held in a ref rather than state because writing it must not itself trigger
   * the effect that fills it.
   */
  const resolvedRef = useRef<LoadedData | null>(null);
  /**
   * What the cache is FOR. A different tournament, or an explicit retry, must
   * start over rather than top up the very data it is retrying because of.
   *
   * Checked inside the load effect rather than reset by a second effect,
   * because two effects sharing dependencies run in declaration order and the
   * loader would read a stale cache before the resetter cleared it. One
   * effect, no ordering to get wrong.
   */
  const resolvedForRef = useRef<string>('');

  const retry = useCallback(() => {
    setState('loading');
    setAttempt((n) => n + 1);
  }, []);

  const toggle = useCallback((key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── load ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!tournamentId) {
      setState('ready');
      setData(null);
      return;
    }

    let cancelled = false;
    const allEntrantIds = entrantKey ? entrantKey.split(',') : [];

    /**
     * A FULL SWEEP, OR A TOP-UP.
     *
     * `prior` is what previous runs resolved for THIS tournament. When it
     * exists, the only ids worth asking about are the ones missing from it, and
     * when none are missing there is nothing to ask at all — the effect
     * re-publishes what it already holds and issues ZERO queries.
     *
     * A retry (`attempt`) or a change of tournament clears it, so "Try Again"
     * really does start over rather than replaying a bad partial result.
     */
    const identity = `${tournamentId}|${unionId ?? ''}|${hostClubId ?? ''}|${attempt}`;
    if (resolvedForRef.current !== identity) {
      resolvedRef.current = null;
      resolvedForRef.current = identity;
    }

    const prior = resolvedRef.current;
    const plan = planUnionLoad(prior, allEntrantIds);
    const isTopUp = plan.mode === 'topup';

    if (plan.mode === 'noop') {
      /* Nothing new to resolve. `groups` below re-buckets from `entries`, so a
         departure or a chip change is already handled without a round trip. */
      setState('ready');
      return;
    }

    const userIds = plan.userIds;

    /** Batched `.in()` that survives a large field. Never one call per row. */
    async function inChunks<T>(
      ids: string[],
      run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>
    ): Promise<T[]> {
      const out: T[] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data: rows, error } = await run(ids.slice(i, i + ID_CHUNK));
        if (error) throw error;
        if (rows) out.push(...rows);
      }
      return out;
    }

    /**
     * Page through a whole result set.
     *
     * "No `.limit()`" is not "no limit": PostgREST caps a request without a
     * range at 1,000 rows and reports nothing about having done so. The query
     * below reads one row per entrant, and this file's own header is about
     * fields of a thousand-plus on a 114,679-row table. Past 1,000 entrants the
     * tail was silently dropped, those players fell through to the membership
     * inference path, and their cards were labelled "By Membership" even though
     * the authoritative club id existed and had simply not been fetched.
     */
    async function fetchAllPages<T>(
      run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
    ): Promise<T[]> {
      const PAGE = 1000;
      const MAX_PAGES = 60; // 60k entrants is far past any real field.
      const out: T[] = [];
      for (let i = 0; i < MAX_PAGES; i++) {
        const { data: rows, error } = await run(i * PAGE, (i + 1) * PAGE - 1);
        if (error) throw error;
        const got = rows || [];
        out.push(...got);
        if (got.length < PAGE) break;
      }
      return out;
    }

    (async () => {
      try {
        /* 1. The club each player ENTERED FROM.
              A cold load pages the whole field. A top-up asks only about the
              newcomers, which is a chunked `.in()` rather than a walk through
              every row of a 500-runner event. */
        const tpRows = isTopUp
          ? await inChunks<{ user_id: string; club_id: string | null }>(userIds, (chunk) =>
              supabase
                .from('tournament_players')
                .select('user_id, club_id')
                .eq('tournament_id', tournamentId)
                .in('user_id', chunk)
            )
          : await fetchAllPages<{ user_id: string; club_id: string | null }>((from, to) =>
              supabase
                .from('tournament_players')
                .select('user_id, club_id')
                .eq('tournament_id', tournamentId)
                .range(from, to)
            );

        /* Seeded from what previous runs resolved, so a top-up ADDS to the
           picture rather than replacing it with only the newcomers. */
        const clubByUser = new Map<string, string>(prior?.clubByUser ?? []);
        const sourceByUser = new Map<string, ClubSource>(prior?.sourceByUser ?? []);
        /* Only players who are actually in `entries`. A re-entry event keeps a
           `tournament_players` row per bust, so seeding from every row made
           step 3 fetch clubs for players this tab will never render — and on a
           big re-entry field that is a measurable slice of a query that is
           already chunked. */
        const entrantSet = new Set(userIds);
        for (const row of tpRows as { user_id: string; club_id: string | null }[]) {
          if (row.user_id && row.club_id && entrantSet.has(row.user_id)) {
            clubByUser.set(row.user_id, row.club_id);
            sourceByUser.set(row.user_id, 'entered');
          }
        }

        // 2. Fall back to membership for the rest — the ~40% of rows written
        //    before `club_id` was recorded on entry.
        const unresolved = userIds.filter((id) => !clubByUser.has(id));
        const memberships =
          unresolved.length > 0
            ? await inChunks<{ user_id: string; club_id: string; joined_at: string | null }>(
                unresolved,
                (chunk) =>
                  supabase
                    .from('club_members')
                    .select('user_id, club_id, joined_at')
                    .in('user_id', chunk)
              )
            : [];

        /* 3. Every club referenced by either pass — MINUS the ones already
              loaded. A newcomer from a club that is already on screen adds no
              club query at all; usually the top-up costs one small
              `tournament_players` read and nothing else. */
        const clubsById = new Map<string, ClubRow>(prior?.clubsById ?? []);
        const candidateClubIds = new Set<string>(clubByUser.values());
        for (const m of memberships) if (m.club_id) candidateClubIds.add(m.club_id);
        if (hostClubId) candidateClubIds.add(hostClubId);
        const unknownClubIds = Array.from(candidateClubIds).filter((id) => !clubsById.has(id));

        if (unknownClubIds.length > 0) {
          const clubRows = await inChunks<ClubRow>(unknownClubIds, (chunk) =>
            supabase.from('clubs').select('id, name, logo_url, level, union_id').in('id', chunk)
          );
          for (const c of clubRows) if (c?.id) clubsById.set(c.id, c);
        }

        // A player can be a member of several clubs. Prefer one inside THIS
        // event's union, then the one they joined first — deterministic, so the
        // card does not reshuffle between loads.
        const byUser = new Map<string, { club_id: string; joined_at: string | null }[]>();
        for (const m of memberships) {
          if (!m.user_id || !m.club_id) continue;
          const list = byUser.get(m.user_id) || [];
          list.push({ club_id: m.club_id, joined_at: m.joined_at });
          byUser.set(m.user_id, list);
        }
        for (const [userId, list] of byUser) {
          const ranked = list.slice().sort((a, b) => {
            const aIn = unionId && clubsById.get(a.club_id)?.union_id === unionId ? 0 : 1;
            const bIn = unionId && clubsById.get(b.club_id)?.union_id === unionId ? 0 : 1;
            if (aIn !== bIn) return aIn - bIn;
            const aHost = a.club_id === hostClubId ? 0 : 1;
            const bHost = b.club_id === hostClubId ? 0 : 1;
            if (aHost !== bHost) return aHost - bHost;
            return (a.joined_at || '').localeCompare(b.joined_at || '');
          });
          const pick = ranked[0];
          if (pick) {
            clubByUser.set(userId, pick.club_id);
            sourceByUser.set(userId, 'member');
          }
        }

        /* 4. The union's name, for the header. Fetched once — a union does not
              rename itself because somebody registered. */
        let unionName: string | null = prior?.unionName ?? null;
        if (unionId && unionName === null) {
          const { data: unionRow, error: unionErr } = await supabase
            .from('unions')
            .select('name')
            .eq('id', unionId)
            .maybeSingle();
          // A missing union name costs the header a word. It is not worth
          // failing the whole tab, which can still show every club. But it is
          // worth SAYING: every other error path here calls reportError, and
          // this one silently degraded the header to "Union Tournament" with no
          // telemetry, so a permission problem on `unions` could sit
          // indefinitely with nobody able to see it had happened.
          if (unionErr) reportError(unionErr, 'UnionsTab.union_name');
          else unionName = (unionRow as { name?: string } | null)?.name || null;
        }

        if (cancelled || !isMounted.current) return;
        const next = { clubsById, clubByUser, sourceByUser, unionName };
        /* Cache BEFORE publishing, so the next entrant-set change tops this up
           instead of starting again. */
        resolvedRef.current = next;
        setData(next);
        setState('ready');
      } catch (err) {
        reportError(err, 'UnionsTab.load_participating_clubs');
        if (cancelled || !isMounted.current) return;
        /* A failed TOP-UP must not throw away a roster that is already on
           screen and still correct for everyone but the newcomers. Only a cold
           load has nothing to fall back to. */
        if (isTopUp) {
          reportWarning(
            'Union roster top-up failed; keeping the roster already loaded',
            'UnionsTab.top_up_failed',
            { tournamentId }
          );
          setState('ready');
        } else {
          setState('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tournamentId, entrantKey, unionId, hostClubId, attempt, isMounted]);

  // ── group ───────────────────────────────────────────────────────────────────
  const groups = useMemo<ClubGroup[]>(() => {
    if (!data) return [];

    const buckets = new Map<string, TournamentEntry[]>();
    for (const entry of entries) {
      /* A club id whose row we could not LOAD is not a club we can name, and a
         card with no name renders as "Unaffiliated". Two of those side by side,
         each with its own count, is not a roster - it is a puzzle. So an
         unloadable club id collapses into the one Unaffiliated bucket here,
         where it belongs, rather than surviving as a distinct key and drawing a
         second nameless card (2026-08-26 audit). */
      const resolved = data.clubByUser.get(entry.user_id) || '';
      const clubId = resolved && data.clubsById.has(resolved) ? resolved : '';
      const list = buckets.get(clubId) || [];
      list.push(entry);
      buckets.set(clubId, list);
    }

    // The host club of a club event is shown even with nobody resolved to it:
    // Dan asked for the host club presented properly, and "the club running
    // this" is true whether or not entry rows happen to name it.
    if (!isUnionEvent && hostClubId && !buckets.has(hostClubId)) buckets.set(hostClubId, []);

    const built: ClubGroup[] = [];
    for (const [clubId, players] of buckets) {
      players.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
      const club = clubId ? data.clubsById.get(clubId) || null : null;
      built.push({
        key: clubId || 'unaffiliated',
        club,
        players,
        inferredOnly:
          players.length > 0 && players.every((p) => data.sourceByUser.get(p.user_id) === 'member'),
      });
    }

    built.sort((a, b) => {
      // Unaffiliated is always last: it is a gap, not a participant.
      const aOrphan = a.club === null ? 1 : 0;
      const bOrphan = b.club === null ? 1 : 0;
      if (aOrphan !== bOrphan) return aOrphan - bOrphan;
      if (b.players.length !== a.players.length) return b.players.length - a.players.length;
      return (a.club?.name || '').localeCompare(b.club?.name || '');
    });

    return built;
  }, [data, entries, isUnionEvent, hostClubId]);

  const clubCount = useMemo(() => groups.filter((g) => g.club !== null).length, [groups]);
  const unaffiliatedCount = useMemo(
    () => groups.find((g) => g.club === null)?.players.length || 0,
    [groups]
  );

  // ── loading ─────────────────────────────────────────────────────────────────
  if (state === 'loading') {
    return (
      <div className="tl-panel un-panel">
        <div className="un-skeletons" aria-busy="true" aria-live="polite">
          <span className="un-sr">Loading Participating Clubs</span>
          {[0, 1, 2].map((i) => (
            <div className="tl-skeleton un-skeleton" key={i} />
          ))}
        </div>
      </div>
    );
  }

  // ── failure: a short retry, never a blank panel and never a forever spinner ─
  if (state === 'error') {
    return (
      <div className="tl-panel un-panel">
        <div className="tl-empty un-error">
          <span>Could Not Load The Participating Clubs</span>
          <span className="tl-empty__hint">Your Connection Or The Club Service Did Not Answer</span>
          <button type="button" className="un-retry" onClick={retry}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tl-panel un-panel">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="un-head">
        <div className="un-head__title">
          <span className="tl-stat__label">{isUnionEvent ? 'Union Event' : 'Club Event'}</span>
          <h3 className="tl-section-title un-head__name">
            {isUnionEvent
              ? data?.unionName || 'Union Tournament'
              : groups.find((g) => g.club?.id === hostClubId)?.club?.name || 'Club Tournament'}
          </h3>
        </div>

        <div className="tl-stat-grid un-stats">
          <div className="tl-stat">
            <span className="tl-stat__label">{isUnionEvent ? 'Clubs' : 'Clubs In Field'}</span>
            <span className="tl-stat__value tl-stat__value--accent">{chips(clubCount)}</span>
            <span className="tl-stat__sub">Participating</span>
          </div>
          <div className="tl-stat">
            <span className="tl-stat__label">Entrants</span>
            <span className="tl-stat__value">{chips(entries.length)}</span>
            <span className="tl-stat__sub">In This Event</span>
          </div>
        </div>
      </div>

      {!isUnionEvent && (
        <p className="tl-section-note un-note">
          This Is A Club Event, Not A Union (XMTT) Tournament. The Host Club Is Shown Below.
        </p>
      )}

      {unaffiliatedCount > 0 && (
        <p className="tl-section-note un-note un-note--gap">
          {chips(unaffiliatedCount)} {unaffiliatedCount === 1 ? 'Player Is' : 'Players Are'} Listed
          Without A Club. Their Entry Predates Club Tracking.
        </p>
      )}

      {/* ── The clubs ────────────────────────────────────────────────────── */}
      {groups.length === 0 ? (
        <div className="tl-empty">
          <span>No Clubs Yet</span>
          <span className="tl-empty__hint">Clubs Appear As Soon As Players Register</span>
        </div>
      ) : (
        <ul className="tl-list tl-scroll un-clubs">
          {groups.map((group) => (
            <ClubCard
              key={group.key}
              group={group}
              isHost={!isUnionEvent && !!hostClubId && group.club?.id === hostClubId}
              currentUserId={currentUserId}
              open={openKeys.has(group.key)}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
