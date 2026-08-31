import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import FeedbackForm from '../components/support/FeedbackForm';
import SystemStatus from '../components/support/SystemStatus';
import styles from './HelpPage.module.css';

interface FAQItem {
  category: 'Account' | 'Clubs' | 'Play' | 'Rewards' | 'Safety';
  question: string;
  answer: string;
}

const FAQ_ITEMS: FAQItem[] = [
  {
    category: 'Account',
    question: 'How Do I Customize My Profile?',
    answer:
      'Open My Profile To Update Your Avatar, Display Name, Bio, And Player Identity. Account And Device Controls Remain In Settings.',
  },
  {
    category: 'Account',
    question: 'How Do I Change My Password?',
    answer:
      'Open Settings, Find Account, And Choose Change Password. Club Arena Sends The Reset Through Your Verified Account Email.',
  },
  {
    category: 'Account',
    // 2026-08-28: this said 2FA was "Coming Soon" for a feature that SHIPPED —
    // SettingsPage implements enrol / challenge / verify / unenrol against
    // Supabase MFA, with a QR modal. Telling a player a security feature does
    // not exist yet, while it sits two taps away, is a false statement about
    // their account security.
    question: 'Is Two-Factor Authentication Available?',
    answer:
      'Yes. Go To Settings → Account → Account Security And Choose Enable Two-Factor Authentication. Scan The QR Code With Your Authenticator App, Then Enter The Six-Digit Code To Confirm.',
  },
  {
    category: 'Account',
    question: 'How Do I Delete My Account?',
    answer:
      'Open Settings And Find Danger Zone. Delete Account Starts The Permanent Deletion Confirmation And Explains What Will Be Removed.',
  },
  {
    category: 'Clubs',
    question: 'How Do I Find Or Join A Club?',
    answer:
      'Use Find Players And Clubs From The Menu. Some Clubs Accept Requests Immediately; Private Clubs Require Approval Or An Invite.',
  },
  {
    category: 'Clubs',
    question: 'Where Do Club Operators Manage A Club?',
    answer:
      'Open The Club, Then Open Operations Center. Available People, Finance, Safety, And Control Tools Match Your Confirmed Club Role.',
  },
  {
    category: 'Play',
    question: 'How Do I Join A Tournament?',
    answer:
      'Open Tournaments, Select An Event, Review Its Live Structure And Entry Requirements, Then Choose Register When Registration Is Open.',
  },
  {
    category: 'Play',
    question: 'Where Can I Review A Hand?',
    answer:
      'Open Hand History To Find Completed Hands, Inspect The Action Record, And Launch The Hand Replayer When Replay Data Is Available.',
  },
  {
    category: 'Play',
    question: 'What Is The Bad Beat Jackpot?',
    answer:
      'Eligible Clubs Can Fund A Progressive Bad Beat Jackpot. The Live Club Rules And Jackpot Panel Show Qualification, Funding, And Payout Details.',
  },
  {
    category: 'Rewards',
    question: 'Where Can I See My Rewards?',
    answer:
      'Open Rewards Center For Wallet Balances, Transactions, VIP Status, Rakeback, Promotions, Bonuses, Achievements, And Challenges.',
  },
  {
    category: 'Rewards',
    question: 'Why Can A Bonus Or Rakeback Rate Change?',
    answer:
      'Reward Amounts Come From The Live Offer, Club, Or Rakeback Record. Review The Current Promotion And Claim Terms Before Participating.',
  },
  {
    category: 'Safety',
    question: 'How Do I Report Suspected Unfair Play?',
    answer:
      'Use Report Player From The Table Or Player Profile And Include The Hand Number And Specific Conduct. You Can Also Send A Support Request Here.',
  },
  {
    category: 'Safety',
    question: 'How Do I Report A Product Problem?',
    answer:
      'Choose Send Support Request, Select Bug, And Describe What Happened. The Form Only Confirms Success After The Request Reaches The Support Queue.',
  },
];

