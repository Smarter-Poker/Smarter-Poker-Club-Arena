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
  VIP_GOLD_LIMITS,
  FEATURE_PRICING,
  type VIPFeature,
} from '../services/VIPService';
import { VIPCardsModal } from '../components/vip/VIPCardsModal';
import { VIPPerksGrid } from '../components/vip/VIPPerksGrid';
import { DiamondTopUpModal } from '../components/vip/DiamondTopUpModal';
import { VIPStatsHeader } from '../components/vip/VIPStatsHeader';
import { TierProgressionCard } from '../components/vip/TierProgressionCard';
import { VIPBenefitsGrid } from '../components/vip/VIPBenefitsGrid';
import { RewardsMarketplace, Reward } from '../components/vip/RewardsMarketplace';
import { VIPActivityHistory, VIPActivity } from '../components/vip/VIPActivityHistory';
import { useToast } from '../components/common/Toast';
import DiamondWalletModal from '../components/wallet/DiamondWalletModal';
import './VIPPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { reportError } from '../utils/errorReporter';

export default function VIPPage() {
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(() => {
    if (user?.id) loadVIPStatus();
  });

  const [isVIP, setIsVIP] = useState(false);
  const [diamonds, setDiamonds] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showTopUpModal, setShowTopUpModal] = useState(false);
  const [showDiamondHistory, setShowDiamondHistory] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
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

    // Real-time profile updates (diamonds, VIP status)
    if (user?.id) {
      const channelKey = 'vip-status';

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'profiles',
            filter: `id=eq.${user.id}`,
          },
          (payload) => {
            if (!isMounted) return;
            const newData = payload.new as any;
            if (newData.diamonds !== undefined) {
              setDiamonds(newData.diamonds);
            }
            // xp has been removed
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'VIPPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[VIPPage] Realtime channel timed out');
          }
        });

      return () => {
        isMounted = false;
        masterBus.removeRegisteredChannel(channelKey);
      };
    }
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

  // Bus listener: update VIP points when awarded locally (debounced)
  useEffect(() => {
    if (!user?.id) return;
    const unsubVIP = masterBus.subscribeDebounced(
      'VIP_POINTS_UPDATED',
      (event: any) => {
        if (event?.payload?.added && event.payload.userId === user.id) {
          setVipPoints((prev) => ({
            ...prev,
            current: prev.current + event.payload.added,
            lifetime: prev.lifetime + event.payload.added,
          }));
        }
      },
      500
    );
    return unsubVIP;
  }, [user?.id]);

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
            description: entry.type || (delta > 0 ? 'Diamonds earned' : 'Diamonds spent'),
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
    if (!user?.id) return;

    setPurchasing(feature);
    try {
      const result = await vipService.purchaseFeature(user.id, feature);
      if (result.success) {
        toast.success(`Purchased ${feature} for ${result.charged} `);
        setDiamonds((prev) => prev - result.charged);
      } else {
        toast.error(result.error || 'Purchase failed');
      }
    } catch (error) {
      toast.error('Purchase failed');
    }
    setPurchasing(null);
  };

  if (loading) {
    return (
      <div className="vip-page">
        <div className="loading-state">
          <PageSkeleton variant="stats" />
        </div>
      </div>
    );
  }

  return (
    <div className="vip-page">
      {/* VIP Stats Header */}
      {vipEntranceComplete && (
        <VIPStatsHeader
          currentPoints={vipPoints.current}
          monthlyPoints={vipPoints.monthly}
          lifetimePoints={vipPoints.lifetime}
          activeStreak={vipPoints.activeStreak}
          daysSinceReview={daysSinceReview}
        />
      )}

      {/* Tier Progression Hero Section */}
      {vipEntranceComplete && (
        <TierProgressionCard
          currentPoints={vipPoints.current}
          lifetimePoints={vipPoints.lifetime}
          monthlyPoints={vipPoints.monthly}
          activeStreak={vipPoints.activeStreak}
        />
      )}

      {/* VIP Benefits Grid */}
      {vipEntranceComplete && <VIPBenefitsGrid currentPoints={vipPoints.current} />}

      {/* Rewards Marketplace */}
      {vipEntranceComplete && (
        <RewardsMarketplace
          currentPoints={vipPoints.current}
          onRedeem={async (reward: Reward) => {
            // Real spend: deduct points server-side (validates balance, records the
            // ledger entry). Only update the UI on success.
            const { data, error } = await supabase.rpc('fn_redeem_vip_points', {
              p_cost: reward.pointsCost,
              p_reason: `Reward: ${reward.name}`,
            });
            if (error || !data?.success) {
              toast.error(
                data?.error === 'insufficient_points'
                  ? 'Not enough VIP points for this reward.'
                  : 'Redemption failed. Please try again.'
              );
              return;
            }
            setVipPoints((prev) => ({ ...prev, current: Number(data.balance ?? prev.current) }));
            toast.success(`Redeemed: ${reward.name}`);
          }}
        />
      )}

      {/* Activity History */}
      {vipEntranceComplete && <VIPActivityHistory activities={recentActivities} />}

      {/* Legacy VIP Gold Status Section */}
      {isVIP && (
        <section
          className="vip-section vip-card-section"
          style={{
            opacity: vipEntranceComplete ? 1 : 0,
            transform: vipEntranceComplete ? 'translateY(0)' : 'translateY(12px)',
            transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <h3> VIP Diamond</h3>
          <div className="vip-card-active" style={{ borderColor: '#ffd700', textAlign: 'center' }}>
            {/* VIP Card Image */}
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
                  boxShadow: '0 8px 32px rgba(255, 215, 0, 0.3)',
                }}
              />
            </div>
            <div className="vip-card-info" style={{ textAlign: 'center' }}>
              <span
                className="vip-card-tier"
                style={{ color: '#ffd700', fontSize: 18, fontWeight: 700 }}
              >
                Diamond Member
              </span>
              <span className="vip-card-expiry">Included with Club Arena</span>
            </div>
            <button className="vip-extend-btn" onClick={() => setShowInfoModal(true)}>
              View Benefits
            </button>
          </div>

          {/* VIP Perks Grid */}
          <VIPPerksGrid
            currentTier="diamond"
            perks={[
              {
                id: 'rabbit',
                icon: '◆',
                title: 'Rabbit Hunt',
                description: 'See undealt cards',
                value: 'Unlimited',
              },
              {
                id: 'timebank',
                icon: '◷',
                title: 'Time Bank',
                description: `${VIP_GOLD_LIMITS.timeBankSeconds}s free per month`,
                value: `${VIP_GOLD_LIMITS.timeBankSeconds}s`,
              },
              {
                id: 'throwable',
                icon: '◆',
                title: 'Throwables',
                description: '500 free throws per month',
                value: '500/mo',
              },
              {
                id: 'offline',
                icon: '◈',
                title: 'Offline Protection',
                description: 'Unlimited timeout protection',
                value: 'Unlimited',
              },
              {
                id: 'autobank',
                icon: '◷',
                title: 'Auto Time Bank',
                description: 'Automatic time bank usage',
                value: 'Free',
              },
              {
                id: 'themes',
                icon: '◇',
                title: 'Themes',
                description: `${VIP_GOLD_LIMITS.themes} premium themes`,
                value: `${VIP_GOLD_LIMITS.themes}`,
              },
              {
                id: 'boost',
                icon: '▦',
                title: 'Leaderboard Boost',
                description: `${(VIP_GOLD_LIMITS.leaderboardBoost * 100).toFixed(0)}% score boost`,
                value: `+${(VIP_GOLD_LIMITS.leaderboardBoost * 100).toFixed(0)}%`,
              },
              {
                id: 'emojis',
                icon: '◆',
                title: 'Emojis',
                description: 'Access to all emoji packs',
                value: 'All Packs',
              },
            ]}
          />
        </section>
      )}

      {/* Diamond Balance */}
      <section className="vip-section">
        <div className="diamond-balance">
          <span className="diamond-icon"></span>
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
            Not a Diamond member? Purchase features individually with diamonds.
          </p>

          <div className="purchase-grid">
            {Object.entries(FEATURE_PRICING)
              .filter(([, pricing]) => pricing.cost > 0)
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
