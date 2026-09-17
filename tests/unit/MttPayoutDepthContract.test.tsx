import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  buildTournamentConfig,
  type TournamentFormInput,
} from '../../src/lib/tournamentFromTableConfig';
import { tournamentService } from '../../src/services/TournamentService';
import { MttPayoutDepthOptions } from '../../src/components/tournament/MttPayoutDepthOptions';
import { MttCreationStructurePreview } from '../../src/components/tournament/MttCreationStructurePreview';
import { MTT_PAYOUT_DEPTH_REQUIRED } from '../../server/src/tournament/mttPayoutDepth';
import { tournamentScheduleService } from '../../src/services/TournamentScheduleService';
import { supabase } from '../../src/lib/supabase';
import { payoutEngine } from '../../src/services/PayoutEngine';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const draft: TournamentFormInput = {
  name: 'Manual MTT',
  gameMode: 'mtt',
  buyIn: 100,
  startingChips: 5000,
  blindStructure: 'standard',
  blindsUpMinutes: 10,
  payoutStructure: 'payout3',
  sngPlayerCount: 9,
  isSpins: false,
  minPlayers: 3,
  maxPlayersRange: 100,
  lateRegistrationLevel: 6,
  numberOfRebuysReentries: 0,
  addOnMultiplier: 0,
  koBounty: false,
  startTime: '',
};

function Form({ initial = 'payout3' }: { initial?: string }) {
  const [choice, setChoice] = useState(initial);
  const config = { ...draft, payoutStructure: choice };
  return (
    <>
      <select
        aria-label="Payout Structure"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      >
        <MttPayoutDepthOptions currentChoice={choice} />
      </select>
      <MttCreationStructurePreview config={config} gameType="nlh" />
      <button
        onClick={() => {
          const payload = tournamentService.buildRpcConfig(buildTournamentConfig(config, 'nlh'));
          document.getElementById('payload')!.textContent = JSON.stringify(payload);
        }}
      >
        Preview Saved Payload
      </button>
      <output id="payload" data-testid="payload" />
    </>
  );
}

describe('manual MTT paid depth reaches the database creation contract', () => {
  it.each([
    ['payout1', 10],
    ['payout3', 15],
    ['payout20', 20],
  ] as const)('keeps %s provisional at every field capacity', (choice, percent) => {
    const legacy = vi.spyOn(payoutEngine, 'payoutsForChoice').mockImplementation(() => {
      throw new Error('The SNG capacity generator must not price a provisional MTT');
    });
    for (const capacity of [2, 34, 300, 1_000_000]) {
      const input = Object.freeze({
        ...draft,
        payoutStructure: choice,
        maxPlayersRange: capacity,
      });
      const payload = tournamentService.buildRpcConfig(buildTournamentConfig(input, 'nlh'));
      expect(payload.payoutPercent).toBe(percent);
      expect(payload.maxPlayers).toBe(capacity);
      expect(payload.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
      expect(input.maxPlayersRange).toBe(capacity);
    }
    expect(legacy).not.toHaveBeenCalled();
  });

  it('requires a supported SNG choice when switching from the new MTT-only depth', () => {
    expect(() =>
      buildTournamentConfig({ ...draft, gameMode: 'sng', payoutStructure: 'payout20' }, 'nlh')
    ).toThrow('Choose A Sit And Go Payout Structure');
  });
  it.each([
    ['payout1', 10, 'Top 10% Of Field'],
    ['payout3', 15, 'Top 15% Of Field (Standard)'],
    ['payout20', 20, 'Top 20% Of Field'],
  ] as const)(
    'selecting %s persists %i percent through the actual mapper and serializer',
    (choice, percent, label) => {
      render(<Form />);
      expect(screen.getByRole('option', { name: label })).toBeTruthy();
      fireEvent.change(screen.getByRole('combobox'), { target: { value: choice } });
      fireEvent.click(screen.getByRole('button'));
      const payload = JSON.parse(screen.getByTestId('payload').textContent!);
      expect(payload.payoutPercent).toBe(percent);
      expect(payload.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
      expect(payload.buyIn).toBe(100);
    }
  );

  it.each(['payout2', 'winner_take_all', '', 'standard', 'retired-preset'])(
    'refuses unsupported restored MTT choice %s before creating a misleading event',
    (payoutStructure) => {
      const input = Object.freeze({ ...draft, payoutStructure });
      expect(() => buildTournamentConfig(input, 'nlh')).toThrow(MTT_PAYOUT_DEPTH_REQUIRED);
      render(<Form initial={payoutStructure} />);
      expect(screen.getByRole('alert').textContent).toBe(MTT_PAYOUT_DEPTH_REQUIRED);
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(payoutStructure);
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'payout3' } });
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(screen.getByRole('button'));
      expect(JSON.parse(screen.getByTestId('payload').textContent!).payoutPercent).toBe(15);
      expect(input.payoutStructure).toBe(payoutStructure);
    }
  );

  it.each(['payout1', 'payout2', 'payout3', 'winner_take_all'])(
    'preserves existing SNG mapping for %s',
    (payoutStructure) => {
      const input = { ...draft, gameMode: 'sng' as const, payoutStructure, sngPlayerCount: 100 };
      const mapped = buildTournamentConfig(input, 'nlh');
      const payload = tournamentService.buildRpcConfig(mapped);
      expect(payload).not.toHaveProperty('payoutPercent');
      expect(mapped.payoutStructure).toHaveLength(
        ({ payout1: 10, payout2: 13, payout3: 15, winner_take_all: 1 } as Record<string, number>)[
          payoutStructure
        ]
      );
    }
  );

  it('carries the same supported selection for a target-linked MTT satellite without changing its ticket terms', () => {
    const mapped = buildTournamentConfig(
      {
        ...draft,
        payoutStructure: 'payout20',
        nextStepSatellite: true,
        satelliteTargetId: 'd3000000-0000-4000-8000-000000000099',
        satelliteSeats: 3,
      },
      'nlh'
    );
    const payload = tournamentService.buildRpcConfig(mapped);
    expect(payload.payoutPercent).toBe(20);
    expect(mapped.satelliteTarget).toEqual({
      tournamentId: 'd3000000-0000-4000-8000-000000000099',
      seatsAwarded: 3,
    });
    expect(mapped.type).toBe('satellite');
  });

  it.each([
    ['payout1', 10],
    ['payout3', 15],
    ['payout20', 20],
  ] as const)(
    'saved schedules retain selected %s instead of reverting at the next occurrence',
    async (choice, percent) => {
      const rpc = vi
        .spyOn(supabase, 'rpc')
        .mockResolvedValue({ data: { ok: true, schedule_id: 'schedule' }, error: null } as never);
      const config = tournamentService.buildRpcConfig(
        buildTournamentConfig({ ...draft, payoutStructure: choice }, 'nlh')
      );
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
        expect.objectContaining({
          p_schedule: expect.objectContaining({
            config: expect.objectContaining({
              payoutPercent: percent,
              payoutStructure: [{ place: 1, percentage: 100 }],
            }),
          }),
        })
      );
      expect(config).not.toHaveProperty('startTime');
    }
  );

  it('does not share mutable provisional rows between drafts', () => {
    const first = buildTournamentConfig(draft, 'nlh');
    first.payoutStructure[0].percentage = 0;
    const second = buildTournamentConfig(draft, 'nlh');
    expect(second.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
  });
});
