/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB ARENA — Fair Gaming Policy
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import styles from './LegalPage.module.css';

const sectionAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

export default function FairGamingPage() {
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>
          ← Back
        </button>
        <h1>Fair Gaming Policy</h1>
      </div>

      <div className={styles.content}>
        <section style={sectionAnimationStyle(0)}>
          <h2>Our Commitment To Fair Play</h2>
          <p>
            Club Arena Is Committed To Providing A Fair, Secure, And Enjoyable Poker Experience For
            All Players. We Employ Industry-Leading Technology And Practices To Ensure Game
            Integrity.
          </p>
        </section>

        <section style={sectionAnimationStyle(1)}>
          <h2>Random Number Generation (RNG)</h2>
          <p>
            All Card Shuffling And Dealing In Club Arena Uses A Certified Random Number Generator
            (RNG):
          </p>
          <ul>
            <li>Cryptographically Secure Random Number Generation</li>
            <li>Each Shuffle Is Completely Independent And Unpredictable</li>
            <li>No Patterns Or Predictability In Card Distribution</li>
            <li>Regular Third-Party Audits To Verify Randomness</li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(2)}>
          <h2>Game Integrity</h2>
          <p>We Maintain Game Integrity Through Multiple Safeguards:</p>
          <ul>
            <li>
              <strong>Secure Servers:</strong> All Games Run On Secure, Monitored Servers
            </li>
            <li>
              <strong>Encrypted Communication:</strong> All Data Transmission Is Encrypted
            </li>
            <li>
              <strong>Anti-Cheating Detection:</strong> Automated Systems Detect Suspicious Patterns
            </li>
            <li>
              <strong>Hand History Verification:</strong> All Hands Are Logged And Can Be Reviewed
            </li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(3)}>
          <h2>Prohibited Activities</h2>
          <p>
            The Following Activities Are Strictly Prohibited And Will Result In Immediate Account
            Termination:
          </p>
          <ul>
            <li>
              <strong>Collusion:</strong> Working With Other Players To Gain An Unfair Advantage
            </li>
            <li>
              <strong>Multi-Accounting:</strong> Using Multiple Accounts At The Same Table
            </li>
            <li>
              <strong>Chip Dumping:</strong> Intentionally Losing Chips To Another Player
            </li>
            <li>
              <strong>Unauthorized Software:</strong> Using Automated Software To Play
            </li>
            <li>
              <strong>Real-Time Assistance (RTA):</strong> Using External Tools During Play
            </li>
            <li>
              <strong>Account Sharing:</strong> Allowing Others To Play On Your Account
            </li>
            <li>
              <strong>Ghosting:</strong> Receiving Advice From Others During Play
            </li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(4)}>
          <h2>Detection And Monitoring</h2>
          <p>Our Security Team Actively Monitors For Unfair Play:</p>
          <ul>
            <li>Automated Pattern Detection Algorithms</li>
            <li>Manual Review Of Flagged Accounts</li>
            <li>Player Reports And Investigations</li>
            <li>Statistical Analysis Of Play Patterns</li>
            <li>IP Address And Device Fingerprinting</li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(5)}>
          <h2>Player Reporting</h2>
          <p>If You Suspect Unfair Play, You Can Report It:</p>
          <ul>
            <li>Use The "Report Player" Button At The Table</li>
            <li>Provide Hand Numbers And Specific Details</li>
            <li>Include Any Supporting Evidence</li>
            <li>Reports Are Reviewed Within 24-48 Hours</li>
          </ul>
          <p>All Reports Are Confidential And Investigated Thoroughly.</p>
        </section>

        <section style={sectionAnimationStyle(6)}>
          <h2>Consequences Of Cheating</h2>
          <p>Players Found Violating Fair Play Rules Face:</p>
          <ul>
            <li>
              <strong>First Offense:</strong> Warning And Temporary Suspension (7-30 Days)
            </li>
            <li>
              <strong>Second Offense:</strong> Extended Suspension (30-90 Days) And Chip
              Confiscation
            </li>
            <li>
              <strong>Third Offense:</strong> Permanent Account Termination
            </li>
            <li>
              <strong>Severe Violations:</strong> Immediate Permanent Ban
            </li>
          </ul>
          <p>
            Ill-Gotten Chips Will Be Confiscated And Redistributed To Affected Players When
            Possible.
          </p>
        </section>

        <section style={sectionAnimationStyle(7)}>
          <h2>Hand History Access</h2>
          <p>All Players Have Access To Their Hand Histories:</p>
          <ul>
            <li>View All Hands You've Played</li>
            <li>Download Hand Histories For Analysis</li>
            <li>Share Hands With Friends Or Coaches</li>
            <li>Verify Game Outcomes And Actions</li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(8)}>
          <h2>Dispute Resolution</h2>
          <p>If You Believe A Game Outcome Was Unfair:</p>
          <ul>
            <li>Contact Support@Smarter.Poker With The Hand Number</li>
            <li>Our Team Will Review The Hand History</li>
            <li>You Will Receive A Response Within 48 Hours</li>
            <li>If An Error Is Found, Appropriate Compensation Will Be Provided</li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(9)}>
          <h2>Continuous Improvement</h2>
          <p>We Continuously Improve Our Fair Play Systems:</p>
          <ul>
            <li>Regular Security Audits</li>
            <li>Updates To Detection Algorithms</li>
            <li>Community Feedback Integration</li>
            <li>Industry Best Practice Adoption</li>
          </ul>
        </section>

        <div className={styles.lastUpdated}>Last Updated: January 29, 2026</div>
      </div>
    </div>
  );
}
