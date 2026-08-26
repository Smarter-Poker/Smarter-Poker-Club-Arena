/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB ARENA — Club Promotion Rules
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useNavigate } from 'react-router-dom';
import StandardContentLayout from '../../components/layouts/StandardContentLayout';
import styles from './LegalPage.module.css';

const sectionAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `animationsFadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

export default function PromotionsPage() {
  const navigate = useNavigate();

  return (
    <StandardContentLayout className={styles.page}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>
          ← Back
        </button>
        <h1>Club Promotion Rules</h1>
      </div>

      <div className={styles.content}>
        <section style={sectionAnimationStyle(0)}>
          <h2>1. General Promotion Guidelines</h2>
          <p>
            All Promotions, Bonuses, And Special Offers In Club Arena Are Subject To These Rules. By
            Participating In Any Promotion, You Agree To Abide By These Terms.
          </p>
        </section>

        <section style={sectionAnimationStyle(1)}>
          <h2>2. Eligibility</h2>
          <p>
            Promotions Are Available To All Registered Club Arena Users Unless Otherwise Specified.
            Users Must Have An Active Account In Good Standing To Participate.
          </p>
          <ul>
            <li>One Promotion Per User Unless Stated Otherwise</li>
            <li>Users With Suspended Or Banned Accounts Are Not Eligible</li>
            <li>
              Club Owners May Set Additional Eligibility Requirements For Club-Specific Promotions
            </li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(2)}>
          <h2>3. Daily Bonuses</h2>
          <p>Daily Bonuses Are Awarded For Consecutive Daily Logins:</p>
          <ul>
            <li>Day 1: 100 Chips</li>
            <li>Day 2: 200 Chips</li>
            <li>Day 3: 300 Chips</li>
            <li>Day 4: 400 Chips</li>
            <li>Day 5: 500 Chips</li>
            <li>Day 6: 600 Chips</li>
            <li>Day 7: 1000 Chips + 100 Diamonds</li>
          </ul>
          <p>Missing A Day Resets Your Streak To Day 1.</p>
        </section>

        <section style={sectionAnimationStyle(3)}>
          <h2>4. Tournament Promotions</h2>
          <p>Tournament Promotions May Include:</p>
          <ul>
            <li>Freeroll Tournaments With Guaranteed Prize Pools</li>
            <li>Reduced Buy-In Tournaments</li>
            <li>Satellite Tournaments To Larger Events</li>
            <li>Special Tournament Series With Leaderboards</li>
          </ul>
          <p>
            All Tournament Promotions Are Subject To The Tournament's Specific Terms And Conditions.
          </p>
        </section>

        <section style={sectionAnimationStyle(4)}>
          <h2>5. Rakeback And Loyalty Rewards</h2>
          <p>
            Rakeback Is Calculated Based On The Rake Contributed In Cash Games And Tournament Fees:
          </p>
          <ul>
            <li>Bronze VIP: 5% Rakeback</li>
            <li>Silver VIP: 10% Rakeback</li>
            <li>Gold VIP: 15% Rakeback</li>
            <li>Platinum VIP: 20% Rakeback</li>
            <li>Diamond VIP: 25% Rakeback</li>
          </ul>
          <p>Rakeback Is Credited Weekly On Mondays For The Previous Week's Play.</p>
        </section>

        <section style={sectionAnimationStyle(5)}>
          <h2>6. Referral Bonuses</h2>
          <p>Refer Friends To Club Arena And Earn Rewards:</p>
          <ul>
            <li>Referrer Receives 500 Chips When Friend Completes Registration</li>
            <li>Referrer Receives 1000 Chips When Friend Plays Their First Hand</li>
            <li>Referrer Receives 5% Of Friend's Rake For Their First Month</li>
          </ul>
          <p>
            Self-Referrals And Fake Accounts Are Prohibited And Will Result In Account Termination.
          </p>
        </section>

        <section style={sectionAnimationStyle(6)}>
          <h2>7. Club-Specific Promotions</h2>
          <p>Individual Clubs May Run Their Own Promotions With Custom Rules:</p>
          <ul>
            <li>Club Owners Set Promotion Terms And Eligibility</li>
            <li>Club Promotions Are Funded By The Club, Not Club Arena</li>
            <li>Disputes Regarding Club Promotions Should Be Directed To The Club Owner</li>
          </ul>
        </section>

        <section style={sectionAnimationStyle(7)}>
          <h2>8. Promotion Abuse</h2>
          <p>
            The Following Activities Are Considered Promotion Abuse And Are Strictly Prohibited:
          </p>
          <ul>
            <li>Creating Multiple Accounts To Claim Bonuses</li>
            <li>Colluding With Other Players To Manipulate Promotions</li>
            <li>Using Automated Tools Or Unauthorized Software</li>
            <li>Exploiting Bugs Or Glitches To Gain Unfair Advantages</li>
          </ul>
          <p>
            Promotion Abuse Will Result In Forfeiture Of Bonuses And Potential Account Termination.
          </p>
        </section>

        <section style={sectionAnimationStyle(8)}>
          <h2>9. Modification And Cancellation</h2>
          <p>
            Club Arena Reserves The Right To Modify, Suspend, Or Cancel Any Promotion At Any Time
            Without Prior Notice. In The Event Of Cancellation, Users Will Be Notified And Any
            Earned Rewards Will Be Honored.
          </p>
        </section>

        <section style={sectionAnimationStyle(9)}>
          <h2>10. Disputes</h2>
          <p>
            All Decisions Regarding Promotions Are Final And At The Sole Discretion Of Club Arena.
            For Promotion-Related Questions Or Disputes, Contact Support@Smarter.Poker
          </p>
        </section>

        <div className={styles.lastUpdated}>Last Updated: January 29, 2026</div>
      </div>
    </StandardContentLayout>
  );
}
