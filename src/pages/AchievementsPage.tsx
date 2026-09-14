/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENTS PAGE — Player Achievements & Badges with Real-Time Unlocks
 * ═══════════════════════════════════════════════════════════════════════════════
 * Display unlocked achievements, progress, and badges
 *
 * ── THE CONSOLE (#ClubArenaConsole) ──────────────────────────────────────────
 *
 * Everything between the Rewards Circuit header and the badge grid used to be
 * drawn inline: a rounded navy streak panel with a 16px radius and a cyan
 * hairline, THREE MILESTONE BOXES side by side, a bordered summary card
 * repeating a number the header already prints, rounded "next up" cards with
 * their own gradient and blur, a row of gradient pill chips and a rounded
 * select. Roughly two hundred lines of `style={{ borderRadius, background:
 * linear-gradient, boxShadow }}` making things look like controls.
 *
 * It is printed on the spade master now. Each section is one console: the head
 * carries the section name, the body prints on the black glass, and every list
 * is ROWS - label in the master's lit blue on the left, value in silver on the
 * right, an engraved rule cut between them.
 *
 * THE THREE MILESTONE BOXES ARE GONE (Dan 2026-09-09: "I DON'T LIKE THE 4
 * BOXES, AND THE WAY IT STICKS OUT ON THE SIDES"). Day 7, Day 30 and Day 100
 * are three rows, and a reward already earned prints in the console's green
 * rather than in a green-tinted tile.
 *
 * WHAT IS DELIBERATELY NOT ON THE CONSOLE. `RewardsSurfaceHeader` is this route
 * family's approved visual anchor and is pinned by
 * tests/unit/cinematicRouteFamilies.test.ts, so it stays exactly as it is. And
 * the badge grid renders BELOW the archive console, on the page's own black
 * ground, because `AchievementBadge` is a bordered, glowing card of its own -
 * putting that grid inside a console body would be a frame sitting on a frame,
 * which Dan's law forbids outright. The console holds the controls and the
 * states; the badges are the badge component's own surface.
 *
 * THE ONE THING STILL DRAWN is the progress meter, because the master paints no
 * meter and a "next up" list with no sense of how close you are is a worse
 * surface. It is cut as a groove in the glass - a black line with a light lip
 * and a solid lit-blue fill - not a rounded bar with a gradient.
 *
 * Every handler, ref, timer and subscription below is untouched: the realtime
 * unlock channel, the 5s auto-hide, the HAND_COMPLETED debounce, the SWR cache,
 * the haptic and the achievement fanfare all behave exactly as before.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import AchievementBadge, { AchievementGrid } from '../components/achievements/AchievementBadge';
import { AchievementShareCard } from '../components/achievements/AchievementShareCard';
import BottomSheet from '../components/common/BottomSheet';
import { StreakFire } from '../components/gamification/StreakFire';
import ActivityHeatmap from '../components/common/ActivityHeatmap';
import { ConfettiEffect } from '../components/gamification/ConfettiEffect';
import { achievementService } from '../services/AchievementService';
import { haptic } from '../services/HapticService';
import { soundService } from '../services/SoundService';
import './AchievementsPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { SpadeConsole, type ConsoleInk } from '../components/console/SpadeConsole';
import { reportError } from '../utils/errorReporter';
import { ErrorState } from '../components/common/EmptyState';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';

type SortMode = 'default' | 'rarity' | 'progress' | 'recent';
const RARITY_ORDER: Record<string, number> = { legendary: 0, epic: 1, rare: 2, common: 3 };

/**
 * Rarity in the master's own inks (§3.4 of the standard) rather than the
 * orange and purple the page used to reach for - Dan: "ALWAYS USE
 * SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS". Four ranks, four
 * distinct inks, all of them already on the console.
 */
const RARITY_INK: Record<string, ConsoleInk> = {
  legendary: 'gold',
  epic: 'white',
  rare: 'blue',
  common: 'muted',
};

/** Animated count-up hook */
function useAnimatedCount(target: number, duration = 600) {
  const [count, setCount] = useState(0);
  const prevRef = useRef(0);
  useEffect(() => {
    const start = prevRef.current;
    const diff = target - start;
    if (diff === 0) return;
    const startTime = Date.now();
    const tick = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      // ease-out quad
      const ease = 1 - (1 - progress) * (1 - progress);
      const current = Math.round(start + diff * ease);
      setCount(current);
      if (progress < 1) requestAnimationFrame(tick);
      else prevRef.current = target;
    };
    requestAnimationFrame(tick);
  }, [target, duration]);
  return count;
}

// ── SWR Cache ──
const ACH_CACHE_KEY = 'ach_cache_';
function getCachedAch(userId: string): Achievement[] | null {
  try {
    const raw = sessionStorage.getItem(ACH_CACHE_KEY + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setCachedAch(userId: string, data: Achievement[]) {
  try {
    sessionStorage.setItem(ACH_CACHE_KEY + userId, JSON.stringify(data));
  } catch {
    /* quota */
  }
}

type AchievementCategory = 'all' | 'poker' | 'social' | 'financial' | 'tournament';

/** One label per category, so nothing ever prints a raw lowercase enum. */
const CATEGORY_LABEL: Record<AchievementCategory, string> = {
  all: 'All',
  poker: 'Poker',
  social: 'Social',
  financial: 'Financial',
  tournament: 'Tournament',
};

interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: AchievementCategory;

  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  progress: number; // 0-100
  unlocked: boolean;
  unlockedAt?: string;
  requirement: string;
}

// Achievement display definitions — IDs MUST match AchievementService.ts exactly
const ACHIEVEMENTS: Omit<Achievement, 'progress' | 'unlocked' | 'unlockedAt'>[] = [
  // ── Hands Played ──
  {
    id: 'hands_100',
    name: 'Getting Started',
    description: 'Play 100 Hands Of Poker',
    icon: '♠',
    category: 'poker',
    rarity: 'common',
    requirement: 'Play 100 Hands',
  },
  {
    id: 'hands_1000',
    name: 'Regular',
    description: 'Play 1,000 Hands',
    icon: '◆',
    category: 'poker',
    rarity: 'rare',
    requirement: 'Play 1,000 Hands',
  },
  {
    id: 'hands_10000',
    name: 'Grinder',
    description: 'Play 10,000 Hands',
    icon: '▲',
    category: 'poker',
    rarity: 'epic',
    requirement: 'Play 10,000 Hands',
  },
  {
    id: 'hands_100000',
    name: 'Professional',
    description: 'Play 100,000 Hands',
    icon: '◆',
    category: 'poker',
    rarity: 'legendary',
    requirement: 'Play 100,000 Hands',
  },

  // ── Wins ──
  {
    id: 'wins_10',
    name: 'First Blood',
    description: 'Win 10 Hands',
    icon: '☆',
    category: 'poker',
    rarity: 'common',
    requirement: 'Win 10 Hands',
  },
  {
    id: 'wins_100',
    name: 'Winner',
    description: 'Win 100 Hands',
    icon: '★',
    category: 'poker',
    rarity: 'rare',
    requirement: 'Win 100 Hands',
  },
  {
    id: 'wins_1000',
    name: 'Dominator',
    description: 'Win 1,000 Hands',
    icon: '▲',
    category: 'poker',
    rarity: 'epic',
    requirement: 'Win 1,000 Hands',
  },

  // ── Special Hands ──
  {
    id: 'royal_flush',
    name: 'Royal Blood',
    description: 'Hit A Royal Flush',
    icon: '♛',
    category: 'poker',
    rarity: 'legendary',
    requirement: 'Get Royal Flush',
  },
  {
    id: 'straight_flush',
    name: 'Straight Shooter',
    description: 'Hit A Straight Flush',
    icon: '◆',
    category: 'poker',
    rarity: 'epic',
    requirement: 'Get Straight Flush',
  },
  {
    id: 'quads',
    name: 'Four Of A Kind',
    description: 'Hit Quads',
    icon: '◎',
    category: 'poker',
    rarity: 'rare',
    requirement: 'Get Quads',
  },

  // ── Social ──
  {
    id: 'friends_5',
    name: 'Social Butterfly',
    description: 'Add 5 Friends',
    icon: '◆',
    category: 'social',
    rarity: 'common',
    requirement: 'Add 5 Friends',
  },
  {
    id: 'friends_25',
    name: 'Popular',
    description: 'Add 25 Friends',
    icon: '★',
    category: 'social',
    rarity: 'rare',
    requirement: 'Add 25 Friends',
  },
  {
    id: 'clubs_3',
    name: 'Club Hopper',
    description: 'Join 3 Clubs',
    icon: '⌂',
    category: 'social',
    rarity: 'common',
    requirement: 'Join 3 Clubs',
  },

  // ── Financial ──
  {
    id: 'profit_1000',
    name: 'In The Green',
    description: 'Profit 1,000 Chips',
    icon: '▲',
    category: 'financial',
    rarity: 'rare',
    requirement: 'Profit 1K Chips',
  },
  {
    id: 'profit_10000',
    name: 'High Roller',
    description: 'Profit 10,000 Chips',
    icon: '◆',
    category: 'financial',
    rarity: 'epic',
    requirement: 'Profit 10K Chips',
  },
  {
    id: 'biggest_pot_500',
    name: 'Big Pot',
    description: 'Win A 500+ Chip Pot',
    icon: '★',
    category: 'financial',
    rarity: 'rare',
    requirement: 'Win 500+ Pot',
  },

  // ── Tournament ──
  {
    id: 'tourney_win_1',
    name: 'Champion',
    description: 'Win A Tournament',
    icon: '★',
    category: 'tournament',
    rarity: 'epic',
    requirement: 'Win Tournament',
  },
  {
    id: 'tourney_top3_10',
    name: 'Consistent',
    description: 'Finish Top 3 In 10 Tournaments',
    icon: '◆',
    category: 'tournament',
    rarity: 'rare',
    requirement: 'Top 3 X10',
  },
  {
    id: 'tourney_played_50',
    name: 'Tournament Regular',
    description: 'Play 50 Tournaments',
    icon: '◆',
    category: 'tournament',
    rarity: 'rare',
    requirement: 'Play 50 Tournaments',
  },

  // ── Streaks ──
  {
    id: 'streak_7',
    name: 'Weekly Warrior',
    description: 'Log In 7 Days In A Row',
    icon: '▲',
    category: 'social',
    rarity: 'common',
    requirement: '7-Day Streak',
  },
  {
    id: 'streak_30',
    name: 'Monthly Grinder',
    description: 'Log In 30 Days In A Row',
    icon: '▤',
    category: 'social',
    rarity: 'rare',
    requirement: '30-Day Streak',
  },
  {
    id: 'streak_100',
    name: 'Centurion',
    description: 'Log In 100 Days In A Row',
    icon: '◆',
    category: 'social',
    rarity: 'legendary',
    requirement: '100-Day Streak',
  },
];

export default function AchievementsPage() {
  useEffect(() => {
    document.title = 'Achievements | Smarter Poker';
  }, []);
  useVisibilityRefresh(() => loadAchievements());
  const { user } = useAuthUser();
  const toast = useToast();
  const [category, setCategory] = useState<AchievementCategory>('all');
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newUnlock, setNewUnlock] = useState<Achievement | null>(null);
  const [visibleBadges, setVisibleBadges] = useState(new Set<number>());
  const [sharingAchievement, setSharingAchievement] = useState<Achievement | null>(null);
  const [selectedAchievement, setSelectedAchievement] = useState<Achievement | null>(null);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAchievementsRef = useRef<(() => Promise<void>) | null>(null);
  const isMounted = useIsMounted();

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (user?.id) {
      loadAchievements();

      // Fetch real daily login streak from profiles
      Promise.resolve(
        supabase.from('profiles').select('login_streak').eq('id', user.id).maybeSingle()
      )
        .then(({ data }) => {
          if (isMounted.current && data) {
            setDailyStreak(data.login_streak || 0);
          }
        })
        .catch((err: unknown) => {
          console.warn('[AchievementsPage] login_streak fetch failed:', err);
        });

      // Subscribe to real-time achievement unlocks
      const channelKey = `user-achievements-${user.id}`;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'training_user_achievements',
            filter: `user_id=eq.${user.id}`,
          },
          async (payload) => {
            if (!isMounted.current) return;
            const newRow = payload.new as any;
            if (!newRow || !newRow.achievement_id) return;

            // Always reload the list so progress bars visually increment immediately
            if (loadAchievementsRef.current) {
              await loadAchievementsRef.current();
            }

            // Celebration Logic: Only trigger if the row has an unlocked_at date
            if (!newRow.unlocked_at) return;

            // If we have old row data, ensure we don't celebrate twice for the same achievement
            const oldRow = payload.old as any;
            if (payload.eventType === 'UPDATE' && oldRow && oldRow.unlocked_at) return;

            // New achievement unlocked!
            const achievementId = newRow.achievement_id;
            const achievement = ACHIEVEMENTS.find((a) => a.id === achievementId);
            if (achievement) {
              setNewUnlock({
                ...achievement,
                progress: 100,
                unlocked: true,
                unlockedAt: newRow.unlocked_at,
              });

              // Auto-hide after 5 seconds (clear previous timer)
              if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
              unlockTimerRef.current = setTimeout(() => setNewUnlock(null), 5000);
            }
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'AchievementsPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[AchievementsPage] Realtime channel timed out');
          }
        });

      return () => {
        masterBus.removeRegisteredChannel(channelKey);
        if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
      };
    }
  }, [user?.id]);

  const loadingRef = useRef(false);

  const loadAchievements = async () => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadError(null);
    // SWR: show cached instantly
    const cached = getCachedAch(user.id);
    if (cached && cached.length > 0) {
      setAchievements(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    try {
      // Get user's achievements from AchievementService with retry
      const userAchievements = await retryFetch(
        () => achievementService.getUserAchievements(user?.id || ''),
        { maxRetries: 2 }
      );
      const allAchievements = achievementService.getAll();

      // Create a map of user progress
      const progressMap = new Map(
        userAchievements.map((ua) => [
          ua.achievementId,
          { progress: ua.progress, unlockedAt: ua.unlockedAt },
        ])
      );

      // Merge with local ACHIEVEMENTS for display
      const merged: Achievement[] = ACHIEVEMENTS.map((a) => {
        const userProgress = progressMap.get(a.id);
        const serviceAchievement = allAchievements.find((sa) => sa.id === a.id);
        const rawProgress = userProgress?.progress || 0;
        const requirement = serviceAchievement?.requirement || 100;
        // Convert absolute progress to 0-100 percentage for display
        const pct =
          requirement > 0 ? Math.min(100, Math.round((rawProgress / requirement) * 100)) : 0;
        return {
          ...a,
          progress: pct,
          unlocked: rawProgress >= requirement,
          unlockedAt: userProgress?.unlockedAt,
        };
      });

      if (isMounted.current) {
        setAchievements(merged);
        setCachedAch(user?.id || '', merged);
      }
    } catch (error) {
      reportError(error, 'AchievementsPage.Failed_to_load_achievements');
      if (isMounted.current) setLoadError('Achievement progress could not be loaded.');
      if (isMounted.current) toast?.error('Failed to load achievements');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  };

  // Store loadAchievements in ref for use in realtime callbacks
  useEffect(() => {
    loadAchievementsRef.current = loadAchievements;
  });

  // ── Bus Listener: refresh achievements when engine completes a hand ──
  useEffect(() => {
    const unsub = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        if (loadAchievementsRef.current) loadAchievementsRef.current();
      },
      3000
    );
    return unsub;
  }, []);

  const [sortMode, setSortMode] = useState<SortMode>('default');

  const filteredAchievements = useMemo(() => {
    const list =
      category === 'all' ? [...achievements] : achievements.filter((a) => a.category === category);
    switch (sortMode) {
      case 'rarity':
        list.sort((a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9));
        break;
      case 'progress':
        list.sort((a, b) => b.progress - a.progress);
        break;
      case 'recent':
        list.sort((a, b) => {
          if (a.unlockedAt && b.unlockedAt)
            return new Date(b.unlockedAt).getTime() - new Date(a.unlockedAt).getTime();
          if (a.unlockedAt) return -1;
          if (b.unlockedAt) return 1;
          return b.progress - a.progress;
        });
        break;
    }
    return list;
  }, [achievements, category, sortMode]);

  const unlockedCount = achievements.filter((a) => a.unlocked).length;
  const animatedUnlocked = useAnimatedCount(unlockedCount);
  const animatedTotal = useAnimatedCount(achievements.length);

  // Category counts for filter chips
  const getCatCount = useCallback(
    (cat: AchievementCategory) => {
      const items = cat === 'all' ? achievements : achievements.filter((a) => a.category === cat);
      const u = items.filter((a) => a.unlocked).length;
      return `${u}/${items.length}`;
    },
    [achievements]
  );

  // Haptic + sound on unlock
  useEffect(() => {
    if (!newUnlock) return;
    haptic.success();
    // SOUND AUDIT 2026-08-19: '/sounds/unlock-chime.mp3' never existed —
    // the request 404'd silently on every unlock. Use the synth achievement
    // fanfare the rest of the app plays.
    try {
      soundService.playAchievement();
    } catch (e) {
      reportError(e, 'AchievementsPage.useEffect');
      /* no audio support */
    }
  }, [newUnlock]);

  const [dailyStreak, setDailyStreak] = useState(0);

  const heatmapData = useMemo(() => {
    const days: Record<string, number> = {};
    achievements.forEach((a) => {
      if (a.unlocked && a.unlockedAt) {
        const d = new Date(a.unlockedAt).toISOString().slice(0, 10);
        days[d] = (days[d] || 0) + 1;
      }
    });
    return Object.entries(days).map(([date, count]) => ({ date, count }));
  }, [achievements]);

  const nextUp = useMemo(() => {
    return achievements
      .filter((a) => !a.unlocked && a.progress > 0)
      .sort((a, b) => b.progress - a.progress)
      .slice(0, 3);
  }, [achievements]);

  // Stagger badge cards
  useEffect(() => {
    setVisibleBadges(new Set());
    const timers = filteredAchievements.map((_, i) =>
      setTimeout(() => setVisibleBadges((prev) => new Set([...prev, i])), i * 45)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [filteredAchievements.length]);

  const milestones = [
    { day: 7, reward: '1K Chips', unlocked: dailyStreak >= 7 },
    { day: 30, reward: '100 Diamonds', unlocked: dailyStreak >= 30 },
    { day: 100, reward: 'Exclusive Badge', unlocked: dailyStreak >= 100 },
  ];

  const hasBadges = !loading && !loadError && filteredAchievements.length > 0;

  return (
    <StandardContentLayout className="achievements-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Achievements"
        title="Achievement Archive"
        description="A Live Record Of Milestones Earned Across Play, Competition, Community, Loyalty, And Special Events, With Every Badge Still Driven By The Existing Achievement Services."
        art="diamonds"
        status="MILESTONE INDEX // LIVE"
        metrics={[
          { label: 'Unlocked', value: animatedUnlocked, tone: 'live' },
          { label: 'Total', value: animatedTotal },
          { label: 'Login Streak', value: `${dailyStreak} days`, tone: 'attention' },
        ]}
      />

      {/* ── The streak: one console, three milestone ROWS, and the heatmap ── */}
      <SpadeConsole
        className="ach-console"
        eyebrow="Rewards Circuit"
        title="Daily Login Streak"
        pill={`${dailyStreak} Days`}
        pillInk={dailyStreak > 0 ? 'gold' : 'muted'}
        foot="foot"
      >
        <p className="sc-copy">Log In Every Day To Claim Milestone Rewards!</p>

        <div className="ach-streak">
          <StreakFire streakCount={dailyStreak} size="lg" showLabel />
        </div>

        <div className="ach-rows">
          {milestones.map((m) => (
            <div className="ach-row" key={m.day}>
              <span className="ach-row__label sc-label sc-ink--blue">{m.day} Days</span>
              <span
                className={`ach-row__value ${m.unlocked ? 'sc-ink--green' : 'sc-ink--muted'}`.trim()}
              >
                {m.reward}
              </span>
            </div>
          ))}
        </div>

        <div className="ach-heatmap">
          <ActivityHeatmap
            data={heatmapData}
            label="Achievement Activity"
            colorScheme="cyan"
            weeks={18}
          />
          {heatmapData.length === 0 && (
            <p className="sc-copy sc-copy--center">Start Playing To Light Up Your Activity Grid!</p>
          )}
        </div>
      </SpadeConsole>

      {/* ── Next up: the three closest, as rows with an engraved meter ── */}
      {nextUp.length > 0 && category === 'all' && (
        <SpadeConsole
          className="ach-console"
          eyebrow="Rewards Circuit"
          title="Next Up"
          pill={`${unlockedCount}/${achievements.length}`}
          foot="foot"
        >
          {nextUp.map((achievement) => (
            <div className="ach-next" key={achievement.id}>
              <div className="ach-row ach-row--flush">
                <span className="ach-row__label sc-label sc-ink--blue">{achievement.name}</span>
                <span className="ach-row__value sc-ink--silver">{achievement.progress}%</span>
              </div>
              {/* A groove in the glass, not a bar: the master paints no meter,
                  and a "next up" list has to show how close you are. */}
              <div
                className="ach-meter"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={achievement.progress}
                aria-label={`${achievement.name} Progress`}
              >
                <div
                  className="ach-meter__fill"
                  style={{ width: `${Math.max(5, achievement.progress)}%` }}
                />
              </div>
              <p className="ach-next__note sc-label sc-ink--muted">
                {100 - achievement.progress}% Remaining For {achievement.name}
              </p>
            </div>
          ))}
        </SpadeConsole>
      )}

      {/* ── The archive: filters, order, and whatever state the list is in ── */}
      <SpadeConsole
        className="ach-console"
        eyebrow="Rewards Circuit"
        title="Your Badges"
        subtitle={CATEGORY_LABEL[category]}
        pill={`${unlockedCount}/${achievements.length}`}
        foot="foot"
      >
        {/* Five lit words on the glass. These were gradient pill chips with a
            cyan glow; nothing here has a fill, a rim or a radius, and the
            chosen one is simply lit. */}
        <div className="ach-filter" role="group" aria-label="Achievement Category">
          {(Object.keys(CATEGORY_LABEL) as AchievementCategory[]).map((cat) => (
            <button
              key={cat}
              type="button"
              className={category === cat ? 'ach-word sc-ink--blue' : 'ach-word sc-ink--muted'}
              aria-pressed={category === cat}
              onClick={() => setCategory(cat)}
            >
              {CATEGORY_LABEL[cat]} ({getCatCount(cat)})
            </button>
          ))}
        </div>

        <label className="ach-sort">
          <span className="ach-sort__label sc-label sc-ink--blue">Order</span>
          <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
            <option value="default">Default Order</option>
            <option value="rarity">Rarity</option>
            <option value="progress">Progress</option>
            <option value="recent">Recently Unlocked</option>
          </select>
        </label>

        {loading ? (
          <div className="ach-skeleton-grid">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="ach-skeleton-card" />
            ))}
          </div>
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => void loadAchievements()} />
        ) : filteredAchievements.length === 0 ? (
          <div className="ach-empty">
            <span className="sc-label sc-ink--blue">
              {category === 'all'
                ? 'No Achievements Yet'
                : `No ${CATEGORY_LABEL[category]} Achievements`}
            </span>
            <p className="sc-copy sc-copy--center">
              {category === 'all'
                ? 'Start Playing To Unlock Your First Badge!'
                : `Play More To Unlock ${CATEGORY_LABEL[category]} Achievements.`}
            </p>
          </div>
        ) : null}
      </SpadeConsole>

      {/* The badges are the badge component's own surface: each one is already
          a bordered, glowing card, so they render on the page's black ground
          rather than inside a console. A frame never sits on a frame. */}
      {hasBadges && (
        <AchievementGrid>
          {filteredAchievements.map((achievement, index) => (
            /* A DEFECT FIXED ON THE WAY: this was a bare clickable <div>, so a
               keyboard could never open an achievement's detail sheet. It
               reports itself as a button and answers Enter and Space now. The
               badge inside declares no handler of its own, so nothing nests. */
            <div
              key={achievement.id}
              role="button"
              tabIndex={0}
              aria-label={`Open ${achievement.name}`}
              className={`ach-card-wrap ${achievement.rarity ? `rarity-${achievement.rarity}` : ''}`}
              onClick={() => setSelectedAchievement(achievement)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedAchievement(achievement);
                }
              }}
              style={{
                opacity: visibleBadges.has(index) ? 1 : 0,
                transform: visibleBadges.has(index) ? 'scale(1)' : 'scale(0.85)',
                transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                cursor: 'pointer',
              }}
            >
              {/* NEW badge for recently unlocked (last 24h) */}
              {achievement.unlocked &&
                achievement.unlockedAt &&
                Date.now() - new Date(achievement.unlockedAt).getTime() < 86400000 && (
                  <span className="ach-new-badge sc-ink--green">New</span>
                )}
              <AchievementBadge
                icon={achievement.icon}
                name={achievement.name}
                description={achievement.description}
                progress={achievement.progress}
                unlocked={achievement.unlocked}
                rarity={achievement.rarity}
                unlockedAt={achievement.unlockedAt}
              />
            </div>
          ))}
        </AchievementGrid>
      )}

      {/* Achievement Detail Bottom Sheet */}
      <BottomSheet
        isOpen={!!selectedAchievement}
        onClose={() => setSelectedAchievement(null)}
        detent="half"
      >
        {selectedAchievement && (
          <div className="ach-detail">
            <span className={`ach-detail__icon sc-ink--${RARITY_INK[selectedAchievement.rarity]}`}>
              {selectedAchievement.icon}
            </span>
            <h2 className="ach-detail__name sc-ink--silver">{selectedAchievement.name}</h2>
            <p className="sc-copy sc-copy--center">{selectedAchievement.description}</p>

            <div
              className="ach-meter"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(selectedAchievement.progress)}
              aria-label="Achievement Progress"
            >
              <div
                className="ach-meter__fill"
                style={{ width: `${selectedAchievement.progress}%` }}
              />
            </div>

            <div className="ach-row ach-row--flush">
              <span className="ach-row__label sc-label sc-ink--blue">
                {Math.round(selectedAchievement.progress)}% Complete
              </span>
              <span className={`ach-row__value sc-ink--${RARITY_INK[selectedAchievement.rarity]}`}>
                {selectedAchievement.requirement}
              </span>
            </div>

            {!selectedAchievement.unlocked && selectedAchievement.progress > 0 && (
              <p className="ach-detail__note sc-label sc-ink--blue">
                Almost There. {100 - Math.round(selectedAchievement.progress)}% Remaining!
              </p>
            )}

            {selectedAchievement.unlocked ? (
              <>
                <p className="ach-detail__note sc-label sc-ink--green">
                  Unlocked On{' '}
                  {new Date(selectedAchievement.unlockedAt || Date.now()).toLocaleDateString()}
                </p>
                {/* One action, so it is a lit word on the glass: the console
                    foot paints BOTH plates and a lone one reads broken. */}
                <button
                  type="button"
                  className="ach-word sc-ink--white"
                  onClick={async () => {
                    const ach = selectedAchievement;
                    const shareText = `I just unlocked "${ach.name}" on Club Arena! ${ach.description}`;
                    try {
                      if (navigator.share) {
                        await navigator.share({
                          title: `Achievement: ${ach.name}`,
                          text: shareText,
                          url: 'https://smarter.poker',
                        });
                      } else {
                        await navigator.clipboard.writeText(shareText);
                        toast?.success('Achievement copied to clipboard!');
                      }
                    } catch (_err) {
                      // User cancelled share or clipboard failed — show share card fallback
                      setSelectedAchievement(null);
                      setTimeout(() => setSharingAchievement(ach), 300);
                    }
                  }}
                >
                  Share Achievement
                </button>
              </>
            ) : (
              <p className="ach-detail__note sc-label sc-ink--red">
                Keep Playing To Unlock This Badge!
              </p>
            )}
          </div>
        )}
      </BottomSheet>

      {/* New Achievement Unlock Popup + Confetti */}
      <ConfettiEffect active={!!newUnlock} />
      {newUnlock && (
        <div className="unlock-popup" role="status" aria-live="polite">
          <div className="unlock-content">
            <span className={`unlock-icon sc-ink--${RARITY_INK[newUnlock.rarity]}`}>
              {newUnlock.icon}
            </span>
            <span className="unlock-text">
              <span className="unlock-label sc-label sc-ink--gold">Achievement Unlocked!</span>
              <span className="unlock-name sc-ink--silver">{newUnlock.name}</span>
            </span>
          </div>
          <button
            type="button"
            className="unlock-dismiss sc-ink--muted"
            aria-label="Dismiss"
            onClick={() => setNewUnlock(null)}
          >
            ✕
          </button>
        </div>
      )}
      {/* Achievement Share Card Modal */}
      {sharingAchievement && (
        <AchievementShareCard
          icon={sharingAchievement.icon}
          name={sharingAchievement.name}
          description={sharingAchievement.description}
          rarity={sharingAchievement.rarity}
          unlockedAt={sharingAchievement.unlockedAt}
          onClose={() => setSharingAchievement(null)}
        />
      )}
    </StandardContentLayout>
  );
}
