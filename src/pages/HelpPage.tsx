/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HELP PAGE — Club Arena Neon Redesign
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import FeedbackForm from '../components/support/FeedbackForm';
import SystemStatus from '../components/support/SystemStatus';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './HelpPage.module.css';

interface FAQItem {
  question: string;
  answer: string;
}

const FAQ_ITEMS: FAQItem[] = [
  {
    question: 'How do I join a club?',
    answer:
      'Go to the Clubs page, find a club you like, and tap "Join". Some clubs require an invitation code or approval from an admin.',
  },
  {
    question: 'How do I buy chips?',
    answer:
      'Use the Cashier to convert diamonds to chips. Go to your Wallet and tap "Mint Chips" to exchange diamonds at the current rate.',
  },
  {
    question: 'What is the rake structure?',
    answer:
      'Rake is 10% of the pot, up to a cap that depends on the stake - from $3 at the smallest blinds to $20 at the largest. The cap is a cash amount, not a number of big blinds, and it is reduced when a hand is played heads-up or three-handed. No flop, no drop: an uncontested pot is never raked. A small portion of the rake also funds the Bad Beat Jackpot.',
  },
  {
    question: 'How do settlements work?',
    answer:
      'Settlements happen weekly on Monday. Your net profit/loss is calculated, and rakeback is applied based on your agent hierarchy.',
  },
  {
    question: 'How do I become an agent?',
    answer:
      'Contact your club owner to be promoted to an agent role. Agents can recruit players and earn commissions on their rake.',
  },
  {
    question: 'What is the Bad Beat Jackpot?',
    answer:
      'The BBJ is a progressive jackpot for losing a monster hand. In Hold\u2019em, Aces full of Jacks or better must lose to Quads or better, and both of your hole cards must play. In Omaha games, Quad Kings or better must lose. When it hits, the losing hand takes 50%, the winning hand 25%, and everyone else dealt into the hand splits the remaining 25% \u2014 credited straight to your table stack.',
  },
];

export default function HelpPage() {
  useEffect(() => {
    document.title = 'Help | Smarter Poker';
  }, []);

  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);

  const filteredFAQ = FAQ_ITEMS.filter(
    (item) =>
      item.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.answer.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <div className={styles.iconWrap}>{'\u003F'}</div>
          <div>
            <h1>Help Center</h1>
            <span className={styles.subtitle}>Support & Frequently Asked Questions</span>
          </div>
        </div>
      </header>

      {/* System Status */}
      <div className={styles.systemStatusWrapper}>
        <SystemStatus status="operational" />
      </div>

      {/* Support Actions */}
      <div className={styles.supportGrid}>
        <button
          className={styles.supportCard}
          onClick={() => setShowFeedbackForm(true)}
          aria-label="Live Chat with Geeves"
        >
          <div className={styles.supportIcon}>💬</div>
          <h2 className={styles.supportTitle}>Live Chat With Geeves</h2>
          <p className={styles.supportDesc}>Get Instant Help From Our AI Support Agent</p>
        </button>

        <a
          href="mailto:support@clubarena.poker"
          className={styles.supportCard}
          aria-label="Email Support"
        >
          <div className={styles.supportIcon}>✉️</div>
          <h2 className={styles.supportTitle}>Email Support</h2>
          <p className={styles.supportDesc}>Support@Clubarena.Poker</p>
        </a>
      </div>

      {/* Search */}
      <div className={styles.searchSection}>
        <div className={styles.searchInputWrapper}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="SEARCH FOR HELP..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* FAQ Section */}
      <div className={styles.faqSection}>
        <h2 className={styles.sectionTitle}>Frequently Asked Questions</h2>

        <div className={styles.faqList}>
          {filteredFAQ.map((item, index) => {
            const isExpanded = expandedIndex === index;
            return (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: index * 0.05 }}
                className={`${styles.faqItem} ${isExpanded ? styles.faqItemExpanded : ''}`}
              >
                <button
                  className={styles.faqQuestion}
                  onClick={() => setExpandedIndex(isExpanded ? null : index)}
                  aria-expanded={isExpanded}
                >
                  <span>{item.question}</span>
                  <span className={styles.faqToggle}>{isExpanded ? '−' : '+'}</span>
                </button>
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className={styles.faqAnswerWrapper}
                    >
                      <div className={styles.faqAnswer}>{item.answer}</div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}

          {filteredFAQ.length === 0 && (
            <div className={styles.emptyState}>
              <p>NO RESULTS FOUND FOR "{searchQuery.toUpperCase()}"</p>
            </div>
          )}
        </div>
      </div>

      {/* Feedback Form Modal */}
      <FeedbackForm isOpen={showFeedbackForm} onClose={() => setShowFeedbackForm(false)} />
    </div>
  );
}
