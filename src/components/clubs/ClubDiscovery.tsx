/**
 * ♠ CLUB ARENA — Club Discovery
 * Browse and search for clubs to join
 */

import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { ClubsService } from '../../services/ClubsService';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { getClubLevel } from '../../utils/clubLevels';
import { useIsMounted } from '../../hooks/useIsMounted';
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

export const ClubDiscovery: React.FC<ClubDiscoveryProps> = ({ onJoinRequest, onViewClub }) => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'popular' | 'active' | 'new'>('popular');
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();

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
        description: c.description || 'Welcome To Our Club!',
        memberCount: c.member_count || 0,
        activeTableCount: c.table_count || 0,
        // No minStakes/maxStakes: clubs has no such columns, so every card
        // showed the fallback "1/2 - 5/10" as if it were real. Fabricated
        // data is worse than no data — the stake filter built on it is gone
        // for the same reason.
        tags: c.tags || (c.game_type ? [c.game_type] : ['Texas Holdem']),
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

  const renderStars = (rating: number) => {
    const full = Math.floor(rating);
    const half = rating % 1 >= 0.5;
    return (
      <span className="stars">
        {'★'.repeat(full)}
        {half && '½'}
        <span className="rating-value">{rating.toFixed(1)}</span>
      </span>
    );
  };

  return (
    <div className="club-discovery">
      <div className="discovery-header">
        <h2>Discover Clubs</h2>
      </div>

      {/* Search */}
      <div className="search-bar">
        <span className="search-icon">⌕</span>
        <input
          type="text"
          placeholder="Search Clubs By Name, Game, Or Tag..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Filters */}
      <div className="filter-row">
        <div className="filter-group">
          {(['all', 'popular', 'active', 'new'] as const).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Q3 Phase 14: Featured / Hot Clubs Carousel */}
      {!loading && filteredClubs.length > 3 && (
        <div
          className="featured-carousel"
          style={{
            display: 'flex',
            gap: '12px',
            overflowX: 'auto',
            padding: '12px 0',
            scrollSnapType: 'x mandatory',
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
          }}
        >
          {filteredClubs.slice(0, 3).map((club) => (
            <div
              key={`featured-${club.id}`}
              onClick={() => onViewClub?.(club)}
              style={{
                minWidth: '200px',
                scrollSnapAlign: 'start',
                cursor: 'pointer',
                background: 'linear-gradient(135deg, rgba(255,107,53,0.12), rgba(255,53,107,0.12))',
                border: '1px solid rgba(255,107,53,0.2)',
                borderRadius: '14px',
                padding: '14px',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: '6px',
                  right: '6px',
                  background: 'linear-gradient(90deg, #ff6b35, #ff356b)',
                  color: '#fff',
                  fontSize: '0.6rem',
                  fontWeight: 800,
                  padding: '2px 8px',
                  borderRadius: '8px',
                }}
              >
                HOT
              </div>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '4px' }}>
                {club.name}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary, #8b9dc3)' }}>
                {club.memberCount} Members
              </div>
              {club.activeTableCount > 0 && (
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: '#10b981',
                    fontWeight: 700,
                    marginTop: '4px',
                  }}
                >
                  ● {club.activeTableCount} Tables Live
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Club Grid */}
      <div className="clubs-grid">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="club-card skeleton" />)
        ) : filteredClubs.length === 0 ? (
          <div className="empty-state">
            <span>⌂</span>
            <p>No Clubs Found Matching Your Criteria</p>
          </div>
        ) : (
          filteredClubs.map((club, i) => (
            <div
              key={club.id}
              className="club-card"
              onClick={() => onViewClub?.(club)}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="club-header">
                <div className="club-logo">
                  {club.logo ? (
                    <img loading="lazy" decoding="async" src={club.logo} alt={club.name} />
                  ) : (
                    <span>{club.name[0]}</span>
                  )}
                </div>
                <div className="club-meta">
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {club.name}
                    {club.levelInfo && (
                      <span
                        style={{
                          fontSize: '0.6rem',
                          padding: '2px 6px',
                          borderRadius: '10px',
                          background: club.levelInfo.gradient,
                          color: '#fff',
                          fontWeight: 700,
                          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                        }}
                      >
                        Lv.{club.levelInfo.level}
                      </span>
                    )}
                  </h3>
                  {club.isPrivate && <span className="private-badge">◈</span>}
                </div>
              </div>
              <p className="club-desc">{club.description}</p>
              <div className="club-tags">
                {club.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
              <div className="club-stats">
                <span> {club.memberCount}</span>
                <span> {club.activeTableCount} Tables</span>
                {club.activeTableCount > 0 && (
                  <span className="live-indicator">
                    <span className="live-pulse" />
                    Live
                  </span>
                )}
              </div>
              <div className="club-footer">
                {renderStars(club.rating)}
                <button
                  className="join-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onJoinRequest?.(club.id);
                  }}
                >
                  {club.isPrivate ? 'Request' : 'Join'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default ClubDiscovery;
