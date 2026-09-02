import { Link } from 'react-router-dom';
import LegalDocumentLayout, {
  type LegalDocumentSection,
} from '../../components/legal/LegalDocumentLayout';

const SECTIONS: LegalDocumentSection[] = [
  {
    id: 'general-rules',
    title: 'General Promotion Rules',
    content: (
      <p>
        Promotions, Bonuses, And Special Offers In Club Arena Are Subject To These Rules And The
        Campaign-Specific Terms Displayed With The Live Offer. Participating In A Promotion Means
        Accepting Both.
      </p>
    ),
  },
  {
    id: 'eligibility',
    title: 'Eligibility',
    content: (
      <ul>
        <li>Users Must Have An Active Account In Good Standing</li>
        <li>One Claim Per Eligible User Unless The Live Offer Says Otherwise</li>
        <li>Suspended Or Banned Accounts Are Not Eligible</li>
        <li>Club-Specific Offers May Add Membership Or Activity Requirements</li>
        <li>Age, Location, Start Time, End Time, And Inventory Limits May Apply</li>
      </ul>
    ),
  },
  {
    id: 'live-terms',
    title: 'Live Offer Terms Are Authoritative',
    content: (
      <>
        <p>
          Reward Amounts, Rakeback Rates, VIP Benefits, Login Streak Values, Referral Awards, And
          Claim Windows Are Live Data. They Are Not Fixed By This General Policy.
        </p>
        <ul>
          <li>
            Review Current Campaigns In <Link to="/promotions">Promotions</Link>
          </li>
          <li>
            Review Claimable Inventory In <Link to="/bonuses">Bonuses</Link>
          </li>
          <li>
            Review Your Recorded Rate In <Link to="/rakeback">Rakeback</Link>
          </li>
          <li>
            Review Current Benefits In <Link to="/vip">VIP Status</Link>
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'tournament-promotions',
    title: 'Tournament Promotions',
    content: (
      <>
        <p>Tournament Promotions May Include:</p>
        <ul>
          <li>Freeroll Events With Published Prize Pools</li>
          <li>Reduced Entry Events</li>
          <li>Satellite Paths To Larger Events</li>
          <li>Series, Missions, Or Leaderboard Awards</li>
        </ul>
        <p>
          The Live Tournament Structure, Registration Screen, And Promotion Detail Control The
          Event-Specific Entry And Award Terms.
        </p>
      </>
    ),
  },
  {
    id: 'club-promotions',
    title: 'Club-Specific Promotions',
    content: (
      <ul>
        <li>Club Operators Set The Published Terms And Eligibility</li>
        <li>Club-Funded Offers Remain The Responsibility Of That Club</li>
        <li>Players Should Capture The Live Terms Before Participating</li>
        <li>Club Promotion Disputes Should Start With The Club Operator</li>
      </ul>
    ),
  },
  {
    id: 'promotion-abuse',
    title: 'Promotion Abuse',
    content: (
      <>
        <p>Prohibited Promotion Conduct Includes:</p>
        <ul>
          <li>Creating Multiple Accounts To Claim The Same Offer</li>
          <li>Colluding To Manipulate Eligibility Or Outcomes</li>
          <li>Using Automation Or Unauthorized Software</li>
          <li>Exploiting A Bug, Race Condition, Or Duplicate Claim Path</li>
          <li>Providing False Information To Obtain A Reward</li>
        </ul>
        <p>
          Confirmed Abuse May Cause Claim Reversal, Reward Forfeiture, Feature Restriction, Or
          Account Action.
        </p>
      </>
    ),
  },
  {
    id: 'changes-cancellation',
    title: 'Modification And Cancellation',
    content: (
      <p>
        Club Arena Or The Responsible Club May Modify, Suspend, Or Cancel A Promotion When The Live
        Terms Permit It, Including For Integrity, Funding, Configuration, Or Availability Problems.
        Already Earned Awards Are Handled According To The Recorded Campaign And Claim State.
      </p>
    ),
  },
  {
    id: 'disputes',
    title: 'Questions And Disputes',
    content: (
      <p>
        Include The Promotion Name, Club, Claim Time, And Any Confirmation Identifier When
        Contacting <a href="mailto:support@smarter.poker">Support@Smarter.Poker</a>. Platform
        Records And The Captured Live Terms Are Used To Review The Claim.
      </p>
    ),
  },
];

export default function PromotionsPage() {
  return (
    <LegalDocumentLayout
      documentCode="CA-PRM-02"
      eyebrow="Campaign Governance"
      title="Promotion Rules"
      summary="The Eligibility, Live-Term Authority, Abuse Controls, And Dispute Process For Platform And Club Offers."
      lastUpdated="August 29, 2026"
      sections={SECTIONS}
    />
  );
}
