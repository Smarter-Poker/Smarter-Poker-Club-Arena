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

import { useState, useRef, useEffect, useCallback } from 'react';
import { MEDIA_BASE } from '../../utils/mediaBase';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ClubsService } from '../../services/ClubsService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import haptic from '../../services/HapticService';
import styles from './CreateClubModal.module.css';
import { reportError } from '../../utils/errorReporter';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { optimizeClubLogo } from '../../utils/clubLogoImage';
import { useDialogEscape } from '../../hooks/useDialogEscape';
import { ClubEntryTrustService } from '../../services/ClubEntryTrustService';
import { titleCase } from '../../utils/titleCase';

const CREATE_DRAFT_KEY = 'club-arena:create-draft:v1';

interface CreateClubModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (clubId: string) => void;
}

// All new clubs start at Level 1 — server-side trigger will recompute
// after the owner membership row is inserted into club_members.

export default function CreateClubModal({ isOpen, onClose, onSuccess }: CreateClubModalProps) {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
  const toast = useToast();

  const [clubName, setClubName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [hasAgreed, setHasAgreed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showLogoGenerator, setShowLogoGenerator] = useState(false);
  const [visibleFormElements, setVisibleFormElements] = useState<boolean[]>([]);
  const [nameStatus, setNameStatus] = useState<
    'idle' | 'checking' | 'available' | 'taken' | 'error'
  >('idle');
  const [allowance, setAllowance] = useState<{
    canCreate: boolean;
    membershipCount: number;
    maxClubs: number | null;
    remaining: number | null;
  } | null>(null);
  const [allowanceError, setAllowanceError] = useState(false);
  const [allowanceRetry, setAllowanceRetry] = useState(0);
  const [isOptimizingLogo, setIsOptimizingLogo] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const trapRef = useFocusTrap(isOpen && !showLogoGenerator);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const creationRequestIdRef = useRef<string>(crypto.randomUUID());
  const eligibilitySequenceRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setAllowance(null);
    setAllowanceError(false);
    setDraftRestored(false);
    ClubEntryTrustService.track('create', 'opened', { outcome: 'viewed' });
    try {
      const saved = window.localStorage.getItem(CREATE_DRAFT_KEY);
      if (saved) {
        const draft = JSON.parse(saved) as {
          name?: string;
          description?: string;
          isPublic?: boolean;
          requiresApproval?: boolean;
          requestId?: string;
        };
        setClubName(draft.name || '');
        setDescription(draft.description || '');
        setIsPublic(draft.isPublic ?? true);
        setRequiresApproval(draft.requiresApproval ?? false);
        if (/^[0-9a-f-]{36}$/i.test(draft.requestId || '')) {
          creationRequestIdRef.current = draft.requestId!;
        }
        setDraftRestored(Boolean(draft.name || draft.description));
        if (draft.name || draft.description) {
          ClubEntryTrustService.track('create', 'draft_restored', { outcome: 'succeeded' });
        }
      }
    } catch (error) {
      reportError(error, 'CreateClubModal.RestoreDraft');
    }
    setVisibleFormElements([]);
    const timers = [0, 1, 2, 3, 4].map((i) =>
      setTimeout(() => {
        setVisibleFormElements((prev) => [...prev, true]);
      }, i * 80)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const draft = {
      name: clubName,
      description,
      isPublic,
      requiresApproval,
      requestId: creationRequestIdRef.current,
    };
    try {
      if (clubName || description)
        window.localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(draft));
      else window.localStorage.removeItem(CREATE_DRAFT_KEY);
    } catch (error) {
      reportError(error, 'CreateClubModal.SaveDraft');
    }
  }, [clubName, description, isPublic, requiresApproval, isOpen]);

  useEffect(() => {
    if (!isOpen || clubName.trim().length < 3) {
      setNameStatus('idle');
      return;
    }
    setNameStatus('checking');
    const timer = window.setTimeout(async () => {
      try {
        const available = await ClubsService.checkNameAvailability(clubName);
        if (isMounted.current) setNameStatus(available ? 'available' : 'taken');
      } catch {
        if (isMounted.current) setNameStatus('error');
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [clubName, isOpen, isMounted]);

  useEffect(() => {
    if (!isOpen || !user?.id) return;
    const sequence = ++eligibilitySequenceRef.current;
    setAllowance(null);
    setAllowanceError(false);
    ClubsService.getCreationEligibility()
      .then((result) => {
        if (isMounted.current && sequence === eligibilitySequenceRef.current) setAllowance(result);
      })
      .catch((error) => {
        reportError(error, 'CreateClubModal.CreationEligibility');
        if (isMounted.current && sequence === eligibilitySequenceRef.current) {
          setAllowance(null);
          setAllowanceError(true);
        }
      });
  }, [allowanceRetry, isOpen, user?.id, isMounted]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsOptimizingLogo(true);
    try {
      setLogoPreview(await optimizeClubLogo(file));
      toast.success('Logo optimized for Club Arena');
    } catch (error) {
      toast.error(safeErrorMessage(error, 'Could not process that image'));
    } finally {
      setIsOptimizingLogo(false);
      e.target.value = '';
    }
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
    if (nameStatus !== 'available') {
      toast.error(
        nameStatus === 'taken'
          ? 'That club name is already taken'
          : 'Wait for the name availability check'
      );
      return;
    }
    if (!allowance?.canCreate) {
      toast.error('Your four-club allowance is full. Leave a club before creating another.');
      return;
    }
    setIsCreating(true);
    const startedAt = performance.now();
    ClubEntryTrustService.track('create', 'submitted', { outcome: 'started' });

    try {
      const clubData = await ClubsService.create({
        request_id: creationRequestIdRef.current,
        name: clubName.trim(),
        description: description.trim(),
        is_public: isPublic,
        requires_approval: requiresApproval,
        logoPreview: logoPreview,
      });

      if (!isMounted.current) return;

      haptic.success();
      toast.success(`Club "${clubName}" created successfully!`);

      setClubName('');
      setDescription('');
      setLogoPreview(null);
      setHasAgreed(false);
      setDraftRestored(false);
      window.localStorage.removeItem(CREATE_DRAFT_KEY);
      creationRequestIdRef.current = crypto.randomUUID();
      ClubEntryTrustService.track('create', 'completed', {
        outcome: 'succeeded',
        durationMs: Math.round(performance.now() - startedAt),
      });

      onClose();
      onSuccess?.(clubData.id);

      // No CLUB_JOINED emit here: ClubsService.create() already emits it via
      // the owner auto-join inside joinClub(). This modal's second emit made
      // every subscriber refetch twice per created club.
    } catch (err: any) {
      ClubEntryTrustService.track('create', 'completed', {
        outcome: 'failed',
        durationMs: Math.round(performance.now() - startedAt),
        metadata: { error_code: err?.code || 'unknown' },
      });
      reportError(err, 'CreateClubModal.Failed_to_create_club');
      if (isMounted.current) toast.error(err.message || 'Failed to create club');
    } finally {
      if (isMounted.current) setIsCreating(false);
    }
  };

  const hasDraft = Boolean(clubName.trim() || description.trim() || logoPreview);
  const requestClose = useCallback(() => {
    if (isCreating) return;
    if (
      hasDraft &&
      !window.confirm('Close Create Club? Your text settings will remain saved as a draft.')
    )
      return;
    ClubEntryTrustService.track('create', 'closed', { outcome: 'cancelled' });
    onClose();
  }, [hasDraft, isCreating, onClose]);
  useDialogEscape(isOpen, requestClose, showLogoGenerator);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={requestClose}>
      <div
        ref={trapRef}
        className={styles.modalContainer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-club-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.artPanel} aria-hidden="true">
          <img
            src="/hub/club-arena/images/club-arena/vault-iris-emblem-v1-320.webp"
            alt=""
            width="320"
            height="296"
          />
          <span>OWNER CONSOLE</span>
        </div>
        <div className={styles.contentPanel}>
          <button
            className={styles.closeButton}
            onClick={() => {
              haptic.light();
              requestClose();
            }}
            aria-label="Close"
          />

          <div className={styles.scrollBody}>
            <span className={styles.eyebrow}>Club Arena / New Organization</span>
            <h2 id="create-club-title" className={styles.title}>
              Create A Club
            </h2>
            <p className={styles.subtitle}>
              Name Your Room, Establish Its Identity, And Open The Doors.
            </p>

            <div className={styles.creationMeta} aria-live="polite">
              {allowance ? (
                <span>{`${allowance.remaining ?? 'Unlimited'} Club Slots Remaining`}</span>
              ) : allowanceError ? (
                <button
                  type="button"
                  className={styles.metaRetryButton}
                  onClick={() => setAllowanceRetry((attempt) => attempt + 1)}
                >
                  Allowance Check Failed · Retry
                </button>
              ) : (
                <span>Verifying Club Allowance…</span>
              )}
              {draftRestored && <span>Draft Restored</span>}
            </div>

            <label className={styles.fieldLabel} htmlFor="new-club-name">
              Club Name
            </label>
            <input
              id="new-club-name"
              type="text"
              className={styles.clubNameInput}
              placeholder="E.G. River Room"
              value={clubName}
              onChange={(e) => setClubName(e.target.value)}
              maxLength={30}
              autoComplete="off"
              style={{
                opacity: visibleFormElements[0] ? 1 : 0,
                transition: 'opacity 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            />
            <div className={`${styles.nameStatus} ${styles[nameStatus]}`} aria-live="polite">
              {nameStatus === 'checking' && 'Checking Availability…'}
              {nameStatus === 'available' && 'Name Available'}
              {nameStatus === 'taken' && 'Name Already In Use'}
              {nameStatus === 'error' && 'Availability Check Unavailable'}
            </div>

            <label className={styles.fieldLabel} htmlFor="new-club-description">
              Description <span>Optional</span>
            </label>
            <textarea
              id="new-club-description"
              className={styles.descriptionInput}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={180}
              placeholder="What Kind Of Room Are You Building?"
            />

            <span className={styles.fieldLabel}>Club Identity</span>
            <div className={styles.logoWorkspace}>
              <div className={styles.logoPreview}>
                {logoPreview ? (
                  <img src={logoPreview} alt="Selected Club Logo" className={styles.logoThumb} />
                ) : (
                  <span aria-hidden="true">♣</span>
                )}
              </div>
              <div className={styles.logoActions}>
                <button
                  className={styles.uploadLogoBtn}
                  onClick={() => {
                    haptic.medium();
                    fileInputRef.current?.click();
                  }}
                >
                  <span>{isOptimizingLogo ? 'Optimizing…' : 'Upload Image'}</span>
                  <small>PNG, JPG Or WEBP · 5MB Max</small>
                </button>
                <button
                  className={styles.createLogoBtn}
                  onClick={() => {
                    haptic.medium();
                    setShowLogoGenerator(true);
                  }}
                >
                  <span>Generate With AI</span>
                  <small>Describe A Custom Club Mark</small>
                </button>
              </div>
            </div>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className={styles.hiddenInput}
              onChange={handleFileSelect}
            />

            <fieldset className={styles.accessSettings}>
              <legend>Launch Settings</legend>
              <label>
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(event) => setIsPublic(event.target.checked)}
                />{' '}
                Discoverable In Club Arena
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={requiresApproval}
                  onChange={(event) => setRequiresApproval(event.target.checked)}
                />{' '}
                Review Join Requests
              </label>
            </fieldset>

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
              <span className={styles.checkboxVisual} aria-hidden="true" />
              <span>I Confirm I Can Manage This Club And Accept The Club Arena Terms.</span>
            </label>
          </div>

          <footer className={styles.pageFooter}>
            {/* CREATE button zone */}
            <button
              className={styles.createButton}
              onClick={() => {
                haptic.medium();
                handleCreate();
              }}
              disabled={
                isCreating ||
                isOptimizingLogo ||
                !hasAgreed ||
                !clubName.trim() ||
                !logoPreview ||
                nameStatus !== 'available' ||
                allowance?.canCreate !== true
              }
              aria-label="Create Club"
              style={{
                opacity: visibleFormElements[4] ? 1 : 0,
                transform: visibleFormElements[4] ? 'scale(1)' : 'scale(0.9)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              {isCreating && <span className={styles.spinner} aria-hidden="true" />}
              {isCreating ? 'Creating Club…' : 'Create Club'}
            </button>
          </footer>
        </div>

        {/* Logo Generator Modal */}
        {showLogoGenerator && (
          <LogoGeneratorModal
            clubName={clubName.trim()}
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
  const trapRef = useFocusTrap(true);
  const [logoDescription, setLogoDescription] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useDialogEscape(true, onClose);

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
        ClubEntryTrustService.track('create', 'logo_generated', { outcome: 'succeeded' });
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
        ref={trapRef}
        className={styles.logoGeneratorModalContainer}
        role="dialog"
        aria-modal="true"
        aria-label="Generate A Club Logo"
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
              <div className={styles.generatorSpinner} aria-hidden="true" />
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
                Use This Logo
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

            {error && <div className={styles.errorMessage}>{titleCase(error)}</div>}
          </>
        )}
      </div>
    </div>
  );
}
