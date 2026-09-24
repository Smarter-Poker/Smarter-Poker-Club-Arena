/**
 *  VIP PAGE — VIP Tier Progression, Benefits, and Rewards Marketplace
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { MEDIA_BASE } from '../utils/mediaBase';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import {
  vipService,
  VIP_MONTHLY_ALLOWANCES,
  FEATURE_PRICING,
  normalizeVIPPurchaseError,
  type VIPFeature,
  type VIPMonthlyLimits,
} from '../services/VIPService';
import type { VipStatus } from '../utils/vipStatus';
import { reportError } from '../utils/errorReporter';
import { VIPCardsModal } from '../components/vip/VIPCardsModal';
import { VIPPerksGrid, type VIPPerk } from '../components/vip/VIPPerksGrid';
import { DiamondTopUpModal } from '../components/vip/DiamondTopUpModal';
import { VIPMembershipPlate } from '../components/vip/VIPMembershipPlate';
import { RewardsMarketplace, Reward } from '../components/vip/RewardsMarketplace';
import { VIPActivityHistory, type DiamondActivity } from '../components/vip/VIPActivityHistory';
import { useToast } from '../components/common/Toast';
import DiamondWalletModal from '../components/wallet/DiamondWalletModal';
import './VIPPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { formatPopupText } from '../utils/popupStyle';

const FEATURE_ACRONYMS: Record<string, string> = {
  ai: 'AI',
  bb: 'BB',
  gto: 'GTO',
  vip: 'VIP',
};

const ALL_THROWABLES_ART = `${MEDIA_BASE}images/marketplace/throwables/all-throwables-access-v1.png`;

const formatFeatureName = (feature: string) =>
  feature
    .split('_')
    .map((word) => FEATURE_ACRONYMS[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');

export default function VIPPage() {
  const { user } = useAuthUser();
  const toast = useToast();

  const [isVIP, setIsVIP] = useState(false);
  /* Which membership, not which rung. Dan 2026-09-04: "THERE IS NO SUCH THING
     AS 'PLATINUM VIP' BTW. JUST VIP, AND LIFETIME VIP." */
  const [vipGrade, setVipGrade] = useState<VipStatus>('none');
  const [vipExpiresAt, setVipExpiresAt] = useState<Date | null>(null);
  const [monthlyLimits, setMonthlyLimits] = useState<VIPMonthlyLimits>({
    rabbitHunts: { used: 0, limit: 0 },
    timeBankSeconds: { used: 0, limit: 0 },
    emojis: { used: 0, limit: 0 },
    tags: { used: 0, limit: 0 },
    throwables: { used: 0, limit: 0 },
  });
  const [diamonds, setDiamonds] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showTopUpModal, setShowTopUpModal] = useState(false);
  const [showDiamondHistory, setShowDiamondHistory] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [stateUserId, setStateUserId] = useState<string | undefined>();
  // React state is not synchronous: two taps in the same frame can both see
  // `purchasing === null`. This ref closes that mobile double-tap window before
  // the first network request leaves the device.
  const purchaseInFlightRef = useRef(false);
  const purchaseRequestRef = useRef(0);
  const activeUserIdRef = useRef(user?.id);
  const [vipEntranceComplete, setVIPEntranceComplete] = useState(false);

  // Promise continuations can run before an account-change effect. Update the
  // identity ref during render so an old response cannot paint a new account.
  activeUserIdRef.current = user?.id;

  // Toasts render through a document-level portal. Scope the shared success
  // palette to this Marketplace route only, then restore the rest of the app's
  // existing toast presentation as soon as the route unmounts.
  useEffect(() => {
    document.body.classList.add('marketplace-color-scope');
    return () => document.body.classList.remove('marketplace-color-scope');
  }, []);

  // VIP Points System
  const [vipPoints, setVipPoints] = useState({
    current: 0,
    lifetime: 0,
    monthly: 0,
    activeStreak: 0,
  });

  const [recentDiamondActivities, setRecentDiamondActivities] = useState<DiamondActivity[]>([]);
  const [diamondActivityState, setDiamondActivityState] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );

  const membershipPerks = useMemo(() => {
    const isLifetime = vipGrade === 'lifetime';
    const perks: VIPPerk[] = [
      {
        id: 'rabbit',
        icon: 'rabbit',
        title: 'Rabbit Hunt',
        description: isLifetime
          ? 'Unlimited Rabbit Hunts With No Diamond Charge'
          : 'See Undealt Cards',
        value: isLifetime ? 'Unlimited' : `${VIP_MONTHLY_ALLOWANCES.rabbitHunts} / Month`,
      },
      {
        id: 'timebank',
        icon: 'timer',
        title: 'Time Bank',
        description: isLifetime
          ? 'Unlimited Standard 20-Second Time Bank Activations'
          : `${VIP_MONTHLY_ALLOWANCES.timeBankSeconds}s Free Per Month`,
        value: isLifetime ? 'Unlimited' : `${VIP_MONTHLY_ALLOWANCES.timeBankSeconds}s`,
      },
      {
        id: 'emojis',
        icon: 'chat',
        title: 'Emojis',
        description: isLifetime
          ? 'Every Digital Emoji Pack Included'
          : `${VIP_MONTHLY_ALLOWANCES.emojis.toLocaleString()} Free Per Month`,
        value: isLifetime ? 'Included' : VIP_MONTHLY_ALLOWANCES.emojis.toLocaleString(),
      },
      {
        id: 'tags',
        icon: 'stats',
        title: 'Player Tags',
        description: isLifetime
          ? 'Every Digital Player Tag Included'
          : `${VIP_MONTHLY_ALLOWANCES.tags.toLocaleString()} Free Per Month`,
        value: isLifetime ? 'Included' : VIP_MONTHLY_ALLOWANCES.tags.toLocaleString(),
      },
      {
        id: 'throwable',
        icon: 'diamond',
        artworkSrc: ALL_THROWABLES_ART,
        title: 'All Throwables',
        description: isLifetime
          ? 'Unlimited Throwables With No Diamond Charge'
          : `${VIP_MONTHLY_ALLOWANCES.throwables} Free Per Month`,
        value: isLifetime ? 'Unlimited' : `${VIP_MONTHLY_ALLOWANCES.throwables}`,
      },
      {
        id: 'stack',
        icon: 'stats',
        title: 'Show Stack In Big Blinds',
        description: 'Otherwise 5 Diamonds Per Session',
        value: 'Included',
      },
      {
        id: 'offline',
        icon: 'settings',
        title: 'Offline Protection',
        description: 'Otherwise 10 Diamonds Per Session',
        value: 'Included',
      },
      {
        id: 'autobank',
        icon: 'timer',
        title: 'Auto Time Bank',
        description: 'Otherwise 5 Diamonds Per Activation',
        value: 'Included',
      },
    ];

    if (isLifetime) {
      perks.push(
        {
          id: 'table-cosmetics',
          icon: 'settings',
          title: 'Table Skins And Backgrounds',
          description: 'All Cataloged Digital Options Included',
          value: 'Included',
        },
        {
          id: 'card-cosmetics',
          icon: 'spade',
          title: 'Card Backs And Dealer Buttons',
          description: 'All Cataloged Digital Options Included',
          value: 'Included',
        },
        {
          id: 'avatar-cosmetics',
          icon: 'info',
          title: 'VIP Avatars, Frames, And Auras',
          description: 'All VIP-Only Digital Options Included',
          value: 'Included',
        }
      );
    }

    return perks;
  }, [vipGrade]);

  // VIP entrance animation
  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => setVIPEntranceComplete(true), 200);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  // Bus listener: update diamond balance when changed from other pages (debounced)
  useEffect(() => {
    if (!user?.id) return;
    const unsubDiamond = masterBus.subscribeDebounced(
      'DIAMOND_BALANCE_CHANGED',
      (event: any) => {
        if (event?.payload?.newBalance !== undefined) {
          setDiamonds(event.payload.newBalance);
        }
      },
      500
    );
    return unsubDiamond;
  }, [user?.id]);

  // Removed 2026-08-28: a VIP_POINTS_UPDATED listener lived here, but NOTHING
  // emits that event on the client bus — points are awarded server-side
  // (rake settlement), so the handler could never run and "live" VIP points
  // silently did not exist. Found when noDeadBusSubscriptions learned to see
  // subscribeDebounced. If live points are wanted, they need a server->client
  // bridge (tournamentEventBridge pattern), not a dead subscription.

  // Every account or visibility refresh gets a generation. Late responses
  // from account A cannot paint account B or leave it stuck in loading state.
  const loadGenerationRef = useRef(0);

  const loadVIPStatus = useCallback(
    async (getIsMounted?: () => boolean) => {
      const requestedUserId = user?.id;
      const generation = ++loadGenerationRef.current;
      const isCurrent = () =>
        generation === loadGenerationRef.current &&
        activeUserIdRef.current === requestedUserId &&
        (!getIsMounted || getIsMounted());

      if (!requestedUserId) {
        if (isCurrent()) {
          setStateUserId(undefined);
          setLoading(false);
        }
        return;
      }

      if (isCurrent()) {
        setLoading(true);
        setRecentDiamondActivities([]);
        setDiamondActivityState('loading');
      }
      try {
        const vipStatus = await vipService.checkVIPStatus(requestedUserId);
        if (!isCurrent()) return;
        setIsVIP(vipStatus.isVIP);
        setVipGrade(vipStatus.status);
        setVipExpiresAt(vipStatus.expiresAt);
        setMonthlyLimits(vipStatus.monthlyLimits);

        const { data: profData } = await supabase
          .from('profiles')
          .select('diamonds')
          .eq('id', requestedUserId)
          .maybeSingle();

        if (!isCurrent()) return;
        setDiamonds(profData?.diamonds || 0);

        const { data: vp } = await supabase
          .from('vip_points')
          .select('current_points, lifetime_points')
          .eq('user_id', requestedUserId)
          .maybeSingle();
        if (!isCurrent()) return;
        setVipPoints((prev) => ({
          ...prev,
          current: Number(vp?.current_points || 0),
          lifetime: Number(vp?.lifetime_points || 0),
        }));

        /* Diamonds live in diamond_transactions. Read both transaction type
           columns because older rows use `type`, and report a failed money
           read instead of presenting an empty history as fact. */
        const { data: ledgerData, error: ledgerError } = await supabase
          .from('diamond_transactions')
          .select('id, type, transaction_type, amount, description, balance_after, created_at')
          .eq('user_id', requestedUserId)
          .order('created_at', { ascending: false })
          .limit(10);

        if (!isCurrent()) return;
        if (ledgerError) {
          reportError(ledgerError, 'VIPPage.Diamond_activity_load_failed', {
            userId: requestedUserId,
          });
          setRecentDiamondActivities([]);
          setDiamondActivityState('error');
        } else if (ledgerData) {
          const mapped = ledgerData.map((entry) => {
            const amount = Number(entry.amount ?? 0);
            const kind = entry.transaction_type || entry.type || '';
            return {
              id: entry.id,
              date: new Date(entry.created_at),
              action: amount > 0 ? 'earned' : 'spent',
              description:
                entry.description || kind || (amount > 0 ? 'Diamonds Earned' : 'Diamonds Spent'),
              diamonds: Math.abs(amount),
              balanceAfter: Number(entry.balance_after ?? 0),
            } as DiamondActivity;
          });
          setRecentDiamondActivities(mapped);
          setDiamondActivityState('ready');
        } else {
          setRecentDiamondActivities([]);
          setDiamondActivityState('ready');
        }
      } catch {
        if (isCurrent()) {
          setRecentDiamondActivities([]);
          setDiamondActivityState('error');
          toast.error('Failed To Load VIP Status');
        }
      } finally {
        if (isCurrent()) {
          setStateUserId(requestedUserId);
          setLoading(false);
        }
      }
    },
    [toast, user?.id]
  );

  useVisibilityRefresh(() => {
    if (user?.id) return loadVIPStatus();
  });

  useEffect(() => {
    loadGenerationRef.current += 1;
    purchaseRequestRef.current += 1;
    purchaseInFlightRef.current = false;
    setPurchasing(null);
    setIsVIP(false);
    setVipGrade('none');
    setVipExpiresAt(null);
    setMonthlyLimits({
      rabbitHunts: { used: 0, limit: 0 },
      timeBankSeconds: { used: 0, limit: 0 },
      emojis: { used: 0, limit: 0 },
      tags: { used: 0, limit: 0 },
      throwables: { used: 0, limit: 0 },
    });
    setDiamonds(0);
    setVipPoints({ current: 0, lifetime: 0, monthly: 0, activeStreak: 0 });
    setRecentDiamondActivities([]);
    setDiamondActivityState('loading');
    setStateUserId(undefined);
    setLoading(true);

    let isMounted = true;
    void loadVIPStatus(() => isMounted);
    return () => {
      isMounted = false;
      loadGenerationRef.current += 1;
    };
  }, [loadVIPStatus]);

  const handlePurchase = async (feature: VIPFeature) => {
    if (!user?.id || purchaseInFlightRef.current) return;

    const requestedUserId = user.id;
    const request = ++purchaseRequestRef.current;
    const isCurrent = () =>
      request === purchaseRequestRef.current && activeUserIdRef.current === requestedUserId;
    purchaseInFlightRef.current = true;
    setPurchasing(feature);
    try {
      const featureLabel = formatFeatureName(feature);
      const result = await vipService.purchaseFeature(requestedUserId, feature);
      if (!isCurrent()) return;
      if (result.success) {
        if (result.idempotent && result.granted === false) {
          toast.success(`${featureLabel} Purchase Already Processed`);
          return;
        }
        const nextBalance = Math.max(0, diamonds - result.charged);
        toast.success(`Purchased ${featureLabel} For ${result.charged} Diamonds`);
        setDiamonds(nextBalance);
        masterBus.emit('DIAMOND_BALANCE_CHANGED', {
          newBalance: nextBalance,
          delta: -result.charged,
          source: 'vip_feature_purchase',
        });

        const category =
          feature === 'emoji_pack'
            ? 'emote_pack'
            : feature === 'throwable'
              ? 'throwable'
              : feature === 'time_bank_seconds' || feature === 'auto_time_bank'
                ? 'time_bank'
                : null;
        if (category) {
          masterBus.emit('ENTITLEMENTS_CHANGED', {
            userId: requestedUserId,
            category,
            assetId: feature,
            quantity: 1,
            source: 'vip-purchase',
          });
        }
      } else if (result.alreadyOwned) {
        toast.success(`You Already Own ${featureLabel}`);
        if (feature === 'emoji_pack') {
          masterBus.emit('ENTITLEMENTS_CHANGED', {
            userId: requestedUserId,
            category: 'emote_pack',
            assetId: feature,
            source: 'vip-purchase',
          });
        }
      } else {
        toast.error(normalizeVIPPurchaseError(result.error));
      }
    } catch {
      if (isCurrent()) toast.error('Purchase Failed');
    } finally {
      if (isCurrent()) {
        purchaseInFlightRef.current = false;
        setPurchasing(null);
      }
    }
  };

  if (loading || stateUserId !== user?.id) {
    return (
      <div className="vip-page">
        <RewardsSurfaceHeader
          eyebrow="Rewards Circuit / VIP"
          title="VIP Command Deck"
          description="Track Live Membership Status, Review Earned Privileges, And Redeem VIP Rewards Through The Existing Protected Reward Services."
          art="vip"
          status="VIP TELEMETRY // SYNCING"
          crest="vip"
          metrics={[
            { label: 'Current Points', value: 'Syncing', tone: 'attention' },
            { label: 'Monthly', value: 'Syncing', tone: 'live' },
            { label: 'Active Streak', value: 'Syncing' },
          ]}
        />
        <div className="loading-state">
          <PageSkeleton variant="stats" />
        </div>
      </div>
    );
  }

  return (
    <div className="vip-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / VIP"
        title="VIP Command Deck"
        description="Track Live Membership Status, Review Earned Privileges, And Redeem VIP Rewards Through The Existing Protected Reward Services."
        art="vip"
        status="VIP TELEMETRY // LIVE"
        crest="vip"
        metrics={[
          { label: 'Current Points', value: vipPoints.current.toLocaleString(), tone: 'attention' },
          { label: 'Monthly', value: vipPoints.monthly.toLocaleString(), tone: 'live' },
          { label: 'Active Streak', value: `${vipPoints.activeStreak} Days` },
        ]}
      />
      {/* MEMBERSHIP, ALLOWANCES, POINTS.
          Replaces VIPStatsHeader + TierProgressionCard + VIPBenefitsGrid, all
          three deleted with src/constants/vipTiers.ts on 2026-09-05. See the
          header of VIPMembershipPlate for what those three were promising. */}
      {vipEntranceComplete && (
        <VIPMembershipPlate
          status={vipGrade}
          expiresAt={vipExpiresAt}
          limits={monthlyLimits}
          points={vipPoints}
        />
      )}

      {/* Rewards Marketplace */}
      {vipEntranceComplete && (
        <RewardsMarketplace
          currentPoints={vipPoints.current}
          onRedeem={async (reward: Reward) => {
            if (!user?.id) {
              toast.error('Please Sign In To Redeem Rewards.');
              return;
            }
            // Real spend AND a real grant. `p_reward_id` is what makes this
            // honest: without it the RPC charged whatever `p_cost` the browser
            // sent (so a 5,000-point pass cost one point) and granted nothing
            // at all. With it, vip_reward_catalog prices the reward and the
            // cosmetic lands in the live entitlement ledgers. p_cost is still
            // sent for the audit trail; the server ignores it for catalog
            // rewards. Migration 20260825_vip_reward_catalog.
            const { data, error } = await supabase.rpc('fn_redeem_vip_points', {
              p_cost: reward.pointsCost,
              p_reason: `Reward: ${reward.name}`,
              p_reward_id: reward.id,
            });
            // Refusals come back as `{ success: false, error }` with NO
            // postgres error, so both halves must be checked.
            if (error || !data?.success) {
              toast.error(
                data?.error === 'insufficient_points'
                  ? 'Not Enough VIP Points For This Reward.'
                  : data?.error === 'already_owned'
                    ? 'You Already Own This Reward.'
                    : data?.error === 'sold_out'
                      ? 'That Reward Is Sold Out.'
                      : 'Redemption Failed. Please Try Again.'
              );
              return;
            }
            setVipPoints((prev) => ({ ...prev, current: Number(data.balance ?? prev.current) }));
            if (data.status === 'granted') {
              const granted = data.granted as
                | { type?: string; theme_id?: string; avatar_id?: string }
                | undefined;
              masterBus.emit('COSMETIC_OWNERSHIP_CHANGED', {
                userId: user.id,
                category: granted?.type === 'avatar' ? 'avatar' : 'theme_id',
                assetId: granted?.avatar_id || granted?.theme_id,
                source: 'vip-reward',
              });
              masterBus.emit('ENTITLEMENTS_CHANGED', {
                userId: user.id,
                category: granted?.type === 'avatar' ? 'avatar' : 'table_skin',
                assetId: granted?.avatar_id || granted?.theme_id,
                source: 'vip-reward',
              });
            }
            // Say what actually happened: a cosmetic is yours now, a physical
            // or tournament reward still needs somebody to fulfil it.
            toast.success(
              data.status === 'granted'
                ? `Unlocked: ${reward.name}`
                : `Claimed: ${reward.name}. Your Club Will Fulfil This.`
            );
          }}
        />
      )}

      {/* Activity History */}
      {vipEntranceComplete && (
        <VIPActivityHistory
          activities={recentDiamondActivities}
          state={diamondActivityState}
          onRetry={() => void loadVIPStatus()}
        />
      )}

      {/* THE CARD, AND ONLY WHAT IT ACTUALLY BUYS.
          Was headed "VIP Diamond" over a "Diamond Member" label in #ffd700 on a
          gold-glow card - three names for a membership that has two (Dan
          2026-09-04), in a colour outside the schema (Dan 2026-09-05).

          Three of the eight perks it listed did not say a true thing, checked
          against feature_pricing, fn_purchase_feature and the engine:

            "+6% Score Boost"             nothing in either repo applies a
                                          scoring boost of any kind
            "All Packs" emojis            the allowance is 1,200 a month
            "Unlimited" offline protection  the word Dan struck; it is
                                          included, which is a different claim

          A FOURTH WAS TRUE AND I CUT IT ANYWAY. "500 Free Throws Per Month" is
          real: fn_use_throwable counts this calendar month's rows in
          `throw_usage` and charges the 1-diamond price only from the 501st. I
          removed it on the strength of `feature_pricing.throwable
          .vip_tiers_included` being empty - a column that is read by NOTHING.
          Restored the same day, and metered on the plate above rather than
          asserted here. The lesson is in the law: an empty column is not an
          absent feature, and the enforcement is whatever the function does.

          Ordinary VIP remains metered at those server-backed caps. The exact
          Lifetime membership branches to its separately enforced unlimited
          gameplay and cataloged digital-cosmetic contract. */}
      {isVIP && (
        <section
          className="vip-section vip-card-section"
          style={{
            opacity: vipEntranceComplete ? 1 : 0,
            transform: vipEntranceComplete ? 'translateY(0)' : 'translateY(12px)',
            transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <h3>Your Card</h3>
          <div className="vip-card-active">
            <div className="vip-card-art">
              <img
                /* /vip-card.webp does not exist at the hub root and 404d in
                   production. The real asset is images/vip-card.png, which is
                   what GlobalHeader already uses; BASE_URL keeps it correct
                   under the /hub/club-arena/ base path. */
                src={`${MEDIA_BASE}images/vip-card.png`}
                alt="VIP Card"
                className="vip-card-image"
              />
            </div>
            <div className="vip-card-info">
              <span className="vip-card-tier">
                {vipGrade === 'lifetime' ? 'Lifetime VIP' : 'VIP'}
              </span>
              <span className="vip-card-expiry">
                {vipGrade === 'lifetime'
                  ? 'Never Expires'
                  : vipExpiresAt
                    ? `Renews ${vipExpiresAt.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}`
                    : 'Active'}
              </span>
            </div>
            <button className="vip-extend-btn" onClick={() => setShowInfoModal(true)}>
              View Benefits
            </button>
          </div>

          <VIPPerksGrid perks={membershipPerks} />
        </section>
      )}

      {/* Diamond Balance */}
      <section className="vip-section">
        <div className="diamond-balance">
          <div className="diamond-balance__identity">
            <img
              className="diamond-balance__icon"
              src={`${MEDIA_BASE}images/diamond-icon.webp`}
              alt=""
              aria-hidden="true"
            />
            <div className="diamond-balance__copy">
              <span className="diamond-count">{diamonds.toLocaleString()}</span>
              <span className="diamond-label">Diamonds</span>
            </div>
          </div>
          <div className="diamond-balance__actions">
            <button
              className="diamond-buy-btn diamond-buy-btn--primary"
              onClick={() => setShowTopUpModal(true)}
            >
              Buy Diamonds
            </button>
            <button
              className="diamond-buy-btn diamond-buy-btn--secondary"
              onClick={() => setShowDiamondHistory(true)}
            >
              View History
            </button>
          </div>
        </div>
      </section>

      {/* A-la-Carte Purchases */}
      {!isVIP && (
        <section className="vip-section">
          <h3>Buy Features</h3>
          <p className="section-desc">
            Not A Member? Purchase Features Individually With Diamonds.
          </p>

          <div className="purchase-grid">
            {Object.entries(FEATURE_PRICING)
              // A generic "theme_unlock" does not identify a theme and cannot
              // issue a usable entitlement. Themes are bought/redeemed from
              // Table Studio and the rewards catalog, where the exact preset
              // bundle is part of the server-side SKU.
              // "club_creation" sells nothing: see docs/handoffs/club-arena-product-completion/.
              .filter(
                ([feature, pricing]) =>
                  feature !== 'theme_unlock' && feature !== 'club_creation' && pricing.cost > 0
              )
              .map(([feature, pricing]) => (
                <div key={feature} className="purchase-card">
                  <div className="purchase-info">
                    <span className="purchase-name">{formatFeatureName(feature)}</span>
                    <span className="purchase-desc">{formatPopupText(pricing.description)}</span>
                  </div>
                  <div className="purchase-action">
                    <span className="purchase-cost">{pricing.cost} Diamonds</span>
                    <button
                      className="purchase-btn"
                      onClick={() => handlePurchase(feature as VIPFeature)}
                      disabled={purchasing === feature || diamonds < pricing.cost}
                    >
                      {purchasing === feature ? 'Processing' : 'Buy'}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Info Modal */}
      <VIPCardsModal
        isOpen={showInfoModal}
        onClose={() => setShowInfoModal(false)}
        vipStatus={vipGrade}
      />

      {/* Diamond Top-Up Modal */}
      <DiamondTopUpModal
        isOpen={showTopUpModal}
        onClose={() => setShowTopUpModal(false)}
        onPurchaseComplete={(newBal) => setDiamonds(newBal)}
      />

      {/* Diamond Wallet History Modal */}
      <DiamondWalletModal
        isOpen={showDiamondHistory}
        onClose={() => setShowDiamondHistory(false)}
        onBuyClick={() => {
          setShowDiamondHistory(false);
          setShowTopUpModal(true);
        }}
      />
    </div>
  );
}
