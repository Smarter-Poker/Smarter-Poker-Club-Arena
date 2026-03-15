/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DAILY CHALLENGES — Extracted Component (Phase 5: Bus Listeners)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Deterministic daily challenges with real-time progress tracking.
 * Subscribes to masterBus events (TABLE_SEATED, TABLE_LEFT, HAND_COMPLETED,
 * HAND_WON, FLOP_SEEN, ALL_IN_WON) to auto-increment challenge progress.
 * Persists to Supabase `daily_challenge_progress` + localStorage fallback.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { retryAsync } from '../../utils/retryAsync';
import styles from '../../pages/HomePage.module.css';

// ═══════════════════════════════════════════════════════════════════════════════
// Challenge definitions — mapped to bus event types
// ═══════════════════════════════════════════════════════════════════════════════
interface Challenge {
  title: string;
  reward: number;
  target: number;
  eventType: string; // masterBus event that increments this challenge
}

const CHALLENGES: Challenge[] = [
  { title: 'Win 3 Hands', reward: 50, target: 3, eventType: 'HAND_WON' },
  { title: 'Play 20 Hands', reward: 30, target: 20, eventType: 'HAND_COMPLETED' },
  { title: 'Win a Pot > 100 BB', reward: 75, target: 1, eventType: 'BIG_POT_WON' },
  { title: 'Play 2 Different Tables', reward: 40, target: 2, eventType: 'TABLE_SEATED' },
  { title: 'Win 5 Hands Pre-Flop', reward: 60, target: 5, eventType: 'PREFLOP_WIN' },
  { title: 'Play for 30 Minutes', reward: 45, target: 30, eventType: 'PLAY_MINUTES' },
  { title: 'Win 2 All-In Pots', reward: 80, target: 2, eventType: 'ALL_IN_WON' },
  { title: 'See 10 Flops', reward: 25, target: 10, eventType: 'FLOP_SEEN' },
  { title: 'Win a Hand with a Flush', reward: 100, target: 1, eventType: 'FLUSH_WIN' },
];

function getDayKey(): string {
  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  return `challenges_${seed}`;
}

function getSeed(): number {
  const today = new Date();
  return today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
}

function pickChallenges(): Challenge[] {
  const seed = getSeed();
  const picked: Challenge[] = [];
  const usedIndices = new Set<number>();
  for (let i = 0; i < 3; i++) {
    let idx = (seed * (i + 7) * 7919) % CHALLENGES.length;
    while (usedIndices.has(idx)) idx = (idx + 1) % CHALLENGES.length;
    usedIndices.add(idx);
    picked.push(CHALLENGES[idx]);
  }
  return picked;
}

