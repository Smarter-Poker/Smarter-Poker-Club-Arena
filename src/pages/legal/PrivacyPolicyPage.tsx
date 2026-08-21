/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB ARENA — Privacy Policy
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useNavigate } from 'react-router-dom';
import styles from './LegalPage.module.css';

const sectionAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

export default function PrivacyPolicyPage() {
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>
          ← Back
        </button>
        <h1>Privacy Policy</h1>
      </div>

      <div className={styles.content}>
        <section style={sectionAnimationStyle(0)}>
          <h2>Introduction</h2>
          <p>
            Club Arena ("We", "Our", Or "Us") Is Committed To Protecting Your Privacy. This Privacy
            Policy Explains How We Collect, Use, Disclose, And Safeguard Your Information When You
            Use Our Poker Platform.
          </p>
        </section>

        <section style={sectionAnimationStyle(1)}>
          <h2>Information We Collect</h2>
          <h3>Personal Information</h3>
          <p>We Collect Information That You Provide Directly To Us:</p>
          <ul>
            <li>Email Address</li>
            <li>Username And Display Name</li>
            <li>Profile Picture/Avatar</li>
            <li>Account Preferences And Settings</li>
          </ul>

          <h3>Gameplay Information</h3>
          <ul>
            <li>Hand Histories And Game Statistics</li>
            <li>Tournament Results And Rankings</li>
            <li>Chip Transactions And Balances</li>
            <li>Club Memberships And Roles</li>
            <li>Chat Messages And Communications</li>
          </ul>

          <h3>Technical Information</h3>
          <ul>
            <li>IP Address And Device Information</li>
            <li>Browser Type And Version</li>
            <li>Operating System</li>
            <li>Login Times And Session Duration</li>
            <li>Cookies And Similar Technologies</li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(2)}>
          <h2>How We Use Your Information</h2>
          <p>We Use The Collected Information For:</p>
          <ul>
            <li>
              <strong>Service Provision:</strong> Operating And Maintaining The Platform
            </li>
            <li>
              <strong>Account Management:</strong> Creating And Managing Your Account
            </li>
            <li>
              <strong>Game Integrity:</strong> Detecting And Preventing Cheating And Fraud
            </li>
            <li>
              <strong>Communication:</strong> Sending Updates, Notifications, And Support Messages
            </li>
            <li>
              <strong>Improvement:</strong> Analyzing Usage To Improve Our Services
            </li>
            <li>
              <strong>Personalization:</strong> Customizing Your Experience
            </li>
            <li>
              <strong>Legal Compliance:</strong> Meeting Legal And Regulatory Requirements
            </li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(3)}>
          <h2>Information Sharing And Disclosure</h2>
          <p>
            We Do Not Sell Your Personal Information. We May Share Information In These
            Circumstances:
          </p>
          <ul>
            <li>
              <strong>With Your Consent:</strong> When You Explicitly Agree
            </li>
            <li>
              <strong>Club Members:</strong> Your Username And Stats Are Visible To Club Members
            </li>
            <li>
              <strong>Service Providers:</strong> Third-Party Services That Help Us Operate
              (Hosting, Analytics)
            </li>
            <li>
              <strong>Legal Requirements:</strong> When Required By Law Or To Protect Rights And
              Safety
            </li>
            <li>
              <strong>Business Transfers:</strong> In Connection With Mergers Or Acquisitions
            </li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(4)}>
          <h2>Data Security</h2>
          <p>We Implement Security Measures To Protect Your Information:</p>
          <ul>
            <li>Encryption Of Data In Transit And At Rest</li>
            <li>Secure Authentication And Password Hashing</li>
            <li>Regular Security Audits And Updates</li>
            <li>Access Controls And Monitoring</li>
            <li>Secure Data Centers And Infrastructure</li>
          </ul>
          <p>
            However, No Method Of Transmission Over The Internet Is 100% Secure. We Cannot Guarantee
            Absolute Security.
          </p>
        </section>

        <section style={sectionAnimationStyle(5)}>
          <h2>Your Privacy Rights</h2>
          <p>You Have The Right To:</p>
          <ul>
            <li>
              <strong>Access:</strong> Request A Copy Of Your Personal Data
            </li>
            <li>
              <strong>Correction:</strong> Update Or Correct Inaccurate Information
            </li>
            <li>
              <strong>Deletion:</strong> Request Deletion Of Your Account And Data
            </li>
            <li>
              <strong>Export:</strong> Download Your Data In A Portable Format
            </li>
            <li>
              <strong>Opt-Out:</strong> Unsubscribe From Marketing Communications
            </li>
            <li>
              <strong>Privacy Settings:</strong> Control What Information Is Visible To Others
            </li>
          </ul>
          <p>To Exercise These Rights, Contact Us At Privacy@Smarter.Poker</p>
        </section>

        <section style={sectionAnimationStyle(6)}>
          <h2>Cookies And Tracking</h2>
          <p>We Use Cookies And Similar Technologies To:</p>
          <ul>
            <li>Maintain Your Session And Keep You Logged In</li>
            <li>Remember Your Preferences And Settings</li>
            <li>Analyze Usage Patterns And Improve Our Services</li>
            <li>Provide Personalized Content And Features</li>
          </ul>
          <p>
            You Can Control Cookies Through Your Browser Settings, But Disabling Them May Affect
            Functionality.
          </p>
        </section>

        <section style={sectionAnimationStyle(7)}>
          <h2>Children's Privacy</h2>
          <p>
            Club Arena Is Not Intended For Users Under 18 Years Of Age. We Do Not Knowingly Collect
            Information From Children Under 18. If We Discover That A Child Under 18 Has Provided Us
            With Personal Information, We Will Delete It Immediately.
          </p>
        </section>

        <section style={sectionAnimationStyle(8)}>
          <h2>Data Retention</h2>
          <p>
            We Retain Your Information For As Long As Your Account Is Active Or As Needed To Provide
            Services. After Account Deletion:
          </p>
          <ul>
            <li>Personal Information Is Deleted Within 30 Days</li>
            <li>Anonymized Gameplay Statistics May Be Retained For Analysis</li>
            <li>Legal And Compliance Records Are Retained As Required By Law</li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(9)}>
          <h2>International Data Transfers</h2>
          <p>
            Your Information May Be Transferred To And Processed In Countries Other Than Your Own.
            We Ensure Appropriate Safeguards Are In Place To Protect Your Data In Accordance With
            This Privacy Policy.
          </p>
        </section>

        <section style={sectionAnimationStyle(10)}>
          <h2>Changes To This Policy</h2>
          <p>
            We May Update This Privacy Policy From Time To Time. We Will Notify You Of Any Material
            Changes By Posting The New Privacy Policy On This Page And Updating The "Last Updated"
            Date.
          </p>
        </section>

        <section style={sectionAnimationStyle(11)}>
          <h2>Contact Us</h2>
          <p>If You Have Questions Or Concerns About This Privacy Policy, Please Contact Us:</p>
          <ul>
            <li>Email: Privacy@Smarter.Poker</li>
            <li>Support: Support@Smarter.Poker</li>
          </ul>
        </section>

        <div className={styles.lastUpdated}>Last Updated: January 29, 2026</div>
      </div>
    </div>
  );
}
