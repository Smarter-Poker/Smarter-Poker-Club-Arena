/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Arena Training Controller
 * ═══════════════════════════════════════════════════════════════════════════════
 * Training session state machine with 85% Mastery Gate enforcement
 */

import { supabase } from '@/lib/supabase';
import type {
    TrainingSession,
    TrainingStatus,
    TrainingLevel,
    TRAINING_LEVELS,
    MASTERY_GATE_THRESHOLD,
    MASTERY_MIN_QUESTIONS
} from '@/types/club.types';

// Re-export constants
export const MASTERY_THRESHOLD = 0.85;
export const MIN_QUESTIONS = 20;

// Training level configurations
export const LEVELS: TrainingLevel[] = [
    { level: 1, name: 'Foundations', description: 'Basic pre-flop scenarios', timer_seconds: 30, difficulty: 'easy', min_questions: 20, mastery_threshold: 0.85 },
    { level: 2, name: 'Position Play', description: 'Positional awareness', timer_seconds: 28, difficulty: 'easy', min_questions: 20, mastery_threshold: 0.85 },
    { level: 3, name: 'Bet Sizing', description: 'Optimal bet sizes', timer_seconds: 25, difficulty: 'medium', min_questions: 20, mastery_threshold: 0.85 },
    { level: 4, name: 'C-Bet Strategy', description: 'Continuation betting', timer_seconds: 22, difficulty: 'medium', min_questions: 20, mastery_threshold: 0.85 },
    { level: 5, name: 'Turn Decisions', description: 'Complex turn strategy', timer_seconds: 20, difficulty: 'medium', min_questions: 20, mastery_threshold: 0.85 },
    { level: 6, name: 'River Play', description: 'River value & bluffs', timer_seconds: 18, difficulty: 'hard', min_questions: 20, mastery_threshold: 0.85 },
    { level: 7, name: '3-Bet Pots', description: 'Navigating 3-bet pots', timer_seconds: 15, difficulty: 'hard', min_questions: 20, mastery_threshold: 0.85 },
    { level: 8, name: 'Multi-Way Pots', description: 'Multi-way dynamics', timer_seconds: 12, difficulty: 'expert', min_questions: 20, mastery_threshold: 0.85 },
    { level: 9, name: 'MTT Strategy', description: 'Tournament ICM', timer_seconds: 10, difficulty: 'expert', min_questions: 20, mastery_threshold: 0.85 },
    { level: 10, name: 'Elite GTO', description: 'Solver-level play', timer_seconds: 8, difficulty: 'master', min_questions: 20, mastery_threshold: 0.85 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 🎮 SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export interface TrainingState {
    session: TrainingSession | null;
    currentLevel: TrainingLevel;
    questionsAttempted: number;
    correctAnswers: number;
    score: number;
    status: TrainingStatus;
    timeRemaining: number;
    bestStreak: number;
    currentStreak: number;
}

/**
 * Initialize a new training session
 */
export async function startTrainingSession(
    level: number,
    clubId?: string
): Promise<TrainingSession> {
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) throw new Error('Authentication required');

    // Check if user has unlocked this level (85% on previous)
    if (level > 1) {
        const canAccess = await checkLevelAccess(user.user.id, level);
        if (!canAccess) {
            throw new Error(`Level ${level} is locked. Complete level ${level - 1} with 85% accuracy first.`);
        }
    }

    const levelConfig = LEVELS.find(l => l.level === level) || LEVELS[0];

    const { data, error } = await supabase
        .from('training_sessions')
        .insert({
            user_id: user.user.id,
            club_id: clubId,
            level,
            status: 'active',
            questions_attempted: 0,
            correct_answers: 0,
            score: 0,
            time_remaining: levelConfig.timer_seconds,
        })
        .select()
        .single();

    if (error) {
        console.error('🔴 Session start failed:', error);
        throw new Error('Failed to start training session');
    }

    return data;
}

/**
 * Check if user has access to a level (85% Mastery Gate)
 */
export async function checkLevelAccess(
    userId: string,
    targetLevel: number
): Promise<boolean> {
    if (targetLevel <= 1) return true;

    const { data, error } = await supabase.rpc('fn_check_level_advancement', {
        p_user_id: userId,
        p_target_level: targetLevel,
    });

    if (error) {
        console.error('🔴 Level access check failed:', error);
        // Default to locked if check fails
        return false;
    }

    return data === true;
}

/**
 * Record an answer and update session
 */
export async function recordAnswer(
    sessionId: string,
    isCorrect: boolean
): Promise<{ masteryRate: number; passed: boolean }> {
    const { data: session, error: fetchError } = await supabase
        .from('training_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (fetchError || !session) {
        throw new Error('Session not found');
    }

    const newAttempted = session.questions_attempted + 1;
    const newCorrect = session.correct_answers + (isCorrect ? 1 : 0);
    const masteryRate = newCorrect / newAttempted;

    // Check if session is complete (20 questions)
    const isComplete = newAttempted >= MIN_QUESTIONS;
    const passed = isComplete && masteryRate >= MASTERY_THRESHOLD;

    const { error: updateError } = await supabase
        .from('training_sessions')
        .update({
            questions_attempted: newAttempted,
            correct_answers: newCorrect,
            score: Math.round(masteryRate * 100),
            status: isComplete ? (passed ? 'complete' : 'failed') : 'active',
            completed_at: isComplete ? new Date().toISOString() : null,
        })
        .eq('id', sessionId);

    if (updateError) {
        console.error('🔴 Answer record failed:', updateError);
        throw new Error('Failed to record answer');
    }

    // If passed, record for level progression
    if (passed) {
        await recordSessionCompletion(sessionId, session.level, masteryRate);
    }

    return { masteryRate, passed };
}

/**
 * Record completed session and trigger rewards
 */
async function recordSessionCompletion(
    sessionId: string,
    level: number,
    masteryRate: number
): Promise<void> {
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) return;

    // Call the record_arena_session RPC for XP and Diamond rewards
    await supabase.rpc('record_arena_session', {
        p_user_id: user.user.id,
        p_session_id: sessionId,
        p_level: level,
        p_mastery_rate: masteryRate,
        p_questions_correct: Math.round(masteryRate * MIN_QUESTIONS),
        p_questions_total: MIN_QUESTIONS,
    });
}

/**
 * Get user's highest unlocked level
 */
export async function getUnlockedLevel(userId: string): Promise<number> {
    const { data, error } = await supabase
        .from('training_sessions')
        .select('level, score')
        .eq('user_id', userId)
        .eq('status', 'complete')
        .gte('score', 85)
        .order('level', { ascending: false })
        .limit(1);

    if (error || !data || data.length === 0) {
        return 1; // Default to level 1
    }

    // Return next level after highest completed
    return Math.min(data[0].level + 1, 10);
}

/**
 * Get training history for a user
 */
export async function getTrainingHistory(
    userId: string,
    limit: number = 20
): Promise<TrainingSession[]> {
    const { data, error } = await supabase
        .from('training_sessions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('🔴 History fetch failed:', error);
        throw new Error('Failed to fetch training history');
    }

    return data || [];
}

// Export controller object
export const ArenaTrainingController = {
    LEVELS,
    MASTERY_THRESHOLD,
    MIN_QUESTIONS,
    startSession: startTrainingSession,
    checkLevelAccess,
    recordAnswer,
    getUnlockedLevel,
    getTrainingHistory,
};
