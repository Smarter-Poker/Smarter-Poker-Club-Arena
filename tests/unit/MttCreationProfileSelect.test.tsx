import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MttCreationProfileSelect } from '../../src/components/tournament/MttCreationProfileSelect';
import { MttCreationStructurePreview } from '../../src/components/tournament/MttCreationStructurePreview';
import {
  buildTournamentConfig,
  type TournamentFormInput,
} from '../../src/lib/tournamentFromTableConfig';
import { tournamentService } from '../../src/services/TournamentService';
import { tournamentScheduleService } from '../../src/services/TournamentScheduleService';
import { supabase } from '../../src/lib/supabase';
import { describeStoredMttStructure } from '../../server/src/tournament/mttStructureDescription';
import { validateMttBlindStructure } from '../../server/src/domain/tournamentBlindContract';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const draft: TournamentFormInput = {
  name: 'Profile Test',
  gameMode: 'mtt',
  buyIn: 20,
  startingChips: 1000,
  blindStructure: 'standard',
  blindsUpMinutes: 3,
  payoutStructure: 'payout3',
  sngPlayerCount: 9,
  isSpins: false,
  minPlayers: 3,
  maxPlayersRange: 300,
  lateRegistrationLevel: 6,
  numberOfRebuysReentries: 0,
  addOnMultiplier: 0,
  koBounty: false,
  startTime: '',
};

function Form({ initial = draft }: { initial?: TournamentFormInput }) {
  const [config, setConfig] = useState(initial);
  return (
    <>
      <MttCreationProfileSelect
        config={config}
        onApply={(values) => setConfig((current) => ({ ...current, ...values }))}
      />
      <MttCreationStructurePreview config={config} gameType="nlh" />
      <button onClick={() => setConfig((current) => ({ ...current, blindsUpMinutes: 4 }))}>
        Edit Level Duration
      </button>
      <button
        onClick={() => {
          const payload = tournamentService.buildRpcConfig(buildTournamentConfig(config, 'nlh'));
          document.getElementById('profile-payload')!.textContent = JSON.stringify(payload);
        }}
      >
        Save Draft Payload
      </button>
      <output data-testid="profile-payload" id="profile-payload" />
    </>
  );
}

const cases = [
  ['regular', 150, 10, 'standard'],
  ['deep', 300, 15, 'slow'],
  ['turbo', 100, 5, 'turbo'],
  ['hyper', 50, 2, 'hyper_turbo'],
] as const;

function selectAndSave(id: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Setup Preset' }), {
    target: { value: id },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Draft Payload' }));
  return JSON.parse(screen.getByTestId('profile-payload').textContent!);
}

describe('engine MTT setup presets reach actual creation', () => {
  it.each(cases)('%s applies its actual depth and clock', (id, depth, minutes, speed) => {
    render(<Form />);
    const payload = selectAndSave(id);
    const facts = describeStoredMttStructure(payload.blindStructure, payload.startingStack);
    expect(facts).toMatchObject({
      startingDepthBB: depth,
      openingMinutes: minutes,
      minimumMinutes: minutes,
      maximumMinutes: minutes,
      speed,
    });
    expect(() =>
      validateMttBlindStructure(payload.blindStructure, payload.startingStack)
    ).not.toThrow();
    expect(payload).toMatchObject({
      name: draft.name,
      buyIn: 20,
      maxPlayers: 300,
      payoutPercent: 15,
    });
    expect(payload.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
  });

  it('preserves a restored custom draft until an explicit selection', () => {
    const restored = Object.freeze({ ...draft, startingChips: 7000, blindsUpMinutes: 7 });
    const onApply = vi.fn();
    const { rerender } = render(<MttCreationProfileSelect config={restored} onApply={onApply} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('custom');
    rerender(<MttCreationProfileSelect config={restored} onApply={onApply} />);
    expect(onApply).not.toHaveBeenCalled();
    expect(restored.startingChips).toBe(7000);
  });

  it('shows Custom again when an operator overrides the preset clock', () => {
    render(<Form />);
    selectAndSave('regular');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Level Duration' }));
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('custom');
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft Payload' }));
    const payload = JSON.parse(screen.getByTestId('profile-payload').textContent!);
    expect(describeStoredMttStructure(payload.blindStructure, payload.startingStack)).toMatchObject(
      { startingDepthBB: 150, openingMinutes: 4, speed: 'turbo' }
    );
  });

  it.each(['regular', 'sng'])('never applies a profile when mounted for %s', (gameMode) => {
    const onApply = vi.fn();
    render(<MttCreationProfileSelect config={{ ...draft, gameMode }} onApply={onApply} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it.each(['bounty', 'satellite', 'rebuy', 'free_buy'])(
    'retains %s economic and qualification settings',
    (kind) => {
      const initial = {
        ...draft,
        buyIn: kind === 'free_buy' ? 0 : draft.buyIn,
        numberOfRebuysReentries: kind === 'rebuy' || kind === 'free_buy' ? 3 : 0,
        addOnMultiplier: kind === 'rebuy' || kind === 'free_buy' ? 2 : 0,
        koBounty: kind === 'bounty',
        nextStepSatellite: kind === 'satellite',
        satelliteTargetId: 'd3000000-0000-4000-8000-000000000099',
        satelliteSeats: 3,
      };
      const before = tournamentService.buildRpcConfig(buildTournamentConfig(initial, 'nlh'));
      render(<Form initial={initial} />);
      const after = selectAndSave('deep');
      for (const key of Object.keys(before).filter(
        (key) =>
          !['blindStructure', 'startingStack', 'rebuyChips', 'addOnChips', 'startTime'].includes(
            key
          )
      )) {
        expect(after[key], key).toEqual(before[key]);
      }
      expect(after.type).toBe(kind === 'satellite' || kind === 'bounty' ? kind : 'mtt');
    }
  );

  it('retains the selected structure through the actual saved-schedule service', async () => {
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { ok: true, schedule_id: 'schedule' }, error: null } as never);
    render(<Form />);
    const config = selectAndSave('turbo');
    delete config.startTime;
    await tournamentScheduleService.upsert({
      clubId: 'club',
      unionId: null,
      name: draft.name,
      daysOfWeek: [1],
      startTimesUtc: ['18:00'],
      intervalMinutes: null,
      active: true,
      config,
    });
    expect(rpc).toHaveBeenCalledWith(
      'fn_upsert_tournament_schedule',
      expect.objectContaining({ p_schedule: expect.objectContaining({ config }) })
    );
    expect(describeStoredMttStructure(config.blindStructure, config.startingStack)).toMatchObject({
      startingDepthBB: 100,
      openingMinutes: 5,
    });
  });
});
