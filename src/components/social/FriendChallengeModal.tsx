/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FRIEND CHALLENGE MODAL — Challenge friends to streak/mission competitions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import './FriendChallengeModal.css';
import { reportError } from '../../utils/errorReporter';

interface FriendChallengeModalProps {
  isOpen: boolean;
  onClose: () => void;
  challengerId: string;
  challengeeId: string;
  challengeeName: string;
}

const CHALLENGE_TYPES = [
  {
    id: 'streak_battle',
    label: 'Streak Battle',
    description: 'Who can build the longest daily login streak this week?',
    icon: '▲',
    duration: 7,
  },
  {
    id: 'mission_race',
    label: 'Mission Race',
    description: 'Complete the most missions in the next 3 days!',
    icon: '◎',
    duration: 3,
  },
  {
    id: 'spin_master',
    label: 'Spin Master',
    description: 'Spin the wheel every day for 5 days straight!',
    icon: '▦',
    duration: 5,
  },
  {
    id: 'hand_grinder',
    label: 'Hand Grinder',
    description: 'Play the most hands in 7 days!',
    icon: '♠',
    duration: 7,
  },
];

export default function FriendChallengeModal({
  isOpen,
  onClose,
  challengerId,
  challengeeId,
  challengeeName,
}: FriendChallengeModalProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const isMounted = useIsMounted();
  const toast = useToast();
  const trapRef = useFocusTrap(isOpen);

  useEffect(() => {
    if (!isOpen) {
      setSelectedType(null);
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose, sending]);

  if (!isOpen) return null;

  const handleSend = async () => {
    if (!selectedType) return;
    setSending(true);

    const challenge = CHALLENGE_TYPES.find((c) => c.id === selectedType);
    if (!challenge) {
      setSending(false);
      return;
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + challenge.duration);

    try {
      const { error } = await supabase.from('friend_challenges').insert({
        challenger_id: challengerId,
        challengee_id: challengeeId,
        challenge_type: selectedType,
        target_value: challenge.duration,
        challenger_progress: 0,
        challengee_progress: 0,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
      });

      if (error) throw error;
      masterBus.emit('NOTIFICATION_RECEIVED', {
        notification: {
          type: 'friend_challenge_sent',
          title: 'Challenge Sent',
          message: `You challenged ${challengeeName} to ${challenge.label}!`,
        },
      });
      if (!isMounted.current) return;
      toast.success(`Challenge sent to ${challengeeName}!`);
      onClose();
    } catch (err: any) {
      reportError(err, 'FriendChallengeModal.send_error');
      if (isMounted.current) toast.error(err.message || 'Failed to send challenge');
    }
    if (isMounted.current) setSending(false);
  };

  return (
    <div className="fcm-overlay" onClick={sending ? undefined : onClose}>
      <div
        ref={trapRef}
        className="fcm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="friend-challenge-title"
        aria-describedby="friend-challenge-description"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fcm-header">
          <div>
            <span>Head-To-Head Protocol</span>
            <h3 id="friend-challenge-title">Challenge {challengeeName}</h3>
          </div>
          <button
            className="fcm-close"
            type="button"
            onClick={onClose}
            aria-label="Close Challenge Dialog"
            disabled={sending}
          >
            ✕
          </button>
        </div>

        <p id="friend-challenge-description" className="fcm-description">
          Select A Verified Challenge Format. Progress Stays Connected To Live Play And Mission
          Data.
        </p>

        <div className="fcm-types">
          {CHALLENGE_TYPES.map((type) => (
            <button
              key={type.id}
              className={`fcm-type-card ${selectedType === type.id ? 'fcm-selected' : ''}`}
              onClick={() => setSelectedType(type.id)}
              type="button"
              aria-pressed={selectedType === type.id}
            >
              <span className="fcm-type-icon">{type.icon}</span>
              <div className="fcm-type-info">
                <span className="fcm-type-label">{type.label}</span>
                <span className="fcm-type-desc">{type.description}</span>
              </div>
              <span className="fcm-type-duration">{type.duration}d</span>
            </button>
          ))}
        </div>

        <button
          className="fcm-send-btn"
          type="button"
          disabled={!selectedType || sending}
          onClick={handleSend}
        >
          {sending ? 'Sending...' : 'Send Challenge'}
        </button>
      </div>
    </div>
  );
}
