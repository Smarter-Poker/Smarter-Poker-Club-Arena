import { useNavigate } from 'react-router-dom';
import styles from './GameCreationActions.module.css';

export type GameCreationTarget = 'table' | 'event' | 'spin' | 'sng';

interface Props {
  managementPath: string;
  compact?: boolean;
  onNavigate?: (path: string) => void;
  /**
   * ONE BUTTON, BELONGING TO THE FIELD IT SITS ON (Dan 2026-09-02).
   *
   * "THE ADD TABLE BUTTONS SHOULD NEVER DISPLAY ON THE ALL FIELD AND THERE
   * SHOULD ONLY BE ONE BUTTON, AND THEY SHOULD BE INDEPENDENT TO THE FIELD."
   *
   * The club lobby shows this row directly above a game-type tab strip, so
   * four buttons offered three creations that had nothing to do with what the
   * player was looking at. Passing a target renders that one button; passing
   * `null` renders none, which is what the ALL tab wants.
   *
   * OPTIONAL on purpose. The union and management screens that also use this
   * component have no tab strip to be independent of - there is no current
   * field there for a button to belong to - so the full set remains right for
   * them and they are unchanged.
   */
  only?: GameCreationTarget | null;
  /**
   * Hide the row below 900px. Dan 2026-09-02: "THIS SHOULDN'T BE DISPLAYED ON
   * MOBILE, THIS IS DESK TOP ONLY BUTTONS REMOVE THEM FROM MOBILE."
   *
   * Opt-in rather than a blanket rule on the row, because the union and
   * game-management screens render this component as their ONLY route to
   * creating a game. Hiding it everywhere would strip a feature from a phone
   * rather than tidy a lobby. The club lobby is the caller that asks.
   */
  desktopOnly?: boolean;
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
  only,
  desktopOnly = false,
}: Props) {
  const navigate = useNavigate();
  const shown = only === undefined ? ACTIONS : ACTIONS.filter((action) => action.target === only);
  if (shown.length === 0) return null;

  return (
    <div
      /* Joined rather than interpolated: two false ternaries left a trailing
         double space in the class attribute on every non-compact render. */
      className={[styles.actions, compact && styles.compact, desktopOnly && styles.desktopOnly]
        .filter(Boolean)
        .join(' ')}
      aria-label="Create Games"
    >
      {shown.map((action) => (
        <button
          key={action.target}
          type="button"
          onClick={() => (onNavigate || navigate)(`${managementPath}?create=${action.target}`)}
        >
          <span aria-hidden="true">+</span>
          <strong>{action.label}</strong>
        </button>
      ))}
    </div>
  );
}
