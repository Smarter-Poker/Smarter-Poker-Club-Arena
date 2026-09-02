import { useNavigate } from 'react-router-dom';
import styles from './GameCreationActions.module.css';

export type GameCreationTarget = 'table' | 'event' | 'spin' | 'sng';

interface Props {
  managementPath: string;
  compact?: boolean;
  onNavigate?: (path: string) => void;
}

const ACTIONS: Array<{ target: GameCreationTarget; label: string }> = [
  { target: 'table', label: 'Add Table' },
  { target: 'event', label: 'Event' },
  { target: 'spin', label: 'Spins' },
  { target: 'sng', label: 'Sit N Go' },
];

export default function GameCreationActions({
  managementPath,
  compact = false,
  onNavigate,
}: Props) {
  const navigate = useNavigate();
  return (
    <div className={`${styles.actions} ${compact ? styles.compact : ''}`} aria-label="Create Games">
      {ACTIONS.map((action) => (
        <button
          key={action.target}
          type="button"
          onClick={() => (onNavigate || navigate)(`${managementPath}?create=${action.target}`)}
        >
          <span aria-hidden="true">+</span> {action.label}
        </button>
      ))}
    </div>
  );
}
