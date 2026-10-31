import {
  MTT_PAYOUT_DEPTH_CHOICES,
  mttPayoutDepthForChoice,
} from '../../../server/src/tournament/mttPayoutDepth';

/** Owner October 29: every new MTT pays the top 15% of its final field. */
function mttPayoutDepthChoicesFor() {
  return MTT_PAYOUT_DEPTH_CHOICES;
}

/** Keep an unsupported restored selection visible until the owner changes it. */
export function MttPayoutDepthOptions({
  currentChoice,
}: {
  currentChoice: string;
  /** The depth this event was saved with, when it was loaded from a saved one. */
  savedChoice?: string;
}) {
  return (
    <>
      {mttPayoutDepthForChoice(currentChoice) === null && (
        <option value={currentChoice} disabled>
          Choose A Supported MTT Payout Depth
        </option>
      )}
      {mttPayoutDepthChoicesFor().map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </>
  );
}
