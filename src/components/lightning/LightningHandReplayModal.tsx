/**
 * LIGHTNING PHASE 8: a Lightning hand, opened in the EXISTING replay.
 *
 * The replay is the one every hand in the app opens in (HandReplay, the
 * Hand Archive's and the table's). It reads the hand_histories row by id and
 * is read-only: it shows the cards the player was entitled to see, nothing
 * more, because it is the same component with the same rules.
 */
import { Suspense } from 'react';
import { createPortal } from 'react-dom';
import { lazyWithRetry } from '../../utils/lazyWithRetry';
import LightningCloseX from './LightningCloseX';
import './LightningSession.css';

const HandReplay = lazyWithRetry(() => import('../replay/HandReplay'));

export default function LightningHandReplayModal({
  handHistoryId,
  onClose,
}: {
  handHistoryId: string;
  onClose: () => void;
}) {
  const body = (
    <div
      className="lightning-sheet__overlay lightning-sheet__overlay--replay"
      data-testid="lightning-replay"
      onClick={onClose}
    >
      <div
        className="lightning-sheet lightning-sheet--replay"
        role="dialog"
        aria-modal="true"
        aria-label="Hand Replay"
        onClick={(e) => e.stopPropagation()}
      >
        <LightningCloseX onClick={onClose} testId="lightning-replay-close" />
        <Suspense fallback={<p className="lightning-sheet__quiet">One Moment...</p>}>
          <HandReplay handId={handHistoryId} onClose={onClose} />
        </Suspense>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
}
