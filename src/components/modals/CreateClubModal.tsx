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
import { MEDIA_BASE } from '../../utils/mediaBase';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { ClubCardGenerator } from '../../services/ClubCardGenerator';
import { sanitizeInput } from '../../utils/sanitizeInput';
import { buildClubSlug, escapeIlikePattern } from '../../utils/clubSlug';
import { masterBus } from '../../core/MasterBus';
import haptic from '../../services/HapticService';
import styles from './CreateClubModal.module.css';
import { reportError } from '../../utils/errorReporter';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
interface CreateClubModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (clubId: string) => void;
}

// High-fidelity modal frame
const MODAL_FRAME_URL = `${MEDIA_BASE}images/modals/create-club-modal-frame.png`;

// All new clubs start at Level 1 — server-side trigger will recompute
// after the owner membership row is inserted into club_members.

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
    if (!isOpen) return;
    setVisibleFormElements([]);
    const timers = [0, 1, 2, 3, 4].map((i) =>
      setTimeout(() => {
        setVisibleFormElements((prev) => [...prev, true]);
      }, i * 80)
    );
    return () => timers.forEach((t) => clearTimeout(t));
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

    // Double-click protection — set BEFORE any await so a rapid second click
    // can't slip through while the duplicate-name check is in flight
    if (isCreating) return;
    setIsCreating(true);

    // Check for duplicate club name
    try {
      const { data: existing } = await supabase
        .from('clubs')
        .select('id')
        .ilike('name', escapeIlikePattern(clubName.trim()))
        .limit(1);

      if (existing && existing.length > 0) {
        if (isMounted.current) {
          toast.error('A club with this name already exists');
          setIsCreating(false);
        }
        return;
      }
    } catch (err) {
      reportError(err, 'CreateClubModal.Error');
      // Non-blocking
    }

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
    } catch (e) {
      reportError(e, 'CreateClubModal');
      // Non-blocking
    }

    try {
      // ── Step 1: Upload raw logo to storage ──────────────────────────────
      let logoUrl: string | null = null;
      try {
        const logoBlob = await fetch(logoPreview).then((r) => r.blob());
        const logoExt = logoBlob.type.includes('png') ? 'png' : 'jpg';
        const logoFileName = `club-logos/${Date.now()}-logo.${logoExt}`;

        const { data: logoUploadData, error: logoUploadError } = await supabase.storage
          .from('club-assets')
          .upload(logoFileName, logoBlob, {
            contentType: logoBlob.type || 'image/png',
            upsert: true,
          });

        if (!logoUploadError && logoUploadData) {
          const { data: urlData } = supabase.storage.from('club-assets').getPublicUrl(logoFileName);
          logoUrl = urlData?.publicUrl || null;
        } else {
          console.warn('[CreateClubModal] Logo upload failed, using data URL fallback');
        }
      } catch (e) {
        reportError(e, 'CreateClubModal.then');
        console.warn('[CreateClubModal] Logo upload failed, continuing without stored logo');
      }

      // ── Step 2: Insert club with collision retry ─────────────────────────
      let clubData: any = null;
      let lastInsertError: any = null;
      const MAX_RETRIES = 3;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // 5-digit code (10000-99999) — canonical format. The Join modal and all
        // existing production clubs use 5-digit codes; 6-digit codes were a bug
        // that made new clubs unjoinable by code.
        const clubIdNumber = Math.floor(10000 + Math.random() * 90000);

        // clubs.slug is UNIQUE — retries append the club_id (see utils/clubSlug)
        const slug = buildClubSlug(sanitizeInput(clubName.trim()), clubIdNumber, attempt);

        const { data: insertData, error: insertError } = await supabase
          .from('clubs')
          .insert({
            club_id: clubIdNumber,
            name: sanitizeInput(clubName.trim()),
            slug,
            owner_id: user.id,
            is_public: true,
            requires_approval: false,
            card_image_url: null, // Will be set after baked card generation
            // Raw logo URL (NOT the baked card). If the storage upload failed,
            // store NULL — never the base64 data URL: a multi-MB data URL in
            // this column gets pulled by every getUserMemberships call on
            // every home-page load. The baked card below still renders from
            // the local preview, and the logo can be re-uploaded in settings.
            logo_url: logoUrl,
            member_count: 1,
            level: 1,
            active_players: 1,
            settings: {
              default_rake_percent: 5,
              rake_cap: 3,
              min_buy_in_bb: 40,
              max_buy_in_bb: 200,
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
        // Name uniqueness (idx_clubs_name_lower) can never be fixed by a
        // retry — the name doesn't change between attempts.
        if (insertError?.message?.includes('idx_clubs_name_lower')) {
          throw new Error('A club with this name already exists');
        }
        if (
          insertError &&
          !insertError.message?.includes('duplicate') &&
          !insertError.message?.includes('unique')
        ) {
          throw insertError;
        }
      }

      if (!clubData) throw lastInsertError || new Error('Club creation failed after retries');

      // ── Step 3: Generate baked card with REAL club_id ────────────────────
      try {
        const { dataUrl, format } = await ClubCardGenerator.generateCard({
          logoUrl: logoUrl || logoPreview,
          clubId: clubData.club_id, // The ACTUAL club_id from the insert
          clubName: sanitizeInput(clubName.trim()).toUpperCase(),
        });

        const cardBlob = await fetch(dataUrl).then((r) => r.blob());
        const ext = format === 'webp' ? 'webp' : 'png';
        const contentType = format === 'webp' ? 'image/webp' : 'image/png';
        // v2 — see ClubCardBackfill: v1 files are whole baked cards.
        const cardFileName = `club-cards/${clubData.club_id}-card-v2.${ext}`;

        const { data: cardUploadData, error: cardUploadError } = await supabase.storage
          .from('club-assets')
          .upload(cardFileName, cardBlob, { contentType, upsert: true });

        if (!cardUploadError && cardUploadData) {
          const { data: urlData } = supabase.storage.from('club-assets').getPublicUrl(cardFileName);
          if (urlData?.publicUrl) {
            await supabase
              .from('clubs')
              .update({ card_image_url: urlData.publicUrl })
              .eq('id', clubData.id);
          }
        }
      } catch (cardErr) {
        // Non-blocking: club is created, card will be backfilled later
        console.warn('[CreateClubModal] Baked card generation failed (non-blocking):', cardErr);
      }

      // Add owner as first member — cleanup orphan if this fails
      const { error: memberError } = await supabase.from('club_members').insert({
        club_id: clubData.id,
        user_id: user.id,
        role: 'owner',
        status: 'active',
      });

      if (memberError) {
        reportError(memberError, 'CreateClubModal.Owner_membership_failed_cleaning_up_orph');
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
      // CLUB_JOINED drives all cross-page refreshes (HomePage subscribes with
      // fetchUserData). No full page reload — it destroyed the SPA navigation
      // to the new club that onSuccess just performed.
      masterBus.emit('CLUB_JOINED', { clubId: clubData.id, action: 'club_created' });
    } catch (err: any) {
      reportError(err, 'CreateClubModal.Failed_to_create_club');
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
  { id: 'shark', icon: '◆', name: 'Shark', theme: 'shark', style: 'aggressive' as const },
  { id: 'dragon', icon: '◆', name: 'Dragon', theme: 'dragon', style: 'classic' as const },
  { id: 'eagle', icon: '◆', name: 'Eagle', theme: 'eagle', style: 'elegant' as const },
  { id: 'lion', icon: '◆', name: 'Lion', theme: 'lion', style: 'aggressive' as const },
  { id: 'phoenix', icon: '▲', name: 'Phoenix', theme: 'phoenix', style: 'modern' as const },
  { id: 'wolf', icon: '◆', name: 'Wolf', theme: 'wolf', style: 'classic' as const },
  {
    id: 'cards',
    icon: '◆',
    name: 'Cards',
    theme: 'playing cards and poker chips',
    style: 'elegant' as const,
  },
  {
    id: 'crown',
    icon: '♛',
    name: 'Crown',
    theme: 'royal crown with poker elements',
    style: 'elegant' as const,
  },
  {
    id: 'diamond',
    icon: '◆',
    name: 'Diamond',
    theme: 'diamond gemstone',
    style: 'modern' as const,
  },
  {
    id: 'skull',
    icon: '◆',
    name: 'Skull',
    theme: 'skull with poker elements',
    style: 'aggressive' as const,
  },
  { id: 'tiger', icon: '◆', name: 'Tiger', theme: 'tiger', style: 'playful' as const },
  { id: 'spade', icon: '♠', name: 'Spade', theme: 'spade suit symbol', style: 'classic' as const },
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
        if (isMounted.current) setError(safeErrorMessage(result.error, 'Failed to generate logo'));
      }
    } catch (err) {
      reportError(err, 'CreateClubModal.Failed_to_generate_logo');
      if (isMounted.current) setError(safeErrorMessage(err, 'Unknown error'));
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
              <div style={{ fontSize: '48px', marginBottom: '20px' }}>◷</div>
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
