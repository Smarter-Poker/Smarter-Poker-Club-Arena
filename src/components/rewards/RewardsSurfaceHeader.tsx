import { useId, type ReactNode } from 'react';
import { mediaUrl } from '../../utils/mediaBase';
import { formatPopupText } from '../../utils/popupStyle';
import styles from './RewardsSurfaceHeader.module.css';
import '../club-buttons/console-kit.css';
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

const TONE_CLASS: Record<NonNullable<RewardMetric['tone']>, string> = {
  default: '',
  live: 'ck-plaque--live',
  attention: 'ck-plaque--attention',
};

/**
 * The Rewards Circuit header, cut from the Club Arena console (Dan 2026-09-09:
 * "upgrade these using #ClubArenaConsole, these pages are still generic").
 * The chassis is the lobby's chrome-railed plaque, the art sits in the
 * lobby's picture frame, and every metric is printed on the card's bay.
 */
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
    <section className={`ck ${styles.header}`} aria-labelledby={titleId}>
      <div className={`ck-frame ${styles.frame}`}>
        <div className={styles.copy}>
          <p className={`ck-h ${styles.eyebrow}`}>{formatPopupText(eyebrow)}</p>
          <h1 id={titleId} className={`ck-title ${styles.title}`}>
            {formatPopupText(title)}
          </h1>
          <p className={`ck-copy ${styles.description}`}>{formatPopupText(description)}</p>

          {(metrics.length > 0 || actions) && (
            <div className={styles.commandRow}>
              {metrics.length > 0 && (
                <dl className={styles.metrics} aria-label={`${title} Live Summary`}>
                  {metrics.map((metric) => (
                    <div
                      className={`ck-plaque ${TONE_CLASS[metric.tone || 'default']} ${styles.metric}`}
                      key={metric.label}
                    >
                      <dt className="ck-plaque__label">{formatPopupText(metric.label)}</dt>
                      <dd className="ck-plaque__well">
                        <span className="ck-plaque__value">{metric.value}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {actions && <div className={styles.actions}>{actions}</div>}
            </div>
          )}
        </div>

        <div
          className={`ck-frame ck-frame--art ${styles.visual}`}
          style={{ backgroundImage: `url("${mediaUrl(artPath || REWARD_ART[art])}")` }}
          aria-hidden="true"
        >
          <div className={styles.status}>{formatPopupText(status)}</div>
        </div>
      </div>
    </section>
  );
}
