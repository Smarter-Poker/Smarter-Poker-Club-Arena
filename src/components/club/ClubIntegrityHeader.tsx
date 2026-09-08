import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  getClubIntegrityNavigation,
  type ClubIntegrityPageId,
} from '../../config/clubIntegrityNavigation';
import { useClubNavigationAccess } from '../../hooks/useClubNavigationAccess';
import styles from './ClubIntegrityHeader.module.css';
import { mediaUrl } from '../../utils/mediaBase';

interface IntegrityMetric {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'active' | 'risk';
}

interface ClubIntegrityHeaderProps {
  clubId?: string;
  active: ClubIntegrityPageId;
  eyebrow: string;
  title: string;
  description: string;
  metrics: IntegrityMetric[];
  action?: ReactNode;
}

export default function ClubIntegrityHeader({
  clubId,
  active,
  eyebrow,
  title,
  description,
  metrics,
  action,
}: ClubIntegrityHeaderProps) {
  const access = useClubNavigationAccess(clubId);
  const navigation = clubId ? getClubIntegrityNavigation(clubId, access) : [];

  return (
    <header className={styles.header}>
      <div className={styles.hero}>
        <div className={styles.copy}>
          <div className={styles.signal} aria-hidden="true">
            <span />
            Integrity Circuit Online
          </div>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1>{title}</h1>
          <p className={styles.description}>{description}</p>
        </div>

        <div className={styles.visual} aria-hidden="true">
          <img
            src={mediaUrl('assets/club-buttons/club/club-identity-template-bbj-finish-v1.png')}
            alt=""
          />
          <div className={styles.scanLine} />
        </div>

        <dl className={styles.metrics} aria-label="Current Case Metrics">
          {metrics.map((metric) => (
            <div key={metric.label} data-tone={metric.tone || 'neutral'}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>

        {action && <div className={styles.action}>{action}</div>}
      </div>

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
                    <small>{item.description}</small>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </header>
  );
}
