/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💬 TABLE CHAT — In-Game Chat Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium table chat featuring:
 * - Message history with auto-scroll
 * - Player mentions with highlighting
 * - Emoji support
 * - System messages (joins, wins, etc.)
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import './TableChat.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ChatMessageType = 'PLAYER' | 'SYSTEM' | 'DEALER' | 'EMOJI';

export interface ChatMessage {
    id: string;
    type: ChatMessageType;
    playerId?: string;
    playerName?: string;
    playerAvatar?: string;
    content: string;
    timestamp: Date;
    isHighlighted?: boolean;
}

export interface TableChatProps {
    messages: ChatMessage[];
    onSendMessage: (message: string) => void;
    myPlayerId?: string;
    isCollapsed?: boolean;
    onToggleCollapse?: () => void;
    maxMessages?: number;
    isDisabled?: boolean;
    placeholder?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

// Quick emoji buttons
const QUICK_EMOJIS = ['👍', '👎', 'nh', 'ty', 'gg', '😂', '🔥', '💰'];

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface MessageRowProps {
    message: ChatMessage;
    isOwnMessage: boolean;
}

function MessageRow({ message, isOwnMessage }: MessageRowProps) {
    if (message.type === 'SYSTEM') {
        return (
            <div className="chat-message chat-message--system">
                <span className="chat-message__system-text">{message.content}</span>
            </div>
        );
    }

    if (message.type === 'DEALER') {
        return (
            <div className="chat-message chat-message--dealer">
                <span className="chat-message__dealer-icon">🃏</span>
                <span className="chat-message__dealer-text">{message.content}</span>
            </div>
        );
    }

    if (message.type === 'EMOJI') {
        return (
            <div className={`chat-message chat-message--emoji ${isOwnMessage ? 'chat-message--own' : ''}`}>
                <span className="chat-message__emoji-large">{message.content}</span>
                <span className="chat-message__sender">{message.playerName}</span>
            </div>
        );
    }

    return (
        <div className={`chat-message ${isOwnMessage ? 'chat-message--own' : ''} ${message.isHighlighted ? 'chat-message--highlighted' : ''}`}>
            {!isOwnMessage && (
                <div className="chat-message__avatar">
                    {message.playerAvatar ? (
                        <img src={message.playerAvatar} alt="" />
                    ) : (
                        <span>{message.playerName?.[0]?.toUpperCase() || '?'}</span>
                    )}
                </div>
            )}
            <div className="chat-message__bubble">
                {!isOwnMessage && (
                    <span className="chat-message__name">{message.playerName}</span>
                )}
                <span className="chat-message__content">{message.content}</span>
                <span className="chat-message__time">{formatTime(message.timestamp)}</span>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TableChat({
    messages,
    onSendMessage,
    myPlayerId,
    isCollapsed = false,
    onToggleCollapse,
    maxMessages = 100,
    isDisabled = false,
    placeholder = 'Type a message...',
}: TableChatProps) {
    const [inputValue, setInputValue] = useState('');
    const [showEmojis, setShowEmojis] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    // Trim messages to max
    const displayMessages = messages.slice(-maxMessages);

    // Handle send
    const handleSend = useCallback(() => {
        if (inputValue.trim() && !isDisabled) {
            onSendMessage(inputValue.trim());
            setInputValue('');
            setShowEmojis(false);
        }
    }, [inputValue, isDisabled, onSendMessage]);

    // Handle key press
    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // Quick emoji click
    const handleQuickEmoji = (emoji: string) => {
        onSendMessage(emoji);
        setShowEmojis(false);
    };

    if (isCollapsed) {
        return (
            <button className="chat-collapsed" onClick={onToggleCollapse}>
                <span className="chat-collapsed__icon">💬</span>
                <span className="chat-collapsed__badge">{messages.length}</span>
            </button>
        );
    }

    return (
        <div className="table-chat">
            {/* Header */}
            <div className="table-chat__header">
                <span className="table-chat__title">Table Chat</span>
                <div className="table-chat__actions">
                    {onToggleCollapse && (
                        <button className="table-chat__minimize" onClick={onToggleCollapse}>
                            —
                        </button>
                    )}
                </div>
            </div>

            {/* Messages */}
            <div className="table-chat__messages">
                {displayMessages.length === 0 ? (
                    <div className="table-chat__empty">
                        <span>No messages yet</span>
                        <span>Be the first to say hello! 👋</span>
                    </div>
                ) : (
                    displayMessages.map((msg) => (
                        <MessageRow
                            key={msg.id}
                            message={msg}
                            isOwnMessage={msg.playerId === myPlayerId}
                        />
                    ))
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Quick Emojis */}
            {showEmojis && (
                <div className="table-chat__emojis">
                    {QUICK_EMOJIS.map((emoji) => (
                        <button
                            key={emoji}
                            className="table-chat__emoji-btn"
                            onClick={() => handleQuickEmoji(emoji)}
                        >
                            {emoji}
                        </button>
                    ))}
                </div>
            )}

            {/* Input */}
            <div className="table-chat__input-container">
                <button
                    className={`table-chat__emoji-toggle ${showEmojis ? 'table-chat__emoji-toggle--active' : ''}`}
                    onClick={() => setShowEmojis(!showEmojis)}
                >
                    😊
                </button>
                <input
                    ref={inputRef}
                    type="text"
                    className="table-chat__input"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder={placeholder}
                    disabled={isDisabled}
                    maxLength={200}
                />
                <button
                    className="table-chat__send"
                    onClick={handleSend}
                    disabled={!inputValue.trim() || isDisabled}
                >
                    ➤
                </button>
            </div>
        </div>
    );
}

export default TableChat;
