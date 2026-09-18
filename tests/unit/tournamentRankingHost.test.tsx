/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RESULT CARD LANDS — for every finisher, 1st included
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "at the end of the tournament when you lose, you need to be auto removed
 * from the table, placed inside the lobby and your tournament result card shown
 * … winners should be auto removed at the end as well."
 *
 * The card had never once been tested. It had also, at one point, never once
 * RENDERED: the first version shipped the result as router state to
 * `/clubs/:clubId` while the only reader of that state was ClubLobby, which is
 * `/clubs/:clubId/lobby`. It was replaced by an app-root host reading
 * pendingSessionSummary — and a silent no-op is exactly what a source-level
 * assertion cannot catch, so this half is behavioural: publish a result, assert
 * a card with the right place on it is in the document.
 *
 * The three cases are the three finishers of a Spin. 1st is the one that was
 * broken all the way to the engine (see tests/config/tournamentWinnerExit),
 * and it is the one a Spin is actually about.
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import TournamentRankingHost from '../../src/components/tournament/TournamentRankingHost';
import {
  publishSessionSummary,
  clearSessionSummary,
  type SessionSummaryPayload,
  type TournamentResult,
} from '../../src/services/pendingSessionSummary';

/**
 * The card puts a name on itself with one profile read on mount.
 *
 * Nothing asserted here depends on that name, and left real it is a genuine
 * nuisance: the query resolves a few microtasks after the publish, so React
 * updates outside act() and every case in the file prints the "not wrapped in
 * act(...)" warning — including the ones where no card is mounted at all,
 * because the resolution lands in the next test. The tests pass either way,
 * which is exactly the problem: a suite that always prints stderr is a suite
 * whose stderr nobody reads.
 *
 * Returning no row is the card's own documented degraded path ("still worth
 * showing without a name on it"), and it short-circuits before setProfile, so
 * there is no post-unmount state update to warn about.
 */
vi.mock('../../src/lib/authUtils', () => ({
  readLocalSession: () => ({ userId: 'u-hero' }),
}));

vi.mock('../../src/lib/supabase', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { supabase: { from: () => builder } };
});

const renderHost = () =>
  render(
    <MemoryRouter>
      <TournamentRankingHost />
    </MemoryRouter>
  );

/**
 * Publish, and let the card settle INSIDE act.
 *
 * The card fires one profile read on mount to put a name on itself. That
 * resolves a few microtasks after the publish, so a bare `publishSessionSummary`
 * leaves React updating outside act and every case prints the "not wrapped in
 * act(...)" warning. The tests still pass, which is the problem: a suite that
 * always prints stderr is a suite nobody reads the stderr of.
 */
