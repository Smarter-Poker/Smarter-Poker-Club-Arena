import { useFitText } from '../lobby/game-cards/useFitText';
import styles from '../../pages/CashierTradePage.module.css';

/** Keep the exact balance inside the painted face at every viewport width. */
export function CashierFrameBalance({ text }: { text: string }) {
  const ref = useFitText<HTMLElement>(text, 1, 0.1);
  return (
    <span className={styles.frameBalance}>
      <strong ref={ref}>{text}</strong>
    </span>
  );
}
