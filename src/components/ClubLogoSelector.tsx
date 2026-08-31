/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB LOGO SELECTOR — Upload or Select Preset Logos
 * ═══════════════════════════════════════════════════════════════════════════════
 * Provides two options for club logos:
 * 1. Upload custom logo (JPEG, PNG, GIF, WebP)
 * 2. Select from 25 pre-made animated GIF logos
 */

import { useState, useRef, useEffect, ChangeEvent } from 'react';
import { uploadClubLogo } from '@/services/ClubsService';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { useToast } from './common/Toast';
import './ClubLogoSelector.css';

interface ClubLogoSelectorProps {
  clubId: string;
  currentLogo?: string;
  onLogoChange: (logoUrl: string) => void;
}

// 25 Pre-made metal club badge logos
const PRESET_LOGOS = [
  { id: 1, name: 'Spade Badge', file: '/club-logos/preset-01.webp' },
  { id: 2, name: 'Heart Badge', file: '/club-logos/preset-02.webp' },
  { id: 3, name: 'Diamond Badge', file: '/club-logos/preset-03.webp' },
  { id: 4, name: 'Club Badge', file: '/club-logos/preset-04.webp' },
  { id: 5, name: 'VIP Chip', file: '/club-logos/preset-05.webp' },
  { id: 6, name: 'Royal Crown', file: '/club-logos/preset-06.webp' },
  { id: 7, name: 'Ace Medal', file: '/club-logos/preset-07.webp' },
  { id: 8, name: 'Shield Crest', file: '/club-logos/preset-08.webp' },
  { id: 9, name: 'Wolf Emblem', file: '/club-logos/preset-09.webp' },
  { id: 10, name: 'Lion Emblem', file: '/club-logos/preset-10.webp' },
  { id: 11, name: 'Eagle Emblem', file: '/club-logos/preset-11.webp' },
  { id: 12, name: 'Dragon Emblem', file: '/club-logos/preset-12.webp' },
  { id: 13, name: 'Skull Badge', file: '/club-logos/preset-13.webp' },
  { id: 14, name: 'Phoenix Badge', file: '/club-logos/preset-14.webp' },
  { id: 15, name: 'Knight Chess', file: '/club-logos/preset-15.webp' },
  { id: 16, name: 'Trophy Cup', file: '/club-logos/preset-16.webp' },
  { id: 17, name: 'Star Badge', file: '/club-logos/preset-17.webp' },
  { id: 18, name: 'Dice Badge', file: '/club-logos/preset-18.webp' },
  { id: 19, name: 'Poker Chip', file: '/club-logos/preset-19.webp' },
  { id: 20, name: 'Four Aces', file: '/club-logos/preset-20.webp' },
  { id: 21, name: 'Horseshoe', file: '/club-logos/preset-21.webp' },
  { id: 22, name: 'Lucky Clover', file: '/club-logos/preset-22.webp' },
  { id: 23, name: 'Fire Badge', file: '/club-logos/preset-23.webp' },
  { id: 24, name: 'Lightning', file: '/club-logos/preset-24.webp' },
  { id: 25, name: 'Money Badge', file: '/club-logos/preset-25.webp' },
];

export default function ClubLogoSelector({
  clubId,
  currentLogo,
  onLogoChange,
}: ClubLogoSelectorProps) {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<'upload' | 'preset'>('preset');
  /**
   * AUDIT 2026-08-25: seeded from `currentLogo`, not from null. A club already
   * using preset-07 opened this picker with NOTHING highlighted, so the only
   * way to find out which badge was in use was to remember. The 25 presets are
   * real, distinct artwork; the picker just refused to admit which one was on.
   */
  const [selectedPreset, setSelectedPreset] = useState<string | null>(
    currentLogo && currentLogo.startsWith('/club-logos/') ? currentLogo : null
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(currentLogo || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Follow the club's stored logo when the parent loads or replaces it. */
  useEffect(() => {
    setPreview(currentLogo || null);
    setSelectedPreset(currentLogo && currentLogo.startsWith('/club-logos/') ? currentLogo : null);
  }, [currentLogo]);

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      const message = 'Please Upload JPEG, PNG, GIF Or WebP Format';
      setError(message);
      toast.error(message);
      return;
    }

    // Validate file size (2MB max)
    if (file.size > 2 * 1024 * 1024) {
      const message = 'File Too Large. Maximum Size Is 2MB';
      setError(message);
      toast.error(message);
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
      toast.success('Club Logo Uploaded');
    } catch (err) {
      const message = safeErrorMessage(err, 'Upload failed');
      setError(message);
      // The inline message sits below a grid the user may have scrolled past.
      // An upload that failed must announce itself, not wait to be found.
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const handlePresetSelect = (preset: (typeof PRESET_LOGOS)[0]) => {
    if (selectedPreset === preset.file) return; // already on, nothing to say
    // Preview updates in the same tick as the tap: the change is visible
    // before anything is written anywhere.
    setSelectedPreset(preset.file);
    setPreview(preset.file);
    setError(null);

    // Presets are static assets, so the id IS the url. Writing it to the club
    // row is the caller's job (ClubSettingsPage saves the whole form at once),
    // which is why this confirms "Selected" and not "Saved".
    onLogoChange(preset.file);
    toast.success(`Logo Selected. ${preset.name}`);
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
            alt="Club Logo Preview"
            className="logo-preview__image"
          />
        ) : (
          <div className="logo-preview__placeholder">
            <span className="logo-preview__icon">IMG</span>
            <span className="logo-preview__text">No Logo Selected</span>
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
            <p className="logo-upload__hint">JPEG, PNG, GIF Or WebP. Max 2MB.</p>
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
