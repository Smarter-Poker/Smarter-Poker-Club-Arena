/**
 *  VIP PAGE — VIP Tier Progression, Benefits, and Rewards Marketplace
 */

import { useState, useEffect, useMemo, useRef } from 'react';
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
            if (newData.xp !== undefined) {
              setVipPoints((prev) => ({
                ...prev,
                current: newData.xp,
                lifetime: Math.max(prev.lifetime, newData.xp),
              }));
            }
          }
        )
        .subscribe();

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
        .select('diamonds, xp, created_at')
        .eq('id', user.id)
        .maybeSingle();

      if (getIsMounted && !getIsMounted()) return;
      setDiamonds(profData?.diamonds || 0);

      const currentPts = profData?.xp || 0;
      setVipPoints((prev) => ({
        ...prev,
        current: currentPts,
        lifetime: currentPts,
      }));

      if (profData?.created_at) {
        const joinDate = new Date(profData.created_at).getTime();
        const daysSinceJoined = Math.floor((Date.now() - joinDate) / (1000 * 60 * 60 * 24));
        setDaysSinceReview(daysSinceJoined % 30);
      }

      const { data: ledgerData } = await supabase
        .from('diamond_ledger')
        .select('id, amount, description, transaction_type, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);

      if (getIsMounted && !getIsMounted()) return;
      if (ledgerData) {
        let runningBalance = currentPts;
        const mapped = ledgerData.map((entry) => {
          const bal = runningBalance;
          runningBalance -= entry.amount;

          return {
            id: entry.id,
            date: new Date(entry.created_at),
            action: entry.amount > 0 ? 'earned' : 'spent',
            description: entry.description || entry.transaction_type,
            points: Math.abs(entry.amount),
            balanceAfter: bal,
            icon: entry.amount > 0 ? '⭐' : '💸',
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
          onRedeem={(reward: Reward) => {
            setVipPoints((prev) => ({
              ...prev,
              current: prev.current - reward.pointsCost,
            }));
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
                src="/vip-card.webp"
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
                icon: '🐰',
                title: 'Rabbit Hunt',
                description: 'See undealt cards',
                value: 'Unlimited',
              },
              {
                id: 'timebank',
                icon: '⏱️',
                title: 'Time Bank',
                description: `${VIP_GOLD_LIMITS.timeBankSeconds}s free per month`,
                value: `${VIP_GOLD_LIMITS.timeBankSeconds}s`,
              },
              {
                id: 'throwable',
                icon: '💣',
                title: 'Throwables',
                description: '500 free throws per month',
                value: '500/mo',
              },
              {
                id: 'offline',
                icon: '🛡️',
                title: 'Offline Protection',
                description: 'Unlimited timeout protection',
                value: 'Unlimited',
              },
              {
                id: 'autobank',
                icon: '⏱️',
                title: 'Auto Time Bank',
                description: 'Automatic time bank usage',
                value: 'Free',
              },
              {
                id: 'themes',
                icon: '🎨',
                title: 'Themes',
                description: `${VIP_GOLD_LIMITS.themes} premium themes`,
                value: `${VIP_GOLD_LIMITS.themes}`,
              },
              {
                id: 'boost',
                icon: '📊',
                title: 'Leaderboard Boost',
                description: `${(VIP_GOLD_LIMITS.leaderboardBoost * 100).toFixed(0)}% score boost`,
                value: `+${(VIP_GOLD_LIMITS.leaderboardBoost * 100).toFixed(0)}%`,
              },
              {
                id: 'emojis',
                icon: '😀',
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
            📜 History
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
                    <span className="purchase-cost">{pricing.cost} 💎</span>
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
