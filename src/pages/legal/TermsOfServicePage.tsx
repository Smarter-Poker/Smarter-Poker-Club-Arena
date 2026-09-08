import LegalDocumentLayout, {
  type LegalDocumentSection,
} from '../../components/legal/LegalDocumentLayout';

const SECTIONS: LegalDocumentSection[] = [
  {
    id: 'acceptance',
    title: 'Acceptance Of Terms',
    content: (
      <p>
        By Accessing And Using Club Arena, You Accept And Agree To Be Bound By The Terms And
        Provision Of This Agreement. If You Do Not Agree To Abide By The Above, Please Do Not Use
        This Service.
      </p>
    ),
  },
  {
    id: 'use-license',
    title: 'Use License',
    content: (
      <>
        <p>
          Permission Is Granted To Temporarily Access Club Arena For Personal, Non-Commercial Use
          Only. This Is The Grant Of A License, Not A Transfer Of Title, And Under This License You
          May Not:
        </p>
        <ul>
          <li>Modify Or Copy The Materials</li>
          <li>Use The Materials For Any Commercial Purpose Or For Any Public Display</li>
          <li>Attempt To Reverse Engineer Any Software Contained In Club Arena</li>
          <li>Remove Any Copyright Or Other Proprietary Notations From The Materials</li>
          <li>Transfer The Materials To Another Person Or Mirror Them On Another Server</li>
        </ul>
      </>
    ),
  },
  {
    id: 'account-responsibilities',
    title: 'Account Responsibilities',
    content: (
      <p>
        You Are Responsible For Maintaining The Confidentiality Of Your Account And Password. You
        Agree To Accept Responsibility For All Activities That Occur Under Your Account.
      </p>
    ),
  },
  {
    id: 'social-play',
    title: 'Chips Are Club Play Credits',
    content: (
      <p>
        Chips Are Club Play Credits. Smarter.Poker Does Not Sell, Redeem Or Pay Out Chips And
        Assigns Them No Monetary Value; Any Arrangement Between A Member And Their Club's Agent Is
        Private And Off-Platform. Diamonds Are A Virtual Currency Sold By Smarter.Poker For Use
        Inside The Platform Only.
      </p>
    ),
  },
  {
    id: 'fair-play',
    title: 'Fair Play',
    content: (
      <p>
        Users Must Play Fairly And Not Use Unauthorized Automated Tools Or Collude With Other
        Players. Violation Of Fair Play Rules May Result In Account Suspension Or Termination.
      </p>
    ),
  },
  {
    id: 'content-conduct',
    title: 'Content And Conduct',
    content: (
      <>
        <p>Users Must Not Post, Transmit, Or Otherwise Make Available Content That Is:</p>
        <ul>
          <li>Unlawful, Harmful, Threatening, Abusive, Harassing, Or Otherwise Objectionable</li>
          <li>Invasive Of Another Person's Privacy</li>
          <li>Infringing Any Intellectual Property Or Other Proprietary Rights</li>
          <li>Containing Software Viruses Or Other Malicious Code</li>
        </ul>
      </>
    ),
  },
  {
    id: 'termination',
    title: 'Termination',
    content: (
      <p>
        We May Terminate Or Suspend Your Account And Bar Access To The Service Immediately, Without
        Prior Notice Or Liability, Under Our Sole Discretion, For Any Reason Whatsoever, Including
        Without Limitation If You Breach The Terms.
      </p>
    ),
  },
  {
    id: 'liability',
    title: 'Limitation Of Liability',
    content: (
      <p>
        In No Event Shall Club Arena, Nor Its Directors, Employees, Partners, Agents, Suppliers, Or
        Affiliates, Be Liable For Any Indirect, Incidental, Special, Consequential, Or Punitive
        Damages, Including Loss Of Profits, Data, Use, Goodwill, Or Other Intangible Losses.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes To Terms',
    content: (
      <p>
        We Reserve The Right, At Our Sole Discretion, To Modify Or Replace These Terms At Any Time.
        We Will Provide Notice Of Material Changes By Posting The New Terms On This Page.
      </p>
    ),
  },
  {
    id: 'contact',
    title: 'Contact Us',
    content: (
      <p>
        If You Have Questions About These Terms, Contact{' '}
        <a href="mailto:support@smarter.poker">Support@Smarter.Poker</a>.
      </p>
    ),
  },
];

export default function TermsOfServicePage() {
  return (
    <LegalDocumentLayout
      documentCode="CA-TOS-01"
      eyebrow="Platform Agreement"
      title="Terms Of Service"
      summary="The Account, Conduct, Social-Play, And Platform Terms That Govern Club Arena Access."
      lastUpdated="January 29, 2026"
      sections={SECTIONS}
    />
  );
}
