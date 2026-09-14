import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MttCreationStructurePreview } from '../../src/components/tournament/MttCreationStructurePreview';
import type { TournamentFormInput } from '../../src/lib/tournamentFromTableConfig';

afterEach(cleanup);
const initial: TournamentFormInput = {
  name: 'Friday MTT',
  gameMode: 'mtt',
  buyIn: 100,
  startingChips: 1000,
  blindStructure: 'standard',
  blindsUpMinutes: 3,
  payoutStructure: 'payout3',
  sngPlayerCount: 9,
  isSpins: false,
  minPlayers: 30,
  maxPlayersRange: 300,
  lateRegistrationLevel: 6,
  numberOfRebuysReentries: 3,
  addOnMultiplier: 1,
  koBounty: false,
  startTime: '',
};
const preview = () => screen.getByLabelText('MTT Structure Preview');

describe('the MTT creator previews its actual mapped rules before booking', () => {
  it('discloses the manual Standard default as 50 BB on a three-minute Turbo clock', () => {
    const input = Object.freeze({ ...initial });
    render(<MttCreationStructurePreview config={input} gameType="nlh" />);
    expect(preview().textContent).toContain('Turbo · 3 Min');
    expect(preview().textContent).toContain('1,000 Starting Chips · 50 Big Blinds');
    expect(preview().textContent).toContain('Blind Structure Sets How Blinds Grow');
    expect(input).toEqual(initial);
  });

  it('a Slow ramp retains the independently selected three-minute clock', () => {
    render(
      <MttCreationStructurePreview config={{ ...initial, blindStructure: 'slow' }} gameType="nlh" />
    );
    expect(preview().textContent).toContain('Turbo · 3 Min');
    expect(preview().textContent).toContain('50 Big Blinds');
  });

  it('updates the exact speed and depth when the owner changes independent controls', () => {
    const view = render(<MttCreationStructurePreview config={initial} gameType="nlh" />);
    view.rerender(
      <MttCreationStructurePreview
        config={{ ...initial, startingChips: 5000, blindsUpMinutes: 15 }}
        gameType="nlh"
      />
    );
    expect(preview().textContent).toContain('Slow · 15 Min');
    expect(preview().textContent).toContain('5,000 Starting Chips · 250 Big Blinds');
    view.rerender(
      <MttCreationStructurePreview config={{ ...initial, blindsUpMinutes: 2 }} gameType="nlh" />
    );
    expect(preview().textContent).toContain('Hyper Turbo · 2 Min');
    expect(preview().textContent).toContain('50 Big Blinds');
  });

  it('uses the effective mapped clock for a restored zero-minute draft', () => {
    render(
      <MttCreationStructurePreview config={{ ...initial, blindsUpMinutes: 0 }} gameType="nlh" />
    );
    expect(preview().textContent).toContain('Hyper Turbo · 1 Min');
  });

  it('applies equally to a target-linked satellite', () => {
    render(
      <MttCreationStructurePreview
        config={{
          ...initial,
          nextStepSatellite: true,
          satelliteTargetId: 'target',
          satelliteSeats: 2,
        }}
        gameType="plo8"
      />
    );
    expect(preview().textContent).toContain('Turbo · 3 Min');
    expect(preview().textContent).toContain('50 Big Blinds');
  });

  it('keeps a malformed restored stack unconfirmed', () => {
    render(
      <MttCreationStructurePreview config={{ ...initial, startingChips: NaN }} gameType="nlh" />
    );
    expect(preview().textContent).toContain('Unconfirmed Starting Chips');
    expect(preview().textContent).not.toContain('NaN');
    expect(preview().textContent).not.toContain('Big Blinds');
  });

  it.each(['regular', 'sng'] as const)('does not advertise an MTT structure for %s', (gameMode) => {
    render(<MttCreationStructurePreview config={{ ...initial, gameMode }} gameType="nlh" />);
    expect(screen.queryByLabelText('MTT Structure Preview')).toBeNull();
  });
});
