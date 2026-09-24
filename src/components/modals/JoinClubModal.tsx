/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  JOIN A CLUB - on the spade console (#ClubArenaConsole)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This was a two-panel sheet: a bevelled art bay on the left with the vault
 * emblem and a blue scan line sweeping over it, and on the right a Rajdhani
 * title, a rounded code well with a 2px cyan focus ring, two bordered import
 * chips, a bordered preview card and a `linear-gradient(#087bb2, #04557f)`
 * button locked to the bottom. Every one of those was CSS pretending to be a
 * control, and the emblem was an icon stuck on top of a frame rather than one
 * built into it.
 *
 * It is now Dan's approved spade master, cut into head / rails / foot by
 * SpadeConsole: JOIN A CLUB engraved in the header well, the lookup state in
 * the well's painted pill slot, the code field a groove cut into the glass,
 * PASTE INVITATION and SCAN QR IMAGE as lit words, the verified club printed
 * as label/value rows separated by engraved rules, and the two doors on the
 * painted plates in the foot - CLOSE on steel, the join on the blue glass.
 * The crest at the top is the master's own; nothing is stuck on it.
 *
 * The full-page shape is unchanged and is a contract
 * (tests/club-entry-redesign-regression.test.ts): 100dvh, a body that scrolls
 * on its own, and a footer locked above the home indicator - which now carries
 * the live status line, so a lookup result can never scroll out of sight.
 *
 * Nothing about the flow changed. The preview sequence guard, the verified
 * identifier ref, the debounce, the paste and QR paths, the pending-request
 * resume on `online`, the re-entry guard on join, the focus trap, the Escape
 * owner and every reportError below are the ones that were here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ClubJoinService,
  type ClubJoinPreview,
  type ClubJoinResult,
} from '../../services/ClubJoinService';
import haptic from '../../services/HapticService';
import { useToast } from '../common/Toast';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useDialogEscape } from '../../hooks/useDialogEscape';
import { reportError } from '../../utils/errorReporter';
import { ClubEntryTrustService } from '../../services/ClubEntryTrustService';
import { titleCase } from '../../utils/titleCase';
import { SpadeConsole, type ConsoleInk } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
import styles from './JoinClubModal.module.css';

interface JoinClubModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (clubId: string) => void;
  initialCode?: string;
  initialRef?: string;
}

