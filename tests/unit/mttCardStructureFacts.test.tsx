import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/context/InTabLobbyContext', () => ({ useAppNavigate: () => vi.fn() }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: null }) }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import TournamentLobbyCard from '../../src/components/tournament/TournamentLobbyCard';
import { mapSatelliteRowToCard } from '../../src/components/tournament/details/useSatellites';
import { describeStoredMttStructure } from '../../server/src/tournament/mttStructureDescription';

afterEach(cleanup);
const row = (blind_structure: unknown, starting_chips = 1000) => ({
  id: 'structure-card',
  name: 'Structure Event',
  status: 'ANNOUNCED',
  tournament_type: 'satellite',
  starting_chips,
  blind_structure,
  current_players: 3,
  max_players: 100,
});
const value = (label: string) =>
  screen.getByText(label).parentElement!.lastElementChild!.textContent;

describe('tournament cards display the same engine structure facts as details', () => {
  it.each([
    { duration: 120, bigBlind: 20, stack: 1000, label: 'Hyper Turbo', depth: '50 BB' },
    { duration: 180, bigBlind: 20, stack: 1000, label: 'Turbo', depth: '50 BB' },
    { duration: 900, bigBlind: 50, stack: 1000, label: 'Slow', depth: '20 BB' },
    { duration: 600, bigBlind: 50, stack: 30000, label: 'Regular', depth: '600 BB' },
  ])(
    'renders satellite $label independently of $depth',
    ({ duration, bigBlind, stack, label, depth }) => {
      const input = row(JSON.stringify([{ duration, bigBlind }]), stack);
      const original = JSON.stringify(input);
      render(
        <TournamentLobbyCard tournament={mapSatelliteRowToCard(input)} knownRegistration={false} />
      );
      expect(value('Structure')).toBe(label);
      expect(value('Starting Chips')).toContain(depth);
      expect(value('Levels')).toBe(`${duration / 60} Min`);
      expect(screen.queryByText('Deep Stack')).toBeNull();
      expect(JSON.stringify(input)).toBe(original);
    }
  );

  it('uses playing levels after a leading break and renders the taper', () => {
    render(
      <TournamentLobbyCard
        tournament={mapSatelliteRowToCard(
          row([
            { isBreak: true, durationMinutes: 5 },
            { durationMinutes: 10, bigBlind: 50 },
            { durationMinutes: 5, bigBlind: 100 },
          ])
        )}
        knownRegistration={false}
      />
    );
    expect(value('Structure')).toBe('Regular');
    expect(value('Starting Chips')).toContain('20 BB');
    expect(value('Levels')).toBe('10 Min Opening · 5-10 Min Range');
  });

  it('keeps a named or malformed stored structure unconfirmed', () => {
    render(
      <TournamentLobbyCard
        tournament={mapSatelliteRowToCard(row('deep stack'))}
        knownRegistration={false}
      />
    );
    expect(value('Structure')).toBe('Unconfirmed');
    expect(value('Levels')).toBe('Unconfirmed');
    expect(value('Starting Chips')).not.toContain('BB');
  });

  it('renders raw legacy seconds through the same card adapter', () => {
    const card = mapSatelliteRowToCard(row([]));
    render(
      <TournamentLobbyCard
        tournament={{
          ...card,
          structureFacts: undefined,
          blindStructure: JSON.stringify([{ duration: 180, bigBlind: 20 }]),
          blindDuration: undefined,
        }}
        knownRegistration={false}
      />
    );
    expect(value('Structure')).toBe('Turbo');
    expect(value('Levels')).toBe('3 Min');
    expect(value('Starting Chips')).toContain('50 BB');
  });

  it('does not claim a whole fixed ladder from a legacy opening-clock prop', () => {
    const card = mapSatelliteRowToCard(row([]));
    render(
      <TournamentLobbyCard
        tournament={{
          ...card,
          structureFacts: undefined,
          blindStructure: 'deep stack',
          blindDuration: 3,
        }}
        knownRegistration={false}
      />
    );
    expect(value('Structure')).toBe('Turbo');
    expect(value('Levels')).toBe('3 Min Opening');
    expect(value('Starting Chips')).not.toContain('BB');
  });

  it('updates a lobby card directly from new mapped structure facts', () => {
    const card = mapSatelliteRowToCard(row([{ duration: 900, bigBlind: 50 }]));
    const rendered = render(<TournamentLobbyCard tournament={card} knownRegistration={false} />);
    expect(value('Structure')).toBe('Slow');
    rendered.rerender(
      <TournamentLobbyCard
        tournament={{
          ...card,
          structureFacts: describeStoredMttStructure([{ duration: 120, bigBlind: 100 }], 1000),
        }}
        knownRegistration={false}
      />
    );
    expect(value('Structure')).toBe('Hyper Turbo');
    expect(value('Levels')).toBe('2 Min');
    expect(value('Starting Chips')).toContain('10 BB');
  });
});
