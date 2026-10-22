import {
  MTT_PAYOUT_DEPTH_CHOICES,
  mttPayoutDepthForChoice,
} from '../../../server/src/tournament/mttPayoutDepth';

/**
 * Dan, 2026-10-21: every MTT pays the top 12.5% of the field by default, and a
 * standalone club may set any depth. Every supported depth is offered; the
 * database forces 12.5 for union and Diamond Arena events whatever is chosen.
 * (This supersedes the 2026-09-20 10-15% ceiling for new events.)
 */
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
