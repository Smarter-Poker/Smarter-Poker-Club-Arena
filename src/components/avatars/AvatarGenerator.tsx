/**
 * ♠ CLUB ARENA — Avatar Generator
 * Uses to generate custom poker avatars
 */

import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './AvatarGenerator.css';
import { reportError } from '../../utils/errorReporter';

interface AvatarStyle {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export const AvatarGenerator: React.FC<{
  onGenerated?: (url: string) => void;
  onClose?: () => void;
}> = ({ onGenerated, onClose }) => {
  const { user } = useAuthUser();
  const toast = useToast();
  const [prompt, setPrompt] = useState('');
  const [selectedStyle, setSelectedStyle] = useState<string>('realistic');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const styles: AvatarStyle[] = [
    { id: 'realistic', name: 'Realistic', icon: '▣', description: 'Photo-realistic poker player' },
    { id: 'cartoon', name: 'Cartoon', icon: '◇', description: 'Fun animated style' },
    { id: 'cyberpunk', name: 'Cyberpunk', icon: '▣', description: 'Futuristic neon aesthetic' },
    { id: 'vintage', name: 'Vintage', icon: '▦', description: 'Classic casino vibe' },
    { id: 'anime', name: 'Anime', icon: '✨', description: 'Japanese animation style' },
    { id: 'minimalist', name: 'Minimalist', icon: '◯', description: 'Clean, simple design' },
  ];

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast.error('Please describe your avatar');
      return;
    }

    setIsGenerating(true);
    setGeneratedImages([]);

    try {
      // Call your avatar generation endpoint
      const response = await fetch('/api/generate-avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Poker player avatar: ${prompt}`,
          style: selectedStyle,
          userId: user?.id,
        }),
      });

      if (!response.ok) {
        throw new Error('Generation failed');
      }

      const data = await response.json();
      setGeneratedImages(data.images || []);
      toast.success('Avatars generated!');
    } catch (error) {
      reportError(error, 'AvatarGenerator.Avatar_generation_failed');
      toast.error('Failed to generate avatar. Please try again.');

      // Replaced mocked fallback with empty array
      setGeneratedImages([]);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSelect = async () => {
    if (!selectedImage) {
      toast.error('Please select an avatar');
      return;
    }

    try {
      /* Club Arena avatar, not the social media photo. See
         AvatarService.setUserAvatar - avatar_url belongs to the social profile
         and is never written from inside Club Arena. */
      const { error } = await supabase
        .from('profiles')
        .update({ arena_avatar_url: selectedImage })
        .eq('id', user?.id);

      if (error) throw error;

      toast.success('Avatar updated!');
      onGenerated?.(selectedImage);
      onClose?.();
    } catch (error) {
      reportError(error, 'AvatarGenerator.Failed_to_save_avatar');
      toast.error('Failed to save avatar');
    }
  };

  const promptSuggestions = [
    'A mysterious player with sunglasses and a hoodie',
    'A friendly grandma who loves playing poker',
    'A cool cat wearing a poker visor',
    'A robot dealer with glowing eyes',
    'A shark in a tuxedo holding cards',
    'A ninja master at the poker table',
  ];

  return (
    <div className="avatar-generator">
      <div className="generator-header">
        <h2>Avatar Generator</h2>
        {onClose && (
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      {/* Style Selector */}
      <div className="style-selector">
        <h3>Choose Style</h3>
        <div className="style-grid">
          {styles.map((style) => (
            <button
              key={style.id}
              className={`style-option ${selectedStyle === style.id ? 'active' : ''}`}
              onClick={() => setSelectedStyle(style.id)}
            >
              <span className="style-icon">{style.icon}</span>
              <span className="style-name">{style.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Prompt Input */}
      <div className="prompt-section">
        <h3>Describe Your Avatar</h3>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what you want your avatar to look like..."
          maxLength={200}
        />
        <span className="char-count">{prompt.length}/200</span>
      </div>

      {/* Suggestions */}
      <div className="suggestions">
        <span className="suggestions-label">Try:</span>
        <div className="suggestion-chips">
          {promptSuggestions.slice(0, 3).map((suggestion, i) => (
            <button key={i} className="suggestion-chip" onClick={() => setPrompt(suggestion)}>
              {suggestion.slice(0, 30)}...
            </button>
          ))}
        </div>
      </div>

      {/* Generate Button */}
      <button
        className="generate-btn"
        onClick={handleGenerate}
        disabled={isGenerating || !prompt.trim()}
      >
        {isGenerating ? (
          <>
            <span className="spinner" />
            Generating...
          </>
        ) : (
          <>✨ Generate Avatar</>
        )}
      </button>

      {/* Generated Results */}
      {generatedImages.length > 0 && (
        <div className="generated-results">
          <h3>Select Your Avatar</h3>
          <div className="results-grid">
            {generatedImages.map((img, i) => (
              <button
                key={i}
                className={`result-image ${selectedImage === img ? 'selected' : ''}`}
                onClick={() => setSelectedImage(img)}
              >
                <img loading="lazy" decoding="async" src={img} alt={`Generated avatar ${i + 1}`} />
                {selectedImage === img && <span className="selected-check">✓</span>}
              </button>
            ))}
          </div>
          <button className="use-avatar-btn" onClick={handleSelect} disabled={!selectedImage}>
            Use This Avatar
          </button>
        </div>
      )}
    </div>
  );
};

export default AvatarGenerator;
