import React, { useState, useRef, useEffect } from 'react';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import './AvatarCustomizer.css';

interface AvatarCustomizerProps {
  currentAvatar?: string;
  onSave?: (avatarUrl: string) => void;
}

const PRESET_AVATARS = [
  '\u2660\uFE0F',
  '\u2665\uFE0F',
  '\u2666\uFE0F',
  '\u2663\uFE0F',
  '\uD83C\uDCA0',
  '\uD83E\uDD88',
  '\uD83E\uDD81',
  '\uD83D\uDC3A',
  '\uD83E\uDD85',
  '\uD83D\uDC09',
  '\uD83E\uDD8A',
  '\uD83D\uDC27',
  '\uD83D\uDE0E',
  '\uD83E\uDD20',
  '\uD83E\uDD77',
  '\uD83D\uDC51',
];

const AVATAR_BACKGROUNDS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

export const AvatarCustomizer: React.FC<AvatarCustomizerProps> = ({ currentAvatar, onSave }) => {
  const [selectedEmoji, setSelectedEmoji] = useState('');
  const [selectedBg, setSelectedBg] = useState(AVATAR_BACKGROUNDS[0]);
  const [customImage, setCustomImage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'preset' | 'custom'>('preset');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const items = activeTab === 'preset' ? PRESET_AVATARS.length + AVATAR_BACKGROUNDS.length : 0;
    // AC-1 BUG FIX: collect all stagger timer IDs so they cancel on cleanup.
    // Without this, switching tabs rapidly or unmounting fires setVisibleItems
    // on a stale component state.
    setVisibleItems(new Set());
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < items; i++) {
      timers.push(setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60));
    }
    return () => timers.forEach(clearTimeout);
  }, [activeTab]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setCustomImage(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSave = () => {
    if (activeTab === 'custom' && customImage) {
      onSave?.(customImage);
    } else {
      // For preset, we'd generate or reference the avatar
      onSave?.(`preset:${selectedEmoji}:${selectedBg}`);
    }
  };

  return (
    <div className="avatar-customizer">
      <h3>Customize Avatar</h3>

      <div className="avatar-preview-large">
        {activeTab === 'custom' && customImage ? (
          <img
            loading="lazy"
            decoding="async"
            src={customImage}
            alt="Custom avatar"
            onError={(e) => {
              (e.target as HTMLImageElement).src = generateDefaultAvatar();
            }}
          />
        ) : (
          <div className="preset-avatar-preview" style={{ background: selectedBg }}>
            <span>{selectedEmoji}</span>
          </div>
        )}
      </div>

      <div className="avatar-tabs">
        <button
          className={activeTab === 'preset' ? 'active' : ''}
          onClick={() => setActiveTab('preset')}
        >
          Preset
        </button>
        <button
          className={activeTab === 'custom' ? 'active' : ''}
          onClick={() => setActiveTab('custom')}
        >
          Upload
        </button>
      </div>

      {activeTab === 'preset' && (
        <div className="preset-options">
          <div className="option-section">
            <label>Icon</label>
            <div className="emoji-grid">
              {PRESET_AVATARS.map((emoji, i) => (
                <button
                  key={emoji}
                  className={`emoji-btn ${selectedEmoji === emoji ? 'selected' : ''}`}
                  onClick={() => setSelectedEmoji(emoji)}
                  style={{
                    opacity: visibleItems.has(i) ? 1 : 0,
                    transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div className="option-section">
            <label>Background</label>
            <div className="color-grid">
              {AVATAR_BACKGROUNDS.map((color, i) => (
                <button
                  key={color}
                  className={`color-btn ${selectedBg === color ? 'selected' : ''}`}
                  style={{
                    background: color,
                    opacity: visibleItems.has(PRESET_AVATARS.length + i) ? 1 : 0,
                    transform: visibleItems.has(PRESET_AVATARS.length + i)
                      ? 'translateY(0)'
                      : 'translateY(8px)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                  onClick={() => setSelectedBg(color)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'custom' && (
        <div className="custom-upload">
          <input
            type="file"
            ref={fileInputRef}
            accept="image/*"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <button className="upload-btn" onClick={() => fileInputRef.current?.click()}>
            Choose Image
          </button>
          <p className="upload-hint">JPG, PNG or GIF. Max 2MB.</p>
        </div>
      )}

      <button className="save-avatar-btn" onClick={handleSave}>
        Save Avatar
      </button>
    </div>
  );
};

export default AvatarCustomizer;
