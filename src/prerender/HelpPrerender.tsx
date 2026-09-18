/**
 * The Help Center as static HTML (AEO phase 1, 2026-09-17).
 *
 * HelpPage renders the same words with search, a collapse toggle, the live
 * status deck and the support form, which need React state and the app's
 * providers (toast, auth, Supabase). None of that exists for a reader that
 * never runs the bundle, so the prerender renders the questions and answers
 * themselves, every answer open, with the same classes from
 * HelpPage.module.css so it looks like the page it stands in for. The copy
 * comes from src/pages/helpContent.ts: one source, two renderers.
 */
import { Link } from 'react-router-dom';
import styles from '../pages/HelpPage.module.css';
import { FAQ_ITEMS, QUICK_LINKS } from '../pages/helpContent';
import { mediaUrl } from '../utils/mediaBase';

export default function HelpPrerender() {
  return (
    <article className={styles.page} aria-labelledby="help-title">
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Player Support Circuit</span>
          <h1 id="help-title">Help Center</h1>
          <p>
            Search Verified Poker Arena Guidance, Check The Live Data Circuit, Or Send A Request
            Directly To Support.
          </p>
          <div className={styles.heroActions}>
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
        </div>

        <div className={styles.faqList}>
          {FAQ_ITEMS.map((item) => {
            const answerId = `faq-${item.question.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            return (
              <article className={`${styles.faqItem} ${styles.expanded}`} key={item.question}>
                <h3>
                  <span className={styles.category}>{item.category}</span>
                  <strong>{item.question}</strong>
                </h3>
                <div className={styles.answer} id={answerId}>
                  {item.answer}
                </div>
              </article>
            );
          })}
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
    </article>
  );
}
