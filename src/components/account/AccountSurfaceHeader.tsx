import type { ReactNode } from 'react';
import { mediaUrl } from '../../utils/mediaBase';
import styles from './AccountSurfaceHeader.module.css';

interface AccountSurfaceHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  status?: string;
  children?: ReactNode;
  /**
   * Route-specific hero art, as a path under public/ (e.g.
   * 'images/account/control-room-hero-v1.webp'). Falls back to the shared
   * vault plate so a surface without its own art still has an anchor.
   */
  artwork?: string;
}

/**
 * Shared visual anchor for the retained player-account surfaces.
 *
 * The image is existing Club Arena vault artwork; the live state below it is
 * supplied by each page. This component deliberately owns presentation only.
 */
export default function AccountSurfaceHeader({
  eyebrow,
  title,
  description,
  status,
  children,
  artwork,
}: AccountSurfaceHeaderProps) {
  const artUrl = artwork ? mediaUrl(artwork) : mediaUrl('images/bg-vault.jpg');
  return (
    <header className={styles.hero}>
      <div
        className={styles.image}
        style={{ backgroundImage: `url("${artUrl}")` }}
        aria-hidden="true"
      />
      <div className={styles.scanline} aria-hidden="true" />
      <div className={styles.content}>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {status && (
          <span className={styles.status} role="status">
            <span aria-hidden="true" />
            {status}
          </span>
        )}
      </div>
      {children && <div className={styles.metrics}>{children}</div>}
    </header>
  );
}
