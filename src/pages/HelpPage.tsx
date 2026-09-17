import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import FeedbackForm from '../components/support/FeedbackForm';
import SystemStatus from '../components/support/SystemStatus';
import styles from './HelpPage.module.css';
import { mediaUrl } from '../utils/mediaBase';
import { FAQ_ITEMS, QUICK_LINKS } from './helpContent';

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
          {/* Discoverability phase 5 (2026-09-17): the 462 KB palette PNG was a
              third of the Help Center's bytes on a phone; the WebP is 49 KB of the
              same pixels, and the PNG stays the fallback for a browser without it. */}
          <picture>
            <source
              type="image/webp"
              srcSet={mediaUrl('assets/club-buttons/lobby/lobby-command-chassis-v2.webp')}
            />
            <img
              src={mediaUrl('assets/club-buttons/lobby/lobby-command-chassis-v2.png')}
              alt=""
              width="960"
              height="1280"
              decoding="async"
            />
          </picture>
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
                {/* AEO PHASE 1 (2026-09-17): the answer is always in the DOM and
                    hidden when collapsed, instead of not rendered at all. A
                    crawler that renders the page, and a screen reader, now
                    get every answer; the toggle behaves as it did. */}
                <div className={styles.answer} id={answerId} hidden={!isExpanded}>
                  {item.answer}
                </div>
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