const QUICK_LINKS = [
  { label: 'Find A Club', path: '/search' },
  { label: 'Hand History', path: '/hand-history' },
  { label: 'Rewards Center', path: '/rewards' },
  { label: 'Fair Gaming', path: '/legal/fair-gaming' },
];

export default function HelpPage() {
  const [expandedQuestion, setExpandedQuestion] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);

  useEffect(() => {
    document.title = 'Help Center | Smarter.Poker';
  }, []);

  const closeFeedbackForm = useCallback(() => setShowFeedbackForm(false), []);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredFAQ = useMemo(
    () =>
      FAQ_ITEMS.filter(
        (item) =>
          !normalizedQuery ||
          item.category.toLowerCase().includes(normalizedQuery) ||
          item.question.toLowerCase().includes(normalizedQuery) ||
          item.answer.toLowerCase().includes(normalizedQuery)
      ),
    [normalizedQuery]
  );

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Player Support Circuit</span>
          <h1>Help Center</h1>
          <p>
            Search Verified Club Arena Guidance, Check The Live Data Circuit, Or Send A Request
            Directly To Support.
          </p>
          <div className={styles.heroActions}>
            <button type="button" onClick={() => setShowFeedbackForm(true)}>
              Send Support Request
            </button>
            <a href="mailto:support@smarter.poker">Email Support</a>
          </div>
        </div>
        <div className={styles.heroArt} aria-hidden="true">
          <img
            src="/hub/club-arena/assets/club-buttons/lobby/lobby-command-chassis-v2.png"
            alt=""
          />
          <span>Support Terminal / Online</span>
        </div>
      </header>

      <section className={styles.statusDeck} aria-label="Live Platform Status">
        <SystemStatus />
      </section>

      <nav className={styles.quickLinks} aria-label="Common Help Destinations">
        {QUICK_LINKS.map((item) => (
          <Link to={item.path} key={item.path}>
            {item.label}
            <span aria-hidden="true">›</span>
          </Link>
        ))}
      </nav>

      <section className={styles.knowledge} aria-labelledby="faq-title">
        <div className={styles.knowledgeHeader}>
          <div>
            <span className={styles.eyebrow}>Knowledge Index</span>
            <h2 id="faq-title">Frequently Asked Questions</h2>
          </div>
          <label className={styles.searchField}>
            <span>Search Help</span>
            <input
              type="search"
              placeholder="Search Clubs, Rewards, Safety..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
        </div>

        <div className={styles.faqList}>
          {filteredFAQ.map((item) => {
            const isExpanded = expandedQuestion === item.question;
            const answerId = `faq-${item.question.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            return (
              <article
                className={`${styles.faqItem} ${isExpanded ? styles.expanded : ''}`}
                key={item.question}
              >
                <button
                  type="button"
                  onClick={() => setExpandedQuestion(isExpanded ? null : item.question)}
                  aria-expanded={isExpanded}
                  aria-controls={answerId}
                >
                  <span className={styles.category}>{item.category}</span>
                  <strong>{item.question}</strong>
                  <span className={styles.toggle} aria-hidden="true">
                    {isExpanded ? '−' : '+'}
                  </span>
                </button>
                {isExpanded && (
                  <div className={styles.answer} id={answerId}>
                    {item.answer}
                  </div>
                )}
              </article>
            );
          })}

          {filteredFAQ.length === 0 && (
            <div className={styles.emptyState} role="status">
              <strong>No Matching Guidance</strong>
              <span>Try A Broader Search Or Send A Support Request.</span>
            </div>
          )}
        </div>
      </section>

      <footer className={styles.footer}>
        <span>Support@Smarter.Poker</span>
        <nav aria-label="Support Policies">
          <Link to="/legal">Legal Center</Link>
          <Link to="/legal/privacy">Privacy</Link>
          <Link to="/legal/tos">Terms</Link>
        </nav>
      </footer>

      <FeedbackForm isOpen={showFeedbackForm} onClose={closeFeedbackForm} />
    </main>
  );
}
