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
  /* A failed acceptance used to be reported to Sentry and shown to the player
     as nothing at all: the button flipped from "Accepting..." back to
     "Accept & Continue" and the modal sat there. The player's only reading of
     that is "the site is broken". The reason the server gave is shown here. */
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    try {
      await onAccept();
    } catch (err) {
      reportError(err, 'TOSAcceptanceModal.onAccept_error');
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not record your acceptance. Please try again.'
      );
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
          <h1>Terms Of Service</h1>
          <p className="tos-subtitle">Please Review And Accept To Continue</p>
        </div>

        <div className="tos-content" onScroll={handleScroll}>
          <h2>Club Arena Terms Of Service</h2>
          <p className="tos-updated">Last Updated: January 2026</p>

          <h3>1. Acceptance Of Terms</h3>
          <p>
            By Accessing Or Using Club Arena ("The Service"), You Agree To Be Bound By These Terms
            Of Service. If You Do Not Agree To These Terms, You May Not Use The Service.
          </p>

          <h3>2. Description Of Service</h3>
          <p>
            Club Arena Is A Poker Club Management Platform That Enables Users To Create And Join
            Private Poker Clubs, Manage Agents And Players, And Participate In Poker Games.
          </p>

          <h3>3. User Accounts</h3>
          <p>
            You Are Responsible For Maintaining The Confidentiality Of Your Account Credentials And
            For All Activities That Occur Under Your Account. You Must Immediately Notify Us Of Any
            Unauthorized Use.
          </p>

          <h3>4. Virtual Currency</h3>
          <p>
            Chips Are Club Play Credits. Smarter.Poker Does Not Sell, Redeem Or Pay Out Chips And
            Assigns Them No Monetary Value; Any Arrangement Between A Member And Their Club's Agent
            Is Private And Off-Platform. Diamonds Are A Virtual Currency Sold By Smarter.Poker For
            Use Inside The Platform Only.
          </p>

          <h3>5. Prohibited Activities</h3>
          <p>You Agree Not To:</p>
          <ul>
            <li>Use The Service For Any Illegal Purpose</li>
            <li>Engage In Collusion, Chip-Dumping, Or Other Unfair Play</li>
            <li>Use Unauthorized Scripts Or Automated Software</li>
            <li>Attempt To Exploit Bugs Or Vulnerabilities</li>
            <li>Harass, Abuse, Or Threaten Other Users</li>
            <li>Create Multiple Accounts To Circumvent Restrictions</li>
          </ul>

          <h3>6. Privacy Policy</h3>
          <p>
            Your Privacy Is Important To Us. We Collect And Process Personal Data As Described In
            Our Privacy Policy, Which Is Incorporated Into These Terms By Reference.
          </p>

          <h3>7. Intellectual Property</h3>
          <p>
            All Content, Features, And Functionality Of The Service Are Owned By Club Arena And Are
            Protected By Copyright, Trademark, And Other Intellectual Property Laws.
          </p>

          <h3>8. Disclaimer Of Warranties</h3>
          <p>
            THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR
            IMPLIED. WE DO NOT GUARANTEE UNINTERRUPTED OR ERROR-FREE SERVICE.
          </p>

          <h3>9. Limitation Of Liability</h3>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, SMARTER.POKER SHALL NOT BE LIABLE FOR ANY
            INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES.
          </p>

          <h3>10. Changes To Terms</h3>
          <p>
            We Reserve The Right To Modify These Terms At Any Time. Continued Use Of The Service
            After Changes Constitutes Acceptance Of The Modified Terms.
          </p>

          <h3>11. Governing Law</h3>
          <p>
            These Terms Shall Be Governed By And Construed In Accordance With The Laws Of The
            Jurisdiction In Which Club Arena Operates.
          </p>

          <h3>12. Contact</h3>
          <p>For Questions About These Terms, Please Contact Us At Support@Smarter.Poker</p>

          <div className="tos-scroll-hint">
            {!hasScrolledToBottom && '↓ Scroll To Read All Terms'}
          </div>
        </div>

        <div className="tos-footer">
          <label className="tos-checkbox-label">
            <input
              type="checkbox"
              checked={hasScrolledToBottom}
              onChange={() => setHasScrolledToBottom(true)}
            />
            I Have Read And Agree To The Terms Of Service And Privacy Policy
          </label>

          {error && (
            <p className="tos-error" role="alert">
              {error}
            </p>
          )}

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
