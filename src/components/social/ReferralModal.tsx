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

export interface ReferralModalProps {
  isOpen: boolean;
  onClose: () => void;
  referralCode: string;
  referralLink: string;
  totalReferrals: number;
}

export function ReferralModal({
  isOpen,
  onClose,
  referralCode,
  referralLink,
  totalReferrals,
}: ReferralModalProps) {
  const [copied, setCopied] = useState(false);
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

  const handleCopy = () => {
    // A link the caller could not build yet (no club in scope, profile still
    // loading) must not be copied as an empty string and reported as "Copied!".
    // Sharing nothing is worse than the button doing nothing.
    if (!referralLink) return;
    navigator.clipboard.writeText(referralLink);
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
            <span className="rfc__figure sc-ink--silver">{compactChips(totalReferrals)}</span>
          </div>

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
