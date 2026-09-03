/**
 * VIP_TIERS — Tier Configuration and Rewards
 * Defines the tier hierarchy, colors, icons, multipliers, and progression thresholds
 */

export const VIP_TIERS = [
  {
    id: 'bronze',
    name: 'Bronze',
    color: '#CD7F32',
    accentColor: 'rgba(205, 127, 50, 0.15)',
    icon: 'B',
    minPoints: 0,
    multiplier: 1,
    rakeback: 5,
    tournyTickets: 0,
    priority: false,
    exclusiveTable: false,
    badgeFrame: 'standard',
  },
  {
    id: 'silver',
    name: 'Silver',
    color: '#C0C0C0',
    accentColor: 'rgba(192, 192, 192, 0.15)',
    icon: 'S',
    minPoints: 1000,
    multiplier: 1.5,
    rakeback: 10,
    tournyTickets: 1,
    priority: false,
    exclusiveTable: false,
    badgeFrame: 'silver',
  },
  {
    id: 'gold',
    name: 'Gold',
    color: '#FFD700',
    accentColor: 'rgba(255, 215, 0, 0.15)',
    icon: 'G',
    minPoints: 5000,
    multiplier: 2,
    rakeback: 15,
    tournyTickets: 2,
    priority: true,
    exclusiveTable: false,
    badgeFrame: 'gold',
  },
  {
    id: 'platinum',
    name: 'Platinum',
    color: '#E5E4E2',
    accentColor: 'rgba(229, 228, 226, 0.15)',
    icon: 'P',
    minPoints: 15000,
    multiplier: 3,
    rakeback: 20,
    tournyTickets: 3,
    priority: true,
    exclusiveTable: true,
    badgeFrame: 'platinum',
  },
  {
    id: 'diamond',
    name: 'Diamond',
    color: '#B9F2FF',
    accentColor: 'rgba(185, 242, 255, 0.15)',
    icon: 'D',
    minPoints: 50000,
    multiplier: 5,
    rakeback: 25,
    tournyTickets: 5,
    priority: true,
    exclusiveTable: true,
    badgeFrame: 'diamond',
  },
  {
    id: 'royal',
    name: 'Royal',
    color: '#9B59B6',
    accentColor: 'rgba(155, 89, 182, 0.15)',
    icon: 'R',
    minPoints: 150000,
    multiplier: 10,
    rakeback: 30,
    tournyTickets: 10,
    priority: true,
    exclusiveTable: true,
    badgeFrame: 'royal',
  },
] as const;

export type VIPTierId = (typeof VIP_TIERS)[number]['id'];

export const getTierById = (id: VIPTierId) => {
  return VIP_TIERS.find((tier) => tier.id === id);
};

export const getTierByPoints = (points: number) => {
  return [...VIP_TIERS].reverse().find((tier) => points >= tier.minPoints) || VIP_TIERS[0];
};

export const getNextTier = (currentTierId: VIPTierId) => {
  const currentIndex = VIP_TIERS.findIndex((tier) => tier.id === currentTierId);
  return VIP_TIERS[currentIndex + 1] || null;
};
