/**
 * The Legal Center as static HTML (GSC fix, 2026-09-22).
 *
 * LegalWorkspacePage renders these words inside WorkspacePage, which reads
 * the club workspace context, and its module (pages/workspaces/
 * ArenaWorkspacePages) creates the Supabase client at import time. Neither
 * exists for a reader that never runs the bundle, so the prerender prints the
 * same hero and the same document cards with the same classes from
 * ArenaWorkspacePages.module.css, so it looks like the page it stands in for.
 * The copy comes from src/pages/legalCenterContent.ts: one source, two
 * renderers. Legal paths carry no club, so the links need no club context.
 */
import { Link } from 'react-router-dom';
import styles from '../pages/workspaces/ArenaWorkspacePages.module.css';
import { LEGAL_CENTER, LEGAL_CENTER_ENTRIES } from '../pages/legalCenterContent';
import { mediaUrl } from '../utils/mediaBase';

export default function LegalPrerender() {
  return (
    <section className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>{LEGAL_CENTER.eyebrow}</span>
          <h1>{LEGAL_CENTER.title}</h1>
          <p>{LEGAL_CENTER.description}</p>
        </div>
        <div className={styles.artFrame} aria-hidden="true">
          <img src={mediaUrl(LEGAL_CENTER.art)} alt="" />
        </div>
      </header>

      <section className={styles.grid} aria-label={`${LEGAL_CENTER.title} Tools`}>
        {LEGAL_CENTER_ENTRIES.map((item, index) => (
          <Link to={item.path} className={styles.card} key={item.path}>
            <span className={styles.index}>{String(index + 1).padStart(2, '0')}</span>
            <span className={styles.cardCopy}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
              <span className={styles.summary}>{item.summary}</span>
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