export default function JoinClubModal({
  isOpen,
  onClose,
  onSuccess,
  initialCode,
  initialRef,
}: JoinClubModalProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const isMounted = useIsMounted();
  const trapRef = useFocusTrap(isOpen);
  const [clubCode, setClubCode] = useState('');
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [preview, setPreview] = useState<ClubJoinPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qrInputRef = useRef<HTMLInputElement>(null);
  const previewSequenceRef = useRef(0);
  const verifiedIdentifierRef = useRef<string | null>(null);

  const loadPreview = useCallback(
    async (identifier: string) => {
      const normalized = identifier.trim();
      if (!ClubJoinService.isValidIdentifier(normalized)) return;
      const sequence = ++previewSequenceRef.current;
      verifiedIdentifierRef.current = null;
      setPreview(null);
      setIsPreviewing(true);
      setStatusMessage(null);
      try {
        const result = await ClubJoinService.preview(normalized);
        if (!isMounted.current || sequence !== previewSequenceRef.current) return;
        setPreview(result.found ? result : null);
        verifiedIdentifierRef.current = result.found ? normalized : null;
        if (!result.found) setStatusMessage('No club was found for that code.');
      } catch (error) {
        if (!isMounted.current || sequence !== previewSequenceRef.current) return;
        reportError(error, 'JoinClubModal.Preview');
        setPreview(null);
        setStatusMessage(error instanceof Error ? error.message : 'Could not look up that code.');
      } finally {
        if (isMounted.current && sequence === previewSequenceRef.current) setIsPreviewing(false);
      }
    },
    [isMounted]
  );

  useEffect(() => {
    if (!isOpen) return;
    ClubEntryTrustService.track('join', 'opened', { outcome: 'viewed' });
    const code =
      initialCode && ClubJoinService.isValidIdentifier(initialCode) ? initialCode.trim() : '';
    setClubCode(code);
    setReferralCode(initialRef?.trim() || null);
    setPreview(null);
    verifiedIdentifierRef.current = null;
    setStatusMessage(null);
    setIsJoining(false);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 100);
    if (code) loadPreview(code);

    const resume = () => {
      ClubJoinService.resumePending()
        .then((result) => result && handleJoinResult(result))
        .catch((error) => reportError(error, 'JoinClubModal.ResumePending'));
    };
    resume();
    window.addEventListener('online', resume);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('online', resume);
    };
    // handleJoinResult reads stable component callbacks and only runs after a
    // persisted request returns; re-registering for every render is harmful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialCode, initialRef, loadPreview]);

  useEffect(() => {
    if (!isOpen || !ClubJoinService.isValidIdentifier(clubCode)) {
      setPreview(null);
      verifiedIdentifierRef.current = null;
      return;
    }
    const timer = window.setTimeout(() => loadPreview(clubCode), 400);
    return () => window.clearTimeout(timer);
  }, [clubCode, isOpen, loadPreview]);

  const handleJoinResult = (result: ClubJoinResult) => {
    if (!result.success) {
      setStatusMessage(result.error || 'This club could not be joined.');
      return;
    }
    const club = result.club;
    if (!club) return;
    setPreview((current) => (current ? { ...current, membership_status: result.status } : current));
    if (result.status === 'pending') {
      toast.success(`Request sent to ${club.name}. You can track or cancel it here.`);
      setStatusMessage('Application pending owner approval.');
      return;
    }
    toast.success(`Welcome to ${club.name}!`);
    if (onSuccess) {
      onSuccess(club.id);
    } else {
      onClose();
      navigate(`/clubs/${club.slug || club.id}`);
    }
  };

  const handleJoin = async () => {
    if (isJoining) return;
    haptic.medium();
    if (!preview?.id || verifiedIdentifierRef.current !== clubCode.trim()) {
      toast.error('Look up and confirm the club before joining.');
      return;
    }
    if (preview.membership_status && preview.membership_status !== 'pending') {
      if (onSuccess) {
        onSuccess(preview.id);
      } else {
        onClose();
        navigate(`/clubs/${preview.slug || preview.id}`);
      }
      return;
    }
    setIsJoining(true);
    setStatusMessage(null);
    try {
      handleJoinResult(await ClubJoinService.join({ identifier: clubCode, referralCode }));
    } catch (error) {
      reportError(error, 'JoinClubModal.Join');
      if (isMounted.current) {
        const message = navigator.onLine
          ? error instanceof Error
            ? error.message
            : 'Could not join this club.'
          : 'You are offline. This join is saved and will retry when you reconnect.';
        setStatusMessage(message);
        toast.error(message);
      }
    } finally {
      if (isMounted.current) setIsJoining(false);
    }
  };

  const consumeInput = (value: string) => {
    const parsed = ClubJoinService.parseInput(value);
    if (!parsed || !ClubJoinService.isValidIdentifier(parsed.identifier)) {
      setStatusMessage('Paste A 5-6 Digit Code Or A Valid Club Arena Invite Link.');
      return false;
    }
    previewSequenceRef.current += 1;
    verifiedIdentifierRef.current = null;
    setPreview(null);
    setClubCode(parsed.identifier);
    setReferralCode(parsed.referralCode);
    setStatusMessage(parsed.referralCode ? 'Invitation detected. Confirm the club below.' : null);
    return true;
  };

  const pasteFromClipboard = async () => {
    try {
      consumeInput(await navigator.clipboard.readText());
    } catch (error) {
      reportError(error, 'JoinClubModal.Clipboard');
      setStatusMessage('Clipboard access was blocked. Paste directly into the code field.');
    }
  };

  const scanQrImage = async (file: File) => {
    setIsScanning(true);
    try {
      const Detector = (
        window as unknown as {
          BarcodeDetector?: new (options: { formats: string[] }) => {
            detect(source: ImageBitmap): Promise<Array<{ rawValue: string }>>;
          };
        }
      ).BarcodeDetector;
      if (!Detector) throw new Error('QR scanning is not supported by this browser.');
      const bitmap = await createImageBitmap(file);
      const codes = await new Detector({ formats: ['qr_code'] }).detect(bitmap);
      bitmap.close();
      if (!codes[0]?.rawValue || !consumeInput(codes[0].rawValue)) {
        throw new Error('No Club Arena invite was found in that QR image.');
      }
      ClubEntryTrustService.track('join', 'qr_imported', { outcome: 'succeeded' });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not read that QR image.');
    } finally {
      setIsScanning(false);
      if (qrInputRef.current) qrInputRef.current.value = '';
    }
  };

  const cancelPending = async () => {
    if (!preview?.id) return;
    try {
      if (await ClubJoinService.cancelRequest(preview.id)) {
        setPreview({ ...preview, membership_status: null });
        setStatusMessage('Join request cancelled.');
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not cancel the request.');
    }
  };

  useDialogEscape(isOpen, onClose);

  if (!isOpen) return null;

  /* The word in the header's painted pill slot: where the lookup has got to. */
  const pill = isPreviewing
    ? 'Checking'
    : preview?.membership_status === 'pending'
      ? 'Pending'
      : preview
        ? 'Verified'
        : 'Code';
  const pillInk: ConsoleInk =
    preview?.membership_status === 'pending' ? 'gold' : preview ? 'green' : 'muted';

  /* Two literal branches rather than one clever ternary: the plate label is
     what a test reads, and `Confirm Join <club>` is pinned by name. */
  const primaryPlate =
    preview?.membership_status === 'pending'
      ? {
          label: 'Cancel Pending Request',
          ink: 'red' as const,
          onClick: cancelPending,
        }
      : {
          label: isJoining
            ? 'Securing Access'
            : preview?.membership_status
              ? 'Enter Club'
              : preview
                ? `Confirm Join ${preview.name}`
                : 'Verify A Club Code',
          ink: 'white' as const,
          onClick: handleJoin,
          disabled: isJoining || !preview?.id,
        };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={trapRef}
        className={styles.modalContainer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-club-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.scrollBody}>
          <SpadeConsole
            onClose={onClose}
            as="div"
            className={styles.console}
            eyebrow="Club Access"
            title="Join A Club"
            titleId="join-club-title"
            pill={pill}
            pillInk={pillInk}
            plates={{
              secondary: { label: 'Close', onClick: onClose },
              primary: primaryPlate,
            }}
          >
            <p className={`sc-copy sc-copy--center ${styles.copy}`}>
              Enter A Code, Paste An Invitation, Or Upload A QR Screenshot. You Will Confirm The
              Club Before Anything Changes.
            </p>

            {/* A groove cut into the glass, not a bordered well. */}
            <div className={styles.field}>
              <label htmlFor="join-club-code" className={`sc-label sc-ink--blue ${styles.label}`}>
                Club Code
              </label>
              <input
                id="join-club-code"
                ref={inputRef}
                type="tel"
                inputMode="numeric"
                pattern="[0-9]{5,6}"
                maxLength={6}
                placeholder="48291"
                className={styles.codeInput}
                value={clubCode}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData('text');
                  if (ClubJoinService.parseInput(pasted)) {
                    event.preventDefault();
                    consumeInput(pasted);
                  }
                }}
                onChange={(event) => {
                  previewSequenceRef.current += 1;
                  verifiedIdentifierRef.current = null;
                  setPreview(null);
                  setClubCode(event.target.value.replace(/\D/g, ''));
                  setReferralCode(null);
                  setStatusMessage(null);
                }}
                onKeyDown={(event) =>
                  event.key === 'Enter' && (preview ? handleJoin() : loadPreview(clubCode))
                }
              />
            </div>

            {/* The two imports are lit words on the glass. The foot paints
                BOTH plates and they are already spoken for, so a third and
                fourth plate cannot exist here. */}
            <div className={styles.wordRail}>
              <button
                type="button"
                className={`${styles.word} sc-ink--blue`}
                onClick={pasteFromClipboard}
              >
                Paste Invitation
              </button>
              <button
                type="button"
                className={`${styles.word} ${isScanning ? 'sc-ink--muted' : 'sc-ink--blue'}`}
                onClick={() => qrInputRef.current?.click()}
                disabled={isScanning}
              >
                {isScanning ? 'Scanning' : 'Scan QR Image'}
              </button>
              <input
                ref={qrInputRef}
                type="file"
                accept="image/*"
                className={styles.hiddenInput}
                onChange={(event) => event.target.files?.[0] && scanQrImage(event.target.files[0])}
              />
            </div>

            {preview && (
              <section className={styles.preview} aria-label="Club Confirmation">
                <h3 className={`${styles.previewName} sc-ink--silver`}>{preview.name}</h3>
                <dl className={styles.facts}>
                  <div className={styles.fact}>
                    <dt className={`sc-label sc-ink--blue ${styles.factLabel}`}>Membership</dt>
                    <dd className={`${styles.factValue} sc-ink--silver`}>
                      {preview.requires_approval ? 'Approval Required' : 'Open Membership'}
                    </dd>
                  </div>
                  <div className={styles.fact}>
                    <dt className={`sc-label sc-ink--blue ${styles.factLabel}`}>Members</dt>
                    <dd className={`${styles.factValue} sc-ink--silver`}>
                      {compactChips(preview.member_count)}
                    </dd>
                  </div>
                </dl>
                {preview.description && (
                  <p className={`sc-copy ${styles.copy}`}>{preview.description}</p>
                )}
              </section>
            )}
          </SpadeConsole>
        </div>

        {/* Locked above the home indicator: the lookup result can never scroll
            out of sight, and it is the same strip whether it is a status or
            the standing hint. */}
        <footer className={styles.pageFooter}>
          <p className={`sc-label ${styles.status}`} aria-live="polite">
            {isPreviewing ? (
              <span className="sc-ink--blue">Verifying Club</span>
            ) : statusMessage ? (
              <span className="sc-ink--gold">{titleCase(statusMessage)}</span>
            ) : (
              <span className="sc-ink--muted">A Club Code Is Five Or Six Digits</span>
            )}
          </p>
        </footer>
      </div>
    </div>
  );
}
