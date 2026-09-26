/**
 * ♠ CLUB ARENA — Club Discovery
 * Browse and search for clubs to join
 *
 * ── ON THE SPADE CONSOLE (#ClubArenaConsole) ────────────────────────────────
 * This component sits directly under the Clubs page header console, and until
 * now it did not look like it belonged there: a rounded navy `--radius-xl`
 * card per club with an inset highlight, a 48px rounded logo well, a
 * `--radius-full` tag pill, a gradient level badge, a green pulsing dot, a
 * star-glyph rating and a `--fb-blue` gradient JOIN button - one frame sitting
 * on another frame, immediately beneath a picture that paints all of those in
 * the art. It also printed the top three clubs TWICE: once in a horizontally
 * snapping "featured" rail of gradient tiles with a HOT badge, and again in
 * the grid below. Dan: "NOTHING CAN BE COPY PASTED OR OVERLAPPED."
 *
 * It is now the same spade master the page above it is drawn from, cut into
 * head / rails / foot by SpadeConsole:
 *
 *   - DISCOVER CLUBS engraved in the header well, the number of clubs on show
 *     in the well's painted pill slot;
 *   - the search field is a groove cut into the glass (a black hairline with a
 *     light lip), never a bordered box; the four views are lit words, never
 *     drawn tabs;
 *   - every club is a ROW on the glass: its name in engraved silver, its
 *     figures as label/value pairs in the master's lit blue and silver,
 *     separated by engraved rules. Dan 2026-09-09, on the four-bay deck:
 *     "I DON'T LIKE THE 4 BOXES, AND THE WAY IT STICKS OUT ON THE SIDES" -
 *     the bays belong to the buy-in family, everything else prints rows;
 *   - the foot is the flat closing cap. There is no pair of actions that
 *     belongs to the whole list, and the foot paints BOTH plates, so a single
 *     plate would leave the other painted and empty. The two per-club actions
 *     are lit words on the glass instead.
 *
 * The "featured" three keep their meaning without a second copy of themselves:
 * the first three rows of a list longer than three carry a lit HOT flag, which
 * is what the rail was saying.
 *
 * Nothing about the data changed. The queries, the explicit column list, the
 * filter ordering, the bus subscription, the mounted guard, the stagger and
 * every reportError below are the ones that were here.
 */

import React, { useState, useEffect, useId } from 'react';
import { supabase } from '../../lib/supabase';
import { ClubsService } from '../../services/ClubsService';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { getClubLevel } from '../../utils/clubLevels';
import { useIsMounted } from '../../hooks/useIsMounted';
import { SpadeConsole } from '../console/SpadeConsole';
import PageSkeleton from '../common/PageSkeleton';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import './ClubDiscovery.css';
import { reportError } from '../../utils/errorReporter';

interface Club {
  id: string;
  slug?: string;
  name: string;
  logo?: string;
  description: string;
  memberCount: number;
  activeTableCount: number;
  tags: string[];
  isPrivate: boolean;
  rating: number;
  levelInfo?: any;
}

interface ClubDiscoveryProps {
  onJoinRequest?: (clubId: string) => void;
  onViewClub?: (club: Club) => void;
}

type Filter = 'all' | 'popular' | 'active' | 'new';

/** The four views, spelled out rather than capitalised from the key: the
    Title Case gate reads the source, not the runtime. */
const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'popular', label: 'Popular' },
  { key: 'active', label: 'Active' },
  { key: 'new', label: 'New' },
];

/** Singular and plural, because "1 Clubs" in the pill slot reads unfinished. */
const countPill = (n: number) => `${n} ${n === 1 ? 'Club' : 'Clubs'}`;

/** The stagger that walks each row on. Unchanged; the animation law keeps it. */
const rowAnimationStyle = (shown: boolean) => ({
  opacity: shown ? 1 : 0,
  transform: shown ? 'translateY(0)' : 'translateY(8px)',
  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
});

