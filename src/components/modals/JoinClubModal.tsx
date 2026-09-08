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
import styles from './JoinClubModal.module.css';
import { mediaUrl } from '../../utils/mediaBase';

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
        <div className={styles.artPanel} aria-hidden="true">
          {preview?.logo_url ? (
            <img src={preview.logo_url} alt="" />
          ) : (
            <img
              src={mediaUrl('images/club-arena/vault-iris-emblem-v1-320.webp')}
              alt=""
              width="320"
              height="296"
            />
          )}
          <span className={styles.artScan} />
        </div>
        <div className={styles.contentPanel}>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close" />
          <div className={styles.scrollBody}>
            <span className={styles.eyebrow}>Club Access / Verified Entry</span>
            <h2 id="join-club-title" className={styles.title}>
              Join A Club
            </h2>
            <p className={styles.subtitle}>
              Enter A Code, Paste An Invitation, Or Upload A QR Screenshot. You Will Confirm The
              Club Before Anything Changes.
            </p>

            <div className={styles.inputWrapper}>
              <label htmlFor="join-club-code" className={styles.inputLabel}>
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

            <div className={styles.importActions}>
              <button onClick={pasteFromClipboard}>Paste Invitation</button>
              <button onClick={() => qrInputRef.current?.click()} disabled={isScanning}>
                {isScanning ? 'Scanning…' : 'Scan QR Image'}
              </button>
              <input
                ref={qrInputRef}
                type="file"
                accept="image/*"
                className={styles.hiddenInput}
                onChange={(event) => event.target.files?.[0] && scanQrImage(event.target.files[0])}
              />
            </div>

            {isPreviewing && (
              <div className={styles.lookupStatus} aria-live="polite">
                Verifying Club…
              </div>
            )}
            {preview && (
              <section className={styles.clubPreview} aria-label="Club Confirmation">
                <div>
                  <span>{preview.requires_approval ? 'Approval Required' : 'Open Membership'}</span>
                  <strong>{preview.name}</strong>
                  <small>{preview.member_count?.toLocaleString()} Members</small>
                </div>
                {preview.description && <p>{preview.description}</p>}
              </section>
            )}
            {statusMessage && (
              <div className={styles.statusMessage} aria-live="polite">
                {titleCase(statusMessage)}
              </div>
            )}
          </div>

          <footer className={styles.pageFooter}>
            {preview?.membership_status === 'pending' ? (
              <button className={styles.cancelRequestButton} onClick={cancelPending}>
                Cancel Pending Request
              </button>
            ) : (
              <button
                className={styles.joinButton}
                onClick={handleJoin}
                disabled={isJoining || !preview?.id}
              >
                {isJoining
                  ? 'Securing Access…'
                  : preview?.membership_status
                    ? 'Enter Club'
                    : preview
                      ? `Confirm Join ${preview.name}`
                      : 'Verify A Club Code'}
              </button>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}
