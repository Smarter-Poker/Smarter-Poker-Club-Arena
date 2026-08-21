/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SCHEDULED MESSAGE UI — Q3: Club Admin Message Scheduling
 * ═══════════════════════════════════════════════════════════════════════════════
 * Allows club admins to compose and schedule announcements for future delivery.
 * Shows pending scheduled messages with cancel option.
 */

import { useState, useEffect, useCallback } from 'react';
import { messagingService } from '../../services/MessagingService';
import styles from './ScheduledMessagePanel.module.css';

interface ScheduledMessagePanelProps {
  conversationId: string;
  senderId: string;
  onClose: () => void;
  onScheduled?: () => void;
}

export default function ScheduledMessagePanel({
  conversationId,
  senderId,
  onClose,
  onScheduled,
}: ScheduledMessagePanelProps) {
  const [content, setContent] = useState('');
  const [sendDate, setSendDate] = useState('');
  const [sendTime, setSendTime] = useState('');
  const [scheduled, setScheduled] = useState<
    Array<{ id: string; content: string; sendAt: string; status: string }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadScheduled = useCallback(async () => {
    const data = await messagingService.getScheduledMessages(conversationId);
    setScheduled(data);
  }, [conversationId]);

  useEffect(() => {
    loadScheduled();
  }, [loadScheduled]);

  const handleSchedule = async () => {
    if (!content.trim() || !sendDate || !sendTime) return;

    setLoading(true);
    setError('');
    const sendAt = new Date(`${sendDate}T${sendTime}`);

    if (sendAt.getTime() <= Date.now()) {
      setError('⚠ Schedule time must be in the future');
      setLoading(false);
      return;
    }

    const result = await messagingService.scheduleMessage(
      conversationId,
      senderId,
      content,
      sendAt
    );
    if (result) {
      setContent('');
      setSendDate('');
      setSendTime('');
      setError('');
      await loadScheduled();
      onScheduled?.();
    } else {
      setError('⚠ Failed to schedule message - please try again');
    }
    setLoading(false);
  };

  const handleCancel = async (id: string) => {
    await messagingService.cancelScheduledMessage(id, senderId);
    await loadScheduled();
  };

  const formatScheduledTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Schedule Message</h3>
          <button className={styles.closeBtn} onClick={onClose}>
            ×
          </button>
        </div>

        {/* Compose */}
        <div className={styles.compose}>
          <textarea
            className={styles.textarea}
            placeholder="Type your announcement..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
          />
          <div className={styles.dateRow}>
            <input
              type="date"
              className={styles.dateInput}
              value={sendDate}
              onChange={(e) => setSendDate(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
            />
            <input
              type="time"
              className={styles.timeInput}
              value={sendTime}
              onChange={(e) => setSendTime(e.target.value)}
            />
          </div>
          <button
            className={styles.scheduleBtn}
            onClick={handleSchedule}
            disabled={loading || !content.trim() || !sendDate || !sendTime}
          >
            {loading ? 'Scheduling...' : 'Schedule'}
          </button>
          {error && (
            <div
              className={styles.errorMsg}
              style={{ color: '#ff6b6b', fontSize: '0.78rem', textAlign: 'center', marginTop: 4 }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Pending List */}
        {scheduled.length > 0 && (
          <div className={styles.pendingSection}>
            <h4>Pending ({scheduled.length})</h4>
            {scheduled.map((msg) => (
              <div key={msg.id} className={styles.pendingItem}>
                <div className={styles.pendingContent}>
                  <span className={styles.pendingText}>{msg.content}</span>
                  <span className={styles.pendingTime}>{formatScheduledTime(msg.sendAt)}</span>
                </div>
                <button className={styles.cancelBtn} onClick={() => handleCancel(msg.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
