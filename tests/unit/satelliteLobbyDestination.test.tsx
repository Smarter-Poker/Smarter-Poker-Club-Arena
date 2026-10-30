import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MttPremiumCard } from '../../src/components/lobby/game-cards/MttPremiumCard';
import { HeadsUpPremiumCard } from '../../src/components/lobby/game-cards/HeadsUpPremiumCard';
import { tournamentEntry, type LobbyTournamentRow } from '../../src/components/lobby/lobbyEntries';
import type { ArenaGameCardData } from '../../src/components/lobby/game-cards/arenaGameCardTypes';
const lookup = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: lookup.read }) }) }) },
}));
afterEach(cleanup);
function Destination({ kind, target }: { kind: 'mtt' | 'sng'; target?: string }) {
  const raw = {
    id: kind,
    name: 'Qualifier',
    format_contract: kind === 'mtt' ? 'mtt-v1' : 'sng-v1',
    status: 'REGISTERING',
    satellite_target_id: target,
  } as LobbyTournamentRow;
  const data = {
    source: tournamentEntry(raw, kind),
    id: kind,
    title: 'Qualifier',
    family: kind === 'mtt' ? 'mtt' : 'heads-up',
    gameType: 'NLH',
    status: 'registering',
    statusLabel: 'Registering',
    rules: [],
  } as ArenaGameCardData;
  const Card = kind === 'mtt' ? MttPremiumCard : HeadsUpPremiumCard;
  return <Card data={data} actions={{ primaryLabel: 'Register' }} />;
}
describe('satellite destination across tournament families', () => {
  it.each(['mtt', 'sng'] as const)(
    'shows the actual target after the %s lookup resolves',
    async (kind) => {
      let resolve!: (value: unknown) => void;
      lookup.read.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        })
      );
      render(<Destination kind={kind} target={kind + '-target'} />);
      expect(screen.getByText('Loading Satellite Destination...')).toBeTruthy();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        resolve({ data: { name: 'Sunday 200 NLH Main' }, error: null });
      });
      expect(screen.getByText('Wins A Seat Into Sunday 200 NLH Main')).toBeTruthy();
    }
  );
  it('reports a missing target honestly', async () => {
    lookup.read.mockResolvedValueOnce({ data: null, error: null });
    render(<Destination kind="mtt" target="missing" />);
    expect(await screen.findByText('Satellite Destination Unavailable')).toBeTruthy();
  });
});
