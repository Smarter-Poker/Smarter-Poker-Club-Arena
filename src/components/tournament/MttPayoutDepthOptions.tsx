import {
  MTT_PAYOUT_DEPTH_CHOICES,
  mttPayoutDepthForChoice,
} from '../../../server/src/tournament/mttPayoutDepth';

/** Keep an unsupported restored selection visible until the owner changes it. */
export function MttPayoutDepthOptions({ currentChoice }: { currentChoice: string }) {
  return (
    <>
      {mttPayoutDepthForChoice(currentChoice) === null && (
        <option value={currentChoice} disabled>
          {currentChoice === 'payout2'
            ? '12.5% Is Not Supported For MTTs: Choose A Depth'
            : 'Choose A Supported MTT Payout Depth'}
        </option>
      )}
      {MTT_PAYOUT_DEPTH_CHOICES.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </>
  );
}
