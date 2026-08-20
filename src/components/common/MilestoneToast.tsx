/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MILESTONE TOAST — Animated popup when milestones/achievements unlock
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Subscribes to MILESTONE_UNLOCKED bus events and displays a premium
 * animated toast notification that auto-dismisses after 5 seconds.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { soundService, haptic } from '../../services/SoundService';
import './MilestoneToast.css';

interface MilestoneNotification {
  id: string;
  title: string;
  description: string;
  icon: string;
  reward?: string;
}

export const MilestoneToast: React.FC = () => {
  const [notifications, setNotifications] = useState<MilestoneNotification[]>([]);
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    const timer = timerRefs.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timerRefs.current.delete(id);
    }
  }, []);

  useMasterBusSubscription('MILESTONE_UNLOCKED', (data: any) => {
    if (!data) return;

    const notification: MilestoneNotification = {
      id: `milestone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: data.title || data.milestoneName || 'Milestone Unlocked!',
      description: data.description || data.message || 'You reached a new milestone!',
      icon: data.icon || 'Trophy',
      reward: data.reward || data.rewardText,
    };

    setNotifications((prev) => [...prev.slice(-4), notification]); // Max 5 at a time

    // ANIMATION/SOUND AUDIT 2026-08-20: this played playTimeBankActivated —
    // the URGENT chime that means "your clock ran out and your time bank just
    // started burning". Hearing your own stress cue at the moment you unlock an
    // achievement is not a small mismatch; it is the wrong emotion entirely,
    // and at a table it reads as a time-bank alarm for a hand you are not even
    // in. playAchievement is the bright celebratory sparkle written for this.
    //
    // The haptic stays, but the gate coalesces it with playAchievement's own,
    // so this is one buzz rather than two (see src/utils/vibrationGate.ts).
    soundService.playAchievement();
    haptic.medium();

    // Auto-dismiss after 5 seconds
    const timerId = setTimeout(() => {
      dismissNotification(notification.id);
    }, 5000);
    timerRefs.current.set(notification.id, timerId);
  });

  useEffect(() => {
    return () => {
      // Clean up all active timers on unmount
      timerRefs.current.forEach((timer) => clearTimeout(timer));
      timerRefs.current.clear();
    };
  }, []);

  if (notifications.length === 0) return null;

  return (
    <div className="milestone-toast-container">
      {notifications.map((n, i) => (
        <div
          key={n.id}
          className="milestone-toast"
          style={{ animationDelay: `${i * 100}ms` }}
          onClick={() => dismissNotification(n.id)}
        >
          <div className="milestone-toast__icon">{n.icon}</div>
          <div className="milestone-toast__content">
            <div className="milestone-toast__title">{n.title}</div>
            <div className="milestone-toast__description">{n.description}</div>
            {n.reward && <div className="milestone-toast__reward">Reward: {n.reward}</div>}
          </div>
          <div className="milestone-toast__progress" />
        </div>
      ))}
    </div>
  );
};

export default MilestoneToast;
