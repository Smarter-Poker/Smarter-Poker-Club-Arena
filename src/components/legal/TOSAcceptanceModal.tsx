/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⚖️ TOS ACCEPTANCE MODAL — Terms of Service Agreement
 * ═══════════════════════════════════════════════════════════════════════════════
 * Full-screen blocking modal for first-time users
 */

import { useState, useEffect } from 'react';
import './TOSAcceptanceModal.css';
import { reportError } from '../../utils/errorReporter';

interface TOSAcceptanceModalProps {
  onAccept: () => Promise<void>;
}

export default function TOSAcceptanceModal({ onAccept }: TOSAcceptanceModalProps) {
  const [isAccepting, setIsAccepting] = useState(false);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isAtBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 50;
    if (isAtBottom) setHasScrolledToBottom(true);
  };

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      await onAccept();
    } catch (err) {
      reportError(err, 'TOSAcceptanceModal.onAccept_error');
    } finally {
      setIsAccepting(false);
    }
  };

  return (
    <div className="tos-modal-overlay">
      <div
        className="tos-modal"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className="tos-header">
          <span className="tos-icon"></span>
          <h1>Terms of Service</h1>
          <p className="tos-subtitle">Please review and accept to continue</p>
        </div>

        <div className="tos-content" onScroll={handleScroll}>
          <h2>Club Arena Terms of Service</h2>
          <p className="tos-updated">Last Updated: January 2026</p>

          <h3>1. Acceptance of Terms</h3>
          <p>
            By accessing or using Club Arena ("the Service"), you agree to be bound by these Terms
            of Service. If you do not agree to these terms, you may not use the Service.
          </p>

          <h3>2. Description of Service</h3>
          <p>
            Club Arena is a poker club management platform that enables users to create and join
            private poker clubs, manage agents and players, and participate in poker games.
          </p>

          <h3>3. User Accounts</h3>
          <p>
            You are responsible for maintaining the confidentiality of your account credentials and
            for all activities that occur under your account. You must immediately notify us of any
            unauthorized use.
          </p>

          <h3>4. Virtual Currency</h3>
          <p>
            The Service uses virtual chips and diamonds for gameplay purposes. Virtual currency has
            no real-world monetary value and cannot be exchanged for real money, goods, or services
            outside the platform.
          </p>

          <h3>5. Prohibited Activities</h3>
          <p>You agree not to:</p>
          <ul>
            <li>Use the Service for any illegal purpose</li>
            <li>Engage in collusion, chip-dumping, or other unfair play</li>
            <li>Use unauthorized scripts or automated software</li>
            <li>Attempt to exploit bugs or vulnerabilities</li>
            <li>Harass, abuse, or threaten other users</li>
            <li>Create multiple accounts to circumvent restrictions</li>
          </ul>

          <h3>6. Privacy Policy</h3>
          <p>
            Your privacy is important to us. We collect and process personal data as described in
            our Privacy Policy, which is incorporated into these Terms by reference.
          </p>

          <h3>7. Intellectual Property</h3>
          <p>
            All content, features, and functionality of the Service are owned by Club Arena and are
            protected by copyright, trademark, and other intellectual property laws.
          </p>

          <h3>8. Disclaimer of Warranties</h3>
          <p>
            THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR
            IMPLIED. WE DO NOT GUARANTEE UNINTERRUPTED OR ERROR-FREE SERVICE.
          </p>

          <h3>9. Limitation of Liability</h3>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, SMARTER.POKER SHALL NOT BE LIABLE FOR ANY
            INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES.
          </p>

          <h3>10. Changes to Terms</h3>
          <p>
            We reserve the right to modify these Terms at any time. Continued use of the Service
            after changes constitutes acceptance of the modified Terms.
          </p>

          <h3>11. Governing Law</h3>
          <p>
            These Terms shall be governed by and construed in accordance with the laws of the
            jurisdiction in which Club Arena operates.
          </p>

          <h3>12. Contact</h3>
          <p>For questions about these Terms, please contact us at support@smarter.poker</p>

          <div className="tos-scroll-hint">
            {!hasScrolledToBottom && '↓ Scroll to read all terms'}
          </div>
        </div>

        <div className="tos-footer">
          <label className="tos-checkbox-label">
            <input
              type="checkbox"
              checked={hasScrolledToBottom}
              onChange={() => setHasScrolledToBottom(true)}
            />
            I have read and agree to the Terms of Service and Privacy Policy
          </label>

          <button
            className="tos-accept-btn"
            onClick={handleAccept}
            disabled={!hasScrolledToBottom || isAccepting}
          >
            {isAccepting ? 'Accepting...' : ' Accept & Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
