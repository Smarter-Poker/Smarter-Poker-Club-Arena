/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ GIF PICKER — Q3 Wave 3 (Block D)
 * Searchable GIF picker with Tenor-style layout (uses open web)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { haptic } from '../../services/HapticService';
import './GifPicker.css';

interface GifPickerProps {
  isOpen: boolean;
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

interface GifResult {
  id: string;
  previewUrl: string;
  fullUrl: string;
  title: string;
}

// Curated built-in GIF set (placeholder URLs for development)
const TRENDING_GIFS: GifResult[] = [
  {
    id: 'thumbs-up',
    previewUrl: 'https://media.giphy.com/media/11ISwbgCxEzMyY/giphy.gif',
    fullUrl: 'https://media.giphy.com/media/11ISwbgCxEzMyY/giphy.gif',
    title: '👍 Nice Hand',
  },
  {
    id: 'clap',
    previewUrl: 'https://media.giphy.com/media/ytwDCy0RqTbkG9gFcY/giphy.gif',
    fullUrl: 'https://media.giphy.com/media/ytwDCy0RqTbkG9gFcY/giphy.gif',
    title: '👏 Well Played',
  },
  {
    id: 'crying',
    previewUrl: 'https://media.giphy.com/media/2rtQMJvhzOnRe/giphy.gif',
    fullUrl: 'https://media.giphy.com/media/2rtQMJvhzOnRe/giphy.gif',
    title: '😭 Bad Beat',
  },
  {
    id: 'money',
    previewUrl: 'https://media.giphy.com/media/3o6gDWzmAzrpi5DQU8/giphy.gif',
    fullUrl: 'https://media.giphy.com/media/3o6gDWzmAzrpi5DQU8/giphy.gif',
    title: '💰 Money',
  },
  {
    id: 'fire',
    previewUrl: 'https://media.giphy.com/media/nrXif9YExO9EI/giphy.gif',
    fullUrl: 'https://media.giphy.com/media/nrXif9YExO9EI/giphy.gif',
    title: '🔥 On Fire',
  },
  {
    id: 'thinking',
    previewUrl: 'https://media.giphy.com/media/3o7buirYcmV5nSwIRW/giphy.gif',
    fullUrl: 'https://media.giphy.com/media/3o7buirYcmV5nSwIRW/giphy.gif',
    title: '🤔 Thinking',
  },
];

// Sticker packs
const STICKER_PACKS = [
  {
    id: 'poker',
    label: '♠ Poker',
    stickers: ['🂡', '🂱', '🂢', '🃁', '🃑', '♠️', '♥️', '♦️', '♣️', '🎰', '🏆', '💰'],
  },
  {
    id: 'emotions',
    label: '😀 Emotions',
    stickers: ['😀', '😂', '🤣', '😎', '🤔', '😱', '🤯', '😤', '😭', '🥳', '😈', '💀'],
  },
  {
    id: 'gestures',
    label: '👋 Gestures',
    stickers: ['👍', '👎', '👏', '🤝', '✌️', '🤙', '💪', '🙏', '🫡', '👀', '💅', '🤌'],
  },
];

type PickerTab = 'gif' | 'stickers';

export const GifPicker: React.FC<GifPickerProps> = ({ isOpen, onSelect, onClose }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<PickerTab>('stickers');
  const [activePack, setActivePack] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery(''); // Reset search on open
      setActivePack(0); // Reset to first pack
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [isOpen]);

  const filteredGifs = searchQuery
    ? TRENDING_GIFS.filter((g) => g.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : TRENDING_GIFS;

  const handleSelectSticker = useCallback(
    (sticker: string) => {
      haptic.medium();
      onSelect(sticker);
      onClose();
    },
    [onSelect, onClose]
  );

  const handleSelectGif = useCallback(
    (gif: GifResult) => {
      haptic.medium();
      // Send the actual GIF URL
      onSelect(gif.fullUrl);
      onClose();
    },
    [onSelect, onClose]
  );

  if (!isOpen) return null;

  return (
    <>
      <div className="gif-picker-overlay" onClick={onClose} />
      <div className="gif-picker">
        {/* Tabs */}
        <div className="gif-picker-tabs">
          <button
            className={`gif-tab ${activeTab === 'stickers' ? 'active' : ''}`}
            onClick={() => {
              haptic.selection();
              setActiveTab('stickers');
            }}
          >
            😀 Stickers
          </button>
          <button
            className={`gif-tab ${activeTab === 'gif' ? 'active' : ''}`}
            onClick={() => {
              haptic.selection();
              setActiveTab('gif');
            }}
          >
            🎬 GIFs
          </button>
          <button className="gif-picker-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Search */}
        <div className="gif-search">
          <input
            ref={inputRef}
            type="text"
            placeholder={activeTab === 'gif' ? 'Search GIFs...' : 'Search stickers...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="gif-search-input"
          />
        </div>

        {/* Content */}
        <div className="gif-content">
          {activeTab === 'stickers' ? (
            <>
              {/* Sticker pack selector */}
              <div className="sticker-pack-tabs">
                {STICKER_PACKS.map((pack, i) => (
                  <button
                    key={pack.id}
                    className={`sticker-pack-tab ${activePack === i ? 'active' : ''}`}
                    onClick={() => setActivePack(i)}
                  >
                    {pack.label}
                  </button>
                ))}
              </div>
              <div className="sticker-grid">
                {STICKER_PACKS[activePack].stickers
                  .filter((s) => !searchQuery || s.includes(searchQuery))
                  .map((sticker, i) => (
                    <button
                      key={i}
                      className="sticker-item"
                      onClick={() => handleSelectSticker(sticker)}
                    >
                      {sticker}
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <div className="gif-grid">
              {filteredGifs.map((gif) => (
                <button key={gif.id} className="gif-item" onClick={() => handleSelectGif(gif)}>
                  <img
                    loading="lazy"
                    decoding="async"
                    src={gif.previewUrl}
                    alt={gif.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </button>
              ))}
              {filteredGifs.length === 0 && (
                <div className="gif-empty">No results for "{searchQuery}"</div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default GifPicker;
