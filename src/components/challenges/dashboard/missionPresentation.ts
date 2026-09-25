import type { CasinoControlIconVariant } from '../CasinoControlIcon';
import type { Tier, TieredUserChallenge } from '../../../services/DailyChallengeService';

// Tier and TieredChallenge now come from the service, which is also what the
// server-catalog fetch returns -- one definition, so a tier added there cannot
// silently disagree with the tabs here.
export type TieredChallenge = TieredUserChallenge;

export const TIER_LABELS: Record<Tier, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

export const TIER_COLORS: Record<Tier, string> = {
  daily: 'var(--realism-cyan, #55e8ff)',
  weekly: 'var(--realism-chrome, #b8c4c9)',
  monthly: 'var(--realism-gold, #ffc93c)',
};

export const TIER_CONTROL_ICONS: Record<Tier, CasinoControlIconVariant> = {
  daily: 'cycle-daily',
  weekly: 'cycle-weekly',
  monthly: 'cycle-monthly',
};

export const TIER_PRESENTATION: Record<
  Tier,
  { title: string; eyebrow: string; description: string }
> = {
  daily: {
    title: 'Daily Challenges',
    eyebrow: 'Club Arena / Daily Challenge Vault',
    description:
      'Complete Live Poker Objectives, Protect Your Streak, And Collect Real Diamond Rewards At The Club Arena Rewards Desk.',
  },
  weekly: {
    title: 'Weekly Challenges',
    eyebrow: 'Club Arena / Weekly Challenge Circuit',
    description:
      'Build Momentum Across The Weekly Poker Circuit, Complete Larger Objectives, And Settle Premium Diamond Rewards.',
  },
  monthly: {
    title: 'Monthly Challenges',
    eyebrow: 'Club Arena / Monthly High-Roller Ledger',
    description:
      "Chase Long-Form Poker Milestones, Track Your Monthly Run, And Secure The Vault's Largest Diamond Rewards.",
  },
};

export const TIERS: Tier[] = ['daily', 'weekly', 'monthly'];

export const MISSION_HERO_DESKTOP = 'images/challenges/daily-missions-casino-v2.webp';
export const MISSION_HERO_MOBILE = 'images/challenges/daily-missions-casino-v2-mobile.webp';
export const MISSION_REWARD_ARTWORK = 'images/challenges/daily-missions-reward-pedestal-v1.webp';
export const MISSION_FREEZE_ARTWORK = 'images/challenges/daily-missions-streak-freeze-v1.webp';
export const MISSION_DIAMOND_ARTWORK = 'images/challenges/daily-missions-diamond-96-v1.webp';
export const MISSION_RESET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
export const MISSION_SYNC_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});
export const MISSION_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Restore keyboard focus after a state update removes the activated control. */
export function focusAfterMissionUpdate(targetId: string): void {
  requestAnimationFrame(() => document.getElementById(targetId)?.focus());
}
