import { Link, useLocation } from 'react-router-dom';
import {
  getActiveArenaSectionPath,
  getArenaSectionNavigation,
} from '../../config/arenaSectionNavigation';
import { useNotificationsOverlayStore } from '../../stores/useNotificationsOverlayStore';
import styles from './ArenaSectionRail.module.css';

/**
 * Notifications is a popup, not a destination (Dan, 2026-09-02: "IT SHOULD
 * CREATE A 'FULL SCREEN POP UP' SO YOU STAY ON THE PAGE YOU WERE ON"). The
 * rail's Account group links to it, so a plain click here opens the popup over
 * whichever account page the player is reading — the same behaviour as the
 * bell and the hamburger. It stays a real <Link>, so a modified click still
 * opens the route in a new tab.
 */
const NOTIFICATIONS_PATH = '/notifications';

export default function ArenaSectionRail() {
  const location = useLocation();
  const openNotifications = useNotificationsOverlayStore((s) => s.openNotifications);
  const section = getArenaSectionNavigation(location.pathname);

  if (!section) return null;

  const activePath = getActiveArenaSectionPath(location.pathname, section.items);

  return (
    <nav
      className={styles.rail}
      aria-label={`${section.label} Sections`}
      data-arena-section={section.id}
    >
      <div className={styles.chassis}>
        <div className={styles.identity} aria-hidden="true">
          <span className={styles.statusLight} />
          <span>{section.label}</span>
        </div>
        <ul className={styles.items}>
          {section.items.map((item) => {
            const isActive = item.path === activePath;
            return (
              <li key={item.path}>
                <Link
                  className={`${styles.item} ${isActive ? styles.active : ''}`}
                  to={item.path}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={(event) => {
                    if (item.path !== NOTIFICATIONS_PATH) return;
                    if (
                      event.defaultPrevented ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    event.preventDefault();
                    openNotifications('arena-section-rail');
                  }}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