const publishAndSettle = async (payload: SessionSummaryPayload) => {
  await act(async () => {
    publishSessionSummary(payload);
    // Drain the profile query's promise chain (thenable builder -> setProfile).
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
};

const spinResult = (finishPlace: number, prize: number): TournamentResult => ({
  name: 'Fidget Spinner',
  finishPlace,
  entrants: 3,
  prize,
  bountyWinnings: 0,
  knockouts: 0,
  rebuys: 0,
  addOns: 0,
});

describe('Tournament result card delivery', () => {
  beforeEach(() => {
    clearSessionSummary();
  });

  /* The host is subscribed for its whole life and re-renders on every publish,
     INCLUDING a clear — even in the cases where it renders null. Vitest runs
     this hook before the global RTL cleanup (afterEach hooks unwind LIFO), so
     the host is still mounted here and a bare clear is a state update outside
     act. Wrap it, or every test in the file reports a warning it did not
     cause. */
  afterEach(async () => {
    await act(async () => {
      clearSessionSummary();
    });
  });

  it('shows nothing when no session has finished', () => {
    renderHost();
    expect(screen.queryByRole('dialog', { name: /tournament ranking/i })).toBeNull();
  });

  it.each([
    ['1st', 1, 60],
    ['2nd', 2, 0],
    ['3rd', 3, 0],
  ])('renders the card for the %s-place finisher of a spin', async (label, place, prize) => {
    renderHost();

    await publishAndSettle({
      duration: 180,
      handsPlayed: 21,
      handsWon: 9,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Fidget Spinner',
      tournament: spinResult(place, prize),
    });

    const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    expect(card).toBeTruthy();
    // The place is the largest thing on the card and the whole point of it.
    expect(card.textContent).toContain(label);
    // Field size reads as "#1(3)" — the place, of how many.
    expect(card.textContent).toContain(`#${place}(3)`);
  });

  it.each([
    ['seat', 'Target Entry:'],
    ['ticket', 'Entry Ticket:'],
    ['cash', 'Cash Award:'],
  ] as const)(
    'shows a committed %s qualifier without inventing a finishing place',
    async (deliveryKind, label) => {
      renderHost();
      await publishAndSettle({
        duration: 180,
        handsPlayed: 21,
        handsWon: 9,
        totalRebuys: 0,
        profitLoss: 0,
        biggestPot: 0,
        peakStack: 0,
        tableName: 'Satellite',
        tournament: {
          ...spinResult(1, 50),
          finishPlace: null,
          name: 'Satellite',
          satelliteQualification: {
            targetId: '20000000-0000-4000-8000-000000000002',
            deliveryKind,
            amount: 50,
          },
        },
      });
      const card = screen.getByRole('dialog', { name: /tournament ranking/i });
      expect(card.textContent).toContain('Qualified');
      expect(card.textContent).toContain(label);
      expect(card.textContent).toContain('50.00');
      expect(card.textContent).not.toMatch(/#1|1st|2nd|3rd|Finished/);
      expect(screen.queryByRole('img', { name: /Place Trophy/ })).toBeNull();
    }
  );

  it('shows the champion their prize', async () => {
    renderHost();
    await publishAndSettle({
      duration: 180,
      handsPlayed: 21,
      handsWon: 9,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Fidget Spinner',
      tournament: spinResult(1, 60),
    });

    const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    expect(card.textContent).toContain('60.00');
  });

  it('never renders a chip summary for a tournament seat', async () => {
    /* Dan 2026-08-20: "tournaments are never displayed by chips, only what
       place you finished and how much you made." The split between the two
       cards is on the PRESENCE of `tournament`, not a boolean, so a tournament
       cannot fall through to the cash summary because someone forgot a flag.
       A cash session must therefore render nothing here. */
    renderHost();
    await publishAndSettle({
      duration: 3600,
      handsPlayed: 210,
      handsWon: 40,
      totalRebuys: 0,
      profitLoss: 1250,
      biggestPot: 400,
      peakStack: 3000,
      tableName: 'NLH 1/2',
    });
    expect(screen.queryByRole('dialog', { name: /tournament ranking/i })).toBeNull();
  });

  it('badges an MTT a tournament, and leaves a Spin unbadged', async () => {
    /* AUDIT 2026-08-22: the banner said SPIN for EVERY finished event, so a
       128-runner MTT wore a Spin badge. The flag is resolved from the
       tournament row by isSpinTournament, never guessed from the name — which
       is why the name here stays the same across both cases.

       Dan 2026-08-23: "remove the 'spin' after SmarterPoker". The event line
       directly beneath the brand already names the game, so on a Spin the
       badge was the same word twice. A Spin now carries NO badge — a stricter
       form of the same guarantee this test was written for: the card must
       never label a game as something it is not. */
    renderHost();
    await publishAndSettle({
      duration: 180,
      handsPlayed: 21,
      handsWon: 9,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Fidget Spinner',
      tournament: { ...spinResult(1, 60), isSpin: true },
    });
    let card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    // A Spin is unbadged: neither word appears in the banner.
    expect(card.textContent).not.toContain('SPIN');
    expect(card.textContent).not.toContain('TOURNAMENT');

    await act(async () => {
      clearSessionSummary();
    });

    await publishAndSettle({
      duration: 180,
      handsPlayed: 21,
      handsWon: 9,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Fidget Spinner',
      tournament: { ...spinResult(1, 60), isSpin: false },
    });
    card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    expect(card.textContent).toContain('TOURNAMENT');
  });

  it('an absent isSpin is not a Spin', async () => {
    // Older payloads carry no flag. A real Spin missing its badge is cosmetic;
    // an MTT wearing one is a lie, so the default has to fall this way.
    renderHost();
    await publishAndSettle({
      duration: 60,
      handsPlayed: 4,
      handsWon: 1,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Fidget Spinner',
      tournament: spinResult(2, 0),
    });
    const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    expect(card.textContent).toContain('TOURNAMENT');
  });

  it('reports the session it is handed — duration and hands', async () => {
    /* Both have ridden in the payload since the card was written and the card
       read neither, so a Spin that ran 21 hands over three minutes said
       nothing about itself. Not chips: Dan, "tournaments are never displayed
       by chips." Time and hands are neither. */
    renderHost();
    await publishAndSettle({
      duration: 185,
      handsPlayed: 21,
      handsWon: 9,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Fidget Spinner',
      tournament: spinResult(1, 60),
    });
    const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    expect(card.textContent).toContain('3m 05s');
    expect(card.textContent).toContain('21');
    expect(card.textContent).toContain('Duration');
    expect(card.textContent).toContain('Hands');
  });

  it('shows rebuys and add-ons, and never a zero of either', async () => {
    renderHost();
    await publishAndSettle({
      duration: 600,
      handsPlayed: 80,
      handsWon: 20,
      totalRebuys: 2,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Early Bird Freeroll',
      tournament: { ...spinResult(4, 0), rebuys: 2, addOns: 1, entrants: 128 },
    });
    const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    expect(card.textContent).toContain('2');
    expect(card.textContent).toContain('Rebuys');
    expect(card.textContent).toContain('Add-On');
    // Singular/plural, because "1 Rebuys" is the kind of thing that ships.
    expect(card.textContent).not.toContain('Add-Ons');
  });

  it('does not print a zero-knockout badge', async () => {
    renderHost();
    await publishAndSettle({
      duration: 180,
      handsPlayed: 21,
      handsWon: 9,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Fidget Spinner',
      tournament: spinResult(3, 0),
    });
    const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    expect(card.textContent).not.toContain('Knockout');
    expect(card.textContent).not.toContain('Rebuy');
    expect(card.textContent).not.toContain('Bounties');
  });

  it('dismisses, and stays dismissed', async () => {
    renderHost();
    await publishAndSettle({
      duration: 180,
      handsPlayed: 21,
      handsWon: 9,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tableName: 'Fidget Spinner',
      tournament: spinResult(1, 60),
    });
    await screen.findByRole('dialog', { name: /tournament ranking/i });

    await act(async () => {
      clearSessionSummary();
    });
    expect(screen.queryByRole('dialog', { name: /tournament ranking/i })).toBeNull();
  });
});
