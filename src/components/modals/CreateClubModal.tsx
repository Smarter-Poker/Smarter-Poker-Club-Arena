/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CreateClubModal — Full-Page Club Creation Console
 * ═══════════════════════════════════════════════════════════════════════════════
 * Uses the sci-fi themed modal frame with:
 * - Club name input
 * - Ten curated placeholder crests or a custom upload
 * - Launch settings on the shared labeled On / Off switch
 * - Terms acceptance checkbox
 * - CREATE button
 * - An in-app close guard (a second console, never the browser's native dialog)
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
import { SpadeConsole } from '../console/SpadeConsole';
import { Toggle } from '../table-config/controls';

const CREATE_DRAFT_KEY = 'club-arena:create-draft:v1';

/**
 * A DRAFT BELONGS TO ONE ACCOUNT. The key used to be the bare literal above, so
 * a second account signing in on the same browser was handed the first
 * account's club name, description and creation request id. The literal stays
 * as the prefix; the signed-in user id scopes it. The bare key is legacy: it
 * carries no owner, so it is never adopted, only removed.
 */
const createDraftKeyFor = (userId: string) => `${CREATE_DRAFT_KEY}:${userId}`;

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
  /** The account whose draft the form currently holds. Saving waits for it. */
  const [draftHydratedFor, setDraftHydratedFor] = useState<string | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const trapRef = useFocusTrap(isOpen);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const creationRequestIdRef = useRef<string>(uuid());
  const eligibilitySequenceRef = useRef(0);
  const formOwnerRef = useRef<string | null>(null);
  const hasTypedRef = useRef(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const closeConfirmReturnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setAllowance(null);
    setAllowanceError(false);
    setCloseConfirmOpen(false);
    ClubEntryTrustService.track('create', 'opened', { outcome: 'viewed' });
    setVisibleFormElements([]);
    const timers = [0, 1, 2, 3, 4].map((i) =>
      setTimeout(() => {
        setVisibleFormElements((prev) => [...prev, true]);
      }, i * 80)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [isOpen]);

  useEffect(() => {
    hasTypedRef.current = Boolean(clubName || description);
  }, [clubName, description]);

  // Draft restore, keyed to the signed-in account (see createDraftKeyFor).
  useEffect(() => {
    if (!isOpen) return;
    setDraftRestored(false);
    try {
      // The unscoped legacy draft has no owner. Never adopt it: remove it.
      window.localStorage.removeItem(CREATE_DRAFT_KEY);
    } catch (error) {
      reportError(error, 'CreateClubModal.RemoveLegacyDraft');
    }
    const userId = user?.id;
    if (!userId) {
      setDraftHydratedFor(null);
      return;
    }
    const previousOwner = formOwnerRef.current;
    formOwnerRef.current = userId;
    if (previousOwner && previousOwner !== userId) {
      // This component stays mounted while closed, so another account's text
      // and request id can still be in memory. None of it crosses accounts.
      setClubName('');
      setDescription('');
      setIsPublic(true);
      setRequiresApproval(false);
      setLogoPreview(defaultLogoUrl(DEFAULT_LOGO.file));
      setSelectedPresetId(DEFAULT_LOGO.id);
      setHasAgreed(false);
      creationRequestIdRef.current = uuid();
    } else if (!previousOwner && hasTypedRef.current) {
      // The account resolved after typing began: what is on screen is this
      // user's work and becomes the draft. A stored draft must not overwrite it.
      setDraftHydratedFor(userId);
      return;
    }
    try {
      const saved = window.localStorage.getItem(createDraftKeyFor(userId));
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
    setDraftHydratedFor(userId);
  }, [isOpen, user?.id]);

  useEffect(() => {
    // Nothing is written until this account's own draft has been read, so one
    // account's text can never be filed under another account's key.
    const userId = user?.id;
    if (!isOpen || !userId || draftHydratedFor !== userId) return;
    const draftKey = createDraftKeyFor(userId);
    const draft = {
      name: clubName,
      description,
      isPublic,
      requiresApproval,
      logoPresetId: selectedPresetId,
      requestId: creationRequestIdRef.current,
    };
    try {
      if (clubName || description) window.localStorage.setItem(draftKey, JSON.stringify(draft));
      else window.localStorage.removeItem(draftKey);
    } catch (error) {
      reportError(error, 'CreateClubModal.SaveDraft');
    }
  }, [
    clubName,
    description,
    isPublic,
    requiresApproval,
    selectedPresetId,
    isOpen,
    user?.id,
    draftHydratedFor,
  ]);

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
      toast.error(safeErrorMessage(error, 'Could Not Process That Image'));
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
      toast.error('Please Enter A Club Name');
      return;
    }

    if (clubName.trim().length < 3) {
      toast.error('Club Name Must Be At Least 3 Characters');
      return;
    }

    if (!logoPreview) {
      toast.error('Please Select Or Upload A Club Logo');
      return;
    }

    if (!hasAgreed) {
      toast.error('Please Accept The Terms To Continue');
      return;
    }

    // Auth guard
    if (!user?.id) {
      toast.error('You Must Be Logged In To Create A Club.');
      return;
    }

    if (isCreating) return;
    if (nameStatus !== 'available') {
      toast.error(
        nameStatus === 'taken'
          ? 'That Club Name Is Already Taken'
          : 'Wait For The Name Availability Check'
      );
      return;
    }
    if (!allowance?.canCreate) {
      toast.error('Your Four-Club Allowance Is Full. Leave A Club Before Creating Another.');
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
      /* THE SERVER NAMES THE CLUB, NOT THE TEXT BOX. A retry after a lost
         response replays the same request id, and the server answers with the
         ORIGINAL club even when the name was edited in between. The toast (and
         the id handed to onSuccess below) come from that answer. */
      const createdName = typeof clubData.name === 'string' ? clubData.name.trim() : '';
      toast.success(
        createdName ? `Club "${createdName}" Created Successfully!` : 'Club Created Successfully!'
      );

      setClubName('');
      setDescription('');
      setLogoPreview(defaultLogoUrl(DEFAULT_LOGO.file));
      setSelectedPresetId(DEFAULT_LOGO.id);
      setHasAgreed(false);
      setDraftRestored(false);
      try {
        window.localStorage.removeItem(createDraftKeyFor(user.id));
      } catch (storageError) {
        reportError(storageError, 'CreateClubModal.ClearDraft');
      }
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
      if (isMounted.current) toast.error(err.message || 'Failed To Create Club');
    } finally {
      if (isMounted.current) setIsCreating(false);
    }
  };

  // A built-in placeholder is the pristine default, not unsaved work.
  const hasDraft = Boolean(clubName.trim() || description.trim() || selectedPresetId === null);
  // Text and launch settings are filed as a draft; an uploaded logo is not.
  const draftIsSaved = Boolean(user?.id && (clubName || description));
  const requestClose = useCallback(() => {
    if (isCreating) return;
    if (hasDraft) {
      // The in-app close guard. Remember where focus was so Keep Editing can
      // hand it back; an inert form drops it before any effect could read it.
      closeConfirmReturnRef.current = document.activeElement as HTMLElement | null;
      setCloseConfirmOpen(true);
      return;
    }
    ClubEntryTrustService.track('create', 'closed', { outcome: 'cancelled' });
    onClose();
  }, [hasDraft, isCreating, onClose]);
  const dismissCloseConfirm = useCallback(() => setCloseConfirmOpen(false), []);
  const confirmClose = useCallback(() => {
    if (isCreating) return;
    setCloseConfirmOpen(false);
    ClubEntryTrustService.track('create', 'closed', { outcome: 'cancelled' });
    onClose();
  }, [isCreating, onClose]);
  // Escape answers the guard the way it answered the native one: it cancels.
  useDialogEscape(isOpen, closeConfirmOpen ? dismissCloseConfirm : requestClose);

  useEffect(() => {
    if (!closeConfirmOpen) return;
    // The safe answer takes focus, so Enter never closes by accident.
    keepEditingRef.current?.focus();
    return () => {
      const back = closeConfirmReturnRef.current;
      closeConfirmReturnRef.current = null;
      if (back && document.contains(back) && !(back as HTMLButtonElement).disabled) back.focus();
    };
  }, [closeConfirmOpen]);

  if (!isOpen) return null;

  const createDisabled =
    isCreating ||
    isOptimizingLogo ||
    !hasAgreed ||
    !clubName.trim() ||
    !logoPreview ||
    nameStatus !== 'available' ||
    allowance?.canCreate !== true;

  return (
    <>
      {/* THE TRAP HOLDS THE WHOLE CONSOLE. It used to wrap only the scroll
          body, and the Close / Create Club plates live in the painted foot
          outside it, so Tab wrapped from the last field to the first and a
          keyboard user could never reach either plate. While the close guard
          is up the same trap moves to the guard and this page goes inert. */}
      <div
        ref={closeConfirmOpen ? undefined : trapRef}
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-club-title"
        aria-hidden={closeConfirmOpen ? true : undefined}
        inert={closeConfirmOpen}
        onClick={requestClose}
      >
        <SpadeConsole
          as="div"
          className={styles.consoleShell}
          onClick={(e: React.MouseEvent<HTMLElement>) => e.stopPropagation()}
          eyebrow="Club Arena / New Organization"
          title="Create A Club"
          titleId="create-club-title"
          subtitle="Name It, Choose A Crest, And Open"
          pill="Owner"
          pillInk="blue"
          crest="club"
          plates={{
            secondary: {
              label: 'Close',
              ink: 'silver',
              className: styles.closeButton,
              onClick: () => {
                haptic.light();
                requestClose();
              },
              'aria-label': 'Close',
              disabled: isCreating,
            },
            primary: {
              /* The in-flight word is no longer than the resting one. 'Creating
               Club...' needed less than the fit floor (half size) on a phone
               plate and still ran 4px past the painted face. */
              label: isCreating ? 'Creating...' : 'Create Club',
              ink: 'white',
              className: styles.createButton,
              onClick: () => {
                haptic.medium();
                handleCreate();
              },
              'aria-label': 'Create Club',
              disabled: createDisabled,
            },
          }}
        >
          <div className={styles.scrollBody}>
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
              placeholder="Name Your Club"
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

            {/* Hidden file input. Upload A Custom Logo is its keyboard route, so
                the invisible control itself is not a tab stop. */}
            <input
              ref={fileInputRef}
              type="file"
              tabIndex={-1}
              aria-hidden="true"
              accept="image/png,image/jpeg,image/webp"
              className={styles.hiddenInput}
              onChange={handleFileSelect}
            />

            <fieldset className={styles.accessSettings}>
              <legend>Launch Settings</legend>
              <Toggle label="Discoverable In Club Arena" value={isPublic} onChange={setIsPublic} />
              <Toggle
                label="Review Join Requests"
                value={requiresApproval}
                onChange={setRequiresApproval}
              />
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
        </SpadeConsole>
      </div>

      {closeConfirmOpen && (
        <div
          ref={trapRef}
          className={styles.leaveGuard}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="create-club-close-guard-heading"
          aria-describedby="create-club-close-guard-copy"
          onClick={dismissCloseConfirm}
        >
          <SpadeConsole
            as="div"
            className={styles.leaveGuardConsole}
            onClick={(e: React.MouseEvent<HTMLElement>) => e.stopPropagation()}
            eyebrow="Create A Club"
            title="Close Create Club?"
            titleId="create-club-close-guard-heading"
            crest="flat"
            plates={{
              secondary: {
                label: 'Close Now',
                ink: 'silver',
                onClick: () => {
                  haptic.light();
                  confirmClose();
                },
              },
              primary: {
                label: 'Keep Editing',
                ink: 'white',
                buttonRef: keepEditingRef,
                onClick: () => {
                  haptic.light();
                  dismissCloseConfirm();
                },
              },
            }}
          >
            <p id="create-club-close-guard-copy" className={styles.leaveGuardCopy}>
              {draftIsSaved
                ? 'Your Club Name, Description And Launch Settings Stay Saved As A Draft On This Device.'
                : selectedPresetId !== null && 'Your Changes Have Not Been Saved As A Draft.'}
              {selectedPresetId === null &&
                `${draftIsSaved ? ' ' : ''}Your Custom Logo Is Not Saved And Must Be Uploaded Again.`}
            </p>
          </SpadeConsole>
        </div>
      )}
    </>
  );
}
