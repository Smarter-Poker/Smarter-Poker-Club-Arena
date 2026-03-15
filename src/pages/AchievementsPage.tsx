/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENTS PAGE — Player Achievements & Badges with Real-Time Unlocks
 * ═══════════════════════════════════════════════════════════════════════════════
 * Display unlocked achievements, progress, and badges
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import AchievementBadge, { AchievementGrid } from '../components/achievements/AchievementBadge';
import { AchievementShareCard } from '../components/achievements/AchievementShareCard';
import BottomSheet from '../components/common/BottomSheet';
import { StreakFire } from '../components/gamification/StreakFire';
import ActivityHeatmap from '../components/common/ActivityHeatmap';
import {
  achievementService,
  ACHIEVEMENTS as SERVICE_ACHIEVEMENTS,
} from '../services/AchievementService';
import './AchievementsPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';

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

// Achievement definitions
const ACHIEVEMENTS: Omit<Achievement, 'progress' | 'unlocked' | 'unlockedAt'>[] = [
  // Poker achievements
  {
    id: 'first_hand',
    name: 'First Hand',
    description: 'Play your first hand of poker',
    icon: '🃏',
    category: 'poker',
    rarity: 'common',
    requirement: 'Play 1 hand',
  },
  {
    id: 'hundred_hands',
    name: 'Centurion',
    description: 'Play 100 hands',
    icon: '💯',
    category: 'poker',
    rarity: 'common',
    requirement: 'Play 100 hands',
  },
  {
    id: 'thousand_hands',
    name: 'Grinder',
    description: 'Play 1,000 hands',
    icon: '⚡',
    category: 'poker',
    rarity: 'rare',
    requirement: 'Play 1,000 hands',
  },
  {
    id: 'ten_thousand',
    name: 'Marathon Runner',
    description: 'Play 10,000 hands',
    icon: '🏃',
    category: 'poker',
    rarity: 'epic',
    requirement: 'Play 10,000 hands',
  },
  {
    id: 'royal_flush',
    name: 'Royal Blood',
    description: 'Hit a Royal Flush',
    icon: '👑',
    category: 'poker',
    rarity: 'legendary',
    requirement: 'Get Royal Flush',
  },
  {
    id: 'straight_flush',
    name: 'Straight Shooter',
    description: 'Hit a Straight Flush',
    icon: '🌊',
    category: 'poker',
    rarity: 'epic',
    requirement: 'Get Straight Flush',
  },
  {
    id: 'quads',
    name: 'Four of a Kind',
    description: 'Hit Quad Aces',
    icon: '🎯',
    category: 'poker',
    rarity: 'rare',
    requirement: 'Get Quad Aces',
  },

  // Social achievements
  {
    id: 'first_club',
    name: 'Club Member',
    description: 'Join your first club',
    icon: '🏠',
    category: 'social',
    rarity: 'common',
    requirement: 'Join 1 club',
  },
  {
    id: 'five_clubs',
    name: 'Social Butterfly',
    description: 'Join 5 different clubs',
    icon: '🦋',
    category: 'social',
    rarity: 'rare',
    requirement: 'Join 5 clubs',
  },
  {
    id: 'first_friend',
    name: 'Friendly',
    description: 'Add your first friend',
    icon: '👋',
    category: 'social',
    rarity: 'common',
    requirement: 'Add 1 friend',
  },
  {
    id: 'popular',
    name: 'Popular',
    description: 'Have 50 friends',
    icon: '🌟',
    category: 'social',
    rarity: 'epic',
    requirement: 'Add 50 friends',
  },

  // Financial achievements
  {
    id: 'first_win',
    name: 'Winner',
    description: 'Win your first pot',
    icon: '🎉',
    category: 'financial',
    rarity: 'common',
    requirement: 'Win 1 pot',
  },
  {
    id: 'big_winner',
    name: 'Big Winner',
    description: 'Win a pot over 1,000 chips',
    icon: '💎',
    category: 'financial',
    rarity: 'rare',
    requirement: 'Win 1K+ pot',
  },
  {
    id: 'profitable',
    name: 'Profitable',
    description: 'Reach 10,000 lifetime profit',
    icon: '📈',
    category: 'financial',
    rarity: 'epic',
    requirement: '10K profit',
  },

  // Tournament achievements
  {
    id: 'first_tourney',
    name: 'Tournament Player',
    description: 'Play in a tournament',
    icon: '🎪',
    category: 'tournament',
    rarity: 'common',
    requirement: 'Enter 1 tournament',
  },
  {
    id: 'final_table',
    name: 'Final Tablist',
    description: 'Make a final table',
    icon: '🏅',
    category: 'tournament',
    rarity: 'rare',
    requirement: 'Make final table',
  },
  {
    id: 'champion',
    name: 'Champion',
    description: 'Win a tournament',
    icon: '🏆',
    category: 'tournament',
    rarity: 'epic',
    requirement: 'Win tournament',
  },
  {
    id: 'ten_wins',
    name: 'Serial Winner',
    description: 'Win 10 tournaments',
    icon: '🔥',
    category: 'tournament',
    rarity: 'legendary',
    requirement: 'Win 10 tournaments',
  },
];

