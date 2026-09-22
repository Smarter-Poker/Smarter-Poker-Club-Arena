import { useNavigate } from 'react-router-dom';
import { WheelWinReveal } from '../wheel/WheelWinReveal';

/** A confirmed receipt is displayed here only after its game has finished revealing. */
export default function BonusCompletion({
  clubId,
  chips,
  detail,
  eyebrow,
}: {
  clubId: string;
  chips: number;
  detail: string;
  /** What this receipt is, when the round was not won. */
  eyebrow?: string;
}) {
  const navigate = useNavigate();
  return (
    <WheelWinReveal
      eyebrow={eyebrow}
      prize={{ kind: 'chips' }}
      title={`${chips.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Chips`}
      detail={`${chips > 0 ? 'Your Prize Is Booked.' : 'No Chips Won This Round.'} ${detail} Returning To Diamond Spins.`}
      autoContinue
      autoContinueAfterMs={5000}
      onOpen={() => navigate(`/clubs/${clubId}/wheel`, { replace: true })}
    />
  );
}
