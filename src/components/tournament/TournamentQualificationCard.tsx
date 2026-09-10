import { useId } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatGameTitle } from '../../utils/formatGameTitle';
import type { SatelliteQualification } from '../../services/satelliteQualification';
import './TournamentRankingCard.css';
import './TournamentQualificationCard.css';

interface Props {
  qualification: SatelliteQualification;
  name?: string;
  onDismiss: () => void;
  onViewTarget: () => void;
}

export default function TournamentQualificationCard({
  qualification,
  name,
  onDismiss,
  onViewTarget,
}: Props) {
  const titleId = useId();
  const focusRef = useFocusTrap<HTMLDivElement>(true);
  const amount = qualification.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const delivery = {
    seat: 'Seat Registered',
    ticket: 'Tournament Ticket Issued',
    cash: 'Cash Credited',
  }[qualification.deliveryKind];

  return createPortal(
    <div className="trc2">
      <div className="trc2__backdrop" aria-hidden="true" />
      <div
        className="trc2__card"
        ref={focusRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="trc2__titlebar">
          <h2 className="trc2__title" id={titleId}>
            Qualified
          </h2>
          <button
            type="button"
            className="trc2__close"
            aria-label="Close Qualification Result"
            onClick={onDismiss}
          >
            ×
          </button>
        </div>
        <div className="trc2__banner">
          <div className="trc2__brand">Smarter.Poker</div>
          <p className="tqc__name">{formatGameTitle(name || 'Satellite')}</p>
        </div>
        <div className="tqc__delivery">
          <h3>{delivery}</h3>
          <dl>
            <dt>Target Entry Value</dt>
            <dd>{amount}</dd>
            {qualification.deliveryKind === 'cash' && (
              <>
                <dt>Player Wallet Credit</dt>
                <dd>{amount}</dd>
              </>
            )}
          </dl>
        </div>
        <div className="trc2__actions">
          <button type="button" className="trc2__btn trc2__btn--primary" onClick={onViewTarget}>
            View Target Tournament
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
