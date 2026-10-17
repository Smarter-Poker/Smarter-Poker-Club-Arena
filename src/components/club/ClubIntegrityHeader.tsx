import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  getClubIntegrityNavigation,
  type ClubIntegrityPageId,
} from '../../config/clubIntegrityNavigation';
import { useClubNavigationAccess } from '../../hooks/useClubNavigationAccess';
import styles from './ClubIntegrityHeader.module.css';
import PageBar from '../help/PageBar';

interface IntegrityMetric {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'active' | 'risk';
}

interface ClubIntegrityHeaderProps {
  compact?: boolean;
  clubId?: string;
  active: ClubIntegrityPageId;
  title: string;
  /** What the page is for. Shown behind the "?" in the top right, never on the page. */
  description: string;
  metrics: IntegrityMetric[];
  action?: ReactNode;
}

const TONE: Record<NonNullable<IntegrityMetric['tone']>, 'default' | 'live' | 'attention'> = {
  neutral: 'default',
  active: 'live',
  risk: 'attention',
};

/**
 * The top of the integrity and casework pages.
 *
 * Dan, 2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL
 * DESCRIPTIONS". The signal line, the eyebrow, the giant title, the paragraph
 * and the artwork are gone. The live case counts, the page action and the
 * casework rail stay; each rail stop is its name alone, and the explanation of
 * the page lives behind the painted "?".
 */
export default function ClubIntegrityHeader({
  compact = false,
  clubId,
  active,
  title,
  description,
  metrics,
  action,
}: ClubIntegrityHeaderProps) {
  const access = useClubNavigationAccess(clubId);
  const navigation = clubId ? getClubIntegrityNavigation(clubId, access) : [];

  return (
    <div className={styles.header} data-compact={compact || undefined}>
      <PageBar
        title={title}
        summary={description}
        metrics={metrics.map((metric) => ({
          label: metric.label,
          value: metric.value,
          tone: TONE[metric.tone || 'neutral'],
        }))}
      >
        {action}
      </PageBar>

      {navigation.length > 0 && (
        <nav className={styles.caseRail} aria-label="Integrity And Casework">
          <ol>
            {navigation.map((item, index) => (
              <li key={item.id}>
                <Link
                  to={item.path}
                  aria-current={item.id === active ? 'page' : undefined}
                  data-active={item.id === active ? 'true' : undefined}
                >
                  <span className={styles.sequence}>{String(index + 1).padStart(2, '0')}</span>
                  <span>
                    <strong>{item.label}</strong>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </div>
  );
}
