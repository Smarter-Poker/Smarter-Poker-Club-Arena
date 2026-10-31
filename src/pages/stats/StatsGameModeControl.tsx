import { useSearchParams } from 'react-router-dom';
import { statsGameMode } from '../../services/statsGameMode';

export default function StatsGameModeControl() {
  const [params, setParams] = useSearchParams();
  const mode = statsGameMode(params.get('gameMode'));
  return (
    <div className="stats-pill-tabs" role="group" aria-label="Statistics Game Mode">
      {(['cash', 'tournament'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={mode === value ? 'active' : ''}
          aria-pressed={mode === value}
          onClick={() =>
            setParams((current) => {
              const next = new URLSearchParams(current);
              next.set('gameMode', value);
              next.delete('tab');
              return next;
            })
          }
        >
          {value === 'cash' ? 'Cash Games' : 'Tournaments'}
        </button>
      ))}
    </div>
  );
}
