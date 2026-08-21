/**
 * RewardsMarketplace — Spend VIP points on exclusive rewards
 * Categorized rewards with filtering, sorting, and redemption
 */

import React, { useState, useMemo } from 'react';
import { useToast } from '../common/Toast';
import './RewardsMarketplace.css';

export interface Reward {
  id: string;
  name: string;
  description: string;
  category: 'tournament' | 'avatar' | 'theme' | 'bonus' | 'merch';
  pointsCost: number;
  icon: string;
  imageUrl?: string;
  stock?: number;
  featured?: boolean;
}

const REWARDS: Reward[] = [
  {
    id: 'tournament-elite',
    name: 'Elite Tournament Pass',
    description: 'Entry to premium tournament series with higher payouts',
    category: 'tournament',
    pointsCost: 5000,
    icon: 'T',
    stock: 25,
    featured: true,
  },
  {
    id: 'avatar-gold-frame',
    name: 'Gold Frame Badge',
    description: 'Exclusive gold avatar frame',
    category: 'avatar',
    pointsCost: 1500,
    icon: '★',
    featured: true,
  },
  {
    id: 'theme-neon',
    name: 'Neon Table Theme',
    description: 'Vibrant neon-style table theme',
    category: 'theme',
    pointsCost: 2000,
    icon: '◆',
  },
  {
    id: 'bonus-50k',
    name: '50K Bonus Package',
    description: 'Bonus chips to use in games',
    category: 'bonus',
    pointsCost: 3500,
    icon: '→',
  },
  {
    id: 'tournament-vip',
    name: 'VIP Tournament Seat',
    description: 'Reserved seat in exclusive weekly tournament',
    category: 'tournament',
    pointsCost: 4000,
    icon: '◆',
  },
  {
    id: 'avatar-royal-crown',
    name: 'Royal Crown Badge',
    description: 'Premium royal crown avatar badge',
    category: 'avatar',
    pointsCost: 2500,
    icon: '♛',
  },
  {
    id: 'theme-midnight',
    name: 'Midnight Casino Theme',
    description: 'Dark elegant casino-inspired theme',
    category: 'theme',
    pointsCost: 1800,
    icon: '◐',
  },
  {
    id: 'bonus-25k',
    name: '25K Bonus Package',
    description: 'Bonus chips to use in games',
    category: 'bonus',
    pointsCost: 1500,
    icon: '◆',
  },
  {
    id: 'tournament-weekly',
    name: 'Weekly Tournament Bundle',
    description: 'Entry to 4 weekly tournaments',
    category: 'tournament',
    pointsCost: 2000,
    icon: '▤',
  },
  {
    id: 'avatar-diamond-halo',
    name: 'Diamond Halo Effect',
    description: 'Animated diamond halo around avatar',
    category: 'avatar',
    pointsCost: 3000,
    icon: '◆',
  },
  {
    id: 'theme-cosmic',
    name: 'Cosmic Space Theme',
    description: 'Futuristic space-themed table',
    category: 'theme',
    pointsCost: 2200,
    icon: '▲',
  },
  {
    id: 'merch-hoodie',
    name: 'Premium Hoodie',
    description: 'Limited edition branded hoodie',
    category: 'merch',
    pointsCost: 8000,
    icon: '◆',
    stock: 50,
  },
];

type SortOption = 'price-low' | 'price-high' | 'popular' | 'new';
type CategoryFilter = 'all' | 'tournament' | 'avatar' | 'theme' | 'bonus' | 'merch';

interface RewardsMarketplaceProps {
  currentPoints: number;
  onRedeem?: (reward: Reward) => void;
}

export const RewardsMarketplace: React.FC<RewardsMarketplaceProps> = ({
  currentPoints,
  onRedeem,
}) => {
  const toast = useToast();
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('popular');
  const [redeemingId, setRedeemingId] = useState<string | null>(null);

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
  }, [activeCategory, sortBy]);

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
  ];

  const handleRedeem = async (reward: Reward) => {
    if (currentPoints < reward.pointsCost) {
      toast.error(
        `You need ${reward.pointsCost - currentPoints} more points to redeem this reward.`
      );
      return;
    }

    setRedeemingId(reward.id);
    try {
      // Simulate redemption delay
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (onRedeem) {
        onRedeem(reward);
      }
      toast.success(`Successfully redeemed ${reward.name}!`);
    } finally {
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
          <span className="balance-label">Your Points</span>
          <span className="balance-value">{currentPoints.toLocaleString()}</span>
        </div>
      </div>

      {/* Featured Reward */}
      {featuredReward && (
        <div className="featured-reward">
          <div className="featured-badge">FEATURED</div>
          <div className="featured-content">
            <div className="featured-icon">{featuredReward.icon}</div>
            <div className="featured-info">
              <h4>{featuredReward.name}</h4>
              <p>{featuredReward.description}</p>
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
              className={`featured-redeem-btn ${!canRedeem(featuredReward) ? 'disabled' : ''} ${redeemingId === featuredReward.id ? 'redeeming' : ''}`}
              onClick={() => handleRedeem(featuredReward)}
              disabled={
                !canRedeem(featuredReward) ||
                redeemingId === featuredReward.id ||
                isOutOfStock(featuredReward)
              }
            >
              {redeemingId === featuredReward.id ? '...' : 'Redeem'}
            </button>
          </div>
        </div>
      )}

      {/* Category Tabs */}
      <div className="category-tabs">
        {categories.map((cat) => (
          <button
            key={cat.id}
            className={`category-tab ${activeCategory === cat.id ? 'active' : ''}`}
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
          filteredRewards.map((reward, idx) => (
            <div
              key={reward.id}
              className={`reward-card ${canRedeem(reward) ? 'available' : 'insufficient'} ${isOutOfStock(reward) ? 'out-of-stock' : ''}`}
              style={{ '--reveal-delay': `${idx * 0.05}s` } as React.CSSProperties}
            >
              {isOutOfStock(reward) && <div className="out-of-stock-overlay">Out Of Stock</div>}

              <div className="reward-icon-box">
                <span className="reward-icon">{reward.icon}</span>
              </div>

              <div className="reward-info">
                <h4 className="reward-name">{reward.name}</h4>
                <p className="reward-desc">{reward.description}</p>

                <div className="reward-footer">
                  <div className="reward-meta">
                    <span className="points-cost">{reward.pointsCost.toLocaleString()} Pts</span>
                    {reward.stock && <span className="stock-badge">{reward.stock} Left</span>}
                  </div>

                  <button
                    className={`redeem-btn ${redeemingId === reward.id ? 'redeeming' : ''}`}
                    onClick={() => handleRedeem(reward)}
                    disabled={
                      !canRedeem(reward) || redeemingId === reward.id || isOutOfStock(reward)
                    }
                  >
                    {redeemingId === reward.id ? '...' : 'Redeem'}
                  </button>
                </div>
              </div>

              {canRedeem(reward) && (
                <div
                  className="card-glow"
                  style={{ boxShadow: `0 0 12px rgba(255, 215, 0, 0.3)` }}
                />
              )}
            </div>
          ))
        ) : (
          <div className="no-rewards">
            <span className="no-rewards-icon">◈</span>
            <p>No Rewards In This Category Yet</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default RewardsMarketplace;