export const ClubDiscovery: React.FC<ClubDiscoveryProps> = ({ onJoinRequest, onViewClub }) => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('popular');
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const searchId = useId();

  useEffect(() => {
    loadClubs();
  }, [filter]);

  // Q3 Phase 10: Bus listener for cross-page club updates
  useMasterBusSubscription('CLUB_UPDATED', () => {
    loadClubs();
  });

  const loadClubs = async () => {
    setLoading(true);
    try {
      let fetchedClubs: any[] = [];
      if (search) {
        fetchedClubs = await ClubsService.search(search);
      } else {
        // ── Filter-specific queries (was: all calling search('')) ──
        // Explicit columns, not `*, club_members(count)`: the embedded count
        // was never read (member_count is trigger-maintained on clubs), and
        // `*` dragged every club's settings JSON and 70+ columns across the
        // wire for a browse grid that renders nine fields.
        let query = supabase
          .from('clubs')
          .select(
            'id, slug, name, description, logo_url, avatar_url, member_count, table_count, requires_approval, is_public, tags, game_type, average_rating, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next, created_at'
          )
          .eq('is_public', true)
          .limit(30);

        // Sort by filter type
        if (filter === 'popular') {
          query = query.order('member_count', { ascending: false });
        } else if (filter === 'active') {
          query = query.order('table_count', { ascending: false, nullsFirst: false });
        } else if (filter === 'new') {
          query = query.order('created_at', { ascending: false });
        } else {
          query = query.order('member_count', { ascending: false });
        }

        const { data, error: queryErr } = await query;
        if (queryErr) reportError(queryErr, 'ClubDiscovery.Load_failed');
        fetchedClubs = data || [];
      }

      // Map backend data to local Club interface
      const mappedClubs: Club[] = fetchedClubs.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        logo: c.logo_url || c.avatar_url,
        // A blank description stays blank. The list used to print a welcome
        // line the owner never wrote, as if it were the club's own copy.
        description: typeof c.description === 'string' ? c.description.trim() : '',
        memberCount: c.member_count || 0,
        activeTableCount: c.table_count || 0,
        // No minStakes/maxStakes: clubs has no such columns, so every card
        // showed the fallback "1/2 - 5/10" as if it were real. Fabricated
        // data is worse than no data — the stake filter built on it is gone
        // for the same reason.
        // The same law for games: a club with no tags and no game type shows
        // none. The old fallback named a game the club may never have run.
        tags: (() => {
          const own: string[] = Array.isArray(c.tags)
            ? c.tags.filter(
                (tag: unknown): tag is string => typeof tag === 'string' && !!tag.trim()
              )
            : [];
          if (own.length > 0) return own;
          return typeof c.game_type === 'string' && c.game_type.trim() ? [c.game_type] : [];
        })(),
        isPrivate: c.requires_approval || !c.is_public,
        rating: c.average_rating || c.rating || 0,
        levelInfo: getClubLevel({
          level: c.level || 1,
          playerCount: c.member_count || 0,
          hierarchyUnits: c.hierarchy_units_rounded_up || 0,
          playerThresholdCurrent: c.player_threshold_current || 0,
          playerThresholdNext: c.player_threshold_next || 0,
          hierarchyThresholdCurrent: c.hierarchy_threshold_current || 0,
          hierarchyThresholdNext: c.hierarchy_threshold_next || 0,
        }),
      }));

      if (!isMounted.current) return;
      setClubs(mappedClubs);
      setVisibleItems(new Set());
      mappedClubs.forEach((_, i) => {
        setTimeout(() => {
          if (isMounted.current) setVisibleItems((prev) => new Set(prev).add(i));
        }, i * 60);
      });
    } catch (error) {
      reportError(error, 'ClubDiscovery.Failed_to_load_clubs');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const filteredClubs = clubs.filter(
    (club) =>
      club.name.toLowerCase().includes(search.toLowerCase()) ||
      club.description.toLowerCase().includes(search.toLowerCase()) ||
      club.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase()))
  );

  /* The rail used to print these three a second time, above the list they are
     already at the top of. The flag says the same thing in one copy. */
  const hotCount = filteredClubs.length > 3 ? 3 : 0;

  return (
    <SpadeConsole
      className="club-discovery"
      aria-busy={loading || undefined}
      eyebrow="Club Arena"
      title="Discover Clubs"
      pill={loading ? 'Loading' : countPill(filteredClubs.length)}
      pillInk={loading || filteredClubs.length === 0 ? 'muted' : 'blue'}
      foot="foot"
    >
      {/* A groove cut into the glass, not a bordered box: a black hairline
          with a light lip, the cut the master's own chrome rules are made of. */}
      <div className="club-discovery__search">
        <label className="club-discovery__search-label sc-label sc-ink--blue" htmlFor={searchId}>
          Search
        </label>
        <input
          id={searchId}
          className="club-discovery__search-field"
          type="search"
          placeholder="Search Clubs By Name, Game, Or Tag..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* The four views are lit words cut into the glass, not drawn tabs: the
          art paints no tab, so nothing here draws one either. */}
      <div className="club-discovery__views" role="group" aria-label="Club Views">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            className={`club-discovery__view ${
              filter === f.key ? 'sc-ink--silver' : 'sc-ink--muted'
            }`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="club-discovery__loading">
          <PageSkeleton variant="list" />
        </div>
      ) : filteredClubs.length === 0 ? (
        <p className="sc-copy sc-copy--center club-discovery__empty">
          No Clubs Found Matching Your Criteria
        </p>
      ) : (
        <ol className="club-discovery__list">
          {filteredClubs.map((club, i) => (
            <li
              key={club.id}
              className="club-discovery__row"
              style={rowAnimationStyle(visibleItems.has(i))}
            >
              <div className="club-discovery__row-head">
                <h3 className="club-discovery__name sc-ink--silver">{club.name}</h3>
                {i < hotCount && (
                  <span className="club-discovery__flag sc-label sc-ink--gold">Hot</span>
                )}
                {club.isPrivate && (
                  <span className="club-discovery__flag sc-label sc-ink--blue">Private</span>
                )}
              </div>

              {/* Owner copy is data, so it is Title Cased where it prints. */}
              {club.description && (
                <p className="sc-copy club-discovery__desc">{titleCase(club.description)}</p>
              )}

              <dl className="club-discovery__facts">
                <div className="club-discovery__fact">
                  <dt className="club-discovery__fact-label sc-label sc-ink--blue">Members</dt>
                  <dd className="club-discovery__fact-value sc-ink--silver">
                    {compactChips(club.memberCount)}
                  </dd>
                </div>
                <div className="club-discovery__fact">
                  <dt className="club-discovery__fact-label sc-label sc-ink--blue">Tables</dt>
                  {/* The green pulsing dot is gone; the figure itself lights up
                      when a club has games running, which is what the dot said. */}
                  <dd
                    className={`club-discovery__fact-value ${
                      club.activeTableCount > 0 ? 'sc-ink--green' : 'sc-ink--silver'
                    }`}
                  >
                    {club.activeTableCount > 0
                      ? `${compactChips(club.activeTableCount)} Live`
                      : compactChips(club.activeTableCount)}
                  </dd>
                </div>
                {club.levelInfo && (
                  <div className="club-discovery__fact">
                    <dt className="club-discovery__fact-label sc-label sc-ink--blue">Level</dt>
                    <dd className="club-discovery__fact-value sc-ink--silver">
                      {`Lv.${club.levelInfo.level} ${club.levelInfo.tierLabel}`}
                    </dd>
                  </div>
                )}
                {club.tags.length > 0 && (
                  <div className="club-discovery__fact">
                    <dt className="club-discovery__fact-label sc-label sc-ink--blue">Games</dt>
                    <dd className="club-discovery__fact-value sc-ink--silver">
                      {club.tags
                        .slice(0, 3)
                        .map((tag) => titleCase(tag))
                        .join(', ')}
                    </dd>
                  </div>
                )}
                {club.rating > 0 && (
                  <div className="club-discovery__fact">
                    <dt className="club-discovery__fact-label sc-label sc-ink--blue">Rating</dt>
                    {/* Whole stars, rounded DOWN, so a printed figure never
                        overstates a club. The star glyphs are gone with the
                        rest of the stuck-on icons. */}
                    <dd className="club-discovery__fact-value sc-ink--silver">
                      {`${Math.floor(club.rating)} / 5`}
                    </dd>
                  </div>
                )}
              </dl>

              {/* Two lit words, not a clickable card with a gradient button
                  inside it: both actions are real buttons a keyboard reaches. */}
              <div className="club-discovery__row-actions">
                <button
                  type="button"
                  className="club-discovery__word sc-ink--silver"
                  aria-label={`View ${club.name}`}
                  onClick={() => onViewClub?.(club)}
                >
                  View Club
                </button>
                <button
                  type="button"
                  className="club-discovery__word sc-ink--blue"
                  aria-label={club.isPrivate ? `Request To Join ${club.name}` : `Join ${club.name}`}
                  onClick={() => onJoinRequest?.(club.id)}
                >
                  {club.isPrivate ? 'Request' : 'Join'}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </SpadeConsole>
  );
};

export default ClubDiscovery;
