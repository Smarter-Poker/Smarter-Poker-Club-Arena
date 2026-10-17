/**
 * The Legal Center as static HTML (GSC fix, 2026-09-22).
 *
 * LegalWorkspacePage renders these words inside WorkspacePage, which reads
 * the club workspace context, and its module (pages/workspaces/
 * ArenaWorkspacePages) creates the Supabase client at import time. Neither
 * exists for a reader that never runs the bundle, so the prerender prints the
 * same page bar and the same document cards with the same classes from
 * ArenaWorkspacePages.module.css, so it looks like the page it stands in for.
 * The copy comes from src/pages/legalCenterContent.ts: one source, two
 * renderers. Legal paths carry no club, so the links need no club context.
 */
import { Link } from 'react-router-dom';
import styles from '../pages/workspaces/ArenaWorkspacePages.module.css';
import { LEGAL_CENTER, LEGAL_CENTER_ENTRIES } from '../pages/legalCenterContent';
import PageBar from '../components/help/PageBar';

export default function LegalPrerender() {
  return (
    <section className={styles.page}>
      <PageBar title={LEGAL_CENTER.title} summary={LEGAL_CENTER.description} />

      <section className={styles.grid} aria-label={`${LEGAL_CENTER.title} Tools`}>
        {LEGAL_CENTER_ENTRIES.map((item, index) => (
          <Link to={item.path} className={styles.card} key={item.path}>
            <span className={styles.index}>{String(index + 1).padStart(2, '0')}</span>
            <span className={styles.cardCopy}>
              <strong>{item.label}</strong>
              {/* The static page is the crawler's index of the documents, so
                  each one carries the sentence on what it covers. The app
                  page puts these words behind its "?" (Dan 2026-10-17); a
                  reader without the app, and a search engine, still needs
                  them here, and the prerender gate refuses a near-empty
                  indexable page (scripts/prerender-public-routes.mjs). */}
              <span>{item.summary}</span>
            </span>
            <span className={styles.arrow} aria-hidden="true">
              ›
            </span>
          </Link>
        ))}
      </section>
    </section>
  );
}
