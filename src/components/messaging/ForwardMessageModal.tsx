/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FORWARD MESSAGE MODAL — Pick conversation to forward message to
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { messagingService, type Conversation } from '../../services/MessagingService';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import styles from './ForwardMessageModal.module.css';

interface ForwardMessageModalProps {
  messageId: string;
  messageContent: string;
  onClose: () => void;
  onForwarded?: () => void;
}

export default function ForwardMessageModal({
  messageId,
  messageContent,
  onClose,
  onForwarded,
}: ForwardMessageModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [forwarding, setForwarding] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!user?.id) return;
    messagingService
      .getConversations(user.id)
      .then((convs) => {
        setConversations(convs);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[ForwardMessageModal] Failed to load conversations:', err);
        setLoading(false);
      });
  }, [user?.id]);

  const handleForward = async (targetConversationId: string) => {
    if (!user?.id) return;
    setForwarding(targetConversationId);
    try {
      const result = await messagingService.forwardMessage(
        messageId,
        targetConversationId,
        user.id
      );
      if (result) {
        toast.success('Message forwarded!');
        // Q3: Emit bus event so conversation lists update instantly
        masterBus.emit('MESSAGE_SENT', {
          message: { content: messageContent, forwarded: true } as Record<string, unknown>,
          conversationId: targetConversationId,
        });
        onForwarded?.();
        onClose();
      } else {
        toast.error('Failed to forward');
      }
    } catch (err) {
      console.error('[ForwardMessageModal] Error:', err);
      toast.error('Failed to forward');
    }
    setForwarding(null);
  };

  const filtered = conversations.filter((c) =>
    c.participants.some((p) => p.displayName.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Forward Message</h3>
          <button className={styles.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Preview */}
        <div className={styles.preview}>
          <span className={styles.previewIcon}>↪</span>
          <p className={styles.previewText}>
            {messageContent.length > 100
              ? messageContent.substring(0, 100) + '...'
              : messageContent}
          </p>
        </div>

        {/* Search */}
        <div className={styles.search}>
          <input
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Conversation List */}
        <div className={styles.list}>
          {loading ? (
            <div className={styles.loading}>
              <div className="spinner" />
            </div>
          ) : filtered.length === 0 ? (
            <div className={styles.empty}>No conversations found</div>
          ) : (
            filtered.map((conv) => {
              const otherUser = conv.participants.find((p) => p.id !== user?.id);
              return (
                <div key={conv.id} className={styles.item} onClick={() => handleForward(conv.id)}>
                  <img
                    loading="lazy"
                    decoding="async"
                    src={otherUser?.avatarUrl || '/default-avatar.png'}
                    alt={otherUser?.displayName}
                    className={styles.avatar}
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = '/default-avatar.png';
                    }}
                  />
                  <span className={styles.name}>{otherUser?.displayName || 'Unknown'}</span>
                  {forwarding === conv.id ? (
                    <div className={styles.forwarding}>Sending...</div>
                  ) : (
                    <span className={styles.sendIcon}>→</span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
