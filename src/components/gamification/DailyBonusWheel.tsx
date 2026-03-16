/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DAILY BONUS WHEEL — Spin-to-Win Daily Reward
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { useIsMounted } from '../../hooks/useIsMounted';
import './DailyBonusWheel.css';
import { retryAsync } from '../../utils/retryAsync';

interface DailyBonusWheelProps {
  isOpen: boolean;
  onClose: () => void;
  onReward?: (reward: WheelReward) => void;
}

interface WheelReward {
  type: 'chips' | 'diamonds' | 'vip_time';
  amount: number;
  label: string;
  color: string;
}

const WHEEL_PRIZES: WheelReward[] = [
  { type: 'chips', amount: 100, label: '100 ', color: '#22c55e' },
  { type: 'chips', amount: 200, label: '200 🪙', color: '#22c55e' },
  { type: 'chips', amount: 250, label: '250 ', color: '#22c55e' },
  { type: 'diamonds', amount: 5, label: '5 ', color: '#a855f7' },
  { type: 'chips', amount: 500, label: '500 ', color: '#22c55e' },
  { type: 'chips', amount: 750, label: '750 🪙', color: '#22c55e' },
  { type: 'chips', amount: 1000, label: '1K ', color: '#fbbf24' },
  { type: 'diamonds', amount: 25, label: '25 ', color: '#a855f7' },
];

export function DailyBonusWheel({ isOpen, onClose, onReward }: DailyBonusWheelProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const wheelRef = useRef<HTMLDivElement>(null);

  const [canSpin, setCanSpin] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<WheelReward | null>(null);
  const [rotation, setRotation] = useState(0);
  const isMounted = useIsMounted();
  const spinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup spin timer on unmount
  useEffect(() => {
    return () => {
      if (spinTimerRef.current) clearTimeout(spinTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (isOpen && user?.id) {
      checkSpinAvailability();
    }
  }, [isOpen, user?.id]);

  const checkSpinAvailability = async () => {
    if (!user?.id) return;

    try {
      const { data, error: spinCheckErr } = await supabase
        .from('daily_spins')
        .select('created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (spinCheckErr) console.error('[DailyBonusWheel] Spin check failed:', spinCheckErr.message);

      if (data) {
        const lastSpin = new Date(data.created_at);
        const now = new Date();
        const hoursSince = (now.getTime() - lastSpin.getTime()) / (1000 * 60 * 60);
        if (isMounted.current) setCanSpin(hoursSince >= 24);
      } else {
        if (isMounted.current) setCanSpin(true);
      }
    } catch (err) {
      console.error('[DailyBonusWheel] Error:', err);
      if (isMounted.current) setCanSpin(true);
    }
  };

  const spin = async () => {
    if (!user?.id || !canSpin || spinning) return;

    setSpinning(true);
    setResult(null);

    // Determine prize (weighted random)
    const prizeIndex = Math.floor(Math.random() * WHEEL_PRIZES.length);
    const prize = WHEEL_PRIZES[prizeIndex];

    // Calculate rotation
    const segmentAngle = 360 / WHEEL_PRIZES.length;
    const targetAngle = prizeIndex * segmentAngle;
    const spins = 5 + Math.random() * 3;
    const finalRotation = rotation + spins * 360 + (360 - targetAngle);

    setRotation(finalRotation);

    // Wait for animation
    spinTimerRef.current = setTimeout(async () => {
      if (!isMounted.current) return;
      setResult(prize);
      setSpinning(false);
      setCanSpin(false);

      // Record spin and grant reward
      try {
        const { error: spinErr } = await supabase.from('daily_spins').insert({
          user_id: user.id,
          reward_type: prize.type,
          reward_amount: prize.amount,
        });

        if (spinErr) throw spinErr;

        // Grant reward
        const { error: rewardErr } = await retryAsync(
          () =>
            supabase.rpc('fn_grant_daily_reward', {
              p_user_id: user.id,
              p_reward_type: prize.type,
              p_reward_amount: prize.amount,
            }),
          3
        );
        if (rewardErr) {
          console.error('[DailyBonusWheel] fn_grant_daily_reward failed:', rewardErr.message);
          toast.error('Reward failed to apply — please contact support');
          return;
        }

        toast.success(` You won ${prize.label}!`);
        onReward?.(prize);
      } catch (error) {
        console.error('Failed to record spin:', error);
      }
    }, 4000);
  };

  // Escape-to-close keyboard handler
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="bonus-wheel-overlay" onClick={onClose}>
      <div className="bonus-wheel" onClick={(e) => e.stopPropagation()}>
        <div className="bonus-wheel__header">
          <h3> Daily Bonus</h3>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="bonus-wheel__container">
          <div className="wheel-pointer">▼</div>
          <div
            ref={wheelRef}
            className="wheel"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: spinning ? 'transform 4s cubic-bezier(0.2, 0.8, 0.3, 1)' : 'none',
            }}
          >
            {WHEEL_PRIZES.map((prize, idx) => {
              const angle = (idx * 360) / WHEEL_PRIZES.length;
              return (
                <div
                  key={idx}
                  className="wheel-segment"
                  style={{
                    transform: `rotate(${angle}deg)`,
                    backgroundColor: prize.color,
                  }}
                >
                  <span className="prize-label">{prize.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {result && (
          <div className="bonus-wheel__result">
            You won <strong>{result.label}</strong>!
          </div>
        )}

        <button className="bonus-wheel__spin" onClick={spin} disabled={!canSpin || spinning}>
          {spinning ? 'Spinning...' : canSpin ? 'SPIN!' : 'Come back tomorrow!'}
        </button>
      </div>
    </div>
  );
}

export default DailyBonusWheel;
