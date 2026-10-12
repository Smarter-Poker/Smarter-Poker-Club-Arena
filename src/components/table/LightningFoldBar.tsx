/**
 * LIGHTNING PHASE 6: LIGHTNING FOLD, and FOLD & WATCH where the platform
 * offers it.
 *
 * Mounted only in a Lightning room, and always mounted there while the hero is
 * in the pool: the strip holds its place between hands and only its words
 * light up or dim, so nothing on the felt moves when one hand gives way to the
 * next. The words are live whenever folding is (on the hero's turn and before
 * it); what each word may do is decided by `lightningFoldAvailability`, and
 * whether FOLD & WATCH exists at all by the platform's capability row.
 */
import { memo } from 'react';
import {
  LIGHTNING_FOLD_LABEL,
  LIGHTNING_FOLD_WATCH_LABEL,
  type LightningFoldAvailability,
} from '../../lightning/lightningHand';
import type { LightningFoldKind } from '../../lightning/lightningActions';
import './LightningFoldBar.css';

export interface LightningFoldBarProps {
  availability: LightningFoldAvailability;
  /** The platform offers FOLD & WATCH at all (capability row). */
  offerFoldWatch: boolean;
  /**
   * LIGHTNING PHASE 8: the player last chose FOLD & WATCH (remembered on this
   * device). Marks that word as their usual one; both stay offered.
   */
  preferFoldWatch?: boolean;
  busy?: boolean;
  onFold: (kind: LightningFoldKind) => void;
}

function LightningFoldBar({
  availability,
  offerFoldWatch,
  preferFoldWatch = false,
  busy = false,
  onFold,
}: LightningFoldBarProps) {
  const live = availability.fastFold || availability.foldWatch;
  return (
    <div
      className="lightning-fold-bar"
      data-testid="lightning-fold-bar"
      data-live={live ? 'true' : 'false'}
      role="group"
      aria-label="Lightning"
    >
      <button
        type="button"
        className="lightning-fold-bar__btn"
        data-testid="lightning-fold"
        disabled={!availability.fastFold || busy}
        aria-hidden={!availability.fastFold}
        tabIndex={availability.fastFold ? 0 : -1}
        onClick={() => onFold('fast_fold')}
      >
        {LIGHTNING_FOLD_LABEL}
      </button>
      {offerFoldWatch ? (
        <button
          type="button"
          className="lightning-fold-bar__btn lightning-fold-bar__btn--quiet"
          data-testid="lightning-fold-watch"
          data-preferred={preferFoldWatch ? 'true' : undefined}
          disabled={!availability.foldWatch || busy}
          aria-hidden={!availability.foldWatch}
          tabIndex={availability.foldWatch ? 0 : -1}
          onClick={() => onFold('fold_watch')}
        >
          {LIGHTNING_FOLD_WATCH_LABEL}
        </button>
      ) : null}
    </div>
  );
}

export default memo(LightningFoldBar);
