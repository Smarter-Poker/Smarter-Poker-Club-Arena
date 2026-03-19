/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CreateClubModal — High-Fidelity Club Creation Popup
 * ═══════════════════════════════════════════════════════════════════════════════
 * Uses the sci-fi themed modal frame with:
 * - Club name input
 * - Logo upload or generation buttons
 * - Terms acceptance checkbox
 * - CREATE button
 */

import { useState, useRef, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { ClubCardGenerator } from '../../services/ClubCardGenerator';
import { sanitizeInput } from '../../utils/sanitizeInput';
import haptic from '../../services/HapticService';
import styles from './CreateClubModal.module.css';

interface CreateClubModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (clubId: string) => void;
}

// High-fidelity modal frame
const MODAL_FRAME_URL = `${import.meta.env.BASE_URL}images/modals/create-club-modal-frame.png`;

// Club level calculation based on member count
function calculateClubLevel(memberCount: number): number {
  const levelThresholds = [
    25,
    50,
    75,
    100,
    150,
    200,
    275,
    350,
    425,
    500, // Levels 1-10
    600,
    750,
    900,
    1100,
    1300,
    1550,
    1850,
    2200,
    2600,
    3000, // Levels 11-20
    3500,
    4000,
    4600,
    5300,
    6000,
    7000,
    8250,
    9750,
    11500,
    13500, // Levels 21-30
    16000,
    19000,
    22500,
    26500,
    31000,
    36500,
    43000,
    50500,
    59000,
    68500, // Levels 31-40
    79000,
    91000,
    105000,
    121000,
    140000,
    165000,
    195000,
    235000,
    285000, // Levels 41-49
  ];

  for (let i = 0; i < levelThresholds.length; i++) {
    if (memberCount <= levelThresholds[i]) return i + 1;
  }
  return 50; // Max level
}

