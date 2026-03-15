/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB LOGO SELECTOR — Upload or Select Preset Logos
 * ═══════════════════════════════════════════════════════════════════════════════
 * Provides two options for club logos:
 * 1. Upload custom logo (JPEG, PNG, GIF, WebP)
 * 2. Select from 25 pre-made animated GIF logos
 */

import { useState, useRef, ChangeEvent } from 'react';
import { uploadClubLogo } from '@/services/ClubsService';
import './ClubLogoSelector.css';

interface ClubLogoSelectorProps {
  clubId: string;
  currentLogo?: string;
  onLogoChange: (logoUrl: string) => void;
}

// 25 Pre-made metal club badge logos
const PRESET_LOGOS = [
  { id: 1, name: 'Spade Badge', file: '/club-logos/preset-01.png' },
  { id: 2, name: 'Heart Badge', file: '/club-logos/preset-02.png' },
  { id: 3, name: 'Diamond Badge', file: '/club-logos/preset-03.png' },
  { id: 4, name: 'Club Badge', file: '/club-logos/preset-04.png' },
  { id: 5, name: 'VIP Chip', file: '/club-logos/preset-05.png' },
  { id: 6, name: 'Royal Crown', file: '/club-logos/preset-06.png' },
  { id: 7, name: 'Ace Medal', file: '/club-logos/preset-07.png' },
  { id: 8, name: 'Shield Crest', file: '/club-logos/preset-08.png' },
  { id: 9, name: 'Wolf Emblem', file: '/club-logos/preset-09.png' },
  { id: 10, name: 'Lion Emblem', file: '/club-logos/preset-10.png' },
  { id: 11, name: 'Eagle Emblem', file: '/club-logos/preset-11.png' },
  { id: 12, name: 'Dragon Emblem', file: '/club-logos/preset-12.png' },
  { id: 13, name: 'Skull Badge', file: '/club-logos/preset-13.png' },
  { id: 14, name: 'Phoenix Badge', file: '/club-logos/preset-14.png' },
  { id: 15, name: 'Knight Chess', file: '/club-logos/preset-15.png' },
  { id: 16, name: 'Trophy Cup', file: '/club-logos/preset-16.png' },
  { id: 17, name: 'Star Badge', file: '/club-logos/preset-17.png' },
  { id: 18, name: 'Dice Badge', file: '/club-logos/preset-18.png' },
  { id: 19, name: 'Poker Chip', file: '/club-logos/preset-19.png' },
  { id: 20, name: 'Four Aces', file: '/club-logos/preset-20.png' },
  { id: 21, name: 'Horseshoe', file: '/club-logos/preset-21.png' },
  { id: 22, name: 'Lucky Clover', file: '/club-logos/preset-22.png' },
  { id: 23, name: 'Fire Badge', file: '/club-logos/preset-23.png' },
  { id: 24, name: 'Lightning', file: '/club-logos/preset-24.png' },
  { id: 25, name: 'Money Badge', file: '/club-logos/preset-25.png' },
];

export default function ClubLogoSelector({
  clubId,
  currentLogo,
  onLogoChange,
}: ClubLogoSelectorProps) {
  const [activeTab, setActiveTab] = useState<'upload' | 'preset'>('preset');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(currentLogo || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setError('Please upload JPEG, PNG, GIF, or WebP format');
      return;
    }

    // Validate file size (2MB max)
    if (file.size > 2 * 1024 * 1024) {
      setError('File too large. Maximum size is 2MB');
      return;
    }

    setError(null);
    setUploading(true);

    try {
      // Create preview
      const reader = new FileReader();
      reader.onload = (event) => {
        setPreview(event.target?.result as string);
      };
      reader.readAsDataURL(file);

      // Upload to Supabase
      const logoUrl = await uploadClubLogo(clubId, file);
      onLogoChange(logoUrl);
      setSelectedPreset(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handlePresetSelect = async (preset: (typeof PRESET_LOGOS)[0]) => {
    setSelectedPreset(preset.file);
    setPreview(preset.file);
    setError(null);

    // For presets, we just update the club's logo_url to the static asset path
    // The calling component should handle saving this to the database
    onLogoChange(preset.file);
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="club-logo-selector">
      {/* Preview Area */}
      <div className="logo-preview">
        {preview ? (
          <img
            loading="lazy"
            decoding="async"
            src={preview}
            alt="Club logo preview"
            className="logo-preview__image"
          />
        ) : (
          <div className="logo-preview__placeholder">
            <span className="logo-preview__icon">IMG</span>
            <span className="logo-preview__text">No logo selected</span>
          </div>
        )}
      </div>

      {/* Tab Selector */}
      <div className="logo-tabs">
        <button
          className={`logo-tab ${activeTab === 'preset' ? 'logo-tab--active' : ''}`}
          onClick={() => setActiveTab('preset')}
        >
          Preset Logos
        </button>
        <button
          className={`logo-tab ${activeTab === 'upload' ? 'logo-tab--active' : ''}`}
          onClick={() => setActiveTab('upload')}
        >
          Upload Custom
        </button>
      </div>

      {/* Tab Content */}
      <div className="logo-content">
        {activeTab === 'upload' ? (
          <div className="logo-upload">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              onChange={handleFileSelect}
              className="logo-upload__input"
            />
            <button className="logo-upload__button" onClick={triggerFileInput} disabled={uploading}>
              {uploading ? 'Uploading...' : 'Choose File'}
            </button>
            <p className="logo-upload__hint">JPEG, PNG, GIF or WebP. Max 2MB.</p>
          </div>
        ) : (
          <div className="logo-preset-grid">
            {PRESET_LOGOS.map((preset) => (
              <button
                key={preset.id}
                className={`logo-preset ${selectedPreset === preset.file ? 'logo-preset--selected' : ''}`}
                onClick={() => handlePresetSelect(preset)}
                title={preset.name}
              >
                <img
                  loading="lazy"
                  decoding="async"
                  src={preset.file}
                  alt={preset.name}
                  className="logo-preset__image"
                />
              </button>
            ))}
          </div>
        )}

        {error && <p className="logo-error">{error}</p>}
      </div>
    </div>
  );
}
