import LegalDocumentLayout, {
  type LegalDocumentSection,
} from '../../components/legal/LegalDocumentLayout';

const SECTIONS: LegalDocumentSection[] = [
  {
    id: 'introduction',
    title: 'Introduction',
    content: (
      <p>
        Club Arena Is Committed To Protecting Your Privacy. This Policy Explains How We Collect,
        Use, Disclose, And Safeguard Information When You Use The Poker Platform.
      </p>
    ),
  },
  {
    id: 'information-collected',
    title: 'Information We Collect',
    content: (
      <>
        <h3>Personal Information</h3>
        <ul>
          <li>Email Address</li>
          <li>Username And Display Name</li>
          <li>Profile Picture Or Avatar</li>
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
          <li>Browser Type, Version, And Operating System</li>
          <li>Login Times And Session Duration</li>
          <li>Cookies And Similar Technologies</li>
        </ul>
      </>
    ),
  },
  {
    id: 'information-use',
    title: 'How We Use Your Information',
    content: (
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
          <strong>Improvement:</strong> Analyzing Usage To Improve Services
        </li>
        <li>
          <strong>Personalization:</strong> Customizing Your Experience
        </li>
        <li>
          <strong>Legal Compliance:</strong> Meeting Legal And Regulatory Requirements
        </li>
      </ul>
    ),
  },
  {
    id: 'information-sharing',
    title: 'Information Sharing And Disclosure',
    content: (
      <>
        <p>We Do Not Sell Your Personal Information. We May Share Information:</p>
        <ul>
          <li>
            <strong>With Your Consent:</strong> When You Explicitly Agree
          </li>
          <li>
            <strong>With Club Members:</strong> Where Your Username And Stats Are Visible In A Club
          </li>
          <li>
            <strong>With Service Providers:</strong> For Hosting, Analytics, And Platform Operations
          </li>
          <li>
            <strong>For Legal Requirements:</strong> When Required By Law Or To Protect Rights And
            Safety
          </li>
          <li>
            <strong>For Business Transfers:</strong> In Connection With A Merger Or Acquisition
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'third-party-services',
    title: 'Third-Party Services We Use',
    content: (
      <>
        <p>These Services Process Data On Our Behalf, Each For One Purpose:</p>
        <ul>
          <li>
            <strong>Supabase:</strong> Hosting, Database, Authentication And Real-Time Gameplay.
            Your Account And Gameplay Data Live Here.
          </li>
          <li>
            <strong>Sentry:</strong> Crash And Error Reporting. An Error Report Carries Your User ID
            And Username, The Device And App Version, And What Went Wrong. It Does Not Carry Your
            Email Address. In The Mobile App No Session Replay Is Recorded.
          </li>
          <li>
            <strong>PostHog:</strong> Product Analytics (Which Screens And Features Are Used). In
            The Mobile App This Runs Only If You Allow It, And You Can Change Your Answer In
            Settings At Any Time. It Never Receives Hands, Chips Or Messages.
          </li>
          <li>
            <strong>Apple App Store And Google Play:</strong> In The Mobile App, Diamonds And VIP
            Are Purchased Through Your Store Account. We Receive A Purchase Record And Never Your
            Payment Details. Stripe Handles Card Payments On The Website.
          </li>
          <li>
            <strong>Firebase Cloud Messaging:</strong> Delivers Push Notifications To The Mobile App
            If You Turn Them On. It Receives A Device Token, Not Your Identity.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'data-security',
    title: 'Data Security',
    content: (
      <>
        <p>We Use Safeguards That Include:</p>
        <ul>
          <li>Encryption Of Data In Transit And At Rest</li>
          <li>Secure Authentication And Password Hashing</li>
          <li>Security Audits And Updates</li>
          <li>Access Controls And Monitoring</li>
          <li>Secure Data Centers And Infrastructure</li>
        </ul>
        <p>
          No Method Of Transmission Over The Internet Is Completely Secure, And Absolute Security
          Cannot Be Guaranteed.
        </p>
      </>
    ),
  },
  {
    id: 'privacy-rights',
    title: 'Your Privacy Rights',
    content: (
      <>
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
            <strong>Privacy Settings:</strong> Control Information Visible To Other Players
          </li>
        </ul>
        <p>
          To Exercise These Rights, Contact{' '}
          <a href="mailto:privacy@smarter.poker">Privacy@Smarter.Poker</a>.
        </p>
      </>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies And Tracking',
    content: (
      <>
        <p>Cookies And Similar Technologies Help Us:</p>
        <ul>
          <li>Maintain Your Session And Keep You Logged In</li>
          <li>Remember Preferences And Settings</li>
          <li>Analyze Usage Patterns And Improve Services</li>
          <li>Provide Personalized Content And Features</li>
        </ul>
        <p>
          You Can Control Cookies Through Your Browser Settings, But Disabling Them May Affect
          Platform Functionality.
        </p>
      </>
    ),
  },
  {
    id: 'children',
    title: "Children's Privacy",
    content: (
      <p>
        Club Arena Is Not Intended For Users Under 18 Years Of Age. We Do Not Knowingly Collect
        Information From Children Under 18. If We Discover Such Information, We Will Delete It.
      </p>
    ),
  },
  {
    id: 'retention',
    title: 'Data Retention',
    content: (
      <>
        <p>
          We Retain Information While Your Account Is Active Or As Needed To Provide Services. After
          Account Deletion:
        </p>
        <ul>
          <li>Personal Information Is Deleted Within 30 Days</li>
          <li>Anonymized Gameplay Statistics May Be Retained For Analysis</li>
          <li>Legal And Compliance Records Are Retained As Required By Law</li>
        </ul>
      </>
    ),
  },
  {
    id: 'international-transfers',
    title: 'International Data Transfers',
    content: (
      <p>
        Information May Be Transferred To And Processed In Countries Other Than Your Own. We Use
        Appropriate Safeguards To Protect Data In Accordance With This Policy.
      </p>
    ),
  },
  {
    id: 'policy-changes',
    title: 'Changes To This Policy',
    content: (
      <p>
        We May Update This Policy. Material Changes Will Be Posted On This Page With An Updated
        Effective Date.
      </p>
    ),
  },
  {
    id: 'contact',
    title: 'Contact Us',
    content: (
      <ul>
        <li>
          Privacy: <a href="mailto:privacy@smarter.poker">Privacy@Smarter.Poker</a>
        </li>
        <li>
          Support: <a href="mailto:support@smarter.poker">Support@Smarter.Poker</a>
        </li>
      </ul>
    ),
  },
];

export default function PrivacyPolicyPage() {
  return (
    <LegalDocumentLayout
      documentCode="CA-PRV-01"
      eyebrow="Data Stewardship"
      title="Privacy Policy"
      summary="How Club Arena Collects, Uses, Protects, Retains, And Gives You Control Over Information."
      lastUpdated="January 29, 2026"
      sections={SECTIONS}
    />
  );
}