export default function CreateClubModal({ isOpen, onClose, onSuccess }: CreateClubModalProps) {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
  const toast = useToast();

  const [clubName, setClubName] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [hasAgreed, setHasAgreed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showLogoGenerator, setShowLogoGenerator] = useState(false);
  const [visibleFormElements, setVisibleFormElements] = useState<boolean[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setVisibleFormElements([]);
    [0, 1, 2, 3, 4].forEach((i) => {
      setTimeout(() => {
        setVisibleFormElements((prev) => [...prev, true]);
      }, i * 80);
    });
  }, [isOpen]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be less than 5MB');
      return;
    }

    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      setLogoPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleLogoGenerated = (logoDataUrl: string) => {
    setLogoPreview(logoDataUrl);
    setShowLogoGenerator(false);
  };

  const handleCreate = async () => {
    if (!clubName.trim()) {
      toast.error('Please enter a club name');
      return;
    }

    if (clubName.trim().length < 3) {
      toast.error('Club name must be at least 3 characters');
      return;
    }

    if (!logoPreview) {
      toast.error('Please upload or create a logo');
      return;
    }

    if (!hasAgreed) {
      toast.error('Please accept the terms to continue');
      return;
    }

    // Auth guard
    if (!user?.id) {
      toast.error('You must be logged in to create a club.');
      return;
    }

    // Double-click protection
    if (isCreating) return;

    // Check for duplicate club name
    try {
      const { data: existing } = await supabase
        .from('clubs')
        .select('id')
        .ilike('name', clubName.trim())
        .limit(1);

      if (existing && existing.length > 0) {
        if (isMounted.current) toast.error('A club with this name already exists');
        return;
      }
    } catch (err) {
      console.error('[CreateClubModal] Error:', err);
      // Non-blocking
    }

    setIsCreating(true);

    // 4-club membership limit
    try {
      const { count, error: countError } = await supabase
        .from('club_members')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .in('status', ['active', 'approved']);

      if (!countError && count !== null && count >= 4) {
        if (isMounted.current) {
          toast.error(
            'You can only be a member of up to 4 clubs. Leave a club to create a new one.'
          );
          setIsCreating(false);
        }
        return;
      }
    } catch {
      // Non-blocking
    }

    try {
      // Generate club card image
      const tempClubId = Math.floor(100000 + Math.random() * 900000);
      const cardDataUrl = await ClubCardGenerator.generateCard({
        logoUrl: logoPreview,
        clubId: tempClubId,
        clubName: sanitizeInput(clubName.trim()).toUpperCase(),
      });

      // Upload card to storage
      const cardBlob = await fetch(cardDataUrl).then((r) => r.blob());
      const cardFileName = `club-cards/${tempClubId}-card.png`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('club-assets')
        .upload(cardFileName, cardBlob, {
          contentType: 'image/png',
          upsert: true,
        });

      if (uploadError) {
        console.error('Upload error:', uploadError);
      }

      let cardUrl = null;
      if (uploadData) {
        const { data: urlData } = supabase.storage.from('club-assets').getPublicUrl(cardFileName);
        cardUrl = urlData.publicUrl;
      }

      // Insert club with collision retry for random club_id
      let clubData: any = null;
      let lastInsertError: any = null;
      const MAX_RETRIES = 3;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const clubIdNumber = Math.floor(100000 + Math.random() * 900000);

        const { data: insertData, error: insertError } = await supabase
          .from('clubs')
          .insert({
            club_id: clubIdNumber,
            name: sanitizeInput(clubName.trim()),
            owner_id: user.id,
            is_public: true,
            requires_approval: false,
            card_image_url: cardUrl,
            logo_url: cardUrl,
            member_count: 1,
            level: calculateClubLevel(1),
            active_players: 1,
            settings: {
              default_rake_percent: 5,
              rake_cap: 3,
              min_buy_in_bb: 40,
              max_buy_in_bb: 200,
              time_bank_seconds: 30,
              allow_straddle: true,
              allow_run_it_twice: true,
            },
          })
          .select()
          .maybeSingle();

        if (!insertError && insertData) {
          clubData = insertData;
          break;
        }

        lastInsertError = insertError;
        if (
          insertError &&
          !insertError.message?.includes('duplicate') &&
          !insertError.message?.includes('unique')
        ) {
          throw insertError;
        }
      }

      if (!clubData) throw lastInsertError || new Error('Club creation failed after retries');

      // Add owner as first member — cleanup orphan if this fails
      const { error: memberError } = await supabase.from('club_members').insert({
        club_id: clubData.id,
        user_id: user.id,
        role: 'owner',
        status: 'active',
      });

      if (memberError) {
        console.error(
          '[CreateClubModal] Owner membership failed, cleaning up orphaned club:',
          memberError
        );
        await supabase.from('clubs').delete().eq('id', clubData.id);
        throw new Error('Failed to set up club ownership. Please try again.');
      }

      if (!isMounted.current) return;

      if (isMounted.current) toast.success(`Club "${clubName}" created successfully!`);

      setClubName('');
      setLogoFile(null);
      setLogoPreview(null);
      setHasAgreed(false);

      onClose();
      onSuccess?.(clubData.id);
      window.location.reload();
    } catch (err: any) {
      console.error('Failed to create club:', err);
      if (isMounted.current) toast.error(err.message || 'Failed to create club');
    } finally {
      if (isMounted.current) setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modalContainer} onClick={(e) => e.stopPropagation()}>
        {/* High-fidelity frame background - hidden when logo generator is open */}
        <img
          loading="lazy"
          decoding="async"
          src={MODAL_FRAME_URL}
          alt=""
          className={styles.frameImage}
          draggable={false}
          style={{ display: showLogoGenerator ? 'none' : 'block' }}
        />

        {/* Close button - positioned over the X in frame */}
        <button
          className={styles.closeButton}
          onClick={() => {
            haptic.light();
            onClose();
          }}
          aria-label="Close"
        />

        {/* Club Name Input - positioned over the input field in frame */}
        <input
          type="text"
          className={styles.clubNameInput}
          placeholder=""
          value={clubName}
          onChange={(e) => setClubName(e.target.value)}
          maxLength={30}
          autoComplete="off"
          style={{
            opacity: visibleFormElements[0] ? 1 : 0,
            transition: 'opacity 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        />

        {/* Upload Logo button zone */}
        <button
          className={styles.uploadLogoBtn}
          onClick={() => {
            haptic.medium();
            fileInputRef.current?.click();
          }}
          aria-label="Upload Logo"
          style={{
            opacity: visibleFormElements[1] ? 1 : 0,
            transform: visibleFormElements[1] ? 'scale(1)' : 'scale(0.9)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          {logoPreview && (
            <img
              loading="lazy"
              decoding="async"
              src={logoPreview}
              alt="Logo preview"
              className={styles.logoThumb}
            />
          )}
        </button>

        {/* Create Logo button zone */}
        <button
          className={styles.createLogoBtn}
          onClick={() => {
            haptic.medium();
            setShowLogoGenerator(true);
          }}
          aria-label="Create Logo"
          style={{
            opacity: visibleFormElements[2] ? 1 : 0,
            transform: visibleFormElements[2] ? 'scale(1)' : 'scale(0.9)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          {logoPreview && (
            <img
              loading="lazy"
              decoding="async"
              src={logoPreview}
              alt="Logo preview"
              className={styles.logoThumb}
            />
          )}
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className={styles.hiddenInput}
          onChange={handleFileSelect}
        />

        {/* Terms checkbox - positioned over the checkbox area */}
        <label
          className={styles.termsLabel}
          style={{
            opacity: visibleFormElements[3] ? 1 : 0,
            transform: visibleFormElements[3] ? 'scale(1)' : 'scale(0.9)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <input
            type="checkbox"
            checked={hasAgreed}
            onChange={(e) => {
              haptic.selection();
              setHasAgreed(e.target.checked);
            }}
            className={styles.termsCheckbox}
          />
          <span className={styles.checkboxVisual} />
        </label>

        {/* CREATE button zone */}
        <button
          className={styles.createButton}
          onClick={() => {
            haptic.success();
            handleCreate();
          }}
          disabled={isCreating || !hasAgreed || !clubName.trim() || !logoPreview}
          aria-label="Create Club"
          style={{
            opacity: visibleFormElements[4] ? 1 : 0,
            transform: visibleFormElements[4] ? 'scale(1)' : 'scale(0.9)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          {isCreating && <span className={styles.spinner}>⟳</span>}
        </button>

        {/* Logo Generator Modal */}
        {showLogoGenerator && (
          <LogoGeneratorModal
            onSelect={handleLogoGenerated}
            onClose={() => setShowLogoGenerator(false)}
          />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Logo Generator Modal — Powered by OpenAI DALL-E
// ═══════════════════════════════════════════════════════════════════════════════

interface LogoGeneratorModalProps {
  onSelect: (logoDataUrl: string) => void;
  onClose: () => void;
  clubName?: string;
}

// Logo style presets
const LOGO_PRESETS = [
  { id: 'shark', icon: '🦈', name: 'Shark', theme: 'shark', style: 'aggressive' as const },
  { id: 'dragon', icon: '🐉', name: 'Dragon', theme: 'dragon', style: 'classic' as const },
  { id: 'eagle', icon: '🦅', name: 'Eagle', theme: 'eagle', style: 'elegant' as const },
  { id: 'lion', icon: '🦁', name: 'Lion', theme: 'lion', style: 'aggressive' as const },
  { id: 'phoenix', icon: '🔥', name: 'Phoenix', theme: 'phoenix', style: 'modern' as const },
  { id: 'wolf', icon: '🐺', name: 'Wolf', theme: 'wolf', style: 'classic' as const },
  {
    id: 'cards',
    icon: '🂡',
    name: 'Cards',
    theme: 'playing cards and poker chips',
    style: 'elegant' as const,
  },
  {
    id: 'crown',
    icon: '👑',
    name: 'Crown',
    theme: 'royal crown with poker elements',
    style: 'elegant' as const,
  },
  {
    id: 'diamond',
    icon: '💎',
    name: 'Diamond',
    theme: 'diamond gemstone',
    style: 'modern' as const,
  },
  {
    id: 'skull',
    icon: '💀',
    name: 'Skull',
    theme: 'skull with poker elements',
    style: 'aggressive' as const,
  },
  { id: 'tiger', icon: '🐯', name: 'Tiger', theme: 'tiger', style: 'playful' as const },
  { id: 'spade', icon: '♠️', name: 'Spade', theme: 'spade suit symbol', style: 'classic' as const },
];

function LogoGeneratorModal({ onSelect, onClose, clubName = '' }: LogoGeneratorModalProps) {
  const isMounted = useIsMounted();
  const [logoDescription, setLogoDescription] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!logoDescription.trim()) {
      return;
    }

    setIsGenerating(true);
    setError(null);
    setPreviewUrl(null);

    try {
      // Import the service dynamically
      const { generateClubLogo } = await import('../../services/LogoGeneratorService');

      const result = await generateClubLogo({
        clubName: clubName || 'Poker Club',
        style: 'modern',
        theme: logoDescription.trim(),
      });

      if (!isMounted.current) return;

      if (result.success && result.logoUrl) {
        setPreviewUrl(result.logoUrl);
      } else {
        if (isMounted.current) setError(result.error || 'Failed to generate logo');
      }
    } catch (err) {
      console.error('Failed to generate logo:', err);
      if (isMounted.current) setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (isMounted.current) setIsGenerating(false);
    }
  };

  const handleUsePreview = () => {
    if (previewUrl) {
      onSelect(previewUrl);
    }
  };

  return (
    <div className={styles.logoGeneratorOverlay} onClick={onClose}>
      <div
        className={styles.logoGeneratorModalContainer}
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: isGenerating || previewUrl ? 'rgba(10, 10, 26, 0.98)' : 'transparent',
        }}
      >
        {/* Frame - explicitly hidden during generation/preview */}
        <img
          loading="lazy"
          decoding="async"
          src="/hub/club-arena/images/logo-generator-frame.png"
          alt="Frame"
          className={styles.frameImage}
          style={{ display: isGenerating || previewUrl ? 'none' : 'block' }}
        />

        {/* Close button positioned over X */}
        <button
          className={styles.closeButton}
          onClick={() => {
            haptic.light();
            onClose();
          }}
          aria-label="Close"
        />

        {isGenerating ? (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(10, 10, 26, 0.98)',
              zIndex: 99999,
            }}
          >
            <div
              style={{
                textAlign: 'center',
                color: '#00d4ff',
                fontFamily: 'Orbitron, monospace',
                fontSize: '24px',
                fontWeight: 600,
                textShadow: '0 0 20px rgba(0, 212, 255, 0.8)',
              }}
            >
              <div style={{ fontSize: '48px', marginBottom: '20px' }}>⏳</div>
              <div>GENERATING LOGO...</div>
              <div style={{ fontSize: '14px', marginTop: '10px', opacity: 0.7 }}>
                Powered by Club Arena
              </div>
            </div>
          </div>
        ) : previewUrl ? (
          <>
            <div className={styles.previewContainer}>
              <img
                loading="lazy"
                decoding="async"
                src={previewUrl}
                alt="Generated Logo"
                className={styles.previewImage}
              />
            </div>

            <div className={styles.logoGeneratorActions}>
              <button className={styles.generateBtn} onClick={handleUsePreview}>
                ✓ Use This Logo
              </button>
              <button
                className={styles.cancelBtn}
                onClick={() => {
                  setPreviewUrl(null);
                  setLogoDescription('');
                }}
              >
                Try Another
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Textarea positioned over the grid area */}
            <textarea
              className={styles.descriptionTextarea}
              placeholder="e.g., A fierce shark with glowing eyes, cyberpunk style..."
              value={logoDescription}
              onChange={(e) => setLogoDescription(e.target.value)}
              style={{ display: isGenerating || previewUrl ? 'none' : 'block' }}
            />

            {/* Submit button positioned over SUBMIT button */}
            <button
              className={styles.submitButton}
              onClick={() => {
                haptic.success();
                handleGenerate();
              }}
              disabled={!logoDescription.trim()}
              aria-label="Submit"
              style={{ display: isGenerating || previewUrl ? 'none' : 'flex' }}
            />

            {error && <div className={styles.errorMessage}>{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
