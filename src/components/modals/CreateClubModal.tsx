/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CreateClubModal — Full-Page Club Creation Console
 * ═══════════════════════════════════════════════════════════════════════════════
 * Uses the sci-fi themed modal frame with:
 * - Club name input
 * - Ten curated placeholder crests or a custom upload
 * - Terms acceptance checkbox
 * - CREATE button
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { mediaUrl } from '../../utils/mediaBase';
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
import { uuid } from '../../utils/uuid';

const CREATE_DRAFT_KEY = 'club-arena:create-draft:v1';

export const DEFAULT_CLUB_LOGOS = [
  { id: 'spade', name: 'Spade Society', file: 'club-logos/preset-01.webp' },
  { id: 'club', name: 'Club Heritage', file: 'club-logos/preset-04.webp' },
  { id: 'crown', name: 'Royal Crown', file: 'club-logos/preset-06.webp' },
  { id: 'shield', name: 'Card Shield', file: 'club-logos/preset-08.webp' },
  { id: 'wolf', name: 'Midnight Wolf', file: 'club-logos/preset-09.webp' },
  { id: 'lion', name: 'Golden Lion', file: 'club-logos/preset-10.webp' },
  { id: 'dragon', name: 'Silver Dragon', file: 'club-logos/preset-12.webp' },
  { id: 'phoenix', name: 'Bronze Phoenix', file: 'club-logos/preset-14.webp' },
  { id: 'chip', name: 'Cardroom Chip', file: 'club-logos/preset-19.webp' },
  { id: 'aces', name: 'Four Aces', file: 'club-logos/preset-20.webp' },
] as const;

const DEFAULT_LOGO = DEFAULT_CLUB_LOGOS[8];
const defaultLogoUrl = (file: string) => mediaUrl(file);

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
  const [logoPreview, setLogoPreview] = useState<string>(defaultLogoUrl(DEFAULT_LOGO.file));
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(DEFAULT_LOGO.id);
  const [hasAgreed, setHasAgreed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
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
  const trapRef = useFocusTrap(isOpen);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const creationRequestIdRef = useRef<string>(uuid());
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
          logoPresetId?: string;
          requestId?: string;
        };
        setClubName(draft.name || '');
        setDescription(draft.description || '');
        setIsPublic(draft.isPublic ?? true);
        setRequiresApproval(draft.requiresApproval ?? false);
        const restoredLogo = DEFAULT_CLUB_LOGOS.find((logo) => logo.id === draft.logoPresetId);
        if (restoredLogo) {
          setSelectedPresetId(restoredLogo.id);
          setLogoPreview(defaultLogoUrl(restoredLogo.file));
        }
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
      logoPresetId: selectedPresetId,
      requestId: creationRequestIdRef.current,
    };
    try {
      if (clubName || description)
        window.localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(draft));
      else window.localStorage.removeItem(CREATE_DRAFT_KEY);
    } catch (error) {
      reportError(error, 'CreateClubModal.SaveDraft');
    }
  }, [clubName, description, isPublic, requiresApproval, selectedPresetId, isOpen]);

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
      setSelectedPresetId(null);
      toast.success('Custom Logo Ready');
    } catch (error) {
      toast.error(safeErrorMessage(error, 'Could not process that image'));
    } finally {
      setIsOptimizingLogo(false);
      e.target.value = '';
    }
  };

  const handlePresetSelect = (logo: (typeof DEFAULT_CLUB_LOGOS)[number]) => {
    haptic.selection();
    setSelectedPresetId(logo.id);
    setLogoPreview(defaultLogoUrl(logo.file));
    toast.success(`${logo.name} Selected`);
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
      toast.error('Please Select Or Upload A Club Logo');
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
        logoPreview: selectedPresetId ? null : logoPreview,
        logoUrl: selectedPresetId ? logoPreview : null,
      });

      if (!isMounted.current) return;

      haptic.success();
      toast.success(`Club "${clubName}" created successfully!`);

      setClubName('');
      setDescription('');
      setLogoPreview(defaultLogoUrl(DEFAULT_LOGO.file));
      setSelectedPresetId(DEFAULT_LOGO.id);
      setHasAgreed(false);
      setDraftRestored(false);
      window.localStorage.removeItem(CREATE_DRAFT_KEY);
      creationRequestIdRef.current = uuid();
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

  // A built-in placeholder is the pristine default, not unsaved work.
  const hasDraft = Boolean(clubName.trim() || description.trim() || selectedPresetId === null);
  const requestClose = useCallback(() => {
    if (isCreating) return;
    if (
      hasDraft &&
      !window.confirm('Close Create Club? Your Text Settings Will Remain Saved As A Draft.')
    )
      return;
    ClubEntryTrustService.track('create', 'closed', { outcome: 'cancelled' });
    onClose();
  }, [hasDraft, isCreating, onClose]);
  useDialogEscape(isOpen, requestClose);

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
            src={mediaUrl('images/club-arena/vault-iris-emblem-v1-320.webp')}
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

            <fieldset className={styles.crestVault}>
              <legend>Club Crest Vault</legend>
              <div className={styles.crestVaultHeader}>
                <div className={styles.logoPreview}>
                  <img src={logoPreview} alt="Selected Club Logo" className={styles.logoThumb} />
                  <span className={styles.previewStatus}>
                    {selectedPresetId ? 'Placeholder Crest Selected' : 'Custom Logo Selected'}
                  </span>
                </div>
                <div className={styles.identityCopy}>
                  <strong>Choose A Starting Identity</strong>
                  <p>
                    Select One Of Ten Club Arena Crests Now. The Club Owner Can Replace It With A
                    Custom Logo At Any Time.
                  </p>
                  <button
                    type="button"
                    className={styles.uploadLogoBtn}
                    disabled={isOptimizingLogo}
                    onClick={() => {
                      haptic.medium();
                      fileInputRef.current?.click();
                    }}
                  >
                    <span>{isOptimizingLogo ? 'Optimizing Logo…' : 'Upload A Custom Logo'}</span>
                    <small>PNG, JPG Or WEBP · 5MB Maximum</small>
                  </button>
                </div>
              </div>

              <div className={styles.crestGrid} role="radiogroup" aria-label="Default Club Logos">
                {DEFAULT_CLUB_LOGOS.map((logo) => {
                  const selected = selectedPresetId === logo.id;
                  return (
                    <button
                      key={logo.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={logo.name}
                      className={`${styles.crestOption} ${selected ? styles.crestOptionSelected : ''}`}
                      onClick={() => handlePresetSelect(logo)}
                    >
                      <img src={defaultLogoUrl(logo.file)} alt="" loading="lazy" decoding="async" />
                      <span>{logo.name}</span>
                      {selected && <small>Selected</small>}
                    </button>
                  );
                })}
              </div>
            </fieldset>

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
      </div>
    </div>
  );
}
