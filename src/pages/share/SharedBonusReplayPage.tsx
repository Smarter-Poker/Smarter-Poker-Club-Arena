import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DiamondReplayService, type BonusReplay } from '../../services/DiamondReplayService';
import { reportError } from '../../utils/errorReporter';
import BonusReplayPlayer from '../../components/games/BonusReplayPlayer';
import styles from '../../components/games/BonusReplay.module.css';

export default function SharedBonusReplayPage() {
  const { shareId } = useParams<{ shareId: string }>();
  const [replay, setReplay] = useState<BonusReplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setReplay(null);
    setError(null);
    DiamondReplayService.read(shareId ?? '', true)
      .then((value) => {
        if (active) setReplay(value);
      })
      .catch((e) => {
        reportError(e, 'SharedBonusReplayPage');
        if (active) setError(e instanceof Error ? e.message : 'Replay Could Not Be Loaded');
      });
    return () => {
      active = false;
    };
  }, [shareId, attempt]);
  return (
    <main className={styles.page}>
      <div>
        <Link to="/" className={styles.action}>
          Smarter.Poker Club Arena
        </Link>
        {replay ? (
          <BonusReplayPlayer key={shareId} replay={replay} />
        ) : error ? (
          <p role="alert">
            {error}
            <button
              className={styles.action}
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try Again
            </button>
          </p>
        ) : (
          <p role="status">Loading Bonus Replay</p>
        )}
      </div>
    </main>
  );
}
