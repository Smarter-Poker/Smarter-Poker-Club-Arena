import './LobbyGameSections.css';
import { useFitText } from './game-cards/useFitText';

export type LobbyGameSection = 'cash' | 'tournaments';

function SectionButton({
  section,
  label,
  expanded,
  onToggle,
}: {
  section: LobbyGameSection;
  label: string;
  expanded: boolean;
  onToggle: (section: LobbyGameSection) => void;
}) {
  const textRef = useFitText<HTMLSpanElement>(label);
  return (
    <button
      type="button"
      className="lobby-game-sections__button"
      aria-expanded={expanded}
      aria-controls="lobby-game-section-controls"
      onClick={() => onToggle(section)}
    >
      <span ref={textRef}>{label}</span>
    </button>
  );
}

export default function LobbyGameSections({
  selected,
  onToggle,
}: {
  selected: LobbyGameSection | null;
  onToggle: (section: LobbyGameSection) => void;
}) {
  return (
    <div className="lobby-game-sections" aria-label="Choose Your Games">
      <SectionButton
        section="cash"
        label="Cash Games"
        expanded={selected === 'cash'}
        onToggle={onToggle}
      />
      <SectionButton
        section="tournaments"
        label="Tournaments"
        expanded={selected === 'tournaments'}
        onToggle={onToggle}
      />
    </div>
  );
}
