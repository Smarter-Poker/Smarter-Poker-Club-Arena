import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../src/services/TournamentService', async (original) => {
  const actual = await original<typeof import('../../src/services/TournamentService')>();
  return {
    ...actual,
    tournamentService: {
      createTournament: mocks.create,
      buildRpcConfig: actual.tournamentService.buildRpcConfig.bind(actual.tournamentService),
    },
  };
});
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}));
import CreateTournamentModal from '../../src/components/club/CreateTournamentModal';
import BlindStructureBuilder from '../../src/components/tournament/BlindStructureBuilder';
import {
  tournamentService,
  BLIND_STRUCTURES,
  SPIN_BLIND_STRUCTURE,
} from '../../src/services/TournamentService';
import type { BlindLevel } from '../../src/config/blindStructures';
import { supabase } from '../../src/lib/supabase';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 'synthetic-created-event' });
});

describe('club MTT setup presets reach the creation payload', () => {
  it.each([
    ['Regular', 150, 10],
    ['Deep Stack', 300, 15],
    ['Turbo', 100, 5],
    ['Hyper Turbo', 50, 2],
  ] as const)(
    '%s sets the advertised opening depth and playing clock',
    async (label, bb, minutes) => {
      const { container } = render(
        <CreateTournamentModal
          clubId="synthetic-club"
          initialFormat="mtt_freezeout"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );
      fireEvent.change(screen.getByPlaceholderText('E.G. Saturday Night Turbo'), {
        target: { value: 'Synthetic Structure' },
      });
      const option = screen.getByRole('option', {
        name: new RegExp(`^${label} [(·]`),
      }) as HTMLOptionElement;
      fireEvent.change(option.parentElement!, { target: { value: option.value } });
      fireEvent.submit(container.querySelector('form')!);
      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
      const config = mocks.create.mock.calls[0][1];
      const payload = tournamentService.buildRpcConfig(config);
      expect(payload.startingStack).toBe(bb * 20);
      const levels = payload.blindStructure as BlindLevel[];
      expect(levels[0]).toMatchObject({ smallBlind: 10, bigBlind: 20 });
      expect(
        levels.filter((row) => !row.isBreak).every((row) => row.durationMinutes === minutes)
      ).toBe(true);
      expect(levels.some((row) => row.isBreak)).toBe(false);
      expect(config).toMatchObject({
        buyIn: 10,
        rake: 1,
        payoutPercent: 10,
        maxPlayers: 1_000_000,
      });
      expect(config.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
      expect(mocks.error).not.toHaveBeenCalled();
    }
  );

  it('keeps the existing custom opening draft until a profile is explicitly selected', async () => {
    const { container } = render(
      <CreateTournamentModal
        clubId="synthetic-club"
        initialFormat="mtt_freezeout"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Setup Preset' })).toHaveDisplayValue(
      'Custom Setup'
    );
    expect(screen.getByLabelText('MTT Structure Preview')).toHaveTextContent('75 Big Blinds');
    fireEvent.change(screen.getByPlaceholderText('E.G. Saturday Night Turbo'), {
      target: { value: 'Existing Custom Draft' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][1]).toMatchObject({
      startingStack: 1500,
      blindStructure: BLIND_STRUCTURES.turbo
        .filter((row) => !row.isBreak)
        .map((row, index) => ({ ...row, level: index + 1 })),
    });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MTT creation publishes a selected paid field', () => {
  it.each([10, 15, 20])('submits %i percent with a bounded provisional ladder', async (depth) => {
    const { container } = render(
      <CreateTournamentModal
        clubId="synthetic-club"
        initialFormat="mtt_freezeout"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    const name = screen.getByPlaceholderText('E.G. Saturday Night Turbo');
    fireEvent.change(name, { target: { value: 'Synthetic Paid Field' } });
    fireEvent.change(screen.getByLabelText('Field Paid'), { target: { value: String(depth) } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const [club, config] = mocks.create.mock.calls[0];
    expect(club).toBe('synthetic-club');
    expect(config.maxPlayers).toBe(1_000_000);
    expect(config.payoutPercent).toBe(depth);
    expect(config.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
    expect(JSON.stringify(config.payoutStructure).length).toBeLessThan(100);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('does not replace the separate Spin prize contract with a paid-field control', () => {
    render(
      <CreateTournamentModal
        clubId="synthetic-club"
        initialFormat="spin"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('Field Paid')).toBeNull();
  });
});

function mountDraft(
  initialFormat: Parameters<typeof CreateTournamentModal>[0]['initialFormat'] = 'mtt_freezeout',
  unionId?: string
) {
  const rendered = render(
    <CreateTournamentModal
      clubId="d6000000-0000-4000-8000-000000000001"
      unionId={unionId}
      initialFormat={initialFormat}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
    />
  );
  fireEvent.change(screen.getByPlaceholderText('E.G. Saturday Night Turbo'), {
    target: { value: 'Custom Club Draft' },
  });
  return rendered;
}

function chooseProfile(value: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Setup Preset' }), { target: { value } });
}

async function submitDraft(container: HTMLElement, callCount = 1) {
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(callCount));
  expect(mocks.error).not.toHaveBeenCalled();
  return mocks.create.mock.calls[callCount - 1][1];
}

describe('club profile selection preserves operator terms', () => {
  it('excludes an inactive custom editor from form validation without discarding its input', async () => {
    const { container } = mountDraft();
    chooseProfile('custom');
    const row = within(screen.getByRole('table')).getAllByRole('row')[1];
    const smallBlind = within(row).getAllByRole('spinbutton')[0] as HTMLInputElement;
    fireEvent.change(smallBlind, { target: { value: '0' } });
    expect(smallBlind.checkValidity()).toBe(false);
    chooseProfile('regular');
    // Happy DOM's willValidate omits inherited fieldset disability. This
    // matcher checks the DOM's actual disabled-fieldset contract instead.
    expect(smallBlind).toBeDisabled();
    const config = await submitDraft(container);
    expect(config.blindStructure[0]).toMatchObject({ smallBlind: 10, bigBlind: 20 });
    chooseProfile('custom');
    expect(smallBlind).not.toBeDisabled();
    expect(smallBlind).toHaveValue(0);
  });

  it('shows the actual custom depth after a starting-stack override without reapplying a profile', async () => {
    const { container } = mountDraft();
    chooseProfile('deep');
    fireEvent.change(screen.getByLabelText(/Starting Chips/), { target: { value: '3500.5' } });
    expect(screen.getByRole('combobox', { name: 'Setup Preset' })).toHaveDisplayValue(
      'Custom Setup'
    );
    expect(screen.getByLabelText('MTT Structure Preview')).toHaveTextContent(
      '175 Big Blinds At Start'
    );
    expect(screen.getByLabelText('MTT Structure Preview')).toHaveTextContent('15 Min');
    const config = await submitDraft(container);
    expect(config.startingStack).toBe(3500);
    expect(config.blindStructure[0].durationMinutes).toBe(15);
  });

  it('retains the exact edited custom ladder when returning from a profile', async () => {
    const { container } = mountDraft();
    chooseProfile('custom');
    const row = within(screen.getByRole('table')).getAllByRole('row')[1];
    fireEvent.change(within(row).getAllByRole('spinbutton')[0], { target: { value: '5' } });
    fireEvent.change(within(row).getAllByRole('spinbutton')[3], { target: { value: '7' } });
    const before = await submitDraft(container);
    expect(before.blindStructure[0]).toMatchObject({
      smallBlind: 5,
      bigBlind: 10,
      durationMinutes: 7,
    });
    chooseProfile('deep');
    expect(screen.queryByRole('table')).toBeNull();
    const profile = await submitDraft(container, 2);
    expect(profile.blindStructure[0]).toMatchObject({
      smallBlind: 10,
      bigBlind: 20,
      durationMinutes: 15,
    });
    chooseProfile('custom');
    const after = await submitDraft(container, 3);
    expect(after.blindStructure).toEqual(before.blindStructure);
    // The explicit Deep selection changed the stack; returning to its custom
    // ladder preserves that current input and accurately discloses the ratio.
    expect(after.startingStack).toBe(6000);
    expect(screen.getByLabelText('MTT Structure Preview')).toHaveTextContent(
      '600 Big Blinds At Start'
    );
    expect(() => tournamentService.buildRpcConfig(after)).not.toThrow();
  });

  it.each([
    'bounty',
    'progressive_bounty',
    'mystery_bounty',
    'mtt_rebuy',
    'mtt_reentry',
    'xmtt',
  ] as const)('preserves %s economic and qualification settings', async (format) => {
    const { container } = mountDraft(format, format === 'xmtt' ? 'synthetic-union' : undefined);
    const before = await submitDraft(container);
    chooseProfile('regular');
    const after = await submitDraft(container, 2);
    for (const key of Object.keys(before).filter(
      (key) =>
        !['blindStructure', 'startingStack', 'rebuyChips', 'addOnChips', 'startTime'].includes(key)
    )) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(after.startingStack).toBe(3000);
    expect(() => tournamentService.buildRpcConfig(after)).not.toThrow();
  });

  it('preserves Free Buy paid rebuy and add-on terms on profile selection', async () => {
    const { container } = mountDraft();
    const freeBuy = screen.getByRole('option', {
      name: 'Free Buy (First Entry Free)',
    }) as HTMLOptionElement;
    fireEvent.change(freeBuy.parentElement!, { target: { value: freeBuy.value } });
    const before = tournamentService.buildRpcConfig(await submitDraft(container));
    chooseProfile('deep');
    const after = tournamentService.buildRpcConfig(await submitDraft(container, 2));
    for (const key of Object.keys(before).filter(
      (key) => !['blindStructure', 'startingStack', 'rebuyChips', 'startTime'].includes(key)
    )) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(after).toMatchObject({
      buyIn: 0,
      startingStack: 6000,
      rebuyCost: 1,
      // Existing freeBuyConfig binds omitted rebuy chips to the chosen stack.
      rebuyChips: 6000,
      addOnChips: 10000,
      addOnCost: 1,
      freeBuy: true,
    });
  });

  it.each(['sng', 'spin'] as const)('keeps %s out of the MTT profile policy', async (format) => {
    const { container } = mountDraft(format);
    expect(screen.queryByRole('combobox', { name: 'Setup Preset' })).toBeNull();
    expect(screen.queryByLabelText('MTT Structure Preview')).toBeNull();
    const config = await submitDraft(container);
    expect(config).toMatchObject({ startingStack: 1500, maxPlayers: format === 'spin' ? 3 : 6 });
    expect(config.blindStructure).toEqual(
      format === 'spin' ? SPIN_BLIND_STRUCTURE : BLIND_STRUCTURES.turbo
    );
  });

  it('preserves the selected satellite target and seat award contract', async () => {
    const target = {
      id: 'd6000000-0000-4000-8000-000000000002',
      name: 'Synthetic Main Event',
      is_bounty: false,
      is_pko: false,
      is_mystery_bounty: false,
      is_premium_spin: false,
      variant: 'freezeout',
      tournament_type: 'MTT',
    };
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [target], error: null }),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query as never);
    const { container } = mountDraft('satellite');
    const option = (await screen.findByRole('option', { name: target.name })) as HTMLOptionElement;
    fireEvent.change(option.parentElement!, { target: { value: target.id } });
    chooseProfile('turbo');
    const config = await submitDraft(container);
    const payload = tournamentService.buildRpcConfig(config);
    expect(config.satelliteTarget).toEqual({ tournamentId: target.id, seatsAwarded: 1 });
    expect(payload).toMatchObject({
      type: 'satellite',
      satelliteTargetId: target.id,
      satelliteSeats: 1,
      startingStack: 2000,
      buyIn: 10,
    });
    expect(config.blindStructure[0].durationMinutes).toBe(5);
  });

  it('saves the selected profile through the actual schedule serializer and service', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { ok: true, schedule_id: 'synthetic-schedule' },
      error: null,
    } as never);
    const { container } = mountDraft();
    chooseProfile('hyper');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Repeats Weekly' }));
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('fn_upsert_tournament_schedule', expect.any(Object))
    );
    const schedule = (
      rpc.mock.calls.find(([name]) => name === 'fn_upsert_tournament_schedule')![1] as any
    ).p_schedule;
    expect(schedule.config).toMatchObject({
      startingStack: 1000,
      buyIn: 10,
      payoutPercent: 10,
      recurrenceCadence: 'weekly',
    });
    expect(schedule.config.startTime).toBeUndefined();
    expect(schedule.config.blindStructure[0]).toMatchObject({ bigBlind: 20, durationMinutes: 2 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});

describe('new drafts only advertise supported tournament breaks', () => {
  it('emits only playing levels from the actual custom editor and preserves synchronized opt-out', async () => {
    const { container } = mountDraft();
    chooseProfile('custom');
    expect(screen.queryByRole('checkbox', { name: /Auto-Insert Breaks/ })).toBeNull();
    expect(screen.queryByTitle('Insert Break After')).toBeNull();
    expect(screen.queryByText('Levels Are Sent Exactly As Shown, Breaks Included.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Advanced Options' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Synchronized Breaks' }));
    expect(screen.getByLabelText('Tournament Break Policy')).toHaveTextContent(
      'No Scheduled Tournament Breaks'
    );
    expect(screen.getByLabelText('Tournament Break Policy')).toHaveTextContent(
      'Platform Maintenance'
    );
    const config = await submitDraft(container);
    expect(config.synchronizedBreaks).toBe(false);
    expect(config.blindStructure.every((row: BlindLevel) => !row.isBreak)).toBe(true);
    expect(tournamentService.buildRpcConfig(config).synchronizedBreaks).toBe(false);
  });

  it('keeps an imported break row visible and refuses it until explicitly removed', () => {
    const onChange = vi.fn();
    const first = { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 7 };
    const last = { ...first, level: 3, smallBlind: 20, bigBlind: 40 };
    const original = [
      first,
      { level: 2, smallBlind: 0, bigBlind: 0, ante: 0, durationMinutes: 5, isBreak: true },
      last,
    ];
    const before = JSON.stringify(original);
    render(<BlindStructureBuilder initialStructure={original} onChange={onChange} />);
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(original);
    expect(screen.getByRole('alert')).toHaveTextContent('Remove Break Rows Before Creating');
    fireEvent.click(screen.getByTitle('Remove Break'));
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual([first, { ...last, level: 2 }]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(JSON.stringify(original)).toBe(before);
  });
});

function purchaseField(label: string) {
  return screen.getByText(label, { selector: 'label' }).parentElement!.querySelector('input')!;
}

function selectFreeBuy() {
  const option = screen.getByRole('option', {
    name: 'Free Buy (First Entry Free)',
  }) as HTMLOptionElement;
  fireEvent.change(option.parentElement!, { target: { value: option.value } });
}

describe('creator controls describe the committed purchase and mystery contracts', () => {
  it('offers only supported mystery settings in both one-off and recurring payloads', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { ok: true, schedule_id: 'synthetic-mystery-schedule' },
      error: null,
    } as never);
    const { container } = mountDraft('mystery_bounty');
    expect(screen.queryByText(/Min Multiplier/)).toBeNull();
    expect(screen.queryByText(/Max Multiplier/)).toBeNull();
    expect(screen.queryByText(/Each Head Is Sealed At Registration/)).toBeNull();
    expect(screen.getByText(/Inventory Is Built From The Funded Mystery Pool/)).toHaveTextContent(
      'After Registration And Purchases Close'
    );
    const jackpot = screen.getByRole('option', {
      name: 'Jackpot (Top Heavy)',
    }) as HTMLOptionElement;
    fireEvent.change(jackpot.parentElement!, { target: { value: jackpot.value } });
    const count = screen.getByRole('option', { name: 'At A Player Count' }) as HTMLOptionElement;
    fireEvent.change(count.parentElement!, { target: { value: count.value } });
    fireEvent.change(purchaseField('Players Left'), { target: { value: '27' } });
    fireEvent.change(purchaseField('Percent Of Bounties In Chests'), { target: { value: '65' } });
    const config = await submitDraft(container);
    for (const document of [config, tournamentService.buildRpcConfig(config)]) {
      expect(document).not.toHaveProperty('mysteryBountyMin');
      expect(document).not.toHaveProperty('mysteryBountyMax');
      expect(document).toMatchObject({
        mysteryBountyProfile: 'jackpot',
        mysteryBountyActivation: 'player_count',
        mysteryBountyActivationValue: 27,
        mysteryBountyPoolPercent: 65,
      });
    }
    fireEvent.click(screen.getByRole('checkbox', { name: 'Repeats Weekly' }));
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('fn_upsert_tournament_schedule', expect.any(Object))
    );
    const schedule = (
      rpc.mock.calls.find(([name]) => name === 'fn_upsert_tournament_schedule')![1] as any
    ).p_schedule;
    expect(schedule.config).toMatchObject({
      mysteryBountyProfile: 'jackpot',
      mysteryBountyActivationValue: 27,
      mysteryBountyPoolPercent: 65,
    });
    expect(schedule.config).not.toHaveProperty('mysteryBountyMin');
    expect(schedule.config).not.toHaveProperty('mysteryBountyMax');
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('shows the actual fixed Free Buy purchases and stack without promising disabled or custom prices', async () => {
    const { container } = mountDraft();
    selectFreeBuy();
    chooseProfile('deep');
    for (const name of ['Allow Rebuys (Same Seat)', 'Allow Re-Entry (New Seat)', 'Allow Add-Ons']) {
      expect(screen.getByRole('checkbox', { name })).toBeChecked();
      expect(screen.getByRole('checkbox', { name })).toBeDisabled();
    }
    expect(screen.queryByText(/Select "MTT [(]Rebuy[)]" Format To Enable/)).toBeNull();
    expect(purchaseField('Rebuy / Re-Entry Cost')).toHaveValue(1);
    expect(purchaseField('Rebuy / Re-Entry Cost')).toBeDisabled();
    expect(purchaseField('Rebuy / Re-Entry Chips')).toHaveValue(6000);
    expect(purchaseField('Rebuy / Re-Entry Chips')).toBeDisabled();
    expect(purchaseField('Add-On Cost')).toHaveValue(1);
    expect(purchaseField('Add-On Cost')).toBeDisabled();
    expect(purchaseField('Add-On Chips')).not.toBeDisabled();
    fireEvent.change(purchaseField('Add-On Chips'), { target: { value: '12000' } });
    expect(screen.getByText('From Seating Until The Add-On Window Closes')).toBeVisible();
    expect(screen.queryByText('1 Minute After Rebuy Period')).toBeNull();
    const raw = await submitDraft(container);
    expect(raw.rebuyChips).toBeUndefined();
    expect(raw.rebuyLevels).toBeUndefined();
    expect(tournamentService.buildRpcConfig(raw)).toMatchObject({
      buyIn: 0,
      startingStack: 6000,
      isRebuy: true,
      isReentry: true,
      rebuyCost: 1,
      rebuyChips: 6000,
      rebuyLevels: 4,
      addOnAvailable: true,
      addOnCost: 1,
      addOnChips: 12000,
      addOnFromStart: true,
    });
  });

  it('preserves editable paid-event purchase prices and the after-rebuy add-on window', async () => {
    const { container } = mountDraft('mtt_rebuy');
    for (const [label, value] of [
      ['Rebuy Cost', '7'],
      ['Add-On Cost', '9'],
    ] as const) {
      expect(purchaseField(label)).not.toBeDisabled();
      fireEvent.change(purchaseField(label), { target: { value } });
    }
    expect(screen.getByRole('checkbox', { name: 'Allow Add-Ons' })).not.toBeDisabled();
    expect(screen.getByText('1 Minute After Rebuy Period')).toBeVisible();
    const config = tournamentService.buildRpcConfig(await submitDraft(container));
    expect(config).toMatchObject({
      buyIn: 10,
      rebuyCost: 7,
      addOnCost: 9,
      isRebuy: true,
      isReentry: false,
      addOnFromStart: false,
    });
  });
});
