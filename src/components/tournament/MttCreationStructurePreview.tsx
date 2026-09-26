import {
  buildTournamentConfig,
  type TournamentFormInput,
} from '../../lib/tournamentFromTableConfig';
import {
  describeStoredMttStructure,
  mttClockDescription,
} from '../../../server/src/tournament/mttStructureDescription';
import {
  mttPayoutDepthForChoice,
  MTT_PAYOUT_DEPTH_REQUIRED,
} from '../../../server/src/tournament/mttPayoutDepth';
import { compactChips } from '../../utils/format';

/** Preview the same mapped payload Save/Start will send, including the separate
 * clock override. This neither creates a tournament nor changes form values. */
export function MttCreationStructurePreview({
  config,
  gameType,
}: {
  config: TournamentFormInput;
  gameType?: string;
}) {
  if (config.gameMode !== 'mtt') return null;
  if (mttPayoutDepthForChoice(config.payoutStructure) === null) {
    return (
      <div className="config-inline-help" role="alert">
        {MTT_PAYOUT_DEPTH_REQUIRED}
      </div>
    );
  }
  // The preview follows an in-progress form. A half start date, a past time or
  // another temporarily invalid field belongs to the form's own refusal path;
  // it must never crash the entire Create Table page while the owner edits it.
  let proposed;
  try {
    proposed = buildTournamentConfig(config, gameType);
  } catch {
    return null;
  }
  const facts = describeStoredMttStructure(proposed.blindStructure, proposed.startingStack);
  const depth = facts.startingDepthBB;
  const chips = Number(proposed.startingStack);
  const chipLabel = Number.isFinite(chips) && chips > 0 ? compactChips(chips) : 'Unconfirmed';
  return (
    <div className="config-inline-help" aria-label="MTT Structure Preview">
      <strong>MTT Structure Preview</strong>
      <span>
        {facts.speedLabel ?? 'Unconfirmed'} · {mttClockDescription(facts)}
      </span>
      <span>
        {chipLabel} Starting Chips
        {depth !== null &&
          ` · ${depth.toLocaleString(undefined, { maximumFractionDigits: 2 })} Big Blinds`}
      </span>
      <span>Blind Structure Sets How Blinds Grow. Blinds Up Sets The Minutes Per Level.</span>
    </div>
  );
}
