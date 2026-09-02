import { Link } from 'react-router-dom';
import LegalDocumentLayout, {
  type LegalDocumentSection,
} from '../../components/legal/LegalDocumentLayout';

const SECTIONS: LegalDocumentSection[] = [
  {
    id: 'commitment',
    title: 'Our Commitment To Fair Play',
    content: (
      <p>
        Club Arena Is Built To Provide A Fair, Secure, And Reviewable Social Poker Experience. Game
        Outcomes, Player Actions, And Operator Decisions Must Remain Traceable To Authoritative
        Records.
      </p>
    ),
  },
  {
    id: 'card-randomness',
    title: 'Card Randomness',
    content: (
      <>
        <p>
          Live Card Paths Use Cryptographically Secure Random Values And An Unbiased Fisher-Yates
          Shuffle. Equity Simulations Use Separate Deterministic Sampling And Do Not Deal Live
          Cards.
        </p>
        <ul>
          <li>Each Live Deck Is Shuffled Before The Deal</li>
          <li>Live Dealing Does Not Use Predictable Math.Random Values</li>
          <li>Card Outcomes Are Not Selected By A Club Owner Or Player Client</li>
          <li>Distribution Monitoring Is Segmented By Game Variant</li>
        </ul>
      </>
    ),
  },
  {
    id: 'integrity-records',
    title: 'Game Integrity Records',
    content: (
      <ul>
        <li>
          <strong>Server Authority:</strong> The Game Engine Owns Legal Actions And Final Outcomes
        </li>
        <li>
          <strong>Hand History:</strong> Completed Hands Preserve The Action Record For Review
        </li>
        <li>
          <strong>Secure Transport:</strong> Platform Traffic Uses Encrypted Connections
        </li>
        <li>
          <strong>Audit Signals:</strong> Suspicious Patterns Can Be Flagged For Investigation
        </li>
      </ul>
    ),
  },
  {
    id: 'prohibited-conduct',
    title: 'Prohibited Conduct',
    content: (
      <ul>
        <li>
          <strong>Collusion:</strong> Coordinating With Other Players For An Unfair Advantage
        </li>
        <li>
          <strong>Multi-Accounting:</strong> Controlling Multiple Accounts In The Same Game
        </li>
        <li>
          <strong>Chip Dumping:</strong> Intentionally Moving Chips Through Artificial Losses
        </li>
        <li>
          <strong>Automation:</strong> Using Unauthorized Software To Make Or Submit Decisions
        </li>
        <li>
          <strong>Real-Time Assistance:</strong> Using Prohibited External Decision Tools During
          Play
        </li>
        <li>
          <strong>Account Sharing:</strong> Allowing Another Person To Play Through Your Account
        </li>
        <li>
          <strong>Ghosting:</strong> Receiving Live Strategic Direction From Another Person
        </li>
      </ul>
    ),
  },
  {
    id: 'detection-review',
    title: 'Detection And Review',
    content: (
      <>
        <p>Integrity Review Can Use Multiple Signals:</p>
        <ul>
          <li>Automated Pattern And Relationship Detection</li>
          <li>Manual Review Of Flagged Accounts And Hands</li>
          <li>Player Reports And Supporting Evidence</li>
          <li>Statistical Analysis Of Actions And Outcomes</li>
          <li>Account, Session, Device, And Network Signals Where Permitted</li>
        </ul>
      </>
    ),
  },
  {
    id: 'reporting',
    title: 'Player Reporting',
    content: (
      <>
        <p>
          Use Report Player From A Table Or Player Profile. Include The Hand Number, The Conduct You
          Observed, And Any Relevant Context. Reports Are Kept Within The Review Process.
        </p>
        <p>
          Review Your Own Evidence In <Link to="/hand-history">Hand History</Link> Or Contact{' '}
          <a href="mailto:support@smarter.poker">Support@Smarter.Poker</a>.
        </p>
      </>
    ),
  },
  {
    id: 'enforcement',
    title: 'Enforcement',
    content: (
      <p>
        Confirmed Violations May Lead To Warnings, Feature Restrictions, Temporary Suspension, Chip
        Reversal Or Confiscation Where Supported By The Record, And Permanent Account Removal.
        Severity, Repetition, Evidence, And Player Impact Inform The Response.
      </p>
    ),
  },
  {
    id: 'disputes',
    title: 'Disputes And Continuous Review',
    content: (
      <>
        <p>
          Send A Dispute With The Hand Number And Specific Concern To Support@Smarter.Poker. The
          Review Uses The Authoritative Hand And Account Records Available To The Platform.
        </p>
        <p>
          Security Controls, Detection Rules, And Fairness Measurements Are Reviewed As The Engine
          And Supported Game Variants Evolve.
        </p>
      </>
    ),
  },
];

export default function FairGamingPage() {
  return (
    <LegalDocumentLayout
      documentCode="CA-FGP-02"
      eyebrow="Integrity Standard"
      title="Fair Gaming Policy"
      summary="The Live-Deal Safeguards, Review Records, Prohibited Conduct, And Reporting Paths That Protect Social Poker."
      lastUpdated="August 29, 2026"
      sections={SECTIONS}
    />
  );
}
