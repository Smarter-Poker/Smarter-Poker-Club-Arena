import { NavLink } from 'react-router-dom';
import styles from '../../pages/diamondGames.module.css';
export default function DiamondSpinsTabs({ clubId }: { clubId: string }) {
  return (
    <nav className={styles.spinsTabs} aria-label="Diamond Spins">
      <NavLink className={styles.back} to={`/clubs/${clubId}/wheel`}>
        Spin Wheel
      </NavLink>
      <NavLink className={styles.back} to={`/clubs/${clubId}/diamond-games`}>
        Bonus Games
      </NavLink>
      <NavLink className={styles.back} to={`/clubs/${clubId}/earn-diamonds`}>
        Earn Diamonds
      </NavLink>
    </nav>
  );
}