export default function DailyChallenges() {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [claimed, setClaimed] = useState<Record<string, boolean>>({});
  const [claimingIndex, setClaimingIndex] = useState<number | null>(null);
  const [currentDayKey, setCurrentDayKey] = useState(getDayKey());
  const [resetCounter, setResetCounter] = useState(0); // forces re-render on midnight reset
  const dayKey = currentDayKey;
  const picked = useRef(pickChallenges()); // stable across re-renders
  const tableSessionStart = useRef<number | null>(null); // for play-time tracking
  const claimingRef = useRef<Set<number>>(new Set()); // prevents double-click race
  const isMountedRef = useRef(true);
  const claimTimerRef = useRef<number | null>(null);

  // ═══════════════════════════════════════════════════════════════════════════
  // Load progress from Supabase → fallback to localStorage
  // ═══════════════════════════════════════════════════════════════════════════
  const loadProgress = useCallback(async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data, error: progressErr } = await supabase
          .from('daily_challenge_progress')
          .select('challenge_index, progress, completed')
          .eq('user_id', user.id)
          .eq('day_key', dayKey);
        if (progressErr)
          console.error('[DailyChallenges] Progress load failed:', progressErr.message);

        if (data && data.length > 0) {
          const map: Record<string, number> = {};
          const claimedMap: Record<string, boolean> = {};
          data.forEach((row: any) => {
            map[row.challenge_index] = row.progress;
            if (row.completed) claimedMap[row.challenge_index] = true;
          });
          if (!isMountedRef.current) return;
          setProgress(map);
          setClaimed(claimedMap);
          return;
        }
      }
    } catch {
      // Supabase unavailable -- fallback to localStorage
    }

    // Fallback: localStorage
    try {
      const stored = JSON.parse(localStorage.getItem(dayKey) || '{}');
      setProgress(stored);
      const storedClaimed = JSON.parse(localStorage.getItem(`${dayKey}_claimed`) || '{}');
      setClaimed(storedClaimed);
    } catch {
      localStorage.removeItem(dayKey);
    }
  }, [dayKey]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Save progress to localStorage + Supabase
  // ═══════════════════════════════════════════════════════════════════════════
  const saveProgress = useCallback(
    async (newProgress: Record<string, number>) => {
      // Always save to localStorage (instant)
      try {
        localStorage.setItem(dayKey, JSON.stringify(newProgress));
      } catch {
        /* */
      }

      // Async save to Supabase
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        const upserts = Object.entries(newProgress).map(([idx, prog]) => ({
          user_id: user.id,
          day_key: dayKey,
          challenge_index: parseInt(idx, 10),
          progress: prog,
          completed: picked.current[parseInt(idx, 10)]
            ? prog >= picked.current[parseInt(idx, 10)].target
            : false,
        }));

        if (upserts.length > 0) {
          await supabase
            .from('daily_challenge_progress')
            .upsert(upserts, { onConflict: 'user_id,day_key,challenge_index' });
        }
      } catch {
        // Silent — localStorage is the fallback
      }
    },
    [dayKey]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Increment challenge progress by event type
  // ═══════════════════════════════════════════════════════════════════════════
  const incrementByEvent = useCallback(
    (eventType: string, amount = 1) => {
      setProgress((prev) => {
        const updated = { ...prev };
        let changed = false;

        picked.current.forEach((ch, idx) => {
          if (ch.eventType === eventType) {
            const current = updated[idx] || 0;
            if (current < ch.target) {
              updated[idx] = Math.min(current + amount, ch.target);
              changed = true;
            }
          }
        });

        if (changed) {
          saveProgress(updated);
          masterBus.emit('CHALLENGE_PROGRESS_UPDATED' as any, { progress: updated });
        }
        return changed ? updated : prev;
      });
    },
    [saveProgress]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // MasterBus subscriptions for real-time challenge tracking
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    loadProgress();

    // Core game events
    const unsubHandCompleted = masterBus.subscribe('HAND_COMPLETED', () => {
      incrementByEvent('HAND_COMPLETED');
    });

    const unsubHandWon = masterBus.subscribe('HAND_WON', () => {
      incrementByEvent('HAND_WON');
    });

    const unsubFlopSeen = masterBus.subscribe('FLOP_SEEN', () => {
      incrementByEvent('FLOP_SEEN');
    });

    const unsubAllInWon = masterBus.subscribe('ALL_IN_WON', () => {
      incrementByEvent('ALL_IN_WON');
    });

    const unsubBigPot = masterBus.subscribe('BIG_POT_WON', () => {
      incrementByEvent('BIG_POT_WON');
    });

    const unsubPreflopWin = masterBus.subscribe('PREFLOP_WIN', () => {
      incrementByEvent('PREFLOP_WIN');
    });

    const unsubFlushWin = masterBus.subscribe('FLUSH_WIN', () => {
      incrementByEvent('FLUSH_WIN');
    });

    // Table session tracking
    const unsubSeated = masterBus.subscribe('TABLE_SEATED', () => {
      incrementByEvent('TABLE_SEATED');
      tableSessionStart.current = Date.now();
    });

    const unsubLeft = masterBus.subscribe('TABLE_LEFT', () => {
      // Calculate play minutes when leaving a table
      if (tableSessionStart.current) {
        const minutes = Math.floor((Date.now() - tableSessionStart.current) / 60000);
        if (minutes > 0) {
          incrementByEvent('PLAY_MINUTES', minutes);
        }
        tableSessionStart.current = null;
      }
    });

    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      unsubHandCompleted();
      unsubHandWon();
      unsubFlopSeen();
      unsubAllInWon();
      unsubBigPot();
      unsubPreflopWin();
      unsubFlushWin();
      unsubSeated();
      unsubLeft();
      if (claimTimerRef.current) clearTimeout(claimTimerRef.current);
    };
  }, [loadProgress, incrementByEvent]);

  // Phase 7 #4: Claim challenge reward
  const claimReward = useCallback(
    async (challengeIndex: number, reward: number) => {
      if (claimed[challengeIndex]) return;
      // BUG FIX: Ref-based guard prevents double-click race condition
      if (claimingRef.current.has(challengeIndex)) return;
      claimingRef.current.add(challengeIndex);
      setClaimingIndex(challengeIndex);
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          // STEP 1: Mark claimed in DB FIRST (idempotent upsert — safe to re-run)
          // This MUST happen before diamonds are incremented to prevent double-reward exploit.
          const { error: claimError } = await supabase.from('daily_challenge_progress').upsert(
            {
              user_id: user.id,
              day_key: dayKey,
              challenge_index: challengeIndex,
              progress: progress[challengeIndex] || 0,
              completed: true,
            },
            { onConflict: 'user_id,day_key,challenge_index' }
          );
          // CRITICAL: Supabase does NOT throw on errors — it returns {error}. Must check explicitly.
          if (claimError) throw claimError;

          // STEP 2: Atomically increment diamond balance (TOCTOU-safe)
          // The upsert is idempotent, so if this step fails the user can safely retry
          // and the upsert will re-run without side effects.
          const { data: rpcResult, error: diamondError } = await retryAsync(
            () =>
              supabase.rpc('increment_diamonds', {
                p_user_id: user.id,
                p_amount: reward,
              }),
            3
          );
          if (diamondError) throw diamondError;
          const newBalance = typeof rpcResult === 'number' ? rpcResult : reward;

          // STEP 3: Both DB writes confirmed — NOW lock local state
          if (!isMountedRef.current) return;
          setClaimed((prev) => {
            const next = { ...prev, [challengeIndex]: true };
            try {
              localStorage.setItem(`${dayKey}_claimed`, JSON.stringify(next));
            } catch {
              /* */
            }
            return next;
          });

          // Emit DIAMOND_BALANCE_CHANGED for header + tile badges
          masterBus.emit('DIAMOND_BALANCE_CHANGED', {
            newBalance,
            delta: reward,
            source: 'daily_challenge',
          });
        }
      } catch (err) {
        console.error('[DailyChallenges] Claim failed — user can retry:', err);
      } finally {
        // Always release claim guard (was leaking on success path before)
        claimingRef.current.delete(challengeIndex);
      }
      // Fade out animation timing — tracked for cleanup
      if (isMountedRef.current) {
        claimTimerRef.current = window.setTimeout(() => {
          if (isMountedRef.current) setClaimingIndex(null);
        }, 600);
      }
    },
    [claimed, dayKey, progress]
  );

  // Phase 7 #5: Midnight auto-reset
  useEffect(() => {
    const checkMidnight = setInterval(() => {
      const newKey = getDayKey();
      if (newKey !== currentDayKey) {
        setCurrentDayKey(newKey);
        setProgress({});
        setClaimed({});
        picked.current = pickChallenges();
        claimingRef.current.clear();
        // BUG FIX: Force re-render so new challenges display
        setResetCounter((c) => c + 1);
      }
    }, 60_000); // Check every 60 seconds
    return () => clearInterval(checkMidnight);
  }, [currentDayKey]);

  return (
    <div
      style={{
        width: '100%',
        maxWidth: 600,
        margin: '20px auto 8px',
        padding: '0 4px',
        zIndex: 10,
      }}
    >
      <h3
        style={{
          fontSize: '0.85rem',
          fontWeight: 800,
          color: 'rgba(0, 212, 255, 0.7)',
          letterSpacing: '0.15em',
          margin: '0 0 12px 4px',
          textTransform: 'uppercase',
        }}
      >
        DAILY CHALLENGES
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {picked.current.map((ch, i) => {
          const prog = progress[i] || 0;
          const pct = Math.min(100, (prog / ch.target) * 100);
          const isComplete = pct >= 100;
          return (
            <div
              key={i}
              style={{
                background: isComplete ? 'rgba(0, 255, 136, 0.06)' : 'rgba(8, 20, 40, 0.6)',
                border: isComplete
                  ? '1px solid rgba(0, 255, 136, 0.2)'
                  : '1px solid rgba(0, 212, 255, 0.1)',
                borderRadius: 10,
                padding: '12px 16px',
                backdropFilter: 'blur(8px)',
                transition: 'border-color 0.3s ease, background 0.3s ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    color: isComplete ? 'rgba(0, 255, 136, 0.95)' : 'rgba(224, 232, 240, 0.9)',
                    letterSpacing: '0.02em',
                  }}
                >
                  {isComplete ? '[DONE] ' : ''}
                  {ch.title}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {isComplete && !claimed[i] && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        claimReward(i, ch.reward);
                      }}
                      style={{
                        padding: '4px 12px',
                        fontSize: '0.7rem',
                        fontWeight: 800,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: '#000',
                        background: 'linear-gradient(90deg, #00ff88, #00d4ff)',
                        border: 'none',
                        borderRadius: 6,
                        cursor: 'pointer',
                        boxShadow: '0 0 10px rgba(0, 255, 136, 0.3)',
                        transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                        animation: claimingIndex === i ? 'claimPop 0.5s ease-out forwards' : 'none',
                      }}
                    >
                      CLAIM
                    </button>
                  )}
                  <span
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 800,
                      color: claimed[i]
                        ? 'rgba(120, 130, 140, 0.5)'
                        : isComplete
                          ? 'rgba(0, 255, 136, 0.9)'
                          : 'rgba(0, 212, 255, 0.85)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      textDecoration: claimed[i] ? 'line-through' : 'none',
                    }}
                  >
                    {claimed[i] ? 'CLAIMED' : `+${ch.reward} DIA`}
                  </span>
                </div>
              </div>
              {/* Progress counter */}
              <div
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: isComplete ? 'rgba(0, 255, 136, 0.7)' : 'rgba(176, 179, 184, 0.7)',
                  marginBottom: 5,
                  textAlign: 'right',
                }}
              >
                {Math.min(prog, ch.target)}/{ch.target}
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: 'rgba(255,255,255,0.06)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    borderRadius: 4,
                    width: `${pct}%`,
                    background: isComplete
                      ? 'linear-gradient(90deg, #00ff88, #00d4ff)'
                      : 'linear-gradient(90deg, #00d4ff, #0088ff)',
                    boxShadow: isComplete
                      ? '0 0 8px rgba(0, 255, 136, 0.4)'
                      : '0 0 6px rgba(0, 212, 255, 0.3)',
                    transition: 'width 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Phase 8 #2: All-claimed congratulations banner */}
      {picked.current.length > 0 && picked.current.every((_ch, i) => claimed[i]) && (
        <div
          style={{
            marginTop: 12,
            padding: '14px 20px',
            background: 'linear-gradient(135deg, rgba(0, 255, 136, 0.08), rgba(0, 212, 255, 0.08))',
            border: '1px solid rgba(0, 255, 136, 0.2)',
            borderRadius: 10,
            textAlign: 'center',
            animation: 'allClaimedFadeIn 0.5s ease-out',
          }}
        >
          <span
            style={{
              fontSize: '0.85rem',
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              background: 'linear-gradient(90deg, #00ff88, #00d4ff)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            All Challenges Complete
          </span>
          <div
            style={{
              fontSize: '0.7rem',
              color: 'rgba(224, 232, 240, 0.5)',
              marginTop: 4,
              fontWeight: 600,
            }}
          >
            New challenges unlock at midnight
          </div>
        </div>
      )}

      <style>{`
                @keyframes claimPop {
                    0% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.15); opacity: 0.8; }
                    100% { transform: scale(0.8); opacity: 0; }
                }
                @keyframes allClaimedFadeIn {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `}</style>
    </div>
  );
}
