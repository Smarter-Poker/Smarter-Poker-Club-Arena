/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MESSAGE INPUT — Chat Composer (SNGINE-inspired)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Features: Auto-resize textarea, image attachment, typing indicator broadcast
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './MessageInput.module.css';
import { ImageUpload, ImagePreview } from './ImageMessage';
import { GifPicker } from './GifPicker';
import { VoiceRecorder } from './VoiceRecorder';
import { haptic } from '../../services/HapticService';

interface MessageInputProps {
  onSend: (text: string, imageUrl?: string, audioUrl?: string) => void;
  onTyping?: (isTyping: boolean) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Initial draft text to restore */
  initialDraft?: string;
  /** Called when draft text changes (for persistence) */
  onDraftChange?: (text: string) => void;
}

export default function MessageInput({
  onSend,
  onTyping,
  disabled = false,
  placeholder = 'Type a message...',
  initialDraft = '',
  onDraftChange,
}: MessageInputProps) {
  const [text, setText] = useState(initialDraft);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingState = useRef(false);
  const draftInitialized = useRef(false);

  // Re-initialize when initialDraft changes (conversation switch)
  useEffect(() => {
    if (!draftInitialized.current) {
      draftInitialized.current = true;
      if (initialDraft) setText(initialDraft);
    }
  }, [initialDraft]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [text]);

  // Typing indicator
  const updateTyping = useCallback(
    (isTyping: boolean) => {
      if (isTyping !== lastTypingState.current) {
        lastTypingState.current = isTyping;
        onTyping?.(isTyping);
      }
    },
    [onTyping]
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);
    onDraftChange?.(newText);

    // Set typing = true
    updateTyping(true);

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set typing = false after 3s of inactivity
    typingTimeoutRef.current = setTimeout(() => {
      updateTyping(false);
    }, 3000);
  };

  const handleSend = () => {
    if ((!text.trim() && !attachmentPreview) || disabled) return;

    haptic.medium();
    onSend(text.trim(), attachmentPreview || undefined);
    setText('');
    setAttachmentPreview(null);
    updateTyping(false);
    onDraftChange?.(''); // Clear draft on send

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setAttachmentPreview(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeAttachment = () => {
    setAttachmentPreview(null);
  };

  return (
    <div className={styles.container}>
      {/* Attachment Preview */}
      {attachmentPreview && (
        <ImagePreview imageUrl={attachmentPreview} onRemove={removeAttachment} />
      )}

      <div className={styles.inputRow}>
        {/* Image Upload Button */}
        <ImageUpload onPreview={setAttachmentPreview} maxSizeMB={5} />

        {/* GIF/Sticker Picker Toggle */}
        <button
          className={styles.toolbarBtn}
          onClick={() => {
            haptic.light();
            setShowGifPicker(!showGifPicker);
            setShowVoiceRecorder(false);
          }}
          title="GIFs & Stickers"
          style={{
            fontSize: '1.1rem',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: showGifPicker ? '#3b82f6' : 'rgba(255,255,255,0.4)',
            padding: '4px 6px',
          }}
        >
          ◆
        </button>

        {/* Text Input */}
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
        />

        {/* Voice Message Toggle */}
        {!text.trim() && !attachmentPreview && (
          <button
            className={styles.toolbarBtn}
            onClick={() => {
              haptic.light();
              setShowVoiceRecorder(true);
              setShowGifPicker(false);
            }}
            title="Voice Message"
            style={{
              fontSize: '1.1rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: showVoiceRecorder ? '#ef4444' : 'rgba(255,255,255,0.4)',
              padding: '4px 6px',
            }}
          >
            ◆
          </button>
        )}

        {/* Send Button */}
        <button
          className={`${styles.sendBtn} ${text.trim() || attachmentPreview ? styles.active : ''}`}
          onClick={handleSend}
          disabled={disabled || (!text.trim() && !attachmentPreview)}
        >
          {disabled ? '' : '➤'}
        </button>
      </div>

      {/* GIF/Sticker Picker Panel */}
      <GifPicker
        isOpen={showGifPicker}
        onSelect={(selection) => {
          if (selection.startsWith('http')) {
            onSend('', selection); // Send as imageUrl
          } else {
            onSend(selection); // Send as text (sticker)
          }
          setShowGifPicker(false);
        }}
        onClose={() => setShowGifPicker(false)}
      />

      {/* Voice Recorder */}
      {showVoiceRecorder && (
        <VoiceRecorder
          onSend={(blob, durationMs) => {
            const reader = new FileReader();
            reader.onload = (event) => {
              const audioDataUrl = event.target?.result as string;
              onSend('', undefined, audioDataUrl);
            };
            reader.readAsDataURL(blob);
            setShowVoiceRecorder(false);
          }}
          onCancel={() => setShowVoiceRecorder(false)}
        />
      )}
    </div>
  );
}
