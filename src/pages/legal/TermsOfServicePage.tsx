/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB ARENA — Terms of Service
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useNavigate } from 'react-router-dom';
import styles from './LegalPage.module.css';

const sectionAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

export default function TermsOfServicePage() {
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>
          ← Back
        </button>
        <h1>Terms Of Service</h1>
      </div>

      <div className={styles.content}>
        <section style={sectionAnimationStyle(0)}>
          <h2>1. Acceptance Of Terms</h2>
          <p>
            By Accessing And Using Club Arena, You Accept And Agree To Be Bound By The Terms And
            Provision Of This Agreement. If You Do Not Agree To Abide By The Above, Please Do Not
            Use This Service.
          </p>
        </section>

        <section style={sectionAnimationStyle(1)}>
          <h2>2. Use License</h2>
          <p>
            Permission Is Granted To Temporarily Access Club Arena For Personal, Non-Commercial Use
            Only. This Is The Grant Of A License, Not A Transfer Of Title, And Under This License
            You May Not:
          </p>
          <ul>
            <li>Modify Or Copy The Materials</li>
            <li>Use The Materials For Any Commercial Purpose Or For Any Public Display</li>
            <li>Attempt To Reverse Engineer Any Software Contained In Club Arena</li>
            <li>Remove Any Copyright Or Other Proprietary Notations From The Materials</li>
            <li>
              Transfer The Materials To Another Person Or "Mirror" The Materials On Any Other Server
            </li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(2)}>
          <h2>3. Account Responsibilities</h2>
          <p>
            You Are Responsible For Maintaining The Confidentiality Of Your Account And Password.
            You Agree To Accept Responsibility For All Activities That Occur Under Your Account.
          </p>
        </section>

        <section style={sectionAnimationStyle(3)}>
          <h2>4. Play Money Only</h2>
          <p>
            Club Arena Uses Play Money Chips Only. All Chips, Diamonds, And Virtual Currency Have No
            Real-World Monetary Value And Cannot Be Exchanged For Real Money Or Prizes.
          </p>
        </section>

        <section style={sectionAnimationStyle(4)}>
          <h2>5. Fair Play</h2>
          <p>
            Users Must Play Fairly And Not Use Any Unauthorized Automated Tools Or Collusion With
            Other Players. Violation Of Fair Play Rules May Result In Account Suspension Or
            Termination.
          </p>
        </section>

        <section style={sectionAnimationStyle(5)}>
          <h2>6. Content And Conduct</h2>
          <p>Users Must Not Post, Transmit, Or Otherwise Make Available Any Content That Is:</p>
          <ul>
            <li>Unlawful, Harmful, Threatening, Abusive, Harassing, Or Otherwise Objectionable</li>
            <li>Invasive Of Another's Privacy</li>
            <li>Infringes Any Intellectual Property Or Other Proprietary Rights</li>
            <li>Contains Software Viruses Or Any Other Malicious Code</li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(6)}>
          <h2>7. Termination</h2>
          <p>
            We May Terminate Or Suspend Your Account And Bar Access To The Service Immediately,
            Without Prior Notice Or Liability, Under Our Sole Discretion, For Any Reason Whatsoever,
            Including Without Limitation If You Breach The Terms.
          </p>
        </section>

        <section style={sectionAnimationStyle(7)}>
          <h2>8. Limitation Of Liability</h2>
          <p>
            In No Event Shall Club Arena, Nor Its Directors, Employees, Partners, Agents, Suppliers,
            Or Affiliates, Be Liable For Any Indirect, Incidental, Special, Consequential Or
            Punitive Damages, Including Without Limitation, Loss Of Profits, Data, Use, Goodwill, Or
            Other Intangible Losses.
          </p>
        </section>

        <section style={sectionAnimationStyle(8)}>
          <h2>9. Changes To Terms</h2>
          <p>
            We Reserve The Right, At Our Sole Discretion, To Modify Or Replace These Terms At Any
            Time. We Will Provide Notice Of Any Material Changes By Posting The New Terms On This
            Page.
          </p>
        </section>

        <section style={sectionAnimationStyle(9)}>
          <h2>10. Contact Us</h2>
          <p>
            If You Have Any Questions About These Terms, Please Contact Us At Support@Smarter.Poker
          </p>
        </section>

        <div className={styles.lastUpdated}>Last Updated: January 29, 2026</div>
      </div>
    </div>
  );
}
