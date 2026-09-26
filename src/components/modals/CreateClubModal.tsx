/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CreateClubModal — Full-Page Club Creation Console
 * ═══════════════════════════════════════════════════════════════════════════════
 * - Club name input
 * - Ten curated placeholder crests or a custom upload
 * - Terms acceptance
 * - CREATE button
 *
 * ── ON THE SPADE CONSOLE (#ClubArenaConsole) ────────────────────────────────
 * This was a two-panel sheet: a bevelled art bay on the left carrying the
 * vault emblem and the words OWNER CONSOLE, and on the right a Rajdhani title,
 * rounded input wells, a bordered "crest vault" fieldset holding a GRID of ten
 * rounded tiles with a cyan selected ring, two native tick boxes, a hand-drawn
 * checkbox square and a blue gradient CREATE button locked to the bottom.
 *
 * It is now Dan's approved spade master, cut into head / rails / foot by
 * SpadeConsole. Dan 2026-09-09, on exactly this shape: "I'M NOT A BIG FAN OF
 * THESE CARDS. I DON'T LIKE THE 4 BOXES, AND THE WAY IT STICKS OUT ON THE
 * SIDES" - so the crests are ROWS on the black glass, each one the crest
 * itself with its name in engraved silver beside it and no tile drawn around
 * it; the two launch settings and the terms are rows that read On or Off; the
 * fields are grooves cut into the glass; and the two doors are the plates
 * painted into the foot - CLOSE on steel, CREATE CLUB on the blue glass.
 *
 * The full-page shape is unchanged and is a contract
 * (tests/club-entry-redesign-regression.test.ts): 100dvh, a body that scrolls
 * on its own, and a footer locked above the home indicator - which now carries
 * the allowance and the name check, so neither can scroll out of sight.
 *
 * Nothing about the flow changed. The draft restore and its request id, the
 * name-availability debounce, the eligibility sequence guard, the logo
 * optimiser, the close confirmation, the focus trap, the Escape owner and
 * every track() call below are the ones that were here.
 *
 * ── HARDENED 2026-09-22 (Create A Club, Phase 2) ────────────────────────────
 * - The scroll region is the console's OWN body, between the head and the
 *   painted foot, so CLOSE and CREATE CLUB never scroll off the screen, and the
 *   console narrows by height (the stylesheet shows the arithmetic) so a laptop
 *   or a landscape phone still has a usable body.
 * - The draft is filed per account. The old unscoped draft has no owner, so it
 *   is removed, never adopted by whoever signs in next.
 * - Closing with unsaved work asks through the kit's ConfirmModal on the spade
 *   console, never the browser's native dialog.
 * - The success toast names the club the SERVER returned: a retry after a lost
 *   response replays the same request id and gets the ORIGINAL club back.
 * - The two launch settings are switches that say On or Off, and the agreement
 *   wears the kit's tick well (Dan 2026-09-15: a person agreeing to something
 *   has to SEE the box they are ticking).
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { mediaUrl } from '../../utils/mediaBase';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ClubsService, type ClubCreationEligibility } from '../../services/ClubsService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import haptic from '../../services/HapticService';
import { SpadeConsole } from '../console/SpadeConsole';
// The tick well and the inks printed below are kit classes, so this file loads
// the kit sheet it depends on (tests/unit/classNamesResolve.test.ts).
import '../console/SpadeConsole.css';
import { ConfirmModal } from '../common/ConfirmModal';
import styles from './CreateClubModal.module.css';
import { reportError } from '../../utils/errorReporter';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { optimizeClubLogo } from '../../utils/clubLogoImage';
import { useDialogEscape } from '../../hooks/useDialogEscape';
import { ClubEntryTrustService } from '../../services/ClubEntryTrustService';
import { uuid } from '../../utils/uuid';

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

/** The name check, said as a word in the master's own ink. */
const NAME_STATUS_TEXT = {
  idle: '',
  checking: 'Checking Availability',
  available: 'Name Available',
  taken: 'Name Already In Use',
  error: 'Availability Check Unavailable',
} as const;

const NAME_STATUS_INK = {
  idle: 'sc-ink--muted',
  checking: 'sc-ink--blue',
  available: 'sc-ink--green',
  taken: 'sc-ink--red',
  error: 'sc-ink--gold',
} as const;

