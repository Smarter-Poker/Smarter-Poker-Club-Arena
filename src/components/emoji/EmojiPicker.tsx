import React, { useState } from 'react';
import './EmojiPicker.css';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  recentEmojis?: string[];
}

const EMOJI_CATEGORIES = {
  faces: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '', '😇', '🥰', '😍', '🤩', '😘'],
  gestures: ['', '', '👊', '✊', '🤛', '🤜', '', '🙌', '👏', '', '🙏', '✌️', '🤞', '🤟'],
  poker: ['', '', '', '', '', '', '', '', '', '', '💫', '', '', '🎊'],
};

export const EmojiPicker: React.FC<EmojiPickerProps> = ({ onSelect, recentEmojis = [] }) => {
  const [category, setCategory] = useState<keyof typeof EMOJI_CATEGORIES>('faces');

  return (
    <div className="emoji-picker">
      <div className="emoji-tabs">
        {Object.keys(EMOJI_CATEGORIES).map((cat) => (
          <button
            key={cat}
            className={cat === category ? 'active' : ''}
            onClick={() => setCategory(cat as keyof typeof EMOJI_CATEGORIES)}
          >
            {cat === 'faces' ? '😀' : cat === 'gestures' ? '' : ''}
          </button>
        ))}
      </div>
      {recentEmojis.length > 0 && (
        <div className="emoji-section">
          <div className="emoji-section-label">Recent</div>
          <div className="emoji-grid">
            {recentEmojis.map((emoji, i) => (
              <button key={i} onClick={() => onSelect(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="emoji-grid">
        {EMOJI_CATEGORIES[category].map((emoji, i) => (
          <button key={i} onClick={() => onSelect(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
};

export default EmojiPicker;
