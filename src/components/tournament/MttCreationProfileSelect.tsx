import {
  MTT_CREATION_PROFILES,
  type MttCreationProfileId,
} from '../../../server/src/tournament/mttCreationProfiles';
import {
  manualMttCreationProfile,
  selectedManualMttProfile,
  type ManualMttProfileValues,
} from '../../lib/mttCreationProfile';

export function MttCreationProfileSelect({
  config,
  onApply,
}: {
  config: {
    gameMode: string;
    blindStructure: string;
    blindsUpMinutes: number;
    startingChips: number;
  };
  onApply: (values: ManualMttProfileValues) => void;
}) {
  if (config.gameMode !== 'mtt') return null;
  return (
    <div className="config-radio-group">
      <label className="radio-group-label" htmlFor="mtt-structure-preset">
        Setup Preset
      </label>
      <select
        id="mtt-structure-preset"
        className="config-select"
        value={selectedManualMttProfile(config)}
        onChange={(event) =>
          onApply(manualMttCreationProfile(event.target.value as MttCreationProfileId))
        }
      >
        <option value="custom" disabled>
          Custom Setup
        </option>
        {MTT_CREATION_PROFILES.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.label} · {profile.depthBB} BB · {profile.minutes} Min
          </option>
        ))}
      </select>
    </div>
  );
}
