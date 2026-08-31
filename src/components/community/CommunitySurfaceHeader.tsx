import type { ReactNode } from 'react';
import { mediaUrl } from '../../utils/mediaBase';
import styles from './CommunitySurfaceHeader.module.css';

export interface CommunityMetric {
  label: string;
  value: number | string;
  tone?: 'default' | 'live' | 'attention';
}

interface CommunitySurfaceHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  metrics?: CommunityMetric[];
  actions?: ReactNode;
}

export default function CommunitySurfaceHeader({
  eyebrow,
  title,
  description,
  metrics = [],
  actions,
}: CommunitySurfaceHeaderProps) {
  return (
    <section className={styles.header} aria-labelledby="community-surface-title">
      <div className={styles.copy}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1 id="community-surface-title" className={styles.title}>
          {title}
        </h1>
        <p className={styles.description}>{description}</p>

        {(metrics.length > 0 || actions) && (
          <div className={styles.commandRow}>
            {metrics.length > 0 && (
              <dl className={styles.metrics} aria-label={`${title} Summary`}>
                {metrics.map((metric) => (
                  <div
                    className={`${styles.metric} ${styles[metric.tone || 'default']}`}
                    key={metric.label}
                  >
                    <dt>{metric.label}</dt>
                    <dd>{metric.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions && <div className={styles.actions}>{actions}</div>}
          </div>
        )}
      </div>

      <div
        className={styles.visual}
        style={{
          backgroundImage: `linear-gradient(90deg, #030609 0%, rgba(3, 6, 9, 0.1) 48%), url("${mediaUrl('images/community/community-network-v1.webp')}")`,
        }}
        aria-hidden="true"
      >
        <div className={styles.scanLine} />
        <div className={styles.visualLabel}>COMMUNITY NETWORK // LIVE</div>
      </div>
    </section>
  );
}
