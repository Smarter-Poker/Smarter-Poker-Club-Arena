import { useFitText } from '../lobby/game-cards/useFitText';

/** Whole Diamond money stays inside the approved plaque's blank readout bay. */
export function DiamondJackpotReadout({ amount }: { amount: number }) {
  const number = amount.toLocaleString('en-US');
  const numberRef = useFitText<HTMLSpanElement>(number, 1, 0.1);
  return (
    <strong className="lobby-bbj__amount lobby-bbj__amount--diamonds">
      <span className="lobby-bbj__number" ref={numberRef}>
        {number}
      </span>{' '}
      <span className="lobby-bbj__unit">Diamonds</span>
    </strong>
  );
}
