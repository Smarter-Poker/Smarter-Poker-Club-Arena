/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENTS PAGE — Player Achievements & Badges with Real-Time Unlocks
 * ═══════════════════════════════════════════════════════════════════════════════
 * Display unlocked achievements, progress, and badges
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
import { reportError } from '../utils/errorReporter';
import { ErrorState } from '../components/common/EmptyState';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';

type SortMode = 'default' | 'rarity' | 'progress' | 'recent';
const RARITY_ORDER: Record<string, number> = { legendary: 0, epic: 1, rare: 2, common: 3 };

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
    requirement: 'Play 100 hands',
  },
  {
    id: 'hands_1000',
    name: 'Regular',
    description: 'Play 1,000 Hands',
    icon: '◆',
    category: 'poker',
    rarity: 'rare',
    requirement: 'Play 1,000 hands',
  },
  {
    id: 'hands_10000',
    name: 'Grinder',
    description: 'Play 10,000 Hands',
    icon: '▲',
    category: 'poker',
    rarity: 'epic',
    requirement: 'Play 10,000 hands',
  },
  {
    id: 'hands_100000',
    name: 'Professional',
    description: 'Play 100,000 Hands',
    icon: '◆',
    category: 'poker',
    rarity: 'legendary',
    requirement: 'Play 100,000 hands',
  },

  // ── Wins ──
  {
    id: 'wins_10',
    name: 'First Blood',
    description: 'Win 10 Hands',
    icon: '☆',
    category: 'poker',
    rarity: 'common',
    requirement: 'Win 10 hands',
  },
  {
    id: 'wins_100',
    name: 'Winner',
    description: 'Win 100 Hands',
    icon: '★',
    category: 'poker',
    rarity: 'rare',
    requirement: 'Win 100 hands',
  },
  {
    id: 'wins_1000',
    name: 'Dominator',
    description: 'Win 1,000 Hands',
    icon: '▲',
    category: 'poker',
    rarity: 'epic',
    requirement: 'Win 1,000 hands',
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
    name: 'Four of a Kind',
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
    requirement: 'Add 5 friends',
  },
  {
    id: 'friends_25',
    name: 'Popular',
    description: 'Add 25 Friends',
    icon: '★',
    category: 'social',
    rarity: 'rare',
    requirement: 'Add 25 friends',
  },
  {
    id: 'clubs_3',
    name: 'Club Hopper',
    description: 'Join 3 Clubs',
    icon: '⌂',
    category: 'social',
    rarity: 'common',
    requirement: 'Join 3 clubs',
  },

  // ── Financial ──
  {
    id: 'profit_1000',
    name: 'In the Green',
    description: 'Profit 1,000 Chips',
    icon: '▲',
    category: 'financial',
    rarity: 'rare',
    requirement: 'Profit 1K chips',
  },
  {
    id: 'profit_10000',
    name: 'High Roller',
    description: 'Profit 10,000 Chips',
    icon: '◆',
    category: 'financial',
    rarity: 'epic',
    requirement: 'Profit 10K chips',
  },
  {
    id: 'biggest_pot_500',
    name: 'Big Pot',
    description: 'Win A 500+ Chip Pot',
    icon: '★',
    category: 'financial',
    rarity: 'rare',
    requirement: 'Win 500+ pot',
  },

  // ── Tournament ──
  {
    id: 'tourney_win_1',
    name: 'Champion',
    description: 'Win A Tournament',
    icon: '★',
    category: 'tournament',
    rarity: 'epic',
    requirement: 'Win tournament',
  },
  {
    id: 'tourney_top3_10',
    name: 'Consistent',
    description: 'Finish Top 3 In 10 Tournaments',
    icon: '◆',
    category: 'tournament',
    rarity: 'rare',
    requirement: 'Top 3 x10',
  },
  {
    id: 'tourney_played_50',
    name: 'Tournament Regular',
    description: 'Play 50 Tournaments',
    icon: '◆',
    category: 'tournament',
    rarity: 'rare',
    requirement: 'Play 50 tournaments',
  },

  // ── Streaks ──
  {
    id: 'streak_7',
    name: 'Weekly Warrior',
    description: 'Log In 7 Days In A Row',
    icon: '▲',
    category: 'social',
    rarity: 'common',
    requirement: '7-day streak',
  },
  {
    id: 'streak_30',
    name: 'Monthly Grinder',
    description: 'Log In 30 Days In A Row',
    icon: '▤',
    category: 'social',
    rarity: 'rare',
    requirement: '30-day streak',
  },
  {
    id: 'streak_100',
    name: 'Centurion',
    description: 'Log In 100 Days In A Row',
    icon: '◆',
    category: 'social',
    rarity: 'legendary',
    requirement: '100-day streak',
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

  const getRarityColor = (rarity: string): string => {
    switch (rarity) {
      case 'legendary':
        return '#ff9800';
      case 'epic':
        return '#9c27b0';
      case 'rare':
        return '#2196f3';
      default:
        return '#9e9e9e';
    }
  };

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
      {/* ═══════════════════════════════════════════════════════════════════════
                 STREAK & ACTIVITY HEADER (Initiative 14)
          ═══════════════════════════════════════════════════════════════════════ */}
      <div
        className="streak-activity-header"
        style={{
          background: 'linear-gradient(145deg, rgba(8, 20, 40, 0.7), rgba(5, 12, 28, 0.9))',
          border: '1px solid rgba(0, 212, 255, 0.1)',
          borderRadius: '16px',
          padding: '1.5rem',
          marginBottom: '1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: '1.25rem',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              Daily Login Streak
            </h2>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Log In Every Day To Claim Milestone Rewards!
            </p>
          </div>
          <StreakFire streakCount={dailyStreak} size="lg" showLabel />
        </div>

        {/* Milestone Rewards */}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between' }}>
          {[
            { day: 7, reward: '1K Chips', unlocked: dailyStreak >= 7, icon: '☆' },
            { day: 30, reward: '100 Diamonds', unlocked: dailyStreak >= 30, icon: '☆' },
            { day: 100, reward: 'Exclusive Badge', unlocked: dailyStreak >= 100, icon: '★' },
          ].map((m) => (
            <div
              key={m.day}
              style={{
                flex: 1,
                background: m.unlocked ? 'rgba(16, 185, 129, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${m.unlocked ? 'rgba(16, 185, 129, 0.3)' : 'rgba(255,255,255,0.05)'}`,
                borderRadius: '12px',
                padding: '0.75rem',
                textAlign: 'center',
                opacity: m.unlocked ? 1 : 0.6,
              }}
            >
              <div
                style={{
                  fontSize: '1.5rem',
                  filter: m.unlocked
                    ? 'drop-shadow(0 0 10px rgba(16,185,129,0.5))'
                    : 'grayscale(1)',
                }}
              >
                {m.icon}
              </div>
              <div
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: m.unlocked ? '#10b981' : '#cbd5e1',
                  marginTop: '0.25rem',
                }}
              >
                {m.day} DAYS
              </div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{m.reward}</div>
            </div>
          ))}
        </div>

        {/* Heatmap */}
        <div
          style={{
            paddingTop: '1rem',
            borderTop: '1px solid rgba(255,255,255,0.05)',
            overflowX: 'auto',
          }}
        >
          <ActivityHeatmap
            data={heatmapData}
            label="Achievement Activity"
            colorScheme="cyan"
            weeks={18}
          />
          {heatmapData.length === 0 && (
            <p
              style={{
                textAlign: 'center',
                color: 'rgba(255,255,255,0.3)',
                fontSize: '0.8rem',
                margin: '0.5rem 0 0',
                fontStyle: 'italic',
              }}
            >
              Start Playing To Light Up Your Activity Grid!
            </p>
          )}
        </div>
      </div>

      {/* Progress Summary — Animated Counter */}
      <div className="progress-summary">
        <div className="summary-stat">
          <span className="stat-value">
            {animatedUnlocked}/{animatedTotal}
          </span>
          <span className="stat-label">Unlocked</span>
        </div>
      </div>

      {/* Next Up Section */}
      {nextUp.length > 0 && category === 'all' && (
        <div className="next-up-section">
          <h3
            className="section-title"
            style={{
              fontSize: '1rem',
              color: '#00d4ff',
              marginBottom: '1rem',
              fontFamily: 'Rajdhani, sans-serif',
            }}
          >
            Next Up
          </h3>
          <div className="next-up-list">
            {nextUp.map((achievement, index) => (
              <div
                key={achievement.id}
                className="next-up-card"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <div className="next-up-icon">{achievement.icon}</div>
                <div className="next-up-info">
                  <h4>{achievement.name}</h4>
                  <div className="next-up-progress-bar">
                    <div
                      className="next-up-progress-fill"
                      style={{ width: `${Math.max(5, achievement.progress)}%` }}
                    ></div>
                  </div>
                  <p className="next-up-motivational">
                    {100 - achievement.progress}% Remaining For {achievement.name}!
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Category Filter — Pill Chips with Counts */}
      <div className="category-filter ach-chip-bar">
        {(['all', 'poker', 'social', 'financial', 'tournament'] as AchievementCategory[]).map(
          (cat) => {
            const label =
              cat === 'all'
                ? 'All'
                : cat === 'poker'
                  ? 'Poker'
                  : cat === 'social'
                    ? 'Social'
                    : cat === 'financial'
                      ? 'Financial'
                      : 'Tournament';
            return (
              <button
                key={cat}
                className={`ach-filter-chip ${category === cat ? 'active' : ''}`}
                onClick={() => setCategory(cat)}
              >
                {label}
                <span
                  style={{
                    marginLeft: '4px',
                    fontSize: '0.7rem',
                    opacity: 0.7,
                    fontWeight: 400,
                  }}
                >
                  ({getCatCount(cat)})
                </span>
              </button>
            );
          }
        )}
      </div>

      {/* Sort Dropdown */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: '0.75rem',
          paddingRight: '0.25rem',
        }}
      >
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px',
            color: '#cbd5e1',
            padding: '6px 12px',
            fontSize: '0.8rem',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value="default">Default Order</option>
          <option value="rarity">Rarity ↓</option>
          <option value="progress">Progress ↓</option>
          <option value="recent">Recently Unlocked</option>
        </select>
      </div>

      {/* Achievements Grid */}
      <AchievementGrid>
        {loading ? (
          <div className="ach-skeleton-grid">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="ach-skeleton-card" />
            ))}
          </div>
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => void loadAchievements()} />
        ) : filteredAchievements.length === 0 ? (
          <div className="empty-state" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
            <span
              style={{
                fontSize: '2.5rem',
                display: 'block',
                marginBottom: '0.75rem',
                opacity: 0.5,
              }}
            >
              ★
            </span>
            <p style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
              {category === 'all'
                ? 'No Achievements Yet'
                : `No ${category.charAt(0).toUpperCase() + category.slice(1)} Achievements`}
            </p>
            <p style={{ color: 'var(--soft-white, #B0B3B8)', fontSize: '0.85rem', margin: 0 }}>
              {category === 'all'
                ? 'Start Playing To Unlock Your First Badge!'
                : `Play More To Unlock ${category} Achievements.`}
            </p>
          </div>
        ) : (
          filteredAchievements.map((achievement, index) => (
            <div
              key={achievement.id}
              className={`ach-card-wrap ${achievement.rarity ? `rarity-${achievement.rarity}` : ''}`}
              onClick={() => setSelectedAchievement(achievement)}
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
                  <span className="ach-new-badge">NEW</span>
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
          ))
        )}
      </AchievementGrid>

      {/* Achievement Detail Bottom Sheet */}
      <BottomSheet
        isOpen={!!selectedAchievement}
        onClose={() => setSelectedAchievement(null)}
        detent="half"
      >
        {selectedAchievement && (
          <div className="achievement-detail-view" style={{ textAlign: 'center', padding: '1rem' }}>
            <div
              style={{
                fontSize: '4rem',
                filter: `drop-shadow(0 0 20px ${getRarityColor(selectedAchievement.rarity)}88)`,
              }}
            >
              {selectedAchievement.icon}
            </div>
            <h2
              style={{
                fontSize: '1.5rem',
                color: '#fff',
                margin: '1rem 0 0.5rem',
                fontFamily: 'Rajdhani, sans-serif',
              }}
            >
              {selectedAchievement.name}
            </h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
              {selectedAchievement.description}
            </p>

            <div className="next-up-progress-bar" style={{ marginBottom: '1rem' }}>
              <div
                className="next-up-progress-fill"
                style={{
                  width: `${selectedAchievement.progress}%`,
                  background: getRarityColor(selectedAchievement.rarity),
                }}
              ></div>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                color: '#cbd5e1',
                fontSize: '0.85rem',
                marginBottom: '2rem',
              }}
            >
              <span>{Math.round(selectedAchievement.progress)}% Complete</span>
              <span style={{ textTransform: 'capitalize' }}>{selectedAchievement.requirement}</span>
            </div>
            {!selectedAchievement.unlocked && selectedAchievement.progress > 0 && (
              <p
                style={{
                  color: '#00d4ff',
                  fontSize: '0.8rem',
                  marginBottom: '1rem',
                  background: 'rgba(0, 212, 255, 0.06)',
                  padding: '0.6rem 1rem',
                  borderRadius: '8px',
                  border: '1px solid rgba(0, 212, 255, 0.1)',
                }}
              >
                Almost There - {100 - Math.round(selectedAchievement.progress)}% Remaining!
              </p>
            )}

            {selectedAchievement.unlocked ? (
              <>
                <p style={{ color: '#10b981', fontSize: '0.8rem', marginBottom: '1rem' }}>
                  Unlocked On{' '}
                  {new Date(selectedAchievement.unlockedAt || Date.now()).toLocaleDateString()}
                </p>
                <button
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
                  style={{
                    width: '100%',
                    padding: '0.85rem',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, #00d4ff 0%, #0066aa 100%)',
                    border: 'none',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: '1rem',
                    cursor: 'pointer',
                    boxShadow: '0 4px 15px rgba(0, 212, 255, 0.4)',
                  }}
                >
                  Share Achievement
                </button>
              </>
            ) : (
              <p
                style={{
                  color: '#ef4444',
                  fontSize: '0.85rem',
                  fontStyle: 'italic',
                  padding: '1rem',
                  background: 'rgba(239, 68, 68, 0.1)',
                  borderRadius: '8px',
                }}
              >
                Keep Playing To Unlock This Badge!
              </p>
            )}
          </div>
        )}
      </BottomSheet>

      {/* New Achievement Unlock Popup + Confetti */}
      <ConfettiEffect active={!!newUnlock} />
      {newUnlock && (
        <div className="unlock-popup">
          <div className="unlock-content">
            <div className="unlock-icon">{newUnlock.icon}</div>
            <div className="unlock-text">
              <span className="unlock-label">Achievement Unlocked!</span>
              <span className="unlock-name">{newUnlock.name}</span>
            </div>
          </div>
          <button className="unlock-dismiss" onClick={() => setNewUnlock(null)}>
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
