/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Arena Stats Store (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 * User progression, streaks, and training state management
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { supabase, getAuthUser } from '@/lib/supabase';
import type {
  ArenaStats,
  TrainingSession,
  TrainingStatus,
  TrainingLevel,
} from '@/types/club.types';
import { retryAsync } from '../utils/retryAsync';
import {
  ArenaTrainingController,
  LEVELS,
  MASTERY_THRESHOLD,
  MIN_QUESTIONS,
} from '@/services/ArenaTrainingController';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// 📦 STORE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ArenaState {
  // User stats
  stats: ArenaStats | null;
  isLoadingStats: boolean;

  // Training state
  currentSession: TrainingSession | null;
  currentLevel: TrainingLevel;
  trainingStatus: TrainingStatus;
  questionsAttempted: number;
  correctAnswers: number;
  currentStreak: number;
  bestStreak: number;
  timeRemaining: number;

  // Previously completed levels (for progression map)
  unlockedLevel: number;
  completedLevels: number[];

  // Previously seen questions (Never-Repeat Law)
  previouslySeenQuestionIds: Set<string>;

  // Leak tracking
  leakSignals: Map<string, number>; // handId -> mistake count

  // Actions
  loadStats: () => Promise<void>;
  startTraining: (level: number, clubId?: string) => Promise<void>;
  recordAnswer: (
    questionId: string,
    isCorrect: boolean
  ) => Promise<{ masteryRate: number; passed: boolean }>;
  endSession: () => void;
  updateTimer: (seconds: number) => void;
  loadUnlockedLevel: () => Promise<void>;
  addLeakSignal: (handId: string) => void;
  clearLeakSignal: (handId: string) => void;
  reset: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🏪 STORE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

const initialState = {
  stats: null,
  isLoadingStats: false,
  currentSession: null,
  currentLevel: LEVELS[0],
  trainingStatus: 'idle' as TrainingStatus,
  questionsAttempted: 0,
  correctAnswers: 0,
  currentStreak: 0,
  bestStreak: 0,
  timeRemaining: 30,
  unlockedLevel: 1,
  completedLevels: [],
  previouslySeenQuestionIds: new Set<string>(),
  leakSignals: new Map<string, number>(),
};

export const useArenaStore = create<ArenaState>()(
  persist(
    (set, get) => ({
      ...initialState,

      loadStats: async () => {
        set({ isLoadingStats: true });
        try {
          const { data: user } = await getAuthUser();
          if (!user.user) return;

          // Try get_user_level_stats first, fall back to defaults if not available
          const { data, error } = await retryAsync(
            () =>
              supabase.rpc('get_user_level_stats', {
                p_user_id: user.user.id,
              }),
            3
          );

          if (error) {
            console.warn('[Store] get_user_level_stats RPC not available - using defaults');
            set({
              stats: {
                total_clubs: 0,
                active_tables: 0,
                active_players: 0,
                total_hands_24h: 0,
                biggest_pot_24h: 0,
                training_sessions_active: 0,
              },
            });
            return;
          }
          set({
            stats: data || {
              total_clubs: 0,
              active_tables: 0,
              active_players: 0,
              total_hands_24h: 0,
              biggest_pot_24h: 0,
              training_sessions_active: 0,
            },
          });
        } catch (error) {
          console.warn('[Store] Load stats failed - using defaults:', error);
          set({
            stats: {
              total_clubs: 0,
              active_tables: 0,
              active_players: 0,
              total_hands_24h: 0,
              biggest_pot_24h: 0,
              training_sessions_active: 0,
            },
          });
        } finally {
          set({ isLoadingStats: false });
        }
      },

      startTraining: async (level, clubId) => {
        const levelConfig = LEVELS.find((l) => l.level === level) || LEVELS[0];

        try {
          const session = await ArenaTrainingController.startSession(level, clubId);

          set({
            currentSession: session,
            currentLevel: levelConfig,
            trainingStatus: 'active',
            questionsAttempted: 0,
            correctAnswers: 0,
            currentStreak: 0,
            bestStreak: 0,
            timeRemaining: levelConfig.timer_seconds,
          });
        } catch (error) {
          reportError(error, 'useArenaStore.Start_training_failed');
          throw error;
        }
      },

      recordAnswer: async (questionId, isCorrect) => {
        const { currentSession } = get();

        if (!currentSession) {
          throw new Error('No active session');
        }

        // Record answer in backend
        const result = await ArenaTrainingController.recordAnswer(currentSession.id, isCorrect);

        // FIX: Use the set() updater form to capture CURRENT state, not pre-await snapshot.
        // Previously, streak/seen values were computed before the await, causing stale state
        // if two rapid recordAnswer() calls overlapped.
        set((state) => {
          const newSeenIds = new Set(state.previouslySeenQuestionIds);
          newSeenIds.add(questionId);
          const newStreak = isCorrect ? state.currentStreak + 1 : 0;
          const newBestStreak = Math.max(state.bestStreak, newStreak);

          return {
            questionsAttempted: state.questionsAttempted + 1,
            correctAnswers: state.correctAnswers + (isCorrect ? 1 : 0),
            currentStreak: newStreak,
            bestStreak: newBestStreak,
            previouslySeenQuestionIds: newSeenIds,
            trainingStatus:
              state.questionsAttempted + 1 >= MIN_QUESTIONS
                ? result.passed
                  ? 'complete'
                  : 'failed'
                : 'active',
          };
        });

        // If passed, update unlocked level
        if (result.passed) {
          set((state) => ({
            unlockedLevel: Math.max(state.unlockedLevel, state.currentLevel.level + 1),
            completedLevels: [...state.completedLevels, state.currentLevel.level],
          }));
        }

        return result;
      },

      endSession: () => {
        set({
          currentSession: null,
          trainingStatus: 'idle',
          questionsAttempted: 0,
          correctAnswers: 0,
          currentStreak: 0,
          timeRemaining: 30,
        });
      },

      updateTimer: (seconds) => {
        set({ timeRemaining: seconds });
      },

      loadUnlockedLevel: async () => {
        try {
          const { data: user } = await getAuthUser();
          if (!user.user) return;

          const level = await ArenaTrainingController.getUnlockedLevel(user.user.id);
          set({ unlockedLevel: level });
        } catch (error) {
          reportError(error, 'useArenaStore.Load_unlocked_level_failed');
        }
      },

      addLeakSignal: (handId) => {
        const { leakSignals } = get();
        const newSignals = new Map(leakSignals);
        const currentCount = newSignals.get(handId) || 0;
        newSignals.set(handId, currentCount + 1);
        set({ leakSignals: newSignals });
      },

      clearLeakSignal: (handId) => {
        const { leakSignals } = get();
        const newSignals = new Map(leakSignals);
        newSignals.delete(handId);
        set({ leakSignals: newSignals });
      },

      reset: () => {
        set({
          ...initialState,
          previouslySeenQuestionIds: new Set<string>(),
          leakSignals: new Map<string, number>(),
        });
      },
    }),
    {
      name: 'arena-stats-store',
      partialize: (state) => ({
        // Persist immutable historical data
        previouslySeenQuestionIds: Array.from(state.previouslySeenQuestionIds),
        leakSignals: Array.from(state.leakSignals.entries()),
        completedLevels: state.completedLevels,
        unlockedLevel: state.unlockedLevel,
      }),
      // Custom serialization for Set and Map
      storage: {
        getItem: (name) => {
          try {
            const str = localStorage.getItem(name);
            if (!str) return null;
            const parsed = JSON.parse(str);
            return {
              ...parsed,
              state: {
                ...parsed.state,
                previouslySeenQuestionIds: new Set(parsed.state.previouslySeenQuestionIds || []),
                leakSignals: new Map(parsed.state.leakSignals || []),
              },
            };
          } catch (e) {
            reportError(e, 'useArenaStore');
            return null;
          }
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, JSON.stringify(value));
          } catch {
            // localStorage unavailable (storage quota, private browsing, etc.)
          }
        },
        removeItem: (name) => {
          try {
            localStorage.removeItem(name);
          } catch {
            // localStorage unavailable
          }
        },
      },
    }
  )
);
