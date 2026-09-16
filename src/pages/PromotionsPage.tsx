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
import { ThrowableImage } from '../components/table/ThrowableImage';
import ReferralModal from '../components/social/ReferralModal';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { promotionService } from '../services/PromotionService';
import './PromotionsPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { compactChips, formatDateShort as formatDate } from '../utils/format';
import { retryFetch } from '../utils/retryFetch';
import { useIsMounted } from '../hooks/useIsMounted';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { reportError } from '../utils/errorReporter';
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
  // table's own cutout pipeline: an organic object on the glass, never a glyph.
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
      {/* ONE PICTURE (#ClubArenaConsole): the Rewards Circuit console carries the
          title and the status word in its painted head, the view words, every
          offer and its claim on the glass, and the two doors on its painted
          plates. Nothing on this page is drawn. */}
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Promotions"
        title="Promotions"
        description="Active Club Offers, Scheduled Events, Referral Rewards And Leaderboard Races, With The Live Eligibility And Claim Workflows Beneath Them."
        art="market"
        status="OFFER INDEX // LIVE"
        crest="flat"
        pill={`${filteredPromos.length} ${filter}`}
        pillInk={filteredPromos.length > 0 ? 'green' : 'muted'}
        plates={{
          secondary: {
            label: 'Invite Friends',
            ink: 'silver',
            onClick: () => setShowReferral(true),
            'aria-haspopup': 'dialog',
          },
          primary: {
            label: 'Daily Bonus',
            ink: 'white',
            onClick: () => navigate('/bonuses'),
          },
        }}
      >
        <div className="promo-views" role="group" aria-label="Offer View">
          {(['active', 'upcoming', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`promo-views__word ${filter === f ? 'sc-ink--white' : 'sc-ink--muted'}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="promo-state" role="status" aria-busy="true" aria-live="polite">
            <p className="sc-copy sc-copy--center promo-word--busy">Reading The Offer Index</p>
          </div>
        ) : loadError ? (
          <div className="promo-state" role="alert">
            <p className="sc-copy sc-copy--center">{loadError}</p>
            <button
              type="button"
              className="promo-word sc-ink--white"
              onClick={() => void loadPromotions()}
            >
              Try Again
            </button>
          </div>
        ) : filteredPromos.length === 0 ? (
          <div className="promo-state" role="status">
            <span className="promo-state__render" aria-hidden="true">
              <ThrowableImage throwableId="star" size={96} loading="lazy" />
            </span>
            <p className="promo-state__title sc-ink--silver">
              {filter === 'active'
                ? 'No Active Promotions'
                : filter === 'upcoming'
                  ? 'No Upcoming Promotions'
                  : 'No Promotions'}
            </p>
            <p className="sc-copy sc-copy--center promo-state__copy">
              {filter === 'active'
                ? 'There Are No Promotions Running Right Now. Check Back Soon.'
                : filter === 'upcoming'
                  ? 'No Promotions Are Scheduled Yet. Stay Tuned.'
                  : 'No Promotions Have Been Created For This Club Yet.'}
            </p>
          </div>
        ) : (
          <ul className="promo-list" aria-label="Offers">
            {filteredPromos.map((promo, index) => {
              const running = new Date(promo.end_date) > now && new Date(promo.start_date) <= now;
              const endingSoon =
                running && new Date(promo.end_date).getTime() - now.getTime() < 86400000;
              const claimed = claimedIds.has(promo.id);
              const claiming = claimingId === promo.id;
              return (
                /* A ROW on the glass, not a card: the render beside the words,
                   the figures on one line, CLAIM a lit word at the end. */
                <li
                  key={promo.id}
                  className="promo-row"
                  data-type={promo.type}
                  style={{
                    opacity: visiblePromoCards.has(index) ? 1 : 0,
                    transform: visiblePromoCards.has(index) ? 'translateY(0)' : 'translateY(10px)',
                    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span className="promo-row__render" aria-hidden="true">
                    <ThrowableImage
                      throwableId={getTypeRender(promo.type)}
                      size={96}
                      loading="lazy"
                    />
                  </span>
                  <span className="promo-row__lines">
                    <span className="sc-label sc-ink--blue promo-row__type">
                      {formatPromoType(promo.type)}
                    </span>
                    <span className="promo-row__title sc-ink--silver">{promo.title}</span>
                    {promo.description && (
                      <span className="sc-copy promo-row__desc">{promo.description}</span>
                    )}
                    <span className="promo-row__meta">
                      <span className="promo-row__fact">
                        <span className="sc-label sc-ink--blue">Runs</span>
                        <span className="sc-ink--silver promo-row__figure">
                          {formatDate(promo.start_date)} To {formatDate(promo.end_date)}
                        </span>
                      </span>
                      {promo.prize_pool != null && promo.prize_pool > 0 && (
                        <span className="promo-row__fact">
                          <span className="sc-label sc-ink--blue">Prize</span>
                          <span className="sc-ink--green promo-row__figure">
                            {compactChips(promo.prize_pool)}
                          </span>
                        </span>
                      )}
                      {running && (
                        <span className="promo-row__fact">
                          <span className="sc-label sc-ink--blue">Left</span>
                          <span
                            className={`promo-row__figure ${endingSoon ? 'sc-ink--red' : 'sc-ink--gold'}`}
                          >
                            {getTimeRemaining(promo.end_date)}
                          </span>
                        </span>
                      )}
                    </span>
                    {/* Leaderboard promotions carry their standings on the same glass. */}
                    {promo.type === 'leaderboard' && (
                      <span className="promo-row__board">
                        <LeaderboardCard
                          promotionId={promo.id}
                          title={`${promo.title || 'Leaderboard'} Rankings`}
                          limit={5}
                          showCurrentUser={true}
                          variant="glass"
                        />
                      </span>
                    )}
                  </span>
                  {/* Claim: active, non-leaderboard promos (leaderboard payouts are
                      ranked, not manually claimed). A lit word, nothing drawn. */}
                  {promo.type !== 'leaderboard' &&
                    running &&
                    (claimed ? (
                      <span className="promo-word sc-ink--green promo-row__action">Claimed</span>
                    ) : (
                      <button
                        type="button"
                        className={`promo-word sc-ink--white promo-row__action${claiming ? ' promo-word--busy' : ''}`}
                        disabled={claiming}
                        aria-busy={claiming || undefined}
                        onClick={() => handleClaimPromo(promo.id)}
                      >
                        {claiming ? 'Claiming' : 'Claim'}
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </RewardsSurfaceHeader>

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
