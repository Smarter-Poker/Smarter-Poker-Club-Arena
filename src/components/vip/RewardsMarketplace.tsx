/**
 * RewardsMarketplace - Spend VIP points on exclusive rewards
 * Categorized rewards with filtering, sorting, and redemption
 *
 * ── 2026-08-25, cosmetics purchase/ownership audit ──────────────────────────
 * This component was a storefront with no shop behind it. `handleRedeem` did:
 *
 *     await new Promise((resolve) => setTimeout(resolve, 800));  // fake work
 *     if (onRedeem) { onRedeem(reward); }                        // NOT awaited
 *     toast.success(`Successfully redeemed ${reward.name}!`);    // always
 *
 * so the member was told the redemption succeeded before the parent's RPC had
 * even resolved, and again when it had REFUSED - VIPPage's own error toast
 * ("Not enough VIP points") landed next to a success toast for the same click.
 *
 * The original twelve rewards were also hardcoded HERE, while the redemption RPC took
 * the price FROM THE CLIENT, so a 5,000-point pass could be bought for one
 * point; and redemption granted nothing at all, so 2,000 points spent on a
 * table theme bought a ledger line and no theme.
 *
 * Now: `vip_reward_catalog` prices every reward server-side and
 * fn_redeem_vip_points grants themes into the category-specific Table Studio
 * ledger and avatar art/styles into avatar_unlocks. The list below survives only as the
 * offline fallback, and the outcome toast belongs to whoever actually performed
 * the redemption.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../common/Toast';
import AvatarCosmetics from '../avatars/AvatarCosmetics';
import { resolveCosmetic } from '../../cosmetics/avatarCosmetics';
import { supabase } from '../../lib/supabase';
import { normalizeThemePresetId, resolveSkin } from '../../lib/tableTheme';
import { reportError } from '../../utils/errorReporter';
import { formatPopupText } from '../../utils/popupStyle';
import './RewardsMarketplace.css';

const REWARD_AVATAR_PREVIEW = `${import.meta.env.BASE_URL}default-avatar.png`;

export interface Reward {
  id: string;
  name: string;
  description: string;
  category: 'tournament' | 'avatar' | 'theme' | 'bonus' | 'merch';
  pointsCost: number;
  grantType: 'theme' | 'avatar' | 'manual';
  grantRef?: string;
  imageUrl?: string;
  stock?: number;
  featured?: boolean;
}

/**
 * OFFLINE FALLBACK ONLY. `vip_reward_catalog` is the price. The prices match
 * the original catalog seed, while the cosmetic references match the later
 * entitlement-delivery migration that made each grant renderable. A failed
 * catalog read therefore shows a useful bundled list, but the server still
 * re-decides the charge and grant from the reward id. A stale entry here can
 * misinform a member and can never mischarge one.
 */
const FALLBACK_REWARDS: Reward[] = [
  {
    id: 'avatar-gold-frame',
    name: 'Gold Avatar Frame',
    description: 'Exclusive Gold Avatar Frame',
    category: 'avatar',
    pointsCost: 1500,
    grantType: 'avatar',
    grantRef: 'frame_gold',
    featured: true,
  },
  {
    id: 'theme-neon',
    name: 'Neon Table Theme',
    description: 'Vibrant Neon-Style Table Theme',
    category: 'theme',
    pointsCost: 2000,
    grantType: 'theme',
    grantRef: 'neon-blue',
  },
  {
    id: 'avatar-royal-crown',
    name: 'Hellfire Avatar Frame',
    description: 'Animated Premium Hellfire Avatar Frame',
    category: 'avatar',
    pointsCost: 2500,
    grantType: 'avatar',
    grantRef: 'frame_hellfire',
  },
  {
    id: 'theme-midnight',
    name: 'Midnight Casino Theme',
    description: 'Dark Elegant Casino-Inspired Theme',
    category: 'theme',
    pointsCost: 1800,
    grantType: 'theme',
    grantRef: 'carbon-ion',
  },
  {
    id: 'avatar-diamond-halo',
    name: 'Diamond Avatar Frame',
    description: 'Premium Faceted Diamond Avatar Frame',
    category: 'avatar',
    pointsCost: 3000,
    grantType: 'avatar',
    grantRef: 'frame_diamond',
  },
  {
    id: 'theme-cosmic',
    name: 'Cosmic Space Theme',
    description: 'Futuristic Space-Themed Table',
    category: 'theme',
    pointsCost: 2200,
    grantType: 'theme',
    grantRef: 'amethyst-night',
  },
];

