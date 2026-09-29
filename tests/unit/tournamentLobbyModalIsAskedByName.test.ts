import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The console header prints a name in two measured zones, so a panel's
 * textContent has no separator between them.
 *
 * `TournamentLobbyModal` renders eyebrow "Tournament" over title "Lobby".
 * The player reads "Tournament Lobby" exactly as before; the DOM string is
 * "TournamentLobby", and `tournament-watch.spec.ts` asserted
 * `toContainText(/Tournament Lobby/i)` against that string. It failed on
 * every Post-Deploy E2E run from the console rebuild onward while nothing was
 * wrong with the page.
 *
 * What that line guards is WHICH panel opened - the lobby, not the info panel
 * it used to open. The dialog's accessible name answers that directly and
 * survives any future zone split, so the spec asks by role and name. This pin
 * keeps the two halves together: the modal must keep publishing the name, and
 * the spec must keep asking for it that way rather than going back to a
 * concatenated substring.
 */
const root = resolve(import.meta.dirname, '../..');
const modal = readFileSync(resolve(root, 'src/components/table/TournamentLobbyModal.tsx'), 'utf8');
const spec = readFileSync(resolve(root, 'tests/e2e/tournament-watch.spec.ts'), 'utf8');

describe('the tournament lobby overlay is identified by its accessible name', () => {
  it('publishes the whole name on the dialog, not only in the painted zones', () => {
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-label="Tournament Lobby"');
  });

  it('still prints both words in the console head the player reads', () => {
    expect(modal).toContain('eyebrow="Tournament"');
    expect(modal).toContain('title="Lobby"');
  });

  it('has the spec ask by role and name rather than by concatenated text', () => {
    expect(spec).toContain("page.getByRole('dialog', { name: /tournament lobby/i })");
    expect(
      spec,
      'the spec went back to asserting a separator the console header does not print'
    ).not.toMatch(/toContainText\(\/Tournament Lobby\/i\)/);
  });
});
