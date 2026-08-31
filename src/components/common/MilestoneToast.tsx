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
import './MilestoneToast.css';
import { formatPopupText } from '../../utils/popupStyle';

/**
 * BUNDLE PASS 2026-08-24: SoundService was a STATIC import here. This component
 * is mounted app-wide in App.tsx and renders nothing until a milestone unlocks,
 * yet that one import welded ~87KB of source (the whole audio engine and its
 * sample map) into the entry chunk that every single boot must download and
 * parse. Loading it inside the handler moves that cost to the first unlock —
 * an event that is already celebratory and already tolerates a few hundred ms.
 *
 * The import is cached by the module registry, so unlock #2 onward is free.
 */
async function playMilestoneFeedback(): Promise<void> {
  try {
    const { soundService, haptic } = await import('../../services/SoundService');
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
  } catch {
    // Audio is decoration. A failed chunk fetch must never stop the toast.
  }
}

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
      description: data.description || data.message || 'You Reached A New Milestone!',
      icon: data.icon || 'Trophy',
      reward: data.reward || data.rewardText,
    };

    setNotifications((prev) => [...prev.slice(-4), notification]); // Max 5 at a time

    // Sound + haptic load on demand — see playMilestoneFeedback above.
    void playMilestoneFeedback();

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
            {/* formatPopupText: this popup does not go through the Toast
                provider, so the house rule (Title Case, no em dashes - see
                CLAUDE.md 5.7 and src/utils/popupStyle.ts) is applied here, the
                same way MysteryBountyCelebration does it. The text is
                bus-supplied, so it is never pre-formatted. */}
            <div className="milestone-toast__title">{formatPopupText(n.title)}</div>
            <div className="milestone-toast__description">{formatPopupText(n.description)}</div>
            {n.reward && (
              <div className="milestone-toast__reward">Reward: {formatPopupText(n.reward)}</div>
            )}
          </div>
          <div className="milestone-toast__progress" />
        </div>
      ))}
    </div>
  );
};

export default MilestoneToast;
