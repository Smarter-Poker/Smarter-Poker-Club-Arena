/**
 *  VIP PAGE — VIP Tier Progression, Benefits, and Rewards Marketplace
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { MEDIA_BASE } from '../utils/mediaBase';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import {
  vipService,
  VIP_MONTHLY_ALLOWANCES,
  FEATURE_PRICING,
  type VIPFeature,
  type VIPMonthlyLimits,
} from '../services/VIPService';
import type { VipStatus } from '../utils/vipStatus';
import { VIPCardsModal } from '../components/vip/VIPCardsModal';
import { VIPPerksGrid } from '../components/vip/VIPPerksGrid';
import { DiamondTopUpModal } from '../components/vip/DiamondTopUpModal';
import { VIPMembershipPlate } from '../components/vip/VIPMembershipPlate';
import { RewardsMarketplace, Reward } from '../components/vip/RewardsMarketplace';
import { VIPActivityHistory, VIPActivity } from '../components/vip/VIPActivityHistory';
import { useToast } from '../components/common/Toast';
import DiamondWalletModal from '../components/wallet/DiamondWalletModal';
import './VIPPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';

export default function VIPPage() {
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(() => {
    if (user?.id) loadVIPStatus();
  });

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
  });
  const [diamonds, setDiamonds] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showTopUpModal, setShowTopUpModal] = useState(false);
  const [showDiamondHistory, setShowDiamondHistory] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  // React state is not synchronous: two taps in the same frame can both see
  // `purchasing === null`. This ref closes that mobile double-tap window before
  // the first network request leaves the device.
  const purchaseInFlightRef = useRef(false);
  const [vipEntranceComplete, setVIPEntranceComplete] = useState(false);

  // VIP Points System
  const [vipPoints, setVipPoints] = useState({
    current: 0,
    lifetime: 0,
    monthly: 0,
    activeStreak: 0,
  });

  const [recentActivities, setRecentActivities] = useState<VIPActivity[]>([]);
  const [daysSinceReview, setDaysSinceReview] = useState(0);

  // VIP entrance animation
  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => setVIPEntranceComplete(true), 200);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  useEffect(() => {
    let isMounted = true;
    loadVIPStatus(() => isMounted);

    // Real-time profile updates (diamonds, VIP status): NOT subscribed here.
    //
    // 2026-08-24: a `vip-status` channel used to live here carrying a single
    // `profiles` (id=eq.<uid>) listener that did setDiamonds(payload.new.diamonds).
    // PostgresSyncHooks' `global_db_sync:<userId>` channel already carries that
    // exact listener - same table, same filter - created once at sign-in and
    // never torn down by navigation. When profiles.diamonds changes it emits
    // DIAMOND_BALANCE_CHANGED carrying { newBalance }, and the bus subscriber
    // further down this file already does setDiamonds(newBalance) from exactly
    // that payload.
    //
    // The whole channel is removed rather than just the listener: it had no
    // other `.on()`, so keeping it would have left a Realtime subscription that
    // listens to nothing, reconnects on error, and reports status for no reason.
    return () => {
      isMounted = false;
    };
  }, [user?.id]);

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

  const loadingRef = useRef(false);

  const loadVIPStatus = async (getIsMounted?: () => boolean) => {
    if (!user?.id) {
      if (!getIsMounted || getIsMounted()) setLoading(false);
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;

    if (!getIsMounted || getIsMounted()) setLoading(true);
    try {
      const vipStatus = await vipService.checkVIPStatus(user.id);
      if (getIsMounted && !getIsMounted()) return;
      setIsVIP(vipStatus.isVIP);
      setVipGrade(vipStatus.status);
      setVipExpiresAt(vipStatus.expiresAt);
      setMonthlyLimits(vipStatus.monthlyLimits);

      const { data: profData } = await supabase
        .from('profiles')
        .select('diamonds, created_at')
        .eq('id', user.id)
        .maybeSingle();

      if (getIsMounted && !getIsMounted()) return;
      setDiamonds(profData?.diamonds || 0);

      // Real VIP points (accrued from rake generated). vip_points is per-user,
      // RLS-scoped to the owner.
      const { data: vp } = await supabase
        .from('vip_points')
        .select('current_points, lifetime_points')
        .eq('user_id', user.id)
        .maybeSingle();
      setVipPoints((prev) => ({
        ...prev,
        current: Number(vp?.current_points || 0),
        lifetime: Number(vp?.lifetime_points || 0),
      }));

      if (profData?.created_at) {
        const joinDate = new Date(profData.created_at).getTime();
        const daysSinceJoined = Math.floor((Date.now() - joinDate) / (1000 * 60 * 60 * 24));
        setDaysSinceReview(daysSinceJoined % 30);
      }

      // BUG 024 FIX (2026-04-16): diamond_ledger columns are (id, user_id, delta, type, balance_after, created_at).
      // Previously queried non-existent columns (amount, description, transaction_type) → always got empty or failed.
      // Map delta → amount and type → description. balance_after is now read from DB (authoritative) so we don't
      // reconstruct the running balance via subtraction (which drifted when rows were missed).
      const { data: ledgerData } = await supabase
        .from('diamond_ledger')
        .select('id, delta, type, balance_after, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);

      if (getIsMounted && !getIsMounted()) return;
      if (ledgerData) {
        const mapped = ledgerData.map((entry) => {
          const delta = Number(entry.delta ?? 0);
          return {
            id: entry.id,
            date: new Date(entry.created_at),
            action: delta > 0 ? 'earned' : 'spent',
            description: entry.type || (delta > 0 ? 'Diamonds Earned' : 'Diamonds Spent'),
            points: Math.abs(delta),
            balanceAfter: Number(entry.balance_after ?? 0),
            // Unicode triangles (allowed per CLAUDE.md §8) instead of the previous emojis
            icon: delta > 0 ? '▲' : '▼',
          } as VIPActivity;
        });
        setRecentActivities(mapped);
      }
    } catch (error) {
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load VIP status');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  const handlePurchase = async (feature: VIPFeature) => {
    if (!user?.id || purchaseInFlightRef.current) return;

    purchaseInFlightRef.current = true;
    setPurchasing(feature);
    try {
      const result = await vipService.purchaseFeature(user.id, feature);
      if (result.success) {
        const nextBalance = Math.max(0, diamonds - result.charged);
        toast.success(`Purchased ${feature.replace(/_/g, ' ')} for ${result.charged} Diamonds`);
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
            userId: user.id,
            category,
            assetId: feature,
            quantity: 1,
            source: 'vip-purchase',
          });
        }
      } else if (result.alreadyOwned) {
        toast.success(`You already own ${feature.replace(/_/g, ' ')}`);
        if (feature === 'emoji_pack') {
          masterBus.emit('ENTITLEMENTS_CHANGED', {
            userId: user.id,
            category: 'emote_pack',
            assetId: feature,
            source: 'vip-purchase',
          });
        }
      } else {
        toast.error(result.error || 'Purchase failed');
      }
    } catch (error) {
      toast.error('Purchase failed');
    } finally {
      purchaseInFlightRef.current = false;
      setPurchasing(null);
    }
  };

  if (loading) {
    return (
      <div className="vip-page">
        <RewardsSurfaceHeader
          eyebrow="Rewards Circuit / VIP"
          title="VIP Command Deck"
          description="Track Live Tier Progress, Review Earned Privileges, And Redeem VIP Rewards Through The Existing Protected Reward Services."
          art="vip"
          status="VIP TELEMETRY // SYNCING"
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
        description="Track Live Tier Progress, Review Earned Privileges, And Redeem VIP Rewards Through The Existing Protected Reward Services."
        art="vip"
        status="VIP TELEMETRY // LIVE"
        metrics={[
          { label: 'Current Points', value: vipPoints.current.toLocaleString(), tone: 'attention' },
          { label: 'Monthly', value: vipPoints.monthly.toLocaleString(), tone: 'live' },
          { label: 'Active Streak', value: `${vipPoints.activeStreak} days` },
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
      {vipEntranceComplete && <VIPActivityHistory activities={recentActivities} />}

      {/* THE CARD, AND ONLY WHAT IT ACTUALLY BUYS.
          Was headed "VIP Diamond" over a "Diamond Member" label in #ffd700 on a
          gold-glow card - three names for a membership that has two (Dan
          2026-09-04), in a colour outside the schema (Dan 2026-09-05).

          Four of the eight perks it listed were not implemented anywhere,
          checked against feature_pricing, fn_purchase_feature and the engine on
          2026-09-05:

            "500 Free Throws Per Month"   `throwable` costs 1 diamond a throw
                                          and has no VIP branch in any code path
            "Unlimited" offline protection  the word Dan struck; it is included,
                                          which is a different claim
            "All Packs" emojis            the allowance is 1,200 a month
            "+6% Score Boost"             LeaderboardService applies no boost

          What is left is what the server meters, and it now comes from the same
          VIPMembershipPlate above rather than a second hand-written list that
          could drift from it. */}
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
          <div className="vip-card-active" style={{ textAlign: 'center' }}>
            <div style={{ marginBottom: 16 }}>
              <img
                /* /vip-card.webp does not exist at the hub root and 404d in
                   production. The real asset is images/vip-card.png, which is
                   what GlobalHeader already uses; BASE_URL keeps it correct
                   under the /hub/club-arena/ base path. */
                src={`${MEDIA_BASE}images/vip-card.png`}
                alt="VIP Card"
                style={{
                  width: '100%',
                  maxWidth: 300,
                  height: 'auto',
                  borderRadius: 12,
                }}
              />
            </div>
            <div className="vip-card-info" style={{ textAlign: 'center' }}>
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

          <VIPPerksGrid
            currentTier="vip"
            perks={[
              {
                id: 'rabbit',
                icon: '\u25C6',
                title: 'Rabbit Hunt',
                description: 'See Undealt Cards',
                // Dan 2026-08-25: 100 a month, then diamonds. This said
                // "Unlimited" while the server charged from the 101st. The cap
                // lives in fn_consume_rabbit_hunt and this is the only place
                // that quotes it to a customer.
                value: `${VIP_MONTHLY_ALLOWANCES.rabbitHunts} / month`,
              },
              {
                id: 'timebank',
                icon: '\u25F7',
                title: 'Time Bank',
                description: `${VIP_MONTHLY_ALLOWANCES.timeBankSeconds}s Free Per Month`,
                value: `${VIP_MONTHLY_ALLOWANCES.timeBankSeconds}s`,
              },
              {
                id: 'emojis',
                icon: '\u25C6',
                title: 'Emojis',
                // Was "All Packs". fn_increment_vip_usage counts 'emoji_pack'
                // against exactly this number.
                description: `${VIP_MONTHLY_ALLOWANCES.emojis.toLocaleString()} Free Per Month`,
                value: VIP_MONTHLY_ALLOWANCES.emojis.toLocaleString(),
              },
              {
                id: 'tags',
                icon: '\u25C6',
                title: 'Player Tags',
                description: `${VIP_MONTHLY_ALLOWANCES.tags.toLocaleString()} Free Per Month`,
                value: VIP_MONTHLY_ALLOWANCES.tags.toLocaleString(),
              },
              {
                id: 'stack',
                icon: '\u25A6',
                title: 'Show Stack In Big Blinds',
                description: 'Otherwise 5 Diamonds Per Session',
                value: 'Included',
              },
              {
                id: 'offline',
                icon: '\u25C8',
                title: 'Offline Protection',
                description: 'Otherwise 10 Diamonds Per Session',
                value: 'Included',
              },
              {
                id: 'autobank',
                icon: '\u25F7',
                title: 'Auto Time Bank',
                description: 'Otherwise 5 Diamonds Per Activation',
                value: 'Included',
              },
            ]}
          />
        </section>
      )}

      {/* Diamond Balance */}
      <section className="vip-section">
        <div className="diamond-balance">
          {/* The glyph is IN THE MARKUP, the way Shell.tsx does it. It used to
              come from a `.diamond-icon::before { content: '◆' }` declared in
              ClubHomePage.css - a page-scoped stylesheet that is loaded
              globally, so this element rendered blank on any session that had
              not visited a club lobby, and blank permanently once that leaked
              rule was removed. */}
          <span className="diamond-icon" aria-hidden="true">
            ◆
          </span>
          <span className="diamond-count">{diamonds.toLocaleString()}</span>
          <span className="diamond-label">Diamonds</span>
          <button className="diamond-buy-btn" onClick={() => setShowTopUpModal(true)}>
            + Buy Diamonds
          </button>
          <button
            className="diamond-buy-btn"
            style={{ background: 'rgba(255,255,255,0.08)', marginLeft: '6px' }}
            onClick={() => setShowDiamondHistory(true)}
          >
            History
          </button>
        </div>
      </section>

      {/* A-la-Carte Purchases */}
      {!isVIP && (
        <section className="vip-section">
          <h3> Buy Features</h3>
          <p className="section-desc">
            Not A Member? Purchase Features Individually With Diamonds.
          </p>

          <div className="purchase-grid">
            {Object.entries(FEATURE_PRICING)
              // A generic "theme_unlock" does not identify a theme and cannot
              // issue a usable entitlement. Themes are bought/redeemed from
              // Table Studio and the rewards catalog, where the exact preset
              // bundle is part of the server-side SKU.
              .filter(([feature, pricing]) => feature !== 'theme_unlock' && pricing.cost > 0)
              .map(([feature, pricing]) => (
                <div key={feature} className="purchase-card">
                  <div className="purchase-info">
                    <span className="purchase-name">{feature.replace(/_/g, ' ')}</span>
                    <span className="purchase-desc">{pricing.description}</span>
                  </div>
                  <div className="purchase-action">
                    <span className="purchase-cost">{pricing.cost} </span>
                    <button
                      className="purchase-btn"
                      onClick={() => handlePurchase(feature as VIPFeature)}
                      disabled={purchasing === feature || diamonds < pricing.cost}
                    >
                      {purchasing === feature ? '...' : 'Buy'}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Info Modal */}
      <VIPCardsModal isOpen={showInfoModal} onClose={() => setShowInfoModal(false)} />

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