type SortOption = 'price-low' | 'price-high' | 'popular' | 'new';
type CategoryFilter = 'all' | 'tournament' | 'avatar' | 'theme' | 'bonus' | 'merch';

interface RewardsMarketplaceProps {
  currentPoints: number;
  /**
   * Performs the redemption and OWNS THE OUTCOME MESSAGE. It must resolve only
   * once the server has answered; this component awaits it and says nothing
   * about success on its own.
   */
  onRedeem?: (reward: Reward) => void | Promise<void>;
}

interface CatalogRow {
  id: string;
  name: string;
  description: string;
  category: Reward['category'];
  points_cost: number;
  stock: number | null;
  featured: boolean;
  grant_type: 'theme' | 'avatar' | 'manual';
  grant_ref: string | null;
}

function RewardPreview({ reward, featured = false }: { reward: Reward; featured?: boolean }) {
  const [themePreviewFailed, setThemePreviewFailed] = useState(false);
  const themeId = reward.grantType === 'theme' ? normalizeThemePresetId(reward.grantRef) : null;
  const frame = reward.grantType === 'avatar' ? resolveCosmetic(reward.grantRef, 'frame') : null;

  if (themeId && !themePreviewFailed) {
    return (
      <div
        className={`reward-preview reward-preview--theme ${featured ? 'reward-preview--featured' : ''}`}
      >
        <img
          src={resolveSkin(themeId)}
          alt=""
          aria-hidden="true"
          className="reward-preview__theme-art"
          draggable={false}
          decoding="async"
          onError={() => setThemePreviewFailed(true)}
        />
        <span className="reward-preview__caption">Table Skin Preview</span>
      </div>
    );
  }

  if (frame) {
    return (
      <div
        className={`reward-preview reward-preview--avatar ${featured ? 'reward-preview--featured' : ''}`}
      >
        <span className="reward-preview__avatar" aria-hidden="true">
          <img
            src={REWARD_AVATAR_PREVIEW}
            alt=""
            className="reward-preview__avatar-art"
            draggable={false}
            decoding="async"
          />
          <AvatarCosmetics frame={frame.id} still />
        </span>
        <span className="reward-preview__caption">
          {formatPopupText(`${frame.label} Frame Preview`)}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`reward-preview reward-preview--unavailable ${featured ? 'reward-preview--featured' : ''}`}
    >
      <span>Preview Unavailable</span>
    </div>
  );
}

