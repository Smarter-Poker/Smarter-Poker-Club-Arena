import { Link, useLocation } from 'react-router-dom';
import {
  getActiveArenaSectionPath,
  getArenaSectionNavigation,
} from '../../config/arenaSectionNavigation';
import styles from './ArenaSectionRail.module.css';

export default function ArenaSectionRail() {
  const location = useLocation();
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
