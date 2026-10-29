import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { register, cardProps } = vi.hoisted(() => ({
  register: vi.fn(async (_event, done) => done?.()),
  cardProps: vi.fn(),
}));
vi.mock('../../src/hooks/useTournamentRegistration', () => ({
  useTournamentRegistration: () => ({ register }),
}));
vi.mock('../../src/components/tournament/TournamentLobbyCard', () => ({
  default: (props: any) => {
    cardProps(props);
    return (
      <button onClick={() => props.onRegister(props.tournament.id)}>Register Satellite</button>
    );
  },
}));
import SatelliteCard from '../../src/components/tournament/details/SatelliteCard';
import {
  satelliteStartsWhenFull,
  isRecordedSatelliteQualifier,
} from '../../src/utils/satelliteQualification';
import { tabsFor } from '../../src/components/tournament/details/types';
import { mapSatelliteRowToCard } from '../../src/components/tournament/details/useSatellites';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('satellites are discoverable and purchasable', () => {
  it.each([false, true])('places Satellites immediately after Details (mystery=%s)', (mystery) => {
    expect(
      tabsFor(mystery)
        .slice(0, 2)
        .map((t) => t.id)
    ).toEqual(['detail', 'satellites']);
  });
  it('shows both unranked SNG qualifiers only for the recorded fixed-field contract', () => {
    const event = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'COMPLETED',
      format_contract: 'sng-v1',
      tournament_type: 'SNG',
      variant: 'sng',
      max_players: 6,
      min_players: 6,
      table_size: 6,
      satellite_seats: 2,
      satellite_target_id: '00000000-0000-4000-8000-000000000002',
    };
    const winner = { status: 'winner', position: null, chips: 3000 };
    expect(isRecordedSatelliteQualifier(event, winner)).toBe(true);
    expect(isRecordedSatelliteQualifier({ ...event, satellite_seats: 1 }, winner)).toBe(false);
    expect(isRecordedSatelliteQualifier(event, { ...winner, position: 1 })).toBe(false);
  });
  it.each([6, 9])('only treats the exact recorded %s-seat contract as when full', (seats) => {
    const event = {
      format_contract: 'sng-v1',
      tournament_type: 'SNG',
      variant: 'sng',
      max_players: seats,
      min_players: seats,
      table_size: seats,
      satellite_seats: 2,
      satellite_target_id: 'target',
    };
    expect(satelliteStartsWhenFull(event)).toBe(true);
    expect(satelliteStartsWhenFull({ ...event, format_contract: 'mtt-v2' })).toBe(false);
    expect(satelliteStartsWhenFull({ ...event, satellite_seats: 1 })).toBe(false);
    expect(satelliteStartsWhenFull({ ...event, min_players: 3 })).toBe(false);
  });
  it('uses exact stored SNG prices and wallet ownership through the confirmed registration flow', async () => {
    const refresh = vi.fn();
    const satellite = mapSatelliteRowToCard({
      id: 'satellite',
      name: 'Two Seat Qualifier',
      status: 'REGISTERING',
      tournament_type: 'SNG',
      variant: 'sng',
      format_contract: 'sng-v1',
      max_players: 9,
      current_players: 0,
      buy_in_amount: 10.8,
      buy_in_fee: 1.2,
      club_id: 'club',
      union_id: 'union',
      satellite_target_id: 'target',
    });
    render(
      <SatelliteCard tournament={satellite} knownRegistration={false} onRegistered={refresh} />
    );
    expect(cardProps.mock.lastCall?.[0].unframed).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Register Satellite' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(register.mock.calls[0][0]).toMatchObject({
      id: 'satellite',
      buy_in_amount: 10.8,
      buy_in_fee: 1.2,
      club_id: 'club',
      union_id: 'union',
      status: 'REGISTERING',
    });
  });
});