export const RewardsMarketplace: React.FC<RewardsMarketplaceProps> = ({
  currentPoints,
  onRedeem,
}) => {
  const toast = useToast();
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('popular');
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  // A ref, not the state flag: state is invisible to a second handler firing in
  // the same tick, and this one spends points.
  const inFlightRef = useRef(false);
  const [rewards, setRewards] = useState<Reward[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadCatalog = useCallback(async () => {
    const { data, error } = await supabase
      .from('vip_reward_catalog')
      .select(
        'id, name, description, category, points_cost, stock, featured, grant_type, grant_ref'
      )
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) {
      // A failed read is not an empty catalog. Show the bundled list and say
      // it is the bundled list, rather than "No Rewards In This Category Yet".
      reportError(error, 'RewardsMarketplace.loadCatalog');
      setRewards(FALLBACK_REWARDS);
      setLoadFailed(true);
      return;
    }
    setRewards(
      ((data || []) as CatalogRow[])
        // Manual rewards had no fulfillment surface. A paid claim that merely
        // says “someone will handle it” is not a functioning product.
        .filter((row) => row.grant_type === 'theme' || row.grant_type === 'avatar')
        .map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          category: row.category,
          pointsCost: Number(row.points_cost),
          grantType: row.grant_type,
          grantRef: row.grant_ref || undefined,
          stock: row.stock ?? undefined,
          featured: row.featured,
        }))
    );
    setLoadFailed(false);
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const REWARDS = rewards ?? FALLBACK_REWARDS;

  const filteredRewards = useMemo(() => {
    let filtered = REWARDS;

    // Filter by category
    if (activeCategory !== 'all') {
      filtered = filtered.filter((r) => r.category === activeCategory);
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'price-low':
          return a.pointsCost - b.pointsCost;
        case 'price-high':
          return b.pointsCost - a.pointsCost;
        case 'popular':
          return (b.stock || 1000) - (a.stock || 1000);
        case 'new':
          return 0; // Maintain original order for "new"
        default:
          return 0;
      }
    });

    return sorted;
  }, [REWARDS, activeCategory, sortBy]);

  const featuredReward = REWARDS.find((r) => r.featured);
  const categories = [
    { id: 'all', label: 'All Rewards', count: REWARDS.length },
    {
      id: 'tournament',
      label: 'Tournaments',
      count: REWARDS.filter((r) => r.category === 'tournament').length,
    },
    {
      id: 'avatar',
      label: 'Avatar Items',
      count: REWARDS.filter((r) => r.category === 'avatar').length,
    },
    {
      id: 'theme',
      label: 'Table Themes',
      count: REWARDS.filter((r) => r.category === 'theme').length,
    },
    {
      id: 'bonus',
      label: 'Bonus Cash',
      count: REWARDS.filter((r) => r.category === 'bonus').length,
    },
    { id: 'merch', label: 'Merch', count: REWARDS.filter((r) => r.category === 'merch').length },
  ].filter((category) => category.id === 'all' || category.count > 0);

  const handleRedeem = async (reward: Reward) => {
    if (inFlightRef.current) return;
    if (currentPoints < reward.pointsCost) {
      toast.error(
        `You Need ${(reward.pointsCost - currentPoints).toLocaleString()} More Points ` +
          'To Redeem This Reward.'
      );
      return;
    }
    if (!onRedeem) {
      // Nothing can perform the redemption, so nothing may claim it happened.
      toast.error('Redeeming Is Not Available Right Now.');
      return;
    }

    inFlightRef.current = true;
    setRedeemingId(reward.id);
    try {
      // AWAITED, and NO SUCCESS TOAST HERE. The handler talks to the server and
      // reports what the server said; a second, unconditional "Successfully
      // redeemed" from this component is how a refusal got announced as a sale.
      await onRedeem(reward);
      // The server may have decremented stock or granted the cosmetic, so the
      // catalog this component is showing is now stale.
      await loadCatalog();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Redemption Failed');
      reportError(err, 'RewardsMarketplace.handleRedeem');
    } finally {
      inFlightRef.current = false;
      setRedeemingId(null);
    }
  };

  const canRedeem = (reward: Reward) => currentPoints >= reward.pointsCost;
  const isOutOfStock = (reward: Reward) => reward.stock !== undefined && reward.stock === 0;

  return (
    <div className="rewards-marketplace">
      {/* Header */}
      <div className="marketplace-header">
        <div>
          <h3>Rewards Marketplace</h3>
          <p>Spend Your VIP Points On Exclusive Rewards</p>
        </div>
        <div className="points-balance">
          <span className="points-balance__copy">
            <span className="balance-label">Your Points</span>
            <span className="balance-value">{currentPoints.toLocaleString()}</span>
          </span>
        </div>
      </div>

      {/* Featured Reward */}
      {featuredReward && (
        <div className="featured-reward">
          <div className="featured-badge">Featured</div>
          <div className="featured-content">
            <RewardPreview reward={featuredReward} featured />
            <div className="featured-info">
              <h4>{formatPopupText(featuredReward.name)}</h4>
              <p>{formatPopupText(featuredReward.description)}</p>
              <div className="featured-meta">
                <span className="points-cost">
                  {featuredReward.pointsCost.toLocaleString()} Points
                </span>
                {featuredReward.stock && (
                  <span className="stock-count">{featuredReward.stock} Available</span>
                )}
              </div>
            </div>
            <button
              className={`featured-redeem-btn ${
                !canRedeem(featuredReward) ? 'disabled' : ''
              } ${redeemingId === featuredReward.id ? 'redeeming' : ''}`}
              onClick={() => handleRedeem(featuredReward)}
              disabled={
                !canRedeem(featuredReward) ||
                redeemingId === featuredReward.id ||
                isOutOfStock(featuredReward)
              }
            >
              {redeemingId === featuredReward.id ? 'Redeeming' : 'Redeem'}
            </button>
          </div>
        </div>
      )}

      {/* Category Tabs */}
      <div className="category-tabs" role="group" aria-label="Filter Rewards By Category">
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`category-tab ${activeCategory === cat.id ? 'active' : ''}`}
            aria-pressed={activeCategory === cat.id}
            onClick={() => setActiveCategory(cat.id as CategoryFilter)}
          >
            <span className="tab-label">{cat.label}</span>
            <span className="tab-count">{cat.count}</span>
          </button>
        ))}
      </div>

      {/* Sorting Options */}
      <div className="sorting-controls">
        <label htmlFor="sort-select">Sort By:</label>
        <select
          id="sort-select"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortOption)}
          className="sort-select"
        >
          <option value="popular">Most Popular</option>
          <option value="price-low">Price: Low To High</option>
          <option value="price-high">Price: High To Low</option>
          <option value="new">Newest</option>
        </select>
      </div>

      {/* Rewards Grid */}
      <div className="rewards-grid">
        {filteredRewards.length > 0 ? (
          filteredRewards.map((reward) => (
            <div
              key={reward.id}
              className={`reward-card ${canRedeem(reward) ? 'available' : 'insufficient'} ${
                isOutOfStock(reward) ? 'out-of-stock' : ''
              }`}
            >
              {isOutOfStock(reward) && <div className="out-of-stock-overlay">Out Of Stock</div>}

              <RewardPreview reward={reward} />

              <div className="reward-info">
                <h4 className="reward-name">{formatPopupText(reward.name)}</h4>
                <p className="reward-desc">{formatPopupText(reward.description)}</p>

                <div className="reward-footer">
                  <div className="reward-meta">
                    <span className="points-cost">{reward.pointsCost.toLocaleString()} Pts</span>
                    {reward.stock ? (
                      <span className="stock-badge">{reward.stock.toLocaleString()} Left</span>
                    ) : null}
                  </div>

                  <button
                    className={`redeem-btn ${redeemingId === reward.id ? 'redeeming' : ''}`}
                    onClick={() => handleRedeem(reward)}
                    disabled={
                      !canRedeem(reward) || redeemingId === reward.id || isOutOfStock(reward)
                    }
                  >
                    {redeemingId === reward.id ? 'Redeeming' : 'Redeem'}
                  </button>
                </div>
              </div>
            </div>
          ))
        ) : rewards === null ? (
          <div className="no-rewards">
            <p>Loading Rewards...</p>
          </div>
        ) : (
          <div className="no-rewards">
            {/* A read that failed is a different statement from a category
                that is empty, and this told the member the second one. */}
            <p>
              {loadFailed ? 'Could Not Load Rewards Right Now' : 'No Rewards In This Category Yet'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default RewardsMarketplace;
