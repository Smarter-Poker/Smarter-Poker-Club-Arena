import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import PlayerNotesPanel from './PlayerNotesPanel';
import styles from './PlayerNotesPanel.module.css';

export function PlayerNotesDialog({
  targetUserId,
  targetName,
  onClose,
}: {
  targetUserId?: string;
  targetName?: string;
  onClose: () => void;
}) {
  const ref = useFocusTrap<HTMLDivElement>(true);
  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={ref}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Player Notes"
        onClick={(event) => event.stopPropagation()}
      >
        <PlayerNotesPanel targetUserId={targetUserId} targetName={targetName} onClose={onClose} />
      </div>
    </div>,
    document.body
  );
}
