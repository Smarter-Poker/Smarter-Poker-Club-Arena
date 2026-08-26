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

  return (
    <div className="referral-overlay" onClick={onClose}>
      <div className="referral-modal" onClick={(e) => e.stopPropagation()}>
        <div className="referral-header">
          <h2>Invite & Earn</h2>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="referral-body">
          <div className="referral-illustration"></div>
          <p className="referral-text">
            Invite Your Friends To The Club And Earn <strong>5% Of Their Rake Forever!</strong>
          </p>

          <div className="referral-stat-box">
            <span className="stat-label">Your Total Referrals</span>
            <span className="stat-val">{totalReferrals}</span>
          </div>

          <div className="referral-link-box">
            <span className="link-label">Your Referral Link</span>
            <div className="link-input-group">
              <input readOnly value={referralLink} placeholder="Preparing Your Link..." />
              <button
                onClick={handleCopy}
                disabled={!referralLink}
                className={copied ? 'copied' : ''}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="referral-code-box">
            <span>Or Share Code:</span>
            <strong className="code-display">{referralCode}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ReferralModal;
