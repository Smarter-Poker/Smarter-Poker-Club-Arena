/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FRIEND CHALLENGE MODAL — Challenge friends to streak/mission competitions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
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
    icon: '🔥',
    duration: 7,
  },
  {
    id: 'mission_race',
    label: 'Mission Race',
    description: 'Complete the most missions in the next 3 days!',
    icon: '🎯',
    duration: 3,
  },
  {
    id: 'spin_master',
    label: 'Spin Master',
    description: 'Spin the wheel every day for 5 days straight!',
    icon: '🎰',
    duration: 5,
  },
  {
    id: 'hand_grinder',
    label: 'Hand Grinder',
    description: 'Play the most hands in 7 days!',
    icon: '🃏',
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
    <div className="fcm-overlay" onClick={onClose}>
      <div className="fcm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fcm-header">
          <h3>Challenge {challengeeName}</h3>
          <button className="fcm-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="fcm-types">
          {CHALLENGE_TYPES.map((type) => (
            <button
              key={type.id}
              className={`fcm-type-card ${selectedType === type.id ? 'fcm-selected' : ''}`}
              onClick={() => setSelectedType(type.id)}
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

        <button className="fcm-send-btn" disabled={!selectedType || sending} onClick={handleSend}>
          {sending ? 'Sending...' : 'Send Challenge'}
        </button>
      </div>
    </div>
  );
}
