/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REFERRAL MODAL — Social Growth
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Popup to invite friends.
 * - Copy referral code
 * - Share via social media
 * - Track referrals
 */

import React, { useState, useRef, useEffect } from 'react';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
import './ReferralModal.css';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { reportError } from '../../utils/errorReporter';

export interface ReferralModalProps {
  isOpen: boolean;
  onClose: () => void;
  referralCode: string;
  referralLink: string;
  totalReferrals: number | null;
}

export function ReferralModal({
  isOpen,
  onClose,
  referralCode,
  referralLink,
  totalReferrals,
}: ReferralModalProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyRequest = useRef(0);
  useEffect(() => {
    copyRequest.current += 1;
    setCopied(false);
    setCopyError(false);
    return () => {
      copyRequest.current += 1;
    };
  }, [isOpen, referralLink]);
  const dialogRef = useFocusTrap(isOpen);
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose]);
  // CA-15 BUG FIX: copiedTimerRef tracks the 2s 'Copied!' feedback timer.
  // Previously fire-and-forget in handleCopy. If the modal closes before 2s
  // (user navigates away), setCopied fires on an unmounted component.
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  if (!isOpen) return null;

  const handleCopy = async () => {
    // A link the caller could not build yet (no club in scope, profile still
    // loading) must not be copied as an empty string and reported as "Copied!".
    // Sharing nothing is worse than the button doing nothing.
    if (!referralLink) return;
    const request = ++copyRequest.current;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(referralLink);
    } catch (error) {
      reportError(error, 'ReferralModal.copy');
      if (request === copyRequest.current) setCopyError(true);
      return;
    }
    if (request !== copyRequest.current) return;
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = null;
      setCopied(false);
    }, 2000);
  };

  /* ONE CONSOLE (#ClubArenaConsole): the spade master. The offer, the
     count, the link and the code are printed on the black glass between the
     rails with an engraved rule between rows; COPY and CLOSE are lit words.
     A page of content with one way out, so the foot is the flat cap. */
  return (
    <div className="referral-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="rfc"
        role="dialog"
        aria-modal="true"
        aria-labelledby="referral-title"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          onClose={onClose}
          eyebrow="Club Referrals"
          title="Invite & Earn"
          titleId="referral-title"
          pill="5% Rake"
          pillInk="gold"
          foot="foot"
          className="rfc__console"
        >
          <p className="sc-copy sc-copy--center">
            Invite Your Friends To The Club And Earn{' '}
            <strong className="sc-ink--gold">5% Of Their Rake Forever!</strong>
          </p>

          <div className="rfc__row">
            <span className="sc-label sc-ink--blue">Your Total Referrals</span>
            <span className="rfc__figure sc-ink--silver">
              {totalReferrals === null ? 'Unavailable' : compactChips(totalReferrals)}
            </span>
          </div>

          {copyError && (
            <p className="sc-copy sc-ink--red" role="alert">
              The Link Could Not Be Copied. Select It And Copy Manually.
            </p>
          )}

          <div className="rfc__link">
            <span className="sc-label sc-ink--blue">Your Referral Link</span>
            <div className="rfc__link-row">
              <input
                readOnly
                value={referralLink}
                placeholder="Preparing Your Link..."
                aria-label="Your Referral Link"
                className="rfc__input"
              />
              <button
                type="button"
                onClick={handleCopy}
                disabled={!referralLink}
                className={`rfc-word ${copied ? 'sc-ink--green' : 'sc-ink--white'}`}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="rfc__row">
            <span className="sc-label sc-ink--blue">Or Share Code</span>
            <strong className="rfc__code sc-ink--silver">{referralCode}</strong>
          </div>

          <div className="rfc__actions">
            <button
              type="button"
              className="rfc-word sc-ink--white"
              onClick={onClose}
              aria-label="Close"
            >
              Close
            </button>
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default ReferralModal;
