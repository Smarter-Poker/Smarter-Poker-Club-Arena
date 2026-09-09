/**
 *  PROMOTIONS PAGE — Club Promotions & Bonuses with Live Updates
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { readClubContextParam } from '../utils/clubScopedPath';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useMasterBusSubscriptions } from '../hooks/useMasterBusSubscription';
import LeaderboardCard from '../components/leaderboard/LeaderboardCard';
import { ArenaActionButton, ClubButtonsSurface } from '../components/club-buttons/ClubButtons';
import { ThrowableImage } from '../components/table/ThrowableImage';
import '../components/club-buttons/console-kit.css';
import ReferralModal from '../components/social/ReferralModal';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { promotionService } from '../services/PromotionService';
import './PromotionsPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { formatDateShort as formatDate } from '../utils/format';
import { retryFetch } from '../utils/retryFetch';
import { useIsMounted } from '../hooks/useIsMounted';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { reportError } from '../utils/errorReporter';
import { ErrorState } from '../components/common/EmptyState';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { publicOrigin } from '../lib/appBase';

interface Promotion {
  id: string;
  title: string;
  description: string;
  type: 'bonus' | 'freeroll' | 'leaderboard' | 'rakeback' | 'special';
  image_url?: string;
  start_date: string;
  end_date: string;
  prize_pool?: number;
  status?: string;
  requirements?: string;
}

export default function PromotionsPage() {
  useVisibilityRefresh(() => loadPromotions());
  const { clubId: routeClubId } = useParams();
  const location = useLocation();
  /* Inside a club the hamburger stamps `?club=` on this link, so the global
     `/promotions` route opens on THAT club's offers rather than the arena's.
     The path param still wins when both are present. */
  const clubId = routeClubId || readClubContextParam(location.search) || undefined;
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const toast = useToast();

  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'upcoming'>('active');
  const [showReferral, setShowReferral] = useState(false);
  const [visiblePromoCards, setVisiblePromoCards] = useState(new Set<number>());
  const [claimedIds, setClaimedIds] = useState<Set<string>>(new Set());
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const loadPromotionsRef = useRef(async () => {});
  const isMounted = useIsMounted();

  // The player's own referral code. This modal used to invent one
  // (`user.id.slice(0, 8).toUpperCase()`) and hand it out beside a link to
  // `https://clubarena.poker/join`, which is neither the production domain nor
  // a route that exists. Nobody who followed it could arrive anywhere, and the
  // code it displayed matched no player, so redemption refused it as an unknown
  // inviter. Both halves now come from the same place the rest of the app
  // shares from: the real player_number, on the real invite route.
  const [playerNumber, setPlayerNumber] = useState<string | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('player_number')
          .eq('id', user.id)
          .maybeSingle();
        if (!isMounted.current) return;
        /* THE ERROR IS READ, because the fallback below is the exact bug the
           comment on this block describes. `error` was never destructured, so
           a failed read left `playerNumber` null and `referralCode` fell back
           to `user.id` - which is what used to be shared, matched no player,
           and made redemption refuse the inviter. A failed read now leaves the
           link unbuilt rather than building a wrong one. */
        if (error) {
          reportError(error, 'PromotionsPage.referral_code_lookup');
          return;
        }
        setPlayerNumber(data?.player_number ?? null);
      } catch (e) {
        reportError(e, 'PromotionsPage.referral_code_lookup');
      }
    })();
  }, [user?.id, isMounted]);

  /* NO user.id FALLBACK. A player number is the only thing redemption
     recognises; sharing an account id produced a link that always refused. If
     the number is not known the link is simply not offered. */
  const referralCode = playerNumber || '';
  const referralLink =
    clubId && referralCode
      ? `${publicOrigin()}/hub/club-arena/invite/${clubId}?ref=${referralCode}`
      : '';

  // Load the user's existing claims so cards show Claimed vs claimable.
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const claims = await promotionService.getUserClaims(user.id);
        if (!isMounted.current) return;
        setClaimedIds(new Set(claims.map((c: any) => c.promotionId).filter(Boolean)));
      } catch (e) {
        reportError(e, 'PromotionsPage.loadClaims');
      }
    })();
  }, [user?.id, isMounted]);

  const handleClaimPromo = async (promoId: string) => {
    if (!user?.id || claimingId || claimedIds.has(promoId)) return;
    setClaimingId(promoId);
    try {
      await promotionService.claimPromotion(promoId, user.id);
      if (!isMounted.current) return;
      setClaimedIds((prev) => new Set(prev).add(promoId));
      /* NO BALANCE_UPDATED HERE, AND THE MESSAGE SAYS WHAT HAPPENED.
         Claiming records a `promotion_claims` row; it credits no wallet. Only
         the deposit-match path calls `add_to_promo_wallet`, and that path
         filters on a promotion type the table's own check constraint forbids
         (`promotions_type_check` allows leaderboard, rake_race, milestone,
         mystery, high_hand), so it can never match. Emitting BALANCE_UPDATED
         made every surface re-read a balance that had not moved, and
         "Promotion claimed!" beside it read as "you have been paid". */
      toast.success('Promotion Claimed. Your Reward Is Recorded Against This Offer.');
    } catch (err: any) {
      if (isMounted.current) toast.error(err?.message || 'Failed to claim promotion');
      reportError(err, 'PromotionsPage.claim');
    } finally {
      if (isMounted.current) setClaimingId(null);
    }
  };

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    loadPromotionsRef.current = loadPromotions;
  });

  const loadPromotionsCb = useCallback(() => {
    loadPromotionsRef.current();
  }, []);

  useEffect(() => {
    let isMounted = true;
    loadPromotions(() => isMounted);

    // Real-time promotions updates (INSERT + UPDATE + DELETE)
    const channelKey = clubId ? `promotions-live-${clubId}` : 'promotions-live';

    /* DB LOAD PASS 2026-08-24: this subscription had no filter, so every
       promotion write for every club on the platform was delivered here and
       re-ran the page's own club-scoped query — and could even toast "New
       promotion available!" for another club's promotion.

       The route param may be a slug, so the club UUID has to be resolved
       before the filter can be built; hence the async setup. Without a clubId
       this is the global promotions surface and there is no narrower scope to
       apply. Do not remove the filter on the club route. */
    const setupRealtime = async () => {
      const resolvedClubId = clubId ? await resolveClubUUID(clubId) : null;

      /* A club slug that fails to resolve must NOT fall through to an
         unfiltered subscription. Spreading `...(resolved ? {filter} : {})`
         reads as harmless, but on the failure path it silently restores the
         platform-wide firehose this scoping exists to remove - and
         tests/no-unfiltered-realtime-firehose.test.ts is static, so it cannot
         see a runtime widening. No scope means no subscription; the page still
         renders from its initial load. (clubId absent entirely is different:
         that is the legitimate global promotions surface.) */
      if (clubId && !resolvedClubId) return;
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'promotions',
            ...(resolvedClubId ? { filter: `club_id=eq.${resolvedClubId}` } : {}),
          },
          (payload) => {
            if (!isMounted) return;
            if (payload.eventType === 'INSERT') {
              toast.info('New Promotion Available');
            }
            loadPromotionsRef.current();
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'PromotionsPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[PromotionsPage] Realtime channel timed out');
          }
        });
    };
    void setupRealtime();

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  // ── Bus Listeners: cross-page reactivity ──
  useMasterBusSubscriptions(
    ['ANNOUNCEMENT_CHANGED', 'CLUB_UPDATED', 'CLUB_SETTINGS_UPDATED'],
    loadPromotionsCb,
    { debounce: 1000 }
  );

  const loadPromotions = async (getIsMounted?: () => boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      let query = supabase
        .from('promotions')
        .select(
          // promotions real columns are name/banner_url/status (not title/image_url/
          // is_active) — alias so the UI fields keep working. See PromotionService.
          'id, title:name, description, type, image_url:banner_url, start_date, end_date, prize_pool, status, requirements, club_id'
        )
        .order('start_date', { ascending: false });

      if (clubId) {
        const resolvedId = await resolveClubUUID(clubId);
        query = query.eq('club_id', resolvedId);
      }

      const { data, error } = await retryFetch(() => query.limit(20).then((r) => r), {
        maxRetries: 2,
        isMountedRef: isMounted,
      });

      if (getIsMounted && !getIsMounted()) return;

      if (error) throw error;
      setPromotions(data || []);
    } catch (error) {
      reportError(error, 'PromotionsPage.Failed_to_load_promotions');
      setLoadError('Promotions could not be loaded. Existing offers have not been changed.');
      toast.error('Failed to load promotions');
    }
    if (getIsMounted && !getIsMounted()) return;
    setLoading(false);
  };

  const now = new Date();
  const filteredPromos = promotions.filter((p) => {
    const start = new Date(p.start_date);
    const end = new Date(p.end_date);

    if (filter === 'active') {
      return start <= now && end >= now;
    } else if (filter === 'upcoming') {
      return start > now;
    }
    return true;
  });

  // Stagger promo cards
  useEffect(() => {
    setVisiblePromoCards(new Set());
    const timers = filteredPromos.map((_, i) =>
      setTimeout(() => setVisiblePromoCards((prev) => new Set([...prev, i])), i * 50)
    );
    return () => timers.forEach((t) => clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredPromos.length]);

  // Every offer type is a 3D render from the throwable kit, drawn through the
  // same cutout pipeline the table uses (no glyphs, no line icons).
  const getTypeRender = (type: string): string => {
    switch (type.toLowerCase()) {
      case 'bonus':
        return 'diamond';
      case 'freeroll':
        return 'star';
      case 'leaderboard':
      case 'high_hand':
        return 'trophy';
      case 'rakeback':
      case 'rake_race':
        return 'cash_stack';
      case 'milestone':
        return 'horseshoe';
      default:
        return 'star';
    }
  };

  const formatPromoType = (type: string): string => {
    const labels: Record<string, string> = {
      bonus: 'Bonus',
      freeroll: 'Freeroll',
      leaderboard: 'Leaderboard',
      rakeback: 'Rakeback',
      special: 'Special',
      high_hand: 'High Hand',
      rake_race: 'Rake Race',
      milestone: 'Milestone',
    };
    return (
      labels[type.toLowerCase()] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    );
  };

  const getTimeRemaining = (endDate: string): string => {
    const end = new Date(endDate);
    const diffMs = end.getTime() - now.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    const diffHours = Math.floor((diffMs % 86400000) / 3600000);

    if (diffDays > 0) return `${diffDays}d ${diffHours}h`;
    if (diffHours > 0) return `${diffHours}h`;
    return 'Ending Soon';
  };

  return (
    <StandardContentLayout className="promotions-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Promotions"
        title="Promotion Exchange"
        description="Discover Active Club Offers, Scheduled Events, Referral Rewards, And Leaderboard Opportunities Without Losing The Live Eligibility And Claim Workflows Beneath Them."
        art="market"
        status="OFFER INDEX // LIVE"
        metrics={[
          { label: 'Visible Offers', value: filteredPromos.length, tone: 'live' },
          { label: 'View', value: filter.toUpperCase() },
        ]}
      />
      {/* The doors: the painted action shells, side by side. */}
      <ClubButtonsSurface className="promotions-doors">
        <ArenaActionButton
          icon="diamond"
          label="Daily Club Arena Bonus"
          sublabel="Claim Today’s Tiles"
          size="large"
          onClick={() => navigate('/bonuses')}
        />
        <ArenaActionButton
          icon="add"
          label="Invite Friends"
          sublabel="Earn 5% Of Their Rake"
          size="large"
          onClick={() => setShowReferral(true)}
        />
      </ClubButtonsSurface>

      <div className="ck promotions-console">
        <div className="ck-selectors promo-filters" role="group" aria-label="Offer View">
          {(['active', 'upcoming', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className="ck-selector"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        <div className="promotions-list">
          {loading ? (
            <div className="promo-skeleton-list" aria-busy="true">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="ck-frame promo-skeleton-card">
                  <div className="promo-skel-icon" />
                  <div className="promo-skel-body">
                    <div className="promo-skel-line" style={{ width: '60%' }} />
                    <div className="promo-skel-line" style={{ width: '80%' }} />
                    <div className="promo-skel-line" style={{ width: '45%' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : loadError ? (
            <div className="ck-frame promo-state">
              <ErrorState message={loadError} onRetry={() => void loadPromotions()} />
            </div>
          ) : filteredPromos.length === 0 ? (
            <div className="ck-frame promo-state">
              <span className="ck-render promo-state__render" aria-hidden="true">
                <ThrowableImage throwableId="star" size={96} loading="lazy" />
              </span>
              <p className="ck-title promo-state__title">
                {filter === 'active'
                  ? 'No Active Promotions'
                  : filter === 'upcoming'
                    ? 'No Upcoming Promotions'
                    : 'No Promotions'}
              </p>
              <p className="ck-copy promo-state__copy">
                {filter === 'active'
                  ? 'There Are No Promotions Running Right Now. Check Back Soon.'
                  : filter === 'upcoming'
                    ? 'No Promotions Are Scheduled Yet. Stay Tuned.'
                    : 'No Promotions Have Been Created For This Club Yet.'}
              </p>
            </div>
          ) : (
            filteredPromos.map((promo, index) => {
              const running = new Date(promo.end_date) > now && new Date(promo.start_date) <= now;
              const endingSoon =
                running && new Date(promo.end_date).getTime() - now.getTime() < 86400000;
              const claimed = claimedIds.has(promo.id);
              const claiming = claimingId === promo.id;
              return (
                <article
                  key={promo.id}
                  className="ck-frame promo-card"
                  data-type={promo.type}
                  style={{
                    opacity: visiblePromoCards.has(index) ? 1 : 0,
                    transform: visiblePromoCards.has(index) ? 'translateY(0)' : 'translateY(10px)',
                    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  {promo.image_url && (
                    <div className="ck-frame ck-frame--art promo-image">
                      <img src={promo.image_url} alt="" loading="lazy" />
                    </div>
                  )}
                  <div className="promo-body">
                    <div className="ck-plaque promo-emblem" aria-hidden="true">
                      <span className="ck-plaque__label">{formatPromoType(promo.type)}</span>
                      <span className="ck-plaque__well">
                        <span className="ck-render promo-emblem__render">
                          <ThrowableImage
                            throwableId={getTypeRender(promo.type)}
                            size={96}
                            loading="lazy"
                          />
                        </span>
                      </span>
                    </div>

                    <div className="promo-content">
                      <h3 className="ck-title promo-title">{promo.title}</h3>
                      <p className="ck-copy promo-desc">{promo.description}</p>

                      <dl className="promo-meta">
                        <div className="ck-plaque promo-meta__plaque">
                          <dt className="ck-plaque__label">Runs</dt>
                          <dd className="ck-plaque__well">
                            <span className="ck-plaque__value promo-dates">
                              <span>{formatDate(promo.start_date)}</span>
                              <span>{formatDate(promo.end_date)}</span>
                            </span>
                          </dd>
                        </div>
                        {promo.prize_pool != null && promo.prize_pool > 0 && (
                          <div className="ck-plaque ck-plaque--live promo-meta__plaque">
                            <dt className="ck-plaque__label">Prize Pool</dt>
                            <dd className="ck-plaque__well">
                              <span className="ck-plaque__value promo-prize">
                                {promo.prize_pool.toLocaleString()}
                              </span>
                            </dd>
                          </div>
                        )}
                        {running && (
                          <div
                            className={`ck-plaque promo-meta__plaque${endingSoon ? ' ck-plaque--attention' : ''}`}
                          >
                            <dt className="ck-plaque__label">Time Left</dt>
                            <dd className="ck-plaque__well">
                              <span className="ck-plaque__value promo-countdown">
                                {getTimeRemaining(promo.end_date)}
                              </span>
                            </dd>
                          </div>
                        )}
                      </dl>

                      {endingSoon && <span className="ending-soon-badge">Ending Soon</span>}

                      {/* Show LeaderboardCard for leaderboard promotions */}
                      {promo.type === 'leaderboard' && (
                        <div className="promo-leaderboard">
                          <LeaderboardCard
                            promotionId={promo.id}
                            title={`${promo.title || 'Leaderboard'} Rankings`}
                            limit={5}
                            showCurrentUser={true}
                          />
                        </div>
                      )}

                      {/* Claim action: active, non-leaderboard promos (leaderboard payouts
                          are ranked, not manually claimed). The console's own faces. */}
                      {promo.type !== 'leaderboard' &&
                        running &&
                        (claimed ? (
                          <span className="ck-btn ck-btn--dark promo-claim-btn">Claimed</span>
                        ) : (
                          <button
                            type="button"
                            className={`ck-btn promo-claim-btn${claiming ? ' ck-btn--busy' : ''}`}
                            disabled={claiming}
                            aria-busy={claiming || undefined}
                            onClick={() => handleClaimPromo(promo.id)}
                          >
                            {claiming ? 'Claiming' : 'Claim'}
                          </button>
                        ))}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </div>

      {/* Referral Modal */}
      <ReferralModal
        isOpen={showReferral}
        onClose={() => setShowReferral(false)}
        referralCode={referralCode}
        referralLink={referralLink}
        totalReferrals={0}
      />
    </StandardContentLayout>
  );
}
