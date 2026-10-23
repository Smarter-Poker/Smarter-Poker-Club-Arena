import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BadBeatJackpot from '../src/components/table/BadBeatJackpot';
import {
  isBbjPlateShown,
  isBbjCelebrationEligible,
} from '../src/components/table/bbjPlateVisibility';

describe('jackpot banners stay in the lobby', () => {
  it('keeps eligible cash-game celebrations independent of hidden readouts', () => {
    const context = { gameType: 'nlh', maxPlayers: 9, isTournament: false, tournamentId: null };
    expect(isBbjPlateShown(context)).toBe(false);
    expect(isBbjCelebrationEligible(context)).toBe(true);
    expect(isBbjCelebrationEligible({ ...context, gameType: 'plo6' })).toBe(false);
    expect(isBbjCelebrationEligible({ ...context, isTournament: true })).toBe(false);
  });

  it.each(['nlh', 'plo', 'plo4', 'plo5', 'plo6', 'short_deck', 'horse', 'spin', 'hu'])(
    'never advertises a jackpot over a live %s game',
    (gameType) => {
      for (const maxPlayers of [2, 6, 9]) {
        expect(
          isBbjPlateShown({ gameType, maxPlayers, isTournament: false, tournamentId: null })
        ).toBe(false);
      }
    }
  );

  it.each(['chips', 'diamonds'] as const)(
    'hides both %s banners while preserving a hit',
    (asset) => {
      const { container } = render(
        <BadBeatJackpot
          amount={36802}
          miniAmount={700}
          asset={asset}
          qualifyingHand="Aces Full Or Better"
          showBanners={false}
          isHit
        />
      );
      expect(container.querySelector('.bbj-widget')).toBeNull();
      expect(container.querySelector('.bbj-mini-plate')).toBeNull();
      expect(screen.queryByRole('button', { name: /View Recent Jackpots/ })).toBeNull();
      expect(container.querySelector('.bbj-hit-overlay')).toBeInTheDocument();
      expect(screen.getByText('HIT!')).toBeInTheDocument();
    }
  );

  it('wires the shared table layer to the display policy and retains the lobby readout', () => {
    const layer = readFileSync('src/components/table/TableModalsLayer.tsx', 'utf8');
    expect(layer).toContain(
      'isBbjCelebrationEligible({ gameType, isTournament, tournamentId, maxPlayers })'
    );
    expect(layer).toMatch(
      /showBanners=\{isBbjPlateShown\(\{ gameType, isTournament, tournamentId, maxPlayers \}\)\}/
    );
    expect(layer).toContain('<BBJCelebration');
    const lobby = readFileSync('src/pages/ClubHomePage.tsx', 'utf8');
    expect(lobby).toContain('className="lobby-bbj"');
    expect(lobby).toContain('className="lobby-bbj__mini"');
    expect(lobby).toContain('setShowBBJInfo(true)');
  });
});
