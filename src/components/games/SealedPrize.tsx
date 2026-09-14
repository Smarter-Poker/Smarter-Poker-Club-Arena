import { useEffect, useState } from 'react';
import { sealedChipPrize } from '../../utils/sealedChipPrize';
import { gameChips } from '../../utils/bonusGameBudget';
import { reportError } from '../../utils/errorReporter';

export default function SealedPrize(props: Parameters<typeof sealedChipPrize>[0]) {
  const [prize, setPrize] = useState<number | null>(null);
  const { serverSeed, clientSeed, nonce, betChips, multiplierCents, roundingStep } = props;
  useEffect(() => {
    let cancelled = false;
    setPrize(null);
    sealedChipPrize({ serverSeed, clientSeed, nonce, betChips, multiplierCents, roundingStep })
      .then((value) => {
        if (!cancelled) setPrize(value);
      })
      .catch((e) => reportError(e, 'SealedPrize.check'));
    return () => {
      cancelled = true;
    };
  }, [serverSeed, clientSeed, nonce, betChips, multiplierCents, roundingStep]);
  return (
    <span>
      {prize === null
        ? 'Checking The Sealed Chip Prize.'
        : `Highest Possible Book: ${gameChips(prize)} Chips.`}
    </span>
  );
}
