import React, { useState, useEffect, useRef } from 'react';
import { useToast } from '../common/Toast';
import './ChatModerationPanel.css';

interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  content: string;
  timestamp: Date;
  flagged?: boolean;
}

interface ChatModerationPanelProps {
  tableId: string;
  messages: ChatMessage[];
  onDeleteMessage?: (messageId: string) => void;
  onMutePlayer?: (userId: string, duration: number) => void;
  onBanPlayer?: (userId: string) => void;
}

export const ChatModerationPanel: React.FC<ChatModerationPanelProps> = ({
  tableId,
  messages,
  onDeleteMessage,
  onMutePlayer,
  onBanPlayer,
}) => {
  const toast = useToast();
  const [selectedMessage, setSelectedMessage] = useState<string | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = messages.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, [messages]);

  const handleDelete = (messageId: string) => {
    onDeleteMessage?.(messageId);
    toast.success('Message deleted');
    setSelectedMessage(null);
  };

  const handleMute = (userId: string, username: string, duration: number) => {
    onMutePlayer?.(userId, duration);
    const durationText =
      duration === 60 ? '1 hour' : duration === 1440 ? '24 hours' : `${duration} minutes`;
    toast.info(`${username} muted for ${durationText}`);
    setSelectedMessage(null);
  };

  const handleBan = (userId: string, username: string) => {
    onBanPlayer?.(userId);
    toast.warning(`${username} banned from chat`);
    setSelectedMessage(null);
  };

  return (
    <div className="chat-moderation-panel">
      <div className="moderation-header">
        <h3>Chat Moderation</h3>
        <span className="table-id">Table #{tableId.slice(0, 8)}</span>
      </div>

      <div className="moderation-messages">
        {messages.map((msg, i) => (
          <div
            key={msg.id}
            className={`mod-message ${msg.flagged ? 'flagged' : ''} ${selectedMessage === msg.id ? 'selected' : ''}`}
            onClick={() => setSelectedMessage(selectedMessage === msg.id ? null : msg.id)}
            style={{
              opacity: visibleItems.has(i) ? 1 : 0,
              transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <div className="message-header">
              <span className="msg-username">{msg.username}</span>
              <span className="msg-time">
                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="msg-content">{msg.content}</div>

            {selectedMessage === msg.id && (
              <div className="mod-actions">
                <button
                  className="action-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(msg.id);
                  }}
                >
                  Delete
                </button>
                <button
                  className="action-mute"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMute(msg.userId, msg.username, 15);
                  }}
                >
                  Mute 15M
                </button>
                <button
                  className="action-mute"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMute(msg.userId, msg.username, 60);
                  }}
                >
                  Mute 1H
                </button>
                <button
                  className="action-ban"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBan(msg.userId, msg.username);
                  }}
                >
                  Ban
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default ChatModerationPanel;