/** The server preflight owns both the membership cap and the rollout gate. */
function allowanceLine(allowance: ClubCreationEligibility): {
  text: string;
  ink: string;
  refusal: string | null;
} {
  if (allowance.reason === 'creation_unavailable' || allowance.creationOpen === false) {
    return {
      text: 'Club Creation Is Temporarily Unavailable',
      ink: 'sc-ink--gold',
      refusal: 'Club Creation Is Temporarily Unavailable. Please Try Again Soon.',
    };
  }
  const atCap =
    allowance.reason === 'membership_cap' ||
    (!allowance.canCreate &&
      allowance.maxClubs !== null &&
      allowance.membershipCount >= allowance.maxClubs);
  if (atCap && allowance.maxClubs !== null) {
    const text = `Membership Limit Reached: You Belong To ${allowance.membershipCount.toLocaleString()} Of ${allowance.maxClubs.toLocaleString()} Clubs`;
    return {
      text,
      ink: 'sc-ink--red',
      refusal: `${text}. Leave A Club Before Creating Another.`,
    };
  }
  if (!allowance.canCreate) {
    const text = 'Club Creation Is Not Available Right Now';
    return { text, ink: 'sc-ink--gold', refusal: `${text}.` };
  }
  if (allowance.remaining === null) {
    return { text: 'Unlimited Club Slots Remaining', ink: 'sc-ink--blue', refusal: null };
  }
  return {
    text: `${allowance.remaining.toLocaleString()} ${allowance.remaining === 1 ? 'Club Slot' : 'Club Slots'} Remaining`,
    ink: 'sc-ink--blue',
    refusal: null,
  };
}

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
  const [allowance, setAllowance] = useState<ClubCreationEligibility | null>(null);
  const [allowanceError, setAllowanceError] = useState(false);
  const [allowanceRetry, setAllowanceRetry] = useState(0);
  const [isOptimizingLogo, setIsOptimizingLogo] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  /** The account whose draft the form holds. Nothing is saved until it is known. */
  const [draftHydratedFor, setDraftHydratedFor] = useState<string | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const trapRef = useFocusTrap(isOpen);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const creationRequestIdRef = useRef<string>(uuid());
  const eligibilitySequenceRef = useRef(0);
  const formOwnerRef = useRef<string | null>(null);
  const hasTypedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    setAllowance(null);
    setAllowanceError(false);
    ClubEntryTrustService.track('create', 'opened', { outcome: 'viewed' });
    setVisibleFormElements([]);
    const timers = [0, 1, 2, 3, 4].map((i) =>
      setTimeout(() => {
        setVisibleFormElements((prev) => [...prev, true]);
      }, i * 80)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [isOpen]);

  // A guard left open when the page closed must not flash up on the next open.
  useEffect(() => {
    if (!isOpen) setCloseConfirmOpen(false);
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
      toast.error(
        (allowance && allowanceLine(allowance).refusal) ||
          'Your Club Allowance Is Not Verified Yet. Please Try Again.'
      );
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
         ORIGINAL club even when the name was edited in between. The toast, like
         the id handed to onSuccess below, comes from that answer. */
      const createdName = typeof clubData.name === 'string' ? clubData.name.trim() : '';
      toast.success(
        createdName ? `Club "${createdName}" created successfully!` : 'Club created successfully!'
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
      if (isMounted.current) toast.error(err.message || 'Failed to create club');
    } finally {
      if (isMounted.current) setIsCreating(false);
    }
  };

  // A built-in placeholder is the pristine default, not unsaved work.
  const hasDraft = Boolean(clubName.trim() || description.trim() || selectedPresetId === null);
  // What the guard can promise: text and settings are filed per account once
  // that account is known; an uploaded logo is never part of the draft.
  const draftIsSaved = Boolean(
    user?.id && draftHydratedFor === user.id && (clubName || description)
  );
  const requestClose = useCallback(() => {
    if (isCreating) return;
    if (hasDraft) {
      // Unsaved work asks first, on the kit's console, never a native dialog.
      setCloseConfirmOpen(true);
      return;
    }
    ClubEntryTrustService.track('create', 'closed', { outcome: 'cancelled' });
    onClose();
  }, [hasDraft, isCreating, onClose]);
  const dismissCloseConfirm = useCallback(() => setCloseConfirmOpen(false), []);
  const confirmClose = useCallback(() => {
    setCloseConfirmOpen(false);
    if (isCreating) return;
    ClubEntryTrustService.track('create', 'closed', { outcome: 'cancelled' });
    onClose();
  }, [isCreating, onClose]);
  // While the guard is up it owns Escape, and Escape cancels it, exactly as it
  // cancelled the native dialog it replaces.
  useDialogEscape(isOpen, requestClose, closeConfirmOpen);

  if (!isOpen) return null;

  /** The stagger that walks each block on. Unchanged; the animation law keeps it. */
  const revealStyle = (index: number) => ({
    opacity: visibleFormElements[index] ? 1 : 0,
    transition: 'opacity 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  });

  const canCreate =
    !isCreating &&
    !isOptimizingLogo &&
    hasAgreed &&
    !!clubName.trim() &&
    !!logoPreview &&
    nameStatus === 'available' &&
    allowance?.canCreate === true;
  const allowanceStatus = allowance ? allowanceLine(allowance) : null;

  const closeGuardMessage = !draftIsSaved
    ? 'Nothing On This Page Has Been Saved As A Draft Yet.'
    : selectedPresetId
      ? 'Your Club Name, Description, Crest And Launch Settings Stay Saved As A Draft On This Device.'
      : 'Your Club Name, Description And Launch Settings Stay Saved As A Draft On This Device. A Custom Logo Is Not Part Of The Draft.';

  return (
    <>
      <div className={styles.overlay} onClick={requestClose}>
        {/* While the close guard is up, the focus trap holds the guard instead
            (the ref moves), so Tab can neither leave it nor fall back here. */}
        <div
          ref={closeConfirmOpen ? undefined : trapRef}
          className={styles.modalContainer}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-club-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.stage}>
            <SpadeConsole
              as="div"
              className={styles.console}
              onClose={isCreating ? undefined : requestClose}
              eyebrow="Club Arena"
              title="Create A Club"
              titleId="create-club-title"
              pill={draftRestored ? 'Draft Restored' : 'New Club'}
              pillInk={draftRestored ? 'gold' : 'blue'}
              plates={{
                secondary: {
                  label: 'Close',
                  // The in-flight guard, made visible: nothing closes mid-create.
                  disabled: isCreating,
                  onClick: () => {
                    haptic.light();
                    requestClose();
                  },
                },
                primary: {
                  label: isCreating ? 'Creating Club' : 'Create Club',
                  ink: 'white',
                  'aria-label': 'Create Club',
                  disabled: !canCreate,
                  onClick: () => {
                    haptic.medium();
                    handleCreate();
                  },
                },
              }}
            >
              {/* The console's own body is the scroll region: the head above it
                and the painted plates below it never move. */}
              <div className={styles.scrollBody}>
                <p className={`sc-copy sc-copy--center ${styles.copy}`}>
                  Name Your Room, Establish Its Identity, And Open The Doors.
                </p>

                {/* ── The name, in a groove cut into the glass ─────────────── */}
                <div className={styles.field} style={revealStyle(0)}>
                  <label className="sc-label sc-ink--blue" htmlFor="new-club-name">
                    Club Name
                  </label>
                  <input
                    id="new-club-name"
                    type="text"
                    className={styles.input}
                    placeholder="Name Your Club"
                    value={clubName}
                    onChange={(e) => setClubName(e.target.value)}
                    maxLength={30}
                    autoComplete="off"
                  />
                </div>

                <div className={styles.field} style={revealStyle(1)}>
                  <label className="sc-label sc-ink--blue" htmlFor="new-club-description">
                    Description (Optional)
                  </label>
                  <textarea
                    id="new-club-description"
                    className={styles.textarea}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={180}
                    placeholder="What Kind Of Room Are You Building?"
                  />
                </div>

                {/* ── The crest vault: rows on the glass, never a grid of tiles ── */}
                <div className={styles.section} style={revealStyle(2)}>
                  <span className={`sc-label sc-ink--blue ${styles.sectionLabel}`}>
                    Club Crest Vault
                  </span>
                  <p className={`sc-copy ${styles.copy}`}>
                    Select One Of Ten Club Arena Crests Now. The Club Owner Can Replace It With A
                    Custom Logo At Any Time.
                  </p>

                  <div
                    className={styles.crestList}
                    role="radiogroup"
                    aria-label="Default Club Logos"
                  >
                    {DEFAULT_CLUB_LOGOS.map((logo) => {
                      const selected = selectedPresetId === logo.id;
                      return (
                        <button
                          key={logo.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={logo.name}
                          className={styles.crestRow}
                          onClick={() => handlePresetSelect(logo)}
                        >
                          <img
                            src={defaultLogoUrl(logo.file)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className={styles.crestArt}
                          />
                          <span
                            className={`${styles.crestName} ${
                              selected ? 'sc-ink--silver' : 'sc-ink--muted'
                            }`}
                          >
                            {logo.name}
                          </span>
                          <span
                            className={`sc-label ${styles.crestState} ${
                              selected ? 'sc-ink--green' : 'sc-ink--muted'
                            }`}
                          >
                            {selected ? 'Selected' : 'Choose'}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    className={`${styles.word} ${isOptimizingLogo ? 'sc-ink--muted' : 'sc-ink--blue'}`}
                    disabled={isOptimizingLogo}
                    onClick={() => {
                      haptic.medium();
                      fileInputRef.current?.click();
                    }}
                  >
                    {isOptimizingLogo ? 'Optimizing Logo' : 'Upload A Custom Logo'}
                  </button>
                  <span className={`sc-label sc-ink--muted ${styles.hint}`}>
                    {selectedPresetId
                      ? 'PNG, JPG Or WEBP, 5MB Maximum'
                      : 'Custom Logo Selected, PNG, JPG Or WEBP, 5MB Maximum'}
                  </span>

                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className={styles.hiddenInput}
                    onChange={handleFileSelect}
                  />
                </div>

                {/* ── Launch Settings: switches that read On or Off. The word is
                   what the eye reads; aria-checked is what a screen reader
                   announces, so the word is hidden from it. ─────────────── */}
                <div className={styles.section} style={revealStyle(3)}>
                  <span className={`sc-label sc-ink--blue ${styles.sectionLabel}`}>
                    Launch Settings
                  </span>
                  <div className={styles.toggleList}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isPublic}
                      className={styles.toggleRow}
                      onClick={() => {
                        haptic.selection();
                        setIsPublic((on) => !on);
                      }}
                    >
                      <span className={`${styles.toggleName} sc-ink--silver`}>
                        Discoverable In Club Arena
                      </span>
                      <span
                        aria-hidden="true"
                        className={`sc-label ${styles.toggleState} ${
                          isPublic ? 'sc-ink--green' : 'sc-ink--muted'
                        }`}
                      >
                        {isPublic ? 'On' : 'Off'}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={requiresApproval}
                      className={styles.toggleRow}
                      onClick={() => {
                        haptic.selection();
                        setRequiresApproval((on) => !on);
                      }}
                    >
                      <span className={`${styles.toggleName} sc-ink--silver`}>
                        Review Join Requests
                      </span>
                      <span
                        aria-hidden="true"
                        className={`sc-label ${styles.toggleState} ${
                          requiresApproval ? 'sc-ink--green' : 'sc-ink--muted'
                        }`}
                      >
                        {requiresApproval ? 'On' : 'Off'}
                      </span>
                    </button>
                  </div>
                </div>

                {/* ── The terms: a checkbox to assistive technology AND to the eye.
                   The master paints no tick box, so the kit cuts one into the
                   glass (sc-check, SpadeConsole.css). Dan 2026-09-15: "there
                   needs to be an area for the box check to the I Agree part." */}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={hasAgreed}
                  className={`${styles.terms} sc-check ${
                    hasAgreed ? 'sc-check--on sc-ink--green' : 'sc-ink--muted'
                  }`}
                  style={revealStyle(4)}
                  onClick={() => {
                    haptic.selection();
                    setHasAgreed((agreed) => !agreed);
                  }}
                >
                  <span className="sc-check__box" aria-hidden="true" />
                  <span>I Confirm I Can Manage This Club And Accept The Club Arena Terms.</span>
                </button>
              </div>
            </SpadeConsole>
          </div>

          {/* Locked above the home indicator: the allowance and the name check
            can never scroll out of sight while the name is being typed. */}
          <footer className={styles.pageFooter}>
            <p className={`sc-label ${styles.status}`} aria-live="polite">
              {allowanceStatus ? (
                <span className={allowanceStatus.ink}>{allowanceStatus.text}</span>
              ) : allowanceError ? (
                <button
                  type="button"
                  className={`${styles.word} sc-ink--gold`}
                  onClick={() => setAllowanceRetry((attempt) => attempt + 1)}
                >
                  Allowance Check Failed, Retry
                </button>
              ) : (
                <span className="sc-ink--muted">Verifying Club Allowance</span>
              )}
              {nameStatus !== 'idle' && (
                <span className={NAME_STATUS_INK[nameStatus]}>{NAME_STATUS_TEXT[nameStatus]}</span>
              )}
            </p>
          </footer>
        </div>
      </div>

      {/* The close guard: the kit's own two-plate confirm on the spade
          console. A sibling of the page, never inside its backdrop, so a tap on
          the guard's backdrop cancels the guard instead of asking again. */}
      {closeConfirmOpen && (
        <div ref={trapRef}>
          <ConfirmModal
            isOpen
            title="Close Create Club?"
            message={closeGuardMessage}
            confirmText="Close Now"
            cancelText="Keep Editing"
            onConfirm={confirmClose}
            onCancel={dismissCloseConfirm}
          />
        </div>
      )}
    </>
  );
}
