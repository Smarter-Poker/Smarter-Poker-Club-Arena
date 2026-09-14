import {
  buildTournamentConfig,
  type TournamentFormInput,
} from '../../lib/tournamentFromTableConfig';
import {
  describeStoredMttStructure,
  mttClockDescription,
} from '../../../server/src/tournament/mttStructureDescription';

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
  const proposed = buildTournamentConfig(config, gameType);
  const facts = describeStoredMttStructure(proposed.blindStructure, proposed.startingStack);
  const depth = facts.startingDepthBB;
  const chips = Number(proposed.startingStack);
  const chipLabel = Number.isFinite(chips) && chips > 0 ? chips.toLocaleString() : 'Unconfirmed';
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
