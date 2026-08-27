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
    question: 'How Do I Create An Account?',
    answer:
      'Click "Sign Up" On The Homepage And Enter Your Email, Username, And Password. You\'ll Receive A Verification Email To Activate Your Account.',
  },
  {
    question: 'How Do I Join A Club?',
    answer:
      'Go To The Clubs Page, Find A Club You Like, And Tap "Join". Some Clubs Require An Invitation Code Or Approval From An Admin.',
  },
  {
    question: 'How Do I Customize My Profile?',
    answer:
      'Go To Settings → Account, Then Click "Edit Profile". You Can Update Your Avatar, Bio, And Display Preferences.',
  },
  {
    question: 'What Is The Diamond Economy?',
    answer:
      'Diamonds Are The Premium Currency On Smarter.Poker. Earn Them Through Gameplay And Achievements.',
  },
  {
    question: 'How Do I Add Friends?',
    answer:
      "Visit The Friends Page, Search For Users By Username, And Send A Friend Request. They'll Receive A Notification To Accept.",
  },
  {
    question: 'How Do I Send Messages?',
    answer:
      'Open Messenger From The Sidebar Menu, Select A Contact, And Start Chatting. You Can Also Send Images And Videos.',
  },
  {
    question: 'Can I Go Live?',
    answer:
      'Yes! Click The "Go Live" Button On The Social Feed To Start Broadcasting. You Can Stream Poker Gameplay, Tutorials, Or Just Chat With The Community.',
  },
  {
    question: 'What Is GTO Training?',
    answer:
      'Game Theory Optimal (GTO) Training Helps You Learn Mathematically Sound Poker Strategies Through Interactive Scenarios And AI-Powered Feedback.',
  },
  {
    question: 'What Is Fantasyland In OFC?',
    answer:
      'In Open Face Chinese Pineapple, Getting QQ+ In Your Front Row Qualifies You For Fantasyland, Where You Get All 14 Cards Dealt At Once.',
  },
  {
    question: 'How Do I Join A Tournament?',
    answer:
      'Visit The Tournaments Page, Browse Available Events, And Click "Register" On Any Tournament You Want To Join.',
  },
  {
    question: 'What Is The Diamond Arena?',
    answer:
      'The Diamond Arena Is Our Competitive Poker Room Where You Can Play Cash Games And Tournaments With Other Players For Diamonds And XP.',
  },
  {
    question: 'How Do I Become An Agent?',
    answer:
      'Contact Your Club Owner To Be Promoted To An Agent Role. Agents Can Recruit Players And Build Their Own Communities.',
  },
  {
    question: 'What Is The Bad Beat Jackpot?',
    answer:
      'The BBJ Is A Progressive Jackpot That Triggers When A Strong Hand (Like Quad Eights Or Better) Loses. The Pot Is Split Among The Table.',
  },
  {
    question: 'How Do I Change My Password?',
    answer:
      'Go To Settings → Account → Account Security, Then Click "Change Password". You\'ll Receive A Password Reset Email.',
  },
  {
    question: 'Is Two-Factor Authentication Available?',
    answer:
      'Two-Factor Authentication (2FA) Is Coming Soon! This Will Add An Extra Layer Of Security To Your Account.',
  },
  {
    question: 'How Do I Delete My Account?',
    answer:
      'Go To Settings → Data Export → Danger Zone. Please Note That Account Deletion Is Permanent And Cannot Be Undone.',
  },
  {
    question: 'How Do I Report A Problem?',
    answer: 'Use The Support Chat Below To Contact Our Team, Or Email Support@ClubArena.Poker.',
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
          <div className={styles.supportIcon} aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="28"
              height="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          </div>
          <h2 className={styles.supportTitle}>Live Chat With Geeves</h2>
          <p className={styles.supportDesc}>Get Instant Help From Our AI Support Agent</p>
        </button>

        <a
          href="mailto:support@clubarena.poker"
          className={styles.supportCard}
          aria-label="Email Support"
        >
          <div className={styles.supportIcon} aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="28"
              height="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 6-10 7L2 6" />
            </svg>
          </div>
          <h2 className={styles.supportTitle}>Email Support</h2>
          <p className={styles.supportDesc}>Support@Clubarena.Poker</p>
        </a>
      </div>

      {/* Search */}
      <div className={styles.searchSection}>
        <div className={styles.searchInputWrapper}>
          <span className={styles.searchIcon} aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
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
