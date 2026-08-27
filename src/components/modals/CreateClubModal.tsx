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
import { ClubsService } from '../../services/ClubsService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
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
// PERF 2026-08-23: both of this modal's frames ship as PNG *and* WebP, and
// the code asked for the PNG - so every open pulled the larger twin while
// the smaller one sat unused beside it in the bundle. 260KB -> 158KB and
// 272KB -> 155KB at source. WebP is referenced directly elsewhere in this
// app (images/mystery-chest.webp), so no fallback shim is warranted.
const MODAL_FRAME_URL = `${MEDIA_BASE}images/modals/create-club-modal-frame.webp`;

// All new clubs start at Level 1 — server-side trigger will recompute
// after the owner membership row is inserted into club_members.

export default function CreateClubModal({ isOpen, onClose, onSuccess }: CreateClubModalProps) {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
  const toast = useToast();

  const [clubName, setClubName] = useState('');
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

    if (isCreating) return;
    setIsCreating(true);

    try {
      const clubData = await ClubsService.create({
        name: clubName.trim(),
        is_public: true,
        requires_approval: false,
        logoPreview: logoPreview,
      });

      if (!isMounted.current) return;

      toast.success(`Club "${clubName}" created successfully!`);

      setClubName('');
      setLogoPreview(null);
      setHasAgreed(false);

      onClose();
      onSuccess?.(clubData.id);

      // No CLUB_JOINED emit here: ClubsService.create() already emits it via
      // the owner auto-join inside joinClub(). This modal's second emit made
      // every subscriber refetch twice per created club.
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
          src={`${MEDIA_BASE}images/logo-generator-frame.webp`}
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
                fontFamily: 'Rajdhani, monospace',
                fontSize: '24px',
                fontWeight: 600,
                textShadow: '0 0 20px rgba(0, 212, 255, 0.8)',
              }}
            >
              <div style={{ fontSize: '48px', marginBottom: '20px' }}>◷</div>
              <div>GENERATING LOGO...</div>
              <div style={{ fontSize: '14px', marginTop: '10px', opacity: 0.7 }}>
                Powered By Club Arena
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
              placeholder="E.g., A Fierce Shark With Glowing Eyes, Cyberpunk Style..."
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
