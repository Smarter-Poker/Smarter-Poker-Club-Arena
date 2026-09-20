import { useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import styles from './LegalDocumentLayout.module.css';
import { mediaUrl } from '../../utils/mediaBase';
import { resolveSeo } from '../../lib/seo';

export interface LegalDocumentSection {
  id: string;
  title: string;
  content: ReactNode;
}

interface LegalDocumentLayoutProps {
  documentCode: string;
  eyebrow: string;
  title: string;
  summary: string;
  lastUpdated: string;
  sections: LegalDocumentSection[];
}

const DOCUMENTS = [
  { path: '/legal/fair-gaming', label: 'Fair Gaming' },
  { path: '/legal/tos', label: 'Terms Of Service' },
  { path: '/legal/privacy', label: 'Privacy Policy' },
  { path: '/legal/promotions', label: 'Promotion Rules' },
];

export default function LegalDocumentLayout({
  documentCode,
  eyebrow,
  title,
  summary,
  lastUpdated,
  sections,
}: LegalDocumentLayoutProps) {
  const location = useLocation();

  /*
   * AEO phase 3 (2026-09-18): the tab title was built from `title`, which is
   * the visible heading. The head that a crawler reads comes from
   * resolveSeo, and once the public titles were prefixed with the product
   * name the two disagreed, so the title changed the moment the page
   * hydrated. Both now come from resolveSeo, which is the one place that
   * decides what this route is called. The heading stays the bare document
   * name, because on a page already headed "Poker Arena Legal Center" the
   * prefix is noise.
   */
  useEffect(() => {
    const seo = resolveSeo(location.pathname);
    const name = seo.title || title;
    document.title = name.includes('Smarter.Poker') ? name : `${name} | Smarter.Poker`;
  }, [location.pathname, title]);

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
            <Link to="/legal">Legal Center</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{title}</span>
          </nav>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{summary}</p>
          <dl className={styles.metadata}>
            <div>
              <dt>Document</dt>
              <dd>{documentCode}</dd>
            </div>
            <div>
              <dt>Effective</dt>
              <dd>{lastUpdated}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span aria-hidden="true" /> Current
              </dd>
            </div>
          </dl>
        </div>
        <div className={styles.heroArt} aria-hidden="true">
          <img src={mediaUrl('images/bg-vault.jpg')} alt="" />
          <span className={styles.seal}>{documentCode}</span>
        </div>
      </header>

      <div className={styles.documentGrid}>
        <aside className={styles.indexRail}>
          <div className={styles.indexPlate}>
            <span className={styles.indexEyebrow}>Document Index</span>
            <nav aria-label={`${title} Sections`}>
              {sections.map((section, index) => (
                <a href={`#${section.id}`} key={section.id}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  {section.title}
                </a>
              ))}
            </nav>
          </div>
        </aside>

        <article className={styles.document} aria-label={title}>
          {sections.map((section, index) => (
            <section id={section.id} key={section.id} tabIndex={-1}>
              <div className={styles.sectionHeading}>
                <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <h2>{section.title}</h2>
              </div>
              <div className={styles.sectionBody}>{section.content}</div>
            </section>
          ))}

          <footer className={styles.documentFooter}>
            <span>Last Updated: {lastUpdated}</span>
            <a href="mailto:support@smarter.poker">Support@Smarter.Poker</a>
          </footer>
        </article>
      </div>

      <nav className={styles.documentSwitchboard} aria-label="Legal Documents">
        {DOCUMENTS.map((document) => (
          <Link
            to={document.path}
            key={document.path}
            aria-current={location.pathname === document.path ? 'page' : undefined}
          >
            {document.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
