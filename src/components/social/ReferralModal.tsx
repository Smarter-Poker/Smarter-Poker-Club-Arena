/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🤝 REFERRAL MODAL — Social Growth
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Popup to invite friends.
 * - Copy referral code
 * - Share via social media
 * - Track referrals
 */

import React, { useState } from 'react';
import './ReferralModal.css';

export interface ReferralModalProps {
    isOpen: boolean;
    onClose: () => void;
    referralCode: string;
    referralLink: string;
    totalReferrals: number;
}

export function ReferralModal({ isOpen, onClose, referralCode, referralLink, totalReferrals }: ReferralModalProps) {
    const [copied, setCopied] = useState(false);

    if (!isOpen) return null;

    const handleCopy = () => {
        navigator.clipboard.writeText(referralLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="referral-overlay" onClick={onClose}>
            <div className="referral-modal" onClick={(e) => e.stopPropagation()}>
                <div className="referral-header">
                    <h2>Invite & Earn</h2>
                    <button onClick={onClose}>×</button>
                </div>

                <div className="referral-body">
                    <div className="referral-illustration">🤝</div>
                    <p className="referral-text">
                        Invite your friends to the club and earn <strong>5% of their rake forever!</strong>
                    </p>

                    <div className="referral-stat-box">
                        <span className="stat-label">Your Total Referrals</span>
                        <span className="stat-val">{totalReferrals}</span>
                    </div>

                    <div className="referral-link-box">
                        <span className="link-label">Your Referral Link</span>
                        <div className="link-input-group">
                            <input readOnly value={referralLink} />
                            <button onClick={handleCopy} className={copied ? 'copied' : ''}>
                                {copied ? 'Copied!' : 'Copy'}
                            </button>
                        </div>
                    </div>

                    <div className="referral-code-box">
                        <span>Or share code:</span>
                        <strong className="code-display">{referralCode}</strong>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ReferralModal;
