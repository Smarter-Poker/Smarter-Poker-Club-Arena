import { useId, type ReactNode } from 'react';
import { mediaUrl } from '../../utils/mediaBase';
import styles from './RewardsSurfaceHeader.module.css';
import './RewardsCircuitSurfaces.css';
import './PlayCircuitSurfaces.css';
import './UnionCircuitSurfaces.css';

const REWARD_ART = {
  diamonds: 'assets/club-buttons/wallets/desktop/wallet-diamonds-v1.webp',
  vault: 'images/bg-vault.jpg',
  vip: 'images/vip-card-v8.jpg',
  missions: 'images/tiles/daily-challenges-v8.jpg',
  market: 'images/tiles/marketplace-v8.jpg',
} as const;

export interface RewardMetric {
  label: string;
  value: number | string;
  tone?: 'default' | 'live' | 'attention';
}

interface RewardsSurfaceHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  metrics?: RewardMetric[];
  actions?: ReactNode;
  art?: 'diamonds' | 'vault' | 'vip' | 'missions' | 'market';
  artPath?: string;
  status?: string;
}

export default function RewardsSurfaceHeader({
  eyebrow,
  title,
  description,
  metrics = [],
  actions,
  art = 'diamonds',
  artPath,
  status = 'VALUE NETWORK // LIVE',
}: RewardsSurfaceHeaderProps) {
  const titleId = useId();

  return (
    <section className={styles.header} aria-labelledby={titleId}>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1 id={titleId} className={styles.title}>
          {title}
        </h1>
        <p className={styles.description}>{description}</p>

        {(metrics.length > 0 || actions) && (
          <div className={styles.commandRow}>
            {metrics.length > 0 && (
              <dl className={styles.metrics} aria-label={`${title} Live Summary`}>
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
        style={{ backgroundImage: `url("${mediaUrl(artPath || REWARD_ART[art])}")` }}
        aria-hidden="true"
      >
        <div className={styles.conduit} />
        <div className={styles.status}>{status}</div>
      </div>
    </section>
  );
}
