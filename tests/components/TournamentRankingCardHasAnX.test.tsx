/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TOURNAMENT RESULT CARD HAS AN X (Dan 2026-10-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "THE TOURNAMENT RESULT CARD HAS NO 'X' OFF ON IT TO CLOSE THIS OUT."
 *
 * Every popup took SpadeConsole's painted X on 2026-09-23. This card was put on
 * the X law's no-X list instead, on the claim that it "carries its own painted
 * close control" - which was the word Close at the bottom of the glass, the one
 * place the X ruling says a player must never have to go. The source law now
 * holds it to `onClose` like every other console under a dialog; this pins the
 * behaviour: the X is in the head, it is labelled, and it dismisses the card.
 *
 * It also pins the place as the result: the ordinal is printed whole for a
 * screen reader and the finish is named, so the redesign of the place band
 * cannot quietly drop either.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TournamentRankingCard from '../../src/components/tournament/TournamentRankingCard';
import type { TournamentResult } from '../../src/services/pendingSessionSummary';
import { CHIP_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
      }),
    }),
  },
}));

vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => null }));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

function result(finishPlace: number): TournamentResult {
  return {
    name: 'NLH Heads-Up 1',
    finishPlace,
    entrants: 2,
    prize: finishPlace === 1 ? 1.9 : 0,
    bountyWinnings: 0,
    knockouts: 0,
    rebuys: 0,
    addOns: 0,
    isSpin: false,
  };
}

describe('the tournament result card closes from its corner X', () => {
  it('prints the console X in the head and it dismisses the card', () => {
    const onDismiss = vi.fn();
    render(
      <TournamentRankingCard result={result(1)} onDismiss={onDismiss} unitCents={CHIP_UNIT_CENTS} />
    );
    const x = screen.getByTestId('sc-close');
    expect(x.closest('.sc__head')).not.toBeNull();
    expect(x).toHaveAttribute('aria-label', 'Close');
    fireEvent.click(x);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('names the finish and prints the place as one ordinal', () => {
    render(
      <TournamentRankingCard result={result(1)} onDismiss={vi.fn()} unitCents={CHIP_UNIT_CENTS} />
    );
    expect(screen.getByText('Champion')).toBeInTheDocument();
    expect(screen.getByLabelText('1st')).toBeInTheDocument();
  });

  it('does not call an off-podium finish anything but finished', () => {
    render(
      <TournamentRankingCard
        result={{ ...result(47), entrants: 128 }}
        onDismiss={vi.fn()}
        unitCents={CHIP_UNIT_CENTS}
      />
    );
    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.getByLabelText('47th')).toBeInTheDocument();
  });
});
