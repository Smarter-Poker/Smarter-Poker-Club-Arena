/**
 * ♠ CLUB ARENA — Avatar Service
 * Integrates with smarter.poker/hub/avatars-complete system
 *
 * Avatars are stored in Supabase and can be:
 * - Pre-made avatars from the library (70 available)
 * - Custom AI-generated avatars (requires login)
 */

import { supabase } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Avatar {
  id: string;
  name: string;
  imageUrl: string;
  category: 'free' | 'vip' | 'custom';
  isOwned: boolean;
}

export interface UserAvatar {
  userId: string;
  avatarId: string;
  avatarUrl: string;
  displayName: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AVATAR LIBRARY (75 Pre-made Avatars)
// These match the Hub's avatar library at smarter.poker/hub/avatars-complete
// ═══════════════════════════════════════════════════════════════════════════════

const AVATAR_LIBRARY: Omit<Avatar, 'isOwned'>[] = [
  // ── FREE AVATARS (25) ─────────────────────────────────────────────────────────
  // Animals
  {
    id: 'poker-shark',
    name: 'Poker Shark',
    imageUrl: '/avatars/poker-shark.png',
    category: 'free',
  },
  {
    id: 'lucky-rabbit',
    name: 'Lucky Rabbit',
    imageUrl: '/avatars/lucky-rabbit.png',
    category: 'free',
  },
  { id: 'wise-owl', name: 'Wise Owl', imageUrl: '/avatars/wise-owl.png', category: 'free' },
  { id: 'sly-fox', name: 'Sly Fox', imageUrl: '/avatars/sly-fox.png', category: 'free' },
  {
    id: 'cool-penguin',
    name: 'Cool Penguin',
    imageUrl: '/avatars/cool-penguin.png',
    category: 'free',
  },
  {
    id: 'fierce-lion',
    name: 'Fierce Lion',
    imageUrl: '/avatars/fierce-lion.png',
    category: 'free',
  },
  {
    id: 'clever-octopus',
    name: 'Clever Octopus',
    imageUrl: '/avatars/clever-octopus.png',
    category: 'free',
  },
  {
    id: 'swift-eagle',
    name: 'Swift Eagle',
    imageUrl: '/avatars/swift-eagle.png',
    category: 'free',
  },
  { id: 'night-wolf', name: 'Night Wolf', imageUrl: '/avatars/night-wolf.png', category: 'free' },
  {
    id: 'royal-tiger',
    name: 'Royal Tiger',
    imageUrl: '/avatars/royal-tiger.png',
    category: 'free',
  },

  // Characters
  {
    id: 'retro-rockstar',
    name: 'Retro Rockstar',
    imageUrl: '/avatars/retro-rockstar.png',
    category: 'free',
  },
  {
    id: 'master-chef',
    name: 'Master Chef',
    imageUrl: '/avatars/master-chef.png',
    category: 'free',
  },
  {
    id: 'lab-scientist',
    name: 'Lab Scientist',
    imageUrl: '/avatars/lab-scientist.png',
    category: 'free',
  },
  { id: 'pop-star', name: 'Pop Star', imageUrl: '/avatars/pop-star.png', category: 'free' },
  {
    id: 'space-explorer',
    name: 'Space Explorer',
    imageUrl: '/avatars/space-explorer.png',
    category: 'free',
  },
  { id: 'cowboy-ace', name: 'Cowboy Ace', imageUrl: '/avatars/cowboy-ace.png', category: 'free' },
  {
    id: 'ninja-master',
    name: 'Ninja Master',
    imageUrl: '/avatars/ninja-master.png',
    category: 'free',
  },
  {
    id: 'pirate-captain',
    name: 'Pirate Captain',
    imageUrl: '/avatars/pirate-captain.png',
    category: 'free',
  },
  { id: 'cyber-punk', name: 'Cyber Punk', imageUrl: '/avatars/cyber-punk.png', category: 'free' },
  {
    id: 'street-artist',
    name: 'Street Artist',
    imageUrl: '/avatars/street-artist.png',
    category: 'free',
  },
  {
    id: 'jazz-musician',
    name: 'Jazz Musician',
    imageUrl: '/avatars/jazz-musician.png',
    category: 'free',
  },
  { id: 'dj-spinner', name: 'DJ Spinner', imageUrl: '/avatars/dj-spinner.png', category: 'free' },
  {
    id: 'yoga-master',
    name: 'Yoga Master',
    imageUrl: '/avatars/yoga-master.png',
    category: 'free',
  },
  {
    id: 'surfer-dude',
    name: 'Surfer Dude',
    imageUrl: '/avatars/surfer-dude.png',
    category: 'free',
  },
  { id: 'skater-kid', name: 'Skater Kid', imageUrl: '/avatars/skater-kid.png', category: 'free' },

  // ── VIP AVATARS (50) ──────────────────────────────────────────────────────────
  // Legends
  { id: 'tech-mogul', name: 'Tech Mogul', imageUrl: '/avatars/tech-mogul.png', category: 'vip' },
  {
    id: 'aerospace-pioneer',
    name: 'Aerospace Pioneer',
    imageUrl: '/avatars/aerospace-pioneer.png',
    category: 'vip',
  },
  {
    id: 'liberty-statue',
    name: 'Liberty Statue',
    imageUrl: '/avatars/liberty-statue.png',
    category: 'vip',
  },
  {
    id: 'royal-monarch',
    name: 'Royal Monarch',
    imageUrl: '/avatars/royal-monarch.png',
    category: 'vip',
  },
  {
    id: 'golden-dragon',
    name: 'Golden Dragon',
    imageUrl: '/avatars/golden-dragon.png',
    category: 'vip',
  },
  {
    id: 'wall-street-wolf',
    name: 'Wall Street Wolf',
    imageUrl: '/avatars/wall-street-wolf.png',
    category: 'vip',
  },
  {
    id: 'diamond-dealer',
    name: 'Diamond Dealer',
    imageUrl: '/avatars/diamond-dealer.png',
    category: 'vip',
  },
  { id: 'casino-king', name: 'Casino King', imageUrl: '/avatars/casino-king.png', category: 'vip' },
  {
    id: 'poker-princess',
    name: 'Poker Princess',
    imageUrl: '/avatars/poker-princess.png',
    category: 'vip',
  },
  {
    id: 'vegas-legend',
    name: 'Vegas Legend',
    imageUrl: '/avatars/vegas-legend.png',
    category: 'vip',
  },

  // Myths & Fantasy
  {
    id: 'phoenix-rising',
    name: 'Phoenix Rising',
    imageUrl: '/avatars/phoenix-rising.png',
    category: 'vip',
  },
  { id: 'thunder-god', name: 'Thunder God', imageUrl: '/avatars/thunder-god.png', category: 'vip' },
  { id: 'frost-queen', name: 'Frost Queen', imageUrl: '/avatars/frost-queen.png', category: 'vip' },
  {
    id: 'shadow-knight',
    name: 'Shadow Knight',
    imageUrl: '/avatars/shadow-knight.png',
    category: 'vip',
  },
  {
    id: 'cosmic-wizard',
    name: 'Cosmic Wizard',
    imageUrl: '/avatars/cosmic-wizard.png',
    category: 'vip',
  },
  { id: 'forest-elf', name: 'Forest Elf', imageUrl: '/avatars/forest-elf.png', category: 'vip' },
  { id: 'stone-golem', name: 'Stone Golem', imageUrl: '/avatars/stone-golem.png', category: 'vip' },
  { id: 'sea-titan', name: 'Sea Titan', imageUrl: '/avatars/sea-titan.png', category: 'vip' },
  { id: 'fire-demon', name: 'Fire Demon', imageUrl: '/avatars/fire-demon.png', category: 'vip' },
  { id: 'wind-spirit', name: 'Wind Spirit', imageUrl: '/avatars/wind-spirit.png', category: 'vip' },

  // Professionals
  { id: 'high-roller', name: 'High Roller', imageUrl: '/avatars/high-roller.png', category: 'vip' },
  {
    id: 'card-counter',
    name: 'Card Counter',
    imageUrl: '/avatars/card-counter.png',
    category: 'vip',
  },
  {
    id: 'bluff-master',
    name: 'Bluff Master',
    imageUrl: '/avatars/bluff-master.png',
    category: 'vip',
  },
  {
    id: 'chip-stacker',
    name: 'Chip Stacker',
    imageUrl: '/avatars/chip-stacker.png',
    category: 'vip',
  },
  { id: 'pot-builder', name: 'Pot Builder', imageUrl: '/avatars/pot-builder.png', category: 'vip' },
  { id: 'river-rat', name: 'River Rat', imageUrl: '/avatars/river-rat.png', category: 'vip' },
  {
    id: 'heads-up-hero',
    name: 'Heads Up Hero',
    imageUrl: '/avatars/heads-up-hero.png',
    category: 'vip',
  },
  { id: 'mtt-grinder', name: 'MTT Grinder', imageUrl: '/avatars/mtt-grinder.png', category: 'vip' },
  { id: 'cash-king', name: 'Cash King', imageUrl: '/avatars/cash-king.png', category: 'vip' },
  {
    id: 'plo-specialist',
    name: 'PLO Specialist',
    imageUrl: '/avatars/plo-specialist.png',
    category: 'vip',
  },

  // Sports & Action
  {
    id: 'championship-boxer',
    name: 'Championship Boxer',
    imageUrl: '/avatars/championship-boxer.png',
    category: 'vip',
  },
  {
    id: 'formula-racer',
    name: 'Formula Racer',
    imageUrl: '/avatars/formula-racer.png',
    category: 'vip',
  },
  {
    id: 'home-run-hero',
    name: 'Home Run Hero',
    imageUrl: '/avatars/home-run-hero.png',
    category: 'vip',
  },
  { id: 'mvp-baller', name: 'MVP Baller', imageUrl: '/avatars/mvp-baller.png', category: 'vip' },
  { id: 'tennis-ace', name: 'Tennis Ace', imageUrl: '/avatars/tennis-ace.png', category: 'vip' },
  {
    id: 'golf-champion',
    name: 'Golf Champion',
    imageUrl: '/avatars/golf-champion.png',
    category: 'vip',
  },
  { id: 'hockey-star', name: 'Hockey Star', imageUrl: '/avatars/hockey-star.png', category: 'vip' },
  {
    id: 'soccer-legend',
    name: 'Soccer Legend',
    imageUrl: '/avatars/soccer-legend.png',
    category: 'vip',
  },
  { id: 'mma-warrior', name: 'MMA Warrior', imageUrl: '/avatars/mma-warrior.png', category: 'vip' },
  {
    id: 'olympic-gold',
    name: 'Olympic Gold',
    imageUrl: '/avatars/olympic-gold.png',
    category: 'vip',
  },

  // Luxury & Lifestyle
  {
    id: 'yacht-captain',
    name: 'Yacht Captain',
    imageUrl: '/avatars/yacht-captain.png',
    category: 'vip',
  },
  { id: 'jet-setter', name: 'Jet Setter', imageUrl: '/avatars/jet-setter.png', category: 'vip' },
  {
    id: 'penthouse-prince',
    name: 'Penthouse Prince',
    imageUrl: '/avatars/penthouse-prince.png',
    category: 'vip',
  },
  {
    id: 'art-collector',
    name: 'Art Collector',
    imageUrl: '/avatars/art-collector.png',
    category: 'vip',
  },
  {
    id: 'wine-connoisseur',
    name: 'Wine Connoisseur',
    imageUrl: '/avatars/wine-connoisseur.png',
    category: 'vip',
  },
  {
    id: 'fashion-mogul',
    name: 'Fashion Mogul',
    imageUrl: '/avatars/fashion-mogul.png',
    category: 'vip',
  },
  {
    id: 'crypto-whale',
    name: 'Crypto Whale',
    imageUrl: '/avatars/crypto-whale.png',
    category: 'vip',
  },
  {
    id: 'venture-guru',
    name: 'Venture Guru',
    imageUrl: '/avatars/venture-guru.png',
    category: 'vip',
  },
  {
    id: 'night-owl-vip',
    name: 'Night Owl VIP',
    imageUrl: '/avatars/night-owl-vip.png',
    category: 'vip',
  },
  { id: 'golden-ace', name: 'Golden Ace', imageUrl: '/avatars/golden-ace.png', category: 'vip' },
];

// Default avatar for users without a selection
const DEFAULT_AVATAR_URL = '/avatars/default-player.png';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class AvatarServiceClass {
  /**
   * Get the Hub avatar page URL for embedding or navigation
   */
  getHubAvatarUrl(): string {
    return 'https://smarter.poker/hub/avatars-complete';
  }

  /**
   * Get all available avatars from the library
   */
  async getAvatarLibrary(userId?: string): Promise<Avatar[]> {
    // In the future, this could fetch from Supabase to check ownership
    return AVATAR_LIBRARY.map((avatar) => ({
      ...avatar,
      isOwned: avatar.category === 'free', // Free avatars are always owned
    }));
  }

  /**
   * Get a user's current avatar URL
   */
  async getUserAvatarUrl(userId: string): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('avatar_url')
        .eq('id', userId)
        .maybeSingle();

      if (error || !data?.avatar_url) {
        return DEFAULT_AVATAR_URL;
      }

      return data.avatar_url;
    } catch (err) {

      console.error("[AvatarService] Error:", err);
      return DEFAULT_AVATAR_URL;
    }
  }

  /**
   * Get avatars for multiple users (for table display)
   */
  async getUserAvatars(userIds: string[]): Promise<Map<string, string>> {
    const avatarMap = new Map<string, string>();

    if (userIds.length === 0) return avatarMap;

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, avatar_url, display_name')
        .in('id', userIds);

      if (!error && data) {
        for (const profile of data) {
          avatarMap.set(profile.id, profile.avatar_url || DEFAULT_AVATAR_URL);
        }
      }
    } catch (err) {

      console.error("[AvatarService] Error:", err);
      // Fall back to default avatars
    }

    // Set default for any missing users
    for (const userId of userIds) {
      if (!avatarMap.has(userId)) {
        avatarMap.set(userId, DEFAULT_AVATAR_URL);
      }
    }

    return avatarMap;
  }

  /**
   * Update user's avatar
   */
  async setUserAvatar(userId: string, avatarUrl: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ avatar_url: avatarUrl })
        .eq('id', userId);

      return !error;
    } catch (err) {

      console.error("[AvatarService] Error:", err);
      return false;
    }
  }

  /**
   * Open the Hub avatar selector in a new tab/modal
   * The Hub will handle avatar selection and save to the user's profile
   */
  openAvatarSelector(): void {
    const url = this.getHubAvatarUrl();
    const isInIframe = typeof window !== 'undefined' && window.parent !== window;
    if (isInIframe) {
      try { window.top!.open(url, '_blank'); } catch { window.open(url, '_blank'); }
    } else {
      window.open(url, '_blank', 'width=800,height=600');
    }
  }

  /**
   * Check if a user has VIP access for premium avatars
   */
  async hasVipAccess(userId: string): Promise<boolean> {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('is_vip')
        .eq('id', userId)
        .maybeSingle();

      return data?.is_vip || false;
    } catch (err) {

      console.error("[AvatarService] Error:", err);
      return false;
    }
  }
}

export const avatarService = new AvatarServiceClass();
export default avatarService;
