/**
 * THE FINAL TABLE'S POOL IS PRINTED AT THE UNIT THE EVENT PAYS IN (2026-09-21).
 *
 * The prize line printed "Chips" after every pool, so a Diamond final table
 * advertised a Chip pool. A chip event prints exactly what it printed before;
 * a Diamond event prints whole Diamonds and names them; an unread asset prints
 * no pool line at all rather than a figure in a currency nobody looked up.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ handlers: new Map<string, (payload: unknown) => void>() }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (name: string, handler: (payload: unknown) => void) => {
    bus.handlers.set(name, handler);
  },
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playTournamentFinalTable: vi.fn() },
}));

import { FinalTableOverlay } from '../../src/components/tournament/FinalTableOverlay';
import { compactChips } from '../../src/utils/format';
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

afterEach(() => {
  cleanup();
  bus.handlers.clear();
});

const PLAYERS = [
  { userId: 'a', username: 'Alice', chips: 60000 },
  { userId: 'b', username: 'Bob', chips: 40000 },
];

function reachFinalTable(tournamentId = 't-1') {
  const handler = bus.handlers.get('FINAL_TABLE_REACHED');
  expect(handler, 'the overlay must listen for the final table').toBeDefined();
  act(() => handler!({ tournamentId, players: PLAYERS }));
}

/** The pool line exactly as a player reads it: raw text, nothing normalised. */
const poolText = (container: HTMLElement) =>
  container.querySelector('.ft-overlay__prize')?.textContent ?? null;

describe('the final table prints its pool at the event unit', () => {
  it('a chip event prints the compact pool and the word Chips, exactly as before', () => {
    const { container } = render(
      <FinalTableOverlay tournamentId="t-1" prizePool={1250} unitCents={CHIP_UNIT_CENTS} />
    );
    reachFinalTable();
    expect(poolText(container)).toBe(`${compactChips(1250)} Chips`);
  });

  it('a Diamond event prints whole Diamonds and never the word Chips', () => {
    const { container } = render(
      <FinalTableOverlay tournamentId="t-1" prizePool={1250} unitCents={DIAMOND_UNIT_CENTS} />
    );
    reachFinalTable();
    expect(poolText(container)).toBe('1,250 Diamonds');
    expect(container.querySelector('.ft-overlay__prize-row')?.textContent).not.toMatch(/Chips/);
  });

  it('an unread asset prints no pool line, and the lineup still shows', () => {
    const { container } = render(
      <FinalTableOverlay tournamentId="t-1" prizePool={1250} unitCents={null} />
    );
    reachFinalTable();
    expect(container.querySelector('.ft-overlay__prize-row')).toBeNull();
    expect(container.textContent).toContain('Alice');
  });

  it('the table, which passes no pool, prints no pool line at either unit', () => {
    for (const unitCents of [CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS]) {
      const { container, unmount } = render(
        <FinalTableOverlay tournamentId="t-1" unitCents={unitCents} />
      );
      reachFinalTable();
      expect(container.querySelector('.ft-overlay__prize-row')).toBeNull();
      unmount();
    }
  });
});
