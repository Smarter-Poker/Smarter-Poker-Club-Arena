import {
  MTT_PAYOUT_DEPTH_CHOICES,
  mttPayoutDepthForChoice,
} from '../../../server/src/tournament/mttPayoutDepth';

/**
 * Owner requirement (2026-09-20): a new MTT pays 10 to 15 percent of the final
 * field. The engine still supports a 20 percent depth, and events saved with it
 * exist, so the catalogue in server/src/tournament/mttPayoutDepth.ts is left
 * exactly as it is and the limit is applied here, where a NEW choice is made.
 */
const NEW_MTT_MAX_PAYOUT_PERCENT = 15;

/**
 * The depths this form offers. A depth above the new-event ceiling is offered
 * only when it is this event's own saved value (`currentChoice`, or
 * `savedChoice` for a loaded template the owner has since moved away from), so
 * a saved 20 percent event is never silently changed and can be put back.
 */
function mttPayoutDepthChoicesFor(currentChoice: string, savedChoice?: string) {
  return MTT_PAYOUT_DEPTH_CHOICES.filter(
    (choice) =>
      choice.percent <= NEW_MTT_MAX_PAYOUT_PERCENT ||
      choice.value === currentChoice ||
      choice.value === savedChoice
  );
}

/** Keep an unsupported restored selection visible until the owner changes it. */
export function MttPayoutDepthOptions({
  currentChoice,
  savedChoice,
}: {
  currentChoice: string;
  /** The depth this event was saved with, when it was loaded from a saved one. */
  savedChoice?: string;
}) {
  return (
    <>
      {mttPayoutDepthForChoice(currentChoice) === null && (
        <option value={currentChoice} disabled>
          {currentChoice === 'payout2'
            ? '12.5% Is Not Supported For MTTs: Choose A Depth'
            : 'Choose A Supported MTT Payout Depth'}
        </option>
      )}
      {mttPayoutDepthChoicesFor(currentChoice, savedChoice).map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </>
  );
}