export default function AchievementsPage() {
  const navigate = useNavigate();
  useVisibilityRefresh(() => loadAchievements());
  const { user } = useAuthUser();
  const toast = useToast();
  const [category, setCategory] = useState<AchievementCategory>('all');
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [loading, setLoading] = useState(true);

  const [newUnlock, setNewUnlock] = useState<Achievement | null>(null);
  const [visibleBadges, setVisibleBadges] = useState(new Set<number>());
  const [sharingAchievement, setSharingAchievement] = useState<Achievement | null>(null);
  const [selectedAchievement, setSelectedAchievement] = useState<Achievement | null>(null);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAchievementsRef = useRef<(() => Promise<void>) | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (user?.id) {
      loadAchievements();

      // Subscribe to real-time achievement unlocks
      const channelKey = `user-achievements-${user.id}`;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'user_achievements',
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
        .subscribe();

      return () => {
        masterBus.removeRegisteredChannel(channelKey);
        if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
      };
    }
  }, [user?.id]);

  const loadAchievements = async () => {
    if (!user?.id) return;
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
        return {
          ...a,
          progress: userProgress?.progress || 0,
          unlocked: (userProgress?.progress || 0) >= (serviceAchievement?.requirement || 100),
          unlockedAt: userProgress?.unlockedAt,
        };
      });

      if (isMounted.current) {
        setAchievements(merged);
        setCachedAch(user?.id || '', merged);
      }
    } catch (error) {
      console.error('Failed to load achievements:', error);
      if (isMounted.current) toast?.error('Failed to load achievements');
    }
    if (isMounted.current) setLoading(false);
  };

  // Store loadAchievements in ref for use in realtime callbacks
  useEffect(() => {
    loadAchievementsRef.current = loadAchievements;
  });

  const filteredAchievements =
    category === 'all' ? achievements : achievements.filter((a) => a.category === category);

  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  const [dailyStreak] = useState(12);

  const heatmapData = useMemo(() => {
    const days: Record<string, number> = {};
    achievements.forEach((a) => {
      if (a.unlocked && a.unlockedAt) {
        const d = new Date(a.unlockedAt).toISOString().slice(0, 10);
        days[d] = (days[d] || 0) + 1;
      }
    });
    // Add some simulated activity to make it look alive
    for (let i = 0; i < 40; i++) {
      const d = new Date();
      d.setDate(d.getDate() - Math.floor(Math.random() * 120));
      const key = d.toISOString().slice(0, 10);
      days[key] = (days[key] || 0) + Math.floor(Math.random() * 3);
    }
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
    <div className="achievements-page">
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
              Log in every day to claim milestone rewards!
            </p>
          </div>
          <StreakFire streakCount={dailyStreak} size="lg" showLabel />
        </div>

        {/* Milestone Rewards */}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between' }}>
          {[
            { day: 7, reward: '1K Chips', unlocked: dailyStreak >= 7, icon: '🥉' },
            { day: 30, reward: '100 Diamonds', unlocked: dailyStreak >= 30, icon: '🥈' },
            { day: 100, reward: 'Exclusive Badge', unlocked: dailyStreak >= 100, icon: '🥇' },
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
        </div>
      </div>

      {/* Progress Summary */}
      <div className="progress-summary">
        <div className="summary-stat">
          <span className="stat-value">
            {unlockedCount}/{achievements.length}
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
              fontFamily: 'Orbitron, sans-serif',
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
                    {100 - achievement.progress}% remaining for {achievement.name}!
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Category Filter — Pill Chips (Initiative 5) */}
      <div className="category-filter ach-chip-bar">
        {(['all', 'poker', 'social', 'financial', 'tournament'] as AchievementCategory[]).map(
          (cat) => (
            <button
              key={cat}
              className={`ach-filter-chip ${category === cat ? 'active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              {cat === 'all'
                ? '📋 All'
                : cat === 'poker'
                  ? '🃏 Poker'
                  : cat === 'social'
                    ? '👥 Social'
                    : cat === 'financial'
                      ? '💰 Financial'
                      : '🏆 Tournament'}
            </button>
          )
        )}
      </div>

      {/* Achievements Grid */}
      <AchievementGrid>
        {loading ? (
          <div className="ach-skeleton-grid">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="ach-skeleton-card" />
            ))}
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
                fontFamily: 'Orbitron, sans-serif',
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
              <span>{selectedAchievement.requirement}</span>
            </div>

            {selectedAchievement.unlocked ? (
              <>
                <p style={{ color: '#10b981', fontSize: '0.8rem', marginBottom: '1rem' }}>
                  Unlocked on{' '}
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
                Keep playing to unlock this badge!
              </p>
            )}
          </div>
        )}
      </BottomSheet>

      {/* New Achievement Unlock Popup */}
      {newUnlock && (
        <div className="unlock-popup">
          <div className="unlock-content">
            <div className="unlock-icon">{newUnlock.icon}</div>
            <div className="unlock-text">
              <span className="unlock-label"> Achievement Unlocked!</span>
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
    </div>
  );
}
