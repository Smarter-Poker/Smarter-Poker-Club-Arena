import { useFitText } from './game-cards/useFitText';
import './LobbyFilterLabel.css';

/** Live copy fits the painted face, independently of the button's hit area. */
export default function LobbyFilterLabel({ children }: { children: string }) {
  const ref = useFitText<HTMLSpanElement>(children, 1, 0.6, { wrapBelow: 0.8, maxLines: 2 });
  return (
    <span className="lobby-filter-label">
      <span ref={ref} className="lobby-filter-label__text">
        {children}
      </span>
    </span>
  );
}
